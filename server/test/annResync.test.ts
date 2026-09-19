import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import type { ServerMsg, Annotation } from '../../shared/protocol'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.PORT = '18095'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'collab-annresync-'))
const { server, shutdown } = await import('../src/index')

const BASE = 'ws://localhost:18095/ws'

/**
 * 批注感知的迷你客户端：维护 revision 与 annotations 镜像，
 * 可通过 ignoreAnn 开关丢弃批注广播（模拟客户端处于重同步窗口、拒绝处理批注消息）。
 */
class AnnClient {
  ws: WebSocket
  clientId = ''
  revision = 0
  annotations = new Map<string, Annotation>()
  inbox: ServerMsg[] = []
  ignoreAnn = false
  private waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = []

  constructor(
    readonly name: string,
    readonly docId: string,
  ) {
    this.ws = new WebSocket(BASE)
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMsg
      this.inbox.push(msg)
      this.handle(msg)
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(msg)) {
          w.resolve(msg)
          return false
        }
        return true
      })
    })
    this.ws.on('error', () => {})
  }

  private handle(msg: ServerMsg) {
    switch (msg.type) {
      case 'welcome':
        this.clientId = msg.clientId
        this.revision = msg.revision
        this.annotations = new Map(msg.annotations.map((a) => [a.id, a]))
        break
      case 'ops':
        // 与修复后的客户端一致：以服务端权威批注快照为准
        this.annotations = new Map(msg.annotations.map((a) => [a.id, a]))
        this.revision = msg.revision
        break
      case 'ack':
        this.revision = msg.revision
        break
      case 'op':
        this.revision = msg.revision + 1
        break
      case 'ann:upsert':
        // 重同步窗口内拒绝处理批注消息（复现缺陷客户端行为）
        if (this.ignoreAnn) break
        this.annotations.set(msg.ann.id, msg.ann)
        break
      case 'ann:delete':
        if (this.ignoreAnn) break
        this.annotations.delete(msg.annId)
        break
    }
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve()
      this.ws.once('open', () => resolve())
      this.ws.once('error', reject)
    })
  }

  async join(lastRevision?: number) {
    await this.open()
    this.send({
      type: 'join',
      docId: this.docId,
      name: this.name,
      role: 'editor',
      lastRevision,
    })
    await this.waitFor((m) => m.type === 'welcome')
  }

  send(obj: object) {
    this.ws.send(JSON.stringify(obj))
  }

  waitFor(pred: (m: ServerMsg) => boolean, timeoutMs = 3000): Promise<ServerMsg> {
    const hit = this.inbox.find(pred)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor 超时')), timeoutMs)
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m) } })
    })
  }

  close() {
    this.ws.close()
  }
}

before(async () => {
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', r)))
})

after(() => {
  shutdown()
})

test('批注: 主动重同步响应携带全量批注，新增/回复/解决/删除均被补齐', async () => {
  const docId = 'e2e-ann-resync'
  const a = new AnnClient('A', docId)
  const b = new AnnClient('B', docId)
  await a.join()
  await b.join()

  // B 先建一条批注，A 正常收到
  b.send({ type: 'ann:add', annId: 'ann-1', start: 0, end: 0, quote: '', text: '第一条' })
  await b.waitFor((m) => m.type === 'ann:upsert' && m.ann.id === 'ann-1')
  assert.ok(a.annotations.has('ann-1'))

  // A 进入「重同步窗口」：此后拒绝处理一切批注广播
  a.ignoreAnn = true

  // 重同步期间产生：新增、回复、解决、再新增、删除
  b.send({ type: 'ann:reply', annId: 'ann-1', replyId: 'r-1', text: '一条回复' })
  await b.waitFor(
    (m) => m.type === 'ann:upsert' && m.ann.id === 'ann-1' && m.ann.replies.length === 1,
  )

  b.send({ type: 'ann:add', annId: 'ann-2', start: 0, end: 0, quote: '', text: '待删除' })
  await b.waitFor((m) => m.type === 'ann:upsert' && m.ann.id === 'ann-2')

  b.send({ type: 'ann:add', annId: 'ann-3', start: 0, end: 0, quote: '', text: '保留项' })
  await b.waitFor((m) => m.type === 'ann:upsert' && m.ann.id === 'ann-3')

  b.send({ type: 'ann:resolve', annId: 'ann-1', resolved: true })
  await b.waitFor(
    (m) => m.type === 'ann:upsert' && m.ann.id === 'ann-1' && m.ann.resolved === true,
  )

  b.send({ type: 'ann:delete', annId: 'ann-2' })
  await b.waitFor((m) => m.type === 'ann:delete' && m.annId === 'ann-2')

  // A 的镜像因丢弃广播而滞后：仍是重同步前的旧状态
  assert.ok(a.annotations.has('ann-1'))
  assert.equal(a.annotations.get('ann-1')!.resolved, false)
  assert.ok(!a.annotations.has('ann-3'))

  // A 主动请求重同步（批注不改变 revision，backlog 为 0 → 走增量 ops 而非全量快照）
  a.send({ type: 'resync', lastRevision: a.revision })
  const opsMsg = (await a.waitFor((m) => m.type === 'ops')) as {
    type: 'ops'
    ops: unknown[]
    annotations: Annotation[]
  }

  // 必须是增量路径（正文无 backlog），且携带全量批注
  assert.equal(opsMsg.ops.length, 0, '无正文操作，应为增量空 ops 而非快照')
  assert.ok(Array.isArray(opsMsg.annotations), 'ops 必须携带批注快照')

  // 客户端按约定采用快照后，重同步窗口内的全部批注变更一次性补齐
  const ann1 = a.annotations.get('ann-1')!
  assert.ok(ann1, 'ann-1 仍存在')
  assert.equal(ann1.resolved, true, '解决状态被补齐')
  assert.equal(ann1.replies.length, 1, '回复被补齐')
  assert.ok(a.annotations.has('ann-3'), '新增批注 ann-3 被补齐')
  assert.ok(!a.annotations.has('ann-2'), '已删除批注 ann-2 不应出现')

  a.close()
  b.close()
})

test('批注: 断线增量重连的 ops 携带权威批注快照，锚点已含 backlog 操作的位移', async () => {
  const docId = 'e2e-ann-rejoin'
  const a = new AnnClient('A', docId)
  const b = new AnnClient('B', docId)
  await a.join()
  await b.join()

  // rev1：文档变为 "abc"（B 也收到广播，revision 推进到 1）
  a.send({ type: 'op', revision: 0, op: [{ insert: 'abc' }], opId: 'op-1' })
  await b.waitFor((m) => m.type === 'op' && m.opId === 'op-1')

  // B 在 "abc" 上对 [1,2)（字符 b）建批注
  b.send({ type: 'ann:add', annId: 'ann-x', start: 1, end: 2, quote: 'b', text: '重连测试' })
  await a.waitFor((m) => m.type === 'ann:upsert' && m.ann.id === 'ann-x')

  // B 断线后，A 在位置 0 插入 ">>"：服务端把批注锚点 [1,2) 移动到 [3,4)
  b.close()
  a.send({ type: 'op', revision: 1, op: [{ insert: '>>' }, { retain: 3 }], opId: 'op-2' })
  await a.waitFor((m) => m.type === 'ack' && m.revision === 2)

  // B 以 rev1 重连 → 增量 ops（backlog = op-2）
  const b2 = new AnnClient('B', docId)
  b2.revision = 1
  await b2.join(1)
  const opsMsg = (await b2.waitFor((m) => m.type === 'ops')) as {
    type: 'ops'
    annotations: Annotation[]
  }

  const ann = opsMsg.annotations.find((x) => x.id === 'ann-x')
  assert.ok(ann, '重连 ops 必须包含已有批注')
  // 关键契约：快照锚点已经是 backlog（插入 ">>"）应用之后的位置。
  // 客户端重放 op-2 更新正文时不得再次变换锚点，否则会错误地继续后移到 [5,6)。
  assert.equal(ann.start, 3)
  assert.equal(ann.end, 4)

  a.close()
  b2.close()
})
