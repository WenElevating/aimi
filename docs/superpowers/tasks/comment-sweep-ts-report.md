# 注释规范整改报告 — TS 侧（packages/protocol + apps/server）

## 结论
- 状态：完成。范围内 `packages/protocol/src/**` 与 `apps/server/src/**` 全部 `.ts` 已按新规范整改。
- 改动文件：**48**（protocol 6 + server src 42）。
- 零代码改动：已用编译器级比对证明——把 HEAD 与工作区两版分别 `transpileModule({ removeComments: true })` 后逐字比较，结果 `ALL COMMENT-ONLY`（详见「验证」）。
- 公开导出 doc comment 覆盖率：只重写/合并，**无删除**（数量不减）。

## 验证（原文）
```
pnpm --filter @aimi/protocol test
 Test Files  1 passed (1)
      Tests  8 passed (8)

pnpm --filter @aimi/server test
 Test Files  16 passed (16)
      Tests  74 passed (74)

pnpm typecheck
> pnpm -r exec tsc --noEmit
EXIT=0
```
数字与改前完全一致（8 + 74 / 16 files / typecheck exit 0）。

### 注释-only 证明
`git diff --name-only -- packages/protocol/src apps/server/src` 得到 48 个文件，喂入脚本
（`transpileModule` 去注释后比对 HEAD 与工作区产物）：
```
ALL COMMENT-ONLY
```
即：48 个文件相较 HEAD 只差注释，任何标识符 / 字符串字面量 / import / 类型 / 逻辑均未变动。
（少数改在行尾注释上，代码前缀保持逐字节相同；由上比对统一覆盖。）

## 改动文件清单（48）
protocol（6）：`src/agentCommands.ts`、`src/agentEvents.ts`、`src/frames.ts`、`src/sessionSpec.ts`、`src/zodFrames.ts`、`src/__tests__/schema.test.ts`

server（42）：
`agents/types.ts`、`agents/registry.ts`、`agents/registry.test.ts`、
`agents/claude/claudeAdapter.ts`、`agents/claude/claudeProtocol.ts`、`agents/claude/claudeProtocol.test.ts`、
`agents/claude/claudeSession.ts`、`agents/claude/claudeSession.test.ts`、
`app/version.ts`、`app/config.ts`、`app/application.ts`、`app/application.test.ts`、
`audit/auditWriter.ts`、`auth/authenticator.ts`、`auth/authenticator.test.ts`、`auth/configProvisioner.ts`、
`bin/aimi-server.ts`、`logging/logger.ts`、`ops/health.ts`、
`events/eventBus.ts`、`events/eventBus.test.ts`、`events/eventFlood.ts`、`events/uiFanout.ts`、
`session/sessionMachine.ts`、`session/sessionManager.ts`、`session/sessionManager.test.ts`、`session/commands.ts`、
`transport/conveyor.ts`、`transport/ws/lanServer.ts`、`transport/ws/messagePipe.ts`、
`persistence/types.ts`、`persistence/types.test.ts`、
`persistence/memory/index.ts`、`persistence/memory/memoryAuditRepository.ts`、
`persistence/memory/memoryCommandDedupRepository.ts`、`persistence/memory/memoryConversationRepository.ts`、
`persistence/memory/memoryDeviceRepository.ts`、
`persistence/sqlite/migrate.ts`、`persistence/sqlite/sqliteRepositories.ts`、
`persistence/sqlite/sqliteConversationRepository.ts`、`persistence/sqlite/sqliteConversationRepository.test.ts`、
`persistence/sqlite/deviceRepository.test.ts`、`persistence/sqlite/benchmarks/throughput.test.ts`

## 违规注释前后对照（典型）

1. 文档/任务号引用 → 自包含约束
   - 前：`/** 手机→agent 的统一指令（§5.1）。所有写操作共享 clientId 幂等（异常 #7）。 */`
   - 后：`/** 手机发给 agent 会话的指令合集；所有写指令以 clientId 作幂等键，重复投递同一 clientId 只会执行一次。 */`

2. 里程碑黑话 → 当前行为
   - 前：`/** 通知分类：M1 前台服务长连接据此驱动通知/红点，M0 只冻结取值域，不产生独立帧。 */`
   - 后：`/** 通知分类；当前版本只保留取值域、不单独产生帧，供前台长连接据此驱动通知与红点。 */`

3. 跨文件引用（同源）→ 把约束写出
   - 前：
     ```
     /**
      * 单字段载荷上限（截断后的总宽）：8192 字符 + "…(truncated)" 标记宽。
      * 与 server `eventFlood.ts` 的 `maxPayloadBytes + truncateMark` 同源——改动须双侧同步；
      * M1 由 schema 生成消除这份双写（protocol 包零内部依赖 server 侧，故此处独立定义同源值）。
      */
     ```
   - 后：
     ```
     /**
      * 单字段载荷上限（截断后的总宽）：8192 字符正文加截断标记 "…(truncated)" 的宽度。
      * 截断产物总宽恰好等于本值、必须被解析放行；本值与文本截断所用的上限必须相等，否则合法截断产物会被拒。
      */
     ```

4. 流程纪年（评审 Fix / 评审裁决 / 必办）→ 直接说约束
   - 前：`* **起始态窗口（评审 Fix 1）**：\`starting\` 必须先于适配器落地——先 \`#publishState("starting")\``
   - 后：`* **起始态窗口**：\`starting\` 必须先于适配器落地——先 \`#publishState("starting")\``

5. 设计小节号（§A / §C / §5.2）→ 领域语言
   - 前：`* §A：全系统唯一传输抽象——业务层（T8/T9/T11）只依赖本接口，不知 ws/TCP 细节。`
   - 后：`* 全系统唯一的传输抽象——业务层只依赖本接口，不关心 ws/TCP 细节。`

6. 危险值引用（C3）→ 约束本体
   - 前：`/** 手机可建会话的描述。permissionMode 白名单锁死（C3：手机不可升权）。 */`
   - 后：`/** 手机可申请的权限模式白名单：只允许 default 与 plan，手机侧不能申请更高权限。 */`

7. 测试断言目的（异常 #7 / 设计 C3）→ 业务语
   - 前：`expect(f).toBeNull(); // 设计 C3：手机不可传未知/越权模式`
   - 后：`expect(f).toBeNull(); // permissionMode 越权取值必须被拒：手机不能申请更高权限`

8. 报告/简报自引（详见报告、简报矛盾）→ 只留 why
   - 前：
     ```
     // 简报此处断言 toBe(1)，与「计数器从 0 起」（简报接口 TSDoc + 行为规格 1 + 本文件用例 1 的 0..199）矛盾：
     // 本调用是该会话的第一次 publish，故为 seq 0（详见报告「简报矛盾」一节）。
     ```
   - 后：
     ```
     // 本调用是该会话的第一次 publish，seq 从 0 起，故结果为 0。
     ```

9. 「见 XX 文件 / 见模块 TSDoc」→ 自包含
   - 前：`/** \`assistant\` 行 → 每个 \`tool_use\` 块一个 \`tool_call\`（文本块刻意跳过，见模块 TSDoc）。 */`
   - 后：`/** \`assistant\` 行 → 每个 \`tool_use\` 块一个 \`tool_call\`（文本块刻意跳过：同一文本已由 \`text_delta\` 增量送达）。 */`

10. 行内噪音（`// 别名`）→ 保留为可读 why（保持该行仍带注释）
    - 前：`const bus2 = bus; // 别名，语义更清楚`
    - 后：`const bus2 = bus; // 与返回的 bus 是同一实例，仅换个名字传入`

11. 迁移规则引用（§D 规则 4）→ 规则本体
    - 前：`/** 追加式迁移：仅执行幂等 schema。禁止 DROP/改列（§D 规则 4）。 */`
    - 后：`/** 追加式迁移：仅执行幂等 schema，不做 DROP 或改列。 */`

12. 冻结（流程语义）→ 不可变（技术语义）
    - 前：`* 全部字段在加载后冻结（\`readonly\`）；...`
    - 后：`* 全部字段在加载后不可变（\`readonly\`）；...`

## 拿不准而保留原样（附原因）

[A] 测试标题 / `describe` 名中的黑话 —— **字符串字面量，硬约束 #1 禁止改**（改即非注释改动、且会改测试输出）。
- `packages/protocol/src/__tests__/schema.test.ts`：`describe("M0 协议契约（冻结线）")`、`it("...冻结枚举内")`、`it("...与 eventFlood 截断同源")`
- `apps/server/src/auth/authenticator.test.ts`：`describe("M0 令牌供给（幂等）")`
- `apps/server/src/events/eventBus.test.ts`：`it("persist 失败不阻塞 ui 路（§11）")`、`describe("...非简报冻结用例...")`、`it("...（§12 保序）")`、`it("R1：bus seq 单权威 ...")`、`describe("...与截断同源")`
- `apps/server/src/session/sessionManager.test.ts`：`describe("SessionManager 编排（§C 三态）")`
- `apps/server/src/app/application.test.ts`：`describe("...（评审 Fix 1/2）")`
- `apps/server/src/agents/claude/claudeProtocol.test.ts`：`it("Step 2.1：...冻结序列...")`
- `apps/server/src/agents/claude/claudeSession.test.ts`：`it("M1 占位：...")`
- `apps/server/src/persistence/types.test.ts`、`.../sqliteConversationRepository.test.ts`：`it("...（异常 #7）")`
- `apps/server/src/persistence/sqlite/benchmarks/throughput.test.ts`：`describe("落库吞吐（§7 预算）")`

[B] 运行时提示文案（notice text）中的 "M1 接入" —— **实现即产出该字符串，测试逐字断言**，改文案即改行为/测试。
- `apps/server/src/agents/claude/claudeSession.ts:174`：`"附件 M1 接入，已忽略 " + ...`
- `apps/server/src/agents/claude/claudeSession.ts:188`：`"审批/提问交互 M1 接入"`
- 对应断言：`apps/server/src/agents/claude/claudeSession.test.ts:190-192`（同字符串，保留）

[C] `apps/server/__tests__/e2e_lan_stream.test.ts` —— **不在声明范围内**（范围是 `apps/server/src/**`）。该文件仍含 `M0` / `M0 性能预算` 等测试标题。未改动；如需覆盖，请把范围扩到 `apps/server/__tests__/`。

## 说明 / 备注
- 加粗：以上 [A] 的 `describe/it` 字符串与 [B] 的实现文案，是本次唯一未消化的黑话，原因是「零代码改动」与「字符串字面量不可动」的硬约束优先于措辞清理。
- 工作区存在 `apps/mobile/lib/**` 与 `apps/mobile/test/**` 的改动，来自并行的另一个整改单元，**本任务未触碰**。
- 未 commit（按约定由 controller 统一提交）。
