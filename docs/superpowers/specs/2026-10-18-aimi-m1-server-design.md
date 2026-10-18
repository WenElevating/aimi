# aimi M1-S1「服务端完备」设计文档

> 取代 `2026-10-18-aimi-m1-core-loop-design.md`（三端核心闭环版本——按 2026-10-18
> 二次裁决改为按端立项，S2 relay / S3 移动端后续各自立项，原文档保留为三端远景与
> 裁决档案）。本文档只收 **server 份（S1）**，自洽完整；对 v1 设计
> （`2026-10-17-aimi-v1-design.md`）的引用仅补充 M1 具体化，不重复其内容。

---

## 1. 意图与背景（Intent & Why）

v1 里程碑表第二行"核心闭环"的三件套（审批/通知/续接）里，**server 是能力中枢**：
协议接口面、会话生命周期、重放、配对与设备管理、审批事件流转、watchdog、上接 relay
的拨入——全部是 server 侧行为。relay 本体是哑管道（对接 server 拨入），移动端是
纯消费方（对接协议接口）。

因此 M1 的推进结构改为**按端分层**：先逐模块把 server 端写完备（模块清单 = v1 §5.2
定稿架构），relay 与移动端后续立项、只对接本阶段定型的 server 接口面
〔对话裁决 2026-10-18〕。这样耦合最低：后两端不需要回头改 server（除非协议缺陷
实证），S1 出口即接口冻结。

M0 已交付的底子（全部核实过）：协议层 `waiting_approval/waiting_input/stopped` 枚举、
通知分类枚举、ping/pong、bye 帧位、hello.resume 字段位（恒 null）；手机端重连退避；
服务端 resume_hint 列（空置）、claude `--resume` spawn 参数（支持未接通）、
SessionManager adopt 通道、EventBus 三路扇出与洪水控制。S1 的主体是**接线与新行为**，
没有推翻性工作。

无手机、无 relay 本体的阶段，验收依托 M0 已有的测试地基：**假 CLI 回放驱动
（AIMI_FAKE_TURN 模式，e2e 已用）+ 内存内 WebSocket 模拟设备客户端**。

---

## 2. 目标 / 非目标 / 反目标

### 2.1 目标（可验收，均落在 server）

- **G1 协议接口面定型**：帧集扩展完成并冻结——hello.resume 对象放开、配对帧、
  permission.request/question.request 事件与响应帧、bye 理由枚举（taken_over/revoked）、
  AgentState 语义接通；zod 校验与 TS 类型同步；对外接口此后不再破坏性变更。
- **G2 会话生命周期与续接**：打断标 `stopped`（≠failed）；回合门→会话门
  （finished 进程存活开新回合 / 进程死 `--resume` 续接 / 无线索只读）；
  resume_hint 捕获→落库→取用全链；PID 台账与孤儿清理；适配器协议探测不兼容即标灰。
- **G3 缺口重放**：hello.resume 光标补发，同一连接 seq 全序（快照切点→补缺口→
  无缝续实时），吞吐 ≥500 events/s，断连窗口零丢失。
- **G4 配对与设备管理**：`aimi-server pair` 出配对码；`hello{pairingCode}` 配对入队
  （一次即焚、5 min、失败限速）；devices 表真实化（每设备一行）；**revoke 即时断连
  且持久（同步报废 lan-token.txt）**；单设备锁同 token 互踢 `bye{taken_over}`；
  auth.pair/auth.revoke 审计。
- **G5 审批/提问接线**：claude 适配器下发 `permission.request`/`question.request`
  （state→waiting_*），消费响应送达 agent 继续运行；晚到响应→"已失效"显式标注，
  不静默吞；手机提交 permissionMode 越权（白名单外）→ server 拒绝+审计。
- **G6 watchdog**：running 超 10 min（可配）无事件 → `notice{stalled}` 仅提示不改态。
- **G7 relay 拨入就绪**：server→relay 出站拨入（独立 server-token、指数退避重拨）；
  与 wsLan 同帧同抽象（Conveyor），核心层无差别。
- **G8 运维入口齐**：CLI 补齐 `pair / devices / revoke / install / uninstall`；
  Windows 任务计划注册（开机自启+崩溃自动重启）。

### 2.2 非目标（本阶段不做）

- relay 本体 `apps/relay` 与部署物（S2 立项）；
- 移动端一切（Drift 镜像、扫码 UI、审批卡、前台服务/通知、双链路徽标——S3 立项；
  冒烟 UI 缺陷 #3/#4/#5 随 S3）；
- Dart DTO 生成管道（S3 的对接件）；
- mDNS、iOS、codex/opencode/zcode 适配器、E2E、FTS、purge 保留策略执行
  （v1 既定 M1 划出项与全量日用段内容，均不入 S1）；
- 附件（send.files）——顺延为非目标〔对话裁决〕，代码占位文案改"后续里程碑接入"
  （一行顺手修）；
- 通知的 server 侧路由帧（本地派生裁决后 server 不发通知帧，server 份只需事件
  正确落库与广播）。

### 2.3 反目标（出现即算失败）

- 审批请求静默丢失（不呈现也不提示失效——v1 §6 #2 红线）；
- 手机端能升 permissionMode（白名单守卫反向）；
- 同 token 多连接双头写（单设备锁失效）；
- 续接后同一会话出现第二个存活 agent 进程（孤儿复发）；
- 打断/被停止的会话被标为"失败"；
- revoke 后 server 重启设备复活（吊销不持久）；
- 为接入两个客户端（S2/S3）回头破协议格式（接口面破坏性变更）。

---

## 3. 约束（Constraints）

- **架构铁律（v1 §5.2 定稿）**：依赖自上而下 `cli/ → app/ → 接入层(transport/, auth/)
  → 核心层(session/, agents/, events/) → 基础层(persistence/, auditlog/, logging/,
  ops/)`；接入层不认识 agent 适配器；跨模块通信必经事件总线，禁止 peer 互调
  （CI 静态检查既有设施保持）；persistence/ 独占 SQL，事务在仓储接口内成交。
- **表-模块一对一**（v1 §D）：ConversationRepository（sessions+events）、
  DeviceRepository（devices）、CommandDedupRepository（cmd_dedup）、AuditRepository
  （audit）；S1 新增 pairing/pid 台账数据同样走 DeviceRepository / Conversation
  域内接口扩展，不破表所有权。
- 宿主 = Windows 11 开发机；Node 22/TS；测试地基 = vite vitest e2e（假 CLI 回放 +
  内存 ws 客户端模式，M0 既有）；CI（.github/workflows/ci.yml）保持绿。
- relay 资源 = 1 vCPU/2 GB VPS（现有但域名/规格待确认——Q6，影响 S2 不影响 S1；
  S1 的仿测用本机 fake relay 验证）。
- 执行纪律承 M0：plan → subagent 分任务 → 每任务代码代理 + 评审代理 → 台账
  `.superpowers/sdd/progress.md` 记录。

---

## 4. 模块推进顺序（写作单元，非端混合分段）

按依赖排序的 server 工作包（W 序列）。全部属本阶段一个 plan：

| # | 工作包 | 内容 | 依赖 |
|---|---|---|---|
| W0 | **spike：claude CLI 行为核实** | 诊断脚本（不入库）核实四项：① finished/stopped 后同进程第二轮 send 是否成立 ② stopped 判据来源（result subtype？）③ `--resume` 后会话 id 是否稳定/fork ④ 权限请求/提问的 stream-json 消息形态、能否 once/always 映射 | — |
| W1 | **packages/protocol 帧集扩展** | hello.resume 对象放开（zod null→对象）、hello{pairingCode, deviceName} 变体、配对响应帧、permission.request/question.request 事件、permission.response/question.response 命令、bye reason 枚举（taken_over/revoked/expired？）、AgentCommand/AgentState 语义接通；zod 校验与类型测试全量更新 | W0（四项事实定字段） |
| W2 | **session/ 生命周期与续接** | commands 会话门重写（回合门→会话门）、stopped 语义落地、适配器启动握手捕获 claude 会话 id→resume_hint 落库链、`--resume` 取用、PID 台账（persistence 新增承载）+spawn 记录+server 启动孤儿清点、协议探测标灰（不兼容 agent 不可选） | W1 |
| W3 | **events/ 重放扇出 + app 消费** | application 处理 hello.resume 消费（per-connection 补发队列：快照切点→events 表补发→无缝续实时）、缺会话/缺 cursor 全量拉、>10,000/会话超限→"重放过大"通知+列表兜底；e2e 零丢失（seq 对账）+ 吞吐断言 | W1, W2 |
| W4 | **auth/ 配对+设备管理+单设备锁** | 配对码生成（8 位/5min/单次）+ 失败限速、hello{pairingCode} 入口（app/）、DeviceRepository 全接通（真实注册/吊销/逐帧校验）、CLI pair/devices/revoke、lan-token.txt 终态（revoke 同步报废文件+审计）、auth.pair/auth.revoke 审计、同 token 互踢（bye{taken_over}，连接处置归 app/） | W1 |
| W5 | **agents/claude 审批/提问接线** | 控制通道消费权限/提问→permission.request/question.request 下发（waiting_* 流转经 session/）、命令帧消费响应→control_response 写回 CLI、晚到失效标注（会话已非 waiting_*）、创建时权限白名单守卫（手机可选集 {default, plan}）、协议探测随 W2 | W0, W1 |
| W6 | **session/ watchdog stalled** | running 超阈值（默认 10 min、配置可调）无事件 → notice{stalled}，仅提示不改态、任何新事件解除 | W2 |
| W7 | **transport/ws/relayClient（server→relay 拨入）** | Conveyor 的第二实例：出站 WS 拨入、独立 server-token（config 配置持有）、重拨指数退避、与 wsLan 同帧协议；S1 验收用本机 fake relay（测试装置）做全链路 | 无（transport 抽象 M0 已有） |
| W8 | **ops/ CLI 汇总 + Windows 自启** | status 扩展、`install/uninstall`（任务计划注册：隐藏窗口、失败 1min 重启至多 3 次、ONLOGON——v1 §5.2 既定）、tools/windows 脚本 | 无 |
| — | （横切）审计 | auth.* 事件随 W4；revoke/taken_over/pair 失败尝试全部入审计 | W4 |

依赖图：`W0 → W1 → {W2 → W3, W4, W5 → W6}`；W7、W8 无前置（随时可并行插队）。
失败模型：W0 的 any 项不成立时——①不成立→会话门退化为永远 `--resume`（冷启动代价，
行为正确性不变）；②stop 判据改为服务端事实推断（interrupt 完成即 stopped）——两者
均被设计吸收，协议形状仅第四项可能影响权限帧字段，回填 W1 后才冻结。

---

## 5. 组件设计要点（as decided，M1-S1 具体化）

### 5.1 会话生命周期与续接（§C 途中件）

- **打断/停止语义**：interrupt 处理完成 → 回合终态 `stopped`；适配器崩溃/管道断裂
  才是 `failed`。手机侧文案"已停止"（S3 渲染，本阶段只保证状态正确）。
- **回合门→会话门**：`send` 可接受条件从"回合进行中"放宽为"会话可续"：
  1. 进程存活且上回合已终（finished/stopped）→ 同进程开新回合（免冷启动，
     W0-①裁决——若 spike 证伪则兜底走 2）；
  2. 进程亡 → `sessions.resume_hint` spawn `--resume {hint}`（底座已有：
     buildArgs 支持、adopt 通道在）；
  3. 无 hint 且进程亡 → 会话只读（"已过期"，send 被拒）。
- **会话门的三形态**与 v1 §C 对齐：新会话（spec 校验→拉起）、可续接（手机显式续接
  指令才动，防半夜全员复活烧 token——**"续接"是一条显式命令**：对可续会话发"续接"
  命令或 send 即视为续接？→ **send 即续接**〔我的决定：手机端 S3 不再需要单独
  "续接"UI 按钮，会话门在 send 时自动代偿——v1 的"显式指令才动"落实为：
  只有用户发出 send 才触发复活，绝不自动复活。此点已留意 v1 语境，S3 移动端
  若发现需要独立按钮再加，协议不受影响〕）、不可续接（历史可查不可跑）。
- **resume_hint 捕获**：适配器首条 CLI 输出（系统初始化/system 消息）中捕获会话 id
  → ConversationRepository.updateSession 持久化（接口扩一个字段更新，W2 落）；
  `--resume` 后新 id 是否 fork 由 W0-③定——fork 则每次回合结束回写。
- **PID 台账**：spawn 时 {sessionId, pid} 入表（persistence 载体与清点策略细节
  留实现者）；server 正常停机 killTree 全收（修冒烟 no-op 遗留）；启动清点孤儿
  （台账 pid 仍活但无 launch 上下文→killTree+审计）。
- **适配器协议探测**：启动握手（W0-④产物可复用）失败/不兼容 → registry 将该 agent
  标 graying"暂不可用"（看板不可选，故障隔离单 agent——v1 §6 #6 落地）。

### 5.2 缺口重放（§A/§E 途中件）

- hello.resume：`{[sessionId]: lastCursor}`（zod 从 `null` 放开为可选对象——
  旧客户端兼容：null 语义不变）。
- per-connection seq 全序：application 收 hello 后建立"补发快照切点"——
  切点前的已入库缺口按 seq 序逐帧补发，切点后的实时事件由 events/ 扇出保证
  在补发完成后才流入该连接；机制（排队/门闸）留实现者，行为承诺（补发完前
  无实时帧、补发后无洞）属接口语义。
- cursor 缺失会话：welcome 全量列表 + 对未发光标会话**不主动拉历史**
  （全量拉取=收到 resume 显式 cursor 才补发——新建连接不雪崩史）
  〔我的决定，对齐 v1"重放按需"〕；S3 的"下拉拉历史"由新 resume 请求触发
  （同一机制复用）。
- 超限 >10,000 事件/会话：逐帧放弃，发"重放过大"错误通知 + 该会话时间线顶部
  标注（S3 渲染），调低点：列表 welcome 兜底。
- 吞吐断言 ≥500 events/s（e2e，缺口 10k 场景）——§7 预算复读。

### 5.3 配对与设备管理（§B 落地件）

- **`aimi-server pair`**：终端 QR（serverId+LAN 地址+relay 地址+8 位一次性配对码；
  5 min 有效、用一次即焚——v1 §5.4 原文）。码存 pairing 承载（persistence 或内存，
  留实现者）。
- **配对入口**：未持 token 设备以 `hello{pairingCode, deviceName}` 接入（M0 首帧
  必须 token，本帧变体走 auth/ 中枢——先校验码后产出正式设备身份）；成功即发
  配对响应帧（一次性明文 token），此后连接按正式身份走。
- **失败限速**：码校验失败按连接/全局限速（防 8 位爆破），具体留实现者——
  失败尝试全记账。
- **DeviceRepository 真实化**：M0 的 `lan-default` 预留行迁移为真实设备行
  （bootstrap 身份保留）；每设备 id/name/token_sha256/last_seen_at/revoked_at。
- **`aimi-server devices` / `aimi-server revoke <device>`**：列出（名称+最后活跃）
  / 吊销（活连接立即 bye{revoked} 断连；**lan-token 吊销→同步删除 token 文件**，
  重启不复活；审计 auth.revoke）。
- **单设备锁**：同 token 并发连接→后来者生效、先到者 bye{taken_over}；跨 token
  并存不限；双头写由命令限速+审计+events 单线程序列化兜底〔对话裁决〕。

### 5.4 审批与提问接线（§5.1 的对话部分，server 份）

- 消费链：claude CLI stream-json 控制通道（M0 interrupt 已走同路）→ 适配器解析
  权限请求/提问 → `permission.request`{tool, summary, options} /
  `question.request`{prompt, suggestions?} 域事件 → state→waiting_approval/waiting_input
  → 落库广播（events/）。
- 响应链：`permission.response`/`question.response` 命令帧 → session/ 终止 dispatch →
  校验 state==waiting_* → control_response 写回 CLI → agent 继续运行。
- 晚到：state 非 waiting_* → notice"审批已失效/提问已失效"（时间线标注归 S3），
  不静默吞、不代答（v1 Q3 代决）；waiting 态中断收口〔我的决定〕：
  resume 续接后原挂起卡自动转失效（CLI 无重放机制）——显式失效不算静默丢失。
- **白名单守卫**：session.create 的 permissionMode 手机可选集 = {default, plan}
  （协议现状）；越权 → error+审计。中途变更命令帧本阶段不建（Q-M1-2 留档）。
- message 形态一次定型于 W0-④，映射表（统一 decision ↔ 原生响应）按 v1 §5.1
  配单测（"最容易翻车的点"）。

### 5.5 watchdog / events / transport 新增件

- watchdog：阈值默认 10 min（app 配置可调）；**只对 running 态**计时；任何事件
  重置。notice{stalled} 通知分类默认关（S3 手机端启停）。
- events/ 重放扇出：见 §5.2；通知路由规则（v1 §E）随本地派生裁决不再产出通知帧
  ——扇出第三路在 S1 中保留**扩展点占位**（未来 server 侧路由需求回归时不破架构）。
- transport/ws/relayClient：见 §4/W7；拨入身份语义与 §5.3 相同中枢（relay 上设备
  请求由 server 端判——relay 永不当信任判断者，v1 §B 既定）。

### 5.6 CLI 与 Windows 常驻（ops/）

- CLI 全集：`serve / status / lan-token(bootstrap保留) / pair / devices / revoke /
  install / uninstall`（audit 查询 v1 §6 既定 `--last`，M0 已具备）。
- install：任务计划注册（v1 §5.2 Windows 常驻原文：ONLOGON、隐藏窗口、
  失败 1 min 自动重启至多 3 次）；uninstall 对应卸载；工具脚本落 tools/windows/
  ——具体注册机制留实现者。
- `aimi-server status` 扩展：sessions/devices 数、拨入状态（WS/relay 在线与否）。

---

## 6. 异常场景矩阵（S1 份额，承 v1 §6）

| # | 场景 | S1 落地 |
|---|---|---|
| 1 | 数据库打开失败/损坏 | 启动中止+ERROR 日志（承 M0 崩溃韧性已验 WAL 自恢复） |
| 2 | hello 非法/劣化 token | 断连+审计（M0 已有）+ 配对失败限速（W4） |
| 3 | 未知 agent/适配器崩溃 | registry 标灰隔离（W2 探测）；子进程崩溃→failed+审计（M0 已有） |
| 4 | 重放超限/并发插入 | 快照全序+超限通知（W3） |
| 5 | watchdog 触发 | stalled notice，仅提示（W6） |
| 6 | 同 token 并发 | 主从互踢（W4） |
| 7 | revoke 活连接 | 即时断+持久（W4） |
| 8 | 配对码过期/爆破 | 失败限速+审计（W4） |
| 9 | relay 拨入失败 | 指数退避重拨（W7），无 relay 时 LAN 独立可用 |
| 10 | server 进程崩溃 | 重启后：pid 台账孤儿清点+会话回象保留（W2）+install 外壳（W8）；AC-M0-6 已验基座 |

S2/S3 的份额（#11 服务器镜头/外网中断、手机断网等）不在本表。

---

## 7. 性能预算（S1 承载，承 v1 §7）

| 指标 | 预算 | 验证 |
|---|---|---|
| 重放吞吐 | ≥ 500 events/s（缺口 ≤10,000/会话） | e2e 断言 |
| 重洨并发写入 | ≥ 500 events/s（既有吞吐基准不回退） | e2e（M0 T5 基准回归） |
| 审批/打断命令端到端 | ≤ 1 拍心跳（≤15 s）P95 | e2e |
| watchdog 触发精度 | 阈值+30 s 内必触发（不受 CPU 抢占拖死） | e2e（短阈值） |
| relay 拨入重建 | 断开后指数退避内恢复（1s→60s 封顶【施工值】），≤60 s | e2e（fake relay kill/重启） |
| server 72 h 稳定 | 观测项（正式口径归全量日用段） | S1 期间顺带跑 |

心跳/重连/洪水/保序预算继承 M0 e2e 口径（回归不重测）。

---

## 8. S1 验收（模块清单 = 测试面）

按 §2.1 目标逐条（全部 e2e/单测可表达，无真机依赖）：

1. G1 协议：帧集全量 zod 校验更新与 TS 类型一致（旧客户端 resume:null 兼容）；
2. G2 生命周期：打断→stopped；进程活 send 开新回合（或 spike 裁决退化路径）；
   进程死+hint 走 `--resume`；无 hint 只读拒绝；孤儿清点实测（人为杀子进程后重启
   server 验证进程被收）；
3. G3 重放：模拟设备断连窗口产生 N 事件 → 重连后 seq 对账零丢失；
   吞吐 ≥500 events/s；超限→"重放过大"通知路径实测；
4. G4 配对：pair 出码 → 模拟 ws 设备配对成功→ devices 列表含新行 → revoke 即断
   + lan-token 报废重启不复活；同 token 两连接先发 bye{taken_over}；
   码过期/错码限速路径实测；
5. G5 审批：假 CLI 驱动 permission.request→模拟设备 once/always/reject 响应→
   CLI 收到 control_response（假 CLI 断言）→agent 继续；晚到→失效 notice；
   手机提 bypassPermissions→拒+审；
6. G6 watchdog：短阈值（配置注入）实测 notice{stalled} 且不自动打断；
7. G7 relay 拨入：本机 fake relay 接受 server 拨入+帧透传全链路（WS 模拟设备
   经 relay 连 server 走完整流）；
8. G8 运维：CLI 子命令全通；install 注册后手动重启电脑一次验证（用户手动，
   模拟器/真机不依赖）。

---

## 9. 留给实现者的部分

- zod/TS 帧集形状扩展的包内组织与测试拆分粒度；
- PID 台账/pairing 码的持久化载体选型（表 vs 内存表+文件）与 DDL/迁移细节；
- per-connection 补发队列实现（门闸/队列/快照点）；
- 配对失败限速的具体窗口与上限数值；
- watchdog 计时器实现与漂移容差；
- fake relay 测试装置（本机 ws 双端点脚本）形态；
- install 的任务计划 XML/调度参数细节；
- lan-token.txt 报废的文件路径协议与恢复引导；
- registry 标灰的状态承载（内存 vs sessions 表）。

---

## 10. 开放问题

- **Q-S1-1（=旧 Q-M1-1）**：claude CLI 四项行为（W0 spike 输出）→ 结论回填：
  若①不成立，会话门永远 `--resume`；②stop 判据若 CLI 无 normative 信号，由服务端
  interrupt 完成事实判定；③fork 则每回合回写 resume_hint；④决定权限帧字段集——
  W1 冻结前完成。
- **Q-S1-2（=旧 Q-M1-2）**：claude 权限模式集与降序映射——写进适配器常量，
  S1 只用创建时白名单 {default, plan}，表仅留档。
- **Q6' relay 域名/云规格**：S2/S3 的部署验收，不阻塞 S1。
- **Q-S1-3**：`"已过期"`会话在 welcome/list 中是否需要独立徽标字段（resumable/
  expired 二元）——S3 渲染需要，S1 协议面建议 sessions.list 附 `resumable: bool`
  〔我的决定：加，一个 bool 字段成本极低且 S3 必用〕。
