import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  baseLength,
  compose,
  diffToOp,
  invert,
  mapPosition,
  normalize,
  targetLength,
  transform,
  transformPair,
  type Op,
} from '../../shared/ot'

/* ---------- 基础 apply ---------- */

test('apply: insert / delete / retain', () => {
  assert.equal(apply('hello', [{ retain: 5 }, { insert: ' world' }]), 'hello world')
  assert.equal(apply('hello', [{ insert: 'say ' }, { retain: 5 }]), 'say hello')
  assert.equal(apply('hello world', [{ retain: 6 }, { delete: 5 }]), 'hello ')
  assert.equal(apply('abc', [{ delete: 3 }]), '')
})

test('apply: 操作未消费完整文档时抛错', () => {
  assert.throws(() => apply('hello', [{ retain: 2 }]))
  assert.throws(() => apply('hi', [{ retain: 5 }]))
})

test('normalize 合并相邻同类组件', () => {
  assert.deepEqual(
    normalize([{ retain: 1 }, { retain: 2 }, { insert: 'a' }, { insert: 'b' }, { delete: 1 }, { delete: 2 }]),
    [{ retain: 3 }, { insert: 'ab' }, { delete: 3 }],
  )
})

/* ---------- transform 经典场景 ---------- */

test('transform: 同位置并发插入，先被接受者在前', () => {
  // S = "xy"，A 在 1 处插入 "A"（已被接受），B 在 1 处插入 "B"
  const a: Op = [{ retain: 1 }, { insert: 'A' }, { retain: 1 }]
  const b: Op = [{ retain: 1 }, { insert: 'B' }, { retain: 1 }]
  const [aP, bP] = transformPair(a, b)
  const left = apply(apply('xy', a), bP)
  const right = apply(apply('xy', b), aP)
  assert.equal(left, right)
  assert.equal(left, 'xABy') // a 优先
})

test('transform: 插入 vs 删除不同区域', () => {
  const a: Op = [{ insert: '>>' }, { retain: 4 }] // 头部插入
  const b: Op = [{ retain: 2 }, { delete: 2 }] // 删除尾部
  const [aP, bP] = transformPair(a, b)
  const s = 'abcd'
  assert.equal(apply(apply(s, a), bP), apply(apply(s, b), aP))
  assert.equal(apply(apply(s, a), bP), '>>ab')
})

test('transform: 双方删除重叠区域', () => {
  const a: Op = [{ delete: 3 }, { retain: 2 }] // 删 [0,3)
  const b: Op = [{ retain: 1 }, { delete: 3 }, { retain: 1 }] // 删 [1,4)
  const [aP, bP] = transformPair(a, b)
  const s = 'abcde'
  assert.equal(apply(apply(s, a), bP), apply(apply(s, b), aP))
  assert.equal(apply(apply(s, a), bP), 'e')
})

/* ---------- compose / invert ---------- */

test('compose 等价于顺序应用', () => {
  const s = 'hello world'
  const a: Op = [{ retain: 6 }, { delete: 5 }, { insert: 'OT' }]
  const b: Op = [{ insert: '[' }, { retain: 8 }, { insert: ']' }]
  assert.equal(apply(apply(s, a), b), apply(s, compose(a, b)))
})

test('invert 恢复原文档', () => {
  const s = 'hello world'
  const op: Op = [{ retain: 6 }, { delete: 5 }, { insert: 'OT' }]
  assert.equal(apply(apply(s, op), invert(op, s)), s)
})

/* ---------- diffToOp / mapPosition ---------- */

test('diffToOp 生成的操作可还原新文档', () => {
  const cases: [string, string][] = [
    ['hello', 'hello world'],
    ['hello world', 'hello'],
    ['abc', 'xbc'],
    ['abc', 'abc'],
    ['', 'new'],
    ['old', ''],
    ['中文内容测试', '中文内容已测试'],
  ]
  for (const [a, b] of cases) {
    assert.equal(apply(a, diffToOp(a, b)), b, `${a} -> ${b}`)
    assert.equal(baseLength(diffToOp(a, b)), a.length)
  }
})

test('mapPosition: 插入与删除的映射', () => {
  const ins: Op = [{ retain: 2 }, { insert: 'XX' }, { retain: 3 }] // 在 2 处插入
  assert.equal(mapPosition(0, ins), 0)
  assert.equal(mapPosition(2, ins, 'before'), 2)
  assert.equal(mapPosition(2, ins, 'after'), 4)
  assert.equal(mapPosition(5, ins), 7)

  const del: Op = [{ retain: 1 }, { delete: 3 }, { retain: 1 }] // 删 [1,4)
  assert.equal(mapPosition(0, del), 0)
  assert.equal(mapPosition(2, del), 1) // 落在删除区间 → 收缩
  assert.equal(mapPosition(4, del), 1)
})

/* ---------- 随机 fuzz：OT 收敛性质 ---------- */

/** 可复现的随机数（mulberry32） */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHA = 'abc中文 \n'

function randomDoc(rand: () => number, maxLen = 30): string {
  const n = Math.floor(rand() * maxLen)
  let s = ''
  for (let i = 0; i < n; i++) s += ALPHA[Math.floor(rand() * ALPHA.length)]
  return s
}

/** 生成一个对 doc 合法的随机操作（若干随机单点编辑的组合） */
function randomOp(rand: () => number, doc: string): Op {
  const op: Op = []
  let pos = 0
  let remaining = doc.length
  while (remaining > 0) {
    const r = rand()
    const step = 1 + Math.floor(rand() * remaining)
    if (r < 0.45) {
      // retain
      op.push({ retain: step })
      pos += step
      remaining -= step
    } else if (r < 0.7) {
      // insert
      const text = randomDoc(rand, 5)
      if (text) op.push({ insert: text })
    } else {
      // delete
      op.push({ delete: step })
      pos += step
      remaining -= step
    }
  }
  if (rand() < 0.5) {
    const text = randomDoc(rand, 5)
    if (text) op.push({ insert: text })
  }
  return normalize(op)
}

test('fuzz: transform 收敛性 apply(apply(S,a),b\') === apply(apply(S,b),a\')', () => {
  const rand = rng(42)
  for (let i = 0; i < 2000; i++) {
    const s = randomDoc(rand)
    const a = randomOp(rand, s)
    const b = randomOp(rand, s)
    assert.equal(baseLength(a), s.length)
    assert.equal(baseLength(b), s.length)
    const [aP, bP] = transformPair(a, b)
    const left = apply(apply(s, a), bP)
    const right = apply(apply(s, b), aP)
    assert.equal(left, right, `第 ${i} 轮发散\nS=${JSON.stringify(s)}\na=${JSON.stringify(a)}\nb=${JSON.stringify(b)}`)
  }
})

test('fuzz: compose 结合律 apply(apply(S,a),b) === apply(S, compose(a,b))', () => {
  const rand = rng(7)
  for (let i = 0; i < 2000; i++) {
    const s = randomDoc(rand)
    const a = randomOp(rand, s)
    const s2 = apply(s, a)
    const b = randomOp(rand, s2)
    assert.equal(apply(s, compose(a, b)), apply(s2, b), `第 ${i} 轮`)
    assert.equal(targetLength(compose(a, b)), apply(s2, b).length)
  }
})

test('fuzz: invert 往返恢复', () => {
  const rand = rng(99)
  for (let i = 0; i < 1000; i++) {
    const s = randomDoc(rand)
    const op = randomOp(rand, s)
    assert.equal(apply(apply(s, op), invert(op, s)), s, `第 ${i} 轮`)
  }
})

test('fuzz: 三方并发收敛（服务端顺序接受 + 客户端各自变换）', () => {
  const rand = rng(2026)
  for (let i = 0; i < 500; i++) {
    const s = randomDoc(rand)
    // 三个客户端基于同一版本各产生一个操作
    const ops = [randomOp(rand, s), randomOp(rand, s), randomOp(rand, s)]
    // 服务端按顺序接受并变换
    const accepted: Op[] = []
    let serverDoc = s
    for (const op of ops) {
      let t = op
      for (const acc of accepted) t = transform(t, acc)
      accepted.push(t)
      serverDoc = apply(serverDoc, t)
    }
    // 每个客户端：本地先应用自己的操作，再按序应用（经本地变换的）他人已接受操作
    for (let me = 0; me < 3; me++) {
      let doc = apply(s, ops[me])
      let pending: Op | null = ops[me]
      for (let j = 0; j < accepted.length; j++) {
        if (j === me) {
          // 自己的操作被 ack：服务器应用的版本与本地 pending 经相同变换后一致，无需再应用
          pending = null
          continue
        }
        const remote = accepted[j]
        if (pending) {
          // 远程操作到达时本地仍有未确认操作：双方互变换，应用远程、更新 pending
          const [remoteP, pendingP] = transformPair(remote, pending)
          doc = apply(doc, remoteP)
          pending = pendingP
        } else {
          doc = apply(doc, remote)
        }
      }
      assert.equal(doc, serverDoc, `第 ${i} 轮客户端 ${me} 发散`)
    }
  }
})
