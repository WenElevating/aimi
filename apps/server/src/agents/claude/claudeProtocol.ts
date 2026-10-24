import { createHash } from "node:crypto";
import type { AgentEvent } from "@aimi/protocol";

/**
 * claude code `stream-json` 协议的纯归一化层（零 IO、零时间依赖）。
 *
 * 把每条 stdout 行映射为 0 到 n 个 `AgentEvent`：将 claude 的私有帧型翻译成
 * `@aimi/protocol` 的归一化事件，编排层与手机侧不需要认识任何 claude 字段。
 *
 * 映射表（左侧 claude 私有帧产出的右侧归一化事件）：
 * - `system/init`：产出 `state:running`（`session_id` 由 `parseLine` 单独带出，不 emit）；
 * - `stream_event.event.delta[type=text_delta]`：产出 `text_delta`；
 * - `stream_event.event.delta[type=thinking_delta]`：产出 `thinking`；
 * - `assistant` 中每个 `tool_use` 块：产出 `tool_call`；
 * - `user` 中每个 `tool_result` 块：产出 `tool_result`；
 * - `result`：产出 `usage` 与 `state:finished`；`is_error` 或非 `success` 子类型则把错误
 *   原因产出为 `text_delta`（在模型输出的位置展示）并落 `state:failed`
 *   （打断专属子类型落 `stopped`）；
 * - 非 JSON 行：产出 `notice:warn`（容错，不炸流）。
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
/** 错误原因文本上限：CLI 的错误串（含 request id 等）500 字符足够定位。 */
const ERROR_TEXT_MAX = 500;

/** `tool_call.summary` 的业务字段探测顺序。 */
const SUMMARY_FIELDS = ["summary", "description", "command", "file_path", "prompt", "name"] as const;

/** 一行原文的归一化产物：事件序列 + 可选续接线索（`system/init.session_id`）+ 可选控制应答。 */
export interface ParsedLine {
  /** 该行映射出的归一化事件（按出现顺序，可能为空） */
  readonly events: readonly AgentEvent[];
  /** 出现 `system/init` 时为 claude 侧会话 id——由会话实现存为续接线索，不 emit */
  readonly sessionId?: string;
  /** 出现 `control_response` 时为控制请求的应答（set_model/set_permission_mode 等的成败），不 emit */
  readonly controlResponse?: ControlResponse;
}

/** claude 控制请求的应答：`success` 或带原因的 `error`（形状按防御式解析，字段缺失不致命）。 */
export interface ControlResponse {
  /** 发出时的 `request_id` 原样回传 */
  readonly requestId: string;
  /** `true`=CLI 已接受；`false`=CLI 拒绝（原因见 `errorMessage`） */
  readonly success: boolean;
  /** 拒绝原因（CLI 给出时才有）；截到 200 字符防刷屏 */
  readonly errorMessage?: string;
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

/** 从 `assistant` 行取工具调用：每个 `tool_use` 块产出一个 `tool_call`（文本块刻意跳过：同一文本已由 `text_delta` 增量送达）。 */
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

/** 从 `user` 行取工具结果：拼接其中的文本块并截 8192（`exitCode` 在 stream-json 中无来源，故省略）。 */
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

/** 把 `stream_event` 的文本/思考增量块映射为 `text_delta`/`thinking`；其余增量类型（input_json_delta 等）不 emit。 */
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

/** 数值字段兜底（缺字段或类型漂移时取 `fallback`）。 */
function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 应答上限：CLI 拒绝原因足够定位即可，不刷屏。 */
const CONTROL_ERROR_MAX = 200;

/**
 * 归一化 `control_response` 行：取 `request_id` 与 `response.subtype`（`success`/`error`），
 * `error` 原因取 `response.error`（字符串时）。形状漂移一律降级为 `success=false` + 无原因，
 * 不抛错（容错优先：应答解析失败不应打断会话事件流）。
 */
function controlResponseOf(raw: Record<string, unknown>): ControlResponse {
  const response = isRecord(raw.response) ? raw.response : {};
  // request_id 实测在内层 response（顶层字段兜一手，防御 CLI 形状漂移）。
  const requestId = asString(raw.request_id) ?? asString(response.request_id) ?? "";
  const subtype = asString(response.subtype);
  const success = subtype === "success";
  const error = asString(response.error);
  return {
    requestId,
    success,
    ...(success || error === undefined ? {} : { errorMessage: error.slice(0, CONTROL_ERROR_MAX) }),
  };
}

/** 归一化 `result` 行：成功时产出 `usage` 与 `finished`，打断时产出打断提示与 `stopped`，其余失败产出 `notice:error` 与 `failed`。 */
function resultOf(result: Record<string, unknown>): AgentEvent[] {
  const subtype = asString(result.subtype);
  if (subtype !== "success") {
    // SPIKE FACT2：`error_during_execution` 是打断专属 subtype（is_error 但进程不退）——手机语义
    // 是「已打断」而非「失败」，状态落 stopped（服务端 interrupt 路已先行发 stopped，迟到的同态帧
    // 由编排层同状态去重）；纯执行错误不走此路（FACT2：模型经 tool_result is_error 收尾 result success）。
    if (subtype === "error_during_execution") {
      return [
        { type: "notice", severity: "warn", text: "执行被打断" },
        { type: "state", state: "stopped" },
      ];
    }
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
  // CLI 把鉴权/配额等 API 失败包成 synthetic 回复 + `success` result（is_error=true）：
  // 只看 subtype 会伪装成"正常完成"，手机零输出却无任何原因。错误原因按**模型输出的位置**
  // 以 text_delta 送达（用户裁决：不要通知条），并置 error 让手机以红色渲染；
  // 状态落 failed 让回合留下终态（用户裁决：失败回合不要「续接」入口）。
  if (result.is_error === true) {
    const text = asString(result.result) ?? "agent 返回错误（未携带原因）";
    return [
      { type: "text_delta", text: text.slice(0, ERROR_TEXT_MAX), error: true },
      usageEvent,
      { type: "state", state: "failed" },
    ];
  }
  return [usageEvent, { type: "state", state: "finished" }];
}

/**
 * 归一化一行 claude `stream-json` 输出。
 *
 * @param line - 单行原文（**不含**行尾换行符；调用方负责行缓冲）
 * @returns 事件序列与可选 `session_id`；空白行得到空序列
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

  if (raw.type === "control_response") {
    return { events: [], controlResponse: controlResponseOf(raw) };
  }

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
 *
 * @param line - 单行原文（不含行尾换行符）
 * @returns 该行映射出的归一化事件
 */
export function normalizeLine(line: string): AgentEvent[] {
  return [...parseLine(line).events];
}
