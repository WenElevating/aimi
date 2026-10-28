# 服务端架构说明

> 事实来源：`apps/server/src` 代码与既有测试（2026-10-28 校对）。本文描述"现状"，新增机制时增量更新；不确定处标 `TODO: 待确认`。

## 1. 进程与组合根

服务端是单 Node 进程、单事件循环、异步 I/O。`apps/server/src/app/Application` 是唯一组合根：

- 启动装配顺序：SQLite 仓储（`openMigrated` 迁移到最新 `user_version`）→ 鉴权/配对 → agent 注册表（含协议探测失败标灰）→ 事件总线（EventBus）→ `SessionManager` → 传输层（LAN WS / relay 出站客户端）。关闭按逆序释放。
- 同一监听端口的非升级 HTTP 经 `onRequest` 单槽分发：`POST /feedback` 归反馈通道（`app/feedbackChannel.ts`，meta.json 原子写 tmp+rename），`GET /updates/*` 与 `POST /internal/updates/refresh` 归更新发布面。
- `aimi-server` 的 `start/status/lan-token/pair/devices/revoke/publish-apk/feedback/install/uninstall` 子命令是独立 CLI 进程，通过 SQLite 与运行中服务共享状态。

## 2. 帧编排（v:1）

`transport/ws` 只负责接入（LAN WebSocket、relay 出站连接）与原始帧搬运；业务帧由 `Application` 解析后分派：

| 帧 | 方向 | 说明 |
| --- | --- | --- |
| `hello`（token/pair 变体） | C→S | 鉴权 + `resume` 重放光标 + 能力协商（`commandAck`、`capabilities.permissionModes`、`dynamicPermissions`） |
| `welcome` | S→C | 全量会话快照（`resumable` 必填，由 resume_hint 派生）+ agents 能力投影 + `features`（`directoryBrowsing`/`sessionFork`）+ update.info |
| `session.create` / `session.fork` | C→S | 建会话 / 分叉（fork = 以源会话 resume_hint 走 SDK `forkSession` 新开）；成功回 `ack`（sessionId） |
| `session.command` | C→S | `send/interrupt/approve/answer/configure/stop/restart`；`clientId` 幂等（PhoneCommandPipe），回 `command.ack`（delivered/duplicate/rejected） |
| `directory.list` | C→S | 目录浏览（能力协商开启；显式错误码 offline/timeout/io_error/…） |
| `update.check` | C→S | 回当前缓存的发布清单 |
| `session.event` | S→C | 事件总线扇出；`seq` 单调，断线按 hello.resume 光标续传 |

入站限制：单帧 8 MiB、握手缓冲上限、每连接速率限制；慢消费者超 OutboundBuffer 上限断开，靠重连重放恢复。

## 3. 会话生命周期（SessionManager）

- 状态机：`starting → running → waiting_approval / waiting_input → finished / failed / stopped`；状态白名单在 emit 包装层校验，非法跃迁降级为 `notice` 事件。
- 三态登记：`new`（全新拉起）/ `resumable`（有续接线索，send 续接可跑）/ `archived`（无线索，历史可查不可续跑，resume 拒绝）。启动恢复经 `adopt(meta, resumeHint?)` 逐会话认领并播种 seq 计数器。
- **会话门三路（send 语义）**：活句柄原路交付（终态开新回合先发服务端事实 `starting`）；死句柄 + resumable + hint → send 即续接（`--resume`）；archived → `"expired"`；未知会话 → `"inactive"`。
- start 失败自动落 `failed` 并清理句柄；`stop` 幂等；`restart` 重挂。agent 子进程由 SDK 拉起，pid 不可得——进程台账（`session_processes`）降级登记续接线索，孤儿回收靠 resume 语义 + processReaper 清点滞留行。
- 分叉（`fork`）：取源会话 spec + resume_hint（仓储为准、内存兜底）走与 `new` 共用的拉起路径，适配器带 `fork: true` → SDK `forkSession` 产出新 CLI 会话 id；源会话不动，新会话事件流从分叉点开始（不复制历史）。无 hint 抛 `session.fork.no_hint`。
- 看门狗：`watchdogMs`（默认 600_000 = 10min，可配）只做停滞观测，发 stalled notice；claude init 看门狗在首条 user 帧后才启动（configure 触发的 restart 不写 user 帧）。

## 4. 事件与持久化

- `EventBus` 是事件序号与发布顺序的权威：持久化订阅写 SQLite，`UiFanout` 推给已鉴权连接，洪水控制做 delta 合并窗口（25ms）与单事件 8192 字符截断（追加 `…(truncated)`）。
- SQLite（better-sqlite3）：`schema.sql` 为准，`user_version` 递增迁移（当前 v11 级，见 `persistence/sqlite/migrate.ts`）；会话、事件、设备、配对码、进程台账、反馈（文件面）、发布清单分仓储。
- 配置：`app/config.ts` Zod strict 校验，键集 `port/host/tls/dataDir/logDir/logLevel/watchdogMs/relay{url,serverToken}`；未知键报错。**非 loopback host 必须配 `tls.certFile/keyFile`**（服务端原生 WSS）。

## 5. 依赖方向（tools/check-deps.mjs 强制）

`transport` 不反向依赖 `session/agents/events/app`；`persistence` 不依赖业务/传输层；`packages/protocol` 不相对导入 `apps/**`。协议改动必须同步 `apps/mobile/lib/data/protocol/frame_dto.dart` 两侧并跑协议 schema 测试。
