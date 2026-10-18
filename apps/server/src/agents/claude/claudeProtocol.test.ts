import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@aimi/protocol";
import { normalizeLine } from "./claudeProtocol.js";

/** 回放样本原文（每行一段 JSON）——回放测试的唯一输入源。 */
const FIXTURE_LINES = readFileSync(
  fileURLToPath(new URL("./__fixtures__/normal-turn.jsonl", import.meta.url)),
  "utf8",
)
  .split(/\r?\n/)
  .filter((line) => line !== "");

/** 摘要算据（手工复算，避免把 bug 抄进期望值）。 */
const DIGEST = createHash("sha256").update(JSON.stringify({ command: "ls -la" })).digest("hex").slice(0, 12);

/** 一次普通回合的完整归一化结果（期望序列）。 */
const NORMAL_TURN: AgentEvent[] = [
  { type: "state", state: "running" },
  { type: "thinking", text: "thinking..." },
  { type: "text_delta", text: "hello" },
  { type: "tool_call", id: "tu1", name: "Bash", summary: "ls -la", inputDigest: DIGEST },
  { type: "tool_result", id: "tu1", ok: true, outputExcerpt: "file1file2" },
  { type: "usage", tokensIn: 10, tokensOut: 5, cost: 0.01 },
  { type: "state", state: "finished" },
];

describe("claudeProtocol 归一化（纯函数回放）", () => {
  it("Step 2.1：fixture 逐行回放得到冻结序列（state/thinking/text/tool_call/tool_result/usage/finished）", () => {
    const events = FIXTURE_LINES.flatMap((line) => normalizeLine(line));
    expect(events).toEqual(NORMAL_TURN);
  });

  it("Step 2.2：非 JSON 行 → notice warn，文本取前 80 字符", () => {
    expect(normalizeLine("oops not json")).toEqual([
      { type: "notice", severity: "warn", text: "non-json line: oops not json" },
    ]);
    const long = "x".repeat(200);
    const [event] = normalizeLine(long);
    expect(event).toMatchObject({ type: "notice", severity: "warn" });
    expect((event as { text: string }).text).toBe("non-json line: " + long.slice(0, 80));
  });

  it("Step 2.3：result 非 success → notice error + state failed", () => {
    const line = JSON.stringify({ type: "result", subtype: "error_max_turns", result: "hit max turns" });
    expect(normalizeLine(line)).toEqual([
      { type: "notice", severity: "error", text: "error_max_turns" },
      { type: "state", state: "failed" },
    ]);
  });

  it("容错：未知 type 的合法 JSON、assistant 文本块、空行均不 emit", () => {
    expect(normalizeLine(JSON.stringify({ type: "future_thing", payload: 1 }))).toEqual([]);
    expect(
      normalizeLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })),
    ).toEqual([]);
    expect(normalizeLine("")).toEqual([]);
    expect(normalizeLine("   ")).toEqual([]);
  });

  it("tool_result：is_error 透传 ok=false；文本块拼接超 8192 截断（exitCode 无来源故省略）", () => {
    const big = "a".repeat(9000);
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu2",
            is_error: true,
            content: [{ type: "text", text: big }, { type: "text", text: "tail" }],
          },
        ],
      },
    });
    const [event] = normalizeLine(line);
    expect(event).toMatchObject({ type: "tool_result", id: "tu2", ok: false });
    expect((event as { outputExcerpt: string }).outputExcerpt.length).toBe(8192);
  });
});
