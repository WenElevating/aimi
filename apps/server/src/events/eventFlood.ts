import type { AgentEvent } from "@aimi/protocol";

/**
 * 洪水控制冻结参数（设计 §5.3）：delta 聚合窗口、单字段 payload 上限、截断标记。
 * 本模块是洪水规则的唯一实现处——T9/T11 不得重复实现（简报「规则集中于此，别处不重复实现」）。
 * `maxPayloadBytes` 语义 = **截断前的载荷预算**：超它则截为「前 8192 字符 + 标记」；
 * 截断后单事件可达 `PAYLOAD_CAP`（= 8192 + 标记宽，见 protocol 的 `zodFrames.ts`），契约校验上限按后者。
 */
export const FLOOD = { deltaWindowMs: 100, maxPayloadBytes: 8192, truncateMark: "…(truncated)" } as const;

/** 可聚合的 delta 事件：窗口内相邻同类 delta 合并为一条（其余事件是窗口边界）。 */
export type DeltaEvent = Extract<AgentEvent, { type: "text_delta" } | { type: "thinking" }>;

/**
 * 是否为可聚合 delta。判定规则集中于此，避免 EventBus 另行内联一份（两份易漂移）。
 * @param event 归一化 agent 事件。
 */
export function isDeltaEvent(event: AgentEvent): event is DeltaEvent {
  return event.type === "text_delta" || event.type === "thinking";
}

/** 单字段截断：超过 `maxPayloadBytes` 字符 → 前 8192 字符 + 截断标记；否则原样。 */
function truncateField(text: string): string {
  return text.length > FLOOD.maxPayloadBytes
    ? text.slice(0, FLOOD.maxPayloadBytes) + FLOOD.truncateMark
    : text;
}

/**
 * 单事件 payload 上限（§5.3）：超 8192 字符的 `text`/`outputExcerpt` 截断为「前 8192 字符 + "…(truncated)"」。
 * 覆盖 `text_delta.text`、`thinking.text`、`notice.text`、`tool_result.outputExcerpt`。
 * 幂等；未超限时原样返回入参（事件对象引用不变，便于上游省去无谓拷贝）。
 * @param event 归一化 agent 事件。
 * @returns 截断后的事件（无超限字段时即入参本身）。
 */
export function truncatePayload(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case "text_delta":
    case "thinking":
    case "notice": {
      const text = truncateField(event.text);
      return text === event.text ? event : { ...event, text };
    }
    case "tool_result": {
      const outputExcerpt = truncateField(event.outputExcerpt);
      return outputExcerpt === event.outputExcerpt ? event : { ...event, outputExcerpt };
    }
    default:
      return event;
  }
}

/** 单会话待合并的 delta 缓冲：窗口锚点 + 顺序累积的文本片段。 */
interface PendingDelta {
  /** 合并产物的类型（同类才合并；类型切换即窗口边界）。 */
  readonly kind: DeltaEvent["type"];
  /** 窗口锚点：首条 delta 的 now（合并事件的 ts 由 EventBus 取它）。 */
  readonly ts: number;
  /** 按到达顺序累积的文本片段。 */
  readonly parts: string[];
}

/**
 * delta 聚合缓冲（§5.3 的窗口语义）。按会话独立持有 pending，跨会话互不影响。
 * 本类只负责「内容合并」；seq 分配、定时器与 promise 兑现由 EventBus 负责（职责分离）。
 */
export class DeltaAggregator {
  readonly #pending = new Map<string, PendingDelta>();

  /**
   * 尝试缓冲一条 delta。
   * @param sessionId 会话 id（缓冲按会话隔离）。
   * @param event 已截断的 delta 事件。
   * @param now 本条到达时刻（毫秒）。
   * @returns `null` = 已缓冲（尚未产出事件）；返回事件 = 缓冲本条之前冲刷出的合并产物
   *   （窗口已过，或 delta 类型与待合并者不同）。两种情形下本条事件都已被缓冲——
   *   EventBus 据此先产出旧聚合、再等本条的下一次冲刷，从而保住顺序。
   */
  offer(sessionId: string, event: DeltaEvent, now: number): AgentEvent | null {
    const pending = this.#pending.get(sessionId);
    if (pending === undefined) {
      this.#pending.set(sessionId, { kind: event.type, ts: now, parts: [event.text] });
      return null;
    }
    if (pending.kind === event.type && now - pending.ts < FLOOD.deltaWindowMs) {
      pending.parts.push(event.text);
      return null;
    }
    const merged = this.#take(sessionId);
    this.#pending.set(sessionId, { kind: event.type, ts: now, parts: [event.text] });
    return merged;
  }

  /**
   * 冲刷某会话 pending（窗口到期、非 delta 边界或装配层关闭时由 EventBus 调用）。
   * @param sessionId 会话 id。
   * @param now 窗口边界时刻；本实现不据其判定（冲刷时机由调用方决定），保留以对齐冻结签名。
   * @returns 合并事件（`text` 顺序连接、类型取首条、合并后再过一遍 8KB 截断）；无 pending 时 `null`。
   */
  flush(sessionId: string, now: number): AgentEvent | null {
    void now;
    return this.#take(sessionId);
  }

  /** 取出并清除某会话 pending，合成一条事件（无 pending 时 `null`）。 */
  #take(sessionId: string): AgentEvent | null {
    const pending = this.#pending.get(sessionId);
    if (pending === undefined) return null;
    this.#pending.delete(sessionId);
    const text = pending.parts.join("");
    const merged: AgentEvent =
      pending.kind === "thinking" ? { type: "thinking", text } : { type: "text_delta", text };
    // 合并后仍受 payload 上限约束（§5.3 不变量：单事件 ≤ 8KB + 标记）。
    return truncatePayload(merged);
  }
}
