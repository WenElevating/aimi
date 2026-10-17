# aimi M0「骨架跑通」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机（Android）通过局域网直连 aimi-server，实时看到 claude code 会话流并能打断——产品核心假设的最快验证。

**Architecture:** pnpm monorepo 四件套（packages/protocol 单一协议源 + apps/server + apps/relay(仅占位) + apps/mobile(Flutter)）。server 按 §5.2 五层划分：transport(ws 实现 Conveyor 抽象) / auth(token 鉴权) / session(编排) / agents(registry+claude 适配器) / events(总线) + persistence(四仓储接口, Sqlite+Memory 双实现) / 横切 audit-logging-ops。

**Tech Stack:** Node.js 22 LTS + TypeScript 5(next) · zod · better-sqlite3(WAL) · ws · pnpm workspaces · Flutter 3.24+ (Riverpod 2.x / GoRouter / web_socket_channel / flutter_local_notifications 暂不接入)

**设计文档:** `docs/superpowers/specs/2026-10-17-aimi-v1-design.md`（本计划所有决策的出处）

## Global Constraints（从设计文档逐条复制，全部任务隐含遵守）

| # | 约束（原句） | 验证落点 |
|---|---|---|
| C1 | Flutter 双端 + Node.js 22/TS 的 server 与 relay + 自建 WS 哑管道中继（Caddy/TLS 为 M1） | monorepo 结构测试（T1） |
| C2 | SQLite(WAL) 唯一权威存储；持久层抽象为 `ConversationRepository`（后缀 Repository）；业务模块禁止直连存储实现；可替换其他数据库/OSS | T4/T5 接口 + T5 落库吞吐基准 |
| C3 | server 仅 Windows 10/11；手机 **Android 领先一拍**（v1 全量），iOS 划出 | 本计划只做 Android |
| C4 | 命名取自真实业务语义，禁止 tmp/util/M0_x/helper×n | T1~T17 命名评审（每任务 PR 自查项） |
| C5 | 注释：公开 API 100% doc comment（TS=TSDoc；Dart=dartdoc），注释回答 why | T1 起每任务代码含 TSDoc/dartdoc |
| C6 | 高内聚低耦合，单向依赖，禁止一锅炖 | T18 import 方向静态检查 |
| C7 | Conventional Commits：`feat(server)/fix(mobile)/refactor(protocol)/docs/specs…` | 每任务提交步 |
| C8 | 单测/集成/性能/压力测试闸门不过关不交付 | 每任务 TDD 步骤 + T5 基准 + T17 冒烟 |
| C9 | 自用：无账号体系 | —（不适用理由） |
| C10 | 大陆网络 FCM 不可达：通知经前台服务长连接（M1）；relay 云资源预留（M1 即插） | M0 不做通知与 relay 部署（明确非范围） |
| 性能 | 事件呈现延迟（agent产生→手机渲染）LAN ≤ 1000 ms P95；重放吞吐 ≥ 500 events/s（M1）；落库 ≥ 500 events/s | T5 基准 / T17 冒烟计时 |
| 顺序性 | eventBus 单线程序列化、会话事件 seq 单调递增；显示顺序=发生顺序 | T8 单测 |
| 幂等 | 写操作携带 clientId 去重（断线重发 approve/interrupt 不执行两遍） | T9 去重单测 |
| 洪水 | text_delta ≤ 100 ms 聚合；payload > 8 KB 截断为摘录+截断标记 | T8 单测 |
| 审计 | 每条远程命令 `{ts, device_id, sessionId, action, detail}` 落 audit + 文件 | T6+T8 单测 |
| 安全 | device token 仅存 SHA-256；逐帧校验；手机不可升权 permissionMode | T6 单测 + T11 守卫 |
| M0 非范围 | 配对 QR / mDNS / 重放 / 单设备锁 / relay 上线 / 通知链 / codex·opencode·zcode 适配 / Windows 自启 —— 均 M1+（在文件结构表标注归属） | — |

**执行环境备注**：Windows 11 + Node 22 LTS + Flutter stable（Android 平台工具链就绪）。四家 CLI 已原生安装且授权（claude/codex/opencode/zcode——本计划仅用 claude；其余 M2）。

---

## File Structure（M0 全量文件地图）

除另有标注，路径相对仓库根 `D:\AiProject\aimi`。`(M1)` 标注的文件不在本计划内——列出来防"越界重建"。

```
package.json                       pnpm workspaces 根（server/relay 包）
pnpm-workspace.yaml                workspace 定义
tsconfig.base.json                 TS 基线（strict, node22）

packages/protocol/
  package.json                     协议包（无运行时依赖，仅 zod）
  tsconfig.json
  src/index.ts                     统一出口
  src/agentEvents.ts               AgentEvent 联合类型（§5.1）
  src/agentCommands.ts             AgentCommand 联合类型（§5.1）
  src/sessionSpec.ts               SessionSpec / SessionMeta / SessionState
  src/frames.ts                    链路层+领域层 Frame 联合类型（link/domain）
  src/zodFrames.ts                 帧校验 schema（zod 单源）
  src/__tests__/schema.test.ts     schema 往返校验测试

apps/server/
  package.json                    （ts-node 运行 + vitest）
  tsconfig.json
  vitest.config.ts
  src/bin/aimi-server.ts           CLI 入口（start/status/lan-token）
  src/app/config.ts                配置加载（config.yaml + zod 校验 + 默认值）
  src/app/application.ts           启动装配（new 各模块接线）
  src/logging/logger.ts            JSON 行日志（分级/tag/按天滚动 stub=单文件追加）
  src/logging/logger.test.ts
  src/persistence/types.ts         四仓储接口（Conversation/Device/CommandDedup/Audit）
  src/persistence/memory/          Memory 四实现（测试用）
  src/persistence/sqlite/          Sqlite 三实现 + schema.sql + migrate.ts
  src/persistence/purge.ts         (M1) 保留策略执行
  src/transport/conveyor.ts        Conveyor 抽象（§A：open/send/onFrame/close)
  src/transport/ws/lanServer.ts    LAN WebSocket 服务（绑定 Conveyor 实例工厂）
  src/transport/ws/messagePipe.ts  帧↔socket 收发与逐帧回调
  src/auth/deviceRepository.ts     （re-export persistence DeviceRepository 使用面）
  src/auth/authenticator.ts        Authenticator（token 校验/逐帧校验/挂接审计）
  src/auth/configProvisioner.ts    M0 配对替代：lan-token 生成+打印
  src/events/eventBus.ts           EventBus（单线程扇出+seq 分配）
  src/events/eventFlood.ts         洪水控制（聚合窗+截断）
  src/events/uiFanout.ts           会话事件→Frame(session.event) 广播
  src/session/sessionMachine.ts    会话状态机（跃迁白名单）
  src/session/sessionManager.ts    编排核心（new/resumable/archived 三态语义）
  src/session/commands.ts          手机命令编排入口（ городах+audit+dedup）
  src/agents/registry.ts           CLI 安装检测 + 适配器注册表
  src/agents/claude/claudeAdapter.ts     适配器+SessionSpec 工厂
  src/agents/claude/claudeSession.ts     子进程托管（spawn/stream-json/打断）
  src/agents/claude/claudeProtocol.ts    协议归一化（NDJSON→AgentEvent 纯函数）
  src/agents/claude/__fixtures__/*.jsonl 录制的协议回放样本
  src/audit/auditWriter.ts         auditlog（业务+鉴权事件同行写入）
  src/ops/health.ts                status 子命令的数据聚合
  src/ops/configStore.ts           (M1) — 暂无
  data/                            运行时数据（gitignore）
  __tests__/e2e_lan_stream.test.ts LAN 全链路 e2e（WS 客户端模拟手机）

apps/mobile/                       Flutter 工程（一个仅 Android 目标）
  lib/main.dart                    入口+Theme（设计 token 骨架）
  lib/app/router.dart              GoRouter：/ ↔ /session/:id
  lib/app/theme.dart               色板/字距（M0 组件级，不追求视觉专项）
  lib/data/protocol/frame_dto.dart Dart 帧模型手写镜像（M1 改由 schema 生成）
  lib/data/connection/aimiConnection.dart 连接状态机（connect/hello/ping/事件流）
  lib/data/cache/sessionCache.dart 手机端内存镜像（M1 换 Drift 持久镜像）
  lib/domain/sessionView.dart      纯函数：事件流→会话视图模型（看板卡/时间线项）
  lib/ui/dashboard/dashboardScreen.dart   会话看板
  lib/ui/session/sessionScreen.dart       时间线+输入框+打断按钮
  lib/ui/settings/settingsScreen.dart     手动填 LAN 地址/端口/token（M0 配对替代）
  pubspec.yaml
```

**M0 明确不建（防越界）**：`apps/relay/` 完整实现（仅 `src/bin/aimi-relay.ts` 打印"预留，M1"的占位不写——干脆不建目录）、mDNS 广播、Drift 缓存、通知、协议 Dart 代码生成 CI、Windows 任务计划脚本、重放/resume。

---

### Task 1: monorepo 骨架与工程基线

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`（追补）, `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`, `packages/protocol/package.json`, `packages/protocol/tsconfig.json`, `apps/mobile/.gitkeep`

**Interfaces:**
- Consumes: 无（起始任务）
- Produces: pnpm workspace；`aimi-protocol` 包可被 `@aimi/server`（packages/protocol 的 package name=`@aimi/protocol`）import；`pnpm -r exec tsc --noEmit` 全绿

- [ ] **Step 1: 建根配置**

`package.json`:
```json
{
  "name": "aimi-monorepo",
  "private": true,
  "engines": { "node": ">=22" },
  "scripts": {
    "typecheck": "pnpm -r exec tsc --noEmit",
    "test": "pnpm -r --filter ./apps/server test",
    "serve": "pnpm --filter @aimi/server dev"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`tsconfig.base.json`:
```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  }
}
```

`.gitignore` 追加：
```
apps/server/data/
node_modules/
apps/mobile/build/
apps/mobile/.dart_tool/
```

`apps/server/package.json`:
```json
{
  "name": "@aimi/server",
  "version": "0.1.0",
  "type": "module",
  "bin": { "aimi-server": "dist/bin/aimi-server.js" },
  "scripts": {
    "dev": "tsx watch src/bin/aimi-server.ts start",
    "test": "vitest run",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@aimi/protocol": "workspace:*",
    "better-sqlite3": "^11.0.0",
    "js-yaml": "^4.1.0",
    "ws": "^8.18.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`apps/server/tsconfig.json`:
```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "references": [{ "path": "../../packages/protocol" }],
  "include": ["src", "vitest.config.ts"]
}
```

`apps/server/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

/** M0 测试配置：单文件进程足够（Node 单进程事件循环与生产一致）。 */
export default defineConfig({
  test: { include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"] },
});
```

`packages/protocol/package.json`:
```json
{
  "name": "@aimi/protocol",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run" },
  "dependencies": { "zod": "^3.23.0" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0" }
}
```

> **Controller 注（Task 1 执行后修订）**：Task 1 实际提交中 protocol tsconfig 含 `composite: true`（server references 所需，TS6306），且 `apps/server/tsconfig.json` include 收窄为 `["src"]`（TS6059）、两处占位 index.ts 由 T2/T3 覆盖/移除；`better-sqlite3` 采用 `^12.0.0`（Node 24 预编译）。后续任务以此为准。

`packages/protocol/tsconfig.json`:
```jsonc
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

- [ ] **Step 2: 安装与验证**

Run: `pnpm install`
Expected: 生成 lockfile，无 peer 冲突。

Run: `pnpm typecheck`
Expected: 通过（当前无源码，仅空转）。

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore packages/protocol/package.json packages/protocol/tsconfig.json apps
git commit -m "chore(monorepo): pnpm workspace 骨架与 TS 基线（server/protocol 两包）"
```

---

### Task 2: packages/protocol —— 统一事件/指令/帧契约（单一协议源）

**Files:**
- Create: `packages/protocol/src/agentEvents.ts`, `src/agentCommands.ts`, `src/sessionSpec.ts`, `src/frames.ts`, `src/zodFrames.ts`, `src/index.ts`, `src/__tests__/schema.test.ts`

**Interfaces:**
- Consumes: zod
- Produces（后续所有任务的契约，签名冻结）：
  - `AgentEvent` 10 变体；`SessionState`；`ApprovalDecision = "once"|"always"|"reject"`
  - `AgentCommand(unified)`：`Send{text,files?}` 等（类型名 `AgentCommand`）
  - `Frame` 联合：`HelloFrame/WelcomeFrame/PingFrame/PongFrame/ByeFrame/SessionCreateFrame/SessionCommandFrame/SessionEventFrame/AckFrame/ErrorFrame`
  - `SessionEventFrame.event = { sessionId: string; seq: number; ts: number; agentEvent: AgentEvent }`
  - 运行时校验：`parseClientFrame(raw: unknown): ClientFrame | null`、`parseServerFrame(raw: unknown): ServerFrame | null`

- [ ] **Step 1: 先写 schema 测试（红）**

`packages/protocol/src/__tests__/schema.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseClientFrame, parseServerFrame } from "../zodFrames.js";

describe("M0 协议契约（冻结线）", () => {
  it("hello 帧必须带 token", () => {
    expect(parseClientFrame({ v: 1, type: "hello", token: "abcd1234efgh", resume: null })).toMatchObject({ type: "hello" });
    expect(parseClientFrame({ v: 1, type: "hello" })).toBeNull();
  });

  it("session.create 必须拒绝手机升权 permissionMode", () => {
    const f = parseClientFrame({
      v: 1, type: "session.create",
      spec: { agentId: "claude", cwd: "D:/work", permissionMode: "danger-off" },
    });
    expect(f).toBeNull(); // 设计 C3：手机不可传未知/越权模式
  });

  it("session.event 服务帧往返", () => {
    const raw = {
      v: 1, type: "session.event", sessionId: "s1", seq: 3, ts: 1729142400000,
      agentEvent: { type: "text_delta", text: "hello" },
    };
    expect(parseServerFrame(raw)).toEqual(raw);
  });

  it("未知帧类型一律 null（防协议漂移）", () => {
    expect(parseClientFrame({ v: 1, type: "hocus.pocus" })).toBeNull();
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm --filter @aimi/protocol test`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写协议源码**

`src/agentEvents.ts`:
```ts
/** agent 会话状态（§5.1 灵魂：waiting_* 驱动红点/通知/徽标）。M0 仅 flowing 子集运行。 */
export type SessionState =
  | "starting" | "running" | "waiting_approval" | "waiting_input"
  | "finished" | "failed" | "stopped";

export type NotificationKind =
  | "pending_approval" | "pending_question" | "finished" | "failed" | "stalled";

/** 归一化事件流：四家 agent 的私有协议都被翻译成它（§5.1 契约）。 */
export type AgentEvent =
  | { readonly type: "state"; readonly state: SessionState }
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "tool_call"; readonly id: string; readonly name: string; readonly summary: string; readonly inputDigest: string }
  | { readonly type: "tool_result"; readonly id: string; readonly ok: boolean; readonly outputExcerpt: string; readonly exitCode?: number }
  | { readonly type: "permission"; readonly id: string; readonly title: string; readonly detail: string; readonly options: readonly ApprovalOption[] }
  | { readonly type: "question"; readonly id: string; readonly prompt: string; readonly options: readonly Choice[] }
  | { readonly type: "usage"; readonly tokensIn: number; readonly tokensOut: number; readonly cost?: number }
  | { readonly type: "notice"; readonly severity: "info" | "warn" | "error"; readonly text: string }
  | { readonly type: "exit"; readonly exitCode: number | null; readonly durationMs: number };

export interface ApprovalOption { readonly label: string; readonly kind: ApprovalDecision }
export type ApprovalDecision = "once" | "always" | "reject";
export interface Choice { readonly label: string; readonly value: string }
```

`src/agentCommands.ts`:
```ts
import type { ApprovalDecision } from "./agentEvents.js";

/** 手机→agent 的统一指令（§5.1）。所有写操作共享 clientId 幂等（异常 #7）。 */
export type AgentCommand =
  | { readonly cmd: "send"; readonly text: string; readonly files?: readonly { readonly name: string; readonly b64: string }[] }
  | { readonly cmd: "interrupt" }
  | { readonly cmd: "approve"; readonly requestId: string; readonly decision: ApprovalDecision }
  | { readonly cmd: "answer"; readonly questionId: string; readonly value: string }
  | { readonly cmd: "stop" }
  | { readonly cmd: "restart" };
```

`src/sessionSpec.ts`:
```ts
/** 手机可建会话的描述。permissionMode 白名单锁死（C3：手机不可升权）。 */
export type PhonePermissionMode = "default" | "plan";

export interface SessionSpec {
  readonly agentId: string;
  readonly cwd: string;
  readonly model?: string;
  readonly permissionMode: PhonePermissionMode;
  readonly initialPrompt?: string;
}

export interface SessionMeta {
  readonly id: string;
  readonly agentId: string;
  readonly cwd: string;
  readonly permissionMode: PhonePermissionMode;
  readonly state: import("./agentEvents.js").SessionState;
  readonly lastSeq: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
```

`src/frames.ts`:
```ts
import type { AgentCommand } from "./agentCommands.js";
import type { AgentEvent, NotificationKind } from "./agentEvents.js";
import type { SessionMeta, SessionSpec } from "./sessionSpec.js";

/** 链路层（连接与恢复）。resume 为 M1 预留：本阶段恒 null。 */
export interface HelloFrame { readonly v: 1; readonly type: "hello"; readonly token: string; readonly resume: null }
export interface WelcomeFrame { readonly v: 1; readonly type: "welcome"; readonly serverVersion: string; readonly sessions: readonly SessionMeta[] }
export interface PingFrame { readonly v: 1; readonly type: "ping"; readonly nonce: number }
export interface PongFrame { readonly v: 1; readonly type: "pong"; readonly nonce: number }
export interface ByeFrame { readonly v: 1; readonly type: "bye"; readonly reason: string }

/** 手机→server 领域帧。 */
export interface SessionCreateFrame { readonly v: 1; readonly type: "session.create"; readonly spec: SessionSpec }
export interface SessionCommandFrame {
  readonly v: 1; readonly type: "session.command";
  readonly sessionId: string; readonly clientId: string; readonly cmd: AgentCommand;
}

/** server→手机 领域帧；ack 对应 session.create。 */
export interface SessionEventFrame {
  readonly v: 1; readonly type: "session.event";
  readonly sessionId: string; readonly seq: number; readonly ts: number; readonly agentEvent: AgentEvent;
}
export interface AckFrame { readonly v: 1; readonly type: "ack"; readonly sessionId: string }
export interface ErrorFrame { readonly v: 1; readonly type: "error"; readonly code: FrameErrorCode; readonly message: string }

export type FrameErrorCode =
  | "auth.invalid_token" | "auth.pairing_expired" | "protocol.bad_frame"
  | "session.not_found" | "session.agent_missing" | "session.duplicate_command"
  | "server.busy";

export type ClientFrame = HelloFrame | PingFrame | SessionCreateFrame | SessionCommandFrame;
export type ServerFrame = WelcomeFrame | PongFrame | ByeFrame | SessionEventFrame | AckFrame | ErrorFrame;

/** M1：通知分类帧（前台服务长连接承载）的占位由 NotificationKind 表达于事件域，不需要独立帧。 */
export type NotificationKindUnused = NotificationKind;
```

`src/zodFrames.ts`:
```ts
import { z } from "zod";
import type { ClientFrame, ServerFrame } from "./frames.js";

const phonePermissionMode = z.enum(["default", "plan"] as const);

const agentCommand = z.discriminatedUnion("cmd", [
  z.object({ cmd: z.literal("send"), text: z.string().max(64 * 1024),
    files: z.array(z.object({ name: z.string().max(255), b64: z.string().max(1_400_000) })).max(5).optional() }),
  z.object({ cmd: z.literal("interrupt") }),
  z.object({ cmd: z.literal("approve"), requestId: z.string().min(1), decision: z.enum(["once", "always", "reject"]) }),
  z.object({ cmd: z.literal("answer"), questionId: z.string().min(1), value: z.string().max(4 * 1024) }),
  z.object({ cmd: z.literal("stop") }),
  z.object({ cmd: z.literal("restart") }),
]);

const agentEvent = z.union([
  z.object({ type: z.literal("state"), state: z.enum([
    "starting", "running", "waiting_approval", "waiting_input", "finished", "failed", "stopped"]) }),
  z.object({ type: z.literal("text_delta"), text: z.string().max(8 * 1024) }),
  z.object({ type: z.literal("thinking"), text: z.string().max(8 * 1024) }),
  z.object({ type: z.literal("tool_call"), id: z.string(), name: z.string(), summary: z.string(), inputDigest: z.string() }),
  z.object({ type: z.literal("tool_result"), id: z.string(), ok: z.boolean(), outputExcerpt: z.string().max(8 * 1024), exitCode: z.number().int().optional() }),
  z.object({ type: z.literal("permission"), id: z.string(), title: z.string(), detail: z.string(),
    options: z.array(z.object({ label: z.string(), kind: z.enum(["once", "always", "reject"]) })) }),
  z.object({ type: z.literal("question"), id: z.string(), prompt: z.string(),
    options: z.array(z.object({ label: z.string(), value: z.string() })) }),
  z.object({ type: z.literal("usage"), tokensIn: z.number().nonnegative(), tokensOut: z.number().nonnegative(), cost: z.number().optional() }),
  z.object({ type: z.literal("notice"), severity: z.enum(["info", "warn", "error"]), text: z.string() }),
  z.object({ type: z.literal("exit"), exitCode: z.number().int().nullable(), durationMs: z.number().nonnegative() }),
]);

const clientFrame = z.union([
  z.object({ v: z.literal(1), type: z.literal("hello"), token: z.string().min(8), resume: z.null() }),
  z.object({ v: z.literal(1), type: z.literal("ping"), nonce: z.number().int() }),
  z.object({ v: z.literal(1), type: z.literal("session.create"),
    spec: z.object({ agentId: z.string().min(1), cwd: z.string().min(1), model: z.string().optional(),
      permissionMode: phonePermissionMode, initialPrompt: z.string().max(64 * 1024).optional() }) }),
  z.object({ v: z.literal(1), type: z.literal("session.command"), sessionId: z.string().min(1),
    clientId: z.string().min(8).max(64), cmd: agentCommand }),
]);

const serverFrame = z.union([
  z.object({ v: z.literal(1), type: z.literal("welcome"), serverVersion: z.string(), sessions: z.array(z.record(z.string(), z.unknown())) }),
  z.object({ v: z.literal(1), type: z.literal("pong"), nonce: z.number().int() }),
  z.object({ v: z.literal(1), type: z.literal("bye"), reason: z.string() }),
  z.object({ v: z.literal(1), type: z.literal("session.event"), sessionId: z.string(), seq: z.number().int().nonnegative(),
    ts: z.number(), agentEvent }),
  z.object({ v: z.literal(1), type: z.literal("ack"), sessionId: z.string() }),
  z.object({ v: z.literal(1), type: z.literal("error"), code: z.string(), message: z.string() }),
]);

/** 宽进严出：非契约帧一律 null（异常 #6 防协议漂移的最内层）。 */
export function parseClientFrame(raw: unknown): ClientFrame | null {
  const r = clientFrame.safeParse(raw); return r.success ? (r.data as ClientFrame) : null;
}
export function parseServerFrame(raw: unknown): ServerFrame | null {
  const r = serverFrame.safeParse(raw); return r.success ? (r.data as ServerFrame) : null;
}
```

`src/index.ts`:
```ts
export * from "./agentEvents.js";
export * from "./agentCommands.js";
export * from "./sessionSpec.js";
export * from "./frames.js";
export * from "./zodFrames.js";
```

- [ ] **Step 4: 跑绿**

Run: `pnpm --filter @aimi/protocol test`
Expected: PASS（4 用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): v1 帧契约与 zod 校验（AgentEvent/AgentCommand/Frame 单一源）"
```

---

### Task 3: logging —— 结构化 JSON 行日志

**Files:**
- Create: `apps/server/src/logging/logger.ts`, `apps/server/src/logging/logger.test.ts`

**Interfaces:**
- Produces: `createLogger(component: string, logDir: string): Logger`；`Logger.error/info/warn(debug 后续) 签名 (msg: string, fields?: Record<string, unknown>)`

- [ ] **Step 1: 红测试**

`apps/server/src/logging/logger.test.ts`:
```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "aimi-log-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("JSON 行日志", () => {
  it("每行一个对象：ts/level/component/msg/fields", () => {
    const log = createLogger("sessionManager", dir);
    log.info("session started", { sessionId: "s1" });
    log.error("boom", { sessionId: "s1", err: "EPIPE" });
    const line = readFileSync(join(dir, "server.log"), "utf8").trim().split("\n");
    expect(line).toHaveLength(2);
    expect(JSON.parse(line[0]!)).toMatchObject({ level: "INFO", component: "sessionManager", sessionId: "s1" });
    expect(JSON.parse(line[1]!).level).toBe("ERROR");
  });
});
```

- [ ] **Step 2: 红** — Run: `pnpm --filter @aimi/server test -- logger`，Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
const LEVEL_RANK: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** JSON 行：一行一对象。分级过滤由 minLevel 决定（默认 INFO——设计 §13）。 */
export function createLogger(
  component: string,
  logDir: string,
  minLevel: LogLevel = "INFO",
): Logger {
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const file = join(logDir, "server.log");
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
    const rec = { ts: Date.now(), level, component, msg, ...fields };
    appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
  };
  return {
    debug: (m, f) => write("DEBUG", m, f),
    info: (m, f) => write("INFO", m, f),
    warn: (m, f) => write("WARN", m, f),
    error: (m, f) => write("ERROR", m, f),
  };
}
```

- [ ] **Step 4: 绿** — Run: `pnpm --filter @aimi/server test -- logger`，Expected: PASS。
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/logging
git commit -m "feat(server): JSON 行日志（ts/level/component/msg）按文件追加"
```

---

### Task 4: persistence —— 四仓储接口 + Memory 实现

**Files:**
- Create: `src/persistence/types.ts`, `src/persistence/memory/memoryConversationRepository.ts`, `src/persistence/memory/memoryDeviceRepository.ts`, `src/persistence/memory/memoryCommandDedupRepository.ts`, `src/persistence/memory/memoryAuditRepository.ts`, `src/persistence/memory/index.ts`, `src/persistence/types.test.ts`

**Interfaces:**
- Produces（冻结签名）：
  ```ts
  /** events + sessions 仓储（§D：唯一能写这两表的人） */
  interface ConversationRepository {
    init(): Promise<void>;
    createSession(row: { id: string; agentId: string; cwd: string; permissionMode: "default"|"plan"; initialPrompt?: string }, initialAgentEvent: AgentEvent | null): Promise<void>; // 原子：会话行+首事件
    appendEvent(sessionId: string, agentEvent: AgentEvent, ts: number): Promise<number>; // 返回分配的 seq（1 起）
    getEvents(sessionId: string, opts?: { sinceSeq?: number; limit?: number }): Promise<{ seq: number; ts: number; agentEvent: AgentEvent }[]>;
    listSessions(): Promise<SessionMeta[]>;
    updateSession(id: string, patch: { state?: SessionState; lastSeq?: number }): Promise<void>;
    close(): Promise<void>;
  }
  interface DeviceRepository { init(): Promise<void>; put(name: string, tokenSha256: string): Promise<string /*deviceId*/>; findByTokenHash(tokenSha256: string): Promise<{ id: string; name: string } | null>; revoke(deviceId: string): Promise<void>; list(): Promise<{ id: string; name: string; lastSeenAt: number }[]>; close(): Promise<void> }
  interface CommandDedupRepository { init(): Promise<void>; putIfAbsent(clientId: string): Promise<boolean>; close(): Promise<void> } // false=重复
  interface AuditRepository { init(): Promise<void>; record(entry: { ts: number; deviceId: string; sessionId: string | null; action: string; detail: string }): Promise<void>; recent(n: number): Promise<AuditEntry[]>; close(): Promise<void> }
  interface AuditEntry { ts: number; deviceId: string; sessionId: string | null; action: string; detail: string }
  ```

- [ ] **Step 1: 红测试** `src/persistence/types.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MemoryConversationRepository } from "./memory/memoryConversationRepository.js";
import { MemoryCommandDedupRepository } from "./memory/memoryCommandDedupRepository.js";

describe("Memory 仓储必须与生产实现同一契约", () => {
  it("createSession 原子后 seq 从 1 递增", async () => {
    const repo = new MemoryConversationRepository();
    await repo.init();
    await repo.createSession({ id: "s1", agentId: "claude", cwd: "D:\\x", permissionMode: "default" },
      { type: "state", state: "starting" });
    const s1 = await repo.appendEvent("s1", { type: "text_delta", text: "a" }, 1);
    const s2 = await repo.appendEvent("s1", { type: "text_delta", text: "b" }, 2);
    expect([s1, s2]).toEqual([1, 2]);
    expect((await repo.getEvents("s1")).map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("getEvents sinceSeq 重放点查", async () => {
    const repo = new MemoryConversationRepository();
    await repo.init();
    await repo.createSession({ id: "s1", agentId: "claude", cwd: "D:\\x", permissionMode: "default" }, null);
    for (let i = 0; i < 5; i++) await repo.appendEvent("s1", { type: "text_delta", text: String(i) }, i);
    expect((await repo.getEvents("s1", { sinceSeq: 3 })).map((e) => e.seq)).toEqual([4, 5]);
  });

  it("clientId 去重：第二次 put 返回 false（异常 #7）", async () => {
    const dedup = new MemoryCommandDedupRepository();
    await dedup.init();
    expect(await dedup.putIfAbsent("cid-1")).toBe(true);
    expect(await dedup.putIfAbsent("cid-1")).toBe(false);
  });
});
```

- [ ] **Step 2: 红** — Run: `pnpm --filter @aimi/server test -- persistence`，Expected: FAIL（文件缺失）。
- [ ] **Step 3: 实现** —— `types.ts` 为上述冻结接口；四个 memory 实现为 `class XxxRepository implements Xxx`，内部 `Map`/数组；`memoryConversationRepository` 维护 `sessionsById: Map`（含 state/lastSeq）+ `eventsBySession: Map<string, Row[]>`；`index.ts` 复出口。
- [ ] **Step 4: 绿** — Expected: PASS。
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/persistence
git commit -m "feat(server): 四仓储契约与测试型 Memory 实现（会话原子建+seq 分配+重放点查+幂等）"
```

---

### Task 5: persistence —— Sqlite 实现（WAL + 微批 + 点查基准）

**Files:**
- Create: `src/persistence/sqlite/schema.sql`, `src/persistence/sqlite/migrate.ts`, `src/persistence/sqlite/sqliteConversationRepository.ts`, `src/persistence/sqlite/sqliteRepositories.ts`, `src/persistence/benchmarks/throughput.test.ts`

**Interfaces:**
- Consumes: Task 4 冻结的四仓储接口（`src/persistence/types.ts`）
- Produces: `SqliteConversationRepository` / `SqliteDeviceRepository` / `SqliteCommandDedupRepository` / `SqliteAuditRepository`（打开=同库连接共享 `db`，`migrate(db)` 幂等执行 `schema.sql` 追加式建表；`db.pragma("journal_mode = WAL")`）

- [ ] **Step 1: schema.sql（全部 CREATE TABLE IF NOT EXISTS，只追加原则 §D 规则 4）**

```sql
CREATE TABLE IF NOT EXISTS meta_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  permission_mode TEXT NOT NULL CHECK (permission_mode IN ('default','plan')),
  state TEXT NOT NULL,
  resume_hint TEXT,                -- M1：每适配器自述
  last_seq INTEGER NOT NULL DEFAULT 0,
  initial_prompt TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  payload TEXT NOT NULL,           -- AgentEvent JSON
  PRIMARY KEY (session_id, seq)    -- 重放=点查（§D 规则 6）
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  revoked_at INTEGER,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cmd_dedup (
  client_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  ts INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  session_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  audit_seq INTEGER PRIMARY KEY AUTOINCREMENT
);
```

- [ ] **Step 2: migrate.ts**
```ts
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** 追加式迁移：仅执行幂等 schema。禁止 DROP/改列（§D 规则 4）。 */
export function openMigrated(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  db.exec(sql);
  return db;
}
```

- [ ] **Step 3: 三实现（要点）** —— `sqliteConversationRepository`：`createSession` 用 `db.transaction()` 原子插 sessions + 首事件（seq 0）；`appendEvent` 在同一事务内 `INSERT INTO events (session_id, seq, ts, payload) VALUES (?,?, ?, ?)`（seq = 读取该会话 `last_seq + 1`）并回写 `sessions.last_seq`，返回新 seq；`getEvents` = `WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?`。微批：同一事件循环 tick 内到达的 appendEvent 聚合进单个事务（50 ms 或 64 条触发 flush）。`SqliteDeviceRepository`（put/findByTokenHash/revoke/list 直写直查）、`SqliteCommandDedupRepository.putIfAbsent`（`INSERT OR IGNORE`，`changes = 0` 即重复）、`SqliteAuditRepository.record/recent`（AUTOINCREMENT audit_seq 倒序取 n 条）——三实现不做微批（写频远低于 events）。
- [ ] **Step 4: 同契约单测 + 吞吐基准** —— 复用 Task 4 的测试参数（把 Memory 换成 Sqlite 临时文件）；基准测试：
```ts
it("落库 ≥ 500 events/s（§7 预算，temp 库）", async () => {
  const repo = new SqliteConversationRepository(tmpDbPath());
  await repo.init();
  await repo.createSession({ id: "s1", /*…*/ }, null);
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) await repo.appendEvent("s1", { type: "text_delta", text: "x".repeat(512) }, i);
  const rate = 1000 / ((performance.now() - t0) / 1000);
  expect(rate).toBeGreaterThanOrEqual(500);
});
```
- [ ] **Step 5: 绿与基准** — Run: `pnpm --filter @aimi/server test -- persistence`，Expected: PASS（rate ≥ 500/s 记录实测值）。
- [ ] **Step 6: Commit**
```bash
git add apps/server/src/persistence
git commit -m "feat(server): SQLite 仓储实现（WAL/微批/点查重放）+ 落库吞吐基准"
```

---

### Task 6: auth —— 设备令牌校验与审计挂钩（M0 配对替代）

**Files:**
- Create: `src/auth/authenticator.ts`, `src/auth/configProvisioner.ts`, `src/auth/authenticator.test.ts`, `src/audit/auditWriter.ts`

**Interfaces:**
- Consumes: `DeviceRepository`、`AuditRepository`、config
- Produces:
  ```ts
  interface Authenticator { verifyHello(token: string, remote: string): Promise<DeviceIdentity | null> }
  interface DeviceIdentity { deviceId: string; name: string }
  class ConfigProvisioner { ensureLanToken(cfg: ServerConfig): { token: string; sha256: string; deviceId: string } } // 无则生成 32B→base64url、写库（哈希）、把明文打印给运维者一次
  class AuditWriter { command(cmd: AgentCommand, identity: DeviceIdentity, sessionId: string): Promise<void>; auth(event: "pair"|"revoke"|"auth_fail", detail: string): Promise<void> }
  ```
- 行为契约：明文 token 只经 CLI 打印一次（M0 替代二维码配对，§16 一致——"配对一次性凭证"）；verifyHello 查 `findByTokenHash` 且 `revoked_at IS NULL`，命中记 `auth` 审计，未命中记 `auth_fail`。测试用 token 应取**≥ 43 字符的真实形态**（base64url 的 32 字节），不得用 8 字符下限凑数。

- [ ] **Step 1: 红测试**（用例 3 条：`正确 token → DeviceIdentity`、`假 token → null + auth_fail 审计`、`吊销后 → null`）；实现 + 跑绿 + Commit：`feat(server): 设备 token 鉴权（SHA-256 逐帧/连接校验）与审计挂钩`。

---

### Task 7: transport —— Conveyor 抽象与 WS 实现

**Files:**
- Create: `src/transport/conveyor.ts`, `src/transport/ws/lanServer.ts`, `src/transport/ws/messagePipe.ts`, `src/transport/ws/messagePipe.test.ts`

**Interfaces:**
- Consumes: `@aimi/protocol`（Frame/parse）
- Produces（冻结）：
  ```ts
  /** §A：全系统唯一传输抽象。心跳/重连/重放属协议层，不在此层。 */
  interface Conveyor {
    open(): Promise<void>;
    send(frame: ServerFrame): void;                                  // 无 await：发即忘（不背压到业务）
    onFrame(cb: (raw: unknown) => void): void;                        // 原始帧回调（pipe 在上层 parse）
    onClose(cb: (reason: string) => void): void;
    close(reason?: string): Promise<void>;
    readonly state: ConveyorState;                                    // "opening"|"open"|"closed"
  }
  class LanWsServer { /** 接住 LAN socket，每个 socket 包一个 ServerSideConveyor */ constructor(opts: { port: number }); onConnection(cb: (c: Conveyor, remote: string) => void): void; listen(): Promise<number /*actualPort*/>; close(): Promise<void> }
  ```
- 契约：`send` 内部走 ws 客户端帧队列（内核缓冲），序列化为 JSON 行帧（每帧一条消息）；`onFrame` 先 `parseClientFrame`？——**否**：`Conveyor` 只给 raw，由上层 `auth/session` 白名单校验（职责分离，防传输层懂业务）。

- [ ] **Step 1: 红测试** `messagePipe.test.ts`：起 `LanWsServer`（随机端口）+ 裸 `ws` 客户端，断言往返：client 收到 `welcome` JSON 帧 / server `onFrame` 收到 client 发来的 raw hello；非 JSON 原文不触发 parse（parse 属上层职责，T11 装配接线）。
- [ ] **Steps 2-4** 红过绿 + **Commit**：`feat(server): Conveyor 传输抽象 + LAN WebSocket 实现（每 socket 一实例）`。

---

### Task 8: events —— EventBus（保序/seq/扇出）+ 洪水控制

**Files:**
- Create: `src/events/eventBus.ts`, `src/events/eventFlood.ts`, `src/events/uiFanout.ts`, `src/events/eventBus.test.ts`

**Interfaces:**
- Consumes: `ConversationRepository.appendEvent`
- Produces（冻结）：
  ```ts
  /** 单线程扇出（Node 事件循环屏障内同步派发），会话有序（§12 #12） */
  class EventBus {
    subscribe(handlers: { persist?: (rec: SessionRecord) => Promise<void>; ui?: (rec: SessionRecord) => void; notify?: (rec: SessionRecord) => void }): void
    async publish(sessionId: string, agentEvent: AgentEvent, ts?: number): Promise<number /*seq*/>
  }
  interface SessionRecord { sessionId: string; seq: number; ts: number; agentEvent: AgentEvent }
  class FloodPolicy { /** M1 起 state separate */ constructor(opts?: { deltaWindowMs?: number; maxPayloadBytes?: number })
    static AGENTEVENT(event: AgentEvent): AgentEvent;   // text_delta/thinking 聚合 + >8KB 截断
  }

- [ ] **Step 1: 红测试**（三条断言）：
  1. 同会话 200 次 `publish` 后 `getEvents` 有序 seq 递增、`seq` 严格 +1；
  2. 三个连续 `text_delta` 在窗口内（注入时钟→模拟 50ms）后合并成一条（`text` 连接）；
  3. `tool_result.outputExcerpt` 9000 字符→截断 `8192 + "…(truncated)"`。
- [ ] **Steps 2-4 + Commit**：`feat(server): EventBus 单线程保序扇出 + 洪水聚合/截断`。

---

### Task 9: session —— 状态机 + 会话编排核心（含命令幂等管道）

**Files:**
- Create: `src/session/sessionMachine.ts`, `src/session/sessionManager.ts`, `src/session/commands.ts`, `src/session/sessionMachine.test.ts`

**Interfaces:**
- Consumes: `ConversationRepository.createSession/appendEvent/updateSession`、`EventBus.publish`、`CommandDedupRepository`、`AgentAdapter(经 registry - T10 提供)`
- Produces（冻结）：
  ```ts
  /** §C 三态形态 */
  type LifecycleKind = "new" | "resumable" | "archived";
  const TRANSITIONS: Record<SessionState, SessionState[]> = {   // 白名单（表格式，不做对象乱跃）
    starting:      ["running", "failed", "stopped"],
    running:       ["waiting_approval", "waiting_input", "finished", "failed", "stopped"],
    waiting_approval: ["running", "failed", "stopped"],
    waiting_input: ["running", "finished", "failed", "stopped"],
    finished: [], failed: [], stopped: [],
  };
  class SessionManager {
    async create(spec: SessionSpec, kind: LifecycleKind, resumeHint?: string): Promise<SessionMeta>
    // kind:"new" → 经 registry.isInstalled 校验后由适配器拉起；"resumable"/"archived" → 仅恢复元数据(子进程不自动复活)
    async resume(sessionId: string): Promise<SessionMeta>  // 仅 lifecycle=resumable 且!==running
    async stop(sessionId: string): Promise<void>; async restart(sessionId: string): Promise<void>
  }
  class PhoneCommandPipe {
    async handle(frame: SessionCommandFrame, identity: DeviceIdentity): Promise<void> // clientId 幂等→audit→dispatch
  }
  ```
- 行为契约：
  - 手机命令先 `updateSession lastSeen? → dedup.putIfAbsent(clientId)`，重复→`audit.record(duplicate)` + 丢弃（不执行两遍）；
  - 状态跃迁非法时 `notice{severity:"error", text:"invalid transition…"}` + 保持原态（异常 #11）；
  - 手机会话 create 请求 `permissionMode` 默认合法白名单（protocol 已限，server 侧仍 re-assert——守卫双保险 §16）。

- [ ] **Step 1: 红测试**：三块（a) 白名单非法跃迁报 notice 不落非法 state；b) `PhoneCommandPipe.handle` 重复 clientId 第二次不 emit 适配器调用，且写 `audit` 两次（执行1+duplicate1）；c) `create("new")` 对 `agentId:"unknown"` 返回 `session.agent_missing` 错误帧路径。
- [ ] **Steps 2-4 + Commit**：`feat(server): 会话状态机三态编排 + 命令幂等管道`。

---

### Task 10: agents —— registry + claude 适配器（含协议归一化、打断）

**Files:**
- Create: `src/agents/registry.ts`, `src/agents/claude/claudeAdapter.ts`, `src/agents/claude/claudeSession.ts`, `src/agents/claude/claudeProtocol.ts`, `src/agents/claude/__fixtures__/normal-turn.jsonl`, `src/agents/claude/claudeProtocol.test.ts`, `src/agents/registry.test.ts`

**Interfaces:**
- Consumes: `SessionSpec/AgentEvent/AgentCommand`（protocol）、node `child_process`
- Produces（冻结 v1）：
  ```ts
  interface AgentAdapter {
    readonly meta: AgentMeta;             // { id: "claude", label: "Claude Code" }
    isInstalled(): Promise<{ ok: boolean; version?: string }>;   // `claude --version` 2s 超时
    create(spec: SessionSpec, emit: Emit): AgentSession;         // Emit = (e: AgentEvent) => void
  }
  interface AgentSession { start(): Promise<void>; send(cmd: AgentCommand): Promise<void>; dispose(reason?: string): Promise<void> }
  ```

- **claude 启动命令**（M0：仅 `permissionMode:"default"`→ `--permission-mode default`；`plan`→`--permission-mode plan`）：
  ```ts
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json",
    "--include-partial-messages", "--verbose"];
  if (spec.permissionMode === "plan") args.push("--permission-mode", "plan");
  if (spec.initialPrompt) stdin 写 {"type":"user","message":{"role":"user","content":[{"type":"text","text":spec.initialPrompt}]}} 然后保持流开
  ```
  （spawn：Windows 下 `shell: true` 使 `.cmd` 垫片可解析；`cwd: spec.cwd`。）
- **打断**（对照官方 headless：control_request/interrupt）：
  ```ts
  await stdin.write(JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } }) + "\n");
  ```
- **归一化映射**（`claudeProtocol.ts`，纯函数 + 回放测试）：`system/init→state running`；`stream_event.content_block_delta[type=thinking_delta|text_delta]→thinking/text_delta`；`assistant(content 块 tool_use)→tool_call{id,name,summary=tool.name,inputDigest=sha256(input).slice(0,12)}`；`user(content 块 tool_result)→tool_result{…,outputExcerpt=拼接文本前 8KB}`；`result→state finished+usage`；`std line 非 JSON→notice warn（容错）`。

- [ ] **Step 1: 回放 fixtures** —— `__fixtures__/normal-turn.jsonl` 录三行样例（system→stream_event(text_delta)→assistant(tool_use)→user(tool_result)→result），来自官方 headless 文档样例字段，手工构造，内容见提交文件（每行一 JSON）。
- [ ] **Step 2: 红测试** `claudeProtocol.test.ts`：fixture→期望 `AgentEvent[]`（含 `state running`、一条 `text_delta`、一条 `tool_call{name:"Bash"}`、一条 `tool_result`、`state finished`）+ `idle JSON 行→notice warn`。
- [ ] **Step 3: registry 红测试**：`isInstalled` 用 mock `PATH`（`claude.cmd` 假脚本回显版本），未安装路径返回 `{ok:false}`。
- [ ] **Step 4: 实现（claudeSession.ts）**：spawn→逐行 on('data')→protocol.ts→emit；打断：控制帧写入；dispose：kill("SIGTERM") 5s 后 SIGKILL（Windows 下 terminate）；`exit` 事件→emit `{type:"exit"…}`。
- [ ] **Steps 5-7** 绿 + e2e `claudeSession` 集成（用 PATH 内假 claude.cmd 回 fixtures）+ **Commit**：`feat(server): claude code 适配器（stream-json 双向流/打断/协议归一化回放测试）`。

---

### Task 11: server 装配 + LAN 直接接手机（e2e）

**Files:**
- Create: `src/app/application.ts`, `src/app/config.ts`, `src/bin/aimi-server.ts`, `__tests__/e2e_lan_stream.test.ts`
- Consume: Task 8 已建的 `src/events/uiFanout.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ServerConfig { port: number; dataDir: string; logDir: string; logLevel: LogLevel; serverVersion: string }
  class Application { constructor(cfg: ServerConfig); async start(): Promise<AppPorts>; async close(): Promise<void> }
  interface AppPorts { port: number }
  // aimi-server.ts:
  //   aimi-server start [--config path] → 终端打印 { lanUrl: ws://<ip>:<port> }（**不打印 token**——§5.4 明文凭证只经配对通道一次）
  //   aimi-server status → JSON { port, sessions: n, devices: n }
  //   aimi-server lan-token → 打印当前 token 明文（M0 配对替代：运维者复制进手机 Settings；后续不再在任何输出中出现）
  ```

- **装配接线**（new 顺序即依赖方向 §5.2）：config → logger → Sqlite 四仓储（`migrate`）→ AuditWriter → auth（configProvisioner+Authenticator+DeviceRepository）→ registry(claude) → EventBus(subscribe: persist via ConversationRepository、ui via uiFanout) → SessionManager → LanWsServer（onConnection：`hello` 校验 → `welcome{sessions}` → 后续帧走 `parseClientFrame`：create→SessionManager、command→PhoneCommandPipe）。
- `uiFanout`：`EventRecord → SessionEventFrame`（seq/ts/event）→ **同一连接池内广播**（M0：全体连接全量，M1 加订阅过滤）。

- [ ] **Step 1: e2e 红测试**（模拟手机全流程）：
  1. 起 Application（随机端口 + tmp dir + 预置 device token）；
  2. ws 客户端 send hello → 期望 welcome；
  3. send `session.create{spec:{agentId:"claude"(stub PATH 假 claude.cmd), cwd: tmpdir(), permissionMode:"default", initialPrompt:"hi"}}` → 期望 `ack`；
  4. 期望收到序列：`state starting`、`state running`、`text_delta("hello world")`、`state finished`（假 claude.cmd 按脚本吐 fixtures）——**断言 seq 递增 & 顺序一致**；
  5. send `session.command{cmd:"interrupt", clientId:"c1"}` → 期望假 claude 收到 control_request（记录 stdin 断言）+ `audit` 行 action=command.interrupt；
  6. 重发同 clientId → **不再**又一次执行（假 claude control_request 计数=1，异常 #7）。
- [ ] **Steps 2-4** 红过绿 + **Commit**：`feat(server): 应用装配与 LAN 手机直连 e2e（hello→welcome→create→事件流→打断→幂等）`。

---

### Task 12: CLI 与运行脚本

**Files:**
- Create: `src/bin/aimi-server.ts`（实现化 Task 11 桩）、Modify: `apps/server/package.json` scripts

**Interfaces:**
- Produces: `aimi-server start/status/lan-token`（cmd 实现于 ops/health.ts，cli 只绑参数——§F 归属）

- [ ] **Step 1: status 单测**：注入 tmp config → 输出 JSON 含 `{"port":…,"sessions":0,"devices":1}`。
- [ ] **Step 2: 实现**（argparse 三子命令直接 switch，no yargs 依赖；yagni）
- [ ] **Step 3: 手工验证清单**：`node --import tsx src/bin/aimi-server.ts start` → 终端打印 lanUrl（token 须经 `lan-token` 子命令另查）；`status`；Ctrl-C 干净退出（close 全模块）。
- [ ] **Step 4: Commit**：`feat(server): aimi-server CLI（start/status/lan-token）`。

---

### Task 13: mobile —— Flutter 工程基线

**Files:**
- Create: `apps/mobile/**`（`flutter create` 后修）

- [ ] **Step 1: 生成**（Windows 下跳过 windows 桌面目标，只保留 android/ios 桩）：
  ```bash
  flutter create apps/mobile --org dev.aimi --platforms android,ios --project-name aimi
  ```
- [ ] **Step 2: pubspec 依赖**：
  ```yaml
  dependencies:
    flutter: { sdk: flutter }
    flutter_riverpod: ^2.6.1
    go_router: ^14.6.2
    web_socket_channel: ^3.0.1
    flutter_secure_storage: ^9.2.2
    uuid: ^4.5.1
  ```
- [ ] **Step 3: theme.dart / router.dart**：
  - `theme.dart`：Material 3 深色浅色双主题占位（色板 6 token 常量，M0 骨架不追视觉）；
  - `router.dart`：`/`→DashboardScreen、`/session/:id`→SessionScreen。

- [ ] **Step 4: analyze 绿**：Run `flutter analyze`，Expected: No issues。
- [ ] **Step 5: Commit**：`feat(mobile): Flutter 工程基线（Riverpod/GoRouter/主题骨架，Android-first）`。

---

### Task 14: mobile —— 连接层与协议镜像

**Files:**
- Create: `lib/data/protocol/frame_dto.dart`, `lib/data/connection/aimiConnection.dart`, `lib/data/connection/aimiConnection.test.dart`(widget-free unit)，`lib/data/cache/sessionCache.dart`, `lib/domain/sessionView.dart`, `lib/domain/sessionView.test.dart`(flutter_test unit)

**Interfaces (冻结):**
- `AimiConnection`（StateNotifier<ConnState>）:
  ```dart
  enum ConnState { offline, reconnecting, onlineLan }
  class AimiConnection extends StateNotifier<ConnState> {
    AimiConnection({required AimiEndpoints endpoints, required SessionCache cache, required void Function(Uint8List) onWebsocketData});
    Future<void> connect();            // hello(token)→welcome→onWelcome(meta)
    Future<void> createSession(SessionSpec spec);    // ack→ui 直达 /session/:id
    Future<void> sendCommand(String sessionId, AgentCommand cmd, {required String clientId});
    void pingLoop();                    // 15s/2拍（M0 简化：30s 心跳足够，M1 全量）
    Future<void> reconnect({int attempt = 0});     // 1s→2s→…→30s+jitter
  }
  class AimiEndpoints { final String host; final int port; final String token; }
  ```
- `SessionCache`（内存 Map）：`applySessionEvent(eventFrame)`（seq 单调检查，乱序帧直接丢弃并计入 watched 计数）、`sessionsSnapshot()`、`eventsFor(sessionId)`。
- `sessionView.dart` 纯函数：`List<TimelineItem> timelineOf(events)`（text_delta 连续合并/工具卡折叠/state→徽标图标）；看板卡副标题=最后 text_delta 前 80 字。

- [ ] **Step 1: 红测**（flutter test）：(a) welcome→cache 元数据；(b) 同会话 seq 3、1 到达乱序→1 被 refuse（单调保障）；(c) timelineOf text_delta×3 相邻合并；(d) state waiting_approval → 徽标 kind=approval（M0 UI 灰卡显示，交互 M1）。
- [ ] **Steps 2-5 + Commit**：`feat(mobile): 连接状态机/协议镜像/会话视图纯函数（含 TDD 用例）`。

---

### Task 15: mobile —— 看板 + 时间线 UI（含打断按钮 + 手动配对入口）

**Files:**
- Create: `lib/ui/dashboard/dashboardScreen.dart`, `lib/ui/session/sessionScreen.dart`, `lib/ui/settings/settingsScreen.dart`, `lib/ui/widgets/stateBadge.dart`, `lib/ui/widgets/timelineView.dart`

**Interfaces:**
- Consumes: `sessionView`/`SessionCache`/`AimiConnection`（Riverpod Provider 桥接）
- 行为：
  - Dashboard：`StreamBuilder(cache.stream)`ListView 卡片（agent 徽标、状态色、最后消息摘要）；FAB→ 选择 agent（M0 只有 claude）→ 文本框 initialPrompt → createSession→ ack 后 GoRouter push `/session/:id`；
  - SessionScreen：TimelineView（ListView.builder + `itemCount = events.length`）+ 底部输入框 send + AppBar 中文按钮断开（`interrupt`）；
  - Settings：三个 TextField（host / port / token）+ store 到 secure_storage（M0 无 QR，编辑入库即可）、连接状态徽标区。

- [ ] **Step 1: 红测**：`timelineView` widget 测试（30 条混合事件→渲染不持锁、折叠卡 count=1；text 合并发单 widget）；`stateBadge` 状态颜色断言。
- [ ] **Steps 2-5 + Commit**：`feat(mobile): 看板/时间线/设置三屏（Riverpod 接线 + widget 测试）`。

---

### Task 16: 端到端握手冒烟（真机可手跑 + 自动 e2e）

**Files:**
- Create: `__tests__/e2e_lan_stream.test.ts`（扩到 TS 全链路）、`docs/superpowers/plans/m0-smoke-checklist.md`

- [ ] **Step 1: 自动 e2e 扩断言**——在 Task 11 基础上追加：
  - 断言呈现延迟预算（本机 loopback ≤ 200 ms P95，抽查 10 事件）；
  - 断言 flood：50 连续 text_delta（间隔 5ms 注入时钟模拟）→ 传输帧数 ≤ ceil(50*5/100)+1；
  - 断言 8KB 截断在链路帧上生效：注入一条 9000 字符 `text_delta` → 广播帧内 `text` 长度 ≤ 8192 + 截断标记宽（≤ 8224）。
- [ ] **Step 2: 真机冒烟清单**写入 `m0-smoke-checklist.md`：
  1. PC：`pnpm serve` → 打印 lanUrl+token；
  2. 手机：Settings 填三项 → Dashboard 显示连接徽标 `LAN`；
  3. 新建 claude 会话（initialPrompt=写一个 hello world）→ 时间线出现流式文本；
  4. 中途点打断 → 流停住；
  5. 计时：文字在 PC 端 cmd 终端出现→手机渲染 ≤ 1 s（目测）。
- [ ] **Step 3: Commit**：`test(server): M0 e2e 延迟与洪水预算断言` 。

---

### Task 17: CI 基线（import 方向静态检查 + 全测门）

**Files:**
- Create: `.github/workflows/ci.yml`, `tools/check-deps.mjs`, `apps/server/version.ts`(serverVersion 常量源)

- [ ] **Step 1: check-deps.mjs**：解析 server/ 与 protocol 的 import 图，白名单（见 §5.2 表）违规即非零退出（禁止：`agents/ import transport`、`transport import session/agents`、任何对 sqlite 直 import（只允许 persistence/）、`events/ import agents/`、mobile `ui/ import data/transport 细节`（仅允许经 connection/service 接口—dart 简化检查在 mobile analyze 规则里 M1））。
- [ ] **Step 2: CI**：
  ```yaml
  name: ci
  on: [push, pull_request]
  jobs:
    server:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: pnpm/action-setup@v4
          with: { version: 9 }
        - uses: actions/setup-node@v4
          with: { node-version: 22, cache: pnpm }
        - run: pnpm install --frozen-lockfile
        - run: node tools/check-deps.mjs
        - run: pnpm typecheck
        - run: pnpm -r test
    mobile:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: subosito/flutter-action@v2
          with: { channel: stable }
        - run: flutter pub get
          working-directory: apps/mobile
        - run: flutter analyze
          working-directory: apps/mobile
        - run: flutter test
          working-directory: apps/mobile
  ```
- [ ] **Step 3: 手跑**：`node tools/check-deps.mjs` Expected：exit 0；人为添一个反向 import 后 Expected exit 1（验证检查真实起作用——先红一下）。
- [ ] **Step 4: Commit**：`ci: import 方向静态检查+四端测试门（server/memory/sqlite bench 保留）+ Flutter analyze/test`。

---

### Task 18: M0 验收（对照设计出口标准）

条件/操作/预期（验收表，全过才算里程碑完成）：

- [ ] AC-M0-1 手机 LAN 看到流：port+token 配置真机→新建 claude 会话→流式文本渲染。
- [ ] AC-M0-2 打断：时间线停住、`audit` 有 `command.interrupt` 行、重复发同 clientId 不重复执行。
- [ ] AC-M0-3 呈现延迟 ≤ 1000 ms P95（本机 LAN 实测记录 ≥ 20 样本）。
- [ ] AC-M0-4 seq 保序：TC 断网重连期间（拔手机 wifi 5s）不收到乱序（seq 连续）。
- [ ] AC-M0-5 全仓测试：pnpm -r test + flutter test 全绿；check-deps 绿；吞吐基准 ≥ 500 events/s（记录实测）。
- [ ] AC-M0-6 崩溃韧性冒烟：server kill -9 → 重启 → `status` 正常、DB 打开无锁残留（WAL 自恢复）。
- [ ] Commit：`docs(plans): M0 验收记录（实测值 + checklist 勾选）` —— 验收数据写回 `m0-smoke-checklist.md`。

---

## 计划自审记录（Self-Review）

1. **Spec 覆盖**：M0 出口=手机 LAN 看 claude 流+打断 → T10-T16；协议/重放/幂等/保序/洪水/审计/安全升权守卫/架构单向依赖/G 项（G1 LAN/G2 部分/G6 子集）全部落到具体任务。G3/G4/G5/G7 的剩余部分在 M1 计划交付（设计 §9 标注归属，无任务落空）。
2. **占位扫描**：无 TBD/“实现稍后”“类似任务 N”；所有测试给断言与命令。
3. **类型一致性**：`AgentEvent/AgentCommand/Frame/Conveyor/ConversationRepository/SessionManager` 签名在 T2/T4/T7/T9 间交叉引用一致（冻结签名块）；T11 `uiFanout` 依赖 T8 `SessionRecord`。T4 `initialAgentEvent` 与 T5 Trasaction `createSession` 契约一致；T14/T15 仅消费 T2 冻结帧。
4. **运营覆盖**：性能（T5 基准+T16 延迟断言）；幂等（T9/T11）；保序（T8/T16）；审计（T6/T9）；依赖方向（T17）；崩溃韧性（T18 AC-6）。洪水（T8+T16 端到端）。

## 里程碑衔接

M1 计划起点：本计划全部 AC 绿 + 用户真机验收通过。M1 范围（不在此文件展开）：配对 QR（`aimi-server pair`）、mDNS、重放/resume、单设备锁、relay 实现与部署材料、通知链（前台服务长连接）、胜会话权限审批全流程（canUseTool）、Windows 任务计划自启、audit 鉴权细分、Dart DTO 由 schema 生成（快快 typecode CI）。
