/**
 * 执行批次协作 hook：
 * 订阅批次 / 执行项 liveQuery，维护当前页签租约心跳与逐张执行运行器，
 * 支持租约失效后由另一页从最后完成项接管恢复。
 */
import { computed, onScopeDispose, reactive, ref } from 'vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { type ExecutionBatchRow, type ExecutionItemRow } from '@/utils/db'
import {
  LEASE_HEARTBEAT_MS,
  isLeaseActive,
  type ExecutionBatch,
  type ExecutionItem
} from '@/types/executionBatch'
import {
  LeaseError,
  acquireLease,
  backfillHistoricalBatches,
  claimPendingAdjusts,
  executeItem,
  listBatchItems,
  releaseLease,
  renewLease,
  retryFailedItems
} from '@/utils/batches'
import { batchEventBus } from '@/utils/batchEvents'
import { readSession, changeShift, type ShiftKind, type ShiftSession } from '@/utils/session'

/** 逐张执行间隔（便于观察进度，也给心跳留出窗口） */
const ITEM_STEP_DELAY_MS = 350

export interface RunSummary {
  batchId: string
  executed: number
  skipped: number
  failed: number
  finished: boolean
  message: string
}

export function useExecutionBatches() {
  const batchTable = useIdbTable<ExecutionBatchRow>((database) => database.executionBatches, {
    sortByUpdatedAt: false
  })
  const itemTable = useIdbTable<ExecutionItemRow>((database) => database.executionItems, {
    sortByUpdatedAt: false
  })

  const session = reactive<ShiftSession>({ ...readSession() })
  /** 每秒自增，驱动租约剩余时间的实时展示 */
  const nowTick = ref(Date.now())
  const running = ref(false)
  const runningBatchId = ref<string | null>(null)
  const lastError = ref('')
  const lastSummary = ref<RunSummary | null>(null)

  let tickTimer: ReturnType<typeof setInterval> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let cancelled = false

  tickTimer = setInterval(() => {
    nowTick.value = Date.now()
  }, 1000)

  const batches = computed<ExecutionBatchRow[]>(() =>
    [...batchTable.rows.value].sort((a, b) => b.createdAt - a.createdAt)
  )

  const items = computed<ExecutionItemRow[]>(() =>
    [...itemTable.rows.value].sort((a, b) => a.seq - b.seq)
  )

  const itemsByBatch = computed(() => {
    const map = new Map<string, ExecutionItemRow[]>()
    items.value.forEach((item) => {
      const list = map.get(item.batchId)
      if (list) list.push(item)
      else map.set(item.batchId, [item])
    })
    return map
  })

  /** 调节单 id → 执行项，用于刷新与导出按最终执行结果展示 */
  const itemByAdjust = computed(() => {
    const map = new Map<string, ExecutionItemRow>()
    items.value.forEach((item) => map.set(item.adjustId, item))
    return map
  })

  /** 当前未完成、可执行 / 可接管的批次（不含历史批次） */
  const activeBatch = computed<ExecutionBatchRow | null>(() => {
    const open = batches.value.find(
      (batch) => !batch.isHistorical && batch.completedCount + batch.failedCount < batch.itemCount
    )
    return open ?? null
  })

  const historicalBatches = computed(() => batches.value.filter((batch) => batch.isHistorical))

  /** 本页签是否持有某批次的有效租约 */
  function ownsLease(batch: ExecutionBatch | null | undefined): boolean {
    if (!batch) return false
    return isLeaseActive(batch, nowTick.value) && batch.leaseOwner === session.owner
  }

  /** 租约是否正被他人有效持有 */
  function leasedByOther(batch: ExecutionBatch | null | undefined): boolean {
    if (!batch) return false
    return isLeaseActive(batch, nowTick.value) && batch.leaseOwner !== session.owner
  }

  function leaseRemainingMs(batch: ExecutionBatch | null | undefined): number {
    if (!batch) return 0
    return Math.max(0, batch.leaseUntil - nowTick.value)
  }

  function itemsOf(batchId: string): ExecutionItem[] {
    return itemsByBatch.value.get(batchId) ?? []
  }

  function switchShift(shift: ShiftKind): void {
    const next = changeShift(shift)
    Object.assign(session, next)
  }

  /* ------------------------------ 认领 ------------------------------ */

  async function claim(adjustIds: string[], name?: string) {
    const { batch, claimed } = await claimPendingAdjusts(adjustIds, {
      owner: session.owner,
      shift: session.shift,
      name
    })
    if (batch) batchEventBus.post({ type: 'batch-changed', sender: session.owner, batchId: batch.id })
    return { batch, claimed }
  }

  /** 认领后立即逐张执行（「认领并执行」）；无可认领单时直接返回提示 */
  async function claimAndRun(adjustIds: string[], name?: string): Promise<RunSummary> {
    const { batch, claimed } = await claim(adjustIds, name)
    if (claimed === 0 || !batch) {
      return {
        batchId: batch?.id ?? '',
        executed: 0,
        skipped: 0,
        failed: 0,
        finished: false,
        message: '所选调节单均已被认领或已处理'
      }
    }
    return runBatch(batch.id)
  }

  /* ---------------------------- 执行运行器 ---------------------------- */

  function startHeartbeat(batchId: string): void {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      void renewLease(batchId, session.owner).catch(() => {
        /* 续约失败由下一次执行的租约校验兜底 */
      })
    }, LEASE_HEARTBEAT_MS)
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  /** 接管（或直接执行）一个批次：拿租约 → 从最后完成项之后逐张执行 */
  async function runBatch(batchId: string): Promise<RunSummary> {
    if (running.value) {
      return {
        batchId,
        executed: 0,
        skipped: 0,
        failed: 0,
        finished: false,
        message: '当前页签已有批次在执行'
      }
    }
    running.value = true
    runningBatchId.value = batchId
    cancelled = false
    lastError.value = ''

    let summary: RunSummary | null = null
    try {
      // 租约空闲或已过期即可接管；仍被他人有效持有时会抛 LeaseError
      await acquireLease(batchId, session.owner)
      startHeartbeat(batchId)
      batchEventBus.post({ type: 'lease-changed', sender: session.owner, batchId })

      let executed = 0
      let skipped = 0
      let failed = 0
      let blocked = ''

      // 认领后立即执行时 liveQuery 可能尚未推送，直接从库中取最新执行项；
      // 已完成项天然被过滤，即「从最后完成项之后恢复」
      const ordered = (await listBatchItems(batchId)).filter((item) => item.status !== '已完成')
      for (const item of ordered) {
        if (cancelled) break
        try {
          const result = await executeItem(batchId, item.id, session.owner)
          if (result.item.status === '失败') failed += 1
          else if (result.executed) executed += 1
          else skipped += 1
          batchEventBus.post({ type: 'batch-changed', sender: session.owner, batchId })
        } catch (error) {
          // 租约失效 / 写入失败：停止本页执行，租约到期后由另一页接管恢复
          blocked = error instanceof Error ? error.message : '执行失败'
          break
        }
        // 出现业务失败项（阀门/调节单缺失）则中断整批，释放租约交界面重试或由另一页接管
        if (failed > 0) break
        await delay(ITEM_STEP_DELAY_MS)
      }

      const refreshed = batchTable.rows.value.find((row) => row.id === batchId)
      const finishedAll = refreshed ? refreshed.completedCount >= refreshed.itemCount : false
      const finishState = cancelled ? '已暂停' : blocked ? '被阻塞' : failed > 0 ? '存在失败项' : finishedAll ? '已全部完成' : '未完成'

      if (finishedAll) {
        await releaseLease(batchId, session.owner)
      } else if (cancelled || failed > 0) {
        // 主动暂停 / 业务失败：立即释放租约，另一页无需等待 TTL 即可接管
        await releaseLease(batchId, session.owner)
      }

      if (blocked) lastError.value = blocked
      const message = blocked
        ? `执行中断：${blocked}，租约失效后可由另一页接管恢复`
        : `本页执行 ${executed} 张、跳过 ${skipped} 张${failed > 0 ? `、失败 ${failed} 张` : ''}（${finishState}）`

      summary = { batchId, executed, skipped, failed, finished: finishedAll && !blocked && failed === 0, message }
    } catch (error) {
      const message =
        error instanceof LeaseError
          ? error.message
          : error instanceof Error
            ? `无法开始执行：${error.message}`
            : '无法开始执行'
      lastError.value = message
      summary = { batchId, executed: 0, skipped: 0, failed: 0, finished: false, message }
    } finally {
      stopHeartbeat()
      running.value = false
      runningBatchId.value = null
      if (summary) lastSummary.value = summary
      batchEventBus.post({ type: 'batch-changed', sender: session.owner, batchId })
    }
    if (!summary) {
      return { batchId, executed: 0, skipped: 0, failed: 0, finished: false, message: '执行未开始' }
    }
    return summary
  }

  /** 暂停：请求停止并释放租约，让另一页可立刻接管 */
  async function stopRunning(): Promise<void> {
    const batchId = runningBatchId.value
    cancelled = true
    stopHeartbeat()
    if (batchId) await releaseLease(batchId, session.owner).catch(() => undefined)
    running.value = false
    runningBatchId.value = null
  }

  async function retry(batchId: string): Promise<number> {
    const count = await retryFailedItems(batchId, session.owner)
    batchEventBus.post({ type: 'lease-changed', sender: session.owner, batchId })
    return count
  }

  async function release(batchId: string): Promise<void> {
    await releaseLease(batchId, session.owner)
    batchEventBus.post({ type: 'lease-changed', sender: session.owner, batchId })
  }

  /** 旧调节单首次进入补历史批次（幂等） */
  async function backfillHistory(): Promise<number> {
    return backfillHistoricalBatches()
  }

  async function refresh(): Promise<void> {
    await Promise.all([batchTable.refresh(), itemTable.refresh()])
  }

  /** 订阅其它页签的批次变化，即时刷新 */
  const unsubscribeBus = batchEventBus.subscribe((event) => {
    if (event.sender === session.owner) return
    void refresh()
  })

  function dispose(): void {
    stopHeartbeat()
    if (tickTimer) clearInterval(tickTimer)
    unsubscribeBus()
  }

  onScopeDispose(() => {
    void dispose()
  })

  return {
    // 数据
    batches,
    items,
    itemsByBatch,
    itemByAdjust,
    activeBatch,
    historicalBatches,
    session,
    nowTick,
    running,
    runningBatchId,
    lastError,
    lastSummary,
    // 租约展示
    ownsLease,
    leasedByOther,
    leaseRemainingMs,
    itemsOf,
    // 动作
    switchShift,
    claim,
    claimAndRun,
    runBatch,
    stopRunning,
    retry,
    release,
    backfillHistory,
    refresh
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
