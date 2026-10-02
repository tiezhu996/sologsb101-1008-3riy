/**
 * 执行批次事务核心行为测试（Node + fake-indexeddb + esbuild 打包运行）
 * 覆盖：
 * 1. 认领后逐张执行：执行记录与阀门开度同事务写入，全部完成批次置 completed
 * 2. 租约未过期不能被另一页抢占
 * 3. 租约失效（TTL 到期/写入失败后）另一页从最后完成项接管续跑，已完成项不重复处理
 * 4. 已认领的单不能被另一页重复认领
 * 5. 旧单（无批次归属）首次补成历史批次；待下发旧单不进历史批次且可重新认领
 */
import './setup-idb'
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { db, type AdjustRow, type ValveRow } from '@/utils/db'
import {
  claimPendingIntoBatch,
  stepExecutionBatch,
  takeOverExecutionBatch,
  heartbeatExecutionBatch,
  releaseExecutionBatch,
  ensureLegacyHistoryBatch,
  canTakeOver,
  leaseActive
} from '@/utils/executionBatch'
import { LEGACY_HISTORY_BATCH_ID } from '@/types/executionBatch'
import type { ShiftName } from '@/types/executionBatch'

const PAGE_A = 'page_a'
const PAGE_B = 'page_b'

interface SeedInput {
  count: number
  states?: Array<'待下发' | '已调节' | '已复核'>
  legacy?: boolean
}

async function seedAdjusts({ count, states, legacy = false }: SeedInput): Promise<AdjustRow[]> {
  const now = Date.now()
  const rows: AdjustRow[] = Array.from({ length: count }, (_v, index) => {
    const state = states?.[index] ?? '待下发'
    const done = state !== '待下发'
    return {
      id: `aj-${index}`,
      valveId: `vv-${index}`,
      targetOpening: 40 + index * 10,
      basis: `b${index}`,
      executor: 'x',
      state,
      reviewNote: '',
      batchId: legacy ? '' : '',
      batchSeq: 0,
      executedAt: legacy && done ? now - 1000 : 0,
      executedShift: legacy && done ? '夜班' : '',
      executedOpening: legacy && done ? 40 + index * 10 : null,
      createdAt: now + index,
      updatedAt: now + index,
      revision: 3
    }
  })
  const valves: ValveRow[] = Array.from({ length: count }, (_v, index) => ({
    id: `vv-${index}`,
    buildingId: 'bd',
    stationId: 'st',
    code: `V${index}`,
    dn: 50,
    currentOpening: 50,
    designFlowM3h: 10,
    position: '楼栋总阀',
    createdAt: now,
    updatedAt: now,
    revision: 3
  }))
  await db.adjusts.bulkPut(rows)
  await db.valves.bulkPut(valves)
  return rows
}

async function runUntilDone(batchId: string, ownerId: string, version: number, shift: ShiftName = '白班') {
  const lease = { ownerId, leaseVersion: version }
  let guard = 0
  const executed: string[] = []
  while (guard++ < 100) {
    const r = await stepExecutionBatch(batchId, lease, shift)
    if (r.outcome === 'lease-lost') return { stopped: 'lease-lost' as const, executed }
    if (r.outcome === 'not-found') return { stopped: 'not-found' as const, executed }
    if (r.outcome === 'completed') return { stopped: 'completed' as const, executed }
    if (r.adjustId) executed.push(r.adjustId)
  }
  return { stopped: 'guard' as const, executed }
}

beforeEach(async () => {
  await db.delete()
  await db.open()
})

test('1. 认领→逐张执行：记录与阀门开度同事务落档，完成后批次闭环', async () => {
  await seedAdjusts({ count: 3 })
  const claim = await claimPendingIntoBatch({ ownerId: PAGE_A, ownerShift: '白班' })
  assert.equal(claim.ok, true)
  const batchId = claim.batch!.id

  const r1 = await stepExecutionBatch(batchId, { ownerId: PAGE_A, leaseVersion: 1 }, '白班')
  assert.equal(r1.outcome, 'executed')
  assert.equal(r1.adjustId, 'aj-0')

  const aj0 = await db.adjusts.get('aj-0')
  assert.equal(aj0!.state, '已调节')
  assert.equal(aj0!.executedOpening, 40)
  assert.equal(aj0!.executedShift, '白班')
  assert.ok(aj0!.executedAt > 0)
  // 阀门开度同事务回写
  const vv0 = await db.valves.get('vv-0')
  assert.equal(vv0!.currentOpening, 40)

  const batch = await db.execBatches.get(batchId)
  assert.equal(batch!.completedSeq, 1)
  assert.equal(batch!.completedCount, 1)

  const rest = await runUntilDone(batchId, PAGE_A, 1)
  assert.equal(rest.stopped, 'completed')
  assert.deepEqual(rest.executed, ['aj-1', 'aj-2'])

  const final = await db.execBatches.get(batchId)
  assert.equal(final!.status, 'completed')
  assert.equal(final!.ownerId, '')
  const allValves = await db.valves.toArray()
  assert.deepEqual(allValves.map((v) => v.currentOpening).sort((a, b) => a - b), [40, 50, 60])
})

test('2. 租约未过期时另一页不能抢占', async () => {
  await seedAdjusts({ count: 2 })
  const claim = await claimPendingIntoBatch({ ownerId: PAGE_A, ownerShift: '白班' })
  const batchId = claim.batch!.id

  const takeover = await takeOverExecutionBatch(batchId, PAGE_B, '夜班')
  assert.equal(takeover.ok, false)
  assert.equal(takeover.reason, 'lease-lost')

  // B 的步进同样被 CAS 拒绝，不会动任何数据
  const stepB = await stepExecutionBatch(batchId, { ownerId: PAGE_B, leaseVersion: 1 }, '夜班')
  assert.equal(stepB.outcome, 'lease-lost')
  const aj0 = await db.adjusts.get('aj-0')
  assert.equal(aj0!.state, '待下发')
  assert.equal(canTakeOver((await db.execBatches.get(batchId))!), false)
})

test('3. 租约失效后另一页从最后完成项接管，已完成项不重复执行', async () => {
  await seedAdjusts({ count: 4 })
  const claim = await claimPendingIntoBatch({ ownerId: PAGE_A, ownerShift: '白班' })
  const batchId = claim.batch!.id

  // A 执行 2 张后页面崩溃（租约不再心跳）
  await stepExecutionBatch(batchId, { ownerId: PAGE_A, leaseVersion: 1 }, '白班')
  await stepExecutionBatch(batchId, { ownerId: PAGE_A, leaseVersion: 1 }, '白班')

  // 手动令租约过期，B 接管
  await db.execBatches.update(batchId, { leaseExpiresAt: Date.now() - 1 })
  assert.equal(canTakeOver((await db.execBatches.get(batchId))!), true)

  const takeover = await takeOverExecutionBatch(batchId, PAGE_B, '夜班')
  assert.equal(takeover.ok, true)
  assert.equal(takeover.batch!.leaseVersion, 2)
  assert.equal(takeover.batch!.ownerId, PAGE_B)

  // A 的旧租约立刻失效：心跳/步进都被拒绝
  assert.equal(leaseActive((await db.execBatches.get(batchId))!, { ownerId: PAGE_A, leaseVersion: 1 }), false)
  const staleHeartbeat = await heartbeatExecutionBatch(batchId, { ownerId: PAGE_A, leaseVersion: 1 })
  assert.equal(staleHeartbeat.ok, false)
  const staleStep = await stepExecutionBatch(batchId, { ownerId: PAGE_A, leaseVersion: 1 }, '白班')
  assert.equal(staleStep.outcome, 'lease-lost')

  // B 从第 3 张继续，aj-0/aj-1 不会被重复处理（executedShift 仍是白班）
  const rest = await runUntilDone(batchId, PAGE_B, 2, '夜班')
  assert.equal(rest.stopped, 'completed')
  assert.deepEqual(rest.executed, ['aj-2', 'aj-3'])

  const adjusts = await db.adjusts.toArray()
  assert.equal(adjusts.find((a) => a.id === 'aj-0')!.executedShift, '白班')
  assert.equal(adjusts.find((a) => a.id === 'aj-2')!.executedShift, '夜班')
  const batch = await db.execBatches.get(batchId)
  assert.equal(batch!.completedSeq, 4)
})

test('4. 已认领进处理中批次的单不能被另一页重复认领', async () => {
  await seedAdjusts({ count: 3 })
  const claim = await claimPendingIntoBatch({ ownerId: PAGE_A, ownerShift: '白班' })
  assert.equal(claim.ok, true)

  const claimB = await claimPendingIntoBatch({ ownerId: PAGE_B, ownerShift: '夜班' })
  assert.equal(claimB.ok, false)
  assert.equal(claimB.reason, 'empty')

  // A 执行一张后释放（中断），剩余单仍不可重新认领（防止重复批次），只能接管续跑
  await stepExecutionBatch(claim.batch!.id, { ownerId: PAGE_A, leaseVersion: 1 }, '白班')
  await releaseExecutionBatch(claim.batch!.id, { ownerId: PAGE_A, leaseVersion: 1 }, '暂停')
  const claimB2 = await claimPendingIntoBatch({ ownerId: PAGE_B, ownerShift: '夜班' })
  assert.equal(claimB2.ok, false)
  const takeover = await takeOverExecutionBatch(claim.batch!.id, PAGE_B, '夜班')
  assert.equal(takeover.ok, true)
})

test('5. 旧单首次补成历史批次，待下发旧单不进批次且可重新认领', async () => {
  await seedAdjusts({
    count: 4,
    states: ['已复核', '已调节', '待下发', '待下发'],
    legacy: true
  })

  const patched = await ensureLegacyHistoryBatch()
  assert.equal(patched, true)

  const history = await db.execBatches.get(LEGACY_HISTORY_BATCH_ID)
  assert.equal(history!.kind, 'history')
  assert.equal(history!.status, 'completed')
  assert.deepEqual(history!.adjustIds, ['aj-0', 'aj-1'])
  assert.equal(history!.completedSeq, 2)

  const done0 = await db.adjusts.get('aj-0')
  assert.equal(done0!.batchId, LEGACY_HISTORY_BATCH_ID)
  assert.equal(done0!.batchSeq, 1)
  assert.equal(done0!.executedOpening, 40)

  // 待下发旧单不进历史批次
  const pending = await db.adjusts.get('aj-2')
  assert.equal(pending!.batchId, '')

  // 幂等：再跑一次不重复/报错
  assert.equal(await ensureLegacyHistoryBatch(), true)
  const history2 = await db.execBatches.get(LEGACY_HISTORY_BATCH_ID)
  assert.deepEqual(history2!.adjustIds, ['aj-0', 'aj-1'])

  // 待下发旧单可被新批次认领执行
  const claim = await claimPendingIntoBatch({ ownerId: PAGE_A, ownerShift: '白班' })
  assert.equal(claim.ok, true)
  assert.deepEqual(claim.batch!.adjustIds, ['aj-2', 'aj-3'])
})
