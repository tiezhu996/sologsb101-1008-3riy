/**
 * 执行批次状态（Pinia）
 * 编排「认领 → 拿租约 → 逐张执行」的跨页面协作：
 * - 持约页按间隔逐张执行，并用心跳续期；
 * - 租约失效（心跳/写入失败、租约被接管）立即停在本页；
 * - 另一页可在租约过期后接管，从最后完成项（completedSeq）之后继续；
 * - 执行数据全部由 utils/executionBatch 的 IndexedDB 事务保证原子性。
 */
import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { type AdjustRow, type ExecutionBatchRow } from '@/utils/db'
import {
  HEARTBEAT_INTERVAL_MS,
  type ExecutionBatch,
  type LeaseRef,
  type ShiftName
} from '@/types/executionBatch'
import { currentShift } from '@/utils/datetime'
import {
  canTakeOver,
  claimPendingIntoBatch,
  ensureLegacyHistoryBatch,
  heartbeatExecutionBatch,
  leaseActive,
  releaseExecutionBatch,
  stepExecutionBatch,
  takeOverExecutionBatch,
  type BatchStepResult
} from '@/utils/executionBatch'

const OWNER_KEY = 'gbheatgrid:owner-id'
const SHIFT_KEY = 'gbheatgrid:owner-shift'
/** 逐张执行间隔（毫秒），模拟现场逐阀操作，也留出两页观察租约的窗口 */
const STEP_DELAY_MS = 1200

function loadOwnerId(): string {
  try {
    const cached = sessionStorage.getItem(OWNER_KEY)
    if (cached) return cached
    const id = `page_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    sessionStorage.setItem(OWNER_KEY, id)
    return id
  } catch {
    return `page_${Math.random().toString(36).slice(2, 10)}`
  }
}

function loadShift(): ShiftName {
  try {
    const cached = sessionStorage.getItem(SHIFT_KEY)
    if (cached === '白班' || cached === '夜班') return cached
  } catch {
    // ignore
  }
  return currentShift()
}

export interface BatchRunResult {
  status: 'completed' | 'lease-lost' | 'failed' | 'stopped'
  batch: ExecutionBatch | null
  message?: string
}

export const useBatchStore = defineStore('executionBatch', () => {
  const batchTable = useIdbTable<ExecutionBatchRow>((database) => database.execBatches, { sortByUpdatedAt: false })
  const adjustTable = useIdbTable<AdjustRow>((database) => database.adjusts, { sortByUpdatedAt: false })

  /** 本标签页固定身份（sessionStorage：不同标签页互不相同，刷新后保持） */
  const ownerId = ref<string>(loadOwnerId())
  const ownerShift = ref<ShiftName>(loadShift())
  /** 当前持约的批次（仅本页正在执行/暂停时） */
  const runningBatchId = ref<string | null>(null)
  const runningLease = ref<LeaseRef | null>(null)
  const busy = ref(false)
  const lastError = ref('')
  /** 驱动租约倒计时刷新 */
  const nowTick = ref(Date.now())
  let stepTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let clockTimer: ReturnType<typeof setInterval> | null = null
  /** 运行令牌：暂停 / 丢失租约时作废，防止旧循环继续写入 */
  let runToken = 0

  const batches = computed<ExecutionBatchRow[]>(() =>
    [...batchTable.rows.value].sort((a, b) => b.claimedAt - a.claimedAt)
  )

  const normalBatches = computed(() => batches.value.filter((item) => item.kind === 'normal'))

  const batchById = computed(() => new Map(batches.value.map((item) => [item.id, item])))

  const adjustById = computed(() => new Map(adjustTable.rows.value.map((item) => [item.id, item])))

  /** 尚未被任何处理中批次认领的待下发单（历史批次中的旧单也算可认领） */
  const claimableAdjusts = computed<AdjustRow[]>(() => {
    const activeNormal = new Set(
      batches.value
        .filter((item) => item.kind === 'normal' && item.status === 'processing')
        .flatMap((item) => item.adjustIds)
    )
    return adjustTable.rows.value
      .filter((item) => item.state === '待下发' && !activeNormal.has(item.id))
      .sort((a, b) => a.createdAt - b.createdAt)
  })

  const runningBatch = computed<ExecutionBatchRow | null>(
    () => (runningBatchId.value ? batchById.value.get(runningBatchId.value) ?? null : null)
  )

  const isLeaseHeld = computed(() => {
    const batch = runningBatch.value
    if (!batch || !runningLease.value) return false
    return leaseActive(batch, runningLease.value, nowTick.value)
  })

  function progressOf(batch: ExecutionBatch): { done: number; total: number; percent: number } {
    const live = batch.adjustIds
      .map((id) => adjustById.value.get(id))
      .filter((item): item is AdjustRow => Boolean(item))
    const done = live.filter((item) => item.state !== '待下发').length
    const total = live.length
    return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
  }

  function leaseStateOf(batch: ExecutionBatch): 'held' | 'releasable' | 'expired' | 'done' {
    if (batch.status === 'completed') return 'done'
    if (batch.status === 'interrupted' || batch.ownerId === '') return 'releasable'
    return batch.leaseExpiresAt > nowTick.value ? 'held' : 'expired'
  }

  function setShift(shift: ShiftName): void {
    ownerShift.value = shift
    try {
      sessionStorage.setItem(SHIFT_KEY, shift)
    } catch {
      // ignore
    }
  }

  /* ------------------------------ 计时器 ------------------------------ */

  function startClock(): void {
    if (!clockTimer) clockTimer = setInterval(() => (nowTick.value = Date.now()), 1000)
  }

  function stopClock(): void {
    if (clockTimer) clearInterval(clockTimer)
    clockTimer = null
  }

  function startHeartbeat(token: number): void {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      void doHeartbeat(token)
    }, HEARTBEAT_INTERVAL_MS)
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }

  function clearStepTimer(): void {
    if (stepTimer) clearTimeout(stepTimer)
    stepTimer = null
  }

  async function doHeartbeat(token: number): Promise<void> {
    const batchId = runningBatchId.value
    const lease = runningLease.value
    if (!batchId || !lease || token !== runToken) return
    const result = await heartbeatExecutionBatch(batchId, lease)
    if (!result.ok) {
      lastError.value = '租约已失效或被另一页接管，本页已停止执行'
      stopLocalRun(token, true)
    }
  }

  /** 不持约时也能让倒计时走，供面板展示其他页的租约剩余时间 */
  startClock()

  /** 从后台切回前台时：本页原持约批次若租约已失效则从最后完成项自接管 */
  function onVisibilityChange(): void {
    if (document.visibilityState === 'visible' && !busy.value && !runningBatchId.value) {
      void resumeOnLoad()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  onScopeDispose(() => {
    runToken += 1
    clearStepTimer()
    stopHeartbeat()
    stopClock()
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })

  /* ------------------------------ 执行循环 ------------------------------ */

  function stopLocalRun(token: number, silent = false): void {
    if (token !== runToken) return
    clearStepTimer()
    stopHeartbeat()
    if (!silent) lastError.value = ''
    runningBatchId.value = null
    runningLease.value = null
  }

  function beginLoop(batchId: string, lease: LeaseRef): void {
    const token = ++runToken
    runningBatchId.value = batchId
    runningLease.value = lease
    lastError.value = ''
    busy.value = true
    startHeartbeat(token)
    void runLoop(batchId, lease, token)
  }

  async function runLoop(batchId: string, lease: LeaseRef, token: number): Promise<BatchRunResult> {
    let guard = 0
    let last: ExecutionBatch | null = null
    while (token === runToken && guard < 10000) {
      guard += 1
      let result: BatchStepResult
      try {
        result = await stepExecutionBatch(batchId, lease, ownerShift.value)
      } catch (error) {
        // 写入失败：释放租约并标记中断，另一页可在租约失效后从最后完成项接管
        lastError.value = `执行写入失败：${error instanceof Error ? error.message : '未知错误'}，等待另一页接管`
        await releaseExecutionBatch(batchId, lease, lastError.value).catch(() => undefined)
        stopLocalRun(token, true)
        busy.value = false
        return { status: 'failed', batch: last, message: lastError.value }
      }
      if (result.batch) last = result.batch

      if (result.outcome === 'lease-lost') {
        lastError.value = '租约已失效或被另一页接管，本页停止处理（已完成项不会被重复执行）'
        stopLocalRun(token, true)
        busy.value = false
        return { status: 'lease-lost', batch: last, message: lastError.value }
      }
      if (result.outcome === 'not-found') {
        lastError.value = '执行批次不存在（可能已被删除）'
        stopLocalRun(token, true)
        busy.value = false
        return { status: 'failed', batch: null, message: lastError.value }
      }
      if (result.outcome === 'completed') {
        stopLocalRun(token)
        busy.value = false
        return { status: 'completed', batch: result.batch ?? last }
      }

      // executed：等待一个执行间隔后继续下一张；等待期间令牌作废则立即退出
      await new Promise<void>((resolve) => {
        stepTimer = setTimeout(resolve, STEP_DELAY_MS)
      })
      if (token !== runToken) {
        busy.value = false
        return { status: 'stopped', batch: last }
      }
    }
    busy.value = false
    return { status: 'stopped', batch: last }
  }

  /* ------------------------------ 对外动作 ------------------------------ */

  /** 认领待下发单进新批次，拿到租约后逐张执行 */
  async function claimAndRun(adjustIds?: string[]): Promise<BatchRunResult> {
    if (busy.value || runningBatchId.value) {
      return { status: 'failed', batch: null, message: '本页已有执行中的批次，请先暂停或等待完成' }
    }
    busy.value = true
    const acquired = await claimPendingIntoBatch({
      adjustIds,
      ownerId: ownerId.value,
      ownerShift: ownerShift.value
    })
    if (!acquired.ok || !acquired.batch) {
      busy.value = false
      lastError.value = acquired.reason === 'empty' ? '没有可认领的待下发调节单' : '认领失败'
      return { status: 'failed', batch: null, message: lastError.value }
    }
    beginLoop(acquired.batch.id, { ownerId: ownerId.value, leaseVersion: acquired.batch.leaseVersion })
    return { status: 'completed', batch: acquired.batch }
  }

  /** 暂停：主动释放租约，标记中断等待交接 */
  async function pause(): Promise<void> {
    const batchId = runningBatchId.value
    const lease = runningLease.value
    if (!batchId || !lease) return
    runToken += 1
    clearStepTimer()
    stopHeartbeat()
    runningBatchId.value = null
    runningLease.value = null
    busy.value = false
    await releaseExecutionBatch(batchId, lease, `${ownerShift.value}暂停并释放租约，等待接管`).catch(() => undefined)
  }

  /** 接管一个租约失效/中断的批次，从最后完成项之后继续 */
  async function takeOver(batchId: string): Promise<BatchRunResult> {
    if (busy.value || runningBatchId.value) {
      return { status: 'failed', batch: null, message: '本页已有执行中的批次，请先暂停' }
    }
    busy.value = true
    const acquired = await takeOverExecutionBatch(batchId, ownerId.value, ownerShift.value)
    if (!acquired.ok || !acquired.batch) {
      busy.value = false
      lastError.value = '租约仍有效，不能抢占另一页正在执行的批次'
      return { status: 'lease-lost', batch: null, message: lastError.value }
    }
    beginLoop(acquired.batch.id, { ownerId: ownerId.value, leaseVersion: acquired.batch.leaseVersion })
    return { status: 'completed', batch: acquired.batch }
  }

  /** 刷新页面后自动恢复：本页（同 ownerId）留在租约里则直接续跑；租约过期则自接管 */
  async function resumeOnLoad(): Promise<boolean> {
    if (busy.value || runningBatchId.value) return false
    const candidates = batches.value.filter((item) => item.kind === 'normal' && item.status === 'processing')
    for (const batch of candidates) {
      if (batch.ownerId === ownerId.value) {
        const expired = batch.leaseExpiresAt <= Date.now()
        if (expired) {
          const acquired = await takeOverExecutionBatch(batch.id, ownerId.value, ownerShift.value)
          if (acquired.ok && acquired.batch) {
            beginLoop(acquired.batch.id, { ownerId: ownerId.value, leaseVersion: acquired.batch.leaseVersion })
            return true
          }
        } else {
          beginLoop(batch.id, { ownerId: ownerId.value, leaseVersion: batch.leaseVersion })
          return true
        }
      }
    }
    return false
  }

  async function ensureLegacy(): Promise<boolean> {
    return ensureLegacyHistoryBatch()
  }

  /** 仅供面板判断某批次当前是否可接管 */
  function takeoverEligible(batch: ExecutionBatch): boolean {
    return canTakeOver(batch, nowTick.value)
  }

  return {
    // 数据
    batchTable,
    batches,
    normalBatches,
    batchById,
    claimableAdjusts,
    // 本页身份与租约
    ownerId,
    ownerShift,
    runningBatchId,
    runningBatch,
    runningLease,
    busy,
    lastError,
    nowTick,
    isLeaseHeld,
    // 派生
    progressOf,
    leaseStateOf,
    takeoverEligible,
    // 动作
    setShift,
    claimAndRun,
    pause,
    takeOver,
    resumeOnLoad,
    ensureLegacy
  }
})
