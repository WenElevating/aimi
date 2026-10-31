import { createHash } from "node:crypto";
import type { AgentEvent } from "@aimi/protocol";

/**
 * zcode `--output-format stream-json` 的纯归一化层（零 IO、零时间依赖）。
 *
 * zcode 每行输出一个会话事件 `{eventId,payload,seq,sessionId,timestamp,traceId,turnId,type}`
 * （NDJSON；`type` 为点分命名，如 `turn.started`）。本层把它翻译成 `@aimi/protocol`
 * 的归一化事件，编排层与手机侧不需要认识任何 zcode 字段。
 *
 * 事件族以两处实证为准：本机实跑冻结样本（`__fixtures__/probe-plan-failure.jsonl`，
 * 覆盖 `turn.failed` 失败路径）与桌面版 transcript.jsonl 的 payload 形状（成功路径的
 * 文本/思考/工具事件族）。**成功路径的流式帧命名尚未在真实 stream 中冻结**（provider
 * 余额不足），故本层按「点分/下划线双命名归一 + 未知类型静默」防御：zcode 升级新增
 * 帧型不应打断会话；拿到成功样本后在此补映射并回填 fixture。
 *
 * 映射表（`type` 点分归一为下划线后匹配；左侧 zcode 帧产出右侧归一化事件）：
 * - `turn_started`：产出 `state:running`；
 * - `model_streaming`：`kind=text_delta` 产出 `text_delta`，`kind=reasoning_delta` 产出
 *   `thinking`；`*_start`/`*_end` 与空 delta 不 emit（起止哨兵无内容）；
 * - `tool_call_scheduled`：产出 `tool_call`（`summary` 按业务字段序探测、`inputDigest`
 *   为 sha256(input) 前 12 位，同 claude 口径）；
 * - `streaming_tool_ledger_updated`：`status=tool_result_committed` 产出 `tool_result`
 *   （ok 按 error 字段判；**输出正文不内联**——zcode 只给 resultPartId 引用，M1 摘录
 *   为空串，工具卡 ok 状态与展开降级可见 docs）；`queued/started/closed` 不 emit；
 * - `model_complete`：`usage` 存在时产出 `usage`（tokensIn/tokensOut；缓存 token 不映射）；
 * - `turn_complete`：产出 `state:finished`；
 * - `turn_failed`：产出 `notice:error`（错误归因原文，500 字符上限）+ `state:failed`；
 * - `session_updated`：携带 `modelId` 时由 `parseLine` 带出（不 emit）——CLI 无 `--model`，
 *   模型跟随全局 provider 配置，会话实现据此发 `configured`；
 * - **刻意静默**：`session_titleUpdated`（标题由 cwd 派生）、`model_request_started/failed`
 *   （失败由 turn_failed 收口）、`unknown_error`（同前）、`result`（批处理汇总帧，zcode
 *   文档承诺存在但字段随构建漂移）、`stream_recovery_anchor_created`、`ephemeral`、
 *   未知 `type` 的合法 JSON、空白行。
 * - 非 JSON 行：产出 `notice:warn`（容错，不炸流）。
 */

/** 单个摘要字段的取值上限：80 字符，不做省略号。 */
const SUMMARY_MAX = 80;
/** 非 JSON 行提示文本中保留的原行长度：前 80 字符。 */
const RAW_MAX = 80;
/** 错误原因文本上限：CLI 的错误串（含 request id 等）500 字符足够定位。 */
const ERROR_TEXT_MAX = 500;
/** `tool_result.outputExcerpt` 上限：zcode 不内联结果正文，M1 恒为空串；上限与协议对齐。 */
const OUTPUT_MAX = 8192;

/** `tool_call.summary` 的业务字段探测顺序（zcode 工具入参常见键 + claude 同款兜底序）。 */
const SUMMARY_FIELDS = [
  "summary",
  "description",
  "command",
  "file_path",
  "path",
  "prompt",
  "query",
  "url",
  "name",
] as const;

/** 一行原文的归一化产物：事件序列 + 可选会话 id + 可选实测模型。 */
export interface ParsedLine {
  /** 该行映射出的归一化事件（按出现顺序，可能为空） */
  readonly events: readonly AgentEvent[];
  /** zcode 侧会话 id（每行都带）——由会话实现存为续接线索（`--resume` 用），不 emit */
  readonly sessionId?: string;
  /** `session_updated` 带出的 CLI 实测模型（如 `deepseek-v4-flash`）——由会话实现比对后发 `configured`，不 emit */
  readonly modelId?: string;
}

/** JSON 对象判据（数组/原始值不算——zcode 的帧都是对象）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只取字符串字段，其余（缺字段/类型漂移）一律 `undefined`。 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `inputDigest`：`sha256(JSON.stringify(input))` 前 12 位十六进制。 */
function digestOf(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input ?? null))
    .digest("hex")
    .slice(0, 12);
}

/** `tool_call.summary`：按业务字段序取第一个非空字符串，截 80 字符；全空则 JSON 摘要。 */
function summaryOf(input: unknown): string {
  if (!isRecord(input)) return "";
  // 经 Map 取值（eslint security 规则拒绝泛型下标访问；字段优先级不变）。
  const values = new Map(Object.entries(input));
  for (const field of SUMMARY_FIELDS) {
    const value = asString(values.get(field));
    if (value !== undefined && value !== "") return value.slice(0, SUMMARY_MAX);
  }
  const flattened = JSON.stringify(input) ?? "";
  return flattened.slice(0, SUMMARY_MAX);
}

/** 错误归因文本的防御式提取：zcode 的错误字段层级随版本漂移，按序探测第一个非空字符串。 */
function errorTextOf(payload: Record<string, unknown>): string | undefined {
  const candidates = [payload.error, payload];
  for (const node of candidates) {
    if (!isRecord(node)) continue;
    // 经 Map 取值（eslint security 规则拒绝泛型下标访问；字段探测序不变）。
    const values = new Map(Object.entries(node));
    for (const field of ["errorMessage", "underlyingErrorMessage", "message", "detail"] as const) {
      const value = asString(values.get(field));
      if (value !== undefined && value !== "") return value.slice(0, ERROR_TEXT_MAX);
    }
  }
  return undefined;
}

/**
 * 解析一行 zcode stream-json 输出。
 *
 * 非对象 JSON / 非法 JSON 都不抛错（容错优先）：前者静默、后者产出 `notice:warn`；
 * 调用方无需预清洗行内容。
 */
export function parseLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (trimmed === "") return { events: [] };
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return {
      events: [{ type: "notice", severity: "warn", text: `zcode 非 JSON 行：${trimmed.slice(0, RAW_MAX)}` }],
    };
  }
  if (!isRecord(decoded)) return { events: [] };

  const sessionId = asString(decoded.sessionId);
  // type 为点分命名（turn.started）；统一归一为下划线后匹配，兼容两种命名的线格式。
  const type = asString(decoded.type)?.replaceAll(".", "_");
  const payload = isRecord(decoded.payload) ? decoded.payload : {};
  const parsed = type === undefined ? { events: [] as AgentEvent[] } : parseSessionEvent(type, payload);
  return { events: parsed.events, sessionId, modelId: parsed.modelId };
}

/**
 * 解析一个 zcode 会话事件的 type + payload（stream-json 行解析与 app-server
 * `session/event` 通知共用的归一化核心；type 已点分归一为下划线）。
 */
export function parseSessionEvent(type: string, payload: Record<string, unknown>): ParsedLine {
  const events: AgentEvent[] = [];

  switch (type) {
    case "turn_started":
      events.push({ type: "state", state: "running" });
      break;
    case "model_streaming": {
      const kind = asString(payload.kind);
      const delta = asString(payload.delta) ?? "";
      if (kind === "text_delta" && delta !== "") events.push({ type: "text_delta", text: delta });
      if (kind === "reasoning_delta" && delta !== "") events.push({ type: "thinking", text: delta });
      break;
    }
    case "tool_call_scheduled":
      events.push({
        type: "tool_call",
        id: asString(payload.toolCallId) ?? "",
        name: asString(payload.toolName) ?? "unknown",
        summary: summaryOf(payload.input),
        inputDigest: digestOf(payload.input),
      });
      break;
    case "streaming_tool_ledger_updated": {
      // 结果正文不内联（zcode 只回 resultPartId 引用），M1 摘录为空串；ok 由 error 字段判。
      if (payload.status === "tool_result_committed") {
        events.push({
          type: "tool_result",
          id: asString(payload.toolCallId) ?? "",
          ok: payload.error === undefined,
          outputExcerpt: asString(payload.result)?.slice(0, OUTPUT_MAX) ?? "",
        });
      }
      break;
    }
    case "model_complete": {
      const usage = isRecord(payload.usage) ? payload.usage : undefined;
      const tokensIn = usage?.inputTokens;
      const tokensOut = usage?.outputTokens;
      if (typeof tokensIn === "number" && typeof tokensOut === "number") {
        events.push({ type: "usage", tokensIn, tokensOut });
      }
      break;
    }
    // 回合终态：batch 流实测 `turn_complete`；contracts 事件值为 `turn_complete`，v4 面为
    // `turn.completed`（点分归一后 turn_completed）——两种拼写都收，防协议面漂移。
    // resultType=cancelled（打断）→ stopped；其余 finished。
    case "turn_complete":
    case "turn_completed": {
      const resultType = asString(payload.resultType);
      events.push({ type: "state", state: resultType === "cancelled" ? "stopped" : "finished" });
      break;
    }
    case "turn_failed":
    case "turn_error": {
      const text = errorTextOf(payload) ?? "回合执行失败";
      events.push({ type: "notice", severity: "error", text });
      events.push({ type: "state", state: "failed" });
      break;
    }
    case "session_updated": {
      const modelId = asString(payload.modelId);
      if (modelId !== undefined) return { events, modelId };
      break;
    }
    default:
      break;
  }
  return { events };
}
