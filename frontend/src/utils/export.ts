/**
 * 导出工具：整库 JSON 存档、调节单 CSV、剪贴板复制
 */
import type { Station } from '@/types/station'
import type { Building } from '@/types/building'
import type { Valve } from '@/types/valve'
import type { Measure } from '@/types/measure'
import type { Adjust } from '@/types/adjust'
import type { ExecutionBatch } from '@/types/executionBatch'
import { imbalance, balanceLevel, flowRatio } from '@/utils/balance'
import { formatDateTime } from '@/utils/datetime'
import { effectiveExecutedOpening } from '@/types/adjust'

export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function stampSuffix(): string {
  const date = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

export function exportBackupJson(payload: unknown): string {
  const filename = `gbheatgrid-backup-${stampSuffix()}.json`
  download(filename, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8')
  return filename
}

export function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 导出调节单 CSV（含失衡度、流量比与最终执行结果） */
export function exportAdjustCsv(
  stations: Station[],
  buildings: Building[],
  valves: Valve[],
  measures: Measure[],
  adjusts: Adjust[],
  batches: ExecutionBatch[] = []
): string {
  const header = [
    '换热站',
    '楼栋',
    '供热方式',
    '阀门编号',
    '口径DN',
    '位置',
    '设计流量(m³/h)',
    '实测流量(m³/h)',
    '流量比',
    '室温(℃)',
    '失衡度(%)',
    '判级',
    '台账当前开度(%)',
    '目标开度(%)',
    '最终执行开度(%)',
    '执行时间',
    '执行班次',
    '执行批次',
    '批次序号',
    '调节依据',
    '执行人',
    '状态',
    '复核意见'
  ]
  const batchById = new Map(batches.map((batch) => [batch.id, batch]))
  /** 导出顺序：先批次（历史批次最早），批次内按序号；未认领单按创建时间排最后 */
  const batchRank = (batch: ExecutionBatch | undefined): number => {
    if (!batch) return Number.MAX_SAFE_INTEGER
    return batch.kind === 'history' ? 0 : new Date(batch.claimedAt).getTime() || 1
  }
  const ordered = [...adjusts].sort((a, b) => {
    const ba = batchById.get(a.batchId)
    const bb = batchById.get(b.batchId)
    const rankDiff = batchRank(ba) - batchRank(bb)
    if (rankDiff !== 0) return rankDiff
    const seqDiff = a.batchSeq - b.batchSeq
    if (seqDiff !== 0) return seqDiff
    return a.createdAt - b.createdAt
  })
  const lines: string[] = [header.map(csvCell).join(',')]
  ordered.forEach((adjust) => {
    const valve = valves.find((item) => item.id === adjust.valveId)
    const building = valve ? buildings.find((item) => item.id === valve.buildingId) ?? null : null
    const station = building ? stations.find((item) => item.id === building.stationId) ?? null : null
    const own = measures.filter((item) => item.valveId === adjust.valveId).sort((a, b) => a.date.localeCompare(b.date))
    const latest = own[own.length - 1]
    const design = valve ? valve.designFlowM3h : 0
    const measured = latest ? latest.flowM3h : 0
    const room = latest ? latest.roomTempC : 0
    const value = imbalance(measured, design, room)
    const batch = batchById.get(adjust.batchId)
    const finalOpening = effectiveExecutedOpening(adjust)
    lines.push(
      [
        station ? station.name : '—',
        building ? building.name : '—',
        building ? building.heatMode : '—',
        valve ? valve.code : '—',
        valve ? valve.dn : '—',
        valve ? valve.position : '—',
        design,
        latest ? measured : '—',
        latest ? flowRatio(measured, design).toFixed(2) : '—',
        latest ? room : '—',
        value,
        balanceLevel(value, measured, design),
        valve ? valve.currentOpening : '—',
        adjust.targetOpening,
        adjust.executedAt > 0 ? finalOpening : '—',
        adjust.executedAt > 0 ? formatDateTime(adjust.executedAt) : '—',
        adjust.executedShift || '—',
        batch ? batch.name : '—',
        adjust.batchSeq > 0 ? adjust.batchSeq : '—',
        adjust.basis,
        adjust.executor,
        adjust.state,
        adjust.reviewNote
      ]
        .map(csvCell)
        .join(',')
    )
  })
  const filename = `调节单-${stampSuffix()}.csv`
  download(filename, `\uFEFF${lines.join('\n')}`, 'text/csv;charset=utf-8')
  return filename
}

/** 导出失衡度排行 CSV */
export function exportBalanceCsv(
  rows: Array<{
    station: Station | null
    building: Building | null
    valve: Valve
    measured: number
    ratio: number
    flowDeviation: number
    roomDeviation: number
    imbalanceValue: number
    level: string
  }>
): string {
  const header = ['换热站', '楼栋', '阀门编号', '设计流量', '实测流量', '流量比', '流量偏差(%)', '室温偏差(℃)', '失衡度(%)', '判级']
  const lines: string[] = [header.map(csvCell).join(',')]
  rows.forEach((row) => {
    lines.push(
      [
        row.station ? row.station.name : '—',
        row.building ? row.building.name : '—',
        row.valve.code,
        row.valve.designFlowM3h,
        row.measured,
        row.ratio.toFixed(2),
        row.flowDeviation.toFixed(1),
        row.roomDeviation.toFixed(1),
        row.imbalanceValue.toFixed(1),
        row.level
      ]
        .map(csvCell)
        .join(',')
    )
  })
  const filename = `失衡度排行-${stampSuffix()}.csv`
  download(filename, `\uFEFF${lines.join('\n')}`, 'text/csv;charset=utf-8')
  return filename
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    return false
  }
  return false
}

/** 解析批量粘贴的实测数据：每行 阀门编号,日期,流量,供温,回温,室温[,操作人] */
export function parseMeasureBatch(text: string): Array<{
  code: string
  date: string
  flowM3h: number
  supplyTempC: number
  returnTempC: number
  roomTempC: number
  operator: string
}> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const parts = line.split(/[,\t;]/).map((item) => item.trim())
      return {
        code: parts[0] ?? '',
        date: parts[1] ?? '',
        flowM3h: Number(parts[2] ?? 0),
        supplyTempC: Number(parts[3] ?? 0),
        returnTempC: Number(parts[4] ?? 0),
        roomTempC: Number(parts[5] ?? 0),
        operator: parts[6] ?? ''
      }
    })
    .filter((item) => item.code.length > 0)
}
