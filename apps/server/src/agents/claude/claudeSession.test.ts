import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, SessionSpec } from "@aimi/protocol";
import { ClaudeAdapter } from "./claudeAdapter.js";
import { killTree, type ClaudeSession } from "./claudeSession.js";

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

const dirs: string[] = [];

/** 造临时目录：拷 fixture、写假 claude 脚本与 `claude.cmd` 垫片（PATH 解析目标）。 */
function fakeClaudeDir(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aimi-claude-"));
  dirs.push(dir);
  writeFileSync(join(dir, "normal-turn.jsonl"), readFileSync(FIXTURE, "utf8"));
  writeFileSync(join(dir, "fake-claude.mjs"), script, "utf8");
  // 生产同构：Windows 下 `claude` 经 `shell:true` 由 cmd.exe 按 PATH+PATHEXT 解析到 `.cmd` 垫片。
  writeFileSync(join(dir, "claude.cmd"), '@echo off\r\n"' + process.execPath + '" "%~dp0fake-claude.mjs"\r\n');
  return dir;
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** 轮询等待条件成立（回放有 30ms/行的节拍，事件是异步到达的）。 */
async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await sleep(20);
  }
}

/** 用 PATH 注入假 CLI 拉起一条会话。 */
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
});

/** 跨平台用例：不依赖 `.cmd`/PATH 语义（占位指令、生命周期旗标、树杀容错）。 */
describe("claudeSession 生命周期与容错（跨平台）", () => {
  it("M1 占位：approve/answer 发 info notice；附件被忽略并告警（不起子进程）", async () => {
    const events: AgentEvent[] = [];
    const spec: SessionSpec = { agentId: "claude", cwd: process.cwd(), permissionMode: "plan" };
    const session = new ClaudeAdapter().create(spec, (event) => { events.push(event); }) as ClaudeSession;
    try {
      await session.send({ cmd: "approve", requestId: "r1", decision: "once" });
      await session.send({ cmd: "answer", questionId: "q1", value: "yes" });
      await session.send({ cmd: "send", text: "look", files: [{ name: "a.png", b64: "AA" }] });
      expect(events).toEqual([
        { type: "notice", severity: "info", text: "审批/提问交互 M1 接入" },
        { type: "notice", severity: "info", text: "审批/提问交互 M1 接入" },
        { type: "notice", severity: "warn", text: "附件 M1 接入，已忽略 1 个" },
      ]);
      expect(session.getResumeHint()).toBeUndefined();
    } finally {
      await session.dispose("test");
    }
  });

  it("生命周期单向：dispose 后 start 抛 /disposed/（防不可杀孤儿）", async () => {
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
