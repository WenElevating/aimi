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

  it("result：success 但 is_error → 错误原因按模型输出的位置产出 text_delta + state failed（不许伪装成正常完成）", () => {
    // 实测形态（CLI 把鉴权/配额失败包成 synthetic 回复）：subtype 仍是 success，
    // 原因在 `result` 文本里；忽略 is_error 会让手机零输出且无任何解释。
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Failed to authenticate. API Error: 403 当前令牌无权访问所选分组",
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
    });
    expect(normalizeLine(line)).toEqual([
      { type: "text_delta", text: "Failed to authenticate. API Error: 403 当前令牌无权访问所选分组", error: true },
      { type: "usage", tokensIn: 0, tokensOut: 0, cost: 0 },
      { type: "state", state: "failed" },
    ]);
  });

  it("result：success 且 is_error 但无 result 文本 → 兜底原因，仍落 failed", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", is_error: true });
    const events = normalizeLine(line);
    expect(events[0]).toEqual({
      type: "text_delta",
      text: "agent 返回错误（未携带原因）",
      error: true,
    });
    expect(events[events.length - 1]).toEqual({ type: "state", state: "failed" });
  });

  it("Task 7.1：打断判据 error_during_execution → notice warn「执行被打断」+ state stopped（SPIKE FACT2）", () => {
    // 打断专属 subtype（is_error 但进程不退）：手机语义=已打断而非失败，状态落 stopped。
    const line = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "interrupted by user" });
    expect(normalizeLine(line)).toEqual([
      { type: "notice", severity: "warn", text: "执行被打断" },
      { type: "state", state: "stopped" },
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
