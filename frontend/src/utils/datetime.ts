/** 时间格式化与班次工具（执行批次租约展示用） */
import type { ShiftName } from '@/types/executionBatch'

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** yyyy-MM-dd HH:mm:ss */
export function formatDateTime(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '—'
  const date = new Date(ms)
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  )
}

/** HH:mm:ss */
export function formatClock(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '--:--:--'
  const date = new Date(ms)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** 按本机小时推断班次：08:00~19:59 为白班，其余为夜班 */
export function currentShift(now: number = Date.now()): ShiftName {
  const hour = new Date(now).getHours()
  return hour >= 8 && hour < 20 ? '白班' : '夜班'
}

/** 租约剩余秒数（可能为负，表示已失效） */
export function leaseRemainingSeconds(expiresAt: number, now: number = Date.now()): number {
  return Math.ceil((expiresAt - now) / 1000)
}
