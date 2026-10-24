import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, SessionSpec } from "@aimi/protocol";
import { ClaudeAdapter } from "./claudeAdapter.js";
import { buildArgs, killTree, type ClaudeSession } from "./claudeSession.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/normal-turn.jsonl", import.meta.url));
const DIGEST = createHash("sha256").update(JSON.stringify({ command: "ls -la" })).digest("hex").slice(0, 12);

/** 期望事件序列（协议面不变，只是被套上了子进程）。 */
const NORMAL_TURN: AgentEvent[] = [
  { type: "state", state: "running" },
  { type: "thinking", text: "thinking..." },
  { type: "text_delta", text: "hello" },
  { type: "tool_call", id: "tu1", name: "Bash", summary: "ls -la", inputDigest: DIGEST },
  { type: "tool_result", id: "tu1", ok: true, outputExcerpt: "file1file2" },
  { type: "usage", tokensIn: 10, tokensOut: 5, cost: 0.01 },
  { type: "state", state: "finished" },
];

/**
 * 假 claude 脚本（前半共用）：读同目录 `normal-turn.jsonl` 按 30ms 间隔回放，
 * 并把 stdin 收到的每一行追加到 `cwd/stdin.log`；回放完**不退出**（保持流开放等打断）。
 */
const SCRIPT_HEAD = [
  'import { appendFileSync, readFileSync } from "node:fs";',
  'import { dirname, join } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  "",
  "const here = dirname(fileURLToPath(import.meta.url));",
  'const lines = readFileSync(join(here, "normal-turn.jsonl"), "utf8").split(/\\r?\\n/).filter((l) => l !== "");',
  "process.stdin.setEncoding(\"utf8\");",
  "let buf = \"\";",
  "process.stdin.on(\"data\", (chunk) => {",
  "  buf += chunk;",
  '  const parts = buf.split("\\n");',
  "  buf = parts.pop();",
  "  for (const part of parts) {",
  '    const line = part.replace(/\\r$/, "");',
  '    if (line !== "") appendFileSync(join(process.cwd(), "stdin.log"), line + "\\n");',
  "  }",
  "});",
].join("\n");

/** 变体 A：逐行换行（LF）回放。 */
const SCRIPT_REPLAY = [
  SCRIPT_HEAD,
  "let i = 0;",
  "const timer = setInterval(() => {",
  "  if (i >= lines.length) { clearInterval(timer); return; }",
  '  process.stdout.write(lines[i] + "\\n");',
  "  i += 1;",
  "}, 30);",
].join("\n");

/** 变体 B：每行拆两半分块写、以 CRLF 收尾（考行缓冲与 `\r` 剥离）。 */
const SCRIPT_SPLIT_CRLF = [
  SCRIPT_HEAD,
  "let i = 0;",
  "const timer = setInterval(() => {",
  "  if (i >= lines.length) { clearInterval(timer); return; }",
  "  const line = lines[i];",
  "  i += 1;",
  "  const mid = Math.ceil(line.length / 2);",
  "  process.stdout.write(line.slice(0, mid));",
  '  setTimeout(() => { process.stdout.write(line.slice(mid) + "\\r\\n"); }, 10);',
  "}, 30);",
].join("\n");

/**
 * 变体 C：全程静默不回 `system/init` 且常驻——init 看门狗用例的"协议未确认"现场。
 * 消费 stdin 但不产任何输出：spawn 成功后不吐 init，看门狗到期即按协议失效处置。
 */
const SCRIPT_SILENT = [
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", () => {});',
  'process.stdin.on("end", () => process.exit(0));',
  "setInterval(() => {}, 1000);",
].join("\n");

/** 变体 D：只回一行 init 随后静默常驻——审批闸环路用例的纯净现场（协议事件零噪声，事件全来自 relay）。 */
const SCRIPT_INIT_SILENT = [
  'process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "cls-silent" }) + "\\n");',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", () => {});',
  'process.stdin.on("end", () => process.exit(0));',
  "setInterval(() => {}, 1000);",
].join("\n");

/** 变体 E：spawn 参数落 args.log 后按 30ms 回放基线样本（垫片转发 `%*`——闸参数断言的数据源）。 */
const SCRIPT_ARGS = [
  SCRIPT_HEAD,
  'appendFileSync(join(process.cwd(), "args.log"), process.argv.slice(2).join(" ") + "\\n");',
  "let i = 0;",
  "const timer = setInterval(() => {",
  "  if (i >= lines.length) { clearInterval(timer); return; }",
  '  process.stdout.write(lines[i] + "\\n");',
  "  i += 1;",
  "}, 30);",
].join("\n");

/**
 * 变体 F：控制请求回声（模拟真 CLI 的 control_response 行为）——init 后常驻，收到
 * `control_request` 即回应答：`set_model` 非 `sonnet` 拒绝（error + 原因），其余成功；
 * 每个请求**应答写两遍**，考重复应答的去重（真 CLI 实测会对同一应答多次重发）。
 */
const SCRIPT_CTRL_ECHO = [
  'import { appendFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "cls-ctrl" }) + "\\n");',
  'process.stdin.setEncoding("utf8");',
  'let buf = "";',
  'process.stdin.on("data", (chunk) => {',
  "  buf += chunk;",
  '  const parts = buf.split("\\n");',
  "  buf = parts.pop();",
  "  for (const part of parts) {",
  '    const line = part.replace(/\\r$/, "");',
  '    if (line === "") continue;',
  '    appendFileSync(join(process.cwd(), "stdin.log"), line + "\\n");',
  "    try {",
  "      const frame = JSON.parse(line);",
  '      if (frame.type === "control_request") {',
  '        const ok = frame.request.subtype !== "set_model" || frame.request.model === "sonnet";',
  '        const response = { subtype: ok ? "success" : "error", request_id: frame.request_id };',
  '        if (!ok) response.error = "bad model";',
  '        const out = JSON.stringify({ type: "control_response", response }) + "\\n";',
  "        process.stdout.write(out);",
  "        process.stdout.write(out);",
  "      }",
  "    } catch {}",
  "  }",
  "});",
  "setInterval(() => {}, 1000);",
].join("\n");

/** 变体 G：写两行 stderr（含 ANSI 彩色）后以码 3 退出——stderr 末段摘录的异常退出现场。 */
const SCRIPT_STDERR_FAIL = [
  'process.stderr.write("some verbose noise\\n");',
  'process.stderr.write("\\x1b[31mFATAL: bad args\\x1b[0m\\n");',
  "process.exit(3);",
].join("\n");

/** 变体 H：写 stderr 后以码 0 退出——正常退出不得携带 stderrTail 的对照现场。 */
const SCRIPT_STDERR_CLEAN = [
  'process.stderr.write("benign noise\\n");',
  "process.exit(0);",
].join("\n");

const dirs: string[] = [];

/**
 * 造一个临时目录：拷入回放样本、写假 claude 脚本与 `claude.cmd` 垫片（PATH 解析目标）。
 *
 * @param script - 假 claude 脚本内容
 * @returns 该临时目录的绝对路径；目录登记进清理表由 afterEach 删除
 */
function fakeClaudeDir(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aimi-claude-"));
  dirs.push(dir);
  writeFileSync(join(dir, "normal-turn.jsonl"), readFileSync(FIXTURE, "utf8"));
  writeFileSync(join(dir, "fake-claude.mjs"), script, "utf8");
  // 生产同构：Windows 下 `claude` 经 `shell:true` 由 cmd.exe 按 PATH+PATHEXT 解析到 `.cmd` 垫片。
  writeFileSync(join(dir, "claude.cmd"), '@echo off\r\n"' + process.execPath + '" "%~dp0fake-claude.mjs"\r\n');
  return dir;
}

/** 带 args.log 的变体：垫片转发 `%*`（完整 spawn 参数到达假 CLI 才可断言闸参数）。 */
function fakeClaudeDirArgs(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aimi-claude-"));
  dirs.push(dir);
  writeFileSync(join(dir, "normal-turn.jsonl"), readFileSync(FIXTURE, "utf8"));
  writeFileSync(join(dir, "fake-claude.mjs"), script, "utf8");
  writeFileSync(join(dir, "claude.cmd"), '@echo off\r\n"' + process.execPath + '" "%~dp0fake-claude.mjs" %*\r\n');
  return dir;
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * 轮询等待条件成立（回放有 30ms/行的节拍，事件是异步到达的）。
 *
 * @param pred - 判定条件，返回 true 即结束等待
 * @param ms - 最长等待毫秒数
 * @returns Promise，resolve 表示条件已成立
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
 * 用 PATH 注入假 CLI，创建一条尚未启动的会话。
 *
 * @param dir - 假 CLI 所在目录（同时作为会话工作目录）
 * @param initialPrompt - 可选首条输入
 * @returns 收集事件的数组与会话句柄
 */
function startSession(dir: string, initialPrompt?: string): { events: AgentEvent[]; session: ClaudeSession } {
  vi.stubEnv("PATH", dir + ";" + process.env.PATH);
  const events: AgentEvent[] = [];
  const spec: SessionSpec = { agentId: "claude", cwd: dir, permissionMode: "default", initialPrompt };
  const session = new ClaudeAdapter().create(spec, (event) => { events.push(event); }) as ClaudeSession;
  return { events, session };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 平台卫语句：假 CLI 走 `.cmd` 垫片 + PATH 分号语义（server 仅在 Windows 上运行；
 * CI 也在 windows-latest 上跑），非 Windows 上整块跳过——纯 Windows 断言保持原样。
 */
describe.skipIf(process.platform !== "win32")("claudeSession 集成（PATH 内假 CLI，不依赖真 CLI）", () => {
  it("回放 fixture → 事件序列同协议回放；initialPrompt 落 stdin；interrupt 落 stdin；dispose 后进程退出", async () => {
    const dir = fakeClaudeDir(SCRIPT_REPLAY);
    const { events, session } = startSession(dir, "hi there");
    try {
      await session.start();
      await waitFor(() => events.some((e) => e.type === "state" && e.state === "finished"), 5000);

      expect(events).toEqual(NORMAL_TURN);
      expect(session.getResumeHint()).toBe("cls-abc123"); // system/init 捕获的续接线索（不 emit）

      await session.send({ cmd: "interrupt" });
      await sleep(500);
      const stdinLog = readFileSync(join(dir, "stdin.log"), "utf8");
      expect(stdinLog).toContain('"text":"hi there"'); // initialPrompt 在 start 时落 stdin
      expect(stdinLog).toContain('"subtype":"interrupt"');

      await session.dispose("test");
      expect(events.at(-1)).toMatchObject({ type: "exit" });
    } finally {
      await session.dispose("cleanup");
    }
  });

  it("行缓冲：分块写 + CRLF 换行仍归一化为同一序列（每行不因分片被撕裂）", async () => {
    const dir = fakeClaudeDir(SCRIPT_SPLIT_CRLF);
    const { events, session } = startSession(dir);
    try {
      await session.start();
      await waitFor(() => events.some((e) => e.type === "state" && e.state === "finished"), 5000);
      expect(events).toEqual(NORMAL_TURN);
    } finally {
      await session.dispose("test");
    }
  });

  it("stdin 队列：start 前 send 的指令在 start 后落盘（initialPrompt 先于排队指令）", async () => {
    const dir = fakeClaudeDir(SCRIPT_REPLAY);
    vi.stubEnv("PATH", dir + ";" + process.env.PATH);
    const events: AgentEvent[] = [];
    const spec: SessionSpec = {
      agentId: "claude",
      cwd: dir,
      permissionMode: "default",
      initialPrompt: "hi there",
    };
    const session = new ClaudeAdapter().create(spec, (event) => { events.push(event); }) as ClaudeSession;
    try {
      await session.send({ cmd: "send", text: "queued before start" }); // 未 start：必须排队
      await session.start();
      await waitFor(() => events.some((e) => e.type === "state" && e.state === "finished"), 5000);
      const stdinLog = readFileSync(join(dir, "stdin.log"), "utf8");
      const promptAt = stdinLog.indexOf('"text":"hi there"');
      const queuedAt = stdinLog.indexOf('"text":"queued before start"');
      expect(promptAt).toBeGreaterThanOrEqual(0);
      expect(queuedAt).toBeGreaterThan(promptAt);
    } finally {
      await session.dispose("test");
    }
  });

  it("runtime() 快照：init 后 pid+hint；dispose 后 hint 保留 pid 消失；未拉起为 null", async () => {
    const dir = fakeClaudeDir(SCRIPT_REPLAY);
    const { session } = startSession(dir);
    expect(session.runtime()).toBe(null); // 未 spawn：pid/hint 皆未知（"未知"≠空快照）
    try {
      await session.start();
      expect(session.runtime()!.pid).toBeTypeOf("number"); // spawn 后才知道（拉取式采集依据）
      await waitFor(() => session.getResumeHint() === "cls-abc123", 5000);
      expect(session.runtime()).toEqual({ pid: expect.any(Number), resumeHint: "cls-abc123" });

      await session.dispose("test");
      expect(session.runtime()).toEqual({ resumeHint: "cls-abc123" }); // 收尸不带走已捕获的续接线索
    } finally {
      await session.dispose("cleanup");
    }
  });

  it("init 看门狗：协议未确认 → notice + failed + 标灰回调恰好一次，dispose 自收尾且句柄作废", async () => {
    const dir = fakeClaudeDir(SCRIPT_SILENT);
    const grayCalls: number[] = [];
    vi.stubEnv("PATH", dir + ";" + process.env.PATH);
    const events: AgentEvent[] = [];
    const spec: SessionSpec = { agentId: "claude", cwd: dir, permissionMode: "default" };
    const session = new ClaudeAdapter({ initTimeoutMs: 250, onProtocolFailure: () => { grayCalls.push(1); } })
      .create(spec, (event) => { events.push(event); }) as ClaudeSession;
    try {
      await session.start();
      await session.send({ cmd: "send", text: "first input" });
      // 到点次序：error notice → state failed（白名单 starting→failed）→ 标灰回调 → dispose 收尾。
      await waitFor(() => events.some((e) => e.type === "state" && e.state === "failed"), 5000);
      const noticeIdx = events.findIndex((e) => e.type === "notice" && e.severity === "error" && e.text === "适配器协议未确认");
      const failedIdx = events.findIndex((e) => e.type === "state" && e.state === "failed");
      expect(noticeIdx).toBeGreaterThanOrEqual(0);
      expect(failedIdx).toBeGreaterThan(noticeIdx);     // 服务端先提示再落失败态
      expect(grayCalls).toEqual([1]);                    // 一次性回调（#exited/#disposed 已收口）

      await waitFor(() => events.some((e) => e.type === "exit"), 5000); // 看门狗主动 dispose 收尸子进程
      expect(session.runtime()).toBe(null);              // sid 从未捕获 + 句柄已作废 → 两者皆未知
      await expect(session.start()).rejects.toThrow(/disposed/);       // 生命周期单向：不复活
    } finally {
      await session.dispose("cleanup");
    }
  }, 15_000);

  it("空会话不启动 init 看门狗；首条 user 消息写入后才开始计时", async () => {
    const dir = fakeClaudeDir(SCRIPT_SILENT);
    const grayCalls: number[] = [];
    vi.stubEnv("PATH", dir + ";" + process.env.PATH);
    const events: AgentEvent[] = [];
    const spec: SessionSpec = { agentId: "claude", cwd: dir, permissionMode: "default" };
    const session = new ClaudeAdapter({ initTimeoutMs: 150, onProtocolFailure: () => { grayCalls.push(1); } })
      .create(spec, (event) => { events.push(event); }) as ClaudeSession;
    try {
      await session.start();
      await sleep(350);
      expect(events.some((event) => event.type === "state" && event.state === "failed")).toBe(false);
      expect(grayCalls).toEqual([]);

      await session.send({ cmd: "send", text: "first input" });
      await waitFor(() => events.some((event) => event.type === "state" && event.state === "failed"), 3000);
      expect(grayCalls).toEqual([1]);
    } finally {
      await session.dispose("test");
    }
  }, 10_000);

  it("configure 落控制请求：set_model/set_permission_mode 写 stdin（default→manual 映射同 buildArgs）", async () => {
    const dir = fakeClaudeDir(SCRIPT_CTRL_ECHO);
    const { events, session } = startSession(dir);
    try {
      await session.start();
      await waitFor(() => session.getResumeHint() === "cls-ctrl", 5000);

      await session.send({ cmd: "configure", model: "opus", permissionMode: "plan" });
      await session.send({ cmd: "configure", permissionMode: "default" });
      await waitFor(() => {
        if (!existsSync(join(dir, "stdin.log"))) return false; // 首写前文件不存在，继续等
        const log = readFileSync(join(dir, "stdin.log"), "utf8");
        return log.includes('"subtype":"set_permission_mode"') && log.split("set_model").length >= 2;
      }, 5000);
      const stdinLog = readFileSync(join(dir, "stdin.log"), "utf8");
      expect(stdinLog).toContain('"subtype":"set_model","model":"opus"');
      expect(stdinLog).toContain('"subtype":"set_permission_mode","mode":"plan"');
      expect(stdinLog).toContain('"subtype":"set_permission_mode","mode":"manual"'); // default 显式 manual
      // 控制请求本身不产生时间线事件（事件只来自 control_response 的成败 notice）
      expect(events.filter((e) => e.type === "state")).toEqual([{ type: "state", state: "running" }]);
    } finally {
      await session.dispose("cleanup");
    }
  });

  it("control_response 成败映射 notice；重复应答去重为单条", async () => {
    const dir = fakeClaudeDir(SCRIPT_CTRL_ECHO);
    const { events, session } = startSession(dir);
    try {
      await session.start();
      await waitFor(() => session.getResumeHint() === "cls-ctrl", 5000);

      await session.send({ cmd: "configure", model: "opus" }); // 回声脚本拒绝非 sonnet
      await waitFor(() => events.some((e) => e.type === "notice" && e.text.includes("模型切换（opus）")), 5000);
      await session.send({ cmd: "configure", model: "sonnet" }); // 成功分支
      await waitFor(() => events.some((e) => e.type === "notice" && e.text.includes("模型切换（sonnet）")), 5000);
      await sleep(200); // 让重复应答到达

      const modelNotices = events.filter((e) => e.type === "notice" && e.text.startsWith("模型切换"));
      expect(modelNotices).toEqual([
        { type: "notice", severity: "error", text: "模型切换（opus）失败：bad model" },
        { type: "notice", severity: "info", text: "模型切换（sonnet）已生效" },
      ]); // 每个动作恰一条：重复应答（脚本写两遍）被删除式消费去重
    } finally {
      await session.dispose("cleanup");
    }
  });

  it("异常退出随 exit 带 stderr 末段（ANSI 已剥离）；正常退出不带", async () => {
    const failDir = fakeClaudeDir(SCRIPT_STDERR_FAIL);
    const fail = startSession(failDir);
    try {
      await fail.session.start();
      await waitFor(() => fail.events.some((e) => e.type === "exit"), 5000);
      const exit = fail.events.find((e) => e.type === "exit") as { exitCode: number; stderrTail?: string };
      expect(exit.exitCode).toBe(3);
      expect(exit.stderrTail).toContain("FATAL: bad args");
      expect(exit.stderrTail).not.toContain("[31m");
    } finally {
      await fail.session.dispose("cleanup");
    }

    const cleanDir = fakeClaudeDir(SCRIPT_STDERR_CLEAN);
    const clean = startSession(cleanDir);
    try {
      await clean.session.start();
      await waitFor(() => clean.events.some((e) => e.type === "exit"), 5000);
      const exit = clean.events.find((e) => e.type === "exit") as { exitCode: number; stderrTail?: string };
      expect(exit.exitCode).toBe(0);
      expect(exit.stderrTail).toBeUndefined();
    } finally {
      await clean.session.dispose("cleanup");
    }
  });
});

/** 跨平台用例：不依赖 `.cmd`/PATH 语义（占位指令、生命周期旗标、树杀容错）。 */
describe("claudeSession 生命周期与容错（跨平台）", () => {
  it("未启动的会话 configure → warn notice（不起子进程，配置留待下次启动生效）", async () => {
    const events: AgentEvent[] = [];
    const spec: SessionSpec = { agentId: "claude", cwd: process.cwd(), permissionMode: "plan" };
    const session = new ClaudeAdapter().create(spec, (event) => { events.push(event); }) as ClaudeSession;
    await session.send({ cmd: "configure", model: "opus" });
    expect(events).toEqual([
      { type: "notice", severity: "warn", text: "会话未运行，配置将在下次启动时生效" },
    ]);
  });

  it("buildArgs 映射模型与四档权限", () => {
    expect(buildArgs({ agentId: "claude", cwd: ".", model: "opus", permissionMode: "acceptEdits" }, undefined, undefined))
      .toContain("--model");
    expect(buildArgs({ agentId: "claude", cwd: ".", model: "opus", permissionMode: "acceptEdits" }, undefined, undefined))
      .toContain("acceptEdits");
    expect(buildArgs({ agentId: "claude", cwd: ".", permissionMode: "bypassPermissions" }, undefined, undefined))
      .toContain("bypassPermissions");
  });
  it("无闸上下文：approve → 失效 warn（无 relay 即账本空）；answer 维持占位 notice；附件告警（不起子进程）", async () => {
    const events: AgentEvent[] = [];
    const spec: SessionSpec = { agentId: "claude", cwd: process.cwd(), permissionMode: "plan" };
    const session = new ClaudeAdapter().create(spec, (event) => { events.push(event); }) as ClaudeSession;
    try {
      await session.send({ cmd: "approve", requestId: "r1", decision: "once" });
      await session.send({ cmd: "answer", questionId: "q1", value: "yes" });
      await session.send({ cmd: "send", text: "look", files: [{ name: "a.png", b64: "AA" }] });
      expect(events).toEqual([
        { type: "notice", severity: "warn", text: "审批已失效（请求不存在或已答复）" },
        { type: "notice", severity: "info", text: "审批/提问交互 M1 接入" },
        { type: "notice", severity: "warn", text: "附件 M1 接入，已忽略 1 个" },
      ]);
      expect(session.getResumeHint()).toBeUndefined();
    } finally {
      await session.dispose("test");
    }
  });  it("生命周期单向：dispose 后 start 抛 /disposed/（防不可杀孤儿）", async () => {
    const events: AgentEvent[] = [];
    const spec: SessionSpec = { agentId: "claude", cwd: process.cwd(), permissionMode: "default" };
    const session = new ClaudeAdapter().create(spec, (event) => { events.push(event); }) as ClaudeSession;
    await session.dispose("test");                      // 未 start 也置旗（句柄作废）
    await expect(session.start()).rejects.toThrow(/disposed/);
    await session.dispose("test-again");                // 幂等：不抛、不复活
    await expect(session.start()).rejects.toThrow(/disposed/);
  });

  it("killTree 容错：对已退出的 pid 与 undefined pid 调用均不抛", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const pid = child.pid;
    await new Promise<void>((resolve) => { child.on("close", () => { resolve(); }); });
    expect(pid).toBeDefined();
    expect(() => killTree(pid)).not.toThrow();          // 已退出：ESRCH/taskkill 报错都被吞
    expect(() => killTree(undefined)).not.toThrow();
  });
});

/**
 * Task 7.4：审批闸接线（spawn 参数映射 / approve 闸环路 / 晚到失效）。
 * 闸组件全部住在 claude 域内（gate/），由 ClaudeSession 自持自清——断言焦点是
 * 「aimi sessionId 经 create 上下文进闸目录派生」与「approve 写决定文件」两条 seam。
 */
describe.skipIf(process.platform !== "win32")("claudeSession 审批闸接线（Task 7.4）", () => {
  it("spawn 参数按权限档位挂闸：default=manual / plan=plan，闸参数 + --mcp-config 指向确定性 permDir", async () => {
    const dir = fakeClaudeDirArgs(SCRIPT_ARGS);
    const dataDir = mkdtempSync(join(tmpdir(), "aimi-gate-data-"));
    dirs.push(dataDir);
    vi.stubEnv("PATH", dir + ";" + process.env.PATH);
    const events: AgentEvent[] = [];
    const adapter = new ClaudeAdapter();
    const session = adapter.create(
      { agentId: "claude", cwd: dir, permissionMode: "default" }, (e) => { events.push(e); },
      undefined, { sessionId: "s-args-1", dataDir },
    ) as ClaudeSession;
    const sessionPlan = adapter.create(
      { agentId: "claude", cwd: dir, permissionMode: "plan" }, (e) => { events.push(e); },
      undefined, { sessionId: "s-args-2", dataDir },
    ) as ClaudeSession;
    const permDir1 = join(dataDir, "perms", "s-args-1");
    const permDir2 = join(dataDir, "perms", "s-args-2");
    try {
      await session.start();
      // mcp.json 断言放 dispose 之前（dispose 会整目录清理 permDir——args.log 在假 CLI 目录不受影响）。
      const mcp = JSON.parse(readFileSync(join(permDir1, "mcp.json"), "utf8")) as { mcpServers: { aimi_gate: { command: string; args: string[] } } };
      expect(mcp.mcpServers.aimi_gate.command).toBe("node");
      expect(mcp.mcpServers.aimi_gate.args[0]).toMatch(/gate\.mjs$/);
      expect(mcp.mcpServers.aimi_gate.args[1]).toBe(permDir1);

      await waitFor(() => events.some((e) => e.type === "state" && e.state === "finished"), 5000);
      await sessionPlan.start();
      expect(existsSync(join(permDir2, "mcp.json"))).toBe(true); // plan 会话同样独立挂闸目录
      await waitFor(() => events.filter((e) => e.type === "state" && e.state === "finished").length === 2, 5000);
    } finally {
      await session.dispose("test");
      await sessionPlan.dispose("test");
    }
    const argLines = readFileSync(join(dir, "args.log"), "utf8").trim().split("\n");
    expect(argLines).toHaveLength(2);
    // FACT4：default 的 auto 安全分类器直接放行（绕闸）——必须显式 manual；plan 本就人工把关、同闸承接。
    expect(argLines[0]).toContain("--permission-mode manual");
    expect(argLines[0]).toContain("--permission-prompt-tool mcp__aimi_gate__request_permission");
    expect(argLines[0]).toContain("--mcp-config " + join(permDir1, "mcp.json"));
    expect(argLines[1]).toContain("--permission-mode plan");
    expect(argLines[1]).toContain("--permission-prompt-tool mcp__aimi_gate__request_permission");
    expect(argLines[1]).toContain("--mcp-config " + join(permDir2, "mcp.json"));
  });

  it("approve 闸环路：请求文件 → permission 卡 + waiting → approve once → 决定文件全等 + emit running", async () => {
    const dir = fakeClaudeDir(SCRIPT_INIT_SILENT);
    const dataDir = mkdtempSync(join(tmpdir(), "aimi-gate-data-"));
    dirs.push(dataDir);
    vi.stubEnv("PATH", dir + ";" + process.env.PATH);
    const events: AgentEvent[] = [];
    const session = new ClaudeAdapter().create(
      { agentId: "claude", cwd: dir, permissionMode: "default" }, (e) => { events.push(e); },
      undefined, { sessionId: "s-gate", dataDir },
    ) as ClaudeSession;
    try {
      await session.start();
      const permDir = join(dataDir, "perms", "s-gate");
      // 等 init 的 running 入册再落请求文件（静默脚本之后零输出——事件序因此完全确定）。
      await waitFor(() => events.some((e) => e.type === "state" && e.state === "running"), 5000);
      // 直写一份闸请求（模拟 gate.mjs 落盘的契约形状）——relay 轮询承接。
      writeFileSync(join(permDir, "perm-t1.request.json"), JSON.stringify({ toolName: "Bash", input: { command: "ls" }, toolUseId: "perm-t1" }));
      await waitFor(() => events.some((e) => e.type === "state" && e.state === "waiting_approval"), 5000);
      expect(events).toEqual([
        { type: "state", state: "running" }, // init（静默脚本只有一行输出）
        {
          type: "permission", id: "perm-t1", title: "Bash", detail: JSON.stringify({ command: "ls" }),
          options: [
            { label: "本次允许", kind: "once" },
            { label: "一直允许", kind: "always" },
            { label: "拒绝", kind: "reject" },
          ],
        },
        { type: "state", state: "waiting_approval" },
      ]);
      await session.send({ cmd: "approve", requestId: "perm-t1", decision: "once" });
      expect(readFileSync(join(permDir, "perm-t1.decision.txt"), "utf8")).toBe(JSON.stringify({ behavior: "allow" }));
      expect(events.at(-1)).toEqual({ type: "state", state: "running" }); // waiting→running 白名单内
    } finally {
      await session.dispose("test");
    }
  });

  it("approve always → 决定文件 + 会话内记名；第二个同工具请求自动放行（无 permission 卡）", async () => {
    const dir = fakeClaudeDir(SCRIPT_INIT_SILENT);
    const dataDir = mkdtempSync(join(tmpdir(), "aimi-gate-data-"));
    dirs.push(dataDir);
    vi.stubEnv("PATH", dir + ";" + process.env.PATH);
    const events: AgentEvent[] = [];
    const session = new ClaudeAdapter().create(
      { agentId: "claude", cwd: dir, permissionMode: "default" }, (e) => { events.push(e); },
      undefined, { sessionId: "s-always", dataDir },
    ) as ClaudeSession;
    try {
      await session.start();
      const permDir = join(dataDir, "perms", "s-always");
      await waitFor(() => events.some((e) => e.type === "state" && e.state === "running"), 5000);
      writeFileSync(join(permDir, "perm-a1.request.json"), JSON.stringify({ toolName: "Bash", input: { command: "ls" }, toolUseId: "perm-a1" }));
      await waitFor(() => events.some((e) => e.type === "state" && e.state === "waiting_approval"), 5000);
      await session.send({ cmd: "approve", requestId: "perm-a1", decision: "always" });
      expect(readFileSync(join(permDir, "perm-a1.decision.txt"), "utf8")).toBe(JSON.stringify({ behavior: "allow" }));
      expect(events.at(-1)).toEqual({ type: "state", state: "running" });

      // 第二个同工具请求：自动放行——无 permission/waiting 事件，仅一条可见性 notice。
      const before = events.length;
      writeFileSync(join(permDir, "perm-a2.request.json"), JSON.stringify({ toolName: "Bash", input: { command: "ls -R" }, toolUseId: "perm-a2" }));
      await waitFor(() => existsSync(join(permDir, "perm-a2.decision.txt")), 5000);
      await sleep(60);
      expect(readFileSync(join(permDir, "perm-a2.decision.txt"), "utf8")).toBe(JSON.stringify({ behavior: "allow" }));
      expect(events.slice(before)).toEqual([
        { type: "notice", severity: "info", text: '已按"一直允许"自动放行 Bash' },
      ]);
    } finally {
      await session.dispose("test");
    }
  });

  it("未知 requestId 的 approve → 失效 warn notice、决定文件未写（不静默吞不代答）", async () => {
    const dir = fakeClaudeDir(SCRIPT_INIT_SILENT);
    const dataDir = mkdtempSync(join(tmpdir(), "aimi-gate-data-"));
    dirs.push(dataDir);
    vi.stubEnv("PATH", dir + ";" + process.env.PATH);
    const events: AgentEvent[] = [];
    const session = new ClaudeAdapter().create(
      { agentId: "claude", cwd: dir, permissionMode: "default" }, (e) => { events.push(e); },
      undefined, { sessionId: "s-ghost", dataDir },
    ) as ClaudeSession;
    try {
      await session.start();
      await session.send({ cmd: "approve", requestId: "perm-ghost", decision: "once" });
      expect(events.at(-1)).toEqual({ type: "notice", severity: "warn", text: "审批已失效（请求不存在或已答复）" });
      expect(existsSync(join(dataDir, "perms", "s-ghost", "perm-ghost.decision.txt"))).toBe(false);
    } finally {
      await session.dispose("test");
    }
  });

  it("dispose 清理闸目录：relay 停轮询 + permDir 整目录删除（同目录复用不得误吃旧决定）", async () => {
    const dir = fakeClaudeDir(SCRIPT_INIT_SILENT);
    const dataDir = mkdtempSync(join(tmpdir(), "aimi-gate-data-"));
    dirs.push(dataDir);
    vi.stubEnv("PATH", dir + ";" + process.env.PATH);
    const events: AgentEvent[] = [];
    const session = new ClaudeAdapter().create(
      { agentId: "claude", cwd: dir, permissionMode: "default" }, (e) => { events.push(e); },
      undefined, { sessionId: "s-clean", dataDir },
    ) as ClaudeSession;
    const permDir = join(dataDir, "perms", "s-clean");
    await session.start();
    expect(existsSync(join(permDir, "mcp.json"))).toBe(true);
    await session.dispose("test");
    expect(existsSync(permDir)).toBe(false); // 整目录清理：下一轮同目录复用从零开始
  });
});
