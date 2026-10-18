# aimi M1-S1「服务端完备」实施计划

> 设计基线：`docs/superpowers/specs/2026-10-18-aimi-m1-core-loop-design.md`——本计划范围 = 其
> §4 阶段表的 **S1 段（服务端完备）**；v1 设计（`2026-10-17-aimi-v1-design.md`）为总架构。
> 本仓库是三端一体（server / relay / mobile）的系统：本阶段只推进 server 的 9 个模块，
> 但协议与接口按"后两端只对接不改"的口径定型（见 review 重点第 7 条）。
>
> 执行框架：与 M0 相同——subagent-driven（每任务 = 实现代理 + 评审代理），台账
> `.superpowers/sdd/progress.md` 逐任务追加。执行可选 worktree 隔离
> （superpowers:using-git-worktrees），默认主干分支推进（沿 M0 惯例）。

---

## 0. 出口判据（S1 完成时必须全成立）

- v1 §5.2 模块清单在 server 侧全数落地（协议帧集扩展 / 生命周期续接 / 缺口重放 /
  配对设备管理单设备锁 / 审批提问接线 / watchdog / relay 出站拨入 / CLI 子命令 / Windows install）；
- `pnpm typecheck` + `pnpm -r test` + `node tools/check-deps.mjs` 全绿（CI windows-latest 口径）；
- 本计划各任务《验收》步骤勾完；M0 既有测试（含 `__tests__/e2e_lan_stream.test.ts` 五用例）零回归；
- Q-M1-1 spike 四项结论回填 core-loop §9（docs 提交）；
- 不做：relay 本体 `apps/relay`、移动端任何改动（冒烟 UI #3/#4/#5 归 S3）。

## 1. 全局约束（执行代理逐字遵守）

### 1.1 架构与编码规范（v1 §5.2 / §8 同源，检查器 `tools/check-deps.mjs`）

- 依赖方向自上而下：`bin/ → app/ → 接入层(transport/, auth/) → 核心层(session/, agents/, events/) → 基础层(persistence/, auditlog, logging/, ops/)`。低层不得 import 高层；services 不 peer 互调。
- `packages/protocol` 是协议单一源：帧类型只在这里声明，apps/* 不得私有 fork；zod 校验与 TS 接口同步改（两者都是契约）。
- `persistence/` 独占 SQL；事务边界封闭在仓储接口内；`schema.sql` **只追加**（禁 DROP/改列/改已有表语义——§D 规则 4）。
- 命名 = 业务实体名（`PairingService`、`ReplayGate`、`RelayClient`、`ProcessLedgerRepository`……），禁 `Helper/Util/Manager2/tmpX`；常量命名并写 why 注释，不裸魔数。
- 导出 API 100% TSDoc；注释答 why 不复述 what；**沿用仓内注释段式**：中文 JSDoc + `@param/@returns/@throws/副作用` 段（照 `session/sessionManager.ts`、`events/eventBus.ts` 现有风格抄格式）。
- Conventional Commits + scope：`feat(server): …` / `feat(protocol): …` / `test(server): …` / `fix(server): …` / `refactor(server): …` / `docs(m1): …`；每个测试段绿一次就提交，不攒大提交。
- **中文提交说明一律 `git commit -F <utf8 文件>`**（Windows 控制台编码陷阱，M0 惯例）。

### 1.2 测试规范

- TDD 步进：先写红测试（断言本任务的精确契约值），再实现转绿；禁"写完再补测试"。
- 全量闸门在每个任务收尾跑：`pnpm typecheck && pnpm -r test`（注意是 `-r`，根 `pnpm test` 只跑 server 包）。
- e2e 沿用 M0 地基形态（先读 `apps/server/__tests__/e2e_lan_stream.test.ts` 再写）：
  - 假 CLI 经 PATH 注入 `claude.cmd` 垫片 + `AIMI_FAKE_TURN/AIMI_FAKE_INTERVAL_MS` 环境变量回放；
  - 临时目录清理用既有的 `removeDir`（Windows EBUSY/EPERM 重试模板）；
  - 内存 ws 客户端用 `ws.WebSocket` 直连 `ws://127.0.0.1:<port>`（Application `port:0`）。
- Windows grep 注意：grep `claude` 时注意进程树杀（`taskkill /T /F`）语义，见 `agents/claude/claudeSession.ts` L25 `killTree`——新增性能清理复用它，不自造终止方式。

### 1.3 移动端/relay 禁区

- `apps/mobile/**` 与未来的 `apps/relay/**`（本阶段不存在）一律不碰；
- 协议改动只允许"加帧/加字段/放宽校验"，不允许删改既有帧语义（M0 客户端 `resume:null` 兼容是硬约束）。

## 2. 现状接口速查（实现者照抄的名字，均已实地核对）

| 事实 | 位置 |
|---|---|
| `Application`：`start(): Promise<{port}>`、`close()`；帧编排全在 `#onFrame/#completeHello/#dispatch/#handleCreate/#handleCommand` | `apps/server/src/app/application.ts` |
| `hello` 鉴权：`DefaultAuthenticator.verifyToken(token, remote)` → `DeviceIdentity{deviceId,name}` | `auth/authenticator.ts` |
| `SessionManager.create(spec, kind, resumeHint?)`；`adopt(meta)`（恢复态一律 archived）；`resume/stop/restart/send`；`send` 返回 `Promise<boolean>`（false→notice "session not active"） | `session/sessionManager.ts` |
| 命令门：`PhoneCommandPipe.handle(frame, identity)`——幂等→审计→stop/restart 分流→`sessions.send` | `session/commands.ts` L50-74 |
| 状态白名单 `TRANSITIONS`（终态 finished/failed/stopped 出度 0）；`starting/stopped` 为服务端事实、不经白名单 | `session/sessionMachine.ts` |
| seq 唯一权威在 `EventBus`（`publish(sessionId, event, opts?)`；`seedSession`；`flush()`）；洪水控制在发布入口（窗口 100ms 合并、8KB 截断） | `events/eventBus.ts` |
| `UiFanout`＝ui 路单槽消费者：`attach(conveyor)/detach/attachedCount()`；全量广播 `session.event` 帧 | `events/uiFanout.ts` |
| Claude 适配器：`ClaudeSession`（`buildArgs` 含 `--resume`；`getResumeHint()` 已捕获 `system/init.session_id`；`send` 中 approve/answer 仅占位 notice；附件占位文案 L186）；协议归一化 `claudeProtocol.parseLine`（`result` 行非 success → `notice:error` + `failed`，**这是冒烟 F3 打断标 failed 的机制现场**） | `agents/claude/*` |
| 传输抽象 `Conveyor`（open/send/onFrame/onClose/close/state；即发即忘、静默丢弃）；`LanWsServer` → `createServerSideConveyor(socket, remote)` | `transport/*` |
| 仓储四件（Conversation/Device/CommandDedup/Audit）；`updateSession(id, {state?, lastSeq?})`；`DeviceRepository.put/findByTokenHash/revoke/list`；审计 `AuditWriter.auth("pair"|"revoke"|"auth_fail", detail)`、`command/duplicate/sessionCreate` | `persistence/types.ts`、`audit/auditWriter.ts` |
| 配置：`ServerConfig{port,dataDir,logDir,logLevel,serverVersion}`（yaml zod strict）；CLI 三子命令 `start/status/lan-token`；`healthSnapshot` 只读不开进程 | `app/config.ts`、`bin/aimi-server.ts`、`ops/health.ts` |
| `ConfigProvisioner.ensureLanToken()`（lan-token.txt 与 lan-default 设备行幂等供给）；schema.sql 含 `meta_kv/sessions.resume_hint(空置)/events/devices/cmd_dedup/audit` | `auth/configProvisioner.ts`、`persistence/sqlite/schema.sql` |
| 假 CLI e2e 脚本与 `removeDir` 清理模板 | `apps/server/__tests__/e2e_lan_stream.test.ts` |

---

## 3. Review 重点（评审代理逐任务核对的坑清单）

1. **重放与实时交叠**：同一连接 seq 全序 + 零重复零丢失。关键不变量：`EventBus` 每会话写库**串行链**（`#persistChains`）保证"已见 seq N+1 提交 ⇒ seq N 已提交"——按"入队时刻的重放进度"去重即完备，禁止对缓存冲刷做二次去重（会吞掉落库滞后帧）。
2. **同 token 互踢的竞态窗口**：接管瞬间旧连接可能半帧在途；bye 后旧连接任何 send 必须按已断处理（不写库不执行）。
3. **配对码跨进程**：`aimi-server pair` 是独立 CLI 进程，服务进程靠**库**消费码（不可放内存）；单次核销必须原子（`UPDATE … WHERE used_at IS NULL`）。
4. **`--resume` 的 id 稳定性**：fork 则 resume_hint 需按回合回写；retry 时旧 hint 不能造成二次 fork 叠加。
5. **stopped vs failed 误判**（SPIKE FACT2 已定案）：interrupt→stopped 为服务端事实先行，CLI 随后到货的 `error_during_execution → stopped` 属同状态重复、由 emit 包装层同状态去重；`error_during_execution` 只映射 stopped（FACT2 实证仅打断走此 subtype，纯执行错误走 tool_result is_error + success 收尾）；fake CLI 的 interrupt 行为 ≠ 真实 CLI（e2e 断言以映射语义为准）。
6. **孤儿清点的 pid 复用**：Windows pid 会复用——杀台账 pid 前必须验证进程 cmdline 含 claude（`queryProcessName` 可注入供测试）；绝不盲杀。
7. **三端一体的协议冻结**：任何协议新字段都问一句"S3 手机/S2 relay 会怎么用它"；禁止只为 server 单测方便加临时帧。
8. **Windows 定时器粒度**：断言时间预算（重放吞吐/watchdog/重拨退避）时沿用 M0"按计划补发"与注入时钟手法，断言不依赖系统粒度。
9. **审批闸环路时序**（SPIKE FACT4/FACT6）：CLI 对闸无内置超时 → 手机迟迟不答则该工具调用悬挂（这是正确行为，不是缺陷）；`always` 的会话内自动放行必须与 relay 账本同源（audit 可对账）；会话 dispose 时闸目录残留必须清理——否则同设备目录复用的下轮会话会误吃到旧 decision。

---

## 4. 任务序列（依赖序；一个 plan 走完 S1）

依赖：T1(spike)→{T2 协议（可并行）}；T3→T4→T5；T6 依赖 T3；T7 依赖 T1/T4；T8 依赖 T4（观察 running 态）；T9 可与 T5 后并行；T10 依赖 T3/T6；T11 收口。
任务内步进可让单个代理一次完成（任务粒度=一天内可收），评审代理按第 3 节与各任务《验收》逐条核。

---

### Task 1（W0 spike）——claude CLI 四项行为核实【已完成 2026-10-18，结论回填】

四项结论（证据存 `%TEMP%\aimi-spike\` 与 `%TEMP%\aimi-spike2\`，摘要见 core-loop §9）：

| # | 结论 | 对计划的映射 |
|---|---|---|
| FACT1 | **同进程多回合 = yes**（turn1→turn2 均 `result success`，session_id 不变；每条 user 帧触发一轮新回合） | Task 4 会话门路径 1 成立——终态后同进程开新回合，免冷启动 |
| FACT2 | **打断判据 = `result subtype:"error_during_execution"`**（is_error:true，**进程不退出**；空窗期 interrupt 仅回 `still_queued` ack） | 打断→`stopped` 的映射在 claudeProtocol 层做（见 Task 7.1 修订）；打断后进程存活 ⇒ 会话门路径 1 直接可续跑 |
| FACT3 | **`--resume` 后 session_id stable**（第三进程 init.session_id 与原值全等，上下文续上） | resume_hint 只需"捕获一次"，变更才回写（Task 4.4 保留按变更回写，不每回合回写） |
| FACT4 | **headless 下 `can_use_tool` 控制帧 0 出现**；权限闸真实路径 = `--permission-mode manual`（默认 mode 的安全分类器直接放行，连 `del` 都不问）+ `--permission-prompt-tool mcp__<srv>__<tool>`；**审批调用不进 stream-json**，由 MCP 闸进程承接（请求帧 `{tool_name, input, tool_use_id}`）；回灌必须是 raw JSON `{behavior:'allow',updatedInput?}` / `{behavior:'deny',message}`（纯文本判无效）；CLI 对闸**无内置超时**（实测 60s hold 后回 deny 照常收尾；延迟 5.4s 写入 allow 被无缝接受）；deny = 软拒（模型继续协调，result.permission_denials 累积；不再发 permission_denied system 事件） | Task 7 重写为"闸环路"方案（新增 aimi-gate MCP 闸组件 + 文件握手），见 Task 7 |
| FACT5 | **提问通道无**（AskUserQuestion 不在 headless 工具表；需宿主声明 supportedDialogKinds；模型纯文本提问后收尾） | 协议 question 帧保留；claude 适配器暂不接（Task 7 降级段），提问卡延至 SDK/未来版本 |

另：`initialize` 握手可用（ack 含 commands/agents/output_style/models/account/pid/current_permission_mode/pending_permission_requests）——Task 4.8 协议探测以"initialize ack 是否回来"为判据。

---

### Task 2（W1）——packages/protocol 帧集扩展

**Files**：`packages/protocol/src/frames.ts`、`agentEvents.ts`（不动）、`sessionSpec.ts`、`zodFrames.ts`、`index.ts`、`src/__tests__/schema.test.ts`

- [ ] 2.1 `sessionSpec.ts`：`SessionMeta` 增 `readonly resumable: boolean`（why：S3"续接入口"按此渲染；server 以 resume_hint 有无派生）。
- [ ] 2.2 `frames.ts`：
  - `export type ReplayCursor = Readonly<Record<string, number>>`（会话 id → 手机已见最大 seq；**缺会话 = 从 0 全量拉**，core-loop §5.2 基线）；
  - `HelloFrame`：`resume: ReplayCursor | null`（保留 null 形态——M0 客户端兼容硬约束）；新增 `HelloPairFrame`：`{v:1; type:"hello"; pairingCode:string; deviceName:string}`（同 type 字面量、按字段区分——core-loop §5.3 措辞即 `hello{pairingCode, deviceName}`）；
  - 新 server 帧 `PairedFrame`：`{v:1; type:"paired"; token:string; deviceId:string}`（明文 token 全程只出现这一次）；
  - `FrameErrorCode` 增 `"auth.pairing_failed"`（错码/限速拒绝；过期沿用 `auth.pairing_expired`）；
  - 导出 bye 理由常量 `BYE_TAKEN_OVER="taken_over"`、`BYE_REVOKED="revoked"`（bye.reason 保持 string，注释列明 canonical 取值）。
- [ ] 2.3 `zodFrames.ts` 同步：clientFrame union 两分支（token 变体 token min 8 + resume: `z.union([z.null(), z.record(z.number().int().nonnegative())])`；配对变体 pairingCode 恰 8 位数字 + deviceName 1..64）；serverFrame 增 paired；`sessionMeta` 增 resumable 必填；error code 白名单加新值。
- [ ] 2.4 测试（TDD，先红）：扩展 `schema.test.ts`——旧 hello（resume:null）仍过；resume map 过/非法值拒；hello.pair 过形、位形不足拒（7 位、非数字、缺 deviceName）；paired 帧过；sessionMeta 缺 resumable 拒；新 error code 过。

**验收**：`pnpm -r test` 绿（含 protocol 包）；apps 端零改动本任务不接线（编译照旧——updateSession 之后任务改）。
**提交**：`feat(protocol): hello 重放光标与配对帧集扩展`。

---

### Task 3（W2a）——persistence 扩展（resume_hint 执行面 / 进程台账 / 配对码 / 设备面增强）

**Files**：`persistence/types.ts`、`persistence/sqlite/schema.sql`、`persistence/sqlite/sqliteConversationRepository.ts`、`persistence/sqlite/sqliteRepositories.ts`、`persistence/memory/*`、对应测试

- [ ] 3.1 schema 追加两表（只追加规则）：
  ```sql
  CREATE TABLE IF NOT EXISTS session_processes (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    pid INTEGER NOT NULL,
    started_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pairing_codes (
    code TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  ```
- [ ] 3.2 `ConversationRepository` 增强：
  - `updateSession` patch 增 `resumeHint?: string`；
  - `listSessions()` 的 SQLite 实现用 `resume_hint IS NOT NULL` 派生 `resumable`；
  - 新 `countEvents(sessionId, sinceSeq): Promise<number>`（sinceSeq 语义同 `getEvents` 的排他下界）；
  - 新 `getSessionHint(sessionId): Promise<string | null>`。
  内存实现同步（memory repo 行存 hint）。
- [ ] 3.3 新 `ProcessLedgerRepository`（types + sqlite + memory）：
  ```ts
  /** 子进程台账：spawn 记 pid、dispose 撤销、重启清点孤儿（core-loop §5.1 F5 防线）。 */
  export interface ProcessLedgerRepository {
    init(): Promise<void>;
    /** 登记或覆盖（同会话重拉覆盖旧行）；started_at 由实现取 now */
    register(sessionId: string, pid: number): Promise<void>;
    clear(sessionId: string): Promise<void>;
    list(): Promise<{ sessionId: string; pid: number }[]>;
    close(): Promise<void>;
  }
  ```
- [ ] 3.4 `DeviceRepository` 增强：
  - `DeviceRecord` 增 `readonly revokedAt: number | null`；
  - 新 `markSeen(deviceId): Promise<void>`；
  - 新 `findById(deviceId): Promise<{ id: string; name: string; revokedAt: number | null } | null>`；
  - 配对码（auth 域独占）：
    ```ts
    /** 8 位数字一次性配对码：5min 有效、单次核销；CLI pair 与运行服务跨进程共库消费 */
    issuePairingCode(opts?: { now?: () => number }): Promise<{ code: string; expiresAt: number }>;
    consumePairingCode(code: string, opts?: { now?: () => number }): Promise<"ok" | "unknown" | "expired" | "used">;
    ```
    consume 原子性 SQL：`UPDATE pairing_codes SET used_at=? WHERE code=? AND used_at IS NULL AND expires_at>`now`——返回值按前置状态区分（先 SELECT 判 expired/used/unknown 用于错误文案，再原子 UPDATE；并发双消费由 UPDATE 行数裁定）。
- [ ] 3.5 测试：sqliteConversation（hint 回写→listSessions.resumable；countEvents 边界 sinceSeq=0/空会话；getSessionHint 空值）、sqlite device（markSeen；findById；issuePairingCode 唯一性碰撞重试、8 位数字、过期时间；consume 四态 + 二次核销 false）、memory 对齐用例、ProcessLedger register/clear/list/upsert。
**提交**：`feat(server): persistence 持久化执行面（续接线索/进程台账/配对码/设备投影）`。

---

### Task 4（W2b）——会话生命周期与续接（会话门 / 停止语义 / 运行时台账 / 孤儿清点 / 协议探测）

**Files**：`agents/types.ts`、`agents/registry.ts`（探针 API 见 4.8）、`agents/claude/claudeSession.ts`、`session/sessionManager.ts`、`session/commands.ts`、`session/processReaper.ts`（新）、`app/application.ts`、各测试 + 新 e2e `__tests__/e2e_session_resume.test.ts`

- [ ] 4.1 `agents/types.ts` 增运行时事实接口（why：pid 在 spawn 后才知、hint 在 `system/init` 才到，编排层须拉取式采集）：
  ```ts
  /** agent 侧会话的被采集运行时事实（皆可缺省—— IPC 前拿不到） */
  export interface AgentRuntime { readonly pid?: number; readonly resumeHint?: string }
  export interface AgentSession {
    start(): Promise<void>; send(cmd: AgentCommand): Promise<void>; dispose(reason?: string): Promise<void>;
    runtime?(): AgentRuntime | null;
  }
  ```
  `ClaudeSession` 实现 `runtime()`（pid 取 `#child?.pid`，hint 取 `#sessionId`）；`getResumeHint()` 保留并委托。
- [ ] 4.2 `SessionManager` 会话门（send 语义三路）——签名改 `send(sessionId, cmd): Promise<"delivered" | "inactive" | "expired">`：
  1. 进程活（`managed.agent !== undefined` 且 runtime?.pid 存活——判活先用"句柄未 dispose"）且非终态 → 原路径交付；终态（finished/stopped 且句柄在）也**开新回合交付**（claude 多回合事实，core-loop §5.1）；
  2. 进程死（句柄已 dispose/exit 后）+ `kind==="resumable"` + hint → **send 即续接**：`#publishState("starting")`（服务端事实旁路白名单，沿用 M0 注释口径）→ `adapter.create(spec, emit, {hint})` → `#startOrRecover` → 交付命令；
  3. 死 + 无 hint（或 kind==="archived"）→ 返 `"expired"`（send 不改库不起进程）。`not found` 仍返 `"inactive"`。
  approve/answer 的 waiting 门与晚到失效在 Task 7 叠加（本任务先把管线铺对）。
- [ ] 4.3 停止语义（冒烟 F3 修复，SPIKE FACT2 校准）：
  - `PhoneCommandPipe.handle` 中 `interrupt` 走新路径 `sessions.interrupt(sessionId)`：
    写 interrupt 控制帧（沿用 `claudeSession.send` 的 control_request 形态）→ 即刻发布 `{state:"stopped"}`（服务端事实，旁路白名单）→ **dispose 不发生**（FACT2：headless CLI 打断后进程存活，会话门路径 1 可立即同进程开新回合——免冷启动红利）；
  - claudeProtocol 的 `result` 行映射（与 FACT2 一一对应，实现在 Task 7.1）：`error_during_execution` → `stopped`；其他非 success → `notice:error + failed`；到货的重复 `state:"stopped"` 由 emit 包装层**同状态去重**（新规则：目标 state 等于当前 state 时静默忽略，why 注释标明"服务端事实先行，CLI 随后到货属正常重复"）；
  - `stop()`/`restart()` 不变：dispose 前 `#publishState("stopped")` + `suppressState` 置位——emit 包装层丢弃此后到来的 `state` 类型事件（killTree 后残流不再洗状态；`exit` 等非状态事件照常放行）。
- [ ] 4.4 运行时采集：`SessionManager` emit 包装层每次事件后调 `agent.runtime?.()`——pid 首现即 `ledger.register(sessionId, pid)`；hint 变更即 `conversations.updateSession(id,{resumeHint})`（fork 回写口径与 spike 结论一致）+ 更新 `managed.hint`。`SessionManager` 增依赖 `ledger?: ProcessLedgerRepository`（可注入，缺省 no-op）；`#dispose` 后调 `ledger.clear(sessionId)`。
- [ ] 4.5 adopt/resume/restart 接 hint：
  - `adopt(meta, resumeHint?)`——应用层启动恢复循环改为 `sessions.adopt(meta, await conversations.getSessionHint(meta.id))`；kind 依 hint 有无派生 resumable/archived；
  - `restart()` 重挂时带 `managed.hint`（同一 aimi 会话的上下文续接，修 M0 缺口）。
- [ ] 4.6 启动孤儿清点：新 `session/processReaper.ts`：
  ```ts
  /** server 启动期清点：台账 pid 无主则终止（先验证身份防 pid 复用误杀）。 */
  export function reapOrphans(deps: {
    ledger: ProcessLedgerRepository;
    queryProcessName?: (pid: number) => Promise<string | null>;   // 生产=tasklist 查询；测试注入
    kill?: (pid: number) => void;                                  // 缺省=killTree
    log?: ..., audit?: ...
  }): Promise<number>;                                               // 返回清扫条数
  ```
  Windows 生产实现：`tasklist /FI "PID eq <pid>" /FO CSV /NH` 解析进程镜像 名；**仅当名称含 "claude"**（cmd 垫片 cmdline 亦含 claude.cmd 参数）才 `killTREE(pid)`；不匹配/查无 → 弃行 + WARN（pid 复用防线）。Application.start 在 recover 前跑一次（audit `session.orphan_reaped`）。
- [ ] 4.7 Application 装配更新：构造 `ProcessLedgerRepository`（sqlite）、`reapOrphans`、adopt 带 hint、SessionManager 注入 ledger。
- [ ] 4.8 协议探测标灰（core-loop §5.1 末条，最小闭环）：`AgentRegistry` 增 `gray(id, reason)` / `isGrayed(id)` / `grayedSnapshot()`（内存态，restart server 清空）；`ClaudeSession.start()` 增 init 看门狗（常量 `INIT_TIMEOUT_MS = 30_000`，spike 实测校准）：超时未见 `system/init` → `notice{error,"适配器协议未确认"}` + `state failed` + registry.gray + dispose。SessionManager.send/create 在 agent 不可用时照常返回 inactive/throw（故障隔离面 = 看板选项 S3 渲染，本阶段只把状态做实）。
- [ ] 4.9 测试：
  - sessionManager 单测扩展（fake adapter 带 runtime 记账）：三路 send；interrupt→stopped（服务端事实、**不 dispose**）+ 假 CLI 迟到的 `error_during_execution` 映射仍 stopped——emit 层同状态去重不产新帧；stop 路径（stop/restart）suppress 残流状态事件；runtime 采集 register/hint 回写一次；dispose 清台账；restart 带 hint；adopt(带 hint)→resume 路径不变量维持；
  - processReaper 单测（注入 queryProcessName：匹配→kill、不匹配→弃行、查无→弃行）；
  - claudeSession 单测：runtime() 输出、require start watchdog（fake CLI 不回 init → failed + notice）；
  - **e2e `e2e_session_resume.test.ts`**：fake CLI（`AIMI_FAKE_EXPECT_RESUME=cls-e2e` 校验参数里有 `--resume cls-e2e`，否者 exit 3）——ws1 建会话跑完一轮（finished）→ `app.close()`（子进程收尸）→ **同 dataDir 新 Application**+port 0 → ws2 hello(resume:null) → `session.command send` 到旧会话 → 断言：starting→running→流式增量→finished；stdin.log 可见 `--resume` 生效；第二次发送同进程零冷启动（fake CLI 回放两轮文件）。
**提交**：`feat(server): 会话门三路/停止语义/运行时台账/孤儿清点/协议探测`。

---

### Task 5（W3）——缺口重放（快照切点全序 + 超限通知）

**Files**：`events/eventBus.ts`（+settle）、`events/uiFanout.ts`（+gate）、`app/application.ts`、新 e2e `__tests__/e2e_replay.test.ts`、`persistence/sqlite/benchmarks/throughput.test.ts`（扩用例）

- [ ] 5.1 `EventBus.settle(): Promise<void>`：`flush()`（聚合窗口）后 `await Promise.all([...#persistChains.values()])`（why：重放起点必须"已发布事件全数落库"，否则快照读漏帧）。
- [ ] 5.2 `UiFanout` 增重放栅：
  ```ts
  /** per-connection 重放闸：attach 后 live 广播先排队，open() 才按入队序冲刷；
   *  入队时按 gate.replayedMax（该连接重放已送的最大 seq）去重——落库串行链保证
   *  "已见 N+1 提交⇒N 已提交"，故按入队时刻一次性去重即完备（不二次去重）。 */
  export interface ReplayGate { readonly replayedMax: ReadonlyMap<string, number>; open(): void }
  attach(conveyor: Conveyor, gate?: ReplayGate): void;
  release(conveyor, gate): void;  // open + 冲刷 + 摘除（广播集合照旧保留）
  ```
  广播实现：有 gate 且未 open 的 conveyor → 帧进入 per-conveyor FIFO，`seq <= replayedMax.get(sessionId)` 丢弃；无 gate 通道路径不变。
- [ ] 5.3 `Application.#completeHello` 重放编排（顺序固定）：
  1. 鉴权成功 → `gates` 若 `hello.resume` 非 null：`EventBus.settle()` → 建 gate（`replayedMax` 由本流程维护）→ `#fanout.attach(conveyor, gate)`；
  2. 发 `welcome`（直发 conveyor不受 gate）；
  3. 逐会话：`count = countEvents(sid, cursor)`；`count > 10_000`（常量 `REPLAY_HARD_CAP = 10_000`，per-session 口径）→ 经 `bus.publish` 落一条 `notice{warn, "重放过大（N 条），该段历史不可读"}`（持久化+广播，手机端 S3 负责时间线标注）并**跳过逐帧**；首次超限后于 `meta_kv` 记 `replay_capped:<sid>`——后续重连只发 `notice{info,"历史过大仍未拉取"}`，不重复 warn（why：防重连提醒风暴；改动 core-loop §5.2 超限条目时一并勘误）；
  4. 否则分页 `getEvents(sid, {sinceSeq: cursor, limit: 500})` 循环取完，逐帧直发 `session.event` 帧（不经 fanout），同步更新 `gate.replayedMax`；
  5. `gate.open()`（此刻起 live 帧 direct 出去；此前排队的按入队序冲刷，enq 时去重已做）；
  6. 放行 `state.buffered` 暂存帧（welcome 前抢跑帧——放在重放完成后，语义"历史先于你的命令生效"）。
  `hello.resume === null`：跳过全部重放（M0 行为不变）。
- [ ] 5.4 测试：
  - 单测 UiFanout gate：排队/冲刷顺序、enq 时 seq 去重（replayedMax 推进后旧 seq 到队被丢）、混合双连接（一带闸一无）互不干扰；
  - 单测 settle：聚合窗口 + 滞后写库链全排干；
  - **e2e `e2e_replay.test.ts`**：①ws1 建会话跑 1 轮（N=5 事件）→ 断开 → **ws1 缺席期间**假 CLI 再跑一轮（同会话经进程内 harness 发布——用第二个 fake 会话 or 同会话续接，产生缺口）→ ws2 `hello{resume:{sid: cursor1}}` → 断言收到帧 seq 序 = cursor1+1..lastSeq、无重复无丢号；②全量拉：ws2 `hello{resume:{}}`（无该会话光标）→ 从 0 全量 ≤ 上限；③超限：直接用仓储灌 10_001 行 → 断言 warn notice 一条 + 逐帧未发 + 二次重连仅 info；
  - 吞吐：`throughput.test.ts` 增用例——预灌 1_000 行，重放断言 ≥500 events/s（M0 补发断言口径）。
**提交**：`feat(server): 断连缺口重放（快照切点全序/超限通知/mark 一次性）`。

---

### Task 6（W4）——配对/设备管理/单设备锁/吊销即时断连

**Files**：`auth/pairingLimiter.ts`（新）、`app/application.ts`、`ops/devices.ts`（新）、`ops/serverId.ts`（新）、`bin/aimi-server.ts`、`app/config.ts`（不动就行——pair 不需要新配置）、`package.json`(server) 增依赖 `qrcode`、各测试 + 新 e2e `__tests__/e2e_pairing.test.ts`、`__tests__/e2e_device_lock.test.ts`

- [ ] 6.1 `auth/pairingLimiter.ts`：
  ```ts
  /** 配对提交失败限速：每远端 windowMs 内至多 max 次失败；干得好也记不过线即拒（第 max+1 次起）。 */
  export class PairingLimiter {
    constructor(deps?: { windowMs?: number; max?: number; now?: () => number });  // 默认 600_000 / 8
    allow(key: string): boolean;
    fail(key: string): void;
  }
  ```
  单测：计数/滚动窗口/key 隔离/到线拒。
- [ ] 6.2 Application 配对握手（#onFrame 增 hello 配对分支）：
  - `hello{pairingCode, deviceName}`：`limiter.allow(remote)` 不过 → `error{auth.pairing_failed,"尝试过多"}` + close + `audit.auth("auth_fail","pair limiter remote=…")`；
  - `consumePairingCode(code)`：非 ok → 对应文案 `auth.pairing_expired`/`auth.pairing_failed` + close + limiter.fail + audit_fail；
  - ok → 生成 token（`randomBytes(32).toString("base64url")`）→ `devices.put(deviceName, sha256hex)` → `markSeen` → 直发 `{type:"paired", token, deviceId}` → **同连接立即转正**（identity 落位、附门/走 welcome/重放/暂存放行——复用 token-hello 的成功路径后半段）→ `audit.auth("pair","device=<name> remote=<remote>")`；
- [ ] 6.3 单设备锁（core-loop §5.4）：
  - Application 增 `#identities = Map<Conveyor, DeviceIdentity>`（onClose 清条目）；
  - 每次 hello 成功（token 与 pair 两路都）登记前查同 deviceId 已挂通道：有 → 旧通道 `send({type:"bye",reason:BYE_TAKEN_OVER})` → `close(BYE_TAKEN_OVER)` → detach，后登者照常完成；why 注释"同 token 至多一条活连接，后登者生效"；
  - markSeen 于双路成功后调。
- [ ] 6.4 吊销跨进程可见（CLI 与运行服务不同进程，谁侧都不知道谁）：Application 起 3s 轮询（常量 `REVOKE_SWEEP_MS = 3_000`；stop 时清 timer）——对 `#identities` 逐个 `devices.findById(deviceId)`，`revokedAt !== null` → `send({bye, reason: BYE_REVOKED})` + close + audit `auth.revoke`；吊销后重连在既有 verifyToken 拒绝（M0 语义）。
- [ ] 6.5 `ops/serverId.ts`：`ensureServerId(repo: MetaRepository…)——meta_kv "server_id"`。注意 meta_kv 无仓储口——**新增 `MetaRepository`（persistence/types.ts + 两实现）**：`get(key): Promise<string|null>` / `set(key,value): Promise<void>`（表-模块一对一：basic kv）。
- [ ] 6.6 `ops/devices.ts`（CLI 实现，直开库——沿 `health.ts` 形态）：
  ```ts
  listDevices(cfg): Promise<DeviceRecord[]>                  // devices 子命令
  revokeDevice(cfg, deviceId): Promise<"ok" | "not_found">   // revoke 子命令
  issuePairing(cfg): Promise<{ code: string; expiresAt: number; serverId: string; lanUrl: string }>
  ```
  `revokeDevice`：repo.revoke + audit `auth.revoke`（deviceId 进 detail）；**若该设备行的 token 哈希 == sha256(lan-token.txt 内容)** → 删除文件（core-loop §5.3"同步报废"，防重启复活）+ detail 注明 "lan-token.txt destroyed"。
  `issuePairing`：devices.issuePairingCode + ensureServerId + `lanUrl(8787)`（日志/QR 内容；真实端口以 config 值为准）。
- [ ] 6.7 `bin/aimi-server.ts` 子命令接线：`pair`（打印 QR——`qrcode` 包 `toString(content,{type:"terminal"})`；QR payload = `{v:1, serverId, lanUrl, relayUrl?, code}`，relay 缺省不含）、`devices`（表格行：id name lastSeenAt revokedAt）、`revoke <id>`（退出码 0/1）。usage 行更新。依赖添加：`apps/server` 的 dependencies 增 `qrcode`（运行时打印之需）。
- [ ] 6.8 测试：
  - ops/devices 单测（temp dataDir + sqlite）：list/revoke/lan-token 报废断言（file gone + audit 行）；issuePairing 内容含 serverId/lancode；
  - **e2e `e2e_pairing.test.ts`**（模 CLI 之旁路：测试直调 `repo.issuePairingCode` 到同一 dataDir 的库——跨进程消费语义一致）：①码配对全流程：hello{code,name} → paired{token} → welcome → session.create 全链通；②过期码 → auth.pairing_expired；③已用码 → pairing_failed；④错码×8 → 第 9 次即便拿新码也拒（limiter 线）；
  - **e2e `e2e_device_lock.test.ts`**：两 ws 同 token → 先者收 `bye{taken_over}` 断开，后者 welcome 正常，先者关闭后事件只达后者；
    吊销 e2e：直接库内 revoke 行（assert 活连接 ≤3.5s 内收 `bye{revoked}`；旧 token 再 hello 被拒）。
**提交**：`feat(server): 配对/设备管理/单设备锁/吊销即时断连`。

---

### Task 7（W5）——审批接线（MCP 审批闸环路 + waiting 态流转 + 晚到失效 + 提问降级）

> 依据 SPIKE FACT4/FACT6：权限审批请求**不进 stream-json**（`can_use_tool` 控制帧 headless 下 0 次出现）；
> 真实路径 = `--permission-mode manual`（默认 mode 的安全分类器直接放行——必须绕开）+
> `--permission-prompt-tool mcp__aimi_gate__request_permission` + per-session `--mcp-config`，
> 闸请求由 CLI 拉起的 MCP 闸进程承接，请求帧 `{tool_name, input, tool_use_id}`（无 reason/suggestions）；
> 回灌闸必须 raw JSON `{behavior:'allow',updatedInput?}` / `{behavior:'deny',message}`（纯文本判无效）；
> CLI 对闸**无内置超时**——挂起等到手机决定即可；deny = 软拒（模型继续协调重试，result.permission_denials 累积）。

**Files**：`agents/claude/gate/gate.mjs`（新 MCP 闸进程）、`agents/claude/gate/permissionRelay.ts`（新闸 watch/发布/响应）、`agents/claude/claudeSession.ts`（spawn 参数映射 + 闸配置写入）、`agents/claude/claudeProtocol.ts`（打断映射）、`session/sessionManager.ts`（waiting 门）、`agents/claude/__fixtures__/permission-gate-turn.jsonl`（新）、e2e `__tests__/e2e_approval.test.ts`

- [ ] 7.1 `claudeProtocol` 打断映射（FACT2 定案）：`result` 行 `subtype!=="success"`：`subtype==="error_during_execution"` → `[notice{warn,"执行被打断"}, state stopped]`；其余非 success → 维持 `notice:error + failed`（why 注释引 SPIKE FACT2：纯执行错误经 `tool_result is_error` + 模型收尾，`result success` 不走此路；`error_during_execution` = interrupt 专属）。单测覆盖三形。
- [ ] 7.2 闸组件 `gate.mjs`（零依赖 stdio MCP，SPIKE-2 已验证的正确形态）：
  - 行分隔 JSON-RPC：`initialize`（回显请求里的 protocolVersion）/`tools/list`（工具 `request_permission`，schema 含 tool_name/input）/`tools/call` → 把 `{toolName(tool_name), input, toolUseId(tool_use_id)}` 写 `<dir>/<toolUseId>.request.json` → **轮询** `<dir>/<toolUseId>.decision.txt`（出现即读；无内置超时——FACT6 实证可无限挂起）→ 按 decision 内容回 `result.content[].text = raw JSON`（allow→`{behavior:'allow',updatedInput?}`；deny→`{behavior:'deny',message}`）→ 回写完成后 5s 删两文件；
  - 请求目录 = `<dataDir>/perms/<sessionId>/`（SessionManager 建）；闸进程由 CLI spawn（`cmd` 形态：`node <仓库绝对路径>/apps/server/src/agents/claude/gate/gate.mjs <dir>`），aimi 侧 per-session 写 `mcp.json`：`{"mcpServers":{"aimi_gate":{"command":"node","args":[<gate.mjs 绝对路径>, <dir>]}}}`。
- [ ] 7.3 `permissionRelay.ts`（aimi 侧闸后端，watch-发布-响应一条路）：
  - `watch(dir, sessionId, emit)`：100ms 轮询目录（常量 `POLL_MS`，测试可注入时钟；每请求文件去重——requestId 记账）→ 命中新 `.request.json` → `emit([permission{id:toolUseId, title:toolName, detail:JSON.stringify(input), options:[once/always/reject]}, state waiting_approval])`；
  - 响应：`answer(dir, toolUseId, decision)`——`once`→写 `{behavior:'allow'}`；`always`→allow 且**把 (toolName) 记入该会话 allowlist**（内存 + audit `command.approve` detail "always"）；`reject`→写 `{behavior:'deny', message:"手机端拒绝"}`；
  - **always 已记名工具自动放行**：后续同 toolName 的 `.request.json` 到达 → 不发手机事件、直接写 decision allow + audit detail "auto-allow(always)"（why：一次决策只管一次调用，跨请求自行兑现 always 语义——S1 的会话内近似）；
  - 会话 dispose/finish → relay 停 watch（挂起请求遗留文件清空，任务清理目录）。
- [ ] 7.4 `claudeSession` spawn 参数映射（`buildArgs` 重写）：
  | PhonePermissionMode | 追加 args |
  |---|---|
  | `default` | `--permission-mode manual` + `--permission-prompt-tool mcp__aimi_gate__request_permission` + `--mcp-config <mcp.json>` |
  | `plan` | `--permission-mode plan` + 同上闸参数 |
  （why：default=auto 分类器绕闸；manual 才保证审批进闸但不丢安全分类语义）。
  ClaudeSession 增 `#permDir`：start() 时写 mcp.json（幂等）；dispose 清目录。
- [ ] 7.5 `session/sessionManager.send` waiting 门（晚到失效，不静默吞、不代答——v1 Q3）：
  ```ts
  if ((cmd.cmd === "approve") &&
      managed.state !== "waiting_approval") {
    await bus.publish(sessionId, { type:"notice", severity:"warn", text:"审批已失效（会话已不在等待态）" });
    return "delivered";   // 消费为通知，不写闸
  }
  ```
  approve 命里的再校验 requestId 在 relay 账本中存在（不存在同样发失效 notice）。
- [ ] 7.6 恢复续接的挂起卡失效标注（core-loop §5.5 我的决定）：Task 4 的 send 即续接路径与 `resume()`：起手若恢复前 state ∈ waiting_* → 先经 bus 发布 `notice{info,"审批已失效（会话中断）"}` 再走 starting（测试见 7.7 ⑤）。
- [ ] 7.7 fixtures + 假 CLI 扩展（fake/prod 共用 relay 行为）：
  - 假 CLI 增 `AIMI_FAKE_PERM_DIR=<dir>`：fixture 内置标线 `{"__aimi_perm__":{id, toolName, input}}`——播到该线 → 假 CLI 写 `<dir>/<id>.request.json` → 轮询 `<dir>/<id>.decision.txt` → allow 则继续播后续行（含工具成功 tool_result），deny 则播 `tool_result is_error` 行与继续协调（软拒——同 FACT6）→ 收尾 `result`（subtype success；time 允许再嵌 `permission_denials` 字段供断言）；
  - fixture `permission-gate-turn.jsonl`：init → text_delta → 标线(权限) → [等待] → allow 后：assistant tool_use(Bash) → tool_result → text_delta → `result success`；另有 deny 变体 fixture。
- [ ] 7.8 测试：
  - gate.mjs 单测：真 stdio 驱动（initialize/tools/list/tools/call → 写 decision.txt → 断言回灌 JSON 全等；wrap 纯文本被 gate 判?——gate 只转发文件内容，格式由 relay 保证）；
  - permissionRelay 单测：request 文件 → 精确事件序（permission 字段全等 + state）；once/always/reject 三写路径；always 第二次自动放行（audit、不发事件）；
  - claudeSession spawn 参数断言（default/plan 两形）；
  - **e2e `e2e_approval.test.ts`**：①happy：ws 收 `permission.request`+`waiting_approval` → `approve once` → 假 CLI 继续 → finished（全链）②`always`：第二次同工具过闸不发手机事件③`reject`：is_error 行到达 → 模型侧收尾（result success + permission_denials 字段断言）④晚到：finished 后 approve → 失效 notice + decision 文件未写⑤waiting 中 kill 假 CLI → send 触发续接 → "因会话中断失效" notice⑥`bypassPermissions` 守卫：create → error 帧。
**提交**：`feat(server): MCP 审批闸接线（手机决策/晚到失效/always 会话内近似）`。

---

### Task 8（W6）——watchdog stalled

**Files**：`events/eventBus.ts`（增 observe 路由槽）、`session/watchdog.ts`（新）、`app/application.ts`、`app/config.ts`、测试

- [ ] 8.1 `EventBusHandlers` 增第4槽 `observe?: (rec) => void`（语义=内部观测消费，不占通知路——通知本地派生后该语义专属 watchdog/未来 metric；注释 why）。
- [ ] 8.2 `session/watchdog.ts`：
  ```ts
  /** running 会话超阈值无新事件 → notice{stalled}，仅提示一次直至下一真实事件（防定时轰炸）。 */
  export class SessionWatchdog {
    constructor(deps: { bus: EventBus; thresholdMs: number; now?: () => number; logger? });
    stop(): void;
  }
  ```
  - 订阅 observe：按事件更新 `lastTs[sid]` 与自观察的最近 state（仅 `state:{running}` 触发计时增挂；非 running 清 timer）；
  - timer 触发（每 sid 一个，任一新事件重置）：state==running → 发布 `notice{warn,"会话疑似停滞（>X min 无新事件）"}`（**用户可读文案可含分钟数**；通知分类 stalled 的映射是手机本地派生——server 只发语义 notice）；告警后静默重挂直到下一事件来前不再重复；
- [ ] 8.3 配置：`config.ts` 增 `watchdogMs: number`（yaml 键 `watchdogMs`，默认 600_000，zod int min 5000——why 注释防测试误配为 0 即停用）。
- [ ] 8.4 测试：①running 静默>阈值 → 恰一条 warn notice（fake 计时注入阈值 200ms 真时钟）；②事件到达 → 无第二告警；再静默再告警（各场一次）；③waiting/finished/starting → 不计时；④双会话隔离；⑤config 默认/yaml 覆盖/下限拒。
**提交**：`feat(server): watchdog stalled 提示（10min 默认可配）`。

---

### Task 9（W7）——server→relay 出站拨入

**Files**：`transport/ws/relayClient.ts`（新）、`transport/ws/clientConveyor.ts`（新，或重按 9.2 抽共享）、`app/application.ts`、`app/config.ts`、e2e `__tests__/e2e_relay_dial.test.ts`（含内嵌 fake relay）

- [ ] 9.1 配置：`ServerConfig` 增 `relay?: { url: string; serverToken: string }`（yaml 键 `relay.url` / `relay.serverToken`；zod object strict 可缺省）。
- [ ] 9.2 客户端 Conveyor：抽出与 ServerSideConveyor 共用的收发改造为 `WsConveyor`（0 语义纯`transport/ws/messagePipe.ts` 内部 class 提升 export；`createServerSideConveyor` 签名不变）；新 `createClientSideConveyor(socket, remote)`（socket open 前提——连接回调时已 open）。
- [ ] 9.3 `transport/ws/relayClient.ts`：
  ```ts
  /** server→relay 出站拨号：拨入 header 携带 server-token（relay 侧校验+S2 对接点），
   *  建链后同帧协议透传：该连接上来自 relay 的"客户端帧"直接进 Application 入站编排。 */
  export class RelayClient {
    constructor(deps: { url: string; serverToken: string; logger?; now?; dial?: (…) => Promise<Conveyor> });  // dial 注入供退避测试
    start(onConnection: (conveyor: Conveyor, remote: string) => void): void;
    close(): Promise<void>;                 // 幂等、取消重拨
  }
  ```
  - 拨入 WS header：`{ "x-aimi-server-token": serverToken }`；
  - 断线重拨：指数退避 1s 起 2^n、封顶 60s、±20% 抖动（常量 `DIAL_RETRY_BASE_MS/MAX_MS`）；
  - 每次成功 dial → `onConnection(createClientSideConveyor(socket, "relay"), "relay")`。
- [ ] 9.4 Application.start：LanWsServer.listen 后 `#handleConnection` 提为公共 `attachConnection(conveyor, remote)`（LAN 回调与 relay 回调同用）；cfg.relay 存在 → 起 RelayClient（close 逆序）。
- [ ] 9.5 假 relay e2e 双端服务器：`WebSocketServer{port:0}` 两路由 `/server`（校验 header token，不符 401——S2 契约预留注释）与 `/phone`；两端 socket **原样转发**（哑管道——不 parse 帧）；case：app 配 relay.url/serverToken → phone 客户端连 /phone 后走 hello→welcome→session.create→假 CLI 回放事件→send 命令全链通（断言帧序列与 LAN 用例等价）。拨入失败：错 token → 无连接；server 端重试：`dial` 注入 fake → 断言退避序列（1,2,4…60 封顶 + 抖动区间）。
**提交**：`feat(server): server→relay 出站拨入（同帧协议透传/指数重拨）`。

---

### Task 10（W8）——CLI 汇总 + Windows 自启

**Files**：`ops/windows.ts`（新）、`bin/aimi-server.ts`、`app/detectAgents.ts`（新，避免 ops→agents 反向依赖）、status 扩展、测试

- [ ] 10.1 `ops/windows.ts`（纯函数构建器 + 执行壳）：
  ```ts
  /** Windows 任务计划注册计划（纯构建器——测试可断言 XML 全文）。 */
  export function installPlan(deps: { nodeExe: string; entryJs: string; taskName?: string }): InstallPlan;
  export interface InstallPlan { readonly taskName: string; readonly xml: string }
  export async function register(plan: InstallPlan): Promise<void>;   // schtasks /Create /TN plan.taskName /F /XML <临时 xml>
  export async function unregister(taskName?: string): Promise<void>;  // /Delete /TN taskName /F（不存在视为成功）
  ```
  XML 契约（why 注明）：触发器 `<LogonTrigger/>`（当前用户）；`<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count>`；隐藏窗口（`<Hidden>true</Hidden>` … `<Exec>node.exe … start 子命令`）；非 Windows 平台调用 → throw `"仅支持 Windows"`。
  node 入口解析：`process.execPath` + `import.meta.url` 派生的 dist 路径（**非 dev/watch 模式**——why：常驻服务）。
- [ ] 10.2 `app/detectAgents.ts`：`detectAgentsSnapshot(): Promise<AgentDetection[]>`（AgentRegistry+ClaudeAdapter 就地小装配——why：status 不拉全 Application，只装检测面）。
- [ ] 10.3 `bin` 接线：`status` 输出 = `{port, sessions, devices, agents}`（agents detectAll 结果）；`install`/`uninstall` 子命令（ops/windows）。
- [ ] 10.4 测试：installPlan XML 全文断言（trigger/restart/hidden/exec 四要素 + taskName）；unregister/install 只测构建器不真正调度（CI 无 Windows 任务计划写权限保障）——`register/unregister` 标注手动验证入口。status agents 断言（fake isInstalled）。
**提交**：`feat(server): CLI 子命令汇总与 Windows 任务计划自启`。

---

### Task 11——S1 终验收与收口

- [ ] 11.1 全闸门重跑：`pnpm typecheck && pnpm -r test && node tools/check-deps.mjs`；本地 CI 同配置（windows runner 口径的 e2e 断言勿在 mac/CI 外放宽）。
- [ ] 11.2 验收对账（写入台账 + core-loop 文档勘误若涉及）：
  - G1 协议冻结：Task 2 全过；
  - G2 生命周期：Task 4 之 stopped 语义/三路会话门/孤儿清点/探测标灰；
  - G3 重放：Task 5 零丢失/吞吐/超限/一次性；
  - G4 配对：Task 6 配对全链/吊销即时断/lan-token 报废/互踢；
  - G5 审批：Task 7 全链（闸环路）/晚到失效/中断挂起失效/白名单守卫 + **手动**：真 CLI（manual+闸）跑一次真实审批回合记台账；FACT5 提问通道降级说明勘误 core-loop §5.5；
  - G6 watchdog：Task 8；
  - G7 relay 拨入：Task 9 fake relay 全链；
  - G8 运维：Task 6 CLI（pair/devices/revoke）+ Task 10（status/install/uninstall）；
  - M0 回归：`e2e_lan_stream.test.ts` 五用例零改动绿。
- [ ] 11.3 台账收口：`.superpowers/sdd/progress.md` S1 段完成状态 + 遗留 gotcha；把"手动项"明确列出：用户重启电脑验证 install（设计 §5.10）+ 后续 S2/S3 立项提议。
- [ ] 11.4 收尾提交：`docs(m1): S1 验收对账与遗留项`（如有文档勘误）。

---

## 5. 与旧计划的差别（一句话）

不再分 P1/P2/P3 三端混合段；S1 server 内 9 模块按依赖序直线推进（spike→协议→persistence→生命周期→重放→配对→审批→watchdog→relay 拨入→CLI/install→终验），三端契约在 T2/T9 按冻结口径定型。
