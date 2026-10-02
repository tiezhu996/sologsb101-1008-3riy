/**
 * 调节单状态（Pinia）
 * 维护调节单状态机、复核统计与筛选。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, deleteAdjustCascade, type AdjustRow, type ExecutionItemRow } from '@/utils/db'
import {
  type Adjust,
  type AdjustDraft,
  type AdjustState
} from '@/types/adjust'
import { balanceLevel, imbalance, type BalanceLevel } from '@/utils/balance'
import type { Valve } from '@/types/valve'
import { useValveStore } from '@/stores/valveStore'

export interface AdjustEnriched {
  adjust: Adjust
  valve: Valve | null
  /** 生成调节单时的失衡度快照（按最新实测重算） */
  imbalanceValue: number
  level: BalanceLevel
  /** 归属执行项：用于展示/导出最终执行开度、执行批次与执行时间 */
  execution: ExecutionItemRow | null
  /** 最终执行开度（%）：优先执行记录，其次取阀门当前开度 */
  finalOpening: number | null
}

export const useAdjustStore = defineStore('adjust', () => {
  const adjustTable = useIdbTable<AdjustRow>((database) => database.adjusts, { sortByUpdatedAt: false })
  const executionItemTable = useIdbTable<ExecutionItemRow>((database) => database.executionItems, {
    sortByUpdatedAt: false
  })
  const valveStore = useValveStore()

  const stateFilter = ref<AdjustState[]>([])
  const keyword = ref('')
  const latestMeasureByValve = ref<Record<string, { flowM3h: number; roomTempC: number; date: string }>>({})

  /** 调节单 id → 执行项（由执行批次 hook 灌入或直接由本表派生） */
  const itemByAdjustId = computed(() => {
    const map = new Map<string, ExecutionItemRow>()
    executionItemTable.rows.value.forEach((item) => map.set(item.adjustId, item))
    return map
  })

  /** 由失衡度排行灌入最新实测快照，供失衡度重算与展示 */
  function syncLatestMeasures(
    rows: Array<{ valve: Valve; measured: number; latest: { roomTempC: number; date: string } | null }>
  ): void {
    const map: Record<string, { flowM3h: number; roomTempC: number; date: string }> = {}
    rows.forEach((row) => {
      if (row.latest) {
        map[row.valve.id] = { flowM3h: row.measured, roomTempC: row.latest.roomTempC, date: row.latest.date }
      }
    })
    latestMeasureByValve.value = map
  }

  const adjusts = computed<AdjustRow[]>(() =>
    [...adjustTable.rows.value].sort((a, b) => b.updatedAt - a.updatedAt)
  )

  const enriched = computed<AdjustEnriched[]>(() =>
    adjusts.value.map((adjust) => {
      const valve = valveStore.valves.find((item) => item.id === adjust.valveId) ?? null
      const snapshot = latestMeasureByValve.value[adjust.valveId]
      const design = valve ? valve.designFlowM3h : 0
      const measured = snapshot ? snapshot.flowM3h : 0
      const room = snapshot ? snapshot.roomTempC : 20
      const value = snapshot ? imbalance(measured, design, room) : 0
      const execution = itemByAdjustId.value.get(adjust.id) ?? null
      // 最终执行开度：以执行记录为准（换班多次操作也只认该单的完成记录），
      // 历史补录/无记录时回退到阀门当前开度
      const finalOpening =
        execution && execution.executedOpening !== null
          ? execution.executedOpening
          : adjust.state !== '待下发' && valve
            ? valve.currentOpening
            : null
      return {
        adjust,
        valve,
        imbalanceValue: value,
        level: valve && snapshot ? balanceLevel(value, measured, design) : '平衡',
        execution,
        finalOpening
      }
    })
  )

  const filtered = computed<AdjustEnriched[]>(() =>
    enriched.value.filter((item) => {
      if (stateFilter.value.length > 0 && !stateFilter.value.includes(item.adjust.state)) return false
      const text = keyword.value.trim().toLowerCase()
      if (text.length === 0) return true
      return (
        (item.valve ? item.valve.code.toLowerCase().includes(text) : false) ||
        item.adjust.executor.toLowerCase().includes(text) ||
        item.adjust.basis.toLowerCase().includes(text)
      )
    })
  )

  const stateCounts = computed<Record<AdjustState, number>>(() => {
    const counts: Record<AdjustState, number> = { 待下发: 0, 已调节: 0, 已复核: 0 }
    adjusts.value.forEach((adjust) => {
      counts[adjust.state] += 1
    })
    return counts
  })

  const reviewedPercent = computed(() =>
    adjusts.value.length === 0 ? 0 : Math.round((stateCounts.value['已复核'] / adjusts.value.length) * 100)
  )

  function patchFilter(patch: { stateFilter?: AdjustState[]; keyword?: string }): void {
    if (patch.stateFilter) stateFilter.value = patch.stateFilter
    if (patch.keyword !== undefined) keyword.value = patch.keyword
  }

  function resetFilter(): void {
    stateFilter.value = []
    keyword.value = ''
  }

  const hasAdjust = (valveId: string): boolean => adjusts.value.some((adjust) => adjust.valveId === valveId)

  async function createAdjust(draft: AdjustDraft): Promise<AdjustRow> {
    return (await adjustTable.create(
      {
        valveId: draft.valveId,
        targetOpening: Math.min(100, Math.max(0, Math.round(draft.targetOpening))),
        basis: draft.basis.trim(),
        executor: draft.executor.trim() || '待指派',
        state: draft.state,
        reviewNote: draft.reviewNote.trim()
      },
      'aj'
    )) as AdjustRow
  }

  async function updateAdjust(id: string, patch: Partial<AdjustDraft>): Promise<void> {
    const next: Partial<AdjustRow> = { ...patch }
    if (patch.targetOpening !== undefined) next.targetOpening = Math.min(100, Math.max(0, Math.round(patch.targetOpening)))
    if (patch.basis !== undefined) next.basis = patch.basis.trim()
    if (patch.executor !== undefined) next.executor = patch.executor.trim()
    if (patch.reviewNote !== undefined) next.reviewNote = patch.reviewNote.trim()
    await adjustTable.update(id, next)
  }

  async function removeAdjust(id: string): Promise<void> {
    await deleteAdjustCascade(id)
  }

  /** 已归属执行批次（已认领）的待下发调节单 id */
  const claimedAdjustIds = computed(
    () => new Set(adjusts.value.filter((adjust) => !!adjust.batchId).map((adjust) => adjust.id))
  )

  function isClaimed(id: string): boolean {
    return claimedAdjustIds.value.has(id)
  }

  /** 尚未认领、可进入执行批次的待下发调节单 */
  const pendingUnclaimed = computed(() =>
    adjusts.value.filter((adjust) => adjust.state === '待下发' && !adjust.batchId)
  )

  /**
   * 已调节 → 已复核的状态流转（复核入口）。
   * 待下发 → 已调节 已改由「执行批次」原子完成（执行记录 + 阀门开度同事务），
   * 此处不再单独执行，避免换班两页重复处理或开度对不上。
   */
  async function advanceReview(id: string): Promise<AdjustState | null> {
    const adjust = adjusts.value.find((item) => item.id === id)
    if (!adjust || adjust.state !== '已调节') return null
    await adjustTable.update(id, { state: '已复核' })
    return '已复核'
  }

  /** 复核：写复核意见并闭环 */
  async function review(id: string, note: string): Promise<void> {
    await adjustTable.update(id, { state: '已复核', reviewNote: note.trim() || '复核合格' })
  }

  /** 由失衡度排行批量生成调节单 */
  async function generateFromRank(
    rows: Array<{ valve: Valve; measured: number; roomTempC: number; imbalanceValue: number; level: BalanceLevel; suggestOpening: number; basisText: string }>
  ): Promise<number> {
    const now = Date.now()
    const payload: AdjustRow[] = rows
      .filter((row) => row.level === '严重失衡' || row.level === '偏大' || row.level === '偏小')
      .filter((row) => !hasAdjust(row.valve.id))
      .map((row, index) => ({
        id: `aj_${now.toString(36)}${index}${Math.random().toString(36).slice(2, 5)}`,
        valveId: row.valve.id,
        targetOpening: row.suggestOpening,
        basis: row.basisText,
        executor: '待指派',
        state: '待下发' as AdjustState,
        reviewNote: '',
        batchId: '',
        createdAt: now,
        updatedAt: now
      }))
    if (payload.length > 0) await db.adjusts.bulkPut(payload)
    return payload.length
  }

  return {
    adjustTable,
    executionItemTable,
    adjusts,
    enriched,
    filtered,
    stateFilter,
    keyword,
    stateCounts,
    reviewedPercent,
    syncLatestMeasures,
    latestMeasureByValve,
    itemByAdjustId,
    claimedAdjustIds,
    pendingUnclaimed,
    isClaimed,
    patchFilter,
    resetFilter,
    hasAdjust,
    createAdjust,
    updateAdjust,
    removeAdjust,
    advanceReview,
    review,
    generateFromRank
  }
})
