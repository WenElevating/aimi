# 注释规范整改 — TS 侧（packages/protocol + apps/server）

用户裁定的新注释规范（**本任务唯一规格，逐条执行**）：

【函数/类注释】
- 只说明：功能（一句话）、每个参数的含义与取值约束、返回值的含义、可能抛出的异常、副作用
- 用业务/领域语言描述，不要用代码里的变量名叙述执行流程
- 注释必须自包含，禁止出现"详见文档""参见README""参考XX链接"等引用式说法
- 不要复述实现细节

【行内注释】
- 仅在逻辑不显然时添加，且只解释"为什么这样做"（业务规则、边界情况、兼容性、性能原因）
- 不要翻译代码字面含义
- 没有必要的地方不加注释

【字段/类型注释（用户示例，原文照录）】
// ❌ 同义复述
interface Task {
  /** 任务ID */
  id: string;
  /** 任务状态 */
  status: string;
  /** 重试次数 */
  retryCount: number;
}
// ✅ 写出约束和含义
interface Task {
  /** 全局唯一，由服务端生成，创建后不可修改 */
  id: string;
  /** 任务当前状态，只能按 pending → running → done/failed 单向流转 */
  status: 'pending' | 'running' | 'done' | 'failed';
  /** 已重试次数，从 0 开始；达到 3 后任务会被标记为 failed，不再重试 */
  retryCount: number;
}

【风格】中文；保持现有块状格式（TS `/** */`）。

## 硬约束（违反=返工）
1. **零代码改动**：只允许注释行（`/** */` 块、`//` 行）增删改。任何标识符、字符串字面量、import、类型、逻辑一行都不能动。误删代码=最严重事故。
2. 公开导出的 doc comment 覆盖率保持 100%（数量不减——可以合并/重写，不能消失）。
3. 自包含禁词清单——出现即违规，全部要改写成自包含的业务语言：
   - 文档引用：「§」「设计 」「计划 」「Task 」「异常 #」「G4」「C3/C4/C5」等小节/任务编号引用
   - 流程引用：「controller」「裁决」「评审」「T8/T9/T11」「冻结」「ratification」「plan-mandated」
   - 跨文件引用：「对齐 XX 语义」「同源」「与 XX 保持一致」「详见」「参见」「见 XX 文件」——改为把约束本身写出来
   - 里程碑黑话：「M0」「M1」「M1 接入」「M1 由 XX 取代」——改写成**当前行为的描述**，如「本版本不接受，收到即忽略并提示」或「当前版本不提供，字段保留」；只有当"未来会提供"本身就是约束的一部分时才可提"后续版本"
4. 行内注释清理：删除纯字面翻译（`// 别名`、`// 跑红`、`// 序号+1`）与噪音；保留并改写真正的 why（如「Windows 下 shell:true 会派生孙进程，裸 kill 会留下孤儿进程树」这类）。
5. 测试文件同样整改（断言目的注释用业务语言写，如「断言重复的客户端流水号不会让指令执行第二次」而非「异常 #7」）。

## 范围
- `packages/protocol/src/**`（6 文件：agentEvents/agentCommands/sessionSpec/frames/zodFrames/__tests__/schema.test）
- `apps/server/src/**` 全部 .ts（logging/persistence(sqlite+memory)/auth/audit/transport(ws)/events/session/agents(claude)/app/ops/bin/__tests__/benchmarks）
- 用 grep 定位违规注释再逐文件改：模式 `§|Task |异常 #|M[01]|设计 |计划 |controller|裁决|冻结|评审|ratif|同源|对齐|详见|参见|参考`（注意"对齐"在正当业务语义如"多行对齐"时不动）。

## 验证
- `pnpm --filter @aimi/protocol test` → 8 passed；`pnpm --filter @aimi/server test` → 74 passed（16 files）——数字必须与改前完全一致
- `pnpm typecheck` → exit 0
- `git diff` 自查：确认 diff 里除注释行外无任何代码行变动（用 `git diff -U0` 核对，每行增删都应以 `*`、`/**`、`//` 或块边界为主）

## 禁止事项
- 不 commit（controller 统一提交）；不动 docs/**；不新增文件；不改报告外的其他工件。

## 报告
写入 `docs/superpowers/tasks/comment-sweep-ts-report.md`：改动文件清单、删除/重写的典型违规注释前后对照（≥5 组）、测试/typecheck 结果原文、你拿不准而保留原样的注释及原因。
回执 ≤10 行：Status / 文件数 / 测试一行 / 拿不准清单 / 报告路径。
