/**
 * 阀门状态（Pinia）
 * 维护阀门集合、开度编辑草稿与筛选条件。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, deleteValveCascade, type ValveRow } from '@/utils/db'
import {
  clampOpening,
  createEmptyValveFilter,
  type Valve,
  type ValveDraft,
  type ValveFilterState
} from '@/types/valve'
import type { Building } from '@/types/building'
import type { Station } from '@/types/station'
import { useStationStore } from '@/stores/stationStore'

export interface ValveEnriched {
  valve: Valve
  building: Building | null
  station: Station | null
  /** 相对设计流量的开度校核结论 */
  openingCheck: string
}

export const useValveStore = defineStore('valve', () => {
  const valveTable = useIdbTable<ValveRow>((database) => database.valves, { sortByUpdatedAt: false })
  const stationStore = useStationStore()

  const filter = ref<ValveFilterState>(createEmptyValveFilter())
  /** 开度编辑草稿：阀门 id → 待提交开度 */
  const openingDraft = ref<Record<string, number>>({})
  const selectedIds = ref<string[]>([])

  const valves = computed<ValveRow[]>(() =>
    [...valveTable.rows.value].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
  )

  const enriched = computed<ValveEnriched[]>(() =>
    valves.value.map((valve) => {
      const building = stationStore.buildingById.get(valve.buildingId) ?? null
      const station = stationStore.stationById.get(valve.stationId) ?? null
      return {
        valve,
        building,
        station,
        openingCheck: checkOpening(valve)
      }
    })
  )

  const filtered = computed<ValveEnriched[]>(() => {
    const text = filter.value.keyword.trim().toLowerCase()
    return enriched.value.filter((item) => {
      const { valve } = item
      if (filter.value.stationId && valve.stationId !== filter.value.stationId) return false
      if (filter.value.positions.length > 0 && !filter.value.positions.includes(valve.position)) return false
      if (filter.value.heatModes.length > 0) {
        const mode = item.building ? item.building.heatMode : ''
        if (!filter.value.heatModes.includes(mode)) return false
      }
      if (text.length === 0) return true
      return (
        valve.code.toLowerCase().includes(text) ||
        (item.building ? item.building.name.toLowerCase().includes(text) : false) ||
        (item.station ? item.station.name.toLowerCase().includes(text) : false)
      )
    })
  })

  const totalDesignFlow = computed(() => valves.value.reduce((sum, valve) => sum + valve.designFlowM3h, 0))

  const averageOpening = computed(() => {
    if (valves.value.length === 0) return 0
    const total = valves.value.reduce((sum, valve) => sum + valve.currentOpening, 0)
    return Math.round((total / valves.value.length) * 10) / 10
  })

  function checkOpening(valve: Valve): string {
    if (valve.designFlowM3h <= 0) return '缺设计流量'
    const ratio = valve.currentOpening / 100
    if (ratio < 0.3) return '开度偏小，可能存在欠流'
    if (ratio > 0.9) return '开度偏大，注意过流'
    return '开度在常规区间'
  }

  function patchFilter(patch: Partial<ValveFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyValveFilter()
  }

  async function createValve(draft: ValveDraft): Promise<ValveRow> {
    const building = stationStore.buildingById.get(draft.buildingId)
    return (await valveTable.create(
      {
        buildingId: draft.buildingId,
        stationId: building ? building.stationId : stationStore.currentStationId ?? '',
        code: draft.code.trim() || `VLV-${Date.now().toString().slice(-5)}`,
        dn: Math.max(0, Math.round(draft.dn)),
        currentOpening: clampOpening(draft.currentOpening),
        designFlowM3h: Math.max(0, Math.round(draft.designFlowM3h * 10) / 10),
        position: draft.position
      },
      'vv'
    )) as ValveRow
  }

  async function updateValve(id: string, patch: Partial<ValveDraft>): Promise<void> {
    const next: Partial<ValveRow> = { ...patch }
    if (patch.code !== undefined) next.code = patch.code.trim()
    if (patch.currentOpening !== undefined) next.currentOpening = clampOpening(patch.currentOpening)
    if (patch.buildingId !== undefined) {
      const building = stationStore.buildingById.get(patch.buildingId)
      if (building) next.stationId = building.stationId
    }
    await valveTable.update(id, next)
  }

  async function removeValve(id: string): Promise<void> {
    await deleteValveCascade(id)
    delete openingDraft.value[id]
    selectedIds.value = selectedIds.value.filter((item) => item !== id)
  }

  /* ---------------------------- 开度草稿 ---------------------------- */

  function setOpeningDraft(valveId: string, opening: number): void {
    openingDraft.value = { ...openingDraft.value, [valveId]: clampOpening(opening) }
  }

  function clearOpeningDraft(valveId?: string): void {
    if (valveId) {
      const next = { ...openingDraft.value }
      delete next[valveId]
      openingDraft.value = next
      return
    }
    openingDraft.value = {}
  }

  async function commitOpeningDraft(valveId: string): Promise<void> {
    const value = openingDraft.value[valveId]
    if (value === undefined) return
    await valveTable.update(valveId, { currentOpening: clampOpening(value) })
    clearOpeningDraft(valveId)
  }

  async function bulkCommitOpenings(): Promise<number> {
    const entries = Object.entries(openingDraft.value)
    if (entries.length === 0) return 0
    const rows = valves.value
      .filter((valve) => entries.some(([id]) => id === valve.id))
      .map((valve) => ({ ...valve, currentOpening: clampOpening(openingDraft.value[valve.id]), updatedAt: Date.now() }))
    if (rows.length > 0) await db.valves.bulkPut(rows)
    clearOpeningDraft()
    return rows.length
  }

  async function applyOpening(valveId: string, opening: number): Promise<void> {
    await valveTable.update(valveId, { currentOpening: clampOpening(opening) })
  }

  function toggleSelect(id: string, checked: boolean): void {
    selectedIds.value = checked
      ? Array.from(new Set([...selectedIds.value, id]))
      : selectedIds.value.filter((item) => item !== id)
  }

  function setSelectedIds(ids: string[]): void {
    selectedIds.value = [...ids]
  }

  function clearSelection(): void {
    selectedIds.value = []
  }

  return {
    valveTable,
    valves,
    enriched,
    filtered,
    filter,
    openingDraft,
    selectedIds,
    totalDesignFlow,
    averageOpening,
    patchFilter,
    resetFilter,
    createValve,
    updateValve,
    removeValve,
    setOpeningDraft,
    clearOpeningDraft,
    commitOpeningDraft,
    bulkCommitOpenings,
    applyOpening,
    toggleSelect,
    setSelectedIds,
    clearSelection,
    checkOpening
  }
})
