/**
 * 执行协作的页签身份：白班/夜班切换 + 当前页签唯一标识。
 * 同一浏览器的两个页签共享 IndexedDB，用 leaseOwner = `${shift}#${tag}` 区分持约方。
 * 班次选择跨页签共享（localStorage），页签标识仅本页签持有（sessionStorage）。
 */
import { LS_KEYS } from '@/utils/db'

export type ShiftKind = '白班' | '夜班'

export interface ShiftSession {
  shift: ShiftKind
  /** 页签实例短标识，仅本页签存活期有效 */
  tag: string
  /** 租约持有者字符串 */
  owner: string
}

function randomTag(): string {
  return Math.random().toString(36).slice(2, 6)
}

/** 按当前时间推断班次：08:00–20:00 白班，其余夜班 */
export function defaultShift(now = new Date()): ShiftKind {
  return now.getHours() >= 8 && now.getHours() < 20 ? '白班' : '夜班'
}

function readShift(): ShiftKind {
  const raw = localStorage.getItem(LS_KEYS.shiftTag)
  return raw === '夜班' ? '夜班' : '白班'
}

function writeShift(shift: ShiftKind): void {
  localStorage.setItem(LS_KEYS.shiftTag, shift)
}

/**
 * 读取当前页签会话。tag 存于 sessionStorage（关页签即失效），
 * 保证两个页签即便同班也有不同的租约持有者标识。
 */
export function readSession(): ShiftSession {
  const shift = readShift()
  let tag = sessionStorage.getItem(LS_KEYS.shiftTag)
  if (!tag) {
    tag = randomTag()
    sessionStorage.setItem(LS_KEYS.shiftTag, tag)
  }
  return { shift, tag, owner: `${shift}#${tag}` }
}

/** 切换班次（同步给其它页签通过 storage 事件感知），返回新会话 */
export function changeShift(shift: ShiftKind): ShiftSession {
  writeShift(shift)
  return readSession()
}
