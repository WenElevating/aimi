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
 * - 从脚本同目录读回放文件（`AIMI_FAKE_TURN`，缺省 `normal-turn.jsonl`），
 *   每 `AIMI_FAKE_INTERVAL_MS`（缺省 30）毫秒回放一行到 stdout（触发状态/增量/工具事件）；
 * - 把 stdin 收到的每行追加到 `cwd/stdin.log`（打断断言据此）；
 * - 收到 `control_request/interrupt` → 写一行**非 JSON**（归一化为 notice）后终止；
 * - 回放完毕或 stdin EOF 亦终止——**自终止**保证测试不留孤儿子进程（生产 claude 反之常驻）。
 *
 * 参数化只经环境变量（子进程继承 `process.env`），不改 `claudeSession` 的 spawn 形态：
 * T16 的延迟/洪水/截断场景各自写一份 fixture + stub `AIMI_FAKE_TURN`/`AIMI_FAKE_INTERVAL_MS`，
 * 既有测试不传环境变量，故回放行为逐字不变。
 */
const FAKE_CLAUDE_SCRIPT = [
  'import { appendFileSync, readFileSync } from "node:fs";',
  'import { dirname, join } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  "",
  "const here = dirname(fileURLToPath(import.meta.url));",
  'const turn = process.env.AIMI_FAKE_TURN || "normal-turn.jsonl";',
  'const intervalMs = Number(process.env.AIMI_FAKE_INTERVAL_MS || "30");',
  'const lines = readFileSync(join(here, turn), "utf8").split(/\\r?\\n/).filter((l) => l !== "");',
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
  "}, intervalMs);",
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

/**
 * 造假 CLI 目录：写 fixture + 脚本 + `claude.cmd` 垫片（PATH 解析目标）。
 * 缺省逐字复刻既有场景（`normal-turn.jsonl`）；T16 场景传入独立的 `fixtureName`/`fixture` 生成回放流。
 * 回放间隔不走本函数（属运行时行为）：由调用方 stub `AIMI_FAKE_INTERVAL_MS` 注入。
 */
function fakeClaudeDir(opts: { fixtureName?: string; fixture?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "aimi-e2e-bin-"));
  cleanups.push(dir);
  writeFileSync(join(dir, opts.fixtureName ?? "normal-turn.jsonl"), opts.fixture ?? readFileSync(FIXTURE, "utf8"));
  writeFileSync(join(dir, "fake-claude.mjs"), FAKE_CLAUDE_SCRIPT, "utf8");
  writeFileSync(join(dir, "claude.cmd"), '@echo off\r\n"' + process.execPath + '" "%~dp0fake-claude.mjs"\r\n');
  return dir;
}

/** 假 claude 回放流的行构造器（`stream-json` 私有帧 → 归一化事件，映射见 claudeProtocol）。 */
const E2E_CLAUDE_SESSION = "cls-e2e";
const fixtureInit = (): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: E2E_CLAUDE_SESSION, model: "claude-e2e", cwd: "D:\\w" });
const fixtureTextDelta = (text: string): string =>
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } }, session_id: E2E_CLAUDE_SESSION });
const fixtureThinkingDelta = (text: string): string =>
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: text } }, session_id: E2E_CLAUDE_SESSION });
const fixtureResult = (): string =>
  JSON.stringify({ type: "result", subtype: "success", result: "done", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, duration_ms: 1 });
/** 行序列 → fixture 文本（含末尾换行，行缓冲末行不丢）。 */
const fixtureLines = (...rows: string[]): string => rows.join("\n") + "\n";

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

  /**
   * @param ws 已建立（或即将建立）的客户端连接。
   * @param onFrame 可选观测钩子：每条消息**到达瞬间**（JSON.parse 之前）回调，
   *   `receivedAt` 为该时刻的 `Date.now()`——T16 延迟断言据此测「服务端发布 → 客户端收帧」。
   */
  constructor(ws: WebSocket, onFrame?: (frame: any, receivedAt: number) => void) {
    ws.on("message", (data) => {
      const receivedAt = Date.now();
      const frame = JSON.parse(String(data));
      onFrame?.(frame, receivedAt);
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

/** T16 性能预算用例的装配把手（app/ws/stream/workDir）。 */
interface PerfHarness {
  readonly app: Application;
  readonly ws: WebSocket;
  readonly stream: MsgStream;
  readonly workDir: string;
}

/**
 * 起一套真 Application + 真 ws + 假 claude（PATH 注入），完成 hello→welcome 握手。
 * fixture 以独立文件名落盘，并经 `AIMI_FAKE_TURN`/`AIMI_FAKE_INTERVAL_MS` 传给自终止脚本。
 * @param opts.fixtureName 回放文件名（脚本按 `AIMI_FAKE_TURN` 读取）。
 * @param opts.fixture 回放内容（NDJSON）。
 * @param opts.intervalMs 行间回放间隔（毫秒）；缺省时脚本内 30ms。
 * @param opts.onFrame 收帧观测钩子（延迟样本采集）。
 */
async function bootPerfHarness(opts: {
  fixtureName: string;
  fixture: string;
  intervalMs?: number;
  onFrame?: (frame: any, receivedAt: number) => void;
}): Promise<PerfHarness> {
  const binDir = fakeClaudeDir({ fixtureName: opts.fixtureName, fixture: opts.fixture });
  const root = mkdtempSync(join(tmpdir(), "aimi-e2e-perf-"));
  cleanups.push(root);
  const dataDir = join(root, "data");
  const workDir = join(root, "work");
  mkdirSync(workDir, { recursive: true });
  vi.stubEnv("PATH", binDir + ";" + (process.env.PATH ?? ""));
  vi.stubEnv("AIMI_FAKE_TURN", opts.fixtureName);
  const intervalMs = opts.intervalMs ?? 30;
  vi.stubEnv("AIMI_FAKE_INTERVAL_MS", String(intervalMs));

  const app = new Application({
    port: 0,
    dataDir,
    logDir: join(root, "logs"),
    logLevel: "ERROR",
    serverVersion: "0.1.0",
  });
  const { port } = await app.start();
  const token = (await new ConfigProvisioner(new MemoryDeviceRepository(), join(dataDir, "lan-token.txt")).ensureLanToken()).token;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const stream = new MsgStream(ws, opts.onFrame);
  await opened(ws);
  ws.send(JSON.stringify({ v: 1, type: "hello", token, resume: null }));
  const welcome = await stream.next();
  if (welcome.type !== "welcome") throw new Error("期望 welcome，实收 " + JSON.stringify(welcome));
  return { app, ws, stream, workDir };
}

/** create 一条 claude 会话，收帧至 `finished`；返回 sid 与途中全部会话帧（含 ack 前到达者）。 */
async function createAndDrain(h: PerfHarness): Promise<{ sid: string; events: any[] }> {
  h.ws.send(JSON.stringify({
    v: 1, type: "session.create",
    spec: { agentId: "claude", cwd: h.workDir, permissionMode: "default", initialPrompt: "hi" },
  }));
  const ack = await untilAck(h.stream);
  const sid: string = ack.ack.sessionId;
  const rest = await h.stream.until(
    (f) => f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "state" && f.agentEvent.state === "finished",
    20000,
  );
  return { sid, events: [...ack.pre, ...rest] };
}

/** 取某会话的 text_delta 帧（到达顺序 = seq 顺序）。 */
function textDeltaFrames(events: any[], sid: string): any[] {
  return events.filter((f) => f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "text_delta");
}

/** 最近秩 P95（nearest-rank）：升序第 `ceil(0.95n)` 个，n≥1 时必落在有效下标内。 */
function percentile95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

/**
 * M0 性能预算（设计 §7 的本机收紧口径）。平台同 LAN 用例：走 Windows `.cmd` 垫片。
 *
 * **延迟口径**：`receivedAt - frame.ts`——`frame.ts` 是 EventBus 发布（聚合事件取首条 delta）的时刻，
 *   故含聚合窗口与落库/广播耗时；loopback 下断言 P95 ≤ 200ms（LAN 真机 1000ms 口径在人肉清单核对）。
 * **确定性说明**：fixture 让每条 text_delta 与相邻 thinking 交替（20ms 行距）——
 *   类型切换是**即时窗口边界**（非 100ms 定时器），故每个 delta 恰好产出 1 帧，样本数确定。
 *   洪水用例靠 100ms 定时窗口聚合，其帧数上界由 §7 给出（50×5/100 向上取整 +1 = 4）。
 */
describe.skipIf(process.platform !== "win32")("M0 性能预算（§7）", () => {
  it("呈现延迟：loopback P95 ≤ 200ms（样本 ≥ 10）", async () => {
    const deltaCount = 20;
    const rows: string[] = [fixtureInit()];
    for (let i = 0; i < deltaCount; i++) {
      rows.push(fixtureThinkingDelta("思考" + i));
      rows.push(fixtureTextDelta("增量-" + i));
    }
    rows.push(fixtureResult());

    const latencies: number[] = [];
    const h = await bootPerfHarness({
      fixtureName: "latency-turn.jsonl",
      fixture: fixtureLines(...rows),
      intervalMs: 20,
      onFrame: (frame, receivedAt) => {
        if (frame.type === "session.event" && frame.agentEvent?.type === "text_delta") {
          latencies.push(receivedAt - frame.ts);
        }
      },
    });
    try {
      const { sid, events } = await createAndDrain(h);
      const frames = textDeltaFrames(events, sid);
      expect(latencies.length).toBeGreaterThanOrEqual(10); // §7 抽查下限
      expect(latencies.length).toBe(frames.length); // 每条 text_delta 帧恰一条样本（观测无漏）
      const p95 = percentile95(latencies);
      const sorted = [...latencies].sort((a, b) => a - b);
      console.log(`[bench] 呈现延迟(loopback) n=${latencies.length} P95=${p95}ms min=${sorted[0]}ms max=${sorted[sorted.length - 1]}ms`);
      expect(p95).toBeLessThanOrEqual(200);
    } finally {
      await h.app.close();
    }
  }, 40_000);

  it("洪水聚合：50 连续 text_delta（5ms 行距）→ 传输帧数 ≤ ceil(50*5/100)+1", async () => {
    const deltaCount = 50;
    const rows: string[] = [fixtureInit()];
    for (let i = 0; i < deltaCount; i++) rows.push(fixtureTextDelta("d" + i));
    rows.push(fixtureResult());

    const h = await bootPerfHarness({ fixtureName: "flood-turn.jsonl", fixture: fixtureLines(...rows), intervalMs: 5 });
    try {
      const { sid, events } = await createAndDrain(h);
      const frames = textDeltaFrames(events, sid);
      const budget = Math.ceil((deltaCount * 5) / 100) + 1; // §7 上界 = 4
      const merged = frames.map((f) => f.agentEvent.text as string).join("");
      const expected = Array.from({ length: deltaCount }, (_, i) => "d" + i).join("");
      console.log(`[bench] 洪水聚合：${deltaCount} 条 → ${frames.length} 帧（预算 ${budget}）`);
      expect(budget).toBe(4);
      expect(frames.length).toBeLessThanOrEqual(budget);
      expect(merged).toBe(expected); // 聚合不丢内容、不乱序
    } finally {
      await h.app.close();
    }
  }, 40_000);

  it("8KB 截断：9000 字符 text_delta → 帧内 text ≤ 8192 + 截断标记宽", async () => {
    const mark = "…(truncated)";
    const big = "x".repeat(9000);

    const h = await bootPerfHarness({
      fixtureName: "truncate-turn.jsonl",
      fixture: fixtureLines(fixtureInit(), fixtureTextDelta(big), fixtureResult()),
      intervalMs: 20,
    });
    try {
      const { sid, events } = await createAndDrain(h);
      const frames = textDeltaFrames(events, sid);
      expect(frames).toHaveLength(1);
      const text: string = frames[0].agentEvent.text;
      console.log(`[bench] 截断：原始 9000 → 帧内 ${text.length}（上限 ${8192 + mark.length}）`);
      expect(text.length).toBeGreaterThan(8192); // 确实触发截断（避免空断言）
      expect(text.length).toBeLessThanOrEqual(8192 + mark.length);
      expect(text.endsWith(mark)).toBe(true);
      expect(text.slice(0, 8192)).toBe("x".repeat(8192));
    } finally {
      await h.app.close();
    }
  }, 40_000);
});
