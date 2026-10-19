# aimi M1-S3「移动端」设计文档

> 状态：设计完成（builder check 已回、六问已收口）——待用户批准
> 前置文档：`docs/superpowers/specs/2026-10-18-aimi-m1-core-loop-design.md`（§5.7–§5.13 是本阶段技术基线）、
> `design.md`（UI 原则全文，§5 组件规则 / §7 无障碍 / §3.8 开场约束 / §3.9 起势 shimmer）、
> `prototypes/codex/`（十四屏视觉契约，`assets/tokens.css` 是唯一 token 源）、S1 服务端（已收口）
> 日期：2026-10-19

---

## 1. 意图与背景（Intent & Why）

S1（服务端完备）已全部收口：配对、续接重放、审批闸、单设备锁、watchdog、协议兜底全绿
（server 231 用例 + protocol 18 用例 + Dart 端兼容实证）。手机端目前仍是 M0 冒烟骨架：
LAN 手填直连、内存镜像、无扫码配对、无审批入口、Material 种子色皮肤。

S3 把手机端补成可日用的产品：按 `prototypes/codex` 的视觉契约实现完整闭环——

**扫码配对 → 看板见历史会话 → 新建/续接会话 → 流式时间线+工具卡 → 审批三选一 → 打断**，
断网重连不丢历史、杀 app 后离线可读，Android 前台服务守护 + 本地派生通知。

平台裁决（对话拍板）：**Android 优先**。iOS 出包、平板/桌面形态整体后置。

## 2. 现状盘点（代码事实基线，2026-10-19 核实）

| 现存 | 状态 | S3 处置 |
|---|---|---|
| `AimiConnection`：LAN 单链路、心跳 15s×2、退避 1s→30s+250ms 抖动 | 可用 | 扩展双链路 + resume 光标 + bye 处置 + 配对握手 |
| hello 帧恒不带 resume（缺口不回补）、命令只有 send/interrupt | M0 口径 | 补 resume、approve、answer（对齐 S1 服务端已就绪语义） |
| `frame_dto.dart`（807 行手写镜像，缺 pair 帧对/approve/answer/resume） | 过渡实现 | 手工补齐 + 测试兜底；生成管道后置（§5-7 裁决） |
| `SessionCache` 内存镜像，welcome 全量替换 + seq 严格 `lastSeq+1` | 可用 | 整体演进为 Drift 持久镜像之上的读缓存层 |
| `providers.dart`：endpoints 靠设置页手填 host/port/token | 能用 | 配对流程接管端点来源；手输保留为备用路 |
| `router.dart` 三路由；`theme.dart` 是 Material 种子色 | 骨架 | 重写为 Codex token 体系 + 新路由组 |
| `session_view.dart` 只渲染 10 类事件中 5 类 | 骨架 | 补 permission/question/exit/thinking/usage 的映射 |
| pubspec：riverpod/go_router/web_socket_channel/secure_storage/uuid | — | 新增：Drift、扫码器、本地通知、前台服务等（§8 选型） |

服务端 S1 已就绪、S3 直接消费的面：`hello.resume` 光标补发（两道去重）、
`replay_capped:<sid>:<deviceId>` warn（按设备一次性）、配对帧`HelloPairFrame{pairingCode,deviceName}`→`PairedFrame{token,deviceId}`、
QR payload `{v,serverId,lanUrl,relayUrl?,code}`、审批 `permission{id,title,detail,options:[once,always,reject]}`+
`waiting_approval` 态 + `approve{requestId,decision}`、answer 门（`waiting_input`）、`bye{taken_over|revoked}`、
打断 → `stopped`（`error_during_execution` 不再呈现为"已失败"）、watchdog `notice{stalled}`、
`command.ack`（hello 带 `commandAck:true` 已具备）。

## 3. 目标 / 非目标 / 反目标

### 3.1 目标（可验收，AC 对账表见 §7）

- **G1 配对**：扫码 + 手输双路，连上即入看板；配对码过期有明确呈现；token 只写设备安全存储、UI 与日志零回显。
- **G2 看板与历史**：冷启动本地镜像先渲染 → 连接 → welcome 全量校准 → resume 补齐，过程界面无跳变；杀 app 后离线可读；server 重启场景徽标自愈（AC-M0-6 回归）。
- **G3 会话闭环**：新建（权限档固定 default，见 §5-2）/续接/发送/流式渲染/工具卡含输出摘录（清冒烟 #4）/自动滚底+跟手（清冒烟 #3）/打断后呈现"已停止"而非"已失败"（清冒烟 #1 的手机面）/卡片状态一律读会话 state（清冒烟 #5）。
- **G4 审批**：permission 事件 → 底部 sheet 三键（允许一次 → 总是允许 → 拒绝）→ `approve` 指令；`waiting_approval` 徽态；重连后晚到的审批呈现失效卡而非重复提交。
- **G5 通知与服务**：本地派生分类通知（审批/提问/完成/失败 默认开，停滞 默认关，设置页可启停）；通知 action 批准/拒绝 → 深链直达 → 自动提交 → 通知消除（失效则呈现时效卡）；前台服务杀 app 后监控不断；电池白名单引导页；BOOT_COMPLETED 自启恢复；开机自启开关（默认开）。
- **G6 双链路**：持有 LAN+relay 双地址，断连先试 LAN、3s 不通切 relay；徽标四态 LAN/中继/离线/重连中；S2 缺席时以 fake relay 做单测级/e2e 级验证。
- **G7 视觉对等**：核心屏（welcome/配对×2/看板/会话/设置）明暗两套对照 prototypes 截图评审；对比度 ≥4.5:1、触控热区 ≥44pt、reduced-motion 降级过 `design.md` §7。
- **G8 开场**：「光尘妆定」（opening.html v1）复刻，≤3s 不阻塞路由，reduced-motion 单帧定格。

### 3.2 非目标

- iOS / 桌面 / 平板 / 横屏布局（Android 竖屏 390×844 基准，横屏不做专门适配）。
- relay 本体与部署物（S2）——S3 只做手机侧双链路 plumbing，relay 以桩代验。
- 服务端改动（S1 冻结面之外零改动；发现缺陷单独立项走修复流程）。
- FCM 等第三方推送通道（"本地派生、不经第三方"为既定裁决）。
- 模型选择 UI（model.html 不进 S3）与权限三态 picker（协议手机白名单只有 default/plan，§5-2）。
- 附件发送 UI；提问通道的 claude 适配（S1 FACT5——question 帧只做兼容渲染，claude 不会触发）。
- 协议 Dart 生成管道（core-loop §5.12）独立小阶段后置，裁决见 §5-7。
- 多语言 i18n / 主题设置页（文案简体中文；明暗跟随系统，无切换入口）。
- 会话内附件/图片渲染、usage 面板复杂化（usage 仅注入元信息行）。

### 3.3 反目标（出现即算失败）

- 看板/列表页出现输入框；发送与打断并排两颗主按钮；UI 用文字复述"运行中/已连接"。
- 出现第二套装饰色、霓虹、渐变；mono 字体用于界面文字或 sans 用于机器输出。
- token / 配对码在界面、日志、快照中回显；令牌明文落普通存储。
- 手机镜像变成第二真相源：任何列表与状态以本地推断覆盖服务端 welcome/事件流。
- 通知内容经由服务器或手机本地以外的第三方合成。
- 杀 app 后告警通知丢失（前台服务职责失守），或前台服务导致 UI 必须手动刷新才更新。
- 流式长回合滚动掉帧到肉眼卡顿；重放 10k 事件把手机卡死（虚拟化/懒加载必须兜住）。

## 4. 对话拍板记录

| 决策 | 出处 |
|---|---|
| 先做 S3，relay（S2）后置 | 用户 2026-10-19「先做S3吧」 |
| 平台 Android 优先 | 用户「android」 |
| 验收 = 完整闭环 workflow（§3.1 各条由此倒推） | 用户 2026-10-19 |
| 视觉契约 = `prototypes/codex` 定妆 + `design.md` 原则 | 用户「原型已经写好了」 |
| 开场动画 = 光尘定妆（opening.html v1，2.8s 固定种子） | 用户「开场动画先用光尘定妆」 |
| 通知 = 本地派生、零协议改动 | core-loop §5.7 对话裁决（2026-10-18），承袭 |
| 模型屏只展示不选择（协议冻结） | S3 立项默认裁决，今日未见否决，保持 |

## 5. 已决定裁决（主会话，review 前可推翻）

以下是我基于协议事实与 design.md 的裁决，builder check 会复核，用户可在批准时推翻任何一条：

1. **模型 chip 只读**：composer 的模型 chip 只展示当前会话的 agent/模型标签，点击不弹选择。
   `model.html` 不进 S3。理由：协议侧 session.create 的 model 是入参而非可枚举清单，无查询帧；
   扩协议违背 S1 冻结。
2. **权限入口只读，不做三态 picker**：Codex 三态（每次询问/自动编辑/完全放行）中后两档对应
   acceptEdits/bypassPermissions，手机白名单不可达（`PhonePermissionMode = {default, plan}`）。
   S3 的 composer 权限图标只读展示当前会话档位：`default` → 锁（每次询问）、`plan` → 计划字形
   （偏离 design.md 三态的既定映射，文档化在 UI 层注释）；新建会话页不放权限行（design.md §8
   明确要求），提交值固定 `default`。三态 picker 后置到协议支持提权档位之后的阶段。
3. **待发消息 = 本地排队**：离线时发送的消息暂存待发胶囊（时钟图标 + 垃圾桶可撤），
   重连自动补发——`clientId` 幂等去重（服务端已实证）保证补发不重复执行；
   建会话不排队（沿 M0"离线建会话不补发"口径）。发送中在途态由同一颗胶囊承继展示。
4. **深链冷启动跳过开场**：从通知拉起直达会话时不播开场动画（任务场景不拦截）；
   常规冷启动且首个路由为看板时播放一次（进程生命周期内只一次）。
5. **待发胶囊/失效卡/深链**的 wordings 以 prototypes 为准；文案一律简体中文。
6. **thinking/usage 呈现口径**：thinking 折叠行（可展开的斜体弱化文本行，默认收起）；
   usage 进会话页底部元信息行（tokens + cost），不做成独立卡片流。
7. **生成管道后置**：S3 继续手改 `frame_dto.dart` + 双端逐字对齐测试兜底；
   zod→Dart 生成管道与 CI 漂移检查是独立基础设施小阶段，不混入 UI 阶段拖长反馈环。
8. **会话标题（本地展示派生）**：协议无标题字段（冻结），标题 = 首条用户消息前若干字符，
   缺省回落 `cwd` 基名；时间线用户气泡 = 本地发件记录（见 §8），均为纯展示派生，
   不改镜像权威，与服务端 welcome/事件流冲突时以服务端为准。
9. **深链呈现**：通知深链 cold-start 只进会话页，跳过开场与看板直达；失效审批在会话页
   以时效卡呈现后，不再重复提交（沿用原 clientId，服务端幂等驳回）。

以下是 builder check（2026-10-19）提出、经代码事实核实后收口的六条裁决（协议零改动为前提）：

10. **前台服务 = 单进程 + 后台 isolate**：不拆独立进程。后台（前台服务）isolate 持有 WS 连接、
    事件流与通知合成；UI 不直连 socket，一切帧经插件消息流转；Drift 单写方在后台 isolate，
    UI 走查询口读快照。理由：双进程要跨进程 IPC + 镜像双写方，且同 token 双连接会触发服务端
    单设备锁互踢（`bye{taken_over}` 乒乓）。app 被杀 = Activity 销毁，FGS（START_STICKY +
    `onTaskRemoved` 重拉）承载监控；厂商清杀靠电池白名单引导兜底。FGS type 取 `specialUse`
    （本应用为本地侧载、不进商店；Android 15 的 `dataSync` 有 6 小时硬上限，不适配 24h 守护）。
11. **手机↔relay 契约（S2 接口纸面，fake relay 即照此实现）**：QR 的 `relayUrl` =
    `cfg.relay.url` = 服务器拨入端 `wss://<relay>/serve`。手机不得拨 `/serve`（那是 server-token
    拨入口）；手机设备端地址 = `relayUrl` 改路径为 `wss://<relay>/device?serverId=<serverId>`。
    升级后帧流即标准 v1 协议帧，鉴权一律在服务端（设备 token / 配对码）落地，relay 全程哑管道
    不解析业务帧；配对帧同样可经此通道。S2 落地时必须按此契约实现 `/device` 入口。
12. **LAN 自签证书 = 应用层 TOFU**（服务端已强制非 loopback 必须 wss，无法回避）：
    首次连接时提取服务器证书 SHA-256 指纹，静默存入 secure_storage（"信任首用"），
    后续连接按指纹 pin（系统信任的证书不受影响）；指纹变化（服务器重装证书/疑似中间人）→
    连接拒绝并在设置页呈现"重置信任"入口。不扩 QR payload、不改协议（指纹随 QR 下发留待
    独立协议小步时再议）。真机验收同时保留两条零成本路径：模拟器/USB 用 `adb reverse`
    映射 8787 走 loopback 明文 ws。
13. **审批与工具卡的内容映射**：`permission.detail` = 工具入参 JSON 串。command well 的 mono
    命令文本：取 JSON 中命令类键（Bash→`command`；Write/Edit 类→`file_path` 优先展示）；JSON
    解析失败或未知工具 → 按 2 空格缩进排版原始 JSON 展示。工具卡路径/摘要一律取服务端已归一的
    `summary`，不在手机端再做入参猜测；工具输出区渲染 `tool_result.outputExcerpt`（monospace
    可换行、超长折叠，映射表做成 domain 层常量）。
14. **续接 = 发送即续接，无续接按钮**（design.md 禁止会话行内按钮；S1 已实证僵句柄 send 自动续接）。
    会话 `resumable=false` 且处于终止态时 composer 收起，呈现为只读存档态；可续接会话 composer
    常驻。`hello.resume` 光标与 `resumable` 字段照 S1 语义消费（builder 实现前先核对 S1 判定源）。

## 6. 界面与组件契约（承 prototypes/codex + design.md §5）

每屏必须对照 `prototypes/codex/screens/*.html`（含明暗两态与 `?state=` 变体）实现；
`design.md` §5/§6/§7 的"必须/禁止"两列与无障碍底线是硬规则，不再在本文重复。
差异处只有 §5 的裁决条目。屏幕清单与关键行为：

| 屏 | 原型 | S3 关键行为 |
|---|---|---|
| 开场 | `opening.html?v=1` | 光尘妆定：黑场 + 光晕 + 散点上升 + 字标 tracking，2.8s + 淡出；固定种子；reduced-motion 单帧；仅常规冷启动播（§5-4） |
| welcome（未连接） | `welcome.html` | 一句状态 + 「扫码配对」主按钮 + 「手动配对」低调备选；右上角设置；不含会话列表/说明段落 |
| 配对·扫码 | `pairing-scan.html` | 取景框扫码 → 解析 QR payload `{v,serverId,lanUrl,relayUrl?,code}` → 发 pair 握手 → 连上即结束进看板；`pairing_expired` 呈现过期态并可重试；禁止扫描线/循环动画/完成按钮/token 回显 |
| 配对·手动 | `pairing-manual.html` | 地址（LAN/WS 地址或主机+端口）+ 8 位配对码 + 一个「连接」；成功落看板；过期态同上 |
| 看板 dashboard | `dashboard.html`（?state=empty/takenover/revoked） | 会话行 = 状态图标 + 标题 + 时间，整行可点；「需要你」琥珀卡直达审批；taken_over/revoked 呈现对应叙事；empty 态给一句引导；无 composer |
| 会话 session | `session.html`（?state=waiting/approval/invalid/stalled/failed/offline/reconnecting） | 三层表面（画布/用户气泡/inset 输入 well）；用户气泡数据源 = 本地发件记录（§5-8）；agent 文本流式追加；mono 只给机器声；工具卡（Bash/Edit/Write 等：图标 + 名称 + mono 路径 + 摘录——清冒烟 #4）；自动滚底 + 上翻停跟 + 回底恢复（清冒烟 #3）；notice 只出错误条不染卡（清冒烟 #5）；待发胶囊；失效卡；stalled 呈现警示条；重连中横幅（承接 M0 既有 UX） |
| composer | `session.html` 内嵌 | 外框卡 + 内框输入 well + 工具行；单一主 pill：发送 ↔ 打断随状态切换；模型 chip 只读；权限图标只读；禁止 spinner+文案堆叠（发送后至首 token 用 Text Shimmer 起势，design.md §3.9） |
| 审批 sheet | `approval.html` | 底部 sheet：标题 + command well（Bash 头 + mono 命令 + 复制）+ 三文字键「允许一次 → 总是允许 → 拒绝」；无项目名/workdir/倒计时/解释 |
| 提问 sheet | —（与审批同构） | 标题 + 一句问题 + 整宽答案键（推荐在前）；claude 会话不触发（协议兼容渲染） |
| 新建会话 | `new-session.html` | 行 = 跑什么（agent，固定 claude）/ 在哪跑（cwd，服务端校验存在）/ 交给谁；无模型行无权限行；提交 spec{agentId:'claude', cwd, permissionMode:'default'} |
| 设置 | `settings.html` | 行 = 服务器（serverId 短码 + 连接徽标 + welcome.serverVersion——协议无显示名/agent 可用性帧，不发明）、本机设备名（配对时的 deviceName）、通知分类启停（五类，§7.2）、开机自启开关（无单独"关闭前台服务"开关，守护即存在意义）、电池白名单引导入口、证书信任重置入口（§5-12）、版本行；无扫码/手动地址入口（design.md §8）；无 token 显示 |
| 深链 | — | 通知/深链 → `/session/:id` 补齐缺口后直达；失效审批呈现时效卡 |

## 7. 前台服务与通知（承 core-loop §5.7/§5.8，Android）

### 7.1 前台服务

- **进程模型见 §5-10（单进程 + 后台 isolate，specialUse type，连接/通知/Drift 写方全在服务隔离）**；
  常驻通知明示"aimi 在守护运行"，点击直达看板。
- app 进程被杀/回收 → 服务与通知存活，监控职责不变；服务被系统杀 → 无告警兜底属于可接受衰减
  （电池白名单引导缓解），重启 app 或开机自启即恢复。
- 连接状态机承 M0：退避 1s→30s 封顶 + 250ms 抖动、心跳 15s×2 拍 ≤45s 检出；徽标与前台服务共用同一状态。
  实现路线（插件 or Kotlin 通道）属 §10 留给 builder；验收以"杀 app 后审批通知仍响"为准。

### 7.2 通知分类（本地派生，零协议改动）

| 分类 | 触发事件 | 默认 | 内容锚点 |
|---|---|---|---|
| 审批 | permission 事件 + `waiting_approval` 态 | 开 | 会话标题 + 一句摘要；action：批准/拒绝 |
| 提问 | question 事件 + `waiting_input` 态 | 开 | 同上（点入回答，通知不带 action） |
| 完成 | `finished` 态事件 | 开 | 会话标题 + "已完成" |
| 失败 | `failed` 态事件 | 开 | 会话标题 + "已失败" |
| 停滞 | notice{stalled} | 关 | 会话标题 + 警示文案 |
| 常驻 | 前台服务通知（静默，独立 channel，不可关闭） | — | 点击直达看板 |

- 前台同会话可见时不重复发通知（进程内去抖）；通知点击/action → 深链 → 自动提交 → 消除；
  深链晚到且审批已失效 → 会话页呈现时效卡，不重复提交（服务端幂等兜底 + 客户端沿用原 clientId）。
- Android 13+ POST_NOTIFICATIONS 运行时权限在首次进入设置页时申请（配对成功后）；
  通知渠道按上表分 channel 建。

### 7.3 自启与电池

- `BOOT_COMPLETED` receiver → 恢复前台服务（仅配置过端点/token 的设备）；"开机自启"开关默认开，偏好本地存储。
- 电池白名单引导页：跳转系统电池优化白名单 + Top 4 厂商（小米/华为/OPPO/vivo）后台管控说明 + 通用提示。
  覆盖面可按真机清单增删（core-loop §5.7 同路径）。

## 8. 技术结构（组合面，细节留给 builder）

- **协议镜像**：`frame_dto.dart` 手工补 pair 帧对、approve/answer 命令、hello resume 光标载荷、
  welcome 会话的 `resumable` 可选字段；同时补齐 `pairing_expired` 等 error code 白名单字面量；
  解析策略维持"宽松接收、严格校验、半帧即弃"。
- **连接层**：`AimiConnection` → 握手的 resume 载荷从镜像读取；bye 处置（taken_over → 看板接管叙事、
  revoked → 回 welcome 页并清 token）；双端点（LAN + relay）迁移：断连重试先 LAN，3s 不通切 relay，
  双向迁移；徽标四态映射；TOFU 指纹校验挂通道工厂（§5-12）。
- **后台 isolate**（§5-10）：连接与通知合成的所有权在服务 isolate；Drift 单写方 + UI 只读查询口；
  平台通道仅在 Android 启用，桌面/测试环境全部静默降级不注册。
- **本地镜像**：Drift 库三张表——sessions（元数据 + 每会话 lastSeq）、events（(sessionId, seq) 主键 + ts + payload JSON）、
  sentMessages（clientId 主键 + sessionId + ts + text，供用户气泡与标题派生；纯本地，不参与服务端对账）；
  冷启动顺序 = Drift 读 → 渲染 → 连接 → welcome 校准 → resume 补发；仓库接口签名保持
  `SessionCache` 同形（M0 内存实现退役为其上的读缓存层）；配对成功/吊销时的清库口径留给 builder。
- **配对**：`mobile_scanner`（或 builder 选型）扫码 → 解析 → 保存端点与 token（secure_storage 键沿用现有四键 + 新增 serverId/relayUrl/TOFU 指纹）→ 连接。
- **UI**：`assets/` 引入 `tokens.css` 对应的 Design tokens 常量表（明暗两套）；字体：UI 用系统字体栈
  （PingFang/微软雅黑中文回退），mono 用打包的 JetBrains Mono（OFL 许可）——打包与否留给 builder 权衡体积。
- **路由**：新增 `/welcome`、`/pairing/scan`、`/pairing/manual`、`/new-session`；深链直达 `/session/:id`；
  cold-start 路由判定开场跳过（§5-4）。
- **测试策略**：data 层（镜像/重放/配对/审批/双链路迁移）单测；widget 测试覆盖关键屏 state 变体；
  fake relay = 测试内起内存 WS server 演迁移；前台服务/通知 action/自启 = 模拟器 + 真机人工清册（§12）。

## 9. 性能与预算（承 core-loop §7 手机相关行）

| 指标 | 预算 | 验证方式 |
|---|---|---|
| 通知延迟 | ≤10s P95 | 真机观测（前台服务存活态） |
| 重连检出 | ≤45s | 单测（心跳两拍已具备）回归 |
| LAN→relay 迁移 | ≤3s | fake relay e2e 断言 |
| resume 补发万级事件 | 万级事件补发不卡 UI | Drift 批量写入 + 渐进渲染，单测加压 |
| 开场时长 | ≤3s（含淡出） | 目测 + 单测帧数预算 |
| 流式滚动 | 不掉帧到肉眼卡顿 | 模拟器/真机人工清单（虚拟列表选型自评） |
| 打断命令端到端 | ≤1 拍心跳 P95 | 已有服务端 e2e，手机面人工清册 |

## 10. 留给 builder 的部分

- 扫码包选型（备选 mobile_scanner，注意维护度与 Android 权限面）、Drift 版本与迁移纪律、
  flutter_local_notifications 与 POST_NOTIFICATIONS 的版本矩阵、前台服务插件路线
  （`flutter_background_service` vs 自写 Kotlin 通道——以"杀 app 通知仍响 + 稳定重连"为验收尺）、
  mono 字体打包与否、时间线虚拟列表沿用或重写、通知去抖窗口参数、
  深链 scheme/netfilter 细节（自定义 scheme 即可，不劫持 http 域）。
- 组件细节（卡片圆角内归宿、chip 内边距、sheet 高度）：一律以 prototypes + tokens.css 为准，
  不发明新材质。
- 开场壁纸参数（粒子数、时长、缓动、颜色、字标 tracking）一律照抄 `opening.html?v=1` 源码与
  design.md §3.8 四条硬约束，不凭感觉重调；Drift 的 build_runner 生成物随源提交，CI 不加生成步骤。

## 11. 验收对账（AC ← 闭环剧本/冒烟缺陷）

| AC | 内容 | 来源 |
|---|---|---|
| AC-S3-1 | 扫码配对成功进看板；手动配对成功；配对码过期呈现。真机口径 = wss + TOFU（§5-12）；模拟器口径 = adb reverse 走 loopback 明文 ws | G1 |
| AC-S3-2 | 杀 app 后冷启动：镜像先渲、离线可读、重连补齐无跳变 | G2（core-loop §5.13） |
| AC-S3-3 | 新建会话→发送→流式→工具卡摘录 显示 | G3 / 冒烟#4 |
| AC-S3-4 | 长回合自动滚底、上翻停跟、回底恢复 | G3 / 冒烟#3 |
| AC-S3-5 | 打断后呈现"已停止"；会话卡状态一律读会话 state | G3 / 冒烟#1#5 |
| AC-S3-6 | 审批：权限事件→sheet 三键→approve→解除等待；重复下发幂等 | G4 |
| AC-S3-7 | 重连后晚到的审批：失效卡；通知深链直达自动提交 | G4/G5 |
| AC-S3-8 | 前台服务：杀 app 审批通知仍响；分类开关生效；常驻通知在 | G5 |
| AC-S3-9 | 双链路：LAN 断 3s 切 relay 徽标"中继"；fake relay 用例 | G6 |
| AC-S3-10 | 明暗两屏对照 prototypes 评审通过；无障碍底线项过 | G7 |
| AC-S3-11 | 开场光尘 ≤3s、reduced-motion 单帧、不阻塞路由 | G8 |
| AC-S3-12 | 冒烟回归：MuMu 8 项清单重跑过；#1/#3/#4/#5 手机面闭环 | 回归 |
| AC-S3-13 | 闸门（check-deps / pnpm typecheck / pnpm -r test）+ 移动端（flutter analyze / flutter test）全绿 | 通用 |

## 12. 真机/模拟器清册（移交用户的第 1 面）

通知延迟 <10s 实测、电池白名单四厂商、开机自启（重启一次）、前台服务跑 24h 存活观测、
MuMu 冒烟 8 项回归（含 #6 断网自愈口径）。

## 13. 开放问题

- builder check 六问已于 2026-10-19 全部收口为 §5-10～§5-14 裁决（进程模型 / relay 契约纸面 /
  TOFU 信任 / 内容映射 / 续接口径 / 设置行数据源），无未答项。
- 遗留给实现期的核查点：`resumable` 的服务端判定语义（实现前核对 S1 源码）；`specialUse`
  通道描述文案与 Android 各版本 FGS 行为的实机差异；厂家清杀策略清单按 §12 真机结果增删。
