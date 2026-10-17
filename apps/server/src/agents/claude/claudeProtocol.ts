import { createHash } from "node:crypto";
import type { AgentEvent } from "@aimi/protocol";

/**
 * claude code `stream-json` 协议的纯归一化层（零 IO、零时间依赖）。
 *
 * 一条 stdout 行 → 0..n 个 `AgentEvent`：把 claude 的私有帧型映射成
 * `@aimi/protocol` 的归一化事件，编排层与手机侧不需要认识任何 claude 字段。
 *
 * 映射表：
 * - `system/init` → `state:running`（`session_id` 由 `parseLine` 单独带出，不 emit）；
 * - `stream_event.event.delta[type=text_delta]` → `text_delta`；
 * - `stream_event.event.delta[type=thinking_delta]` → `thinking`；
 * - `assistant` 中每个 `tool_use` 块 → `tool_call`；
 * - `user` 中每个 `tool_result` 块 → `tool_result`；
 * - `result` → `usage` + `state:finished`（非 `success` 子类型 → `notice:error` + `state:failed`）；
 * - 非 JSON 行 → `notice:warn`（容错，不炸流）。
 *
 * **刻意静默**（容错优先，后续可扩展）：
 * - 未知 `type` 的合法 JSON：不 emit（claude 版本升级新增帧型不应打断会话）；
 * - `assistant` 里的文本块：不 emit（同一文本已由 `--include-partial-messages` 的
 *   `text_delta` 增量送达，再转一次会重复）；
 * - 空白行：不 emit（流尾/心跳空行不应污染手机上可见的事件流）。
 *
 * 不做 `protocolVersion` 探测与协商——当前只针对本机已装 claude 的
 * 当前线格式；版本漂移导致的静默降级暂不处理。
 */

/** 单个摘要字段的取值上限：80 字符，不做省略号。 */
const SUMMARY_MAX = 80;
/** `tool_result` 文本摘录上限：8192 字符。 */
const OUTPUT_MAX = 8192;
/** 非 JSON 行提示文本中保留的原行长度：前 80 字符。 */
const RAW_MAX = 80;

/** `tool_call.summary` 的业务字段探测顺序。 */
const SUMMARY_FIELDS = ["summary", "description", "command", "file_path", "prompt", "name"] as const;

/** 一行原文的归一化产物：事件序列 + 可选续接线索（`system/init.session_id`）。 */
export interface ParsedLine {
  /** 该行映射出的归一化事件（按出现顺序，可能为空）。 */
  readonly events: readonly AgentEvent[];
  /** 出现 `system/init` 时为 claude 侧会话 id——由会话实现存为续接线索，不 emit。 */
  readonly sessionId?: string;
}

/** JSON 对象判据（数组/原始值不算——claude 的帧都是对象）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只取字符串字段，其余（缺字段/类型漂移）一律 `undefined`。 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `inputDigest`：`sha256(JSON.stringify(input))` 前 12 位十六进制。 */
function digestOf(input: unknown): string {
  // `JSON.stringify(undefined)` 返回 undefined（不是字符串）——工具块无 input 时退化到 "null"。
  const json = JSON.stringify(input) ?? "null";
  return createHash("sha256").update(json).digest("hex").slice(0, 12);
}

/** `summary`：按字段序取第一个非空字符串，截 80 字符；全空则空串。 */
function summaryOf(input: unknown): string {
  if (!isRecord(input)) return "";
  for (const field of SUMMARY_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value !== "") return value.slice(0, SUMMARY_MAX);
  }
  return "";
}

/** `assistant` 行 → 每个 `tool_use` 块一个 `tool_call`（文本块刻意跳过：同一文本已由 `text_delta` 增量送达）。 */
function toolCalls(assistant: Record<string, unknown>): AgentEvent[] {
  const message = assistant.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  const events: AgentEvent[] = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    const id = asString(block.id);
    const name = asString(block.name);
    if (id === undefined || name === undefined) continue; // 形状不符：静默跳过（容错优先）
    events.push({ type: "tool_call", id, name, summary: summaryOf(block.input), inputDigest: digestOf(block.input) });
  }
  return events;
}

/** `tool_result` 块 → 拼接文本块截 8192（`exitCode` 在 stream-json 中无来源，故省略）。 */
function toolResults(user: Record<string, unknown>): AgentEvent[] {
  const message = user.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  const events: AgentEvent[] = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_result") continue;
    const id = asString(block.tool_use_id);
    if (id === undefined) continue; // 形状不符：静默跳过
    const parts: string[] = [];
    if (Array.isArray(block.content)) {
      for (const part of block.content) {
        if (!isRecord(part) || part.type !== "text") continue;
        const text = asString(part.text);
        if (text !== undefined) parts.push(text);
      }
    }
    events.push({
      type: "tool_result",
      id,
      ok: block.is_error !== true,
      outputExcerpt: parts.join("").slice(0, OUTPUT_MAX),
    });
  }
  return events;
}

/** `stream_event` 的增量块 → `text_delta`/`thinking`；其余增量类型（input_json_delta 等）不 emit。 */
function deltaOf(streamEvent: Record<string, unknown>): AgentEvent[] {
  const inner = streamEvent.event;
  if (!isRecord(inner)) return [];
  const delta = inner.delta;
  if (!isRecord(delta)) return [];
  if (delta.type === "text_delta") {
    const text = asString(delta.text);
    return text === undefined ? [] : [{ type: "text_delta", text }];
  }
  if (delta.type === "thinking_delta") {
    const text = asString(delta.thinking);
    return text === undefined ? [] : [{ type: "thinking", text }];
  }
  return [];
}

/** 数值字段兜底（缺字段/类型漂移 → `fallback`）。 */
function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** `result` 行 → 成功态 `usage`+`finished`；失败态 `notice:error`+`failed`。 */
function resultOf(result: Record<string, unknown>): AgentEvent[] {
  const subtype = asString(result.subtype);
  if (subtype !== "success") {
    // 提示文本优先取 subtype（机器可读的原因），缺失时退化到 result 的人类可读摘要。
    const text = subtype ?? asString(result.result) ?? "agent result error";
    return [
      { type: "notice", severity: "error", text },
      { type: "state", state: "failed" },
    ];
  }
  const usage = isRecord(result.usage) ? result.usage : {};
  const cost = result.total_cost_usd;
  const usageEvent: AgentEvent = {
    type: "usage",
    tokensIn: num(usage.input_tokens, 0),
    tokensOut: num(usage.output_tokens, 0),
    ...(typeof cost === "number" && Number.isFinite(cost) ? { cost } : {}),
  };
  return [usageEvent, { type: "state", state: "finished" }];
}

/**
 * 归一化一行 claude `stream-json` 输出。
 * @param line 单行原文（**不含**行尾换行符；调用方负责行缓冲）。
 * @returns 事件序列与可选 `session_id`（空白行 → 空序列）。
 */
export function parseLine(line: string): ParsedLine {
  if (line.trim() === "") return { events: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { events: [{ type: "notice", severity: "warn", text: "non-json line: " + line.slice(0, RAW_MAX) }] };
  }
  if (!isRecord(raw)) return { events: [] };

  switch (raw.type) {
    case "system": {
      if (raw.subtype !== "init") return { events: [] };
      const sessionId = asString(raw.session_id);
      return sessionId === undefined
        ? { events: [{ type: "state", state: "running" }] }
        : { events: [{ type: "state", state: "running" }], sessionId };
    }
    case "stream_event":
      return { events: deltaOf(raw) };
    case "assistant":
      return { events: toolCalls(raw) };
    case "user":
      return { events: toolResults(raw) };
    case "result":
      return { events: resultOf(raw) };
    default:
      return { events: [] };
  }
}

/**
 * 归一化一行（只取事件面；续接线索由 `parseLine` 单独暴露）。
 * @param line 单行原文（不含行尾换行符）。
 * @returns 该行映射出的归一化事件。
 */
export function normalizeLine(line: string): AgentEvent[] {
  return [...parseLine(line).events];
}
