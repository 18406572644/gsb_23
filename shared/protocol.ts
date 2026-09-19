/**
 * 客户端 / 服务端 WebSocket 协议定义。
 * 所有消息均为 JSON 文本帧，含 type 字段。
 */
import type { Op } from './ot'

/** 角色：viewer 只读 / commenter 可批注 / editor 可编辑+批注 */
export type Role = 'viewer' | 'commenter' | 'editor'

export const ROLE_LABEL: Record<Role, string> = {
  viewer: '只读',
  commenter: '批注',
  editor: '编辑',
}

export function canEdit(role: Role): boolean {
  return role === 'editor'
}

export function canAnnotate(role: Role): boolean {
  return role === 'editor' || role === 'commenter'
}

export interface UserInfo {
  clientId: string
  name: string
  role: Role
  color: string
}

export interface Reply {
  id: string
  authorId: string
  authorName: string
  text: string
  createdAt: number
}

/** 批注锚定到文档的 [start, end) 区间，随编辑操作做位置映射 */
export interface Annotation {
  id: string
  start: number
  end: number
  /** 锚点文本被完全删除后为 true（孤儿批注，折叠到 start 处展示） */
  orphan: boolean
  quote: string
  authorId: string
  authorName: string
  text: string
  replies: Reply[]
  resolved: boolean
  createdAt: number
}

export interface LogEntry {
  revision: number
  op: Op
  opId: string
  clientId: string
  authorName: string
  /** 应用该操作前的文档长度（用于校验客户端操作的基准版本） */
  lenBefore: number
}

/* ---------------- 客户端 → 服务端 ---------------- */

export interface JoinMsg {
  type: 'join'
  docId: string
  name: string
  role: Role
  /** 断线重连时携带本地已同步到的版本号，用于增量补齐 */
  lastRevision?: number
}

export interface OpMsg {
  type: 'op'
  revision: number
  op: Op
  opId: string
}

export interface CursorMsg {
  type: 'cursor'
  start: number
  end: number
}

export interface AnnAddMsg {
  type: 'ann:add'
  annId: string
  start: number
  end: number
  quote: string
  text: string
}

export interface AnnReplyMsg {
  type: 'ann:reply'
  annId: string
  replyId: string
  text: string
}

export interface AnnResolveMsg {
  type: 'ann:resolve'
  annId: string
  resolved: boolean
}

export interface AnnDeleteMsg {
  type: 'ann:delete'
  annId: string
}

/** 主动请求重同步（检测到消息空洞 / ack 超时 / 收到 RESYNC 错误时） */
export interface ResyncMsg {
  type: 'resync'
  lastRevision: number
}

export interface PingMsg {
  type: 'ping'
  t: number
}

export type ClientMsg =
  | JoinMsg
  | OpMsg
  | CursorMsg
  | AnnAddMsg
  | AnnReplyMsg
  | AnnResolveMsg
  | AnnDeleteMsg
  | ResyncMsg
  | PingMsg

/* ---------------- 服务端 → 客户端 ---------------- */

export interface WelcomeMsg {
  type: 'welcome'
  clientId: string
  docId: string
  revision: number
  doc: string
  annotations: Annotation[]
  users: UserInfo[]
  role: Role
  /** 重连时若 true 表示服务端日志已不足以增量补齐，本消息为全量快照 */
  snapshot: boolean
  /** 当前文档广播序号，客户端据此检测后续消息空洞 */
  seq: number
}

/** 增量补齐：重连后补发错过的操作 */
export interface OpsMsg {
  type: 'ops'
  ops: { revision: number; op: Op; opId: string; clientId: string; authorName: string }[]
  revision: number
  seq: number
}

export interface AckMsg {
  type: 'ack'
  opId: string
  revision: number
  /** 与他人收到的 op 广播使用同一序号，保证所有客户端的 seq 流一致 */
  seq: number
}

/** 他人操作广播（不发给操作发起者，发起者收 ack） */
export interface RemoteOpMsg {
  type: 'op'
  revision: number
  op: Op
  opId: string
  clientId: string
  authorName: string
  seq: number
}

export interface PresenceMsg {
  type: 'presence'
  users: UserInfo[]
}

export interface RemoteCursorMsg {
  type: 'cursor'
  clientId: string
  start: number
  end: number
}

export interface AnnUpsertMsg {
  type: 'ann:upsert'
  ann: Annotation
  seq: number
}

export interface AnnDeletedMsg {
  type: 'ann:delete'
  annId: string
  seq: number
}

export type ServerErrorCode =
  | 'PERMISSION_DENIED'
  | 'BAD_REVISION'
  | 'RESYNC_REQUIRED'
  | 'BAD_MESSAGE'
  | 'INTERNAL'

export interface ErrorMsg {
  type: 'error'
  code: ServerErrorCode
  message: string
  opId?: string
}

export interface PongMsg {
  type: 'pong'
  t: number
}

export type ServerMsg =
  | WelcomeMsg
  | OpsMsg
  | AckMsg
  | RemoteOpMsg
  | PresenceMsg
  | RemoteCursorMsg
  | AnnUpsertMsg
  | AnnDeletedMsg
  | ErrorMsg
  | PongMsg
