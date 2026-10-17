# 注释规范整改报告 — Dart 侧（apps/mobile）

- 范围：`apps/mobile/lib/**` + `apps/mobile/test/**` 全部 .dart
- 结果：**16 个文件**改动，全部为注释行（`///`、`//`）重写；代码零改动
- 验证：`flutter test` → 30 passed；`flutter analyze` → No issues found
- 未 commit（按要求交 controller 统一提交）

## 改动文件清单（16）

| 文件 | 改动行数(±) |
|---|---|
| lib/data/protocol/frame_dto.dart | 140 |
| lib/data/connection/aimi_connection.dart | 28 |
| lib/app/providers.dart | 22 |
| lib/domain/session_view.dart | 16 |
| lib/ui/dashboard/dashboard_screen.dart | 14 |
| lib/data/cache/session_cache.dart | 12 |
| lib/ui/widgets/timeline_view.dart | 8 |
| lib/ui/session/session_screen.dart | 6 |
| lib/ui/settings/settings_screen.dart | 6 |
| lib/ui/widgets/state_badge.dart | 2 |
| lib/app/router.dart | 2 |
| lib/app/theme.dart | 2 |
| lib/main.dart | 2 |
| test/data/connection/aimi_connection_test.dart | 2 |
| test/data/protocol/frame_dto_test.dart | 2 |
| test/ui/widgets/state_badge_test.dart | 4 |

`git diff --stat` 汇总：134 insertions(+) / 134 deletions(-)——每处都是「注释行替换注释行」，注释行总数不变，公开 API dartdoc 覆盖率保持 100%（只重写、不删除）。

## 典型违规注释前后对照（12 组）

### 1. 跨文件引用「对齐 TS / 唯一真源」
`lib/data/protocol/frame_dto.dart`（文件头）
- 前：
  ```dart
  // aimi 协议的手写 Dart 镜像。**M0 过渡物**：M1 改由 packages/protocol 的 schema 生成
  // （计划中的 schema→Dart 生成），届时本文件整体删除。
  //
  // 唯一真源是 packages/protocol/src/*.ts；本文件的每个 JSON 字段名、取值域白名单都与
  // TS 逐字一致，改动必须同步 TS（CI 的 import/契约检查在 M1 补 schema 对比）。
  //
  // 解析语义对齐 zodFrames.ts 的「宽进严出」：非契约帧（v 不为 1、未知 type、未知取值域、
  // 缺字段/类型不符）一律降级为 null，绝不放行半截帧。
  ```
- 后：
  ```dart
  // aimi 协议的手机端手写 Dart 镜像，当前是过渡实现：尚未由协议定义自动生成，
  // 生成方案落地后整体替换。
  //
  // 以电脑端的协议定义为唯一依据：本文件的每个 JSON 字段名、取值域白名单都与它逐字一致；
  // 任何一方单独改名都会造成两端解析失败，改动必须两端同时进行。
  //
  // 解析采取宽松接收、严格校验：非契约帧（v 不为 1、未知 type、未知取值域、缺字段或类型不符）
  // 一律降级为 null，绝不放行半截帧。
  ```

### 2. 里程碑黑话「M1 换 Drift」
`lib/data/cache/session_cache.dart`
- 前：`/// 手机端内存镜像（M1 换 Drift 持久化，接口不变）。`
- 后：`/// 手机端会话镜像：当前只保留在内存，应用退出即清空；后续版本将改为持久化存储，公开接口不变。`

### 3. 流程引用 + 评审标记
`lib/data/cache/session_cache.dart`（`applyWelcome`）
- 前：
  ```dart
  /// welcome 帧的全量替换会话元数据，并把每会话光标对齐到服务端水位。
  ///
  /// 只替换元数据：事件与光标**不**清空——M1 断线重放要靠本地光标算缺口。
  /// **服务端水位对齐（评审 Fix 2）**：把 `_lastSeq` 设为 welcome 带回的 `lastSeq`，
  /// 断线缺口按「允许缺口」语义跳过（M1 重放补齐历史），冷启动/重连后流不再永久冻结
  ```
- 后：
  ```dart
  /// 用 welcome 帧的会话元数据全量替换本地元数据，并把每会话的写入光标推进到服务端水位。
  ///
  /// 只替换元数据：已缓存的事件与光标**不**清空，历史仍然可读。
  /// 光标推进到服务端下发的 `lastSeq` 后，重连产生的缺口按「允许缺口」语义跳过，
  /// 冷启动或重连后事件流不会因为本地光标停旧而永久停滞
  ```

### 4. 流程号引用「T14 冻结接口」
`lib/app/providers.dart`（`cacheTicksProvider`）
- 前：`/// 镜像版本号：`SessionCache` 是 T14 的冻结类，**没有变更通知流**，故用「事件帧 + 连接状态」`
- 后：`/// 镜像版本号：`SessionCache` 不提供变更通知流，故用「事件帧 + 连接状态」`

### 5. 章节号「§」引用
`lib/data/connection/aimi_connection.dart`（类文档）
- 前：
  ```dart
  /// 连接状态机（§5.3/§5.6/§7.3）：
  /// `connect → hello → welcome(元数据入 cache) → 事件流 → cache` 单向管道；
  /// ...
  /// [dispose] 后停止一切重连与心跳。错误帧仅记日志（M1 才做 UI 呈现）。
  ```
- 后：
  ```dart
  /// 连接状态机：
  /// 单向管道为：建立连接 → 发 hello → 收 welcome（元数据写入镜像）→ 事件流持续写入镜像；
  /// ...
  /// [dispose] 后停止一切重连与心跳。错误帧只记日志，不做界面呈现。
  ```

### 6. 编号引用「异常 #7」
`lib/data/protocol/frame_dto.dart`（`SessionCommandFrameDto.clientId`）
- 前：`/// 幂等键（uuid）：断线重发同一命令时 server 侧去重（异常 #7）。`
- 后：`/// 幂等键（uuid）：断线重发同一命令时由服务端去重，避免重复执行。`

### 7. 「评审 Fix 2 / 异常 #12」等流程编号
`lib/data/cache/session_cache.dart`（类文档）
- 前：`/// 事件写入前必须通过 seq 单调检查——这是异常 #12（人/agent 同时发消息）与断线补齐窗口内`
- 后：`/// 事件写入前必须通过 seq 单调检查——这是多来源并发（人与 agent 同时发消息）以及断线窗口内`

### 8. 「对齐 TS」逐字段复述
`lib/data/protocol/frame_dto.dart`（多处）
- 前：`/// 字段名与 TS `SessionMeta` 逐字一致。`
- 后：`/// 字段名与电脑端协议的同名结构逐字一致，任何一方单独改名都会造成解析失败。`

### 9. 业务约束被写成「对齐 TS」的字段注释
`lib/data/protocol/frame_dto.dart`（`AttachmentDto` 字段）
- 前：`/// base64 附件内容（TS 侧上限 1.4 MB）。`
- 后：`/// base64 编码的附件内容；服务端校验上限 1.4 MB，超出即被拒。`

### 10. 行内注释「T14 移交必办 + M0 无重放」
`lib/ui/dashboard/dashboard_screen.dart`
- 前：`// T14 移交必办：M0 无事件重放，重连期间的增量永久丢失，必须常驻告知用户。`
- 后：`// 重连期间的增量不会补发，恢复连接后从最新状态继续，必须常驻告知用户。`

### 11. 测试文件的引用式 dartdoc
`test/data/connection/aimi_connection_test.dart`
- 前：`/// server 侧 welcome 帧携带的会话元数据（字段名与 TS `SessionMeta` 逐字一致）。`
- 后：`/// 服务端 welcome 帧携带的会话元数据（字段名与电脑端协议逐字一致）。`

`test/ui/widgets/state_badge_test.dart`
- 前：`/// 会话七态（对齐 `SessionMeta.state` 取值域）。`
- 后：`/// 会话的七种合法状态。`

### 12. 行内噪音（纯 M0/M1 描述）
`lib/ui/widgets/timeline_view.dart`
- 前：`/// （M0 无重放，这是既知后果），此时仍渲染为一张卡而不是丢弃。`
- 后：`/// （重连期间错过的调用不会补发，这是既知后果），此时仍渲染为一张卡而不是丢弃。`

## 验证结果（原文）

- `flutter test`（apps/mobile 内）：
  ```
  00:03 +30: All tests passed!
  ```
  与改前完全一致：30 passed（总数未增未减）。
- `flutter analyze`（apps/mobile 内）：
  ```
  Analyzing mobile...
  No issues found! (ran in 19.2s)
  ```
- `git diff -U0` 自查脚本（仅注释行）：`OK: all changed lines are comments`
  （判定规则：每个 `+`/`-` 行去掉首字符并去掉前导空白后，必须以 `//` 开头；否则计入违规。结果 0 违规。）
- `git diff --stat -- apps/mobile`：`16 files changed, 134 insertions(+), 134 deletions(-)`

## 拿不准 / 保留原样清单

以下命中违禁词，但**位于字符串字面量或标识符中，属代码而非注释**；硬约束 #1（零代码改动）优先，故不改：

1. `lib/ui/settings/settings_screen.dart:142` — 用户可见文案字符串
   `'（M0 只支持局域网直连；扫码配对在 M1。）'`。改它会动字符串字面量（返工），保留；建议 controller 单独安排文案类整改任务。
2. `lib/ui/dashboard/dashboard_screen.dart:255` — 用户可见文案字符串
   `'agent：claude（M0 固定）'`。同上。
3. `lib/data/protocol/frame_dto.dart:261` — 异常消息字符串
   `FormatException('kind 不在裁决值域：$kind')`。含「裁决」，但为运行时错误文案（代码），不改。
4. 测试名称 / `reason:` 字符串（属测试断言的字符串参数，非注释）：
   - `test/domain/session_view_test.dart:33`（含「M0 域外事件」）
   - `test/data/protocol/frame_dto_test.dart:8、:95`（含「与 TS 逐字一致」）、`:119`（含「对齐 zodFrames 宽进严出」）、`:158`（reason 含「与 TS 一致」）、`:179`（reason 含「C3：手机不可升权」）
   - `test/data/connection/aimi_connection_test.dart:242、:254`（含「水位对齐 / 缺口对齐」）、`:299、:362`（含「与 TS 逐字一致」）
   这些是 `test('...')` 与 `reason:` 的字符串字面量，改动即代码改动，保留。

说明：`lib/data/connection/aimi_connection.dart` 中出现的 `_retryTask` 等标识符含子串 `Task`，经确认为代码命名，非引用式注释，未改动。

范围说明：本任务的改动全部位于 `apps/mobile/**`（`git diff --name-only` 过滤后 16 个文件）。工作树中同时可见 `apps/server/**`、`packages/protocol/**` 的改动，属于并行的 TypeScript 侧注释整改，非本任务产出，本任务未触碰。
