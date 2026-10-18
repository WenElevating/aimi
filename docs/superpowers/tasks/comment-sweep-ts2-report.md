# 注释规范第二轮 — TS 侧全量补齐 @tag 格式：执行报告

## 1. 任务与范围

- 依据：`docs/superpowers/tasks/comment-sweep-ts2.md`（用户规范逐字执行，优先级最高）。
- 样式基准：`apps/server/src/events/eventBus.ts`（controller 手工完成，全仓唯一基准，**本轮未改动它**）。
- 扫描范围：
  - `packages/protocol/src/**`（6 个 .ts，实际有注释变更 2 个）
  - `apps/server/src/**`（含各层源码与全部 `*.test.ts`、benchmark）
  - `apps/server/__tests__/e2e_lan_stream.test.ts`
  - `tools/check-deps.mjs`
- 硬约束：零代码改动（只动注释行）；公开导出 doc comment 覆盖率不降；字符串字面量不动；不 commit；不动 `apps/mobile/**`、`docs/**`（本报告除外）、配置文件。

## 2. 变更文件清单（42 个，均仅注释行）

事件/接入层
- `apps/server/src/events/eventFlood.ts`
- `apps/server/src/events/uiFanout.ts`
- `apps/server/src/events/eventBus.test.ts`
- `apps/server/src/transport/conveyor.ts`
- `apps/server/src/transport/ws/messagePipe.ts`
- `apps/server/src/transport/ws/lanServer.ts`
- `apps/server/src/transport/ws/messagePipe.test.ts`

应用/运维/日志
- `apps/server/src/app/application.ts`
- `apps/server/src/app/application.test.ts`
- `apps/server/src/app/config.ts`
- `apps/server/src/bin/aimi-server.ts`
- `apps/server/src/logging/logger.ts`
- `apps/server/src/ops/health.ts`
- `apps/server/src/ops/health.test.ts`

审计/鉴权
- `apps/server/src/audit/auditWriter.ts`
- `apps/server/src/auth/authenticator.ts`
- `apps/server/src/auth/authenticator.test.ts`
- `apps/server/src/auth/configProvisioner.ts`

agents / claude
- `apps/server/src/agents/types.ts`
- `apps/server/src/agents/registry.ts`
- `apps/server/src/agents/registry.test.ts`
- `apps/server/src/agents/claude/claudeAdapter.ts`
- `apps/server/src/agents/claude/claudeProtocol.ts`
- `apps/server/src/agents/claude/claudeProtocol.test.ts`
- `apps/server/src/agents/claude/claudeSession.ts`
- `apps/server/src/agents/claude/claudeSession.test.ts`

会话编排
- `apps/server/src/session/sessionMachine.ts`
- `apps/server/src/session/commands.ts`
- `apps/server/src/session/sessionManager.ts`
- `apps/server/src/session/sessionManager.test.ts`

持久化
- `apps/server/src/persistence/types.ts`
- `apps/server/src/persistence/memory/memoryConversationRepository.ts`
- `apps/server/src/persistence/memory/memoryDeviceRepository.ts`
- `apps/server/src/persistence/memory/memoryCommandDedupRepository.ts`
- `apps/server/src/persistence/memory/memoryAuditRepository.ts`
- `apps/server/src/persistence/sqlite/migrate.ts`
- `apps/server/src/persistence/sqlite/sqliteConversationRepository.ts`
- `apps/server/src/persistence/sqlite/sqliteRepositories.ts`

协议包 / 工具 / e2e
- `packages/protocol/src/frames.ts`
- `packages/protocol/src/sessionSpec.ts`
- `packages/protocol/src/zodFrames.ts`
- `apps/server/__tests__/e2e_lan_stream.test.ts`
- `tools/check-deps.mjs`

> 说明：`apps/server/src/events/eventBus.ts` 在工作树中亦显示为已修改，但那是 controller 预置的基准样例，本轮**未触碰**。工作树中的 `apps/mobile/**` 改动不属本任务范围（非本 agent 所为），未纳入本报告的核对与统计。

## 3. @tag 格式转换典型前后对照（≥5 组）

### 3.1 `apps/server/src/events/eventFlood.ts` — `isDeltaEvent`（补 `@returns`、参数加破折号）

```diff
-/**
- * 是否为可聚合 delta。判定规则集中于此，避免 EventBus 另行内联一份（两份易漂移）。
- * @param event 归一化 agent 事件。
- */
+/**
+ * 判定一条事件是否属于可聚合的增量类型（文本/思考增量）。
+ * 判定规则集中于此，避免调用方另行内联一份导致两份漂移。
+ *
+ * @param event - 归一化 agent 事件
+ * @returns true 表示该事件可进入聚合窗口
+ */
```

### 3.2 `apps/server/src/events/uiFanout.ts` — 构造函数（首句业务语言 + `@param` 破折号 + 副作用）

```diff
-  /**
-   * @param eventBus 事件总线；构造时注册 ui 路由（接管单槽）。
-   */
+  /**
+   * 构造即接管事件总线的界面路，把后续会话事件转发给挂接的通道。
+   *
+   * @param eventBus - 事件总线；ui 路由由本类独占
+   * 副作用：覆盖事件总线的 ui 路由，调用方不要再自行注册
+   */
```

### 3.3 `apps/server/src/transport/conveyor.ts` — 接口方法 `close`（由无标签说明改为完整标签）

```diff
-  /** 主动关闭（发 close 帧并清理）。幂等：已 closed 直接 resolve。 */
+  /**
+   * 主动关闭（发 close 帧并清理）。幂等：已 closed 直接 resolve。
+   *
+   * @param reason - 关闭原因；缺省时以对端 close 帧带来的原因回填
+   * @returns Promise，resolve 表示通道已关闭；已关闭时立即 resolve
+   */
   close(reason?: string): Promise<void>;
```

### 3.4 `apps/server/src/persistence/types.ts` — `appendEvent`（接口方法补齐四类标签）

```diff
-  /**
-   * 按 **EventBus 分配的显式 seq** 追加事件（该会话首事件 seq=0）；同事务回写 `last_seq=seq` 与 `updated_at=ts`。
-   * **seq 的分配权威在 EventBus**——本仓储只执行写入，不自行分配序号；
-   * seq 冲突（`(session_id, seq)` 主键重复）视为编程错误，由底层自然抛出，不做容错。
-   * 会话不存在时抛错。
-   */
+  /**
+   * 按 **EventBus 分配的显式 seq** 追加事件（该会话首事件 seq=0）；同事务回写 `last_seq=seq` 与 `updated_at=ts`。
+   * **seq 的分配权威在 EventBus**——本仓储只执行写入，不自行分配序号；
+   * seq 冲突（`(session_id, seq)` 主键重复）视为编程错误，由底层自然抛出，不做容错。
+   *
+   * @param sessionId - 目标会话
+   * @param seq - 事件序号，由 EventBus 统一分配
+   * @param agentEvent - 归一化后的 agent 事件
+   * @param ts - 事件发出时刻（毫秒）
+   * @returns Promise，resolve 表示已落库
+   * @throws 会话不存在或 seq 冲突时抛出底层错误
+   */
```

### 3.5 `apps/server/src/session/sessionManager.ts` — `dispose`（补 `@returns` 与副作用）

```diff
-  /** 释放 agent 侧会话句柄（可缺省——恢复态没有子进程）。 */
+  /**
+   * 释放 agent 侧会话句柄（可缺省——恢复态没有子进程）。
+   *
+   * @param sessionId - 目标会话
+   * @param managed - 编排层持有的会话条目
+   * @param reason - 释放原因，仅用于诊断
+   * @returns Promise，resolve 表示句柄已回收
+   * 副作用：清空条目的 agent 引用并终止底层子进程
+   */
```

### 3.6 `apps/server/src/agents/claude/claudeSession.ts` — `dispose`（补 `@returns` 与副作用）

```diff
-   * 后立即返回，绝不把调用方（`SessionManager.stop`）永久挂起。
-   * @param reason 仅用于诊断（参数为满足 `AgentSession` 接口契约而保留）。
+   * 后立即返回，绝不把调用方（`SessionManager.stop`）永久挂起。
+   *
+   * @param reason - 仅用于诊断（参数为满足 `AgentSession` 接口契约而保留）
+   * @returns Promise，resolve 表示子进程已收尸或已放弃等待
+   * 副作用：终止子进程树、置句柄作废（此后 `start` 一律拒绝）
```

### 3.7 `tools/check-deps.mjs` — `resolveSpecifier`（JS 无类型签名，`@param` 不带大括号）

```diff
-/** 相对说明符 → 目标文件绝对路径（`.js` 说明符按 TS NodeNext 习惯映射到同目录 .ts）。 */
+/**
+ * 把相对导入说明符解析为目标文件的绝对路径（`.js` 说明符按 TS NodeNext 习惯映射到同目录 .ts）。
+ *
+ * @param fromFile - 发起导入的文件绝对路径
+ * @param specifier - 相对导入说明符
+ * @returns 目标文件的绝对路径
+ */
```

> 另附异步“永不 reject / reject 条件”写法示例，见 `authenticator.ts` 的 `verifyToken`：
> `@throws 正常情况不会 reject：任何查表失败都收敛为 null，调用方只需一个拒绝分支`；
> 以及 `lanServer.ts` 的 `listen`：`@returns Promise，resolve 为实际监听端口` / `@throws 监听失败（如端口被占用）时抛出底层错误`。

## 4. 第一轮残留清理对照（≥3 组）

### 4.1 括号内跨文件符号引用（（见 X）（接 X））

`apps/server/src/transport/ws/messagePipe.ts`
```diff
-  /** 单槽：重复注册覆盖（见 `Conveyor.onFrame`）。 */
+  /** 单槽：重复注册会覆盖前一次回调，只保留最后注册者 */
```

`apps/server/src/session/sessionManager.ts`（三处引用式说法全部就地展开为约束本身）
```diff
-   * @throws 适配器 `start()` 的原始错误：会话已自动落 `failed` 并清理句柄（见类 TSDoc）。
+   * @throws 适配器 `start()` 的原始错误：会话已自动落 `failed` 并清理句柄
...
-   * 新事件序号不与既有事件撞车（跨进程 seq 连续性，见 `EventBus.seedSession`）。
+   * 并把 seq 计数器播种到 `meta.lastSeq + 1`，保证重启后新事件序号不与既有事件撞车。
...
-   * **仅启动装配期逐会话调用一次**：重复认领会用新条目顶掉活动句柄导致子进程泄漏（见类 TSDoc 遗留警示）。
+   * **仅启动装配期逐会话调用一次**：重复认领会用新条目顶掉活动句柄导致子进程泄漏。
```

`apps/server/__tests__/e2e_lan_stream.test.ts`
```diff
-      // 对恢复会话发 stop：archived 无子进程，但仍会发 {state:stopped}——其 seq 必须 = 6（接续仓储）。
+      // 对恢复会话发 stop：archived 无子进程，但仍会发 {state:stopped}——其 seq 必须接续仓储 lastSeq，即 6。
...
- *   行距由假 CLI **按标称计划补发**（见 FAKE_CLAUDE_SCRIPT），实测总跨度 ≈150ms 与 OS 定时器粒度无关。
+ *   行距由假 CLI **按标称计划补发**，实测总跨度 ≈150ms 与 OS 定时器粒度无关。
```

### 4.2 英文术语残留（fixture → 回放样本）

`apps/server/src/agents/claude/claudeProtocol.test.ts`
```diff
-/** fixture 原文（每行一 JSON）——回放测试的唯一输入源。 */
+/** 回放样本原文（每行一段 JSON）——回放测试的唯一输入源。 */
```
`apps/server/src/agents/claude/claudeSession.test.ts`
```diff
-/** 造临时目录：拷 fixture、写假 claude 脚本与 `claude.cmd` 垫片（PATH 解析目标）。 */
+/**
+ * 造一个临时目录：拷入回放样本、写假 claude 脚本与 `claude.cmd` 垫片（PATH 解析目标）。
+ *
+ * @param script - 假 claude 脚本内容
+ * @returns 该临时目录的绝对路径；目录登记进清理表由 afterEach 删除
+ */
```
`apps/server/__tests__/e2e_lan_stream.test.ts`
```diff
-/** 单轮对话的回放 fixture（服务端单测与这里的 e2e 共用一份，同一输入自然期望同一事件流）。 */
+/** 单轮对话的回放样本（服务端单测与这里的 e2e 共用一份，同一输入自然期望同一事件流）。 */
-/** 行序列 → fixture 文本（含末尾换行，行缓冲末行不丢）。 */
+/** 把行序列拼成回放样本文本（含末尾换行，保证行缓冲末行不丢）。 */
```

### 4.3 箭头链执行流程叙述（A → B → C）

`apps/server/src/app/application.ts`（接线顺序由箭头链改为顿号叙述）
```diff
- * 接线顺序（即依赖方向）：
- * logger → Sqlite 四仓储 → AuditWriter → ConfigProvisioner → DefaultAuthenticator →
- * AgentRegistry(+ClaudeAdapter) → EventBus(subscribe persist) → UiFanout →
- * SessionManager → 启动恢复（listSessions → adopt + seed seq）→ LanWsServer.listen。
+ * 接线顺序（即依赖方向）：
+ * logger、Sqlite 四仓储、AuditWriter、ConfigProvisioner、DefaultAuthenticator、
+ * AgentRegistry(+ClaudeAdapter)、EventBus（订阅 persist）、UiFanout、
+ * SessionManager、启动恢复（listSessions 后 adopt 并播种 seq）、LanWsServer.listen。
```
```diff
-   * 优雅关停（幂等）：WS 收口 → 停会话（释放 agent 子进程）→ 冲刷聚合 → 关库。
+   * 优雅关停（幂等）：先收口 WS，再停会话（释放 agent 子进程），接着冲刷聚合，最后关库。
```

`apps/server/src/agents/claude/claudeProtocol.ts`（映射表箭头改为“产出”叙述）
```diff
- * - `system/init` → `state:running`（`session_id` 由 `parseLine` 单独带出，不 emit）；
- * - `stream_event.event.delta[type=text_delta]` → `text_delta`；
+ * - `system/init`：产出 `state:running`（`session_id` 由 `parseLine` 单独带出，不 emit）；
+ * - `stream_event.event.delta[type=text_delta]`：产出 `text_delta`；
```

`apps/server/src/session/sessionManager.ts`
```diff
-   * 服务端事实驱动的状态落地：写内存状态 → 回写 `sessions.state` → 经 bus 发布。
+   * 服务端事实驱动的状态落地：先写内存状态，再回写 `sessions.state`，随后经 bus 发布。
```

### 4.4 字段注释行尾去句号（对齐基准样例）

按基准样例（字段注释行尾不加句号），对多行 `interface` 的成员注释统一去尾句号（`apps/server/src/app/config.ts`、`agents/registry.ts`、`persistence/types.ts`、`session/sessionManager.ts`、`transport/*`、`events/eventFlood.ts`、`agents/claude/claudeSession.ts` 等），并补齐此前缺失的字段约束，例如 `packages/protocol/src/sessionSpec.ts`：

```diff
 export interface SessionMeta {
+  /** 会话标识，由服务端生成，创建后不变 */
   readonly id: string;
+  /** 适配器标识 */
   readonly agentId: string;
...
+  /** 会话内最后一条事件的序号；手机据此补齐断线期间漏掉的事件 */
   readonly lastSeq: number;
```

## 5. 验证结果（原文）

```
$ node tools/check-deps.mjs
check-deps: 38 file(s) scanned, 0 violations
check-deps exit=0

$ pnpm typecheck
> aimi-monorepo@ typecheck D:\AiProject\aimi
> pnpm -r exec tsc --noEmit
typecheck exit=0

$ pnpm --filter @aimi/protocol test
  ✓ src/__tests__/schema.test.ts (8 tests)
 Test Files  1 passed (1)
      Tests  8 passed (8)

$ pnpm --filter @aimi/server test
  ... 16 个测试文件全部通过 ...
 Test Files  16 passed (16)
      Tests  74 passed (74)
server exit=0
```

零代码改动自查（逐 hunk 判定，仅注释行）：
```
$ git diff -U0 -- packages apps tools | <过滤非 `*`/`//`/`/*` 开头的新增/删除行>
OK: all changed lines are comment lines
```
> 说明：含行尾注释的代码行（如测试里的 `adapter.emit(...); // 合法：...`）若改动其注释会使整行进入 diff，为严守“hunk 仅触及注释行”，此类行尾注释**保持原样未动**（见保留清单 §6）。

## 6. 拿不准 / 刻意保留清单及原因

1. **字符串字面量中的旧术语与箭头（一律保留）**——属代码，不可动：
   - 测试标题：`it("persist 失败不阻塞 ui 路（§11）")`、`it("...（异常 #7）")`、`it("Step 2.1/2.2/2.3：...")`、`describe("SessionManager 编排（§C 三态）")`、`describe("落库吞吐（§7 预算）")`、`describe("M0 性能预算（§7）")`、`it("回放 fixture → 事件序列同协议回放;...")`、`it("连接→双向帧→关闭回调")`、`describe("Application 部分启动失败的资源回收（评审 Fix 1/2）")`、e2e 的 `hello→welcome→create→...`、`洪水聚合：... → 传输帧数 ...`、`8KB 截断：... → ...`；
   - 运行时/断言文案：`invalid transition ${from}→${to}`、`[bench] ... → ...` 等。
2. **`sessionManager.ts` 中 `text:"invalid transition <from>→<to>"` 的箭头**：注释在展示 notice 的字面文案（代码里就是 `→`），保留才与实现一致。
3. **`apps/server/src/persistence/sqlite/*.ts`、`memory/*.ts` 的内部 DB 行投影接口**（`SessionRow`/`EventRow`/`DeviceRow`/`AuditRow`/`StoredSession`/`StoredEvent`/`StoredDevice`/`StoredAudit`）：未逐字段加注释——字段即落库列名的一一映射，逐字段注释会沦为“同义复述”（规范禁止），且已在接口级注释与 `schema.sql` 中说明。
4. **协议包中单行声明的接口**（`frames.ts` 的 `HelloFrame`/`WelcomeFrame`/`PingFrame`/`PongFrame`/`ByeFrame`/`SessionCreateFrame`/`SessionCommandFrame`/`SessionEventFrame`/`AckFrame`/`ErrorFrame`，`agentEvents.ts` 的 `ApprovalOption`/`Choice` 等）：为单行 `interface { ... }` 声明，补字段注释须把声明拆成多行——那是代码行改动，违反零代码改动硬约束，故保留原样（其字段语义已由接口级注释与 `zodFrames.ts` 结构契约覆盖）。多行接口（`SessionSpec`/`SessionMeta`）已补字段注释。
5. **行尾注释所在的代码行**：`sessionManager.test.ts` 中 `// 合法：starting→running` 一类行尾注释含箭头，但改动会使该代码行进入 diff，为守住硬约束**未动**。
6. **`eventBus.ts`**：controller 基准样例，按任务要求全程只读，未改。
7. **`check-deps.mjs` 中代码块内的 `import` 字样、注释里作为术语的 `import`**：属注释对导入语义的说明，非引用式说法，保留。

## 7. 结论

- 范围文件注释已按基准样例统一为业务语言首句 + `@param name - 说明` / `@returns`（含异步 resolve 语义与永不 reject 说明）/ `@throws`（含 reject 条件）/ 副作用行；凡有 `await` 的导出函数均说明 resolve 内容，凡写库/触发事件/修改入参处均写“副作用：…”。
- 第一轮残留（括号内跨文件符号引用、`fixture` 等英文术语、箭头链流程叙述）已按 grep 逐条确认并清理；不可动的字符串字面量内同类内容保留。
- 零代码改动、导出 doc comment 覆盖率不降、四条验证基线全绿。
