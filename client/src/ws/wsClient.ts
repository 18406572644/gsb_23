/**
 * WebSocket 客户端封装：
 * - 断线自动重连（指数退避 + 抖动，上限 15s）
 * - 断线期间非易失消息进入发送队列，重连后按需补发
 * - 应用层心跳（ping/pong），超时判定假死并主动断开触发重连
 */

export type ConnStatus = 'offline' | 'connecting' | 'online' | 'reconnecting'

const MAX_QUEUE = 200
const PING_INTERVAL = 10_000
const PONG_TIMEOUT = 5_000

export class WSClient {
  private ws: WebSocket | null = null
  private url = ''
  private manualClose = false
  private attempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  /** 断线期间排队的消息（批注等非 OT 消息；编辑操作由 OTClient 自己缓存） */
  private outbox: object[] = []

  status: ConnStatus = 'offline'
  onStatus: (status: ConnStatus, attempt: number) => void = () => {}
  onOpen: () => void = () => {}
  onMessage: (msg: unknown) => void = () => {}

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN
  }

  connect(url: string) {
    this.url = url
    this.manualClose = false
    this.clearReconnect()
    this.openSocket()
  }

  /** 主动断开（模拟断网）：不自动重连，直到再次调用 connect */
  disconnect() {
    this.manualClose = true
    this.clearReconnect()
    this.stopHeartbeat()
    this.ws?.close()
    this.setStatus('offline', 0)
  }

  private openSocket() {
    this.setStatus(this.attempts > 0 ? 'reconnecting' : 'connecting', this.attempts)
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.attempts = 0
      this.setStatus('online', 0)
      this.startHeartbeat()
      this.onOpen()
    }
    ws.onmessage = (ev) => {
      let msg: unknown
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
      } catch {
        console.warn('[ws] 收到无法解析的消息，已忽略')
        return
      }
      this.onMessage(msg)
    }
    ws.onclose = () => {
      this.stopHeartbeat()
      if (!this.manualClose) this.scheduleReconnect()
      else this.setStatus('offline', 0)
    }
    ws.onerror = () => {
      // 交由 onclose 统一处理重连
      ws.close()
    }
  }

  private scheduleReconnect() {
    if (this.manualClose) return
    this.attempts++
    // 指数退避 + 抖动：1s, 2s, 4s, ... 封顶 15s
    const backoff = Math.min(15_000, 1000 * 2 ** (this.attempts - 1))
    const delay = backoff + Math.floor(Math.random() * 500)
    this.setStatus('reconnecting', this.attempts)
    this.clearReconnect()
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay)
  }

  private clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private setStatus(s: ConnStatus, attempt: number) {
    this.status = s
    this.onStatus(s, attempt)
  }

  /** 发送消息；断线时非易失消息排队，光标等易失消息直接丢弃 */
  send(msg: object) {
    if (this.isOpen) {
      this.ws!.send(JSON.stringify(msg))
      return
    }
    const type = (msg as { type?: string }).type
    if (type === 'cursor' || type === 'ping') return
    if (this.outbox.length < MAX_QUEUE) this.outbox.push(msg)
  }

  /** 重连并完成重同步后，补发排队消息 */
  flushOutbox() {
    if (!this.isOpen) return
    for (const m of this.outbox.splice(0)) this.ws!.send(JSON.stringify(m))
  }

  /** 断线期间排队、重连补发的非易失消息条数（不含光标 / ping） */
  get pendingCount() {
    return this.outbox.length
  }

  /** 队列中待发送的批注消息条数（ann:add / ann:reply / ann:resolve / ann:delete） */
  get pendingAnnotationCount() {
    return this.outbox.filter((m) => (m as { type?: string }).type?.startsWith('ann:')).length
  }

  clearOutbox() {
    this.outbox = []
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.pingTimer = setInterval(() => {
      if (!this.isOpen) return
      this.ws!.send(JSON.stringify({ type: 'ping', t: Date.now() }))
      // 5 秒内未收到任何服务端消息（pong / 广播）视为假死
      this.pongTimer = setTimeout(() => {
        console.warn('[ws] 心跳超时，主动断开重连')
        this.ws?.close()
      }, PONG_TIMEOUT)
    }, PING_INTERVAL)
  }

  /** 任何服务端消息都证明连接存活 */
  noteAlive() {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  private stopHeartbeat() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.pingTimer = null
    this.pongTimer = null
  }
}
