import {
  apply,
  baseLength,
  isNoop,
  mapPosition,
  transform,
  type Op,
} from '../../shared/ot'
import type { Annotation, LogEntry, Role, UserInfo } from '../../shared/protocol'
import { canAnnotate, canEdit } from '../../shared/protocol'

/** 服务端操作日志保留长度：超出后落后太多的客户端只能走全量快照回滚 */
export const LOG_LIMIT = 1000

const COLORS = [
  '#f56c6c',
  '#e6a23c',
  '#67c23a',
  '#409eff',
  '#9b59b6',
  '#16a085',
  '#d35400',
  '#2c3e50',
]

export interface ClientState {
  clientId: string
  name: string
  role: Role
  color: string
  cursor: { start: number; end: number } | null
  send: (msg: object) => void
}

export class DocSession {
  readonly docId: string
  doc: string
  revision = 0
  /** 广播序号：客户端用它检测消息丢失（cursor/presence 等易失消息不计入） */
  seq = 0
  log: LogEntry[] = []
  annotations = new Map<string, Annotation>()
  clients = new Map<string, ClientState>()
  /** 已接受的 opId 集合（幂等去重：ack 丢失导致客户端重发时不重复应用） */
  private acceptedOpIds = new Set<string>()
  private acceptedOpIdQueue: string[] = []
  private colorIdx = 0
  /** 数据变更回调（用于持久化防抖） */
  onDirty: (() => void) | null = null

  constructor(docId: string, initialDoc = '') {
    this.docId = docId
    this.doc = initialDoc
  }

  private dirty() {
    this.onDirty?.()
  }

  addClient(clientId: string, name: string, role: Role, send: (msg: object) => void): ClientState {
    const state: ClientState = {
      clientId,
      name: name.slice(0, 24) || '匿名',
      role,
      color: COLORS[this.colorIdx++ % COLORS.length],
      cursor: null,
      send,
    }
    this.clients.set(clientId, state)
    return state
  }

  removeClient(clientId: string) {
    this.clients.delete(clientId)
  }

  users(): UserInfo[] {
    return [...this.clients.values()].map((c) => ({
      clientId: c.clientId,
      name: c.name,
      role: c.role,
      color: c.color,
    }))
  }

  /** 向除 exclude 外的所有客户端广播 */
  broadcast(msg: object, exclude?: string) {
    for (const c of this.clients.values()) {
      if (c.clientId === exclude) continue
      c.send(msg)
    }
  }

  broadcastAll(msg: object) {
    this.broadcast(msg)
  }

  /**
   * 处理客户端提交的编辑操作。
   * 返回 null 表示成功；否则返回错误码与信息。
   */
  receiveOp(
    client: ClientState,
    revision: number,
    op: Op,
    opId: string,
  ): { code: 'PERMISSION_DENIED' | 'BAD_REVISION' | 'RESYNC_REQUIRED'; message: string } | null {
    if (!canEdit(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '当前角色无编辑权限' }
    }
    // 幂等：该操作已被接受过（ack 丢失后客户端重发）→ 直接重新确认，不重复应用
    if (this.acceptedOpIds.has(opId)) {
      client.send({ type: 'ack', opId, revision: this.revision, seq: this.seq })
      return null
    }
    if (typeof revision !== 'number' || revision > this.revision || revision < 0) {
      return { code: 'RESYNC_REQUIRED', message: '版本号异常，请重新同步' }
    }
    const backlog = this.revision - revision
    if (backlog > this.log.length) {
      // 客户端落后太多，日志已不足以做变换，只能全量重同步
      return { code: 'RESYNC_REQUIRED', message: '本地版本过旧，需要全量重同步' }
    }
    // 校验操作基准长度与该版本文档长度一致
    const lenAt = backlog === 0 ? this.doc.length : this.log[this.log.length - backlog].lenBefore
    if (baseLength(op) !== lenAt) {
      return { code: 'BAD_REVISION', message: '操作与基准版本不匹配' }
    }

    // 针对客户端落后期间已被接受的并发操作逐个做 OT 变换
    let transformed = op
    for (let i = this.log.length - backlog; i < this.log.length; i++) {
      transformed = transform(transformed, this.log[i].op)
    }

    const entry: LogEntry = {
      revision: this.revision,
      op: transformed,
      opId,
      clientId: client.clientId,
      authorName: client.name,
      lenBefore: this.doc.length,
    }
    if (!isNoop(transformed)) {
      this.doc = apply(this.doc, transformed)
      this.transformAnnotations(transformed)
    }
    this.log.push(entry)
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT)
    this.acceptedOpIds.add(opId)
    this.acceptedOpIdQueue.push(opId)
    if (this.acceptedOpIdQueue.length > LOG_LIMIT * 2) {
      this.acceptedOpIds.delete(this.acceptedOpIdQueue.shift()!)
    }
    this.revision++
    this.seq++

    // 先确认发起者，再广播给其他人（ack 与广播共用同一 seq，保证序号流一致）
    client.send({ type: 'ack', opId, revision: this.revision, seq: this.seq })
    this.broadcast(
      {
        type: 'op',
        revision: entry.revision,
        op: transformed,
        opId,
        clientId: client.clientId,
        authorName: client.name,
        seq: this.seq,
      },
      client.clientId,
    )
    this.dirty()
    return null
  }

  /** 编辑操作后，批注锚点随文档做位置映射 */
  private transformAnnotations(op: Op) {
    for (const ann of this.annotations.values()) {
      ann.start = mapPosition(ann.start, op, 'after')
      ann.end = mapPosition(ann.end, op, 'before')
      if (ann.end < ann.start) ann.end = ann.start
      ann.orphan = ann.start === ann.end
    }
  }

  addAnnotation(
    client: ClientState,
    msg: { annId: string; start: number; end: number; quote: string; text: string },
  ): { code: 'PERMISSION_DENIED' | 'BAD_MESSAGE'; message: string } | null {
    if (!canAnnotate(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '当前角色无批注权限' }
    }
    const start = Math.max(0, Math.min(msg.start, this.doc.length))
    const end = Math.max(start, Math.min(msg.end, this.doc.length))
    if (!msg.text || !msg.text.trim()) {
      return { code: 'BAD_MESSAGE', message: '批注内容不能为空' }
    }
    const ann: Annotation = {
      id: msg.annId,
      start,
      end,
      orphan: start === end,
      quote: (msg.quote || this.doc.slice(start, end)).slice(0, 200),
      authorId: client.clientId,
      authorName: client.name,
      text: msg.text.trim().slice(0, 2000),
      replies: [],
      resolved: false,
      createdAt: Date.now(),
    }
    this.annotations.set(ann.id, ann)
    this.seq++
    this.broadcastAll({ type: 'ann:upsert', ann, seq: this.seq })
    this.dirty()
    return null
  }

  replyAnnotation(
    client: ClientState,
    msg: { annId: string; replyId: string; text: string },
  ): { code: 'PERMISSION_DENIED' | 'BAD_MESSAGE'; message: string } | null {
    if (!canAnnotate(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '当前角色无批注权限' }
    }
    const ann = this.annotations.get(msg.annId)
    if (!ann || !msg.text?.trim()) {
      return { code: 'BAD_MESSAGE', message: '批注不存在或内容为空' }
    }
    ann.replies.push({
      id: msg.replyId,
      authorId: client.clientId,
      authorName: client.name,
      text: msg.text.trim().slice(0, 2000),
      createdAt: Date.now(),
    })
    this.seq++
    this.broadcastAll({ type: 'ann:upsert', ann, seq: this.seq })
    this.dirty()
    return null
  }

  resolveAnnotation(
    client: ClientState,
    msg: { annId: string; resolved: boolean },
  ): { code: 'PERMISSION_DENIED' | 'BAD_MESSAGE'; message: string } | null {
    if (!canAnnotate(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '当前角色无批注权限' }
    }
    const ann = this.annotations.get(msg.annId)
    if (!ann) return { code: 'BAD_MESSAGE', message: '批注不存在' }
    ann.resolved = !!msg.resolved
    this.seq++
    this.broadcastAll({ type: 'ann:upsert', ann, seq: this.seq })
    this.dirty()
    return null
  }

  deleteAnnotation(
    client: ClientState,
    annId: string,
  ): { code: 'PERMISSION_DENIED' | 'BAD_MESSAGE'; message: string } | null {
    const ann = this.annotations.get(annId)
    if (!ann) return { code: 'BAD_MESSAGE', message: '批注不存在' }
    // 仅作者本人或编辑者可删除
    if (ann.authorId !== client.clientId && !canEdit(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '仅作者或编辑者可删除批注' }
    }
    this.annotations.delete(annId)
    this.seq++
    this.broadcastAll({ type: 'ann:delete', annId, seq: this.seq })
    this.dirty()
    return null
  }

  updateCursor(client: ClientState, start: number, end: number) {
    client.cursor = { start, end }
    // 光标消息易失：不计 seq、不持久化，直接转发
    this.broadcast({ type: 'cursor', clientId: client.clientId, start, end }, client.clientId)
  }

  /**
   * 断线重连：优先按版本号增量补齐错过的操作；日志不足时回退全量快照。
   */
  buildResync(lastRevision: number):
    | { kind: 'ops'; ops: LogEntry[] }
    | { kind: 'snapshot' } {
    const backlog = this.revision - lastRevision
    if (backlog >= 0 && backlog <= this.log.length) {
      return { kind: 'ops', ops: this.log.slice(this.log.length - backlog) }
    }
    return { kind: 'snapshot' }
  }

  /** 序列化快照（持久化用） */
  serialize() {
    return {
      docId: this.docId,
      doc: this.doc,
      revision: this.revision,
      annotations: [...this.annotations.values()],
    }
  }

  static deserialize(data: {
    docId: string
    doc: string
    revision: number
    annotations: Annotation[]
  }): DocSession {
    const s = new DocSession(data.docId, data.doc)
    s.revision = data.revision || 0
    for (const a of data.annotations || []) s.annotations.set(a.id, a)
    return s
  }
}
