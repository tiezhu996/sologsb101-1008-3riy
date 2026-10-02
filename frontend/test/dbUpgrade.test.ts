/**
 * 数据库 v2 → v3 升级迁移测试：
 * 先用旧版结构写入演示规模数据（旧调节单无批次/执行字段），
 * 再以新版 db 打开，验证：
 * - 旧调节单全部补录进历史批次，已执行单回填执行记录与最终开度；
 * - 待下发旧单保留待下发，可被新批次认领；
 * - 原数据不丢失。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import './setup-idb'
import Dexie, { type Table } from 'dexie'
import { db } from '@/utils/db'
import { LEGACY_HISTORY_BATCH_ID } from '@/types/executionBatch'
import { claimPendingIntoBatch } from '@/utils/executionBatch'

interface OldAdjust {
  id: string
  valveId: string
  targetOpening: number
  basis: string
  executor: string
  state: string
  reviewNote: string
  createdAt: number
  updatedAt: number
  revision?: number
}

class OldDb extends Dexie {
  adjusts!: Table<OldAdjust, string>

  constructor() {
    super('gbheatgrid')
    this.version(1).stores({
      stations: 'id, name, commissionYear',
      buildings: 'id, stationId, name, heatMode',
      valves: 'id, buildingId, code, position',
      measures: 'id, valveId, date',
      adjusts: 'id, valveId, state'
    })
    this.version(2).stores({
      stations: 'id, name, commissionYear, updatedAt',
      buildings: 'id, stationId, name, heatMode, updatedAt',
      valves: 'id, buildingId, stationId, code, position, updatedAt',
      measures: 'id, valveId, date, operator, updatedAt',
      adjusts: 'id, valveId, state, executor, updatedAt'
    })
  }
}

after(async () => {
  await db.delete()
})

test('v2→v3：旧调节单补成历史批次，待下发旧单可重新认领', async () => {
  const now = Date.now()
  const oldDb = new OldDb()
  const legacy: OldAdjust[] = [
    { id: 'aj-old-1', valveId: 'vv-1', targetOpening: 55, basis: '旧依据1', executor: '王海', state: '已复核', reviewNote: '合格', createdAt: now - 4000, updatedAt: now - 3000, revision: 2 },
    { id: 'aj-old-2', valveId: 'vv-2', targetOpening: 60, basis: '旧依据2', executor: '赵明', state: '已调节', reviewNote: '', createdAt: now - 2000, updatedAt: now - 1000, revision: 2 },
    { id: 'aj-old-3', valveId: 'vv-3', targetOpening: 62, basis: '旧依据3', executor: '孙倩', state: '待下发', reviewNote: '', createdAt: now - 500, updatedAt: now - 500, revision: 2 }
  ]
  await oldDb.adjusts.bulkPut(legacy)
  await oldDb.close()

  // 以当前版本（v3）打开同一库，触发 upgrade
  await db.open()

  const migrated = await db.adjusts.toArray()
  assert.equal(migrated.length, 3)
  const byId = new Map(migrated.map((item) => [item.id, item]))

  const done1 = byId.get('aj-old-1')!
  assert.equal(done1.batchId, LEGACY_HISTORY_BATCH_ID)
  assert.equal(done1.batchSeq, 1)
  assert.equal(done1.executedOpening, 55)
  assert.ok(done1.executedAt > 0)
  assert.equal(done1.reviewNote, '合格')

  const done2 = byId.get('aj-old-2')!
  assert.equal(done2.batchSeq, 2)
  assert.equal(done2.executedOpening, 60)

  const pending = byId.get('aj-old-3')!
  assert.equal(pending.state, '待下发')
  assert.equal(pending.batchId, LEGACY_HISTORY_BATCH_ID)
  assert.equal(pending.executedOpening, null)

  const history = await db.execBatches.get(LEGACY_HISTORY_BATCH_ID)
  assert.ok(history)
  assert.equal(history!.kind, 'history')
  assert.equal(history!.totalCount, 3)
  assert.equal(history!.completedCount, 2)
  assert.equal(history!.status, 'interrupted')
  assert.deepEqual(history!.adjustIds, ['aj-old-1', 'aj-old-2', 'aj-old-3'])

  // 待下发旧单可从历史批次重新认领进新批次执行
  const claim = await claimPendingIntoBatch({ ownerId: 'page_new', ownerShift: '白班' })
  assert.equal(claim.ok, true)
  assert.deepEqual(claim.batch!.adjustIds, ['aj-old-3'])
})
