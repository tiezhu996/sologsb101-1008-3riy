/**
 * 水力失衡度计算、开度调整步长建议与单位格式化
 * 失衡度 = |流量偏差率| × 0.7 + |室温偏差| × 1.5（单位：%）
 */
import type { Building } from '@/types/building'
import type { Valve } from '@/types/valve'
import type { Measure } from '@/types/measure'
import { ROOM_TARGET_C } from '@/types/measure'

/** 平衡判定阈值：失衡度 ≤ 10% 视为平衡 */
export const IMBALANCE_BALANCED = 10
/** 常规偏大/偏小上限：≤ 25%，超过即严重失衡 */
export const IMBALANCE_WARN = 25

export type BalanceLevel = '平衡' | '偏大' | '偏小' | '严重失衡'

export const BALANCE_COLOR: Record<BalanceLevel, string> = {
  平衡: '#1e8449',
  偏大: '#d68910',
  偏小: '#2b6cb0',
  严重失衡: '#c0392b'
}

export const BALANCE_BG: Record<BalanceLevel, string> = {
  平衡: '#eaf6ee',
  偏大: '#fdf3e3',
  偏小: '#e8f1fb',
  严重失衡: '#fdecea'
}

/** TDesign 标签主题色映射 */
export const BALANCE_THEME: Record<BalanceLevel, 'success' | 'warning' | 'primary' | 'danger'> = {
  平衡: 'success',
  偏大: 'warning',
  偏小: 'primary',
  严重失衡: 'danger'
}

export const BALANCE_ICON: Record<BalanceLevel, string> = {
  平衡: 'check-circle-filled',
  偏大: 'arrow-up',
  偏小: 'arrow-down',
  严重失衡: 'error-circle-filled'
}

export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 流量比 = 实测流量 ÷ 设计流量 */
export function flowRatio(measured: number, design: number): number {
  if (!Number.isFinite(design) || design <= 0) return 0
  return round(measured / design, 4)
}

/** 流量偏差率（%），正值为偏大 */
export function flowDeviationPct(measured: number, design: number): number {
  if (!Number.isFinite(design) || design <= 0) return 0
  return round((measured / design - 1) * 100, 2)
}

/** 室温偏差（℃） */
export function roomDeviationC(roomTempC: number): number {
  return round(roomTempC - ROOM_TARGET_C, 2)
}

/** 合成失衡度（%）：流量偏差占七成权重，室温偏差占三成权重 */
export function imbalance(measured: number, design: number, roomTempC: number): number {
  const flowPart = Math.abs(flowDeviationPct(measured, design)) * 0.7
  const roomPart = Math.abs(roomDeviationC(roomTempC)) * 1.5
  return round(flowPart + roomPart, 1)
}

/** 由失衡度与流量方向判定档位 */
export function balanceLevel(imbalanceValue: number, measured: number, design: number): BalanceLevel {
  if (imbalanceValue <= IMBALANCE_BALANCED) return '平衡'
  if (imbalanceValue > IMBALANCE_WARN) return '严重失衡'
  return flowDeviationPct(measured, design) > 0 ? '偏大' : '偏小'
}

export function balanceWeight(level: BalanceLevel): number {
  if (level === '严重失衡') return 40
  if (level === '平衡') return 0
  return 20
}

/**
 * 开度调整步长建议：目标开度 = 当前开度 ÷ 流量比，并按 5% 取整、限制在 20%~100%
 */
export function suggestOpening(currentOpening: number, ratio: number, level: BalanceLevel): number {
  if (level === '平衡') return Math.round(currentOpening)
  const safeRatio = ratio > 0.2 ? ratio : 0.2
  const raw = currentOpening / safeRatio
  const stepped = Math.round(raw / 5) * 5
  return Math.min(100, Math.max(20, stepped))
}

/** 依据文案 */
export function basisText(row: {
  valve: Valve
  building: Building | null
  ratio: number
  flowDeviation: number
  roomDeviation: number
  imbalanceValue: number
  level: BalanceLevel
}): string {
  const buildingName = row.building ? row.building.name : '未知楼栋'
  return `${buildingName} ${row.valve.code} 流量比 ${row.ratio.toFixed(2)}（偏差 ${row.flowDeviation.toFixed(1)}%）、室温偏差 ${row.roomDeviation.toFixed(1)}℃，合成失衡度 ${row.imbalanceValue.toFixed(1)}%，判定为「${row.level}」`
}

export function formatFlow(flowM3h: number): string {
  if (!Number.isFinite(flowM3h)) return '—'
  return `${flowM3h.toFixed(1)} m³/h`
}

export function formatTemp(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${value.toFixed(1)} ℃`
}

export function formatOpening(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${Math.round(value)}%`
}

export function formatImbalance(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${value.toFixed(1)}%`
}

/** 采集一组实测时的室温偏差提示 */
export function measureHint(measure: Pick<Measure, 'flowM3h' | 'roomTempC'>, designFlowM3h: number): string {
  const value = imbalance(measure.flowM3h, designFlowM3h, measure.roomTempC)
  return `失衡度约 ${value.toFixed(1)}%`
}
