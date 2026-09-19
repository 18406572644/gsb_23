/**
 * OT 客户端状态机（与 shared/ot.ts 及服务端约定配套）：
 *
 * - 本地编辑乐观应用到文档，同时进入 unacked 队列；
 * - unacked[0] 为「已发送待确认」，其余为「缓冲」（连续输入会被 compose 合并）；
 * - 远程操作到达时，与所有未确认操作做双侧变换后应用；
 * - ack 超时 / 序号空洞 / 版本过旧 → 触发重同步；
 * - 重同步支持增量补齐（resyncOps）与全量快照回滚（rollback）。
 *
 * 发送节流：minSendInterval 内的连续输入合并为一条消息，
 * 在「实时性」与「消息频率 / 服务器压力」之间取平衡。
 */
import { compose, isNoop, transformPair, type Op } from '../../../shared/ot'

export interface OTCallbacks {
  sendOp: (op: Op, opId: string, revision: number) => void
  /** 将一个已完成变换的远程操作应用到本地文档 */
  applyRemote: (op: Op) => void
  requestResync: () => void
}

interface Unacked {
  opId: string
  op: Op
  sent: boolean
}

export class OTClient {
  revision = 0
  private unacked: Unacked[] = []
  private connected = false
  private lastSendAt = 0
  private sendTimer: ReturnType<typeof setTimeout> | null = null
  private ackTimer: ReturnType<typeof setTimeout> | null = null
  /** 发送节流窗口（ms）：连续输入在该窗口内合并发送 */
  minSendInterval = 60
  /** ack 超时（ms）：超过则认为消息丢失，主动请求重同步 */
  ackTimeoutMs = 5000
  private idSeq = 0
  /** 客户端实例随机盐：保证 opId 全局唯一（服务端按 opId 幂等去重） */
  private salt = Math.random().toString(36).slice(2, 10)

  constructor(private cb: OTCallbacks) {}

  get pendingCount() {
    return this.unacked.length
  }

  /** 未确认操作列表（重同步后用于批注锚点重放） */
  get unackedOps(): Op[] {
    return this.unacked.map((u) => u.op)
  }

  private genId() {
    return `op-${this.salt}-${(this.idSeq++).toString(36)}`
  }

  setConnected(v: boolean) {
    this.connected = v
    if (v) this.trySend()
  }

  /** 本地编辑：乐观应用（调用方负责），此处仅入队并尝试发送 */
  localChange(op: Op) {
    if (isNoop(op)) return
    const last = this.unacked[this.unacked.length - 1]
    if (last && !last.sent) {
      last.op = compose(last.op, op)
    } else {
      this.unacked.push({ opId: this.genId(), op, sent: false })
    }
    this.trySend()
  }

  /** 远程操作：与全部未确认操作互变换后返回应应用到本地文档的操作 */
  remoteChange(op: Op) {
    let x = op
    for (const u of this.unacked) {
      const pair = transformPair(x, u.op)
      x = pair[0]
      u.op = pair[1]
    }
    this.revision++
    this.cb.applyRemote(x)
  }

  ack(opId: string, revision: number) {
    if (!this.unacked.length || this.unacked[0].opId !== opId) {
      // ack 与本地队列对不上（可能丢消息）→ 重同步
      this.cb.requestResync()
      return
    }
    this.unacked.shift()
    this.revision = revision
    this.clearAckTimer()
    this.trySend()
  }

  /**
   * 增量重同步：missed 为服务端补发的操作流。
   * 其中可能包含「服务器已收到但 ack 丢失」的自己的操作 —— 按 opId 匹配直接确认。
   */
  resyncOps(missed: { opId: string; op: Op }[], revision: number) {
    for (const m of missed) {
      const idx = this.unacked.findIndex((u) => u.opId === m.opId)
      if (idx >= 0) {
        this.unacked.splice(idx, 1)
        continue
      }
      this.remoteChange(m.op)
    }
    this.revision = revision
    // 重发尚未确认的操作（基于新版本重新发送）
    for (const u of this.unacked) u.sent = false
    this.clearAckTimer()
    this.trySend()
  }

  /** 全量快照回滚：丢弃所有未确认操作。返回是否有被丢弃的本地修改。 */
  rollback(revision: number): boolean {
    const hadUnsynced = this.unacked.length > 0
    this.unacked = []
    this.revision = revision
    this.clearAckTimer()
    if (this.sendTimer) {
      clearTimeout(this.sendTimer)
      this.sendTimer = null
    }
    return hadUnsynced
  }

  private trySend() {
    if (!this.connected) return
    const head = this.unacked[0]
    if (!head || head.sent) return
    const wait = this.lastSendAt + this.minSendInterval - Date.now()
    if (wait > 0) {
      if (!this.sendTimer) {
        this.sendTimer = setTimeout(() => {
          this.sendTimer = null
          this.trySend()
        }, wait)
      }
      return
    }
    head.sent = true
    this.lastSendAt = Date.now()
    this.armAckTimer()
    this.cb.sendOp(head.op, head.opId, this.revision)
  }

  private armAckTimer() {
    this.clearAckTimer()
    this.ackTimer = setTimeout(() => {
      if (this.unacked[0]?.sent) {
        console.warn('[ot] ack 超时，请求重同步')
        this.cb.requestResync()
      }
    }, this.ackTimeoutMs)
  }

  private clearAckTimer() {
    if (this.ackTimer) {
      clearTimeout(this.ackTimer)
      this.ackTimer = null
    }
  }
}
