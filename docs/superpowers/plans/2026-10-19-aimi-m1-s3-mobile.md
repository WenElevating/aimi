# aimi M1-S3 移动端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Android 优先的局域网口径下，把现有 Flutter M0 骨架交付为可日用的 aimi 移动端：扫码/手动配对、持久化历史、断线续接、会话控制、审批、模型与权限选择、前台服务和本地通知，并完成 MuMu/模拟器验收。

**Architecture:** 服务端继续是单 Node 进程和既有 `Application` 组合根；只增加规格列出的协议兼容扩展、模型/权限接线、配置上限和 QR 指纹输出。移动端将连接、事件、通知和 Drift 写入集中到后台 isolate，UI 通过 Riverpod 读取本地镜像；LAN 和 fake relay 共用一个连接状态机，真实 relay 部署留给 S2。

**Tech Stack:** Node.js 22、TypeScript、Zod、Vitest、SQLite、Flutter/Dart 3.11、Riverpod、go_router、Drift、`mobile_scanner`、`flutter_secure_storage`、`flutter_local_notifications`、前台服务插件或 Kotlin FGS 壳、WebSocket。

**Spec:** `docs/superpowers/specs/2026-10-19-aimi-m1-mobile-design.md`

## Global Constraints

- Android 优先；iOS、桌面、平板和横屏不在本阶段交付。
- S1 既有协议语义、SQLite 既有数据和 WebSocket v1 帧保持向后兼容；只允许增加字段、放宽白名单或增加命令变体；保留现有对未知类型、非法枚举和缺失/错误类型字段的拒绝行为。
- 新客户端的 `capabilities.permissionModes` 是 `hello` 顶层可选能力声明；旧客户端不声明、不发送 `configure`。
- 未声明能力的连接按 `{default, plan}` 处理；welcome 中客户端未声明的高权限档位投影为 `default`，不修改服务端权威值。
- `agents.permissionCeiling` 默认 `default`；只有本机管理员显式配置后才允许更高档位。
- 令牌只能写入安全存储；UI、日志、截图和普通数据库不得回显明文 token。
- 本地镜像不能成为第二真相源；welcome 和按 seq 有序事件是服务端权威。
- `hello.resume` 缺会话表示从 seq 0 全量补发；本地零事件会话不发送 cursor；`lastSeq` 只能单调取 `max`。
- 离线 `send` 入队先落盘；断线/超时重发复用原 `clientId`，已收到 `rejected` 后的用户重试必须生成新 `clientId`。
- 不新增 relay 服务；S3 只实现 fake relay 状态机，真实 relay 部署和跨网验收归 S2。
- 不修改 `design.md`、`resources/` 或无关用户工作区改动；不提交生成物、数据库和日志目录。
- 每个任务采用 TDD：先红测试，再实现，再运行任务级测试；提交遵循 Lore trailer 和带 scope 的 Conventional Commit。

## Review Focus

- **旧客户端连接新服务端：** 未声明能力仍能完成 hello/welcome，且高权限会话不在旧客户端显示为未知值；由 Task 1 的协议 schema 和服务端 welcome 投影测试覆盖。
- **新客户端连接旧服务端：** 发送 `configure` 后收到 `protocol.bad_frame` 即停止重试并提示版本不兼容；由 Task 1 的兼容测试和 Task 4 的连接状态测试覆盖。
- **乱序、重复和缺洞事件：** 迟到低 seq 不回退水位，迟到旧 state 不覆盖新 state；由 Task 2 的纯函数合并测试覆盖。
- **离线命令幂等边界：** 超时重发保持原 clientId，明确 rejected 后重试生成新 clientId；由 Task 2 队列状态机测试覆盖。
- **权限安全边界：** create/adopt/configure 都受 `permissionCeiling` 约束，configure 重启失败保留新 spec 并落 failed；由 Task 1 服务端测试和 Task 3 集成测试覆盖。
- **TLS 首连信任：** QR 指纹 pin 失败必须拒绝，手动配对只允许 TOFU 语义；由 Task 3 连接测试和 Task 6 真机清册覆盖。

## File Map

### Protocol and server

- Modify: `packages/protocol/src/frames.ts`, `sessionSpec.ts`, `agentCommands.ts`, `zodFrames.ts`, `src/__tests__/schema.test.ts`
- Modify: `apps/server/src/app/application.ts`, `app/config.ts`, `app/config.test.ts`, `session/commands.ts`, `session/sessionManager.ts`
- Modify: `apps/server/src/agents/claude/claudeSession.ts`, `agents/claude/claudeAdapter.ts`, `agents/types.ts`
- Modify: `apps/server/src/persistence/types.ts`, `persistence/sqlite/schema.sql`, `sqliteConversationRepository.ts`, `sqliteRepositories.ts`, memory repositories and tests
- Modify: pairing/CLI modules that issue QR payloads and print pairing information

### Mobile data and connection

- Modify: `apps/mobile/pubspec.yaml`, `lib/data/protocol/frame_dto.dart`, `test/data/protocol/frame_dto_test.dart`
- Create or modify: `lib/data/db/*`, `lib/data/cache/*`, `lib/data/connection/*`, `lib/data/pairing/*`, `lib/data/notifications/*`
- Modify: `lib/app/providers.dart`, `lib/main.dart`, and their tests

### Mobile UI and Android

- Modify: `lib/app/router.dart`, `lib/app/theme.dart`, `lib/domain/session_view.dart`, existing dashboard/session/settings widgets
- Create: pairing, welcome, new-session, approval, and opening UI modules with widget tests
- Modify: `android/app/src/main/AndroidManifest.xml`, Kotlin service/receiver bridge, notification and FGS tests where supported

## Task 1: Freeze and Extend the Protocol/Server Contract

**Files:**
- Modify: `packages/protocol/src/frames.ts`, `sessionSpec.ts`, `agentCommands.ts`, `zodFrames.ts`
- Test: `packages/protocol/src/__tests__/schema.test.ts`
- Modify/Test: `apps/server/src/app/application.ts`, `apps/server/src/app/config.ts`, `apps/server/src/app/config.test.ts`, `apps/server/src/session/commands.ts`, `apps/server/src/session/sessionManager.ts`

**Interfaces:**
- Produce `HelloFrame.capabilities?: { permissionModes?: PhonePermissionMode[] }` and the same optional field on `HelloPairFrame`.
- Produce `PhonePermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions"`.
- Produce `AgentCommand` variant `{ cmd: "configure"; model?: string; permissionMode?: PhonePermissionMode }`.
- Produce optional `SessionMeta.model` and connection-aware welcome projection.
- Produce `ServerConfig.agents.permissionCeiling` with default `default`.

- [ ] **Step 1: Write protocol red tests.** Cover four permission values, configure payload validation, hello capabilities on both variants, optional session model, and rejection of malformed capability arrays.
- [ ] **Step 2: Run `pnpm --filter @aimi/protocol exec vitest run src/__tests__/schema.test.ts` and confirm the new cases fail.**
- [ ] **Step 3: Implement the TypeScript types and Zod schemas.** Preserve `resume: null`, existing frame types, and current malformed-frame rejection behavior; do not turn optional forward-compatible fields into a legacy-client failure.
- [ ] **Step 4: Write server red tests.** Cover old-client projection, declared-capability projection, permission ceiling rejection in create/configure, and old-server `protocol.bad_frame` handling at the client boundary.
- [ ] **Step 5: Implement server dispatch and compatibility rules.** Keep projection connection-scoped; never mutate persisted `permissionMode` when serializing a legacy welcome.
- [ ] **Step 6: Add/extend config tests.** Verify relative `dataDir`, `logDir`, TLS paths resolve from the config file directory, absolute paths remain unchanged, and default paths remain unchanged without a config file.
- [ ] **Step 7: Run `pnpm --filter @aimi/protocol test`, `pnpm --filter @aimi/server test`, `pnpm typecheck`, and `node tools/check-deps.mjs`.**
- [ ] **Step 8: Commit with Lore trailers.** Suggested intent: `feat(protocol): expose compatible model and permission controls`.

## Task 2: Persisted Session Mirror and Offline Queue

**Files:**
- Create/Modify: `apps/mobile/lib/data/db/*`, `lib/data/cache/*`
- Modify: `apps/mobile/lib/data/protocol/frame_dto.dart`
- Test: `apps/mobile/test/data/cache/*`, `test/data/protocol/frame_dto_test.dart`

**Interfaces:**
- `SessionMirror` exposes `upsertWelcome`, `applyEvent`, `eventsFor`, `resumeCursors`, and `archiveMissingSessions`.
- `OutgoingMessageStore` exposes `enqueue`, `markSent`, `markFailed`, `cancelQueued`, `recoverInFlight`, and `queuedInTsOrder`.
- A mirror event transaction inserts `(sessionId, seq)` and updates session metadata atomically.

- [ ] **Step 1: Add Drift dependencies and create the three tables.** Use `sessions`, `events(sessionId, seq)`, and `sentMessages`; include `model`, `permissionMode`, `lastSeq`, and the state projection sequence needed to reject stale state events.
- [ ] **Step 2: Write pure merge tests before implementation.** Cover welcome upsert without cursor movement, duplicate events, out-of-order events, gaps, `lastSeq = max`, stale state projection, `replay_capped` notice, and missing remote sessions becoming read-only archives.
- [ ] **Step 3: Implement `SessionMirror`.** Use one transaction for event insert plus projection update; batch large replay writes in chunks of about 500 rows without blocking UI reads.
- [ ] **Step 4: Write queue state-machine tests.** Cover write-before-send, delivered/duplicate to sent, rejected to failed, timeout retry up to three attempts, crash recovery to queued, and cancellation only from queued.
- [ ] **Step 5: Implement `OutgoingMessageStore`.** Only text `send` is queued; approve/answer/interrupt/configure remain direct commands.
- [ ] **Step 6: Update Dart DTOs and add JSON fixtures.** Support four permission modes, optional model, resumable, capabilities, pairing frames, configure, approve, answer, bye, errors, and resume maps while preserving strict frame rejection.
- [ ] **Step 7: Run `flutter analyze` and targeted cache/protocol tests.**
- [ ] **Step 8: Commit.** Suggested intent: `feat(mobile): persist session history and offline sends`.

## Task 3: Server Model/Permission Execution and Failure Semantics

**Files:**
- Modify: `apps/server/src/persistence/sqlite/schema.sql`, migration and repositories, memory repositories
- Modify: `apps/server/src/agents/claude/claudeSession.ts`, `claudeAdapter.ts`, `agents/types.ts`
- Modify: `apps/server/src/session/sessionManager.ts`, `session/commands.ts`, `app/application.ts`
- Test: persistence, session manager, Claude session, and server e2e tests

**Interfaces:**
- `SessionManager.configure(sessionId, patch)` runs through the existing per-session serial queue.
- `ClaudeSession.buildArgs` accepts persisted `model` and `permissionMode` and applies them to the next process.
- Process exit handling publishes `notice`, `state: failed`, persists `failed`, then retains the original `exit` event when an active handle exits unexpectedly.

- [ ] **Step 1: Write persistence red tests.** Add nullable `sessions.model`, four-value permission CHECK migration, row mapping, update/read round trips, and migration from the existing schema.
- [ ] **Step 2: Implement the SQLite table rebuild migration and repository updates.** Keep existing rows and IDs intact; do not change unrelated schema or protocol fields.
- [ ] **Step 3: Write session manager red tests.** Cover configure serialization, waiting-state rejection, ceiling rejection, persisted spec on restart failure, and all abnormal exit states from `starting`, `running`, `waiting_approval`, and `waiting_input` to `failed`.
- [ ] **Step 4: Add stale-handle tests.** An exit from a stopped/restarted/replaced handle may enter the event stream but must not alter the current handle's state or publish a duplicate failed state.
- [ ] **Step 5: Implement configure and failure convergence.** `delivered` is emitted only after persistence and new handle startup; restart failure returns `rejected/server.busy`, preserves the new spec, and leaves the session failed.
- [ ] **Step 6: Wire `--model`, permission mode, `agents.permissionCeiling`, and QR TLS fingerprint calculation/output.** Keep absolute config path normalization already present and add regression coverage rather than reimplementing it.
- [ ] **Step 7: Run server unit/e2e tests, `pnpm typecheck`, and `pnpm --filter @aimi/server build`.**
- [ ] **Step 8: Commit.** Suggested intent: `feat(server): make model changes and abnormal exits durable`.

## Task 4: Pairing, Resume Connection, TLS Pinning, and Fake Relay

**Files:**
- Modify: `apps/mobile/lib/data/connection/aimi_connection.dart`, `lib/data/protocol/frame_dto.dart`, `lib/data/pairing/*`, providers
- Test: `apps/mobile/test/data/connection/*`, pairing and fake-relay tests
- Modify: `apps/server/src/app/application.ts` only where the new hello capabilities and QR fields are consumed

**Interfaces:**
- `AimiEndpoints` carries LAN endpoint, optional relay endpoint, serverId, token, and optional pinned TLS fingerprint.
- `AimiConnection` exposes `offline`, `reconnecting`, `onlineLan`, and `onlineRelay`; LAN is attempted first and relay is selected after 3 seconds of LAN failure.
- `PairingRepository` stores endpoint metadata and token only through secure storage.

- [ ] **Step 1: Write connection tests.** Cover hello with resume cursors and capabilities, welcome-before-replay and replay-before-welcome ordering, `bye.taken_over`, `bye.revoked`, and old-server configure rejection without retry storm.
- [ ] **Step 2: Write pairing/TLS tests.** Cover QR parsing with optional `tlsFingerprint`, QR pin mismatch rejection, manual TOFU first-use/store and later mismatch rejection, and token absence from logs/UI-facing state.
- [ ] **Step 3: Implement pairing storage and QR/manual flows.** Keep manual entry as fallback; clear token and route to welcome on revoked.
- [ ] **Step 4: Implement the dual-endpoint connection state machine.** Reuse existing heartbeat/backoff behavior, preserve pending command semantics, and make relay migration observable through the connection state.
- [ ] **Step 5: Add an in-memory fake relay WebSocket test server.** Assert LAN loss switches to relay within 3 seconds, relay loss enters offline, and LAN recovery migrates back.
- [ ] **Step 6: Run targeted Flutter tests and `flutter analyze`.**
- [ ] **Step 7: Commit.** Suggested intent: `feat(mobile): add pairing resume and dual-link transport`.

## Task 5: Domain and Product UI Flows

**Files:**
- Modify: `apps/mobile/lib/app/router.dart`, `theme.dart`, `domain/session_view.dart`, existing dashboard/session/settings screens
- Create: `apps/mobile/lib/ui/opening/*`, `ui/welcome/*`, `ui/pairing/*`, `ui/new_session/*`, `ui/approval/*`
- Test: corresponding `apps/mobile/test/ui/*` and domain tests

**Interfaces:**
- Routes: `/welcome`, `/pairing/scan`, `/pairing/manual`, `/`, `/new-session`, `/session/:id`, `/settings`.
- `timelineOf` maps thinking, usage, permission, question, exit, notice, state, tool call, and tool result without inventing protocol values.
- Session and dashboard state are derived from mirror metadata; local outgoing messages render as pending user bubbles.

- [ ] **Step 1: Add domain tests.** Cover all event mappings, failed/stopped labels, approval expiration, permission/model picker state, and archive sessions with composer hidden.
- [ ] **Step 2: Implement token-driven theme and route shell.** Use `prototypes/codex` and `assets/tokens.css` as the visual source; keep Android portrait baseline 390x844.
- [ ] **Step 3: Implement opening and welcome states.** Opening is at most 3 seconds, fixed-seed, reduced-motion single frame, and does not block deep-link routing.
- [ ] **Step 4: Implement scan/manual pairing and dashboard.** Scan parses the QR payload, pairing ends directly in dashboard, expired pairing shows retry, and token is never rendered.
- [ ] **Step 5: Implement new-session and session composer.** New sessions start at `default`; model picker submits `spec.model`; in-session model and permission changes send configure; send/interrupt share one primary control.
- [ ] **Step 6: Implement timeline and approval/question sheets.** Render tool output excerpts, three approval actions, waiting badges, invalidated late approvals, auto-scroll pause/resume, and failed/stopped semantics.
- [ ] **Step 7: Implement settings.** Show server version/id, connection badge, notification category controls, autostart and battery guidance, and TLS trust reset; never show token.
- [ ] **Step 8: Run widget/domain tests and perform screenshot comparison against each prototype state in light/dark themes.**
- [ ] **Step 9: Commit.** Suggested intent: `feat(mobile): ship M1 session and pairing flows`.

## Task 6: Android Foreground Service, Notifications, and Startup Recovery

**Files:**
- Modify: `apps/mobile/pubspec.yaml`, `lib/data/notifications/*`, `lib/main.dart`, providers
- Modify/Create: `apps/mobile/android/app/src/main/AndroidManifest.xml`, Kotlin foreground service/receiver bridge
- Test: notification/domain tests; emulator/manual checklist for platform behavior

**Interfaces:**
- Background isolate owns WebSocket, Drift writes, and notification synthesis; UI only reads state and sends commands through the service bridge.
- Notification categories: approval, question, finished, failed, stalled, plus non-dismissible foreground-service channel.
- `BOOT_COMPLETED` restores the service only when endpoints/token exist and autostart is enabled.

- [ ] **Step 1: Select and pin the foreground-service implementation.** Prefer `flutter_background_service` only if it exposes Android `specialUse`; otherwise create the minimal Kotlin FGS shell without changing Dart-facing interfaces.
- [ ] **Step 2: Write notification synthesis tests.** Cover category defaults, in-app de-duplication, deep-link actions, stale approval cards, and disabled channels without retry storms.
- [ ] **Step 3: Implement background isolate ownership.** Move connection, mirror writes, queue recovery, and notification synthesis behind one service-owned entry point; desktop/test platforms silently no-op platform channels.
- [ ] **Step 4: Add Android manifest, notification permission, BOOT_COMPLETED receiver, autostart preference, and battery guidance.**
- [ ] **Step 5: Run `flutter analyze`, `flutter test`, and an emulator smoke test.** Record force-stop/vendor-cleaner behavior as observation only; swipe removal, low-memory recovery, and reboot must pass.
- [ ] **Step 6: Commit.** Suggested intent: `feat(android): keep sessions alive with foreground service`.

## Task 7: End-to-End Verification and MuMu Handoff

**Files:**
- Modify only as required by failed tests; add `docs/superpowers/evidence/2026-10-19-aimi-m1-s3-acceptance.md` if evidence logging is needed.
- Do not modify: `design.md`, `resources/`, unrelated dirty files.

- [ ] **Step 1: Run repository gates in order.** `node tools/check-deps.mjs`, `pnpm typecheck`, `pnpm -r test`, `pnpm --filter @aimi/server build`, `flutter analyze`, and `flutter test`.
- [ ] **Step 2: Start the server from a CWD outside the repository using a relative-path config.** Verify the resolved absolute data/log/TLS paths and that MCP gate/session data use the same data directory.
- [ ] **Step 3: Run server abnormal-exit acceptance.** Confirm `starting/running/waiting_approval/waiting_input + exit` produces notice, failed state, persisted failed state, and the original exit event; confirm finished/failed/stopped and stale handles do not duplicate failure.
- [ ] **Step 4: Run emulator/MuMu S3 workflow.** Verify QR/manual pairing, LAN badge, create Claude session, command ack plus events, resume after server restart, model/permission configure, approval, interruption, offline queue, and fake relay migration.
- [ ] **Step 5: Run Android service scenarios.** Swipe task removal, system activity reclaim, reboot/autostart, notification actions, category toggles, and record force-stop/vendor-cleaner limitations.
- [ ] **Step 6: Complete visual/accessibility review.** Compare core screens in light/dark themes to prototypes; check contrast >= 4.5:1, hit areas >= 44pt, reduced-motion behavior, and no token leakage in screenshots/logs.
- [ ] **Step 7: Record evidence and remaining risks.** Separate automated tests, emulator/MuMu results, and user-owned real-device acceptance; do not claim real relay or iOS closure.
- [ ] **Step 8: Create a final Lore-compliant integration commit only after all gates pass.** Include `Tested:` and honest `Not-tested:` trailers.

## Dependency Order

`Task 1 -> Task 2 -> Task 3 -> Task 4 -> Task 5 -> Task 6 -> Task 7`.

Task 1 can be split into protocol and server lanes after the protocol red tests establish the exact wire shape. Task 2's pure merge and queue tests may run in parallel with Task 3's SQLite tests, but Task 4 must consume the finalized DTOs and mirror interfaces. UI work begins only after the mirror and connection contracts are stable.

## Exit Criteria

- All task checkboxes are complete and each task has a focused commit.
- `node tools/check-deps.mjs`, `pnpm typecheck`, `pnpm -r test`, server build, `flutter analyze`, and `flutter test` pass.
- AC-S3-1 through AC-S3-14 from the spec have explicit evidence or are marked as user-owned/manual with the gap stated.
- No known protocol, persistence, permission-ceiling, stale-handle, resume, clientId, TLS, or token-leakage issue remains open.
- Real relay deployment, iOS, force-stop auto-recovery, and vendor cleaner auto-recovery remain explicitly outside S3 closure.
