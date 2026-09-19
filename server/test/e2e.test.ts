import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { apply, transformPair, type Op } from '../../shared/ot'
import type { ServerMsg, WelcomeMsg } from '../../shared/protocol'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.PORT = '18099'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'collab-e2e-'))
const { server, shutdown } = await import('../src/index')

const BASE = 'ws://localhost:18099/ws'

/** 一个忠实的迷你客户端：实现与服务端对应的 OT 客户端算法 */
class TestClient {
  ws: WebSocket
  name: string
  role: string
  docId: string
  clientId = ''
  doc = ''
  revision = 0
  pending: { opId: string; op: Op } | null = null
  inbox: ServerMsg[] = []
  private waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = []
  private opCounter = 0

  constructor(name: string, role: string, docId: string) {
    this.name = name
    this.role = role
    this.docId = docId
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
      case 'welcome': {
        const w = msg as WelcomeMsg
        this.clientId = w.clientId
        if (w.snapshot) {
          this.doc = w.doc
          this.revision = w.revision
          this.pending = null
        } else {
          this.revision = w.revision
        }
        break
      }
      case 'ops': {
        for (const e of msg.ops) {
          if (this.pending && this.pending.opId === e.opId) {
            this.pending = null
            continue
          }
          if (this.pending) {
            const [rP, pP] = transformPair(e.op, this.pending.op)
            this.doc = apply(this.doc, rP)
            this.pending.op = pP
          } else {
            this.doc = apply(this.doc, e.op)
          }
        }
        this.revision = msg.revision
        break
      }
      case 'ack': {
        this.pending = null
        this.revision = msg.revision
        break
      }
      case 'op': {
        if (this.pending) {
          const [rP, pP] = transformPair(msg.op, this.pending.op)
          this.doc = apply(this.doc, rP)
          this.pending.op = pP
        } else {
          this.doc = apply(this.doc, msg.op)
        }
        this.revision = msg.revision + 1
        break
      }
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
    this.send({ type: 'join', docId: this.docId, name: this.name, role: this.role, lastRevision })
    await this.waitFor((m) => m.type === 'welcome')
  }

  send(obj: object) {
    this.ws.send(JSON.stringify(obj))
  }

  /** 本地编辑：乐观应用并发送 */
  edit(op: Op) {
    const opId = `${this.name}-${this.opCounter++}`
    this.doc = apply(this.doc, op)
    this.pending = { opId, op }
    this.send({ type: 'op', revision: this.revision, op, opId })
    return opId
  }

  waitFor(pred: (m: ServerMsg) => boolean, timeoutMs = 3000): Promise<ServerMsg> {
    const hit = this.inbox.find(pred)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor 超时')), timeoutMs)
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
  }

  close() {
    this.ws.close()
  }
}

let serverDoc = ''

before(async () => {
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', r)))
})

after(() => {
  shutdown()
})

test('e2e: 双客户端并发编辑收敛', async () => {
  const docId = 'e2e-concurrent'
  const a = new TestClient('A', 'editor', docId)
  const b = new TestClient('B', 'editor', docId)
  await a.join()
  await b.join()

  // 同一同步块内背靠背提交：两个操作真正并发（互不感知），服务端按到达顺序接受并变换
  a.edit([{ insert: 'hello' }])
  b.edit([{ insert: 'world' }])

  await a.waitFor((m) => m.type === 'ack')
  await b.waitFor((m) => m.type === 'ack')
  await a.waitFor((m) => m.type === 'op')
  await b.waitFor((m) => m.type === 'op')

  // 等双方消息都处理完：无论接受顺序如何，双方必须收敛到同一文档
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(a.doc, b.doc)
  assert.ok(a.doc.length === 10, `文档应包含两个插入: ${a.doc}`)
  assert.equal(a.revision, 2)
  assert.equal(b.revision, 2)

  // 新加入的客户端拿到一致的全量文档
  const c = new TestClient('C', 'viewer', docId)
  await c.join()
  assert.equal(c.doc, a.doc)
  serverDoc = a.doc
  a.close()
  b.close()
  c.close()
})

test('e2e: 权限控制 —— 只读不可编辑/批注，批注者可批注不可编辑', async () => {
  const docId = 'e2e-perm'
  const editor = new TestClient('E', 'editor', docId)
  const viewer = new TestClient('V', 'viewer', docId)
  const commenter = new TestClient('M', 'commenter', docId)
  await editor.join()
  await viewer.join()
  await commenter.join()

  editor.edit([{ insert: 'abcdef' }])
  await editor.waitFor((m) => m.type === 'ack')

  // viewer 编辑 → 拒绝
  viewer.send({ type: 'op', revision: 1, op: [{ retain: 6 }, { insert: 'x' }], opId: 'v1' })
  const errV = await viewer.waitFor((m) => m.type === 'error')
  assert.equal((errV as { code: string }).code, 'PERMISSION_DENIED')

  // commenter 编辑 → 拒绝
  commenter.send({ type: 'op', revision: 1, op: [{ retain: 6 }, { insert: 'x' }], opId: 'm1' })
  const errM = await commenter.waitFor((m) => m.type === 'error')
  assert.equal((errM as { code: string }).code, 'PERMISSION_DENIED')

  // commenter 批注 → 成功，三方都收到广播
  commenter.send({ type: 'ann:add', annId: 'ann-1', start: 1, end: 3, quote: 'bc', text: '这里建议修改' })
  const up = (await editor.waitFor((m) => m.type === 'ann:upsert')) as { ann: { id: string; start: number; end: number } }
  assert.equal(up.ann.id, 'ann-1')
  assert.equal(up.ann.start, 1)
  assert.equal(up.ann.end, 3)
  await viewer.waitFor((m) => m.type === 'ann:upsert')

  // viewer 批注 → 拒绝
  viewer.send({ type: 'ann:add', annId: 'ann-2', start: 0, end: 1, quote: 'a', text: 'x' })
  const errV2 = await viewer.waitFor((m) => m.type === 'error' && m.message.includes('批注'))
  assert.equal((errV2 as { code: string }).code, 'PERMISSION_DENIED')

  // 编辑导致批注锚点移动：在位置 0 插入 2 个字符 → [1,3) → [3,5)
  editor.edit([{ insert: '>>' }, { retain: 6 }])
  await editor.waitFor((m) => m.type === 'ack')
  const fresh = new TestClient('F', 'viewer', docId)
  await fresh.join()
  const welcome = fresh.inbox.find((m) => m.type === 'welcome') as WelcomeMsg
  const ann = welcome.annotations.find((x) => x.id === 'ann-1')!
  assert.equal(ann.start, 3)
  assert.equal(ann.end, 5)

  editor.close()
  viewer.close()
  commenter.close()
  fresh.close()
})

test('e2e: 断线重连 —— 增量补齐错过的操作', async () => {
  const docId = 'e2e-reconnect'
  const a = new TestClient('A', 'editor', docId)
  const b = new TestClient('B', 'editor', docId)
  await a.join()
  await b.join()

  a.edit([{ insert: 'v1 ' }])
  await a.waitFor((m) => m.type === 'ack')
  await b.waitFor((m) => m.type === 'op')

  // B 断线，期间 A 又产生两个操作
  const bRev = b.revision
  b.close()
  await new Promise((r) => setTimeout(r, 100))
  a.edit([{ retain: 3 }, { insert: 'v2 ' }])
  await a.waitFor((m) => m.type === 'ack' && (m as { revision: number }).revision === 2)
  a.edit([{ retain: 6 }, { insert: 'v3' }])
  await a.waitFor((m) => m.type === 'ack' && (m as { revision: number }).revision === 3)

  // B 重连并携带旧版本号 → 收到增量 ops
  const b2 = new TestClient('B', 'editor', docId)
  b2.doc = b.doc // 模拟本地保留的文档
  b2.revision = bRev
  await b2.join(bRev)
  const opsMsg = (await b2.waitFor((m) => m.type === 'ops')) as { ops: unknown[]; revision: number }
  assert.equal(opsMsg.ops.length, 2)
  assert.equal(opsMsg.revision, 3)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(b2.doc, 'v1 v2 v3')
  assert.equal(b2.revision, 3)

  a.close()
  b2.close()
})

test('e2e: 版本过旧 —— 回退全量快照', async () => {
  const docId = 'e2e-snapshot'
  const a = new TestClient('A', 'editor', docId)
  await a.join()
  a.edit([{ insert: 'snap' }])
  await a.waitFor((m) => m.type === 'ack')

  // lastRevision = -1 → 全量快照
  const b = new TestClient('B', 'editor', docId)
  await b.join(-1)
  const w = b.inbox.find((m) => m.type === 'welcome') as WelcomeMsg
  assert.equal(w.snapshot, true)
  assert.equal(w.doc, 'snap')
  a.close()
  b.close()
})

test('e2e: 重复 opId 幂等（ack 丢失重发不重复应用）', async () => {
  const docId = 'e2e-idempotent'
  const a = new TestClient('A', 'editor', docId)
  await a.join()
  a.send({ type: 'op', revision: 0, op: [{ insert: 'x' }], opId: 'dup-1' })
  await a.waitFor((m) => m.type === 'ack')
  // 模拟 ack 丢失后客户端重发同一操作
  a.send({ type: 'op', revision: 0, op: [{ insert: 'x' }], opId: 'dup-1' })
  await new Promise((r) => setTimeout(r, 300))
  const b = new TestClient('B', 'viewer', docId)
  await b.join()
  assert.equal(b.doc, 'x') // 只被应用了一次
  a.close()
  b.close()
})

test('e2e: 畸形消息不炸服务器', async () => {
  const ws = new WebSocket(BASE)
  await new Promise<void>((r) => ws.once('open', r))
  ws.send('not-json{{{')
  ws.send(JSON.stringify({ type: 'join', docId: 'e2e-robust', name: 'R', role: 'editor' }))
  const welcome = await new Promise<ServerMsg>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时')), 3000)
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.type === 'welcome') {
        clearTimeout(timer)
        resolve(m)
      }
    })
  })
  assert.equal(welcome.type, 'welcome')
  ws.close()
})
