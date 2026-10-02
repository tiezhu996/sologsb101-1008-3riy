/**
 * 调节单状态（Pinia）
 * 维护调节单状态机、复核统计与筛选。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type AdjustRow } from '@/utils/db'
import {
  ADJUST_STATE_FLOW,
  type Adjust,
  type AdjustDraft,
  type AdjustState
} from '@/types/adjust'
import { useValveStore } from '@/stores/valveStore'
import { balanceLevel, imbalance, type BalanceLevel } from '@/utils/balance'
import type { Valve } from '@/types/valve'

export interface AdjustEnriched {
  adjust: Adjust
  valve: Valve | null
  /** 生成调节单时的失衡度快照（按最新实测重算） */
  imbalanceValue: number
  level: BalanceLevel
}

export const useAdjustStore = defineStore('adjust', () => {
  const adjustTable = useIdbTable<AdjustRow>((database) => database.adjusts, { sortByUpdatedAt: false })
  const valveStore = useValveStore()

  const stateFilter = ref<AdjustState[]>([])
  const keyword = ref('')
  const latestMeasureByValve = ref<Record<string, { flowM3h: number; roomTempC: number; date: string }>>({})

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
      return {
        adjust,
        valve,
        imbalanceValue: value,
        level: valve && snapshot ? balanceLevel(value, measured, design) : '平衡'
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
    await adjustTable.remove(id)
  }

  /** 状态流转：已调节时把目标开度回写到阀门 */
  async function advance(id: string): Promise<AdjustState | null> {
    const adjust = adjusts.value.find((item) => item.id === id)
    if (!adjust) return null
    const next = ADJUST_STATE_FLOW[adjust.state]
    if (!next) return null
    await adjustTable.update(id, { state: next })
    if (next === '已调节') {
      await valveStore.applyOpening(adjust.valveId, adjust.targetOpening)
    }
    return next
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
        createdAt: now,
        updatedAt: now
      }))
    if (payload.length > 0) await db.adjusts.bulkPut(payload)
    return payload.length
  }

  return {
    adjustTable,
    adjusts,
    enriched,
    filtered,
    stateFilter,
    keyword,
    stateCounts,
    reviewedPercent,
    syncLatestMeasures,
    latestMeasureByValve,
    patchFilter,
    resetFilter,
    hasAdjust,
    createAdjust,
    updateAdjust,
    removeAdjust,
    advance,
    review,
    generateFromRank
  }
})
