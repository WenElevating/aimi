# Task 18 最终评审收口修复（M0 全分支评审 3 条 Important）

一个修复 round 内全部关闭（同一 worktree `m0-skeleton`），一次提交。

## Fix 1 — 载荷上限契约统一

- `packages/protocol/src/zodFrames.ts`：新增 `export const PAYLOAD_CAP = 8192 + "…(truncated)".length;`，
  三处 `text_delta.text` / `thinking.text` / `tool_result.outputExcerpt` 上限由 `8 * 1024` 改为 `PAYLOAD_CAP`，
  并注释「与 server eventFlood.maxPayloadBytes+truncateMark 同源，改动须双侧同步；M1 由 schema 生成消除双写」。
- `apps/server/src/events/eventFlood.ts`：`maxPayloadBytes: 8192` 保持（语义=截断前的载荷预算），
  TSDoc 注明「截断后可达 PAYLOAD_CAP，见 protocol」。
- 回归测试：
  - `packages/protocol/src/__tests__/schema.test.ts` 追加「text_delta 8192+标记 载荷可解析」：8192+mark 帧
    `parseServerFrame` 非 null（此前会 null），略超上限仍 null。
  - `apps/server/src/events/eventBus.test.ts` 追加「truncatePayload 8204 帧经 parseServerFrame 往返不失」。

## Fix 2 — 手机端水位对齐

- `apps/mobile/lib/data/cache/session_cache.dart` `applyWelcome`：对每个 meta 设置 `_lastSeq[sessionId] = meta.lastSeq`
  （TSDoc：服务端水位对齐——断线缺口按「允许缺口」语义跳过，M1 重放补齐历史；冷启动/重连后流不再永久冻结）。
- 测试（`apps/mobile/test/data/connection/aimi_connection_test.dart`）：
  - 「welcome 水位对齐后 seq 续接（lastSeq=5 → 6,7 写入）」。
  - 「断线缺口对齐——本地 0 → welcome lastSeq=5 → seq 6 直接可流」。
  - 同步修订两处既有用例以匹配新水位语义（未知会话首帧 seq 0 / 连接透传下一条 = 1）。

## Fix 3 — session.create 审计

- `apps/server/src/audit/auditWriter.ts`：新增 `sessionCreate(identity, sessionId, detail)`，
  `action = "command.session_create"`，复用 `DETAIL_LIMIT`(2048) 截断；`command()` 签名不 fit（无 create 变体）故另设方法。
- `apps/server/src/app/application.ts` `#handleCreate`：注入 `identity`；成功路径记
  `sessionCreate(identity, meta.id, JSON.stringify(spec))`，失败路径记 `sessionCreate(identity, null, "error: " + message)`。
- 测试：
  - `apps/server/src/auth/authenticator.test.ts` 追加「sessionCreate 审计：成功带 sessionId+spec，失败 null+错误摘要」。
  - `apps/server/__tests__/e2e_lan_stream.test.ts` 追加断言 `command.session_create` 行 = 3（2 成功 + 1 agent_missing 失败）。

## 计划文本同步

- `docs/superpowers/plans/2026-10-17-aimi-m0-skeleton.md` T17 注记后追加「最终评审裁决记录」：
  - session.create 无 clientId（协议缺口，M1 破坏性扩展补幂等键）；
  - resumable 生命周期 M0 不可达（resume_hint 从未持久化——claudeSession.#sessionId 捕获后丢弃，M1 持久化接通）；
  - auth.pair/revoke 审计为死枚举（M1 配对/吊销接通）。

## 收尾验证（全绿）

| 门禁 | 结果 |
|---|---|
| `pnpm --filter @aimi/protocol test` | 8 passed |
| `pnpm --filter @aimi/server test` | 74 passed |
| `flutter test` | 30 passed |
| `pnpm typecheck` | 0 errors |
| `node tools/check-deps.mjs` | 38 file(s), 0 violations（exit 0） |
