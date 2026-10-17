# aimi v1 设计文档 — 移动端编码 Agent 远程监控与控制系统

> 状态：Draft · 待 builder check 与最终批准
> 决策来源标注：〔对话〕= 2026-10-17 与项目所有者的设计对话中确认；〔建议〕= 编写者建议值，builder check 后确认归属

---

## 1. 意图与背景（Intent & Why）

**一句话**：让 AI 编码 agent 在你离开电脑时也能被盯住、被打断、被指派新任务——用手机，实时。

**为什么现在做**：Claude Code / Codex / OpenCode / ZCode 这类编码 agent 已经成为日常主力工具，但它们跑在开发机的终端里。一次长任务动辄数小时，其中大量时间 agent 是**阻塞等待人**：确认工具权限、回答提问、等待反馈。人一离开座位，整个流水线就停摆；多个 agent 并行时还得逐窗口切换盯梢。与此同时，所有主流 agent CLI 都已经提供机器可读的双向流式协议（NDJSON / JSON-RPC / HTTP+SSE），手机是唯一随身设备——把"盯盘"从电脑前解耦出来的技术前提刚好成熟。〔对话〕

**给谁用**：首先是项目所有者本人（自用工具），单台开发机、单设备接入，不追求大众分发。〔对话〕

---

## 2. 目标 / 非目标 / 反目标

### 2.1 目标（可验收）

| # | 目标 | 验收口径 |
|---|---|---|
| G1 | 手机实时查看目标电脑上全部托管 agent 会话流 | 事件从 agent 产生到手机渲染完成：LAN ≤ 1000 ms、外网经中继 ≤ 3000 ms（P95，测试条件见 §7） |
| G2 | 手机交互控制：打断、发送新指令+附件、回答 agent 提问、审批工具调用（once/always/reject） | 命令从手机提交到 agent 进程收到：同 G1 延迟口径 |
| G3 | 会话进入会阻塞 agent 的状态（等待审批 / 等待输入）时手机被主动唤醒 | 前台服务长连接承载通知（不依赖系统推送商）：事件产生→通知 ≤ 10 s（正常网络、前台服务存活，P95）；服务被死后 ≤ 5 min 内可恢复（用户打开 app 或开机自启） |
| G4 | 断线/杀后台回来后无缝续流 | 缺口事件按 resume 光标补发，零丢失、零重复执行（命令幂等） |
| G5 | 电脑/server 重启后历史完整可查、可续接 | 会话列表与全部历史事件可恢复；支持 resume 的 agent 一键续接，server 重启**不自动复活** agent 子进程 |
| G6 | claude code / codex / opencode 三家完整接入 + zcode 实验性接入 | 三家：完整 waiting 检测/审批/续接；zcode：残缺适配器（send+监控，按其协议能力尽量对齐），UI 明示实验性 |
| G7 | 局域网直连为主链路；外网经中继链路**架构就绪、资源预留** | relay 代码/协议/部署物就绪，云资源确认后即插启用；外网验收顺延至 relay 就绪时补做 |

### 2.2 非目标（v1 明确不做）

- 多台电脑（v1 锁定 1 台开发机）
- 自动编排/调度（拆任务、自动派发、结果汇总——纯监控+人工指派）
- attach 用户已有终端会话（所有会话必须由 aimi-server 托管启动）
- 多人/多角色权限体系、云端账号体系（自用，无注册登录）
- 文件编辑/深度遥控（远程 IDE 级体验）
- server 端全文搜索（v1 手机本地过滤，FTS 划入 v1.1）
- 端到端加密（relay 可见明文，v1.1 补）
- **iOS 端**（Android 领先一拍；待 Apple Developer 帐号 + macOS/云端构建链条齐备后单独立项追平）
- **系统推送商通道（FCM / APNs）**：主力网络环境 FCM 不可达；通知由前台服务长连接承载，不引入 Firebase
- UI 视觉专项（先完成功能开发；视觉独立设计定稿后实施并另行验收）　〔对话〕

### 2.3 反目标（出现即算失败）

- 推送不可靠：审批/提问深夜到了手机却没响——盯盘价值清零
- 审批流别扭：手机上处理一个权限请求要点很多下、看不清在批什么
- UI 不吸引人：功能全但没人想打开（项目所有者原话：UI 是脸面，功能再好都没人用）
- 双头写状态：审批被执行两次、事件显示乱序
- agent 因 aimi 挂掉而丢工作状态：aimi 的任何故障不得比"没有 aimi"更糟

---

## 3. 约束（Constraints）

用户拍板的硬约束〔对话〕：

| 约束 | 内容 |
|---|---|
| C1 技术栈 | 方案 A：**Flutter 双端 App（iOS+Android）+ Node.js 22 / TypeScript 的 aimi-server 与 aimi-relay + 自建极简 WebSocket 哑管道中继**，部署在自有云服务器（Linux），relay 前置 Caddy 做 TLS |
| C2 持久化 | **SQLite（WAL）** 为唯一权威存储；持久层必须抽象为 **`ConversationRepository`** 接口（命名后缀 Repository），业务模块禁止直连存储实现；接口必须允许未来替换其他数据库或冷归档至对象存储 |
| C3 机器 | server 仅 Windows 10/11（优先）；手机 **Android 领先一拍（v1 全量）**，iOS 待构建链条后追平 |
| C4 dedication | 命名（目录/文件/类/函数）必须取自真实业务语义，参照大型工程惯例；禁止 `M0_xx`、tmp、util 这类无语义词 |
| C5 注释 | 该注释处必须有清晰注释，参照开源/大厂项目风格（公开 API 必有 doc comment） |
| C6 架构 | 职责清晰、高内聚低耦合，禁止一锅炖；每文件单一职责 |
| C7 Git | 提交遵循 Conventional Commits（`feat(server):` / `fix(mobile):` / `refactor(protocol):`，scope=monorepo 组件） |
| C8 质量 | 功能开发完必须有充分测试才可交付：单元测试、集成测试、性能测试、压力测试都要有关口，不过关不得合入/发布 |
| C9 定位 | 自用工具：不建账号体系、不做多租户；以下所有安全设计以此为前提 |
| C10 网络 | 大陆网络环境，FCM 不可达：通知不走系统推送商，由 app 常驻前台服务的长连接承载；relay 属预留资源（云服务器现有，域名/规格后确认，部署即插） |

---

## 4. 总体架构

```
┌─────────────────┐         ┌──────────────────┐
│  aimi-mobile     │  WSS    │  aimi-relay      │  自有云服务器 Linux
│  Flutter App     │◄═══════►│  哑管道 WS 中继    │  + Caddy TLS
│  iOS / Android   │         │  (无业务逻辑)      │
└───────▲─────────┘         └────────▲─────────┘
        │ WS (LAN，token 校验)        │ WSS (出站拨入)
        │                            │
┌───────┴────────────────────────────┴─────────┐
│  aimi-server  (Node.js 22 + TypeScript)      │  Windows 开发机
│  会话托管 · 统一事件归一 · SQLite 持久化        │
│  · agent 适配层 (claude/codex/opencode/zcode) │
│  · LAN WS 服务 (mDNS 广播) · 中继拨入常驻连接   │
│  · 通知下发路由 · 设备/审计管理 · 运维 CLI        │
└───────┬──────────┬──────────┬──────────┬─────┘
   claude子进程  codex子进程  opencode子进程  zcode子进程
   (各由适配器按其原生协议承载)
```

分工铁律〔对话〕：

1. **aimi-server 拥有全部业务逻辑**：托管 agent 子进程全生命周期、协议归一、多会话管理、持久化、重放、命令执行。能脱离手机独立运行。
2. **aimi-relay 是哑管道**：只做 token 验证、配对查找、原样转发字节。无业务逻辑——server 与 relay 升级互不牵连。
3. **aimi-mobile 是观察者+控制面板**：一切状态来自 server 推送（含重放），本地仅缓存镜像，冷启动秒开历史。
4. **agent CLI 是被托管的子进程**：由 server 拉起并看管到底。
5. **server 对 relay 是出站拨入**（desktop→cloud 方向长连接），手机连 cloud：桌面与手机两侧 NAT/防火墙零配置。
6. 两条链路跑**同一种 WS 协议**，手机端只认"地址+令牌"，切换自动、UI 显示当前链路。

---

## 5. 已决定的组件设计（as decided）

### 5.1 Agent 适配层（项目心脏）

**统一事件模型 AgentEvent**（server → 手机）：

```ts
type AgentEvent =
  | { type: "state",      state: "starting" | "running" | "waiting_approval"
                          | "waiting_input" | "finished" | "failed" | "stopped" }
  | { type: "text_delta",   sessionId, text }                  // 流式正文
  | { type: "thinking",     sessionId, text }                  // 思考摘要
  | { type: "tool_call",    id, name, summary, inputDigest }   // 工具开始
  | { type: "tool_result",  id, ok, outputExcerpt, exitCode? } // 工具结束
  | { type: "permission",   id, title, detail, options: ApprovalOption[] }
  | { type: "question",     id, prompt, options?: Choice[] }   // agent 提问
  | { type: "usage",        tokensIn, tokensOut, cost? }
  | { type: "notice",       severity, text }                   // 卡死提示/上下文压缩等
  | { type: "exit",         exitCode, durationMs }
```

**统一指令集 AgentCommand**（手机 → agent）：

```ts
type AgentCommand =
  | { cmd: "send",      text, files?: {name, b64}[] }
  | { cmd: "interrupt" }
  | { cmd: "approve",   requestId, decision: "once" | "always" | "reject" }
  | { cmd: "answer",    questionId, value }
  | { cmd: "stop" }
  | { cmd: "restart" }
```

**适配器接口**（吸收四家协议异构性——stdio / HTTP+SSE / SDK 回调全部封在适配器内）：

```ts
interface AgentAdapter {
  meta: AgentMeta;                                   // id / 名称 / 图标
  isInstalled(): Promise<{ ok: boolean; version?: string }>;
  create(spec: SessionSpec, emit: (e: AgentEvent) => void): AgentSession;
}
interface AgentSession {
  start(): Promise<void>;
  send(cmd: AgentCommand): Promise<void>;
  dispose(reason?: string): Promise<void>;
}
// SessionSpec: { agentId, cwd, model?, permissionMode?, initialPrompt? }
```

四家对接要点〔对话，实现期以各家官方文档核对〕：

| agent | 接入协议 | 审批/提问回流 | 成熟度 |
|---|---|---|---|
| claude code | 官方 Claude Agent SDK (TS) `query()`，NDJSON 双向流；支持 interrupt / resume | SDK `canUseTool` 回调 native 映射 | 高 |
| codex | 随 CLI 提供的 **app-server JSON-RPC over stdio**（字段以 openai/codex 官方文档为准） | 服务端推 approval 请求通知 → 回 decision | 中（无官方 TS SDK，手写薄客户端） |
| opencode | 官方 **server 模式**：HTTP API + SSE 事件流（`opencode serve`），官方 TS SDK | REST 端点响应权限（once/always/reject），SSE 推 pending 事件 | 中高 |
| zcode | 对齐其官方无头/JSON 模式文档（zcode.z.ai），形制接近 claude code | 视文档而定 | 低——**待验证**（开放问题 Q1） |

三条关键决定〔对话〕：

- **waiting 检测是灵魂**：`waiting_approval / waiting_input` 状态驱动看板红点、推送、UI 徽标。适器做不到=不完整。
- **可续接性**：适配器必须保留 `(会话ID → resume 线索)`；server 重启后可续接。zcode 不能则标"不可恢复"。
- **权限语义映射表**：每个适配器维护"统一 decision ↔ 原生响应"映射并配单测（最容易翻车的点）。

### 5.2 aimi-server 内部划分（分层与模块边界，全部定稿）

依赖方向自上而下，两条铁律：接入层不认识 agent 适配器；跨模块通信必经事件总线，禁止 peer 互调（CI 静态检查把守）。

```
cli/                      运维入口（pair/devices/revoke/sessions/audit/install/status）
 └→ app/                  启动装配：加载 config.yaml（独家读盘）、组装各模块、生命周期
     ├→ 接入层：
     │   transport/   传输抽象 Conveyor（§A）
     │     ├ ws/      v1 唯一实现：wsLan 监听 + wsRelay 出站拨入
     │     └ （未来 quic/ webrtc/ grpc/ 各自独立目录）
     │   auth/        鉴权中枢 + 通道鉴权策略（§B）
     ├→ 核心层：
     │   session/     会话编排核心（§C）
     │   agents/      registry + 四家适配器（§5.1）
     │   events/      事件总线 + 事件管理（§E）
     └→ 基础层（横切）：
         persistence/  持久层（§D）→ auditlog/ → logging/ → ops/
```

#### §A transport/ —— 统一 WebSocket，抽象可换

- 全系统统一 WebSocket：LAN 与 relay 拨入是同一帧协议、同一抽象的两个实例，server 视角无差别。
- 抽象为 **`Conveyor`**（双向帧通道）接口：`open / send(frame) / receive() / close(reason) / state`。心跳、重连、重放信封属于协议层，**不属于 Conveyor 实现**；未来换 QUIC/WebRTC/gRPC 时只新增 transport 子目录 + 对应通道鉴权策略，核心层零改动。核心层只认 Conveyor 接口。

#### §B auth/ —— 鉴权中枢 + 通道策略

- 通道无关决策：设备 token 校验（SHA-256 对表、**逐帧**校验）、一次性配对码（8 位、5 min、单次）、单设备锁 → 产出 `{device, grants}`。
- 通道差异封装为策略：**LAN 策略**（明文 ws + token，家庭网已声明风险）；**relay 策略**（拨入 server-token；手机侧逐帧设备校验——语义统一在 server，relay 永不充当信任判断者）。换传输方式只补一个策略，鉴权中枢不动。
- 鉴权事件（配对/吊销/失败尝试）强制进审计。

#### §C session/ —— 会话编排核心（三类形态，语义分开）

| 形态 | 编排逻辑 | 手机可见 |
|---|---|---|
| 新会话 | spec 校验（agent 已装/目录合法/手机不许升权）→ registry 取适配器→拉起→全事件落库 | 看板正常出现 |
| 可续接 | 持久层恢复 + 每适配器自述的 resume 线索标记；**手机显式续接指令才动**（防半夜全员复活烧 token） | "可续接"徽标，一键续接 |
| 不可续接 | 无线索/agent 不支持：历史可查不可续跑 | 历史区，标"不可续接" |

- 状态机 `starting→running→waiting_approval→running→…→finished/failed/stopped` 所有跃迁先过 session/、再经 events/ 广播，不与 agent 原生状态字面量耦合；interrupt/restart/stop/reset 编排唯一入口在此。
- 模块结构（各模块目录，依赖只指向上层接口）：

```
core 接口事实名单（业务模块 import 清单）：
  session/   ← registry(agents) + ConversationRepository + CommandDedupRepository + EventBus
  agents/    ← 只依赖统一事件/指令类型与 registry 规约
  events/    ← ConversationRepository + Conveyor 帧 + 通知路由
```

#### §D persistence/ —— 持久层（接口的仓库，不是业务的仓库）

**表所有权一对一，模块只能走各自仓储接口：**

| 仓储接口 | 表/数据 | 唯一使用方 | 说明 |
|---|---|---|---|
| `ConversationRepository` | `sessions` + `events` | session/（写）· events/（追加）· ops/（恢复扫描、清理） | `init/createSession/appendEvent/getEvents(sinceSeq,limit)/listSessions/updateSession/close` + 冷归档 `exportSession(id)→NDJSON`；多行联动（新会话=会话行+初始事件）在接口内原子完成 |
| `DeviceRepository` | `devices` | auth/ | 配对/吊销/逐帧校验数据面 |
| `CommandDedupRepository` | `cmd_dedup` | session/ | 写操作幂等（clientId 去重） |
| `AuditRepository` | `audit` | auditlog/ | 审计写入与查询 |

**边界规则（CI 把守）**：
1. 只有 persistence/ 写 SQL/DDL，业务模块禁止直连存储实现；
2. 表与模块一一对应，禁止跨模块抄表；
3. 事务边界在仓储接口内成交（调用方不感知）；
4. 迁移只追加（加列/加表、版本号守门、启动自动执行、旧库向前可读）；
5. 保留策略执行在 ops/（定时调 `purgeExpired(policy)`；规则值 100 会话/90 天来自 app/ 配置快照），persistence/ 只实现清理与导出；
6. 性能契约挂在接口上（微批+索引 → 落库 ≥ 500 events/s、重放毫秒级，见 §7），WAL/聚批是实现自由度。

SQLite(WAL) 为 v1 唯一实现（SqliteRepository）+ 测试用 MemoryRepository；换基建/OSS 冷归档 = 新实现，core 零改动。

#### §E events/ —— 事件总线与事件管理

- **EventBus**：进程内单线程序列化分发（保序——异常 #12 的根），扇出三路：persistence/ 落库、Conveyor UI 帧、通知分类路由。
- **事件管理规则集中于此（别处不重复实现）**：会话事件统一信封+seq 单调递增；落库闸门（经 ConversationRepository）；通知分类路由（pending_approval/pending_question/finished/failed + stalled）→ 通知帧；洪水控制（text_delta ≤ 100 ms 聚合、payload ≤ 8 KB 截断）。

#### §F 横切：auditlog / logging / ops

- **auditlog/**：业务命令审计 + 鉴权事件审计同表，与排障日志分离（问"谁干了什么" vs "哪里出问题"）。
- **logging/**：JSON 行、分级、组件 tag、按天滚动。
- **ops/**：指标快照（§7 基准）、诊断、`aimi-server` 全部子命令实现（cli/ 只绑参数）；保留策略定时执行者。

Windows 常驻〔对话〕：`aimi-server install` 注册任务计划 ONLOGON（隐藏窗口、失败 1 分钟自动重启至多 3 次）；`aimi-server uninstall` 卸载。全部状态可在进程被杀后经 DB 完整恢复。

### 5.3 通信协议与断线重放

信封层次〔对话〕：

```text
链路层: hello{token, device, resume?{[sessionId]: lastCursor}}
        welcome{serverVersion, sessions[]} · ping/pong(15s，连续 2 拍未回=判死，≤45s 检出)
        bye{reason}
领域层(全部带单调递增 seq):
  C→S session.create{spec} · session.command{sessionId, clientId, cmd}
  S→C session.event{sessionId, seq, ts, event} · session.list{sessions} · ack/error
```

- **重连**：`hello.resume` 携带手机本地存的各会话 lastCursor → server 按 DB events 表补发缺口 → 手机端无缝续流。重放吞吐预算 ≥ 500 events/s（LAN 参考硬件）〔建议〕。
- **幂等**：所有写操作带 `clientId`(uuid)，`cmd_dedup` 表去重——断线重发的 approve/interrupt 不执行两遍。
- **命令限速**：每设备 ≤ 10 条/s，超限排队不丢弃。
- **双链路迁移（手机端）**：同时持有 LAN 地址 + relay 地址；断网重连先试 LAN（3 s 内不通切 relay）；双向可迁，UI 徽标显示 `LAN / 中继 / 离线…`。
- **洪水控制（server 侧）**：tool_result 输出 > 8 KB 截断为摘录+截断标记；text_delta 以 ≤ 100 ms 窗口聚合再发；有序性由 eventBus 单线程序列化保证（Node 单进程事件循环自然保序）。

### 5.4 安全模型

威胁画像：手机端可让电脑执行代码（agent 本就有 shell/写盘权限）。自用前提下防三类对手：丢机/泄 token、局域网其他设备、云服务器被打穿。〔对话〕

- **配对**：`aimi-server pair` 终端打印 QR（含 serverId、LAN 地址、relay 地址、8 位一次性配对码；5 min 有效、用一次即焚）。手机扫码→提交→server 生成 32 字节设备 token（random）→仅 SHA-256 哈希入 `devices` 表；随时 token 只存手机 secure_storage（Keychain/Keystore）。
- **校验**：每条 WS 连接 token 哈希比对 + **逐帧设备校验**——token 被吊销时活连接立即断开。
- **吊销**：`aimi-server devices` 列出 / `aimi-server revoke <device>` 即时失效；审计可回查最后动作。
- **链路加密分级**：WAN=wss（Caddy，TLS 终结在 relay，relay 进程内可见明文——E2E 列 v1.1）；LAN v1=ws 明文+token（家庭网可接受，升级路径保留：自签证书+pinning）；手机本地 secure storage。
- **爆炸半径收敛**：手机只能对**已有**审批请求做 once/always/reject 映射、发消息/打断/停止/重启、在时间线内答复提问；`SessionSpec.permissionMode` 手机端**只许降不许升**（server 守卫），不得由手机开启跳过权限模式。
- **审计**：每条远程命令 `{ts, device_id, sessionId, action, detail}` 落 `audit` 表并写 `audit.log`；`aimi-server audit --last 100` 查看。
- 划出：多因子、RBAC、防定向 APT 加固（E2E 之外）。

### 5.5 aimi-relay

约 300 行的 TypeScript 哑管道〔对话〕：验证两端 token → 依 serverId/设备配对路由 → 原样转发帧；心跳保活；部署为 systemd 服务，前置 Caddy（自动 TLS）。不含协议解析，协议升级不需要动 relay。

### 5.6 aimi-mobile（Flutter）

选型〔对话〕：Riverpod 2.x（事件流→UI 单向管道）、GoRouter（声明式+深链：点通知直达会话）、Drift（本地镜像库：sessions/events 缓存 + lastCursor）、flutter_secure_storage（设备 token）、flutter_local_notifications（本地渲染通知）。**不引入 Firebase**（C10：大陆网络 FCM 不可达）。

分层〔对话〕：`data/`（connection 状态机、协议 DTO、缓存、push）↘ `domain/`（纯函数：事件流→会话视图模型；零 IO，异常场景单测在此）↘ `ui/`（dashboard/session/approval/new_session/settings）。

关键机制〔对话〕：

- **生命周期**：前台=WS 实时流；后台靠推送；回前台=连接状态机复活+光标补齐。重连退避 1s→2s→…→30s 封顶+抖动，前 5 秒积极重试。
- **时间线**：事件追加进本地镜像，UI 只读镜像查询，虚拟列表——洪水下不整屏重建。
- **通知即命令入口**： Android 12+/iOS 通知 action"批准/拒绝"直达，不必进 app。
- **UI 专项**：视觉语言/信息布局/微交互/动效**另行单独立项设计**（本设计文档只约束屏幕骨架与状态表现）；本轮出海即以"不好用的 UI=失败"为反目标。

### 5.7 通知触达（无系统推送商方案）

- **承载通道**：复用事件流本身——app 的**常驻前台服务**维持到 LAN/relay 的 WebSocket 长连接，通知即"该连接上的通知类帧经本地渲染"。server 侧仅由 `events/` 通知分类路由下发（§5.2 §E），不引入 Firebase/APNs。〔对话 + builder check Q1 拍板，见 §11〕
- **Android 保活**：前台服务+常驻状态栏通知；设置页提供各厂 ROM 电池优化白名单引导；开机自启恢复；前台服务被杀→打开 app 或开机自恢复（G3 承诺含 ≤5 min 恢复）。
- **触发分类**：pending_approval、pending_question、finished、failed；另 stalled（§6 #10）可配置默认推送〔建议〕；按事件类型在设置中启停。
- **形态**：本地渲染通知（内容不经过第三方），通知 action"批准/拒绝"直达；深链 GoRouter 直达会话并 resume 补齐。
- **iOS**：划出 v1（见 C3/非目标）；届时评估 APNs 或"前台服务+后台拉取"降级链——链条对现有架构零破坏。

---

## 6. 异常场景矩阵（全部 12 条契约）

| # | 场景 | 处理策略 | 结果承诺 |
|---|---|---|---|
| 1 | 手机断网/杀后台后回来 | 重连 + resume 光标补发 | 缺口事件零丢失 |
| 2 | 审批请求落在断网窗口 | 事件已落库，重连后补发 permission 事件；agent 侧阻塞等待天然支持晚到审批（各适配器核对——开放问题 Q3） | 审批不静默丢失 |
| 3 | agent 子进程崩溃/被杀 | exit 事件 + failed/stopped 状态 + 推送；可续接会话可一键续接 | 不比"没有 aimi"更糟 |
| 4 | aimi-server 崩溃/断电 | 任务计划自动重启；不自动复活子进程；手机从 transcripts/DB 恢复视图 | G5 |
| 5 | relay 宕机 | server 拨入指数退避重拨；手机连 relay 失败 3 次→提示走 LAN | 双链路互不拖垮 |
| 6 | agent CLI 升级破坏协议 | 启动握手探测 protocolVersion；不兼容→该 agent 标灰"暂不可用" | 故障隔离到单 agent |
| 7 | 重发 approve/interrupt | clientId 去重 | 不执行两遍 |
| 8 | token 泄露/丢机 | `aimi-server revoke` 即时断连 | 立即失效，可审计 |
| 9 | 输出洪水 | 截断+聚合+虚拟列表 | 手机不卡死不 OOM |
| 10 | agent 卡死不输出 | watchdog：running 超过 10 min 无任何事件（可配置）→ notice(stalled) **仅提示不自动打断** | 误报最小化 |
| 11 | 多设备同登 | v1 单设备锁：后登者接管，先登者收 `bye{taken_over}` | 状态无双头写 |
| 12 | 人/agent 同时发消息 | eventBus 单线程序列化 | 手机显示顺序=发生顺序 |

追加异常：磁盘满→停止写入并告警（不丢已存数据）；DB 损坏→备份接续+重建索引恢复；推送 token 失效→自动重注册。〔建议：测试期细化〕

晚到审批语义（builder check Q3 收敛，编写者代决——可被项目所有者否决）〔我的决定〕：实现期逐家核对权限请求的悬挂/超时语义；若某 agent 会拒绝迟到的审批决定，server 端将该决定映射为「审批已失效」通知并在时间线中显式标注，同时该 agent 的审批卡转为时效性（倒计时提示）——不静默吞掉，不代答。

附件与通道细化（builder check 采纳建议定案）〔我的决定〕：`send.files` b64 上限 1 MB，类型白名单=文本/图片（做成可配置）；relay 与 server 拨入采用**独立 server-token**（服务器配置持有，不复用设备 token）。

---

## 7. 性能与可靠性预算

参考硬件：server=项目开发机（Windows 11 / 8 核 / NVMe）；relay=1 vCPU / 2 GB 云 VPS；手机=中端 Android（2020 级）/ iPhone 12。〔建议〕

| 指标 | 预算 | 条件 |
|---|---|---|
| 事件呈现延迟 | LAN ≤ 1000 ms；relay ≤ 3000 ms | P95，事件时刻→手机渲染完成 |
| 命令端到端延迟 | 同上同量级（打断/审批 ≤ 1 拍心跳） | P95 |
| 通知延迟 | ≤ 10 s | 正常网络、前台服务存活（大陆网络，无系统推送商），P95；后台 24 h 存活率为验收观测项 |
| 重连检出 | ≤ 45 s | 心跳 15s×2 拍 |
| 重放吞吐 | ≥ 500 events/s | LAN，缺口 ≤ 10,000 事件 |
| server 稳态内存 | ≤ 300 MB | 8 会话正常输出 24 h |
| relay 内存 | ≤ 150 MB | 2 会话经中继 |
| 洪水承载 | 8 会话并发 ≥ 200 events/s 持续 10 min | 无丢事件、无 OOM、手机无 ANR |
| 稳定性 | server 连续 72 h；relay 连续 7×24 h | 期间无崩溃、无持续内存增长 |

---

## 8. 工程与协作规范（用户强力要求）〔对话〕

- **命名**：目录/文件/类/函数全部取自业务实体（sessionManager、agentAdapter、ConversationRepository、dashboard…），禁止业务上不存在的单词（tmp/util/M0_x/helper×n）。类型在 `packages/protocol` 单一来源定义。
- **注释**：公开 API 100% doc comment（TS 用 TSDoc、Dart 用 dartdoc 风格）；注释回答 why，不重复 what。
- **耦合**：单向依赖：mobile `ui→domain←data`；server `cli→core←agents/transport/push`，core 不 import agents 具体适配器（经 registry）。CI 可加 import 方向静态检查。
- **Git**：Conventional Commits；feat/fix/refactor/docs/test/chore + scope(server|relay|mobile|protocol|tool)；合并前自测走分支。
- **测试闸门**（不达标不交付）：
  - 单元测试：core/domain 全覆盖（核心模块行覆盖 ≥ 80%）；适配器以**协议回放用例**测（录制的原生协议样本→断言归一事件），覆盖 ≥ 70%；
  - 集成测试：四家适配真实子进程跑通 create/send/interrupt/approve；重放/幂等/单设备锁用例化；
  - 异常矩阵 12 条 + 追加异常逐条对应测试项；
  - 性能测试：按 §7 预算逐项出基准脚本与结果记录；
  - 压力测试：8 会话洪水、断连风暴（1000 次循环）、长稳 72 h；
  - 后台 UI 烟雾测试（widget smoke）与深链用例。

---

## 9. 仓库布局与里程碑

Monorepo〔对话〕：

```
aimi/
├─ packages/protocol/     协议唯一源（TS 类型；mobile 端由 schema 生成 Dart）
├─ apps/
│  ├─ server/             （agents/ 适配器为内部分包）
│  ├─ relay/
│  └─ mobile/             Flutter 工程
├─ tools/deploy/relay/    systemd+Caddyfile+脚本
│  tools/windows/         任务计划注册/卸载
└─ docs/                  specs、协议文档、UI 专项草稿
```

里程碑〔对话——以"能用起来"为出口〕：

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| 骨架跑通 | monorepo + protocol + server 骨架（session manager + SqliteRepository + MemoryRepository）+ **claude 适配器** + mobile 骨架（LAN 直连+看板+时间线） | 手机看到 claude 实时流并可打断——核心假设最快验证 |
| 核心闭环 | LAN 全量（审批/提问：时间线内答复+通知 action）+ 前台服务常驻通知（含电池白名单引导/开机自启）+ 重放 + 配对 QR + 审计 + Windows 自启 + relay 代码/部署物就绪（即插位，资源确认后启用） | 家里 LAN：新建任务→实时流→审批→完成全流程；退出 app 后通知仍响（前台服务）；重启电脑后可续接 |
| 全量日用 | codex + opencode 适配器 + zcode 实验性适配器 + 通知偏好/未读/本地过滤搜索 + 12 条异常全部落地 + relay 部署上线（域名/规格就绪后）+ 外网真机验收（补 G2/G3/G7 外端口径） | 三家完整+zcode 实验性；relay 通后 4G 全流程实测 |
| 后置追平 | iOS 链条（Apple 帐号+macOS 构建通道齐备后）；UI 视觉专项（独立设计→定稿→实施→验收）；v1.1 划出项（E2E/FTS/多设备/LAN wss） | 各自单独立项 |

---

## 10. 留给实现者的部分

本设计只决定"做什么、对什么负责、失败怎么办"。以下归实现 plan 决定：具体库版本与依赖清单、SQLite DDL 与迁移脚本、递智级适配器内部解析细节、终端 QR 绘制方式、CI 具体步骤、日志库选型等。

## 11. 开放问题

已收敛（builder check + 项目所有者拍板，2026-10-17）：

- **Q1 通知通道**：大陆网络 FCM 不可达 → v1 无系统推送商；前台服务长连接承载（C10、§5.7）。Firebase 项目相关全部划出。
- **Q2 iOS 链条**：缺 Apple 帐号/构建通道 → Android 领先一拍，iOS 划入后置追平。
- **Q6 云服务器**：现有但域名/规格待确认 → relay 代码/部署物就绪、资源确认后即插启用；外网验收顺延。
- **Q7 UI 专项口径**：先完成功能开发，UI 独立设计定稿后再实施验收；"全量日用"出口=功能完备性。

仍待实现期核实：

- **Q1' zcode 协议能力清单**：用 spike 核实其无头/审批可行能力，据此定实验性适配器的能力清单（保留允许残缺路线只剩能力标注问题，路线已定）。
- Q3/Q4/Q5 已按代决收口（见 §6 后两段）。
