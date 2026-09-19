# 多人协同批注编辑器

基于 **Vue3 + TypeScript + Pinia + Element Plus + WebSocket** 的多人轻量协同批注编辑器。
多人同时编辑 / 批注同一文档，使用 **OT（Operational Transformation）** 解决并发冲突，
支持只读 / 批注 / 编辑三种权限，具备断网重连、消息丢失检测与状态回滚能力。

## 功能一览

- **实时协同编辑**：多人在线编辑同一文档，操作经 OT 变换后收敛一致
- **划词批注**：选中文字添加批注，支持回复、解决、删除；批注锚点随编辑自动移动
- **三级权限**：`editor`（编辑+批注）/ `commenter`（仅批注）/ `viewer`（只读），服务端逐条校验
- **在线状态**：在线用户列表、远程光标与选区实时展示
- **异常链路**：断网自动重连（指数退避）、离线编辑暂存、消息序号空洞检测、ack 超时重同步、版本过旧时全量快照回滚
- **演示工具栏**：一键「模拟断线 / 重新连接」，直观展示离线编辑与重连同步

## 快速开始

```bash
# 1. 安装依赖（根目录 + server + client）
npm run setup          # 或分别 npm --prefix server install && npm --prefix client install
npm install            # 根目录 concurrently（仅 dev 需要）

# 2. 开发模式（server:8080 + vite:5173，ws 已配置代理）
npm run dev

# 3. 打开 http://localhost:5173 ，多开几个标签页选择不同身份加入同一文档
```

生产模式：

```bash
npm run build          # 构建客户端到 client/dist
npm start              # 服务端托管 API + 静态页面：http://localhost:8080
```

测试与类型检查：

```bash
npm test               # OT 单元测试（含随机 fuzz 收敛性）+ 服务端 e2e（并发/权限/重连/快照）
npm run typecheck      # server tsc + client vue-tsc
```

## 目录结构

```
├── shared/               # 前后端共享代码
│   ├── ot.ts             #   OT 核心：apply / transformPair / compose / invert / mapPosition / diffToOp
│   └── protocol.ts       #   协议类型：角色、批注、全部 WS 消息
├── server/
│   └── src/
│       ├── docSession.ts #   文档会话：版本日志、OT 变换、批注锚点变换、权限、重同步
│       └── index.ts      #   HTTP + WS 入口、心跳、静态托管、文件持久化
│   └── test/             #   ot.test.ts（性质 fuzz）/ e2e.test.ts（并发·权限·重连）
│                         #   otClient.e2e.ts（真实客户端 OTClient × 真实服务端集成）
└── client/src/
    ├── collab/collab.ts  #   编排层：连接 × OT × store，异常链路处理
    ├── ot/otClient.ts    #   OT 客户端状态机（未确认队列 / 发送节流 / ack 超时）
    ├── ws/wsClient.ts    #   WS 封装（自动重连 / 发送队列 / 心跳）
    ├── stores/           #   Pinia：session（连接·用户）/ doc（文档·批注）
    └── components/       #   EditorView（高亮层编辑器）/ AnnotationPanel / TopBar / LoginGate
```

## 核心设计

### OT 并发模型

文档为纯字符串，操作是 `retain(n) / insert(s) / delete(n)` 组件序列：

- 服务端为每个文档维护 `revision` 与操作日志（上限 1000 条）。客户端操作携带基准版本号；
  若已落后，服务端将其对落后期间的全部已接受操作**逐个变换**后应用，再广播给其他人。
- 客户端本地乐观应用，未确认操作进入队列（`unacked[0]` 已发送待确认，其余为缓冲，
  连续输入经 `compose` 合并）。远程操作到达时与全部未确认操作做双侧变换。
- 同位置并发插入的先后由「先被服务端接受者优先」的全局约定打破，保证各端收敛。
- 正确性由 `server/test/ot.test.ts` 中的随机 fuzz 性质测试保障
  （`apply(apply(S,a),b') === apply(apply(S,b),a')`、compose 结合律、invert 往返、三方并发收敛）。

### 批注锚点

批注锚定 `[start, end)` 区间。服务端与客户端在每次应用操作时都用 `mapPosition`
移动锚点（起点 `after`、终点 `before`，边界输入不扩选）；锚点文本被完全删除时
批注转为「孤儿」状态（📌 标记，保留原文引用）。

### 断网重连与消息可靠性

| 异常 | 检测 | 恢复 |
| --- | --- | --- |
| 断网 / 假死 | WS close、应用层 ping/pong 心跳（10s/5s） | 指数退避重连（1s→2s→…→15s + 抖动），重连后带 `lastRevision` 重新 join |
| 离线编辑 | — | 编辑进入 OT 队列、批注进入 outbox，重连并重同步后自动补发 |
| 消息丢失（下行） | 广播消息携带单调 `seq`，客户端检测空洞 | 发送 `resync`，服务端按版本补发 `ops`（含按 opId 去重自己的操作） |
| 消息丢失（上行/ack） | ack 5s 超时 | 同上触发 resync |
| 版本过旧 | 服务端日志不足以覆盖客户端版本 | 下发全量快照，客户端**回滚**未确认修改并提示 |
| 权限/协议错误 | 服务端逐条校验返回 `error` | 前端提示，必要时自动 resync |

### 实时推送频率与性能权衡

- **编辑操作**：本地乐观应用零延迟；发送端做 **60ms 节流合并**（`minSendInterval`），
  连续打字合并为一条消息，ack 后立即发送缓冲批次 —— 用可忽略的延迟换取消息数量级下降。
- **光标/选区**：120ms 节流、易失消息（不计 seq、不持久化、断线即弃），不参与可靠性链路。
- **presence**：仅 join/leave 时广播。
- **持久化**：文档变更后 1.5s 防抖写盘（`server/data/*.json`），重启自动恢复。
- **渲染**：高亮层按「边界切分」一次计算 HTML，避免逐字 span；大文档下 diff 为
  公共前后缀算法，单点编辑 O(1) 生成操作。

### 已知取舍（轻量化的边界）

- 单文档模型为纯文本（非富文本），编辑器用 `textarea + 高亮背景层` 实现，
  避免 contenteditable 的选区/IME 复杂度；IME 组合输入期间不做 diff。
- 服务端为单进程内存状态 + 文件持久化；多实例部署需引入共享存储与消息总线。
- 角色在加入时选定（演示用），未实现管理员在线改权；服务端已按消息逐条鉴权，
  接入真实账号体系后可直接复用校验点。
- 批注锚点在「本地未确认操作 + 并发远程操作」的极端交错下可能与服务端有字符级偏差，
  任何重同步都会以服务端为准收敛。

## 协议摘要

客户端 → 服务端：`join`（含 lastRevision）/ `op`（含 opId+revision）/ `cursor` /
`ann:add|reply|resolve|delete` / `resync` / `ping`

服务端 → 客户端：`welcome`（snapshot 标志 + seq）/ `ops`（增量补发）/ `ack` / `op` /
`presence` / `cursor` / `ann:upsert|delete` / `error`（PERMISSION_DENIED、RESYNC_REQUIRED…）/ `pong`
