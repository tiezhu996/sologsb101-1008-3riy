/**
 * 执行批次：夜班 / 白班跨页面协作下发同一批调节单时的互斥单元。
 * - 待下发调节单先「认领」进批次，页面拿到租约后才能逐张执行；
 * - 租约带 TTL，由持约页心跳续期；租约失效或写入失败后另一页可从 completedSeq 接管恢复；
 * - 旧调节单（升级前已存在）在数据库迁移时补成 kind=history 的历史批次。
 */

/** 班次身份：每个浏览器标签页在会话内固定一个班次 */
export type ShiftName = '白班' | '夜班'

export const SHIFT_NAMES: ShiftName[] = ['白班', '夜班']

export type ExecutionBatchKind = 'normal' | 'history'

/** processing=持约执行中（或暂停待接管）；completed=全部执行完；interrupted=中断可接管 */
export type ExecutionBatchStatus = 'processing' | 'completed' | 'interrupted'

export interface ExecutionBatch {
  id: string
  /** 批次名称，如「白班执行批次 #1」 */
  name: string
  kind: ExecutionBatchKind
  /** 批次内调节单 id 的认领顺序（序号 = 下标 + 1） */
  adjustIds: string[]
  /** 认领时的调节单总数 */
  totalCount: number
  /** 已完成（已调节 / 已复核）张数 */
  completedCount: number
  /** 最后完成项序号（从 1 起，0 表示尚未完成任何一张）：断点恢复位点 */
  completedSeq: number
  status: ExecutionBatchStatus
  /** 当前持约页面 id；空串表示租约已释放、等待接管 */
  ownerId: string
  ownerShift: ShiftName | ''
  /** 租约版本：每次接管自增，旧持约页的心跳/步进据此被拒绝（CAS） */
  leaseVersion: number
  /** 租约到期时间戳；心跳与每次执行都会续期 */
  leaseExpiresAt: number
  claimedAt: number
  lastHeartbeatAt: number
  finishedAt: number | null
  /** 暂停 / 接管 / 异常等交接说明 */
  note: string
  createdAt: number
  updatedAt: number
}

/** 租约 TTL：持约页超过该时长没有心跳/执行即视为失效，另一页可接管 */
export const LEASE_TTL_MS = 15000
/** 持约页心跳间隔 */
export const HEARTBEAT_INTERVAL_MS = 5000
/** 升级/导入旧数据时补录的历史批次固定 id */
export const LEGACY_HISTORY_BATCH_ID = 'eb-legacy-history'
/** 历史批次名称 */
export const LEGACY_HISTORY_BATCH_NAME = '历史批次（旧调节单补录）'

export interface BatchClaimInput {
  /** 指定认领的调节单 id；为空表示认领全部可认领的待下发单 */
  adjustIds?: string[]
  name?: string
  ownerId: string
  ownerShift: ShiftName
}

export interface LeaseRef {
  ownerId: string
  leaseVersion: number
}
