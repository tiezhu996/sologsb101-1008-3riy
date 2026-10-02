/**
 * 换热站与楼栋状态（Pinia）
 * 维护换热站/楼栋列表、当前选中站与面积区间、供热方式筛选。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  db,
  deleteBuildingCascade,
  deleteStationCascade,
  readUiPrefs,
  writeUiPrefs,
  type BuildingRow,
  type StationRow
} from '@/utils/db'
import type { Building, BuildingDraft, HeatMode } from '@/types/building'
import { HEAT_MODES } from '@/types/building'
import type { StationDraft } from '@/types/station'

export const useStationStore = defineStore('station', () => {
  const stationTable = useIdbTable<StationRow>((database) => database.stations, { sortByUpdatedAt: false })
  const buildingTable = useIdbTable<BuildingRow>((database) => database.buildings, { sortByUpdatedAt: false })

  const currentStationId = ref<string | null>(readUiPrefs().lastStationId)
  const keyword = ref('')
  const heatModes = ref<HeatMode[]>([])
  const areaFrom = ref<number | null>(null)
  const areaTo = ref<number | null>(null)

  const stations = computed<StationRow[]>(() =>
    [...stationTable.rows.value].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  )

  const buildings = computed<BuildingRow[]>(() =>
    [...buildingTable.rows.value].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  )

  const stationById = computed(() => new Map(stations.value.map((station) => [station.id, station])))
  const buildingById = computed(() => new Map(buildings.value.map((building) => [building.id, building])))

  const buildingsOfStation = computed(() =>
    currentStationId.value ? buildings.value.filter((item) => item.stationId === currentStationId.value) : buildings.value
  )

  /** 楼栋筛选：供热方式 + 建筑面积区间 + 关键字 */
  const filteredBuildings = computed(() =>
    buildingsOfStation.value.filter((building) => {
      if (heatModes.value.length > 0 && !heatModes.value.includes(building.heatMode)) return false
      if (areaFrom.value !== null && building.areaM2 < areaFrom.value) return false
      if (areaTo.value !== null && building.areaM2 > areaTo.value) return false
      const text = keyword.value.trim().toLowerCase()
      if (text.length === 0) return true
      const station = stationById.value.get(building.stationId)
      return (
        building.name.toLowerCase().includes(text) ||
        (station ? station.name.toLowerCase().includes(text) : false)
      )
    })
  )

  const filteredStations = computed(() => stations.value)

  const currentStation = computed<StationRow | null>(
    () => stations.value.find((station) => station.id === currentStationId.value) ?? null
  )

  const heatModeOptions = HEAT_MODES

  async function selectStation(id: string | null): Promise<void> {
    currentStationId.value = id
    writeUiPrefs({ ...readUiPrefs(), lastStationId: id })
    await Promise.resolve()
  }

  /* ------------------------------ 换热站 ------------------------------ */

  async function createStation(draft: StationDraft): Promise<StationRow> {
    const row = (await stationTable.create(
      {
        name: draft.name.trim(),
        heatAreaM2: Math.max(0, Math.round(draft.heatAreaM2)),
        designFlowM3h: Math.max(0, Math.round(draft.designFlowM3h * 10) / 10),
        supplyTempC: Math.round(draft.supplyTempC * 10) / 10,
        returnTempC: Math.round(draft.returnTempC * 10) / 10,
        commissionYear: Math.round(draft.commissionYear)
      },
      'st'
    )) as StationRow
    await selectStation(row.id)
    return row
  }

  async function updateStation(id: string, patch: Partial<StationDraft>): Promise<void> {
    const next: Partial<StationRow> = { ...patch }
    if (patch.name !== undefined) next.name = patch.name.trim()
    await stationTable.update(id, next)
  }

  async function removeStation(id: string): Promise<void> {
    await deleteStationCascade(id)
    if (currentStationId.value === id) {
      const fallback = stations.value.find((station) => station.id !== id) ?? null
      await selectStation(fallback ? fallback.id : null)
    }
  }

  /* ------------------------------- 楼栋 ------------------------------- */

  async function createBuilding(draft: BuildingDraft): Promise<BuildingRow> {
    return (await buildingTable.create(
      {
        stationId: draft.stationId || currentStationId.value || '',
        name: draft.name.trim(),
        areaM2: Math.max(0, Math.round(draft.areaM2)),
        floors: Math.max(0, Math.round(draft.floors)),
        units: Math.max(0, Math.round(draft.units)),
        heatMode: draft.heatMode
      },
      'bd'
    )) as BuildingRow
  }

  async function updateBuilding(id: string, patch: Partial<BuildingDraft>): Promise<void> {
    const next: Partial<BuildingRow> = { ...patch }
    if (patch.name !== undefined) next.name = patch.name.trim()
    await buildingTable.update(id, next)
  }

  async function removeBuilding(id: string): Promise<void> {
    await deleteBuildingCascade(id)
  }

  function setHeatModes(values: HeatMode[]): void {
    heatModes.value = values
  }

  function setAreaRange(from: number | null, to: number | null): void {
    areaFrom.value = from
    areaTo.value = to
  }

  function resetFilter(): void {
    keyword.value = ''
    heatModes.value = []
    areaFrom.value = null
    areaTo.value = null
  }

  /** 供热面积合计 */
  const totalHeatArea = computed(() => stations.value.reduce((sum, station) => sum + station.heatAreaM2, 0))

  function buildingsOf(stationId: string): Building[] {
    return buildings.value.filter((item) => item.stationId === stationId)
  }

  function getStation(id: string): Promise<StationRow | undefined> {
    return db.stations.get(id)
  }

  return {
    stationTable,
    buildingTable,
    stations,
    filteredStations,
    buildings,
    buildingsOfStation,
    filteredBuildings,
    currentStationId,
    currentStation,
    stationById,
    buildingById,
    heatModeOptions,
    keyword,
    heatModes,
    areaFrom,
    areaTo,
    totalHeatArea,
    selectStation,
    createStation,
    updateStation,
    removeStation,
    createBuilding,
    updateBuilding,
    removeBuilding,
    setHeatModes,
    setAreaRange,
    resetFilter,
    buildingsOf,
    getStation
  }
})
