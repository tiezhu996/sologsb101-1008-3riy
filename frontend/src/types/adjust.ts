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
  /** 认领进的执行批次 id；未认领（待下发）时为空 */
  batchId?: string
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
