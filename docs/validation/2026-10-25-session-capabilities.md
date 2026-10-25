# 会话体验、动态权限与目录浏览交付记录

日期：2026-10-25。移动端版本：`1.3.4+20`。

## 实现结果

- 状态栏安全区、标题栏及时间/事件行共用不透明背景，底部单条边界区分正文；覆盖浅色、深色主题和状态栏图标样式。
- 移除流式光标；服务端文本合并窗口从 100ms 降到 25ms，移动端按最多 16ms 窗口合并文本通知，语义边界立即刷新。
- 会话投影增量追加，复用历史轮次及控件，元信息与输入区不随每个 token 重建；用户上滑立即暂停跟随，回到底部恢复。
- 权限名称、描述、可用性来自 agent 适配器，经服务端策略过滤及会话权威快照下发，Flutter 不再枚举 Claude 权限。
- 当前 Claude SDK `0.3.310` 没有公开的“列出支持权限模式”查询 API。适配器对齐其公开 `PermissionMode` 类型，提供 `default`、`plan`、`acceptEdits`、`bypassPermissions`、`dontAsk`、`auto`；`auto` 的运行时资格保持 unknown，不能把类型存在解释成当前模型已支持。
- SDK 确认后更新模型/权限；失败返回拒绝并保留实际状态，组合请求部分成功如实体现。运行时状态回调优先，防止较晚 ACK 覆盖实际模式。
- 新客户端协商动态权限能力，旧客户端维持兼容帧；SQLite 在一个事务中迁移历史权限约束并校验外键。
- 目录浏览显式声明能力，修复 Windows 盘符根目录返回及非法路径，区分离线、不支持、超时和文件系统错误，防止使用过期选择。

简化：移除光标组件、全历史重复投影和移动端固定权限列表，复用既有连接、事件序号、配置确认及 UI 组件。

## 自动化验证

以下为实际运行结果；最终版本变更与本文档以外的源代码已经包含在两个修复提交中。

| 命令 | 实际结果 |
| --- | --- |
| `node tools/check-deps.mjs` | `59 file(s) scanned, 0 violations` |
| `pnpm typecheck` | 退出码 0 |
| `pnpm -r test` | protocol：33 passed；server：45 files、315 passed |
| `pnpm --filter @aimi/server build` | `tsc -p tsconfig.build.json`，退出码 0 |
| 对改动 TypeScript 文件执行 ESLint | 通过 |
| `flutter analyze --no-pub` | `No issues found! (ran in 47.1s)` |
| `flutter test --no-pub` | `+194: All tests passed!` |
| 最终 EventBus/LAN 定向回归 | 23 passed |
| `flutter build apk --release --no-pub` | `Built ...app-release.apk (73.5MB)`，126.6s |
| 修复提交的 pre-commit | Prettier、ESLint、密钥扫描通过，未绕过 hook |

集成回归覆盖真实鉴权 WebSocket 的目录请求、权限成功与拒绝、组合请求部分成功、SQLite 持久化及动态/旧客户端重连。迁移测试覆盖旧两模式/四模式表、关联对象保留及失败回滚。

性能证据：全量后端测试的 loopback n=20、P95=30ms；后续定向回归约 32ms。长历史投影实验（2201 条历史事件、300 条增量）全量约 72.8ms，增量约 5.4ms，最终投影一致。以上属于本机自动化证据，不能替代 Android 帧耗时与网络实测。

浅/深色 Widget 渲染及像素断言验证 24px 模拟安全区、标题和事件行背景连续。截图使用 Windows 字体；没有真实 Android 状态图标和系统合成器证据。

## 运行服务和数据库

- 确认旧服务没有活跃会话后完成数据库与配置备份，并以更新后的源码启动服务。交付核对进程 PID：34856；启动时间：2026-10-25 20:30:45。
- 沿用原有 `node --import tsx ... start` 运行方式。现有 TypeScript 构建不会复制 `schema.sql`，本轮未改用 dist 启动。
- 本机配置显式允许 Claude 六个模式；默认源代码策略不因此自动授权新增模式。
- 迁移前后会话均为 34 条、事件均为 936 条；外键错误为 0。
- 已鉴权 TLS WebSocket 实测目录能力为 true、根目录结果 2 项、六个权限描述完整；前五项 available，auto 为 unknown。
- 备份位于本机数据目录 `data/backups/before-dynamic-permissions-20261025.db` 及同名配置备份；配置包含凭据，不提交、不展示。
- 回滚须停止服务并恢复匹配的数据库/配置备份和旧版本代码；不要直接让旧迁移逻辑写入新结构数据库。恢复备份前须另行保留发布后的新增数据。

## APK 发布

发布命令使用 APK 绝对路径，避免 workspace 子命令工作目录变化导致读取错误文件：

```powershell
pnpm --filter @aimi/server exec tsx src/bin/aimi-server.ts publish-apk <absolute-app-release.apk> --notes '动态权限目录、目录浏览修复、统一会话顶栏及增量流式输出'
```

真实输出：

```text
已发布 1.3.4+20（77059852 字节, sha256 239dd050…）
已通知运行中服务：在线手机将立即收到更新推送。
```

核对发布清单：versionName=`1.3.4`、versionCode=`20`、downloadPath=`/updates/app-20.apk`。构建 APK、发布 APK 和 manifest 三者 SHA-256 一致：

```text
239dd0508e7057a43f938bc25bd438dc3eb2edcdd2f4c894926fafb89115700e
```

构建仍有现存 CupertinoIcons 字体提示，但成功产出 APK；本轮没有新增依赖。

## 验收边界

没有连接 Android 设备；未完成 Android profile 帧耗时、真实状态栏视觉、弱网流式体验及真实 Claude 工具审批验证。服务刷新通知成功不等于手机已经接收或安装。`auto` 是否适用于当前模型/提供商仍需实际 SDK/CLI 确认。

建议安装版本 20 后实测浅/深色顶部连续性、长会话输出和上滑、六种权限的实际确认/拒绝，以及目录进入/返回。

## 改动文件清单

下列清单相对基线 `0ac7f66`，包括测试与本交付记录。
- `apps/mobile/lib/app/providers.dart`
- `apps/mobile/lib/app/session_render_provider.dart`
- `apps/mobile/lib/data/cache/session_mirror.dart`
- `apps/mobile/lib/data/connection/aimi_connection.dart`
- `apps/mobile/lib/data/protocol/frame_dto.dart`
- `apps/mobile/lib/domain/session_view.dart`
- `apps/mobile/lib/ui/new_session/directory_picker_screen.dart`
- `apps/mobile/lib/ui/session/composer.dart`
- `apps/mobile/lib/ui/session/session_screen.dart`
- `apps/mobile/lib/ui/session/shimmer_line.dart`
- `apps/mobile/lib/ui/widgets/timeline_view.dart`
- `apps/mobile/pubspec.yaml`
- `apps/mobile/test/app/session_render_provider_test.dart`
- `apps/mobile/test/data/cache/session_mirror_test.dart`
- `apps/mobile/test/data/connection/aimi_connection_test.dart`
- `apps/mobile/test/data/protocol/dynamic_permissions_test.dart`
- `apps/mobile/test/data/protocol/frame_dto_test.dart`
- `apps/mobile/test/domain/conversation_projection_test.dart`
- `apps/mobile/test/ui/directory_picker_test.dart`
- `apps/mobile/test/ui/session/composer_test.dart`
- `apps/mobile/test/ui/session/session_chrome_test.dart`
- `apps/mobile/test/ui/session/session_permission_confirmation_test.dart`
- `apps/mobile/test/ui/session/session_screen_test.dart`
- `apps/mobile/test/ui/widgets/timeline_view_test.dart`
- `apps/server/__tests__/e2e_directory.test.ts`
- `apps/server/__tests__/e2e_lan_stream.test.ts`
- `apps/server/__tests__/e2e_permission_configure.test.ts`
- `apps/server/src/agents/claude/claudeAdapter.ts`
- `apps/server/src/agents/claude/claudePermissions.ts`
- `apps/server/src/agents/claude/claudeSession.test.ts`
- `apps/server/src/agents/claude/claudeSession.ts`
- `apps/server/src/agents/permissions.ts`
- `apps/server/src/agents/types.ts`
- `apps/server/src/app/application.ts`
- `apps/server/src/app/config.test.ts`
- `apps/server/src/app/config.ts`
- `apps/server/src/events/eventBus.test.ts`
- `apps/server/src/events/eventBus.ts`
- `apps/server/src/events/eventFlood.ts`
- `apps/server/src/persistence/sqlite/migrate.test.ts`
- `apps/server/src/persistence/sqlite/migrate.ts`
- `apps/server/src/persistence/sqlite/schema.sql`
- `apps/server/src/session/sessionManager.test.ts`
- `apps/server/src/session/sessionManager.ts`
- `design.md`
- `docs/validation/2026-10-25-session-capabilities.md`
- `packages/protocol/src/__tests__/schema.test.ts`
- `packages/protocol/src/frames.ts`
- `packages/protocol/src/sessionSpec.ts`
- `packages/protocol/src/zodFrames.ts`
