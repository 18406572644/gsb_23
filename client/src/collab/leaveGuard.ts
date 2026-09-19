/**
 * 离开文档前的未同步修改确认（纯逻辑层，不依赖 DOM / 组件库）：
 *
 * - collectUnsynced 汇总三类「离开即丢失」的本地状态：
 *   1. OT 队列中待确认的编辑操作组（含离线缓冲，尚未被服务端 ack）；
 *   2. WS 发送队列中断线期间暂存的批注消息（ann:*）；
 *   3. 重同步进行中（welcome 已到、ops 未完成，或主动 resync 未完成）。
 * - buildLeavePrompt 生成弹窗文案；已全部同步时返回 null（直接退出，不打断用户）。
 * - discardLocalChanges 执行「放弃本地修改」：回滚未确认编辑并清空待发队列。
 *
 * 纯函数 + 结构化依赖，方便在 node 验收测试中直接用真实 OTClient / WSClient 驱动。
 */
import type { OTClient } from '../ot/otClient'
import type { WSClient } from '../ws/wsClient'

export interface UnsyncedSummary {
  /** OT 队列中待确认（含离线缓冲）的编辑操作组数 */
  pendingEditGroups: number
  /** WS 发送队列中待发送的批注消息条数（ann:*） */
  pendingAnnotations: number
  /** 是否正处于重同步中 */
  resyncing: boolean
}

export interface LeavePrompt {
  title: string
  /** 弹窗正文的条目（TopBar 负责渲染为列表） */
  reasons: string[]
  confirmText: string
  cancelText: string
  /** resync-only 时为 info，存在实际未同步内容时为 warning */
  severity: 'warning' | 'info'
}

export function summarizeUnsynced(input: {
  pendingEditGroups: number
  pendingAnnotations: number
  resyncing: boolean
}): UnsyncedSummary {
  return {
    pendingEditGroups: Math.max(0, Math.floor(input.pendingEditGroups)),
    pendingAnnotations: Math.max(0, Math.floor(input.pendingAnnotations)),
    resyncing: Boolean(input.resyncing),
  }
}

/** 从真实的 OTClient / WSClient 采集未同步状态 */
export function collectUnsynced(
  ot: Pick<OTClient, 'pendingCount'>,
  ws: Pick<WSClient, 'pendingAnnotationCount'>,
  resyncing: boolean,
): UnsyncedSummary {
  return summarizeUnsynced({
    pendingEditGroups: ot.pendingCount,
    pendingAnnotations: ws.pendingAnnotationCount,
    resyncing,
  })
}

export function hasUnsynced(s: UnsyncedSummary): boolean {
  return s.resyncing || s.pendingEditGroups > 0 || s.pendingAnnotations > 0
}

/** 已同步返回 null（可直接退出）；否则返回弹窗文案，逐条列出待同步内容与数量 */
export function buildLeavePrompt(s: UnsyncedSummary): LeavePrompt | null {
  if (!hasUnsynced(s)) return null

  const reasons: string[] = []
  if (s.pendingEditGroups > 0) {
    reasons.push(`有 ${s.pendingEditGroups} 组待确认的编辑操作尚未同步到服务器`)
  }
  if (s.pendingAnnotations > 0) {
    reasons.push(`有 ${s.pendingAnnotations} 条批注（含回复 / 解决 / 删除）尚未发送`)
  }
  if (s.resyncing) {
    reasons.push('文档正在重同步，此刻离开会中断同步过程')
  }

  const resyncOnly = s.resyncing && s.pendingEditGroups === 0 && s.pendingAnnotations === 0
  return {
    title: '离开文档？',
    reasons,
    confirmText: '放弃本地修改并离开',
    cancelText: '继续编辑',
    severity: resyncOnly ? 'info' : 'warning',
  }
}

/** 放弃本地修改：丢弃未确认编辑（版本回零，离开后以全新会话重新拉取）并清空待发队列 */
export function discardLocalChanges(
  ot: Pick<OTClient, 'rollback'>,
  ws: Pick<WSClient, 'clearOutbox'>,
) {
  ot.rollback(0)
  ws.clearOutbox()
}
