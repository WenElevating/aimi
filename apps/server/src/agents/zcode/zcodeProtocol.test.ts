import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLine } from "./zcodeProtocol.js";

/** 读取冻结的真实探针样本（本机 `--output-format stream-json --mode plan` 实跑，含失败路径）。 */
function probeFixture(): string[] {
  const file = join(import.meta.dirname, "__fixtures__", "probe-plan-failure.jsonl");
  return readFileSync(file, "utf8").trim().split("\n");
}

describe("zcodeProtocol parseLine", () => {
  it("真实探针样本回放：titleUpdated 静默、turn.started→running、session.updated 带出 modelId、turn.failed→notice+failed", () => {
    const lines = probeFixture();
    // 行 1：session.titleUpdated —— 刻意静默，但 sessionId 每行都带出。
    const first = parseLine(lines[0]!);
    expect(first.events).toEqual([]);
    expect(first.sessionId).toBe("sess_28e500b8-8076-4dd6-bf96-6c86752e5843");

    // 行 2：turn.started —— state:running。
    const started = parseLine(lines[1]!);
    expect(started.events).toEqual([{ type: "state", state: "running" }]);

    // 行 4（session.updated 带 modelId）：不 emit，但 modelId 带出。
    const modelLine = lines.find((l) => parseLine(l).modelId !== undefined);
    expect(modelLine).toBeDefined();
    expect(parseLine(modelLine!).modelId).toBe("deepseek-v4-flash");
    expect(parseLine(modelLine!).events).toEqual([]);

    // 末行：turn.failed —— notice:error（错误归因原文）+ state:failed。
    const failed = parseLine(lines[lines.length - 1]!);
    expect(failed.events).toHaveLength(2);
    expect(failed.events[0]).toMatchObject({ type: "notice", severity: "error" });
    expect((failed.events[0] as { text: string }).text).toContain("Insufficient Balance");
    expect(failed.events[1]).toEqual({ type: "state", state: "failed" });
  });

  it("成功路径（transcript 形状合成）：流式文本/思考、工具调用/结果、usage、turn_complete→finished", () => {
    // 文本增量：kind=text_delta。
    expect(
      parseLine(
        JSON.stringify({
          type: "model.streaming",
          payload: { assistantMessageId: "m1", delta: "你好", done: false, kind: "text_delta" },
        }),
      ).events,
    ).toEqual([{ type: "text_delta", text: "你好" }]);

    // 思考增量：kind=reasoning_delta。
    expect(
      parseLine(
        JSON.stringify({
          type: "model.streaming",
          payload: { assistantMessageId: "m1", delta: "推理片段", done: false, kind: "reasoning_delta" },
        }),
      ).events,
    ).toEqual([{ type: "thinking", text: "推理片段" }]);

    // 起止哨兵与空 delta：不 emit。
    expect(
      parseLine(
        JSON.stringify({
          type: "model.streaming",
          payload: { assistantMessageId: "m1", delta: "", done: false, kind: "start" },
        }),
      ).events,
    ).toEqual([]);

    // 工具调用：summary 按字段序取 file_path，digest 稳定。
    const scheduled = parseLine(
      JSON.stringify({
        type: "tool_call.scheduled",
        payload: { toolCallId: "call_1", toolName: "Read", input: { file_path: "D:\\proj\\a.ts" } },
      }),
    ).events;
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ type: "tool_call", id: "call_1", name: "Read", summary: "D:\\proj\\a.ts" });
    expect((scheduled[0] as { inputDigest: string }).inputDigest).toHaveLength(12);

    // 工具结果：committed → ok=true、摘录为空串（zcode 不内联正文）；closed → 静默。
    const committed = parseLine(
      JSON.stringify({
        type: "streaming_tool_ledger.updated",
        payload: { toolCallId: "call_1", toolName: "Read", status: "tool_result_committed", input: {} },
      }),
    ).events;
    expect(committed).toEqual([{ type: "tool_result", id: "call_1", ok: true, outputExcerpt: "" }]);
    expect(
      parseLine(
        JSON.stringify({
          type: "streaming_tool_ledger.updated",
          payload: { toolCallId: "call_1", toolName: "Read", status: "tool_call_closed", input: {} },
        }),
      ).events,
    ).toEqual([]);

    // 用量：model_complete.usage → usage 事件。
    expect(
      parseLine(
        JSON.stringify({
          type: "model.complete",
          payload: { content: "", stopReason: "tool-calls", usage: { inputTokens: 5177, outputTokens: 344 } },
        }),
      ).events,
    ).toEqual([{ type: "usage", tokensIn: 5177, tokensOut: 344 }]);

    // 回合完成：state:finished。
    expect(parseLine(JSON.stringify({ type: "turn.complete", payload: { response: "done" } })).events).toEqual([
      { type: "state", state: "finished" },
    ]);
  });

  it("容错：非 JSON 行 → notice:warn；空白行与未知类型 → 空；非对象 JSON → 空", () => {
    const bad = parseLine("这不是 JSON");
    expect(bad.events).toHaveLength(1);
    expect(bad.events[0]).toMatchObject({ type: "notice", severity: "warn" });

    expect(parseLine("   ").events).toEqual([]);
    expect(parseLine(JSON.stringify({ type: "brand_new.frame", payload: {} })).events).toEqual([]);
    expect(parseLine("[1,2,3]").events).toEqual([]);
  });
});
