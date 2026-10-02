/**
 * 执行批次：换班协作的核心。
 * 待下发调节单先认领进批次（原子写入 adjust.batchId），
 * 页面拿到租约后逐张执行，执行记录与阀门开度同事务落库。
 */

/** 执行项处理状态 */
export type BatchItemStatus = '待执行' | '已完成' | '失败'

/** 批次整体状态 */
export type BatchState =
  | '待执行' // 已认领，尚未开始
  | '执行中' // 已拿到租约，正在逐张执行
  | '已完成' // 全部执行项完成
  | '已中断' // 存在失败项或租约被接管，等待恢复
  | '历史批次' // 旧调节单首次进入页面时补录的历史结果

/** 租约参数：TTL 内仅持有方可执行，到期可被另一页接管 */
export const LEASE_TTL_MS = 30_000
/** 执行期间心跳续约间隔（小于 TTL，保证正常执行不会丢约） */
export const LEASE_HEARTBEAT_MS = 10_000

export interface ExecutionItem {
  id: string
  batchId: string
  adjustId: string
  valveId: string
  /** 认领时的目标开度快照，执行以此为准回写阀门 */
  targetOpening: number
  /** 认领时的执行人快照 */
  executor: string
  seq: number
  status: BatchItemStatus
  /** 执行后的阀门最终开度（%），失败前未回写时为 null */
  executedOpening: number | null
  executedAt: number | null
  executedBy: string
  /** 失败原因（写库失败 / 阀门缺失等），用于接管恢复时提示 */
  failReason: string
  attempts: number
  createdAt: number
  updatedAt: number
}

export interface ExecutionBatch {
  id: string
  name: string
  state: BatchState
  /** 认领人（班次） */
  ownerShift: string
  /** 当前租约持有者标签（页签实例），空表示无租约、可被认领 */
  leaseOwner: string
  /** 租约到期时间戳（毫秒）；过去时间表示租约已失效 */
  leaseUntil: number
  /** 已完成执行项序号水位，接管方从该序号之后恢复 */
  lastCompletedSeq: number
  itemCount: number
  completedCount: number
  failedCount: number
  /** 是否为旧调节单补录的历史批次 */
  isHistorical: boolean
  createdAt: number
  updatedAt: number
}

/** 计算一个批次当前租约是否仍有效 */
export function isLeaseActive(batch: Pick<ExecutionBatch, 'leaseOwner' | 'leaseUntil'>, now = Date.now()): boolean {
  return batch.leaseOwner.length > 0 && batch.leaseUntil > now
}

/** 失败项是否可重试 */
export function isItemRetryable(item: Pick<ExecutionItem, 'status'>): boolean {
  return item.status === '失败'
}
