import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentCommand, AgentEvent, SessionSpec } from "@aimi/protocol";
import { ZcodeSession } from "./zcodeSession.js";

/**
 * 假 zcode CLI（真实子进程，协议形状与线格式一致）：按 `AIMI_ZCODE_MODE` 出三种行为。
 * argv 全量写 `AIMI_ZCODE_ARGS_LOG`（每行一次 spawn，JSON 数组），供 resume/mode 断言。
 */
const FAKE_CLI = `
const fs = require("node:fs");
const argsLog = process.env.AIMI_ZCODE_ARGS_LOG;
if (argsLog) fs.appendFileSync(argsLog, JSON.stringify(process.argv.slice(2)) + "\\n");
const mode = process.env.AIMI_ZCODE_MODE ?? "success";
const sid = process.env.AIMI_ZCODE_SID ?? "sess_fake_1";
const line = (type, payload) => process.stdout.write(
  JSON.stringify({ eventId: "e" + Math.random(), payload, seq: 1, sessionId: sid, timestamp: 1, traceId: "t", turnId: "tn", type }) + "\\n");
if (mode === "hang") { line("turn.started", { turnNumber: 0, input: "x" }); setInterval(() => {}, 1000); return; }
if (mode === "silent") { setInterval(() => {}, 1000); return; }
if (mode === "stderr-exit") { process.stderr.write("boom: bad args\\n"); process.exit(3); }
line("session.titleUpdated", { title: "t" });
line("turn.started", { turnNumber: 0, input: "x" });
line("model.streaming", { assistantMessageId: "m", delta: "第一段", done: false, kind: "text_delta" });
line("model.streaming", { assistantMessageId: "m", delta: "第二段", done: false, kind: "text_delta" });
line("tool_call.scheduled", { toolCallId: "call_9", toolName: "Read", input: { file_path: "D:\\\\p\\\\a.ts" } });
line("streaming_tool_ledger.updated", { toolCallId: "call_9", toolName: "Read", status: "tool_result_committed", input: {} });
line("model.complete", { content: "", stopReason: "end-turn", usage: { inputTokens: 100, outputTokens: 20 } });
line("turn.complete", { response: "done" });
line("session.updated", { messageCount: 1, providerId: "p1", modelId: "glm-5.3", toolCount: 1, iteration: 0 });
process.exit(0);
`;

/** 会话描述（cwd 指向临时目录，mode 缺省走 spec 值）。 */
function specOf(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return { agentId: "zcode", cwd: tmpWorkdir(), permissionMode: "edit", ...overrides };
}

let workdir: string | undefined;
function tmpWorkdir(): string {
  if (workdir === undefined) workdir = mkdtempSync(join(tmpdir(), "zcode-session-"));
  return workdir;
}

/** 泵一个接好事件出口的 ZcodeSession；返回事件数组与 argv 日志路径。 */
function startSession(
  opts: {
    spec?: SessionSpec;
    mode?: string;
    initTimeoutMs?: number;
    resume?: { hint: string };
    onProtocolFailure?: () => void;
  } = {},
): { session: ZcodeSession; events: AgentEvent[]; argsLog: string } {
  const events: AgentEvent[] = [];
  const argsLog = join(tmpWorkdir(), "args-" + Math.random().toString(36).slice(2) + ".log");
  const cliPath = join(tmpWorkdir(), "fake-zcode-" + Math.random().toString(36).slice(2) + ".cjs");
  writeFileSync(cliPath, FAKE_CLI);
  vi.stubEnv("AIMI_ZCODE_MODE", opts.mode ?? "success");
  vi.stubEnv("AIMI_ZCODE_ARGS_LOG", argsLog);
  vi.stubEnv("AIMI_ZCODE_SID", "sess_fake_1");
  const session = new ZcodeSession(
    opts.spec ?? specOf({ initialPrompt: "第一次任务" }),
    (event) => {
      events.push(event);
    },
    opts.resume,
    {
      cli: { file: process.execPath, args: [cliPath] },
      initTimeoutMs: opts.initTimeoutMs,
      onProtocolFailure: opts.onProtocolFailure,
    },
  );
  return { session, events, argsLog };
}

/** 等待事件数组中出现满足谓词的条目（子进程异步流，轮询至上限）。 */
async function waitFor(events: AgentEvent[], pred: (e: AgentEvent) => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!events.some(pred)) {
    if (Date.now() > deadline) throw new Error("等待事件超时: " + JSON.stringify(events.map((e) => e.type)));
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterAll(() => {
  if (workdir !== undefined) rmSync(workdir, { recursive: true, force: true });
});

describe("ZcodeSession", () => {
  vi.setConfig({ testTimeout: 20_000 });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("首回合：spawn 全参数、事件按序归一化、configured 上报实测模型", async () => {
    const { session, events, argsLog } = startSession();
    await session.start();
    await waitFor(events, (e) => e.type === "state" && e.state === "finished");

    // 事件序：running → 两条 text_delta → tool_call → tool_result → usage → finished。
    const types = events.map((e) => e.type);
    expect(types.indexOf("state")).toBeGreaterThanOrEqual(0);
    const states = events.filter((e) => e.type === "state").map((e) => (e as { state: string }).state);
    expect(states).toEqual(["running", "finished"]);
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text)).toEqual([
      "第一段",
      "第二段",
    ]);
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({
      type: "tool_call",
      id: "call_9",
      name: "Read",
      summary: "D:\\p\\a.ts",
    });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ type: "tool_result", id: "call_9", ok: true });
    expect(events.find((e) => e.type === "usage")).toMatchObject({ type: "usage", tokensIn: 100, tokensOut: 20 });
    expect(events.find((e) => e.type === "configured")).toMatchObject({ type: "configured", model: "glm-5.3" });

    // spawn 参数逐字核对（fake 把 argv 落盘）。
    const argvLines = readFileSync(argsLog, "utf8").trim().split(/\r?\n/);
    const argv = JSON.parse(argvLines[0]!);
    expect(argv).toContain("--prompt");
    expect(argv).toContain("第一次任务");
    expect(argv.indexOf("--cwd") + 1).toBe(argv.indexOf(tmpWorkdir()));
    expect(argv.indexOf("--mode") + 1).toBe(argv.indexOf("edit"));
    expect(argv).toContain("--output-format");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--no-color");
    expect(argv).not.toContain("--resume"); // 首回合无线索

    // runtime：hint 捕获自事件行 sessionId。
    expect(session.runtime()?.resumeHint).toBe("sess_fake_1");
    expect(session.isAlive()).toBe(true);
    await session.dispose();
  });

  it("续接：第二回合 spawn 带 --resume；configure 权限档随下回合生效；模型切换被拒", async () => {
    const { session, events, argsLog } = startSession();
    await session.start();
    await waitFor(events, (e) => e.type === "state" && e.state === "finished");

    // 模型切换：抛错（编排层不保存）。
    await expect(session.send({ cmd: "configure", model: "another-model" } as AgentCommand)).rejects.toThrow(
      /跟随全局配置/,
    );

    // 权限档切换：接受，下一回合 argv 生效。
    await session.send({ cmd: "configure", permissionMode: "yolo" } as never);
    await session.send({ cmd: "send", text: "第二次任务" } as never);
    // 第二回合完成 = state 事件数达 4（running/finished/running/finished）。
    await waitFor(events, () => events.filter((x) => x.type === "state").length >= 4);

    const argvs = readFileSync(argsLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((l) => JSON.parse(l) as string[]);
    expect(argvs).toHaveLength(2);
    expect(argvs[1]!).toContain("--resume");
    expect(argvs[1]![argvs[1]!.indexOf("--resume") + 1]).toBe("sess_fake_1");
    expect(argvs[1]!.indexOf("--mode") + 1).toBe(argvs[1]!.indexOf("yolo"));
    await session.dispose();
  });

  it("中断：running 中 interrupt → notice + stopped，进程被杀；不误报 failed", async () => {
    const { session, events } = startSession({ mode: "hang", initTimeoutMs: 60_000 });
    await session.start();
    await waitFor(events, (e) => e.type === "state" && e.state === "running");
    await session.send({ cmd: "interrupt" } as never);

    await waitFor(events, (e) => e.type === "state" && e.state === "stopped");
    // 不应有 failed（stopped 已是终态，exit 收口不再叠加）。
    expect(events.some((e) => e.type === "state" && e.state === "failed")).toBe(false);
    // 进程被树杀：runtime pid 归 undefined。
    const deadline = Date.now() + 3000;
    while (session.runtime()?.pid !== undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(session.runtime()?.pid).toBeUndefined();
    await session.dispose();
  });

  it("异常终止：stderr-exit → notice:error（带 stderr 尾段）+ failed + exit 事件", async () => {
    const { session, events } = startSession({ mode: "stderr-exit", initTimeoutMs: 60_000 });
    await session.start();
    await waitFor(events, (e) => e.type === "exit");
    const failed = events.find((e) => e.type === "state" && e.state === "failed");
    expect(failed).toBeDefined();
    const exit = events.find((e) => e.type === "exit") as { exitCode: number | null; stderrTail?: string };
    expect(exit.exitCode).toBe(3);
    expect(exit.stderrTail).toContain("boom: bad args");
    expect(events.some((e) => e.type === "notice" && e.severity === "error")).toBe(true);
    // 句柄作废：isAlive false。
    expect(session.isAlive()).toBe(false);
  });

  it("看门狗：hang 模式 30s 无事件（注入 50ms）→ notice + failed + 树杀 + onProtocolFailure", async () => {
    let protocolFailed = false;
    const { session, events } = startSession({
      mode: "silent",
      initTimeoutMs: 50,
      onProtocolFailure: () => {
        protocolFailed = true;
      },
    });
    await session.start();
    await waitFor(events, (e) => e.type === "state" && e.state === "failed");
    expect(protocolFailed).toBe(true);
    expect(events.some((e) => e.type === "notice" && e.severity === "error")).toBe(true);
    expect(session.isAlive()).toBe(false);
    await session.dispose();
  });
});
