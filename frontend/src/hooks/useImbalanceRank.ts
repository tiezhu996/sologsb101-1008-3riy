/**
 * 失衡度排行：汇总每个阀门的最新实测与设计流量，派生流量比、室温偏差、
 * 合成失衡度与建议目标开度，并按失衡度降序排列。
 * 被失衡度计算页、调节单页消费。
 */
import { computed, type ComputedRef } from 'vue'
import { useIdbTable, type UseIdbTableResult } from '@/hooks/useIdbTable'
import { useStationStore } from '@/stores/stationStore'
import { useValveStore } from '@/stores/valveStore'
import type { Measure } from '@/types/measure'
import type { Valve } from '@/types/valve'
import type { Building } from '@/types/building'
import type { Station } from '@/types/station'
import type { MeasureRow } from '@/utils/db'
import {
  balanceLevel,
  flowDeviationPct,
  flowRatio,
  imbalance,
  roomDeviationC,
  round,
  suggestOpening,
  type BalanceLevel
} from '@/utils/balance'

export interface ImbalanceRow {
  valve: Valve
  building: Building | null
  station: Station | null
  latest: Measure | null
  measureCount: number
  /** 最新实测流量，无实测时为 0 */
  measured: number
  ratio: number
  /** 流量偏差率（%），正值为偏大 */
  flowDeviation: number
  roomDeviation: number
  imbalanceValue: number
  level: BalanceLevel
  suggestOpening: number
}

export interface ImbalanceSummary {
  total: number
  balanced: number
  minor: number
  severe: number
  average: number
  /** 严重失衡占比 0-100 */
  severePercent: number
}

export interface UseImbalanceRankResult {
  rows: ComputedRef<ImbalanceRow[]>
  /** 叠加 valveStore 筛选条件后的排行 */
  filteredRows: ComputedRef<ImbalanceRow[]>
  measureTable: UseIdbTableResult<MeasureRow>
  summary: ComputedRef<ImbalanceSummary>
  rowOf: (valveId: string) => ImbalanceRow | null
  reload: () => Promise<void>
}

export function useImbalanceRank(): UseImbalanceRankResult {
  const stationStore = useStationStore()
  const valveStore = useValveStore()
  const measureTable = useIdbTable<MeasureRow>((database) => database.measures, { sortByUpdatedAt: false })

  const rows = computed<ImbalanceRow[]>(() => {
    const grouped = new Map<string, MeasureRow[]>()
    measureTable.rows.value.forEach((measure) => {
      const list = grouped.get(measure.valveId)
      if (list) list.push(measure)
      else grouped.set(measure.valveId, [measure])
    })

    const list = valveStore.valves.map((valve) => {
      const own = (grouped.get(valve.id) ?? []).sort((a, b) => a.date.localeCompare(b.date))
      const latest = own.length > 0 ? own[own.length - 1] : null
      const measured = latest ? latest.flowM3h : 0
      const room = latest ? latest.roomTempC : 20
      const design = valve.designFlowM3h
      const ratio = flowRatio(measured, design)
      const value = latest ? imbalance(measured, design, room) : 0
      const level = latest ? balanceLevel(value, measured, design) : '平衡'
      const building = stationStore.buildings.find((item) => item.id === valve.buildingId) ?? null
      const station = stationStore.stations.find((item) => item.id === valve.stationId) ?? null
      return {
        valve,
        building,
        station,
        latest,
        measureCount: own.length,
        measured,
        ratio,
        flowDeviation: latest ? flowDeviationPct(measured, design) : 0,
        roomDeviation: latest ? roomDeviationC(room) : 0,
        imbalanceValue: value,
        level,
        suggestOpening: latest ? suggestOpening(valve.currentOpening, ratio, level) : valve.currentOpening
      }
    })
    return list.sort((a, b) => b.imbalanceValue - a.imbalanceValue)
  })

  const filteredRows = computed<ImbalanceRow[]>(() => {
    const filter = valveStore.filter
    const text = filter.keyword.trim().toLowerCase()
    return rows.value.filter((row) => {
      if (filter.stationId && row.valve.stationId !== filter.stationId) return false
      if (filter.positions.length > 0 && !filter.positions.includes(row.valve.position)) return false
      if (filter.heatModes.length > 0) {
        const mode = row.building ? row.building.heatMode : ''
        if (!filter.heatModes.includes(mode)) return false
      }
      if (filter.onlyImbalanced && row.level === '平衡') return false
      if (text.length === 0) return true
      return (
        row.valve.code.toLowerCase().includes(text) ||
        (row.building ? row.building.name.toLowerCase().includes(text) : false) ||
        (row.station ? row.station.name.toLowerCase().includes(text) : false)
      )
    })
  })

  const summary = computed<ImbalanceSummary>(() => {
    const list = rows.value.filter((row) => row.latest !== null)
    const severe = list.filter((row) => row.level === '严重失衡').length
    const balanced = list.filter((row) => row.level === '平衡').length
    const average = list.length === 0 ? 0 : round(list.reduce((sum, row) => sum + row.imbalanceValue, 0) / list.length, 1)
    return {
      total: rows.value.length,
      balanced,
      minor: list.length - balanced - severe,
      severe,
      average,
      severePercent: list.length === 0 ? 0 : Math.round((severe / list.length) * 100)
    }
  })

  const rowOf = (valveId: string): ImbalanceRow | null => rows.value.find((row) => row.valve.id === valveId) ?? null

  return {
    rows,
    filteredRows,
    measureTable,
    summary,
    rowOf,
    reload: measureTable.refresh
  }
}
