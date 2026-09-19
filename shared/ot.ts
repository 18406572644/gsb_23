/**
 * 简易文本 OT（Operational Transformation）核心。
 *
 * 文档模型：纯字符串。
 * 操作（Op）：有序组件数组，按顺序消费文档字符：
 *   - { retain: n }   跳过 n 个字符（保持不变）
 *   - { insert: s }   在当前位置插入字符串 s（不消耗原文档字符）
 *   - { delete: n }   删除 n 个字符
 *
 * 不变式：op 中所有 retain/delete 消耗的字符总数 === 应用前 doc.length。
 *
 * 本文件同时被服务端与客户端使用，禁止引入任何环境相关 API。
 */

export type OpComponent = { retain: number } | { insert: string } | { delete: number }
export type Op = OpComponent[]

export const isRetain = (c: OpComponent): c is { retain: number } => 'retain' in c
export const isInsert = (c: OpComponent): c is { insert: string } => 'insert' in c
export const isDelete = (c: OpComponent): c is { delete: number } => 'delete' in c

/** 操作消耗的原文档字符数（retain + delete） */
export function baseLength(op: Op): number {
  let n = 0
  for (const c of op) {
    if (isRetain(c)) n += c.retain
    else if (isDelete(c)) n += c.delete
  }
  return n
}

/** 操作产生的新文档字符数（retain + insert） */
export function targetLength(op: Op): number {
  let n = 0
  for (const c of op) {
    if (isRetain(c)) n += c.retain
    else if (isInsert(c)) n += c.insert.length
  }
  return n
}

export function isNoop(op: Op): boolean {
  return op.every((c) => isRetain(c))
}

/** 规范化：剔除空组件、合并相邻同类组件 */
export function normalize(op: Op): Op {
  const out: Op = []
  for (const c of op) {
    if (isRetain(c) && c.retain === 0) continue
    if (isDelete(c) && c.delete === 0) continue
    if (isInsert(c) && c.insert.length === 0) continue
    const last = out[out.length - 1]
    if (last && isRetain(last) && isRetain(c)) last.retain += c.retain
    else if (last && isDelete(last) && isDelete(c)) last.delete += c.delete
    else if (last && isInsert(last) && isInsert(c)) last.insert += c.insert
    else out.push({ ...c } as OpComponent)
  }
  return out
}

/** 将操作应用到文档上，返回新文档 */
export function apply(doc: string, op: Op): string {
  let out = ''
  let pos = 0
  for (const c of op) {
    if (isRetain(c)) {
      if (pos + c.retain > doc.length) throw new Error('OT apply: retain 超出文档长度')
      out += doc.slice(pos, pos + c.retain)
      pos += c.retain
    } else if (isInsert(c)) {
      out += c.insert
    } else {
      if (pos + c.delete > doc.length) throw new Error('OT apply: delete 超出文档长度')
      pos += c.delete
    }
  }
  if (pos !== doc.length) throw new Error('OT apply: 操作未消费完整文档')
  return out
}

/**
 * 双侧变换：a、b 基于同一文档版本，返回 [a', b']：
 *   apply(apply(S, a), b') === apply(apply(S, b), a')
 * 约定：a 在 insert/insert 同位置冲突时优先（a 的文本排在前面）。
 * 因此调用方必须把「已被服务器接受、先发生的操作」放在第一个参数，
 * 服务端与所有客户端使用同一约定即可收敛。
 */
export function transformPair(a: Op, b: Op): [Op, Op] {
  const aOut: Op = []
  const bOut: Op = []
  let i = 0
  let j = 0
  let ca: OpComponent | undefined = a[0]
  let cb: OpComponent | undefined = b[0]

  const nextA = () => {
    ca = a[++i]
  }
  const nextB = () => {
    cb = b[++j]
  }

  while (ca !== undefined || cb !== undefined) {
    // a 的 insert 优先发射（a 赢得同位置插入冲突）
    if (ca && isInsert(ca)) {
      aOut.push(ca)
      bOut.push({ retain: ca.insert.length })
      nextA()
      continue
    }
    if (cb && isInsert(cb)) {
      aOut.push({ retain: cb.insert.length })
      bOut.push(cb)
      nextB()
      continue
    }
    if (ca === undefined) {
      // a 已耗尽，b 剩余的 delete 对 a' 无影响（字符已被 b 删除，a' 无需操作），
      // 但 b' 需要原样保留 b 的 delete。
      if (cb) {
        if (isDelete(cb)) bOut.push(cb)
        else if (isRetain(cb)) {
          aOut.push(cb)
          bOut.push(cb)
        }
        nextB()
      }
      continue
    }
    if (cb === undefined) {
      if (isDelete(ca)) aOut.push(ca)
      else if (isRetain(ca)) {
        aOut.push(ca)
        bOut.push(ca)
      }
      nextA()
      continue
    }

    // 双方均为 retain / delete，取最小消耗步长对齐
    if (isRetain(ca) && isRetain(cb)) {
      const n = Math.min(ca.retain, cb.retain)
      aOut.push({ retain: n })
      bOut.push({ retain: n })
      ca = ca.retain === n ? a[++i] : { retain: ca.retain - n }
      cb = cb.retain === n ? b[++j] : { retain: cb.retain - n }
    } else if (isDelete(ca) && isDelete(cb)) {
      // 双方删除同一段字符：结果中互相抵消，无需任何输出
      const n = Math.min(ca.delete, cb.delete)
      ca = ca.delete === n ? a[++i] : { delete: ca.delete - n }
      cb = cb.delete === n ? b[++j] : { delete: cb.delete - n }
    } else if (isDelete(ca) && isRetain(cb)) {
      // a 删除、b 保留：a' 仍删除，b' 无需 retain（字符已不存在）
      const n = Math.min(ca.delete, cb.retain)
      aOut.push({ delete: n })
      ca = ca.delete === n ? a[++i] : { delete: ca.delete - n }
      cb = cb.retain === n ? b[++j] : { retain: cb.retain - n }
    } else {
      // isRetain(ca) && isDelete(cb)：b 删除、a 保留：a' 无需 retain，b' 仍删除
      const n = Math.min((ca as { retain: number }).retain, (cb as { delete: number }).delete)
      bOut.push({ delete: n })
      ca = (ca as { retain: number }).retain === n ? a[++i] : { retain: (ca as { retain: number }).retain - n }
      cb = (cb as { delete: number }).delete === n ? b[++j] : { delete: (cb as { delete: number }).delete - n }
    }
  }
  return [normalize(aOut), normalize(bOut)]
}

/** 单侧变换：op 基于 S，other 已被接受，返回 op 在 other 之后应用的形态（other 优先） */
export function transform(op: Op, other: Op): Op {
  return transformPair(other, op)[1]
}

/** 组合：compose(a, b) 等价于先应用 a 再应用 b */
export function compose(a: Op, b: Op): Op {
  const out: Op = []
  let i = 0
  let j = 0
  let ca: OpComponent | undefined = a[0]
  let cb: OpComponent | undefined = b[0]

  while (ca !== undefined || cb !== undefined) {
    // a 的 delete 最先发射（先删原文档字符）
    if (ca && isDelete(ca)) {
      out.push(ca)
      ca = a[++i]
      continue
    }
    // b 的 insert 直接发射（插入的是新字符，与 a 无关）
    if (cb && isInsert(cb)) {
      out.push(cb)
      cb = b[++j]
      continue
    }
    if (ca === undefined) {
      // a 耗尽：b 剩余组件原样接上
      if (cb) {
        out.push(cb)
        cb = b[++j]
      }
      continue
    }
    if (cb === undefined) {
      // b 耗尽：a 剩余组件原样接上
      if (ca) {
        out.push(ca)
        ca = a[++i]
      }
      continue
    }

    if (isInsert(ca)) {
      // a 插入的字符，b 可能 retain 或 delete
      if (isRetain(cb)) {
        const n = Math.min(ca.insert.length, cb.retain)
        out.push({ insert: ca.insert.slice(0, n) })
        ca = n === ca.insert.length ? a[++i] : { insert: ca.insert.slice(n) }
        cb = cb.retain === n ? b[++j] : { retain: cb.retain - n }
      } else if (isDelete(cb)) {
        const n = Math.min(ca.insert.length, cb.delete)
        // a 插入的字符随即被 b 删除，互相抵消
        ca = n === ca.insert.length ? a[++i] : { insert: ca.insert.slice(n) }
        cb = cb.delete === n ? b[++j] : { delete: cb.delete - n }
      }
    } else if (isRetain(ca)) {
      if (isRetain(cb)) {
        const n = Math.min(ca.retain, cb.retain)
        out.push({ retain: n })
        ca = ca.retain === n ? a[++i] : { retain: ca.retain - n }
        cb = cb.retain === n ? b[++j] : { retain: cb.retain - n }
      } else if (isDelete(cb)) {
        const n = Math.min(ca.retain, cb.delete)
        out.push({ delete: n })
        ca = ca.retain === n ? a[++i] : { retain: ca.retain - n }
        cb = cb.delete === n ? b[++j] : { delete: cb.delete - n }
      }
    }
  }
  return normalize(out)
}

/** 求逆操作：apply(apply(S, op), invert(op, S)) === S。用于本地回滚。 */
export function invert(op: Op, doc: string): Op {
  const out: Op = []
  let pos = 0
  for (const c of op) {
    if (isRetain(c)) {
      out.push({ retain: c.retain })
      pos += c.retain
    } else if (isInsert(c)) {
      out.push({ delete: c.insert.length })
    } else {
      out.push({ insert: doc.slice(pos, pos + c.delete) })
      pos += c.delete
    }
  }
  return normalize(out)
}

/**
 * 位置映射：将文档中的偏移 pos 穿过操作 op 映射到新文档中的偏移。
 * assoc 决定「恰好在 pos 处发生插入」时位置的归属：
 *   - 'before'：位置属于其后的字符，不随插入后移（远程在光标处插入时，本地光标不动）
 *   - 'after' ：位置属于其前的字符，随插入后移
 */
export function mapPosition(pos: number, op: Op, assoc: 'before' | 'after' = 'after'): number {
  let oldPos = 0
  let delta = 0
  for (const c of op) {
    if (isRetain(c)) {
      if (pos < oldPos + c.retain) return pos + delta
      oldPos += c.retain
    } else if (isInsert(c)) {
      if (pos > oldPos || (pos === oldPos && assoc === 'after')) delta += c.insert.length
    } else {
      if (pos <= oldPos) return pos + delta
      // 位置落在被删除区间内：收缩到删除起点
      if (pos < oldPos + c.delete) return oldPos + delta
      delta -= c.delete
      oldPos += c.delete
    }
  }
  return pos + delta
}

/** 由「旧文本 → 新文本」的差异反推一个操作（取最长公共前缀/后缀，适用于单点编辑） */
export function diffToOp(oldDoc: string, newDoc: string): Op {
  if (oldDoc === newDoc) return [{ retain: oldDoc.length }]
  let start = 0
  const minLen = Math.min(oldDoc.length, newDoc.length)
  while (start < minLen && oldDoc[start] === newDoc[start]) start++
  let oldEnd = oldDoc.length
  let newEnd = newDoc.length
  while (oldEnd > start && newEnd > start && oldDoc[oldEnd - 1] === newDoc[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  const op: Op = []
  if (start > 0) op.push({ retain: start })
  if (oldEnd > start) op.push({ delete: oldEnd - start })
  if (newEnd > start) op.push({ insert: newDoc.slice(start, newEnd) })
  if (oldDoc.length - oldEnd > 0) op.push({ retain: oldDoc.length - oldEnd })
  return normalize(op)
}
