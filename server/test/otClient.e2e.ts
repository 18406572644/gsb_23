/**
 * 集成测试：真实服务端 + 真实客户端 OTClient（client/src/ot/otClient.ts），
 * 验证并发收敛与「离线编辑 → 重连 → 增量重同步 → 补发」完整链路。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { apply, diffToOp } from '../../shared/ot'
import type { ServerMsg } from '../../shared/protocol'
import { OTClient } from '../../client/src/ot/otClient'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.PORT = '18097'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'collab-itest-'))
const { server, shutdown } = await import('../src/index')

const BASE = 'ws://localhost:18097/ws'

async function waitFor(cond: () => boolean, timeout = 5000, step = 25): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, step))
  }
}

/** 无头客户端：与 collab.ts 相同的接线方式（OTClient + 消息分发） */
class HeadlessClient {
  doc = ''
  ws: WebSocket | null = null
  ot: OTClient
  resyncCount = 0

  constructor(
    readonly name: string,
    readonly docId: string,
  ) {
    this.ot = new OTClient({
      sendOp: (op, opId, revision) => this.send({ type: 'op', op, opId, revision }),
      applyRemote: (op) => {
        this.doc = apply(this.doc, op)
      },
      requestResync: () => {
        this.resyncCount++
        this.send({ type: 'resync', lastRevision: this.ot.revision })
      },
    })
    this.ot.minSendInterval = 0
    this.ot.ackTimeoutMs = 2000
  }

  get revision() {
    return this.ot.revision
  }

  async join(lastRevision?: number) {
    this.ws = new WebSocket(BASE)
    this.ws.on('message', (raw) => this.handle(JSON.parse(raw.toString()) as ServerMsg))
    this.ws.on('error', () => {})
    await new Promise<void>((resolve, reject) => {
      this.ws!.once('open', resolve)
      this.ws!.once('error', reject)
    })
    this.send({ type: 'join', docId: this.docId, name: this.name, role: 'editor', lastRevision })
    await waitFor(() => this.ready, 3000)
  }

  private ready = false

  private handle(msg: ServerMsg) {
    switch (msg.type) {
      case 'welcome':
        if (msg.snapshot) {
          this.ot.rollback(msg.revision)
          this.doc = msg.doc
          this.ot.setConnected(true)
          this.ready = true
        }
        // 增量路径：等 ops 到达后再置 connected（与 collab.ts 一致）
        break
      case 'ops':
        this.ot.resyncOps(msg.ops, msg.revision)
        this.ot.setConnected(true)
        this.ready = true
        break
      case 'op':
        this.ot.remoteChange(msg.op)
        break
      case 'ack':
        this.ot.ack(msg.opId, msg.revision)
        break
    }
  }

  /** 在 pos 处插入文本（默认末尾），走与编辑器相同的 diff 路径 */
  type(text: string, pos?: number) {
    const p = pos ?? this.doc.length
    const newDoc = this.doc.slice(0, p) + text + this.doc.slice(p)
    const op = diffToOp(this.doc, newDoc)
    this.doc = newDoc
    this.ot.localChange(op)
  }

  send(obj: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj))
  }

  close() {
    this.ws?.close()
    this.ot.setConnected(false)
    this.ready = false
  }
}

before(async () => {
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', r)))
})

after(() => {
  shutdown()
})

test('集成: 真实 OTClient 双方并发输入收敛', async () => {
  const docId = 'itest-concurrent'
  const a = new HeadlessClient('A', docId)
  const b = new HeadlessClient('B', docId)
  await a.join()
  await b.join()

  // 同步块内背靠背输入：真正并发
  a.type('aaa', 0)
  b.type('bbb', 0)

  await waitFor(() => a.ot.pendingCount === 0 && b.ot.pendingCount === 0 && a.revision === 2 && b.revision === 2)
  assert.equal(a.doc, b.doc)
  assert.ok(a.doc === 'aaabbb' || a.doc === 'bbbaaa')

  // 继续交替输入（含缓冲合并路径）
  a.type('111')
  b.type('222')
  a.type('333')
  await waitFor(() => a.ot.pendingCount === 0 && b.ot.pendingCount === 0 && a.revision === 5 && b.revision === 5)
  assert.equal(a.doc, b.doc)

  // 第三方全量加入，文档一致
  const c = new HeadlessClient('C', docId)
  await c.join()
  assert.equal(c.doc, a.doc)

  a.close()
  b.close()
  c.close()
})

test('集成: 离线编辑 → 重连增量重同步 → 自动补发收敛', async () => {
  const docId = 'itest-reconnect'
  const a = new HeadlessClient('A', docId)
  const b = new HeadlessClient('B', docId)
  await a.join()
  await b.join()

  a.type('hello ')
  await waitFor(() => a.ot.pendingCount === 0 && b.revision === 1)
  assert.equal(b.doc, 'hello ')

  // A 断线，离线期间本地继续编辑；B 同时在线编辑
  const savedRevision = a.revision
  a.close()
  a.type('[离线]')
  b.type('B在线>', 0)
  await waitFor(() => b.ot.pendingCount === 0)

  // A 重连：携带旧版本号，服务端增量补发 B 的操作，A 的离线操作重放后补发
  await a.join(savedRevision)
  await waitFor(() => a.ot.pendingCount === 0 && b.ot.pendingCount === 0)
  await waitFor(() => a.revision === b.revision)

  assert.equal(a.doc, b.doc)
  assert.ok(a.doc.includes('[离线]'), '离线编辑应保留并同步')
  assert.ok(a.doc.includes('B在线>'), '对方的在线编辑应补齐')
  assert.ok(a.doc.includes('hello '))

  a.close()
  b.close()
})

test('集成: ack 超时触发主动重同步', async () => {
  const docId = 'itest-ack-timeout'
  const a = new HeadlessClient('A', docId)
  await a.join()
  // 连接静默丢失（不通知 OT 层，模拟上行丢包）：操作被标记已发送但实际未送达
  a.ws!.close()
  a.type('x')
  // ack 永远不来 → ack 超时 → 主动 requestResync
  await waitFor(() => a.resyncCount > 0, 4000)
  a.close()
})
