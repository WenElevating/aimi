import { z } from "zod";
import type { ClientFrame, ServerFrame } from "./frames.js";

/**
 * 单字段载荷上限（截断后的总宽）：8192 字符正文加截断标记 "…(truncated)" 的宽度。
 * 截断产物总宽恰好等于本值、必须被解析放行；本值与文本截断所用的上限必须相等，否则合法截断产物会被拒。
 */
export const PAYLOAD_CAP = 8192 + "…(truncated)".length;

const phonePermissionMode = z.enum(["default", "plan", "acceptEdits", "bypassPermissions"] as const);

const helloCapabilities = z.object({
  permissionModes: z.array(phonePermissionMode).optional(),
});

/** error 帧错误码的唯一取值域；出现域外 code 即视为非法帧。 */
const frameErrorCode = z.enum([
  "auth.invalid_token",
  "auth.pairing_expired",
  "auth.pairing_failed",
  "protocol.bad_frame",
  "session.not_found",
  "session.agent_missing",
  "session.duplicate_command",
  "server.busy",
  "protocol.rate_limited",
]);

/** welcome 帧中会话列表项的结构契约；resumable 必填（server 依 resume_hint 有无派生）。 */
const sessionMeta = z.object({
  id: z.string(),
  agentId: z.string(),
  cwd: z.string(),
  permissionMode: phonePermissionMode,
  model: z.string().optional(),
  state: z.enum(["starting", "running", "waiting_approval", "waiting_input", "finished", "failed", "stopped"]),
  lastSeq: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
  resumable: z.boolean(),
});

/** welcome 帧中单条 agent 能力投影的结构契约（模型清单 + 权限上限）。 */
const agentCapability = z.object({
  id: z.string().min(1),
  label: z.string(),
  permissionCeiling: phonePermissionMode,
  models: z.array(
    z.object({
      value: z.string().min(1),
      name: z.string().min(1),
      detail: z.string().optional(),
    }),
  ),
});

const agentCommand = z.discriminatedUnion("cmd", [
  z.object({
    cmd: z.literal("send"),
    text: z.string().max(64 * 1024),
    files: z
      .array(z.object({ name: z.string().max(255), b64: z.string().max(1_400_000) }))
      .max(5)
      .optional(),
  }),
  z.object({ cmd: z.literal("interrupt") }),
  z.object({ cmd: z.literal("approve"), requestId: z.string().min(1), decision: z.enum(["once", "always", "reject"]) }),
  z.object({ cmd: z.literal("answer"), questionId: z.string().min(1), value: z.string().max(4 * 1024) }),
  z.object({
    cmd: z.literal("configure"),
    model: z.string().min(1).optional(),
    permissionMode: phonePermissionMode.optional(),
  }),
  z.object({ cmd: z.literal("stop") }),
  z.object({ cmd: z.literal("restart") }),
]);

const agentEvent = z.union([
  z.object({
    type: z.literal("state"),
    state: z.enum(["starting", "running", "waiting_approval", "waiting_input", "finished", "failed", "stopped"]),
  }),
  z.object({ type: z.literal("text_delta"), text: z.string().max(PAYLOAD_CAP), error: z.boolean().optional() }),
  z.object({ type: z.literal("thinking"), text: z.string().max(PAYLOAD_CAP) }),
  z.object({
    type: z.literal("tool_call"),
    id: z.string(),
    name: z.string(),
    summary: z.string(),
    inputDigest: z.string(),
  }),
  z.object({
    type: z.literal("tool_result"),
    id: z.string(),
    ok: z.boolean(),
    outputExcerpt: z.string().max(PAYLOAD_CAP),
    exitCode: z.number().int().optional(),
  }),
  z.object({
    type: z.literal("permission"),
    id: z.string(),
    title: z.string(),
    detail: z.string(),
    options: z.array(z.object({ label: z.string(), kind: z.enum(["once", "always", "reject"]) })),
  }),
  z.object({
    type: z.literal("question"),
    id: z.string(),
    prompt: z.string(),
    options: z.array(z.object({ label: z.string(), value: z.string() })),
  }),
  z.object({
    type: z.literal("usage"),
    tokensIn: z.number().nonnegative(),
    tokensOut: z.number().nonnegative(),
    cost: z.number().optional(),
  }),
  z.object({ type: z.literal("notice"), severity: z.enum(["info", "warn", "error"]), text: z.string() }),
  z.object({ type: z.literal("configured"), model: z.string().min(1) }),
  z.object({
    type: z.literal("exit"),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().nonnegative(),
    stderrTail: z.string().max(600).optional(),
  }),
]);

/** hello 变体①：token 鉴权（M0 形态）；resume 保留 null 兼容——M0 客户端只发 null。 */
const helloToken = z.object({
  v: z.literal(1),
  type: z.literal("hello"),
  token: z.string().min(8),
  resume: z.union([z.null(), z.record(z.number().int().nonnegative())]),
  commandAck: z.boolean().optional(),
  capabilities: helloCapabilities.optional(),
});
/** hello 变体②上限：64 字符——人工命名的可读上限，单一源避免 schema 内裸魔数。 */
const DEVICE_NAME_MAX = 64;
/** hello 变体②：配对握手——pairingCode 恰 8 位数字（人工可转抄、服务端一次性核销）。 */
const helloPair = z.object({
  v: z.literal(1),
  type: z.literal("hello"),
  pairingCode: z.string().regex(/^\d{8}$/),
  deviceName: z.string().min(1).max(DEVICE_NAME_MAX),
  commandAck: z.boolean().optional(),
  capabilities: helloCapabilities.optional(),
});

/** update.info 帧 latest 的结构契约；downloadPath 必须以 "/" 开头（相对路径，见 frames.ts 注释）。
 *  导出供服务端读取磁盘发布清单（manifest.json）时复用同一校验源。 */
export const appUpdateManifest = z.object({
  versionName: z.string().min(1).max(64),
  versionCode: z.number().int().positive(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  downloadPath: z.string().regex(/^\//).max(255),
  notes: z.string().max(1024).optional(),
});

const clientFrame = z.union([
  helloToken,
  helloPair,
  z.object({ v: z.literal(1), type: z.literal("ping"), nonce: z.number().int() }),
  z.object({
    v: z.literal(1),
    type: z.literal("session.create"),
    spec: z.object({
      agentId: z.string().min(1),
      cwd: z.string().min(1),
      model: z.string().optional(),
      permissionMode: phonePermissionMode,
      initialPrompt: z
        .string()
        .max(64 * 1024)
        .optional(),
    }),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal("session.command"),
    sessionId: z.string().min(1),
    clientId: z.string().min(8).max(64),
    cmd: agentCommand,
  }),
  z.object({ v: z.literal(1), type: z.literal("update.check") }),
  z.object({
    v: z.literal(1),
    type: z.literal("directory.list"),
    requestId: z.string().min(8).max(64),
    path: z.string().max(4096),
  }),
]);

const serverFrame = z.union([
  z.object({
    v: z.literal(1),
    type: z.literal("welcome"),
    serverVersion: z.string(),
    sessions: z.array(sessionMeta),
    agents: z.array(agentCapability).optional(),
  }),
  z.object({ v: z.literal(1), type: z.literal("pong"), nonce: z.number().int() }),
  z.object({ v: z.literal(1), type: z.literal("bye"), reason: z.string() }),
  z.object({ v: z.literal(1), type: z.literal("paired"), token: z.string(), deviceId: z.string() }),
  z.object({
    v: z.literal(1),
    type: z.literal("session.event"),
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    ts: z.number(),
    agentEvent,
  }),
  z.object({ v: z.literal(1), type: z.literal("ack"), sessionId: z.string() }),
  z.object({
    v: z.literal(1),
    type: z.literal("command.ack"),
    sessionId: z.string(),
    clientId: z.string().min(8).max(64),
    status: z.enum(["accepted", "delivered", "duplicate", "rejected"]),
    code: frameErrorCode.optional(),
  }),
  z.object({ v: z.literal(1), type: z.literal("error"), code: frameErrorCode, message: z.string() }),
  z.object({ v: z.literal(1), type: z.literal("update.info"), latest: appUpdateManifest.nullable() }),
  z.object({
    v: z.literal(1),
    type: z.literal("directory.result"),
    requestId: z.string().min(8).max(64),
    path: z.string().optional(),
    parent: z.string().optional(),
    entries: z.array(z.object({ name: z.string(), path: z.string() })).optional(),
    error: z.enum(["invalid_path", "not_found", "permission_denied", "not_directory", "io_error"]).optional(),
  }),
]);

/**
 * 解析手机发来的帧：符合契约才返回，任何不符（未知类型、越权取值等）一律返回 null。
 *
 * @param raw - 已做 JSON 解码的原始值
 * @returns 通过契约校验的手机帧；不合法时为 null
 */
export function parseClientFrame(raw: unknown): ClientFrame | null {
  const r = clientFrame.safeParse(raw);
  return r.success ? (r.data as ClientFrame) : null;
}
/**
 * 解析 server 发往手机的帧：符合契约才返回，任何不符一律返回 null。
 *
 * @param raw - 已做 JSON 解码的原始值
 * @returns 通过契约校验的服务端帧；不合法时为 null
 */
export function parseServerFrame(raw: unknown): ServerFrame | null {
  const r = serverFrame.safeParse(raw);
  return r.success ? (r.data as ServerFrame) : null;
}
