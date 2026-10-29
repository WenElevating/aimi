import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Application } from "../src/app/application.js";
import { ConfigProvisioner } from "../src/auth/configProvisioner.js";
import { MemoryDeviceRepository } from "../src/persistence/memory/index.js";

import type { ServerConfig } from "../src/app/config.js";

/** 回放样本：每 user 帧同步全文重放——首行 system/init 的 session_id 即源会话续接线索。 */
const R_SESSION = "cls-e2e-fork";
const FORK_TURN =
  JSON.stringify({ type: "system", subtype: "init", session_id: R_SESSION, model: "claude-e2e", cwd: "D:\\w" }) +
  "\n" +
  JSON.stringify({
    type: "result",
    subtype: "success",
    result: "done",
    usage: { input_tokens: 1, output_tokens: 1 },
    total_cost_usd: 0,
    duration_ms: 1,
  }) +
  "\n";

import { writeFakeCli } from "./fakeCli.js";

const cleanups: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function opened(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });
}

/** 帧流：与 e2e_session_resume 同构（队列 + 等位者，until 不漏帧）。 */
class MsgStream {
  readonly #queue: any[] = [];
  readonly #waiters: ((frame: any) => void)[] = [];

  constructor(ws: WebSocket) {
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data));
      const waiter = this.#waiters.shift();
      if (waiter !== undefined) waiter(frame);
      else this.#queue.push(frame);
    });
  }

  next(timeoutMs = 5000): Promise<any> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待帧超时")), timeoutMs);
      this.#waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  async until(pred: (frame: any) => boolean, timeoutMs = 15000): Promise<any[]> {
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

/**
 * 会话分叉 e2e：create 拉起（hint 落库）→ session.fork 帧 → ack 新 sessionId、
 * 新会话独立跑完回合并落库；假 CLI argv 带 --fork-session（SDK forkSession 语义直达 CLI）。
 */
describe.skipIf(process.platform !== "win32")("会话分叉 e2e", () => {
  it("fork 帧 → ack 新会话 → fork 语义拉起（argv 含 --fork-session）→ 双会话并存", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-e2e-fork-"));
    cleanups.push(root);
    const dataDir = join(root, "data");
    const workDir = join(root, "work");
    mkdirSync(workDir, { recursive: true });
    const binDir = mkdtempSync(join(tmpdir(), "aimi-fork-bin-"));
    cleanups.push(binDir);
    writeFakeCli(binDir, { "fork-turn.jsonl": FORK_TURN });
    vi.stubEnv("AIMI_FAKE_CLI_PATH", join(binDir, "fake-cli.mjs"));
    vi.stubEnv("AIMI_FAKE_TURN", "fork-turn.jsonl");
    vi.stubEnv("AIMI_ARGS_LOG", join(workDir, "args.log"));

    const cfg: ServerConfig = {
      port: 0,
      dataDir,
      logDir: join(root, "logs"),
      logLevel: "ERROR",
      watchdogMs: 600_000,
      serverVersion: "0.1.0",
    };
    const app = new Application(cfg);
    const { port } = await app.start();
    const token = (
      await new ConfigProvisioner(new MemoryDeviceRepository(), join(dataDir, "lan-token.txt")).ensureLanToken()
    ).token;

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const s = new MsgStream(ws);
    await opened(ws);
    ws.send(JSON.stringify({ v: 1, type: "hello", token, resume: null }));
    const welcome = await s.next();
    expect(welcome.type).toBe("welcome");
    expect(welcome.features).toMatchObject({ sessionFork: true }); // 能力声明先行，手机据此渲染分叉按钮

    // 源会话：跑完一回合，init 的 session_id 落库为续接线索。
    ws.send(
      JSON.stringify({
        v: 1,
        type: "session.create",
        spec: { agentId: "claude", cwd: workDir, permissionMode: "default", initialPrompt: "hi" },
      }),
    );
    const created = await s.until((f) => f.type === "ack", 15000);
    const sourceId: string = created[created.length - 1].sessionId;
    await s.until(
      (f) =>
        f.type === "session.event" &&
        f.sessionId === sourceId &&
        f.agentEvent?.type === "state" &&
        f.agentEvent.state === "finished",
      15000,
    );

    // 分叉：ack 携带新 sessionId，且与源不同。
    ws.send(JSON.stringify({ v: 1, type: "session.fork", sourceId }));
    const forkAcks = await s.until((f) => f.type === "ack", 15000);
    const forkedId: string = forkAcks[forkAcks.length - 1].sessionId;
    expect(forkedId).not.toBe(sourceId);

    // 延迟启动核心断言：fork 后只有一条 finished 状态事件（无 starting、零 CLI 启动
    // ——args.log 仍只有源会话 1 行）。1.3.6 的永久转圈根因即 fork 即拉起且无看门狗。
    // 该事件先于 ack 发出，已被上面 until(ack) 扫进集合——直接在集合上断言。
    const forkedInitialStates = forkAcks
      .filter((f) => f.type === "session.event" && f.sessionId === forkedId)
      .map((f) => (f.agentEvent as { state?: string }).state);
    expect(forkedInitialStates).toEqual(["finished"]);
    expect(readFileSync(join(workDir, "args.log"), "utf8").trim().split("\n")).toHaveLength(1);

    // 首条 send 触发 fork 续接：新会话独立跑完回合（同连接 seq 全序）。
    ws.send(
      JSON.stringify({
        v: 1,
        type: "session.command",
        sessionId: forkedId,
        clientId: "cid-fork-send-01",
        cmd: { cmd: "send", text: "fork run" },
      }),
    );
    const forkedTurn = await s.until(
      (f) =>
        f.type === "session.event" &&
        f.sessionId === forkedId &&
        f.agentEvent?.type === "state" &&
        f.agentEvent.state === "finished",
      15000,
    );
    const forkedSeqs = forkedTurn
      .filter((f) => f.type === "session.event" && f.sessionId === forkedId)
      .map((f) => f.seq as number);
    expect(forkedSeqs).toEqual([...forkedSeqs].sort((a, b) => a - b));

    // 分叉拉起（首条 send 触发）是第二次进程：argv 带 resume 线索 + fork 标志
    // （SDK forkSession 语义直达 CLI）。
    const argsLog = readFileSync(join(workDir, "args.log"), "utf8").trim().split("\n");
    expect(argsLog).toHaveLength(2);
    expect(argsLog[0]).not.toContain("--resume");
    expect(argsLog[1]).toContain(`--resume=${R_SESSION}`);
    expect(argsLog[1]).toContain("--fork-session");

    ws.close();
    await app.close();
    await sleep(600); // 假 CLI 自退窗口过后再清理，规避 Windows 句柄抖动
  }, 45_000);
});
