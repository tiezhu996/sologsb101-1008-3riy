/**
 * 执行批次事务核心（IndexedDB / Dexie）
 *
 * 跨标签页协作完全由 IndexedDB 的读事务串行化保证：
 * - claimPendingIntoBatch：原子认领待下发调节单进批次并写入租约；
 * - stepExecutionBatch：单张执行——租约 CAS 校验 → 执行记录 → 阀门开度在同一事务提交，
 *   另一页不可能重复处理同一张；
 * - heartbeat / takeover / release：租约续期、失效接管与释放；
 * - ensureLegacyHistoryBatch：导入旧存档或异常漏迁时，运行时幂等补录历史批次。
 */
import { db, type AdjustRow, type ExecutionBatchRow, type ValveRow } from '@/utils/db'
import { clampOpening } from '@/types/valve'
import {
  LEASE_TTL_MS,
  LEGACY_HISTORY_BATCH_ID,
  LEGACY_HISTORY_BATCH_NAME,
  type BatchClaimInput,
  type LeaseRef,
  type ShiftName
} from '@/types/executionBatch'

export type BatchStepOutcome = 'executed' | 'completed' | 'lease-lost' | 'not-found'

export interface BatchStepResult {
  outcome: BatchStepOutcome
  batch?: ExecutionBatchRow
  adjustId?: string
}

export interface BatchAcquireResult {
  ok: boolean
  reason?: 'empty' | 'lease-lost' | 'not-found'
  batch?: ExecutionBatchRow
}

function nextName(shift: ShiftName, existing: number): string {
  return `${shift}执行批次 #${existing + 1}`
}

/**
 * 认领待下发调节单进新批次并立刻持有租约。
 * - 指定 input.adjustIds 时按给定顺序认领（过滤已在其他批次中的单）；
 * - 不指定时认领全部待下发单（含历史批次中尚未执行的旧单），按创建时间排序。
 */
export async function claimPendingIntoBatch(input: BatchClaimInput): Promise<BatchAcquireResult> {
  return db.transaction('rw', db.adjusts, db.execBatches, async () => {
    const pending = await db.adjusts.where('state').equals('待下发').toArray()
    const wanted = input.adjustIds
      ? input.adjustIds
          .map((id) => pending.find((item) => item.id === id))
          .filter((item): item is AdjustRow => Boolean(item))
      : pending.sort((a, b) => a.createdAt - b.createdAt)

    // 已被其他批次认领（batchId 指向处理中的新批次）的单不可重复认领；
    // 历史批次里尚未执行的旧单允许重新认领进新批次。
    const claimed = wanted.filter(
      (item) => item.batchId === '' || item.batchId === LEGACY_HISTORY_BATCH_ID
    )
    if (claimed.length === 0) return { ok: false, reason: 'empty' }

    const now = Date.now()
    const normalCount = await db.execBatches.filter((item) => item.kind === 'normal').count()
    const batch: ExecutionBatchRow = {
      id: `eb_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: input.name?.trim() || nextName(input.ownerShift, normalCount),
      kind: 'normal',
      adjustIds: claimed.map((item) => item.id),
      totalCount: claimed.length,
      completedCount: 0,
      completedSeq: 0,
      status: 'processing',
      ownerId: input.ownerId,
      ownerShift: input.ownerShift,
      leaseVersion: 1,
      leaseExpiresAt: now + LEASE_TTL_MS,
      claimedAt: now,
      lastHeartbeatAt: now,
      finishedAt: null,
      note: `${input.ownerShift}认领 ${claimed.length} 张待下发调节单`,
      createdAt: now,
      updatedAt: now,
      revision: 3
    }

    await db.execBatches.put(batch)
    for (const [index, adjust] of claimed.entries()) {
      await db.adjusts.update(adjust.id, {
        batchId: batch.id,
        batchSeq: index + 1,
        updatedAt: now
      })
    }
    return { ok: true, batch }
  })
}

/** 租约是否由本页持有且未过期 */
export function leaseActive(batch: ExecutionBatchRow, lease: LeaseRef, now: number = Date.now()): boolean {
  return (
    batch.status === 'processing' &&
    batch.ownerId === lease.ownerId &&
    batch.leaseVersion === lease.leaseVersion &&
    batch.leaseExpiresAt > now
  )
}

/**
 * 执行批次内下一张未完成的调节单。
 * 租约校验、状态置已调节、执行记录、阀门开度回写在同一事务内完成，
 * 任一步失败整体回滚，绝不会出现「记录已写 / 开度没写」或两页重复执行。
 */
export async function stepExecutionBatch(batchId: string, lease: LeaseRef, shift: ShiftName): Promise<BatchStepResult> {
  return db.transaction('rw', db.adjusts, db.execBatches, db.valves, async () => {
    const batch = await db.execBatches.get(batchId)
    if (!batch) return { outcome: 'not-found' }
    const now = Date.now()
    if (!leaseActive(batch, lease, now)) return { outcome: 'lease-lost' }

    // 清理已被删除的调节单，避免恢复位点被悬挂 id 卡住
    if (batch.adjustIds.length > 0) {
      const live = await db.adjusts.where('id').anyOf(batch.adjustIds).toArray()
      const liveIds = new Set(live.map((item) => item.id))
      const missing = batch.adjustIds.filter((id) => !liveIds.has(id))
      if (missing.length > 0) {
        batch.adjustIds = batch.adjustIds.filter((id) => liveIds.has(id))
      }
    }

    // 以批次内第一张「待下发」单作为下一项；已完成的绝不会被另一页再次处理
    const liveAdjusts =
      batch.adjustIds.length > 0 ? await db.adjusts.where('id').anyOf(batch.adjustIds).toArray() : []
    const byId = new Map(liveAdjusts.map((item) => [item.id, item]))
    let nextEntry: AdjustRow | null = null
    for (const id of batch.adjustIds) {
      const candidate = byId.get(id)
      if (candidate && candidate.state === '待下发') {
        nextEntry = candidate
        break
      }
    }

    if (!nextEntry) {
      const doneCount = liveAdjusts.filter((item) => item.state !== '待下发').length
      batch.status = 'completed'
      batch.completedSeq = batch.adjustIds.length
      batch.completedCount = doneCount
      batch.finishedAt = now
      batch.leaseExpiresAt = 0
      batch.ownerId = ''
      batch.ownerShift = ''
      batch.note = '批次全部执行完成'
      batch.updatedAt = now
      await db.execBatches.put(batch)
      return { outcome: 'completed', batch }
    }

    const adjustId = nextEntry.id
    const seq = batch.adjustIds.indexOf(adjustId) + 1
    const adjust = nextEntry

    const opening = clampOpening(adjust.targetOpening)
    const nextAdjust: Partial<AdjustRow> = {
      state: '已调节',
      executedAt: now,
      executedShift: shift,
      executedOpening: opening,
      updatedAt: now
    }
    await db.adjusts.update(adjust.id, nextAdjust)

    const valve = await db.valves.get(adjust.valveId)
    if (valve) {
      const nextValve: Partial<ValveRow> = {
        currentOpening: opening,
        updatedAt: now
      }
      await db.valves.update(valve.id, nextValve)
    }

    batch.completedSeq = Math.max(batch.completedSeq, seq)
    batch.completedCount = liveAdjusts.filter((item) => item.state !== '待下发').length + 1
    batch.lastHeartbeatAt = now
    batch.leaseExpiresAt = now + LEASE_TTL_MS
    batch.updatedAt = now
    await db.execBatches.put(batch)

    return { outcome: 'executed', batch, adjustId: adjust.id }
  })
}

/** 持约心跳：CAS 校验通过后续期，否则返回 lease-lost（页面应停止执行） */
export async function heartbeatExecutionBatch(batchId: string, lease: LeaseRef): Promise<BatchAcquireResult> {
  return db.transaction('rw', db.execBatches, async () => {
    const batch = await db.execBatches.get(batchId)
    if (!batch) return { ok: false, reason: 'not-found' }
    const now = Date.now()
    if (batch.ownerId !== lease.ownerId || batch.leaseVersion !== lease.leaseVersion) {
      return { ok: false, reason: 'lease-lost' }
    }
    batch.lastHeartbeatAt = now
    batch.leaseExpiresAt = now + LEASE_TTL_MS
    batch.updatedAt = now
    await db.execBatches.put(batch)
    return { ok: true, batch }
  })
}

/** 租约是否处于可被另一页接管的状态：中断待交接、已释放，或租约过期 */
export function canTakeOver(batch: ExecutionBatchRow, now: number = Date.now()): boolean {
  if (batch.status === 'completed') return false
  if (batch.status === 'interrupted') return true
  if (batch.ownerId === '') return true
  return batch.leaseExpiresAt <= now
}

/**
 * 另一页接管批次：租约过期或已释放才允许，leaseVersion 自增使旧持约页全部 CAS 失败。
 * 接管后从 completedSeq（最后完成项）之后继续。
 */
export async function takeOverExecutionBatch(
  batchId: string,
  ownerId: string,
  ownerShift: ShiftName
): Promise<BatchAcquireResult> {
  return db.transaction('rw', db.execBatches, async () => {
    const batch = await db.execBatches.get(batchId)
    if (!batch) return { ok: false, reason: 'not-found' }
    const now = Date.now()
    if (!canTakeOver(batch, now)) return { ok: false, reason: 'lease-lost' }
    batch.ownerId = ownerId
    batch.ownerShift = ownerShift
    batch.leaseVersion += 1
    batch.leaseExpiresAt = now + LEASE_TTL_MS
    batch.lastHeartbeatAt = now
    batch.status = 'processing'
    batch.note = `${ownerShift}于租约失效后从第 ${batch.completedSeq + 1} 张接管续跑`
    batch.updatedAt = now
    await db.execBatches.put(batch)
    return { ok: true, batch }
  })
}

/** 持约页主动释放租约（暂停 / 完成收尾），标记中断等待交接 */
export async function releaseExecutionBatch(batchId: string, lease: LeaseRef, note?: string): Promise<void> {
  await db.transaction('rw', db.execBatches, async () => {
    const batch = await db.execBatches.get(batchId)
    if (!batch) return
    if (batch.ownerId !== lease.ownerId || batch.leaseVersion !== lease.leaseVersion) return
    const now = Date.now()
    if (batch.status === 'processing') batch.status = 'interrupted'
    batch.ownerId = ''
    batch.ownerShift = ''
    batch.leaseExpiresAt = 0
    batch.updatedAt = now
    if (note) batch.note = note
    await db.execBatches.put(batch)
  })
}

/**
 * 运行时幂等补录历史批次：
 * 导入旧存档（无 execBatches）或升级异常漏迁时，把没有批次归属的旧单补成历史批次。
 * - 已执行 / 已复核的旧单回填执行记录（以目标开度落档最终执行结果）；
 * - 待下发旧单保持可重新认领，不写入历史批次。
 */
export async function ensureLegacyHistoryBatch(): Promise<boolean> {
  return db.transaction('rw', db.adjusts, db.execBatches, async () => {
    const all = await db.adjusts.toArray()
    const legacyDone = all.filter(
      (item) =>
        !item.batchId &&
        (item.state === '已调节' || item.state === '已复核')
    )
    const existing = await db.execBatches.get(LEGACY_HISTORY_BATCH_ID)
    if (legacyDone.length === 0 && !existing) return false

    const now = Date.now()
    // 历史批次只收录已闭环 / 已执行的旧单，保证待下发旧单仍可被新批次认领
    const memberIds = new Set(existing?.adjustIds ?? [])
    legacyDone.forEach((item) => memberIds.add(item.id))

    for (const adjust of legacyDone) {
      await db.adjusts.update(adjust.id, {
        batchId: LEGACY_HISTORY_BATCH_ID,
        executedAt: adjust.executedAt || adjust.updatedAt || now,
        executedShift: adjust.executedShift || adjust.executor || '',
        executedOpening: typeof adjust.executedOpening === 'number' ? adjust.executedOpening : adjust.targetOpening
      })
    }

    const members = (
      await (memberIds.size > 0 ? db.adjusts.where('id').anyOf([...memberIds]).toArray() : Promise.resolve([]))
    ).sort((a, b) => a.createdAt - b.createdAt)
    for (const [index, item] of members.entries()) {
      if (item.batchId === LEGACY_HISTORY_BATCH_ID && item.batchSeq === 0) {
        await db.adjusts.update(item.id, { batchSeq: index + 1 })
      }
    }
    const completedCount = members.length
    const history: ExecutionBatchRow = {
      id: LEGACY_HISTORY_BATCH_ID,
      name: LEGACY_HISTORY_BATCH_NAME,
      kind: 'history',
      adjustIds: members.map((item) => item.id),
      totalCount: members.length,
      completedCount,
      completedSeq: completedCount,
      status: 'completed',
      ownerId: existing?.ownerId ?? '',
      ownerShift: existing?.ownerShift ?? '',
      leaseVersion: existing?.leaseVersion ?? 0,
      leaseExpiresAt: 0,
      claimedAt: existing?.claimedAt ?? members[0]?.createdAt ?? now,
      lastHeartbeatAt: 0,
      finishedAt: existing?.finishedAt ?? now,
      note: existing?.note ?? '旧存档调节单首次进入时补录的历史批次',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      revision: 3
    }
    await db.execBatches.put(history)
    return true
  })
}
