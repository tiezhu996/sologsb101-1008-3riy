/** 调节单：由失衡度排序生成，执行与复核分两步回写状态 */
export type AdjustState = '待下发' | '已调节' | '已复核'

export interface Adjust {
  id: string
  valveId: string
  /** 目标开度（%） */
  targetOpening: number
  /** 调节依据 */
  basis: string
  executor: string
  state: AdjustState
  /** 复核意见 */
  reviewNote: string
  /** 所属执行批次 id；未认领的待下发单为空串；旧单补录后指向历史批次 */
  batchId: string
  /** 批次内序号（从 1 起），由认领顺序决定 */
  batchSeq: number
  /** 实际执行时间戳（未执行为 0） */
  executedAt: number
  /** 执行班次（未执行为空串） */
  executedShift: string
  /**
   * 最终执行开度（%）：执行时与阀门开度在同一事务写入。
   * 刷新与导出一律以此字段为最终执行结果，避免台账开度被后续手工改动后对不上。
   */
  executedOpening: number | null
  createdAt: number
  updatedAt: number
}

export const ADJUST_STATES: AdjustState[] = ['待下发', '已调节', '已复核']

/** 调节单状态机：待下发 → 已调节 → 已复核 */
export const ADJUST_STATE_FLOW: Record<AdjustState, AdjustState | null> = {
  待下发: '已调节',
  已调节: '已复核',
  已复核: null
}

export interface AdjustDraft {
  valveId: string
  targetOpening: number
  basis: string
  executor: string
  state: AdjustState
  reviewNote: string
}

export const EMPTY_ADJUST_DRAFT: AdjustDraft = {
  valveId: '',
  targetOpening: 50,
  basis: '',
  executor: '',
  state: '待下发',
  reviewNote: ''
}

/** 调节单的最终执行开度：执行记录优先；未执行时退回目标开度（用于待执行展示） */
export function effectiveExecutedOpening(adjust: Pick<Adjust, 'executedOpening' | 'targetOpening'>): number {
  return typeof adjust.executedOpening === 'number' ? adjust.executedOpening : adjust.targetOpening
}
