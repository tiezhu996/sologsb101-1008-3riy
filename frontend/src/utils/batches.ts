/**
 * 执行批次协作服务：
 * 待下发调节单先「认领进批次」（原子回填 adjust.batchId，天然防重复认领），
 * 页面拿到租约后逐张执行；执行记录、阀门开度、调节单状态在同一事务落库。
 * 租约失效或写入失败后，另一页可接管租约并从最后完成项之后恢复。
 */
import { db, createId, type AdjustRow, type ExecutionBatchRow, type ExecutionItemRow } from '@/utils/db'
import { clampOpening } from '@/types/valve'
import {
  LEASE_TTL_MS,
  isLeaseActive,
  type BatchState
} from '@/types/executionBatch'

const BATCH_PREFIX = 'eb'
const ITEM_PREFIX = 'ei'

export class LeaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LeaseError'
  }
}

export interface ClaimOptions {
  /** 认领人（班次标签），同时写入租约持有者 */
  owner: string
  /** 认领人班次，展示用 */
  shift: string
  /** 批次名称，默认按班次与时间生成 */
  name?: string
}

/** 当前未完成（可继续执行 / 可认领）的批次 */
export async function findOpenBatch(): Promise<ExecutionBatchRow | undefined> {
  const candidates = await db.executionBatches
    .where('state')
    .anyOf('待执行', '执行中', '已中断')
    .toArray()
  return candidates.find((batch) => !batch.isHistorical && batch.completedCount < batch.itemCount)
}

/**
 * 认领待下发调节单进批次。
 * - 已有未完成批次时并入该批次（沿用其执行人归属）；
 * - 否则新建批次。认领与 adjust.batchId 回写在同一事务，保证不会被两页重复认领。
 * 返回 { batch, claimed }，claimed 为本次实际认领张数。
 */
export async function claimPendingAdjusts(
  adjustIds: string[],
  options: ClaimOptions,
  now = Date.now()
): Promise<{ batch: ExecutionBatchRow | undefined; claimed: number }> {
  if (adjustIds.length === 0) throw new Error('没有可认领的调节单')

  let result: { batch: ExecutionBatchRow | undefined; claimed: number } | null = null

  await db.transaction(
    'rw',
    db.executionBatches,
    db.executionItems,
    db.adjusts,
    async () => {
      // 仅复用「本页持约」或「租约空闲/已失效」的未完成批次；
      // 正被他人有效持约执行中的批次不并入，避免认领后无法立即执行
      const open = await findOpenBatch()
      let batch =
        open && (!isLeaseActive(open, now) || open.leaseOwner === options.owner) ? open : null
      const existingAdjustIds = new Set<string>()
      if (batch) {
        const existing = await db.executionItems.where('batchId').equals(batch.id).toArray()
        existing.forEach((item) => existingAdjustIds.add(item.adjustId))
      }

      const wants = await db.adjusts
        .where('id')
        .anyOf(adjustIds)
        .toArray()
      // 仅待下发且未归属任何批次的调节单可被认领
      const picked = wants.filter(
        (adjust) => adjust.state === '待下发' && !adjust.batchId && !existingAdjustIds.has(adjust.id)
      )

      if (picked.length === 0) {
        // 请求的调节单均已在批次中或已处理：幂等返回 0，不新建批次
        result = { batch: open, claimed: 0 }
        return
      }

      if (!batch) {
        batch = {
          id: createId(BATCH_PREFIX),
          name: options.name ?? `${options.shift}执行批次 ${new Date(now).toLocaleString('zh-CN', { hour12: false })}`,
          state: '待执行',
          ownerShift: options.shift,
          leaseOwner: options.owner,
          leaseUntil: now + LEASE_TTL_MS,
          lastCompletedSeq: 0,
          itemCount: 0,
          completedCount: 0,
          failedCount: 0,
          isHistorical: false,
          createdAt: now,
          updatedAt: now,
          revision: 2
        }
        await db.executionBatches.add(batch)
      }

      const baseSeq = batch.itemCount
      const items: ExecutionItemRow[] = picked.map((adjust, index) => ({
        id: createId(ITEM_PREFIX),
        batchId: batch!.id,
        adjustId: adjust.id,
        valveId: adjust.valveId,
        targetOpening: adjust.targetOpening,
        executor: adjust.executor && adjust.executor !== '待指派' ? adjust.executor : options.shift,
        seq: baseSeq + index + 1,
        status: '待执行',
        executedOpening: null,
        executedAt: null,
        executedBy: '',
        failReason: '',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        revision: 2
      }))
      await db.executionItems.bulkPut(items)

      await Promise.all(
        picked.map((adjust) =>
          db.adjusts.update(adjust.id, { batchId: batch!.id, updatedAt: now })
        )
      )

      const merged: ExecutionBatchRow = {
        ...batch,
        itemCount: batch.itemCount + picked.length,
        updatedAt: now
      }
      await db.executionBatches.put(merged)
      result = { batch: merged, claimed: picked.length }
    }
  )

  if (!result) throw new Error('认领失败：无可用执行批次')
  return result
}

/**
 * 获取（或接管）批次租约。租约空闲 / 已过期时可被任一页签认领；
 * 仍被他人有效持有时抛 LeaseError。
 */
export async function acquireLease(batchId: string, owner: string, now = Date.now()): Promise<ExecutionBatchRow> {
  let acquired: ExecutionBatchRow | null = null
  await db.transaction('rw', db.executionBatches, async () => {
    const batch = await db.executionBatches.get(batchId)
    if (!batch) throw new Error('执行批次不存在')
    if (batch.completedCount >= batch.itemCount) throw new LeaseError('该批次已全部完成')
    if (isLeaseActive(batch, now) && batch.leaseOwner !== owner) {
      throw new LeaseError(`批次正被 ${batch.leaseOwner} 执行，租约内不可抢占`)
    }
    const next: ExecutionBatchRow = {
      ...batch,
      leaseOwner: owner,
      leaseUntil: now + LEASE_TTL_MS,
      state: batch.state === '待执行' || batch.state === '执行中' || batch.state === '已中断' ? '执行中' : batch.state,
      updatedAt: now
    }
    await db.executionBatches.put(next)
    acquired = next
  })
  if (!acquired) throw new Error('获取租约失败')
  return acquired
}

/** 心跳续约：仅当前持有方可续 */
export async function renewLease(batchId: string, owner: string, now = Date.now()): Promise<void> {
  await db.transaction('rw', db.executionBatches, async () => {
    const batch = await db.executionBatches.get(batchId)
    if (!batch || batch.leaseOwner !== owner) return
    await db.executionBatches.update(batchId, { leaseUntil: now + LEASE_TTL_MS })
  })
}

/** 主动释放租约（完成 / 暂停 / 离开页面） */
export async function releaseLease(batchId: string, owner: string, now = Date.now()): Promise<void> {
  await db.transaction('rw', db.executionBatches, async () => {
    const batch = await db.executionBatches.get(batchId)
    if (!batch || batch.leaseOwner !== owner) return
    const unfinished = batch.completedCount < batch.itemCount
    await db.executionBatches.put({
      ...batch,
      leaseOwner: '',
      leaseUntil: 0,
      state: unfinished ? '已中断' : '已完成',
      updatedAt: now
    })
  })
}

export interface ExecuteItemResult {
  item: ExecutionItemRow
  /** true 表示本次真正执行；false 表示该项已完成被跳过（恢复场景） */
  executed: boolean
}

/** 直接从库中读取某批次的执行项并按 seq 排序（不依赖 liveQuery 是否已推送） */
export async function listBatchItems(batchId: string): Promise<ExecutionItemRow[]> {
  const items = await db.executionItems.where('batchId').equals(batchId).toArray()
  return items.sort((a, b) => a.seq - b.seq)
}

/**
 * 执行单个执行项：在同一事务内
 * 1) 校验租约归属于 owner 且未过期；
 * 2) 已完成项直接跳过（幂等，防止换班重复处理 / 重复回写开度）；
 * 3) 写执行记录 + 回写阀门开度 + 调节单置「已调节」，任一失败整体回滚。
 */
export async function executeItem(
  batchId: string,
  itemId: string,
  owner: string,
  now = Date.now()
): Promise<ExecuteItemResult> {
  let outcome: ExecuteItemResult | null = null

  await db.transaction(
    'rw',
    db.executionBatches,
    db.executionItems,
    db.adjusts,
    db.valves,
    async () => {
      const batch = await db.executionBatches.get(batchId)
      if (!batch) throw new LeaseError('执行批次不存在')
      if (batch.leaseOwner !== owner || !isLeaseActive(batch, now)) {
        throw new LeaseError('租约已失效，请接管后再执行')
      }

      const item = await db.executionItems.get(itemId)
      if (!item || item.batchId !== batchId) throw new Error('执行项不存在')
      if (item.status === '已完成') {
        outcome = { item, executed: false }
        return
      }

      const adjust = await db.adjusts.get(item.adjustId)
      const valve = await db.valves.get(item.valveId)

      // 调节单缺失：该项无法再执行，标记跳过性失败，不阻塞整批恢复
      if (!adjust) {
        const failedItem: ExecutionItemRow = {
          ...item,
          status: '失败',
          failReason: '调节单已被删除',
          attempts: item.attempts + 1,
          updatedAt: now
        }
        await db.executionItems.put(failedItem)
        await settleBatchCounters(batchId, owner, now)
        outcome = { item: failedItem, executed: true }
        return
      }

      // 阀门缺失属于可记录的业务失败（写入仍成功，事务提交）
      if (!valve) {
        const failedItem: ExecutionItemRow = {
          ...item,
          status: '失败',
          failReason: '阀门已被删除，无法回写开度',
          attempts: item.attempts + 1,
          updatedAt: now
        }
        await db.executionItems.put(failedItem)
        await settleBatchCounters(batchId, owner, now)
        outcome = { item: failedItem, executed: true }
        return
      }

      const opening = clampOpening(item.targetOpening)
      const executedItem: ExecutionItemRow = {
        ...item,
        status: '已完成',
        executedOpening: opening,
        executedAt: now,
        executedBy: owner,
        failReason: '',
        attempts: item.attempts + 1,
        updatedAt: now
      }
      // 执行记录 + 阀门开度 + 调节单状态：同事务原子提交
      await db.executionItems.put(executedItem)
      await db.valves.put({ ...valve, currentOpening: opening, updatedAt: now })
      await db.adjusts.put({
        ...adjust,
        state: '已调节',
        executor: item.executor,
        updatedAt: now
      })
      await settleBatchCounters(batchId, owner, now)
      outcome = { item: executedItem, executed: true }
    }
  )

  if (!outcome) throw new Error('执行失败：无执行结果')
  return outcome
}

/** 按执行项实际状态重算批次计数、完成水位与批次状态（在持有租约的事务内调用） */
async function settleBatchCounters(batchId: string, owner: string, now: number): Promise<void> {
  const batch = await db.executionBatches.get(batchId)
  if (!batch) return
  const items = await db.executionItems.where('batchId').equals(batchId).toArray()
  const completed = items.filter((item) => item.status === '已完成').length
  const failed = items.filter((item) => item.status === '失败').length
  const lastCompletedSeq = items
    .filter((item) => item.status === '已完成')
    .reduce((max, item) => Math.max(max, item.seq), 0)
  const allDone = completed + failed === items.length
  const state: BatchState = completed === items.length
    ? '已完成'
    : failed > 0
      ? '已中断'
      : '执行中'
  await db.executionBatches.put({
    ...batch,
    completedCount: completed,
    failedCount: failed,
    lastCompletedSeq,
    leaseOwner: allDone && completed === items.length ? '' : owner,
    leaseUntil: allDone && completed === items.length ? 0 : now + LEASE_TTL_MS,
    state,
    updatedAt: now
  })
}

/** 重试失败项：重置为待执行并接管租约 */
export async function retryFailedItems(
  batchId: string,
  owner: string,
  now = Date.now()
): Promise<number> {
  let resetCount = 0
  await db.transaction('rw', db.executionBatches, db.executionItems, async () => {
    const batch = await db.executionBatches.get(batchId)
    if (!batch) throw new Error('执行批次不存在')
    if (isLeaseActive(batch, now) && batch.leaseOwner !== owner) {
      throw new LeaseError(`批次正被 ${batch.leaseOwner} 执行`)
    }
    const failed = await db.executionItems
      .where('batchId')
      .equals(batchId)
      .filter((item) => item.status === '失败')
      .toArray()
    await Promise.all(
      failed.map((item) =>
        db.executionItems.put({
          ...item,
          status: '待执行',
          failReason: '',
          executedOpening: null,
          executedAt: null,
          executedBy: '',
          updatedAt: now
        })
      )
    )
    resetCount = failed.length
    await db.executionBatches.put({
      ...batch,
      leaseOwner: owner,
      leaseUntil: now + LEASE_TTL_MS,
      state: '执行中',
      failedCount: 0,
      updatedAt: now
    })
  })
  return resetCount
}

/**
 * 旧调节单首次进入补成历史批次（幂等）。
 * 把「无 batchId 且无对应执行项」的已调节 / 已复核调节单，
 * 汇总成一张「历史批次」，执行开度快照取调节单目标开度，
 * 并回填 adjust.batchId。重复调用不会重复补录。
 */
export async function backfillHistoricalBatches(now = Date.now()): Promise<number> {
  let backfilled = 0
  await db.transaction(
    'rw',
    db.executionBatches,
    db.executionItems,
    db.adjusts,
    async () => {
      const allItems = await db.executionItems.toArray()
      const coveredAdjustIds = new Set(allItems.map((item) => item.adjustId))

      const legacy = (await db.adjusts.toArray()).filter(
        (adjust) =>
          (adjust.state === '已调节' || adjust.state === '已复核') &&
          !adjust.batchId &&
          !coveredAdjustIds.has(adjust.id)
      )
      if (legacy.length === 0) return

      const batchId = createId(BATCH_PREFIX)
      const batch: ExecutionBatchRow = {
        id: batchId,
        name: `历史执行批次（旧单补录）${new Date(now).toLocaleDateString('zh-CN')}`,
        state: '历史批次',
        ownerShift: '系统',
        leaseOwner: '',
        leaseUntil: 0,
        lastCompletedSeq: legacy.length,
        itemCount: legacy.length,
        completedCount: legacy.length,
        failedCount: 0,
        isHistorical: true,
        createdAt: now,
        updatedAt: now,
        revision: 2
      }
      await db.executionBatches.add(batch)

      const items: ExecutionItemRow[] = legacy.map((adjust, index) => ({
        id: createId(ITEM_PREFIX),
        batchId,
        adjustId: adjust.id,
        valveId: adjust.valveId,
        targetOpening: adjust.targetOpening,
        executor: adjust.executor,
        seq: index + 1,
        status: '已完成',
        executedOpening: clampOpening(adjust.targetOpening),
        executedAt: adjust.updatedAt || adjust.createdAt || now,
        executedBy: adjust.executor || '历史记录',
        failReason: '',
        attempts: 1,
        createdAt: adjust.createdAt || now,
        updatedAt: now,
        revision: 2
      }))
      await db.executionItems.bulkPut(items)
      await Promise.all(
        legacy.map((adjust: AdjustRow) =>
          db.adjusts.put({ ...adjust, batchId, updatedAt: now })
        )
      )
      backfilled = legacy.length
    }
  )
  return backfilled
}
