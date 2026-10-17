import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Application } from "../src/app/application.js";
import type { ServerConfig } from "../src/app/config.js";
import { ConfigProvisioner } from "../src/auth/configProvisioner.js";
import { MemoryDeviceRepository } from "../src/persistence/memory/index.js";
import { openMigrated } from "../src/persistence/sqlite/migrate.js";
import { SqliteConversationRepository } from "../src/persistence/sqlite/sqliteConversationRepository.js";

/** 复用 T10 的协议回放 fixture（同一线格式，故同一期望事件流）。 */
const FIXTURE = fileURLToPath(new URL("../src/agents/claude/__fixtures__/normal-turn.jsonl", import.meta.url));

/**
 * 假 claude 脚本（PATH 注入，复用 T10 手法）：
 * - 从脚本同目录读 `normal-turn.jsonl`，每 30ms 回放一行到 stdout（触发状态/增量/工具事件）；
 * - 把 stdin 收到的每行追加到 `cwd/stdin.log`（打断断言据此）；
 * - 收到 `control_request/interrupt` → 写一行**非 JSON**（归一化为 notice）后终止；
 * - 回放完毕或 stdin EOF 亦终止——**自终止**保证测试不留孤儿子进程（生产 claude 反之常驻）。
 */
const FAKE_CLAUDE_SCRIPT = [
  'import { appendFileSync, readFileSync } from "node:fs";',
  'import { dirname, join } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  "",
  "const here = dirname(fileURLToPath(import.meta.url));",
  'const lines = readFileSync(join(here, "normal-turn.jsonl"), "utf8").split(/\\r?\\n/).filter((l) => l !== "");',
  'let buf = "";',
  "let done = false;",
  "let timer = null;",
  "function finish() {",
  "  if (done) return;",
  "  done = true;",
  "  if (timer !== null) clearInterval(timer);",
  "  setTimeout(() => process.exit(0), 100);",
  "}",
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (chunk) => {',
  "  buf += chunk;",
  '  const parts = buf.split("\\n");',
  "  buf = parts.pop();",
  "  for (const part of parts) {",
  '    const line = part.replace(/\\r$/, "");',
  '    if (line === "") continue;',
  '    appendFileSync(join(process.cwd(), "stdin.log"), line + "\\n");',
  '    if (line.includes(\'"subtype":"interrupt"\')) {',
  '      process.stdout.write("interrupt received\\n");',
  "      finish();",
  "    }",
  "  }",
  "});",
  'process.stdin.on("end", finish);',
  "let i = 0;",
  "timer = setInterval(() => {",
  "  if (i >= lines.length) { finish(); return; }",
  '  process.stdout.write(lines[i] + "\\n");',
  "  i = i + 1;",
  "}, 30);",
].join("\n");

const cleanups: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of cleanups.splice(0)) await removeDir(dir);
});

/** 删除临时目录：假 claude 异步自退出，句柄释放有时间窗——重试若干次规避 Windows EBUSY/EPERM 抖动。 */
async function removeDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 19) throw err;
      await sleep(50);
    }
  }
}

/** 造假 CLI 目录：拷 fixture + 写脚本 + `claude.cmd` 垫片（PATH 解析目标）。 */
function fakeClaudeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aimi-e2e-bin-"));
  cleanups.push(dir);
  writeFileSync(join(dir, "normal-turn.jsonl"), readFileSync(FIXTURE, "utf8"));
  writeFileSync(join(dir, "fake-claude.mjs"), FAKE_CLAUDE_SCRIPT, "utf8");
  writeFileSync(join(dir, "claude.cmd"), '@echo off\r\n"' + process.execPath + '" "%~dp0fake-claude.mjs"\r\n');
  return dir;
}

/** ws 连接的 open 事件（错误一并拒绝）。 */
function opened(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** 帧流：把 ws 文本消息解析为对象，未消费的入队（`until` 从不会漏帧）。 */
class MsgStream {
  readonly #queue: any[] = [];
  readonly #waiters: ((frame: any) => void)[] = [];

  constructor(ws: WebSocket) {
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data));
      const waiter = this.#waiters.shift();
      if (waiter !== undefined) waiter(frame); else this.#queue.push(frame);
    });
  }

  /** 取下一条帧（队列空则挂起等待），超时即拒绝。 */
  next(timeoutMs = 5000): Promise<any> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待帧超时")), timeoutMs);
      this.#waiters.push((frame) => { clearTimeout(timer); resolve(frame); });
    });
  }

  /** 连续收帧直到 `pred` 命中；返回途中收到的全部帧（含命中帧）。 */
  async until(pred: (frame: any) => boolean, timeoutMs = 10000): Promise<any[]> {
    const collected: any[] = [];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("until 超时");
      const frame = await this.next(remaining);
      collected.push(frame);
      if (pred(frame)) return collected;
    }
  }
}

/** 收帧直到 `ack`；返回 ack 与其**之前**已到达的帧（`starting` 等会话事件可能先于 ack）。 */
async function untilAck(stream: MsgStream): Promise<{ ack: any; pre: any[] }> {
  const frames = await stream.until((f) => f.type === "ack", 15000);
  return { ack: frames[frames.length - 1], pre: frames };
}

/**
 * 平台卫语句（C3：server 仅 Windows；假 `.cmd` 垫片 + PATH 分号语义）。非 Windows 整块跳过。
 */
describe.skipIf(process.platform !== "win32")("M0 e2e：LAN 直连全流程", () => {
  it("hello→welcome→create→事件流(seq 保序)→打断→幂等→审计", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-e2e-"));
    cleanups.push(root);
    const dataDir = join(root, "data");
    const workDir = join(root, "work");
    mkdirSync(workDir, { recursive: true });
    const binDir = fakeClaudeDir();
    vi.stubEnv("PATH", binDir + ";" + (process.env.PATH ?? ""));

    const app = new Application({
      port: 0,
      dataDir,
      logDir: join(root, "logs"),
      logLevel: "ERROR",
      serverVersion: "0.1.0",
    });
    const { port } = await app.start();

    // 令牌经实现口径 (b)：直接构造 ConfigProvisioner 读明文（Application 已 provision 到同一文件）。
    const provision = new ConfigProvisioner(new MemoryDeviceRepository(), join(dataDir, "lan-token.txt"));
    const token = (await provision.ensureLanToken()).token;

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const stream = new MsgStream(ws);
    try {
      await opened(ws);
      ws.send(JSON.stringify({ v: 1, type: "hello", token, resume: null }));
      const welcome = await stream.next();
      expect(welcome.type).toBe("welcome");
      expect(welcome.sessions).toEqual([]); // 全新库

      // 会话 1：create → 事件流至 finished；断言 seq 严格递增（保序）。
      ws.send(JSON.stringify({
        v: 1, type: "session.create",
        spec: { agentId: "claude", cwd: workDir, permissionMode: "default", initialPrompt: "hi" },
      }));
      const ack = await untilAck(stream);
      expect(ack.ack).toEqual({ v: 1, type: "ack", sessionId: expect.any(String) });
      const sid1: string = ack.ack.sessionId;

      const rest = await stream.until(
        (f) => f.type === "session.event" && f.sessionId === sid1 && f.agentEvent?.type === "state" && f.agentEvent.state === "finished",
        15000,
      );
      const events = [...ack.pre, ...rest].filter((f) => f.type === "session.event" && f.sessionId === sid1);
      const seqs = events.map((f) => f.seq as number);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // 保序
      expect(seqs[0]).toBe(0);
      expect(events[0].agentEvent).toEqual({ type: "state", state: "starting" });

      // 会话 2：create → running → 打断（对活动会话）；随后同 clientId 重发验证幂等。
      ws.send(JSON.stringify({
        v: 1, type: "session.create",
        spec: { agentId: "claude", cwd: workDir, permissionMode: "default" },
      }));
      const ack2 = await untilAck(stream);
      const sid2: string = ack2.ack.sessionId;
      await stream.until(
        (f) => f.type === "session.event" && f.sessionId === sid2 && f.agentEvent?.type === "state" && f.agentEvent.state === "running",
        15000,
      );

      const interrupt = JSON.stringify({
        v: 1, type: "session.command", sessionId: sid2, clientId: "cid-e2e-0001", cmd: { cmd: "interrupt" },
      });
      ws.send(interrupt);
      // 假 claude 对 interrupt 的回应：非 JSON 行 → notice 事件。
      await stream.until(
        (f) => f.type === "session.event" && f.sessionId === sid2 && f.agentEvent?.type === "notice",
        8000,
      );

      ws.send(interrupt); // 重发同 clientId：不得再执行（只在 stdin.log 留 1 次）
      await sleep(400);

      // 错误帧映射：不存在的会话 stop → session.not_found（message 带 at-most-once 提示）；未知 agent → session.agent_missing。
      ws.send(JSON.stringify({
        v: 1, type: "session.command", sessionId: "no-such-session", clientId: "cid-e2e-0002", cmd: { cmd: "stop" },
      }));
      const notFound = await stream.until((f) => f.type === "error", 5000).then((frames) => frames[frames.length - 1]);
      expect(notFound.code).toBe("session.not_found");
      expect(notFound.message).toMatch(/at-most-once/);

      ws.send(JSON.stringify({
        v: 1, type: "session.create",
        spec: { agentId: "no-such-agent", cwd: workDir, permissionMode: "default" },
      }));
      const missing = await stream.until((f) => f.type === "error", 5000).then((frames) => frames[frames.length - 1]);
      expect(missing.code).toBe("session.agent_missing");
    } finally {
      await app.close();
    }

    // 审计：command.interrupt 恰 1 次（clientId 去重生效）。
    const db = new Database(join(dataDir, "aimi.db"));
    try {
      const rows = db.prepare("SELECT action, COUNT(*) AS c FROM audit GROUP BY action").all() as { action: string; c: number }[];
      const counts: Record<string, number> = Object.fromEntries(rows.map((r) => [r.action, r.c]));
      expect(counts["command.interrupt"]).toBe(1);
      expect(counts["command.duplicate"] ?? 0).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }

    // 假 claude 实际收到的 interrupt 恰一次。
    const stdinLog = readFileSync(join(workDir, "stdin.log"), "utf8");
    const interrupts = stdinLog.split("\n").filter((line) => line.includes('"subtype":"interrupt"'));
    expect(interrupts).toHaveLength(1);
  }, 40_000);
});

/**
 * 启动恢复（跨平台）：不依赖 claude，直接预置库，验证装配层 `adopt` + `EventBus.seedSession` 两条 seam。
 * 核心断言是**跨进程 seq 连续性**——重启后第一条新事件的 seq 必须接续仓储 `lastSeq`（否则撞主键）。
 */
describe("M0 启动恢复：跨进程 seq 连续性 + 既有会话入 welcome", () => {
  it("重启后新事件 seq = 仓储 lastSeq + 1（不撞车）", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-recover-"));
    cleanups.push(root);
    const dataDir = join(root, "data");
    const cfg: ServerConfig = {
      port: 0, dataDir, logDir: join(root, "logs"), logLevel: "ERROR", serverVersion: "0.1.0",
    };

    // 预置：一条 running 会话 + seq 0..5 的事件（模拟上次进程遗留的库）。
    mkdirSync(dataDir, { recursive: true });
    const db = openMigrated(join(dataDir, "aimi.db"));
    const conversations = new SqliteConversationRepository(db);
    await conversations.createSession(
      { id: "s-recover", agentId: "claude", cwd: "C:/w", permissionMode: "default" },
      { type: "state", state: "starting" },
    );
    for (let seq = 1; seq <= 5; seq++) {
      await conversations.appendEvent("s-recover", seq, { type: "text_delta", text: "x" }, Date.now());
    }
    await conversations.updateSession("s-recover", { state: "running", lastSeq: 5 });
    db.close();

    const app = new Application(cfg);
    const { port } = await app.start();
    try {
      const token = (await new ConfigProvisioner(new MemoryDeviceRepository(), join(dataDir, "lan-token.txt")).ensureLanToken()).token;
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const stream = new MsgStream(ws);
      await opened(ws);
      ws.send(JSON.stringify({ v: 1, type: "hello", token, resume: null }));
      const welcome = await stream.next();
      expect(welcome.sessions.map((s: any) => s.id)).toEqual(["s-recover"]);
      expect(welcome.sessions[0].lastSeq).toBe(5);

      // 对恢复会话发 stop：archived 无子进程，但仍会发 {state:stopped}——其 seq 必须 = 6（接续仓储）。
      ws.send(JSON.stringify({
        v: 1, type: "session.command", sessionId: "s-recover", clientId: "cid-recover-0001", cmd: { cmd: "stop" },
      }));
      const frames = await stream.until(
        (f) => f.type === "session.event" && f.sessionId === "s-recover" && f.agentEvent?.type === "state" && f.agentEvent.state === "stopped",
        8000,
      );
      expect(frames[frames.length - 1].seq).toBe(6);
      ws.close();
    } finally {
      await app.close();
    }
  }, 30_000);
});
