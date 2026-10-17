import { z } from "zod";
import type { ClientFrame, ServerFrame } from "./frames.js";

/**
 * 单字段载荷上限（截断后的总宽）：8192 字符正文加截断标记 "…(truncated)" 的宽度。
 * 截断产物总宽恰好等于本值、必须被解析放行；本值与文本截断所用的上限必须相等，否则合法截断产物会被拒。
 */
export const PAYLOAD_CAP = 8192 + "…(truncated)".length;

const phonePermissionMode = z.enum(["default", "plan"] as const);

/** error 帧错误码的唯一取值域；出现域外 code 即视为非法帧。 */
const frameErrorCode = z.enum([
  "auth.invalid_token", "auth.pairing_expired", "protocol.bad_frame",
  "session.not_found", "session.agent_missing", "session.duplicate_command",
  "server.busy",
]);

/** welcome 帧中会话列表项的结构契约。 */
const sessionMeta = z.object({
  id: z.string(), agentId: z.string(), cwd: z.string(), permissionMode: phonePermissionMode,
  state: z.enum(["starting", "running", "waiting_approval", "waiting_input", "finished", "failed", "stopped"]),
  lastSeq: z.number().int().nonnegative(), createdAt: z.number(), updatedAt: z.number(),
});

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
  z.object({ type: z.literal("text_delta"), text: z.string().max(PAYLOAD_CAP) }),
  z.object({ type: z.literal("thinking"), text: z.string().max(PAYLOAD_CAP) }),
  z.object({ type: z.literal("tool_call"), id: z.string(), name: z.string(), summary: z.string(), inputDigest: z.string() }),
  z.object({ type: z.literal("tool_result"), id: z.string(), ok: z.boolean(), outputExcerpt: z.string().max(PAYLOAD_CAP), exitCode: z.number().int().optional() }),
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
  z.object({ v: z.literal(1), type: z.literal("welcome"), serverVersion: z.string(), sessions: z.array(sessionMeta) }),
  z.object({ v: z.literal(1), type: z.literal("pong"), nonce: z.number().int() }),
  z.object({ v: z.literal(1), type: z.literal("bye"), reason: z.string() }),
  z.object({ v: z.literal(1), type: z.literal("session.event"), sessionId: z.string(), seq: z.number().int().nonnegative(),
    ts: z.number(), agentEvent }),
  z.object({ v: z.literal(1), type: z.literal("ack"), sessionId: z.string() }),
  z.object({ v: z.literal(1), type: z.literal("error"), code: frameErrorCode, message: z.string() }),
]);

/** 解析手机发来的帧：符合契约才返回，任何不符（未知类型、越权取值等）一律返回 null。 */
export function parseClientFrame(raw: unknown): ClientFrame | null {
  const r = clientFrame.safeParse(raw); return r.success ? (r.data as ClientFrame) : null;
}
export function parseServerFrame(raw: unknown): ServerFrame | null {
  const r = serverFrame.safeParse(raw); return r.success ? (r.data as ServerFrame) : null;
}
