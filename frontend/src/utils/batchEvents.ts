/**
 * 跨页签协作通知：执行批次发生认领 / 租约变化 / 执行进度后，
 * 通知同一浏览器其它页签即时刷新；Dexie liveQuery 已能响应跨标签写入，
 * 这里再叠加 BroadcastChannel（不支持时退回 storage 事件）保证租约状态及时可见。
 */

export type BatchEventType = 'batch-changed' | 'lease-changed' | 'request-refresh'

export interface BatchEvent {
  type: BatchEventType
  /** 发送方页签 owner，避免收到自己的通知 */
  sender: string
  batchId?: string
  at: number
}

const CHANNEL_NAME = 'gbheatgrid:execution-batch'
const STORAGE_FLAG = 'gbheatgrid:batch-event'

type Listener = (event: BatchEvent) => void

class BatchEventBus {
  private channel: BroadcastChannel | null = null
  private listeners = new Set<Listener>()

  constructor() {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME)
      this.channel.onmessage = (message: MessageEvent<BatchEvent>) => {
        this.dispatch(message.data)
      }
    } else if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key !== STORAGE_FLAG || !event.newValue) return
        try {
          this.dispatch(JSON.parse(event.newValue) as BatchEvent)
        } catch {
          /* 忽略无法解析的通知 */
        }
      })
    }
  }

  private dispatch(event: BatchEvent | undefined): void {
    if (!event) return
    this.listeners.forEach((listener) => listener(event))
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  post(event: Omit<BatchEvent, 'at'> & { at?: number }): void {
    const payload: BatchEvent = { ...event, at: Date.now() }
    if (this.channel) {
      this.channel.postMessage(payload)
      return
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_FLAG, JSON.stringify(payload))
    }
  }
}

export const batchEventBus = new BatchEventBus()
