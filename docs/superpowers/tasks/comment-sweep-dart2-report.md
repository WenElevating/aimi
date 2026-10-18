# 注释规范第二轮报告 — Dart 侧内容规则复查（apps/mobile）

- 范围：`apps/mobile/lib/**` 与 `apps/mobile/test/**` 全部 19 个 .dart 文件，逐文件通读全部注释（非 grep）
- 结果：**15 个文件**改动，全部为注释行（`///`、`//`）重写/补齐；代码零改动
- 验证：`flutter test` → 30 passed；`flutter analyze` → No issues found；`git diff -U0` 自查 → 改动行 100% 是注释行
- dartdoc 覆盖率：改动文件 `///` 行数 354 → 363（无一处注释被删除，公开 API 覆盖保持 100%）
- 未 commit（按要求交 controller 统一提交）

## 复查维度（对应用户内容规则）

| 维度 | 本轮判定口径 |
|---|---|
| 首句"做什么" | 类/函数/工厂注释第一句必须是业务动作，不是引用、不是实现步骤、不是名字复述 |
| 参数 | 含义、取值约束、单位、可否为 null；Dart 惯例用 `[方括号]` 引用参数名 |
| 返回值 | 含义与特殊取值（null / 空 / 负数代表什么）；异步说明 Future 完成或报错时的内容 |
| 异常 | 同步：什么条件抛什么；异步：Future 在什么条件下报错 |
| 副作用 | 写库、发请求、改入参、触发事件必须写出 |
| 字段注释 | 约束式（谁生成 / 取值范围 / 流转方向 / 失效条件），行尾不加句号 |
| 行内注释 | 只留"为什么"（业务规则、边界、兼容性、规避已知 bug），删字面翻译与噪音 |
| 引用式说法 | 「见 X」「见类文档」「见字段说明」等一律改为把约束直接写出来 |

## 改动文件清单（15）

| 文件 | ± 行 |
|---|---|
| lib/data/protocol/frame_dto.dart | 87 / 86 |
| lib/data/connection/aimi_connection.dart | 28 / 24 |
| lib/domain/session_view.dart | 13 / 13 |
| lib/ui/widgets/timeline_view.dart | 11 / 11 |
| lib/app/providers.dart | 9 / 9 |
| lib/ui/dashboard/dashboard_screen.dart | 7 / 4 |
| test/data/connection/aimi_connection_test.dart | 7 / 6 |
| lib/ui/widgets/state_badge.dart | 6 / 6 |
| lib/ui/settings/settings_screen.dart | 4 / 4 |
| lib/ui/session/session_screen.dart | 3 / 3 |
| lib/data/cache/session_cache.dart | 1 / 1 |
| lib/main.dart | 1 / 1 |
| test/data/protocol/frame_dto_test.dart | 1 / 1 |
| test/domain/session_view_test.dart | 1 / 1 |
| test/ui/widgets/state_badge_test.dart | 1 / 1 |

合计 `15 files changed, 180 insertions(+), 171 deletions(-)`（行数不等的三处来自"补一句约束/副作用"，其差值全部是新增的 `///` 行）。

通读后**判定无需改动**的 4 个文件：`lib/app/theme.dart`、`lib/app/router.dart`、`test/ui/widgets/timeline_view_test.dart`、`test/smoke_test.dart`（注释已满足首句动作+约束式字段+只讲为什么）。

## 典型对照（15 组）

### 1. 引用式说法 → 直接写约束（`lib/app/providers.dart` 存储键）

- 前：
  ```dart
  /// 安全存储的键名之一；配对功能接入后沿用同一组键，键名固定为主机/端口/令牌三要素。
  const String hostStorageKey = 'aimi.host';

  /// 见 [hostStorageKey]。
  const String portStorageKey = 'aimi.port';

  /// 见 [hostStorageKey]。
  const String tokenStorageKey = 'aimi.token';
  ```
- 后：
  ```dart
  /// 安全存储中主机键的键名；值为用户手填的 IP 或主机名，配对功能接入后沿用同一组键。
  const String hostStorageKey = 'aimi.host';

  /// 安全存储中端口键的键名；值以十进制字符串存放，解析失败按未配置处理。
  const String portStorageKey = 'aimi.port';

  /// 安全存储中令牌键的键名；配对时签发，只写设备安全存储。
  const String tokenStorageKey = 'aimi.token';
  ```
- 判定：原注释把约束"外包"给另一个符号，且 host 那条是同义复述；改为各自写清值的来源、存放形式与失效口径。

### 2. 函数注释引用别的注释 → 自己说清"推迟交付"的为什么（`lib/app/providers.dart`）

- 前：`/// `async*` 包装：见 [connStateProvider] 的注释（同步补发 → 微任务交付）。`
- 后：`/// 把连接状态的同步补发推迟到微任务后，避免在 widget build 期间修改 provider 状态而触发断言。`
- 判定：删掉"见 XX 的注释"，把规避 Riverpod 断言这一"为什么"直接写在被注释对象上。

### 3. 引用式说法 → 写出折叠规则本身（`lib/ui/widgets/timeline_view.dart`）

- 前：
  ```dart
  /// [call]/[result] 允许缺一半（见类文档）。
  ...
  /// [items] 为已算好的领域项（见字段说明）。
  ...
  /// [data] 为折叠后的行数据（见 [foldTimelineRows]）。
  ```
- 后：
  ```dart
  /// 允许缺一半：[call] 与 [result] 至少有一个非 null（重连中途进入会话时可能只见其一）。
  ...
  /// [items] 需为 `timelineOf` 产出的、已按 seq 升序的领域项（组件只做折叠，不重排）。
  ...
  /// [data] 为已折叠的一行：单条领域项或一张工具卡。
  ```

### 4. 方法注释不写"做什么"，只写字段名约束（`lib/data/protocol/frame_dto.dart`，`toJson` 共 9 处）

- 前：`/// 字段名与电脑端协议的同名结构逐字一致，任何一方单独改名都会造成解析失败。`
- 后：`/// 序列化为 JSON 对象；键名与电脑端协议的同名结构逐字一致，任何一方单独改名都会造成解析失败。`
- 另两处同源问题：
  - 前 `/// 字段名与电脑端协议的对应帧类型逐字一致，任何一方单独改名都会造成解析失败。` → 后 `/// 序列化为 JSON 对象；键名与电脑端协议的对应帧类型逐字一致，任何一方单独改名都会造成解析失败。`
  - 前：
    ```dart
    /// 字段名与电脑端协议的对应变体逐字一致；可选字段为 null 时省略该键。
    /// `exit.exitCode` 例外：协议规定为「可空但必填」，故始终写出（值为 null 也写）。
    ```
    后：
    ```dart
    /// 序列化为 JSON 对象：可选字段为 null 时省略该键，键名与电脑端协议的对应变体逐字一致，
    /// 任何一方单独改名都会造成解析失败；`exit.exitCode` 例外，协议规定为「可空但必填」，值为 null 也写出。
    ```

### 5. 字段注释缺"谁生成/取值约束"且行尾带句号（`lib/data/protocol/frame_dto.dart`）

- 前：
  ```dart
  /// 会话 id（server 生成的稳定标识）。
  final String id;

  /// 服务端最新事件序号：重连时以它作为本机续接的起点，与本地已写入进度之间的缺口不回补。
  final int lastSeq;

  /// 最后更新时间（server 毫秒时间戳）：看板卡按它降序排列。
  final int updatedAt;
  ```
- 后：
  ```dart
  /// 会话 id，由 server 生成并保持稳定
  final String id;

  /// 服务端最新事件序号；重连时以它作为本机续接的起点，与本地已写入进度之间的缺口不回补
  final int lastSeq;

  /// 最后更新时间，server 毫秒时间戳；看板卡按它降序排列
  final int updatedAt;
  ```
- 同批次：`SessionSpecDto`（5 字段）、`AttachmentDto`（2）、`ApprovalOptionDto`（2）、`ChoiceDto`（2）、`AgentEventDto`（19）、`SessionEventFrameDto`（4）、`SendCommandDto`（2）、`AimiEndpoints`/`AimiConnection`（12）、`session_view.dart`（12）、`timeline_view.dart`（8）、`state_badge.dart`（4）、测试桩（4）等字段注释统一去掉行尾句号并补上取值/来源约束。
- 定量：纯"只去掉句号"的行 34 处，其余随内容补齐同行完成。

### 6. 字段注释是同义复述（`lib/ui/widgets/timeline_view.dart`、`lib/ui/widgets/state_badge.dart`）

- 前：`/// 被渲染的领域项。` → 后：`/// 待渲染的领域项（文本 / 通知 / 状态，或孤立的工具结果）`
- 前：`/// 折叠后的行数据。` → 后：`/// 该行要渲染的内容（单条领域项或工具卡）`
- 前：`/// 展示文案。` → 后：`/// 展示文案；未知状态时原样回显协议值`
- 前：`/// 圆点与文字的强调色。` → 后：`/// 圆点与文字的强调色；未知状态回落中性灰`
- 前（`lib/domain/session_view.dart`）：`/// info/warn/error（决定 UI 颜色；取值域由协议层保证）。` → 后：`/// 严重级，取值限 info/warn/error，决定 UI 颜色；取值域由协议层保证`
- 判定：`label`/`color`/`severity` 这类名字已自解释，注释必须补"取值从哪来、越界怎么办"，否则就是复述。

### 7. 抛错条件不全（`lib/data/protocol/frame_dto.dart` 三处 `fromJson`）

- 前：`/// 从 welcome 帧的 JSON 构造；非法取值域（state/permissionMode 白名单外）抛 [FormatException]。`
  后：`/// 从 welcome 帧的 JSON 构造；字段缺失、类型不符，或 state/permissionMode 不在白名单时抛 [FormatException]。`
- 前：`/// 从 JSON 构造；`seq` 为负或字段缺失抛 [FormatException]。`
  后：`/// 从 JSON 构造；字段缺失或类型不符，以及 `seq` 为负时抛 [FormatException]。`
- 前：`/// 从 JSON 构造；未知 type 或缺失变体必需字段抛 [FormatException]。`
  后：`/// 从 JSON 构造；未知 type、取值域越界，或必需字段缺失/类型不符时抛 [FormatException]。`

### 8. 参数与副作用缺失（`lib/data/connection/aimi_connection.dart`）

- 前：`/// 发 `session.command`；`clientId` 由调用方生成（uuid），server 侧据此做幂等去重。`
- 后：
  ```dart
  /// 发送一条 agent 指令给 [sessionId] 会话；[clientId] 由调用方生成（uuid），
  /// server 侧据此做幂等去重，避免断线重发导致命令执行两次。
  ///
  /// 不等回执：离线或通道未就绪时静默丢弃（只记日志），调用方无从判断是否真的发出。
  ```
- 同类（补副作用）：`connect()` 增补 `/// 副作用：建立 WebSocket 通道、发 hello、启动心跳计时器，welcome 携带的元数据写入 cache。`

### 9. 返回值特殊取值与参数语义缺失（`lib/ui/dashboard/dashboard_screen.dart`）

- 前：`/// `updatedAt`（server 毫秒时间戳）→ 相对时间文案（看板卡右侧）。`
- 后：
  ```dart
  /// 把 server 毫秒时间戳转成「刚刚 / N 分钟前」这类相对时间文案（看板卡右侧）。
  ///
  /// [now] 只供测试注入时钟，缺省取当前时间；传入早于 [millis] 的时刻时各档均不命中，按「刚刚」返回。
  ```

### 10. 用符号名/箭头叙述执行流程（私有方法与类文档，共 7 处）

- 前：`/// 单帧入口：JSON 文本 → 契约解析 → 分发。非契约帧只记日志（防协议漂移的最内层）。`
  后：`/// 处理一条原始入帧：非文本、非法 JSON、非契约帧一律只记日志丢弃（防协议漂移的最内层）。`
- 前：`/// 单次连接尝试：建通道 → hello → 等 welcome（入 cache）。`
  后：`/// 执行一次连接尝试：成功则把 welcome 元数据写入 cache 并返回 true，失败返回 false。`
- 前：`/// 退避重连链：每次失败后按 [_backoffFor] 等待再试，直到成功或主动断开。`
  后：`/// 退避重连循环：每次失败后等待递增的间隔再试，直到连接成功或主动断开。`
- 前：`/// 通道中断（对端关闭/错误/心跳判死）的统一收口：拆通道 → reconnecting → 退避重连。`
  后：`/// 通道中断的统一收口：对端关闭、错误、心跳判死都走这里，落 [ConnState.reconnecting] 并排期重试。`
- 前（类文档）：`/// 保存 = 写 secure_storage + `invalidate(endpointsProvider)` → 连接层重建 → 自动连接。`
  后：`/// 保存的副作用：写 secure_storage 并 invalidate `endpointsProvider`，连接层随之重建并自动连接。`
- 前：`/// 弹层收参数 → `session.create` → 成功 push 时间线，失败 SnackBar 说明原因。`
  后：`/// 新建会话：弹层收集目录与首轮提示词后请求服务端，成功则打开新会话时间线，/// 失败用 SnackBar 说明原因。`
- 前（`providers.dart`）：`/// 连接三要素：从 secure_storage 异步读出；缺项/非法（端口不是数字）→ null（未配置）。`
  后：`/// 连接三要素：从 secure_storage 异步读出；缺项或非法（端口不是数字）时值为 null（未配置）。`

### 11. 类注释＝类名复述，零信息（`lib/data/protocol/frame_dto.dart` 五个类）

- 前：`/// `ping` 帧。` → 后：`/// 应用层心跳帧；与 pong 按 nonce 配对，用于判定链路是否仍然存活。`
- 前：`/// `session.create` 帧。` → 后：`/// 建会话帧；服务端成功后回 ack（携带新会话 id），失败回 error 帧。`
- 前：`/// `session.command` 帧。` → 后：`/// 指令帧；服务端执行前按 `clientId` 去重，同一 clientId 只执行一次。`
- 前：`/// `send` 指令。` → 后：`/// 发消息指令：正文与可选附件，由服务端转交给该会话的 agent。`
- 前：`/// `interrupt` 指令。` → 后：`/// 打断指令：中止该会话当前正在执行的回合，不带额外参数。`

### 12. 字面复述代码（`lib/ui/widgets/timeline_view.dart`）

- 前：`/// 工具卡：标题 = 工具名 + 入参摘要；展开显示结果摘录（等宽字体，便于读日志/代码）。`
- 后：`/// 工具卡：展开后显示结果摘录（等宽字体，便于读日志与代码）。`
- 判定：标题公式在 `_title` 里一眼可见，属字面翻译；保留的是"为什么用等宽字体"。

### 13. 测试断言辅助：参数与失败条件缺失（`test/data/connection/aimi_connection_test.dart`）

- 前：`/// 轮询等待条件成立（真实时钟推进，供真实 Timer 场景使用）。`
- 后：
  ```dart
  /// 轮询等待 [condition] 成立（真实时钟推进，供真实 Timer 场景使用）；
  /// 最多等 [tries] × [step]，仍未成立即断言失败。
  ```

### 14. 测试 dartdoc 名不副实（`test/data/protocol/frame_dto_test.dart`）

- 前：`/// 手机发往服务端的帧 JSON（字段名与电脑端协议逐字一致）。`（挂在 `void main()` 上，讲的是别的事）
- 后：`/// 客户端出帧与帧解析器的契约测试：覆盖各类帧的 JSON 形状，以及非法帧一律返回 null。`

### 15. 过期/越界引用（2 处）

- 前（`lib/app/providers.dart`）：`/// 但不直接引用 `data/transport` 的细粒度实现。` —— 仓库内已无 `data/transport` 目录，属失效路径
  后：`/// 但不直接 import 数据层实现细节——WebSocket 通道与镜像实现在本层装配。`
- 前（`lib/ui/widgets/state_badge.dart`）：`/// 会话七态（`SessionMeta.state` 取值域）+ 连接三态的徽标映射。` —— `SessionMeta` 是对端栈的类型名
  后：`/// 会话七态（协议 state 取值域）+ 连接三态的徽标映射。`

## 验证结果（原文）

- `flutter test`（在 `apps/mobile` 内执行）：
  ```
  00:02 +30: All tests passed!
  ```
  与改前一致：30 passed（一次不少）。
- `flutter analyze`（在 `apps/mobile` 内执行）：
  ```
  Analyzing mobile...
  No issues found! (ran in 1.8s)
  ```
- `git diff -U0` 自查：逐行判定"去首字符去前导空白后必须以 `//` 开头"（脚本 `check-comments.ps1`）：
  ```
  files touched: 15
  changed lines: +180 / -171
  OK: all changed lines are comments
  stat:  15 files changed, 180 insertions(+), 171 deletions(-)
  ```
- dartdoc 行数自查（`count-doc.ps1`，`git show HEAD:<file>` 对比工作区）：
  ```
  TOTAL dartdoc lines before=354 after=363
  ```
  15 个文件逐一 `after >= before`，无 `DOC-LOST`（公开 API dartdoc 覆盖率保持 100%）。
- 字段行尾句号自查（`check-period.ps1`）：剩余命中全部是**顶层变量/provider 注释与构造函数注释**，类/枚举/类型的实例字段已无句号。
- 纯句号规范化计数（`count-period.ps1`）：`period-only normalization pairs: 34`。

## 拿不准 / 保留原样清单

1. **字符串字面量中的跨栈用语（代码，按硬约束不动）**
   - `test/data/protocol/frame_dto_test.dart:8`（`'客户端帧：toJson 字段名与 TS 逐字一致（含 resume 恒 null）'`）、`:95`、`:119`（`'…对齐 zodFrames 宽进严出'`）、`:158`（`reason: 'state 取值域与 TS 一致'`）、`:179`（`reason: 'permissionMode 白名单锁死（C3：手机不可升权）'`）
   - `test/data/connection/aimi_connection_test.dart:300`、`:363`（测试名含"与 TS 逐字一致"，行号为本轮改动后的实际位置）
   - `test/domain/session_view_test.dart:33`（测试名含"M0 域外事件"）
   - `lib/ui/settings/settings_screen.dart:142`（用户可见提示，含"M0/M1"）、`lib/ui/dashboard/dashboard_screen.dart:256`（`'agent：claude（M0 固定）'`）
   - 理由：这些是 `test(...)`/`reason:` 的字符串参数与 UI 文案，改动即代码改动（返工项）。建议 controller 另开一个"文案与测试名"任务处理。
2. **顶层 const / provider 注释保留行尾句号**（如 `hostStorageKey`、`routerProvider`、`sessionsProvider`、`_permissionModes`）。理由：本轮规则原文限定"类/类型的每个字段"不加句号；顶层变量与 provider 属 dartdoc 叙述式，同一文件内保持一种风格（类/函数 doc 也用句号）比机械去句号更一致。
3. **`lib/app/providers.dart:12-18` 的悬空库级注释（接线层的依赖方向）保留**。理由：内容是架构约束（为什么这样接线），非引用式说法；Dart 允许 `///` 后接空行，analyzer 无告警，删掉会丢失"ui 不直接 import 数据层实现"的边界约定。
4. **`lib/ui/widgets/timeline_view.dart:8` 中的 `` `domain/session_view.dart` `` 保留**。理由：它写的是"折叠只做呈现层映射、不改领域层"这一约束本身（同仓库同栈路径），不是"与 TS 侧一致"式的一致性引用。
5. **`test/data/connection/aimi_connection_test.dart:14-15` 中 `` [AdapterWebSocketChannel] `` 保留**。理由：它解释的是本桩 `local/foreign` 方向约定的由来（真实适配器的方向语义），属"为什么"，非文档外包。
6. **私有成员的"无注释"处不改**（`_string`/`_int`/`_bool`/`_object`/`_objectList`、`_snack`、`_send`、`_interrupt`、`_status`、`_defaultDelay` 等）。理由：命名自解释、无隐藏约束，规则禁止为这类代码凑注释。

## 说明

改动全部位于 `apps/mobile/**`。工作区同时可见 `apps/server/**` 与 `docs/**`、`prototypes/**` 的改动，属其他并行任务/未被本任务触碰；本任务未 commit。
