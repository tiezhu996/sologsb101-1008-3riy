/** 阀门：楼栋总阀或单元立管阀 */
export type ValvePosition = '单元立管' | '楼栋总阀'

export interface Valve {
  id: string
  buildingId: string
  /** 冗余换热站 id，便于按站快速筛选 */
  stationId: string
  code: string
  /** 口径 DN */
  dn: number
  /** 当前开度（%） */
  currentOpening: number
  /** 设计流量（m³/h） */
  designFlowM3h: number
  position: ValvePosition
  createdAt: number
  updatedAt: number
}

export const VALVE_POSITIONS: ValvePosition[] = ['单元立管', '楼栋总阀']

export interface ValveDraft {
  buildingId: string
  code: string
  dn: number
  currentOpening: number
  designFlowM3h: number
  position: ValvePosition
}

export const EMPTY_VALVE_DRAFT: ValveDraft = {
  buildingId: '',
  code: '',
  dn: 50,
  currentOpening: 50,
  designFlowM3h: 0,
  position: '楼栋总阀'
}

/** 阀门列表筛选条件（存于 valveStore，与 URL query 同步） */
export interface ValveFilterState {
  keyword: string
  stationId: string
  heatModes: string[]
  positions: ValvePosition[]
  onlyImbalanced: boolean
}

export function createEmptyValveFilter(): ValveFilterState {
  return { keyword: '', stationId: '', heatModes: [], positions: [], onlyImbalanced: false }
}

export function clampOpening(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}
