/** 换热站：二次网水力平衡调节的管理单元 */
export interface Station {
  id: string
  name: string
  /** 供热面积（m²） */
  heatAreaM2: number
  /** 设计流量（m³/h） */
  designFlowM3h: number
  /** 设计供水温度（℃） */
  supplyTempC: number
  /** 设计回水温度（℃） */
  returnTempC: number
  commissionYear: number
  createdAt: number
  updatedAt: number
}

export interface StationDraft {
  name: string
  heatAreaM2: number
  designFlowM3h: number
  supplyTempC: number
  returnTempC: number
  commissionYear: number
}

export const EMPTY_STATION_DRAFT: StationDraft = {
  name: '',
  heatAreaM2: 0,
  designFlowM3h: 0,
  supplyTempC: 55,
  returnTempC: 40,
  commissionYear: new Date().getFullYear()
}

/** 换热站卡片回显用的聚合值 */
export interface StationStat {
  stationId: string
  buildingCount: number
  valveCount: number
  imbalancedCount: number
  pendingReviewCount: number
}

export function formatArea(areaM2: number): string {
  if (!Number.isFinite(areaM2)) return '—'
  if (areaM2 >= 10000) return `${(areaM2 / 10000).toFixed(2)} 万m²`
  return `${Math.round(areaM2)} m²`
}

export function formatFlow(flowM3h: number): string {
  if (!Number.isFinite(flowM3h)) return '—'
  return `${flowM3h.toFixed(1)} m³/h`
}
