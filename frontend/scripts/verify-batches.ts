/**
 * 执行批次协作的端到端逻辑验证（Node + fake-indexeddb，不参与前端构建）。
 * 覆盖：原子认领防重复、逐张原子写（记录+开度）、已完成项不重复、
 * 租约互斥与到期接管恢复、写入失败恢复、旧单历史补录、最终执行开度导出依据。
 * 运行前由 scripts/fake-idb-preload.cjs 注入 IndexedDB 全局。
 */

import { db } from '../src/utils/db'
import {
  acquireLease,
  backfillHistoricalBatches,
  claimPendingAdjusts,
  executeItem,
  listBatchItems,
  renewLease,
  retryFailedItems
} from '../src/utils/batches'
import { LeaseError } from '../src/utils/batches'

let passed = 0
let failed = 0
function assert(cond: boolean, message: string): void {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${message}`)
  } else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

const DAY = 86_400_000
const now0 = Date.parse('2024-11-20T09:00:00+08:00')

interface Seed {
  valveIds: string[]
  pendingAdjustIds: string[]
  doneAdjustIds: string[]
}

async function seed(): Promise<Seed> {
  const now = Date.now()
  const valves = Array.from({ length: 4 }, (_, i) => ({
    id: `vv-t${i}`,
    buildingId: 'bd',
    stationId: 'st',
    code: `V${i}`,
    dn: 50,
    currentOpening: 50,
    designFlowM3h: 20,
    position: '楼栋总阀' as const,
    createdAt: now,
    updatedAt: now,
    revision: 2
  }))
  const pendingAdjustIds = valves.slice(0, 3).map((v, i) => `aj-p${i}`)
  const pending = pendingAdjustIds.map((id, i) => ({
    id,
    valveId: valves[i].id,
    targetOpening: [60, 70, 80][i],
    basis: 'b',
    executor: '待指派',
    state: '待下发' as const,
    reviewNote: '',
    batchId: '',
    createdAt: now0 - DAY,
    updatedAt: now0 - DAY,
    revision: 2
  }))
  // 一张旧的「已调节」无批次调节单
  const oldDone = {
    id: 'aj-old',
    valveId: valves[3].id,
    targetOpening: 55,
    basis: 'old',
    executor: '王海',
    state: '已调节' as const,
    reviewNote: '',
    batchId: '',
    createdAt: now0 - 5 * DAY,
    updatedAt: now0 - 2 * DAY,
    revision: 2
  }
  await db.valves.bulkPut(valves)
  await db.adjusts.bulkPut([...pending, oldDone])
  return {
    valveIds: valves.map((v) => v.id),
    pendingAdjustIds,
    doneAdjustIds: ['aj-old']
  }
}

async function main(): Promise<void> {
  await db.open()
  const s = await seed()
  const A = '白班#aaaa'
  const B = '夜班#bbbb'

  console.log('\n[1] 旧调节单首次进入补成历史批次（幂等）')
  const n1 = await backfillHistoricalBatches()
  const n2 = await backfillHistoricalBatches()
  assert(n1 === 1, `首次补录 1 张旧单（实际 ${n1}）`)
  assert(n2 === 0, `再次进入不重复补录（实际 ${n2}）`)
  const oldAdjust = await db.adjusts.get('aj-old')
  assert(!!oldAdjust?.batchId, '旧调节单已回填 batchId')
  const oldItem = (await db.executionItems.where('adjustId').equals('aj-old').toArray())[0]
  assert(oldItem?.status === '已完成' && oldItem.executedOpening === 55, '历史执行项已完成且最终开度=目标 55%')

  console.log('\n[2] 待下发调节单原子认领进批次')
  const claimed = await claimPendingAdjusts(s.pendingAdjustIds, { owner: A, shift: '白班' })
  assert(claimed.claimed === 3, `A 认领 3 张（实际 ${claimed.claimed}）`)
  const batchId = claimed.batch.id
  assert(claimed.batch.leaseOwner === A, '认领即由 A 持约')

  console.log('\n[3] 另一页不能重复认领同一批调节单')
  const claimedAgain = await claimPendingAdjusts(s.pendingAdjustIds, { owner: B, shift: '夜班' })
  assert(claimedAgain.claimed === 0, `B 重复认领得到 0 张（实际 ${claimedAgain.claimed}）`)
  const stillOneBatch = (await db.executionBatches.where('state').anyOf('待执行', '执行中', '已中断').toArray()).length
  assert(stillOneBatch === 1, `未产生第二个未完成批次（实际 ${stillOneBatch}）`)

  console.log('\n[4] 租约内另一页不可抢占')
  let blocked = false
  try {
    await acquireLease(batchId, B)
  } catch (e) {
    blocked = e instanceof LeaseError
  }
  assert(blocked, 'B 在 A 租约有效期内抢占被拒')

  console.log('\n[5] A 逐张执行：执行记录与阀门开度同事务落库')
  let items = await listBatchItems(batchId)
  const r0 = await executeItem(batchId, items[0].id, A)
  assert(r0.item.status === '已完成' && r0.executed === true, '第 1 张执行成功')
  const v0 = await db.valves.get(items[0].valveId)
  const a0 = await db.adjusts.get(items[0].adjustId)
  assert(v0?.currentOpening === 60, '阀门开度已回写为 60%')
  assert(a0?.state === '已调节', '调节单已置「已调节」')
  assert(items[0].executedBy === '' && r0.item.executedBy === A, '执行记录记录了持约人 A')

  console.log('\n[6] 已完成项不能被重复处理（幂等跳过，开度不再变）')
  const repeat = await executeItem(batchId, items[0].id, A)
  assert(repeat.executed === false, '重复执行已完成项被跳过')
  const v0b = await db.valves.get(items[0].valveId)
  assert(v0b?.currentOpening === 60, '阀门开度未被二次改动')

  console.log('\n[7] B 非持约人执行被拒')
  let denied = false
  try {
    await executeItem(batchId, items[1].id, B)
  } catch (e) {
    denied = e instanceof LeaseError
  }
  assert(denied, 'B 未持约执行被拒')

  console.log('\n[8] 租约失效后 B 接管，从最后完成项之后恢复')
  // 模拟 A 页签崩溃：租约到期（把 leaseUntil 改到过去）
  await db.executionBatches.update(batchId, { leaseOwner: A, leaseUntil: Date.now() - 1 })
  const taken = await acquireLease(batchId, B)
  assert(taken.leaseOwner === B, 'B 在租约过期后成功接管')
  items = await listBatchItems(batchId)
  // 第 1 张已完成，接管应只处理剩余 2 张
  const r1 = await executeItem(batchId, items[1].id, B)
  const r2 = await executeItem(batchId, items[2].id, B)
  assert(r1.executed && r2.executed, 'B 执行剩余两张')
  const v1 = await db.valves.get(items[1].valveId)
  const v2 = await db.valves.get(items[2].valveId)
  assert(v1?.currentOpening === 70 && v2?.currentOpening === 80, '剩余阀门开度分别回写为 70% / 80%，无重复无遗漏')
  const batch = await db.executionBatches.get(batchId)
  assert(batch?.completedCount === 3 && batch?.lastCompletedSeq === 3, '批次完成计数=3，完成水位序号=3')

  console.log('\n[9] 他人执行中，新认领不得并入其批次')
  // 先造两张待下发单：A 认领第一张（持约但未执行完），B 再认领第二张应另起批次
  await db.adjusts.bulkPut([
    {
      id: 'aj-a1', valveId: s.valveIds[0], targetOpening: 60, basis: 'a1', executor: '待指派',
      state: '待下发' as const, reviewNote: '', batchId: '', createdAt: Date.now(), updatedAt: Date.now(), revision: 2
    },
    {
      id: 'aj-b1', valveId: s.valveIds[1], targetOpening: 70, basis: 'b1', executor: '待指派',
      state: '待下发' as const, reviewNote: '', batchId: '', createdAt: Date.now(), updatedAt: Date.now(), revision: 2
    }
  ])
  const aBatch = await claimPendingAdjusts(['aj-a1'], { owner: A, shift: '白班' })
  assert(aBatch.claimed === 1 && aBatch.batch.leaseOwner === A, 'A 先认领一张并持约（未执行）')
  const separate = await claimPendingAdjusts(['aj-b1'], { owner: B, shift: '夜班' })
  assert(separate.batch.id !== aBatch.batch.id, 'B 的新认领另起批次，未并入 A 执行中的批次')
  assert(separate.claimed === 1 && separate.batch.leaseOwner === B, '新批次由 B 持约，可独立执行')
  // 收尾：各自执行完，避免遗留持约批次影响后续用例
  const aItems = await listBatchItems(aBatch.batch.id)
  const bItems = await listBatchItems(separate.batch.id)
  await executeItem(aBatch.batch.id, aItems[0].id, A)
  await executeItem(separate.batch.id, bItems[0].id, B)

  console.log('\n[11] 心跳续约延长租约')
  // 新建一张待认领单用于心跳验证
  await db.adjusts.add({
    id: 'aj-hb',
    valveId: s.valveIds[0],
    targetOpening: 65,
    basis: 'hb',
    executor: '待指派',
    state: '待下发',
    reviewNote: '',
    batchId: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 2
  })
  const c2 = await claimPendingAdjusts(['aj-hb'], { owner: A, shift: '白班' })
  const before = (await db.executionBatches.get(c2.batch.id))?.leaseUntil ?? 0
  await new Promise((r) => setTimeout(r, 20))
  await renewLease(c2.batch.id, A)
  const after = (await db.executionBatches.get(c2.batch.id))?.leaseUntil ?? 0
  assert(after > before, '心跳续约后 leaseUntil 推后')
  // 非持约人续约无效
  await renewLease(c2.batch.id, B)
  const afterB = (await db.executionBatches.get(c2.batch.id))?.leaseUntil ?? 0
  assert(afterB === after, '非持约人 B 的续约不生效')

  console.log('\n[12] 失败项可重置重试')
  // 删除阀门制造业务失败
  const hbItems = await listBatchItems(c2.batch.id)
  await db.valves.delete(s.valveIds[0])
  const fr = await executeItem(c2.batch.id, hbItems[0].id, A)
  assert(fr.item.status === '失败' && !!fr.item.failReason, '阀门缺失时执行项标记失败并记录原因')
  // 恢复阀门后重试
  await db.valves.add({
    id: s.valveIds[0],
    buildingId: 'bd',
    stationId: 'st',
    code: 'V0',
    dn: 50,
    currentOpening: 50,
    designFlowM3h: 20,
    position: '楼栋总阀',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 2
  })
  await db.executionBatches.update(c2.batch.id, { leaseUntil: Date.now() - 1 })
  const reset = await retryFailedItems(c2.batch.id, B)
  assert(reset === 1, `重置 1 个失败项（实际 ${reset}）`)
  const hbItems2 = await listBatchItems(c2.batch.id)
  const rr = await executeItem(c2.batch.id, hbItems2[0].id, B)
  assert(rr.item.status === '已完成', '重试后执行项成功完成')

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed > 0) process.exitCode = 1
  await db.close()
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
