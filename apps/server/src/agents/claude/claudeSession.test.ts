import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, SessionSpec } from "@aimi/protocol";
import { ClaudeAdapter } from "./claudeAdapter.js";
import type { ClaudeSession } from "./claudeSession.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/normal-turn.jsonl", import.meta.url));
const DIGEST = createHash("sha256")
  .update(JSON.stringify({ command: "ls -la" }))
  .digest("hex")
  .slice(0, 12);

/** 期望事件序列（SDK 消息即 wire 帧——归一化语义与手搓线协议一致；init 实测模型变化发 configured）。 */
const NORMAL_TURN: AgentEvent[] = [
  { type: "state", state: "running" },
  { type: "configured", model: "claude-x" },
  { type: "thinking", text: "thinking..." },
  { type: "text_delta", text: "hello" },
  { type: "tool_call", id: "tu1", name: "Bash", summary: "ls -la", inputDigest: DIGEST },
  { type: "tool_result", id: "tu1", ok: true, outputExcerpt: "file1file2" },
  { type: "usage", tokensIn: 10, tokensOut: 5, cost: 0.01 },
  { type: "state", state: "finished" },
];

/**
 * 假 CLI 脚本（经 `AIMI_FAKE_CLI_PATH` 注入：SDK 以 `node <path>` 拉起）。
 * 职责：应答 SDK 的 `initialize` 控制请求；stdin 每行落 `stdin.log`；按 `AIMI_FAKE_MODE` 行动——
 * - `replay`（缺省）：首条 user 消息后按 20ms 间隔回放 `AIMI_FAKE_TURN` 样本，回放完常驻；
 * - `silent`：吞掉输入永不输出（init 看门狗现场）；
 * - `stderr-exit`：写两行 stderr（含 ANSI）后以码 3 退出（异常终止现场）；
 * - `perm`：首条 user 消息后发 `AIMI_FAKE_PERM_COUNT` 个 `can_use_tool` 控制请求（tool_use_id
 *   递增），每个等 control_response 到达再发下一个/开始回放；决定与 set_permission_mode 落盘。
 * 控制请求应答：`set_model` 在 `AIMI_FAKE_CTRL_ERROR` 置位且 model≠sonnet 时回 error（成败映射测试），
 * 其余一律 success（request_id 回显）。
 */
const FAKE_CLI = [
  'import { appendFileSync, readFileSync } from "node:fs";',
  'import { dirname, join } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  "const here = dirname(fileURLToPath(import.meta.url));",
  'appendFileSync(join(process.cwd(), "args.log"), JSON.stringify(process.argv.slice(2)) + "\\n");',
  'const mode = process.env.AIMI_FAKE_MODE ?? "replay";',
  'const lines = readFileSync(join(here, process.env.AIMI_FAKE_TURN ?? "normal-turn.jsonl"), "utf8").split(/\\r?\\n/).filter((l) => l !== "");',
  'const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");',
  'const logStdin = (line) => appendFileSync(join(process.cwd(), "stdin.log"), line + "\\n");',
  "let replayStarted = false;",
  "let permSent = 0;",
  "let permDone = 0;",
  'const permTotal = Number(process.env.AIMI_FAKE_PERM_COUNT ?? "0");',
  "const startReplay = () => {",
  "  if (replayStarted) return;",
  "  replayStarted = true;",
  "  let i = 0;",
  "  const timer = setInterval(() => {",
  "    if (i >= lines.length) { clearInterval(timer); return; }",
  "    send(JSON.parse(lines[i]));",
  "    i += 1;",
  "  }, 20);",
  "};",
  "const nextOrReplay = () => {",
  "  if (permSent < permTotal) {",
  "    permSent += 1;",
  '    send({ type: "control_request", request_id: "perm-req-" + permSent, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf /x" }, tool_use_id: "tu" + (8 + permSent) } });',
  "    return;",
  "  }",
  "  startReplay();",
  "};",
  'process.stdin.setEncoding("utf8");',
  'let buf = "";',
  'process.stdin.on("data", (chunk) => {',
  "  buf += chunk;",
  '  const parts = buf.split("\\n");',
  "  buf = parts.pop();",
  "  for (const part of parts) {",
  '    const line = part.replace(/\\r$/, "");',
  '    if (line === "") continue;',
  "    logStdin(line);",
  "    let frame;",
  "    try { frame = JSON.parse(line); } catch { continue; }",
  '    if (frame.type === "control_request") {',
  "      const req = frame.request ?? {};",
  '      if (req.subtype === "initialize") {',
  '        send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } });',
  '      } else if (req.subtype === "set_model" && process.env.AIMI_FAKE_CTRL_ERROR !== undefined && req.model !== "sonnet") {',
  '        send({ type: "control_response", response: { subtype: "error", request_id: frame.request_id, error: "bad model" } });',
  "      } else {",
  '        if (req.subtype === "set_permission_mode") appendFileSync(join(process.cwd(), "setmode.log"), JSON.stringify(req) + "\\n");',
  '        send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } });',
  "      }",
  "      continue;",
  "    }",
  '    if (frame.type === "control_response") {',
  '      appendFileSync(join(process.cwd(), "decisions.log"), JSON.stringify(frame.response) + "\\n");',
  "      permDone += 1;",
  "      nextOrReplay();",
  "      continue;",
  "    }",
  '    if (frame.type === "user" && frame.parent_tool_use_id == null) {',
  '      if (mode === "silent") continue;',
  '      if (mode === "stderr-exit") {',
  '        process.stderr.write("noise before\\n");',
  '        process.stderr.write("\\x1b[31mFATAL: bad args\\x1b[0m\\n");',
  "        process.exit(3);",
  "      }",
  '      if (mode === "perm") {',
  "        nextOrReplay();",
  "        continue;",
  "      }",
  "      startReplay();",
  "    }",
  "  }",
  "});",
  'process.stdin.on("end", () => process.exit(0));',
  "setInterval(() => {}, 1000);",
].join("\n");

const dirs: string[] = [];

/**
 * 造一个临时目录：写假 CLI 脚本与回放样本（`AIMI_FAKE_CLI_PATH` 注入目标，SDK 以 node 拉起）。
 *
 * @param fixtureName - 回放样本文件名（拷入假 CLI 同目录）
 * @returns 该临时目录的绝对路径；目录登记进清理表由 afterEach 删除
 */ function fakeCliDir(fixtureName = "normal-turn.jsonl"): string {
  const dir = mkdtempSync(join(tmpdir(), "aimi-sdk-fake-"));
  dirs.push(dir);
  writeFileSync(join(dir, "fake-cli.mjs"), FAKE_CLI, "utf8");
  writeFileSync(join(dir, fixtureName), readFileSync(join(FIXTURE, "..", fixtureName), "utf8"));
  return dir;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 轮询等待条件成立（回放/控制往返都是异步的）。
 *
 * @param pred - 判定条件，返回 true 即结束等待
 * @param ms - 最长等待毫秒数
 * @throws 超过 `ms` 仍未成立时抛出 `timeout waiting for condition`
 */
async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await sleep(20);
  }
}

/**
 * 注入假 CLI 并创建一条会话（`AIMI_FAKE_CLI_PATH` 环境缝——SDK 以 `executable:'node'` 拉起脚本）。
 *
 * @param dir - 假 CLI 所在目录（同时作为会话工作目录）
 * @param opts.initialPrompt - 可选首条输入
 * @param opts.model - 可选启动模型，按原始标识传给 SDK
 * @param opts.initTimeoutMs - 可选看门狗上限注入
 * @param opts.onProtocolFailure - 可选协议未确认回调
 * @returns 收集事件的数组与会话句柄
 */
function startSession(
  dir: string,
  opts: { initialPrompt?: string; model?: string; initTimeoutMs?: number; onProtocolFailure?: () => void } = {},
): { events: AgentEvent[]; session: ClaudeSession } {
  vi.stubEnv("AIMI_FAKE_CLI_PATH", join(dir, "fake-cli.mjs"));
  const events: AgentEvent[] = [];
  const spec: SessionSpec = {
    agentId: "claude",
    cwd: dir,
    permissionMode: "default",
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(opts.initialPrompt === undefined ? {} : { initialPrompt: opts.initialPrompt }),
  };
  const session = new ClaudeAdapter({
    ...(opts.initTimeoutMs === undefined ? {} : { initTimeoutMs: opts.initTimeoutMs }),
    ...(opts.onProtocolFailure === undefined ? {} : { onProtocolFailure: opts.onProtocolFailure }),
  }).create(spec, (event) => {
    events.push(event);
  }) as ClaudeSession;
  return { events, session };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  // Windows 下假 CLI 进程收尸有窗口期（cwd 在临时目录内），EPERM 重试直到释放。
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(100);
      }
    }
  }
});

describe("claudeSession（SDK 传输，AIMI_FAKE_CLI_PATH 假 CLI）", () => {
  it("回放 fixture → 事件序列与手搓线协议一致；init 捕获线索与实测模型；initialPrompt 落 stdin", async () => {
    const dir = fakeCliDir();
    const { events, session } = startSession(dir, { initialPrompt: "hi there" });
    try {
      await session.start();
      await waitFor(() => events.some((e) => e.type === "state" && e.state === "finished"), 8000);

      // SDK 附带消息（hook/status 等）不产生事件——序列与 NORMAL_TURN 逐字一致。
      expect(events).toEqual(NORMAL_TURN);
      expect(session.getResumeHint()).toBe("cls-abc123");
      expect(session.getResolvedModel()).toBe("claude-x"); // init.model（CLI 实际解析值）

      const stdinLog = readFileSync(join(dir, "stdin.log"), "utf8");
      expect(stdinLog).toContain('"text":"hi there"');

      await session.dispose("test");
      const exit = events.at(-1);
      expect(exit).toMatchObject({ type: "exit", exitCode: null }); // SDK 不暴露退出码
    } finally {
      await session.dispose("cleanup");
    }
  });

  it("输入排队：start 前 send 的消息在 initialPrompt 之后按序落 stdin", async () => {
    const dir = fakeCliDir();
    const { events, session } = startSession(dir, { initialPrompt: "hi there" });
    try {
      await session.send({ cmd: "send", text: "queued before start" }); // 未 start：必须排队
      await session.start();
      await waitFor(() => events.some((e) => e.type === "state" && e.state === "finished"), 8000);
      const stdinLog = readFileSync(join(dir, "stdin.log"), "utf8");
      const promptAt = stdinLog.indexOf('"text":"hi there"');
      const queuedAt = stdinLog.indexOf('"text":"queued before start"');
      expect(promptAt).toBeGreaterThanOrEqual(0);
      expect(queuedAt).toBeGreaterThan(promptAt);
    } finally {
      await session.dispose("test");
    }
  });

  it("runtime() 快照：init 后仅 resumeHint（SDK 不暴露 pid）；dispose 后线索保留", async () => {
    const dir = fakeCliDir();
    const { session } = startSession(dir, { initialPrompt: "hi" }); // 懒 init：需首条输入才回 init
    expect(session.runtime()).toBe(null); // 未启动：线索未知（"未知"≠空快照）
    expect(session.isAlive()).toBe(true); // 未 start 但句柄在：可交付（send 排队）
    try {
      await session.start();
      await waitFor(() => session.getResumeHint() === "cls-abc123", 8000);
      expect(session.runtime()).toEqual({ resumeHint: "cls-abc123" });
      expect(session.isAlive()).toBe(true);
      await session.dispose("test");
      expect(session.runtime()).toEqual({ resumeHint: "cls-abc123" }); // 收尸不带走已捕获的续接线索
      expect(session.isAlive()).toBe(false);
    } finally {
      await session.dispose("cleanup");
    }
  });

  it("init 看门狗：协议未确认 → notice + failed + 标灰回调恰好一次，dispose 自收尾且句柄作废", async () => {
    const dir = fakeCliDir();
    vi.stubEnv("AIMI_FAKE_MODE", "silent");
    const grayCalls: number[] = [];
    const { events, session } = startSession(dir, {
      initialPrompt: "first input",
      initTimeoutMs: 250,
      onProtocolFailure: () => {
        grayCalls.push(1);
      },
    });
    try {
      await session.start();
      await waitFor(() => events.some((e) => e.type === "state" && e.state === "failed"), 5000);
      expect(grayCalls).toEqual([1]);
      expect(events.some((e) => e.type === "notice" && e.text === "适配器协议未确认")).toBe(true);
      await waitFor(() => !session.isAlive(), 5000); // dispose 自收尾
      await expect(session.start()).rejects.toThrow(/disposed/); // 句柄作废
    } finally {
      await session.dispose("cleanup");
    }
  }, 10_000);

  it("空会话不启动 init 看门狗；首条消息交付后才开始计时", async () => {
    const dir = fakeCliDir();
    vi.stubEnv("AIMI_FAKE_MODE", "silent");
    const grayCalls: number[] = [];
    const { events, session } = startSession(dir, {
      initTimeoutMs: 150,
      onProtocolFailure: () => {
        grayCalls.push(1);
      },
    });
    try {
      await session.start();
      await sleep(350);
      expect(events.some((e) => e.type === "state" && e.state === "failed")).toBe(false);
      expect(grayCalls).toEqual([]);

      await session.send({ cmd: "send", text: "first input" });
      await waitFor(() => events.some((e) => e.type === "state" && e.state === "failed"), 5000);
      expect(grayCalls).toEqual([1]);
    } finally {
      await session.dispose("test");
    }
  }, 10_000);

  it("configure 经 SDK 控制请求：set_model/set_permission_mode 落 stdin（default→manual），成败映射 notice", async () => {
    const dir = fakeCliDir();
    vi.stubEnv("AIMI_FAKE_CTRL_ERROR", "1");
    const { events, session } = startSession(dir, { initialPrompt: "go" });
    try {
      await session.start();
      await waitFor(() => session.getResumeHint() === "cls-abc123", 8000);

      await expect(session.send({ cmd: "configure", model: "opus" })).rejects.toThrow("bad model");
      await waitFor(() => events.some((e) => e.type === "notice" && e.text.includes("模型切换（opus）")), 5000);
      await session.send({ cmd: "configure", model: "sonnet" }); // 成功分支
      await waitFor(() => events.some((e) => e.type === "notice" && e.text.includes("模型切换（sonnet）已生效")), 5000);
      await session.send({ cmd: "configure", permissionMode: "default" });
      await waitFor(() => existsSync(join(dir, "setmode.log")), 5000);

      const notices = events.filter((e) => e.type === "notice" && e.text.startsWith("模型切换"));
      expect(notices).toEqual([
        { type: "notice", severity: "error", text: "模型切换（opus）失败：bad model" },
        { type: "notice", severity: "info", text: "模型切换（sonnet）已生效" },
      ]);
      const setmode = JSON.parse(readFileSync(join(dir, "setmode.log"), "utf8").split("\n")[0]!);
      expect(setmode.mode).toBe("manual"); // default 显式 manual（与历史 buildArgs 同语义）
      const stdinLog = readFileSync(join(dir, "stdin.log"), "utf8");
      expect(stdinLog).toContain('"subtype":"set_model","model":"opus"');
      expect(stdinLog).toContain('"subtype":"set_model","model":"sonnet"');

      // 组合命令保留旧兼容语义：模型失败仍继续处理权限，不向调用者抛错。
      await expect(
        session.send({ cmd: "configure", model: "opus", permissionMode: "default" }),
      ).resolves.toBeUndefined();
      expect(events.filter((e) => e.type === "notice" && e.text === "模型切换（opus）失败：bad model")).toHaveLength(2);
      expect(readFileSync(join(dir, "setmode.log"), "utf8").trim().split("\n")).toHaveLength(2);
    } finally {
      await session.dispose("cleanup");
    }
  });

  /** 自定义标识在 SDK 的启动参数和会话内控制请求中均须原样传递。 */
  it("自定义模型经 SDK 原样传递到启动参数和会话内 set_model", async () => {
    const dir = fakeCliDir();
    const { events, session } = startSession(dir, { initialPrompt: "go", model: "vendor/start-model-v1" });
    try {
      await session.start();
      await waitFor(() => session.getResumeHint() === "cls-abc123", 8000);
      await session.send({ cmd: "configure", model: "vendor/next-model-v2" });

      const args: string[] = JSON.parse(readFileSync(join(dir, "args.log"), "utf8").trim());
      expect(args).toContain("--model=vendor/start-model-v1");
      expect(readFileSync(join(dir, "stdin.log"), "utf8")).toContain(
        '"subtype":"set_model","model":"vendor/next-model-v2"',
      );
      expect(events).toContainEqual({
        type: "notice",
        severity: "info",
        text: "模型切换（vendor/next-model-v2）已生效",
      });
    } finally {
      await session.dispose("cleanup");
    }
  });

  it("审批环 once：can_use_tool → permission 卡 + waiting → approve once → allow 落 CLI + running", async () => {
    const dir = fakeCliDir();
    vi.stubEnv("AIMI_FAKE_MODE", "perm");
    vi.stubEnv("AIMI_FAKE_PERM_COUNT", "1");
    const { events, session } = startSession(dir, { initialPrompt: "go" });
    try {
      await session.start();
      await waitFor(() => events.some((e) => e.type === "permission"), 8000);
      const card = events.find((e) => e.type === "permission") as Extract<AgentEvent, { type: "permission" }>;
      expect(card).toMatchObject({ id: "tu9", title: "Bash" });
      expect(JSON.parse(card.detail)).toEqual({ command: "rm -rf /x" }); // detail = input JSON（与旧闸一致）
      expect(events.some((e) => e.type === "state" && e.state === "waiting_approval")).toBe(true);

      await session.send({ cmd: "approve", requestId: "tu9", decision: "once" });
      await waitFor(() => events.some((e) => e.type === "state" && e.state === "running"), 5000);
      await waitFor(() => existsSync(join(dir, "decisions.log")), 5000);
      const decision = JSON.parse(readFileSync(join(dir, "decisions.log"), "utf8").split("\n")[0]!);
      expect(decision.response.behavior).toBe("allow");

      // 晚到二次 approve：失效 notice，不代答。
      await session.send({ cmd: "approve", requestId: "tu9", decision: "once" });
      await waitFor(() => events.some((e) => e.type === "notice" && e.text.includes("审批已失效")), 5000);
      await waitFor(() => events.some((e) => e.type === "state" && e.state === "finished"), 8000);
    } finally {
      await session.dispose("cleanup");
    }
  });

  it("审批环 always：首个请求出卡；同工具第二请求自动放行（无第二张卡）+ 可见性 notice", async () => {
    const dir = fakeCliDir();
    vi.stubEnv("AIMI_FAKE_MODE", "perm");
    vi.stubEnv("AIMI_FAKE_PERM_COUNT", "2");
    const { events, session } = startSession(dir, { initialPrompt: "go" });
    try {
      await session.start();
      await waitFor(() => events.some((e) => e.type === "permission"), 8000);
      await session.send({ cmd: "approve", requestId: "tu9", decision: "always" });
      // 第二个同工具请求：自动放行 notice，不出现第二张 permission 卡。
      await waitFor(() => events.some((e) => e.type === "notice" && e.text.includes("自动放行 Bash")), 8000);
      await waitFor(() => events.filter((e) => e.type === "permission").length === 1, 8000);
      const decisions = readFileSync(join(dir, "decisions.log"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(decisions).toHaveLength(2);
      expect(decisions.every((d) => d.response.behavior === "allow")).toBe(true);
      await waitFor(() => events.some((e) => e.type === "state" && e.state === "finished"), 8000);
    } finally {
      await session.dispose("cleanup");
    }
  });

  it("审批环 reject：deny 携带固定文案（软拒）+ running", async () => {
    const dir = fakeCliDir();
    vi.stubEnv("AIMI_FAKE_MODE", "perm");
    vi.stubEnv("AIMI_FAKE_PERM_COUNT", "1");
    const { events, session } = startSession(dir, { initialPrompt: "go" });
    try {
      await session.start();
      await waitFor(() => events.some((e) => e.type === "permission"), 8000);
      await session.send({ cmd: "approve", requestId: "tu9", decision: "reject" });
      await waitFor(() => existsSync(join(dir, "decisions.log")), 5000);
      const decision = JSON.parse(readFileSync(join(dir, "decisions.log"), "utf8").split("\n")[0]!);
      expect(decision.response).toMatchObject({ behavior: "deny", message: "手机端拒绝" });
      await waitFor(() => events.some((e) => e.type === "state" && e.state === "running"), 5000);
    } finally {
      await session.dispose("cleanup");
    }
  });

  it("异常终止：SDK 流错误 → exit(null) 且 stderrTail 带崩溃原因（ANSI 已剥离）", async () => {
    const dir = fakeCliDir();
    vi.stubEnv("AIMI_FAKE_MODE", "stderr-exit");
    const { events, session } = startSession(dir, { initialPrompt: "go" });
    try {
      await session.start();
      await waitFor(() => events.some((e) => e.type === "exit"), 8000);
      const exit = events.find((e) => e.type === "exit") as { exitCode: number | null; stderrTail?: string };
      expect(exit.exitCode).toBe(null);
      expect(exit.stderrTail).toContain("FATAL: bad args");
      expect(exit.stderrTail).not.toContain("[31m");
    } finally {
      await session.dispose("cleanup");
    }
  });
});

/** 跨平台用例：不起子进程（占位指令、生命周期旗标）。 */
describe("claudeSession 占位与生命周期（跨平台）", () => {
  it("未启动的会话 configure/approve/answer → warn/失效/占位 notice（不起子进程）", async () => {
    const events: AgentEvent[] = [];
    const spec: SessionSpec = { agentId: "claude", cwd: process.cwd(), permissionMode: "plan" };
    const session = new ClaudeAdapter().create(spec, (event) => {
      events.push(event);
    }) as ClaudeSession;
    await session.send({ cmd: "configure", model: "opus" });
    await session.send({ cmd: "approve", requestId: "r1", decision: "once" });
    await session.send({ cmd: "answer", questionId: "q1", value: "yes" });
    await session.send({ cmd: "send", text: "look", files: [{ name: "a.png", b64: "AA" }] });
    expect(events).toEqual([
      { type: "notice", severity: "warn", text: "会话未运行，配置将在下次启动时生效" },
      { type: "notice", severity: "warn", text: "审批已失效（请求不存在或已答复）" },
      { type: "notice", severity: "info", text: "审批/提问交互 M1 接入" },
      { type: "notice", severity: "warn", text: "附件 M1 接入，已忽略 1 个" },
    ]);
    expect(session.isAlive()).toBe(true); // 未 start 但句柄在：可交付（send 排队，与旧口径一致）
  });

  it("生命周期单向：dispose 后 start 抛 /disposed/（防不可杀孤儿）", async () => {
    const spec: SessionSpec = { agentId: "claude", cwd: process.cwd(), permissionMode: "plan" };
    const session = new ClaudeAdapter().create(spec, () => {}) as ClaudeSession;
    await session.dispose("test");
    await expect(session.start()).rejects.toThrow(/disposed/);
  });
});
