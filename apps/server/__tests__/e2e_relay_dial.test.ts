import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { Application } from "../src/app/application.js";
import { ConfigProvisioner } from "../src/auth/configProvisioner.js";
import { MemoryDeviceRepository } from "../src/persistence/memory/index.js";

/** 单轮对话的回放样本（与 LAN 用例同形：init → text_delta → result success）。 */
const FIXTURE = fileURLToPath(new URL("../src/agents/claude/__fixtures__/normal-turn.jsonl", import.meta.url));

/** fake relay 接受的 server-token（app 侧配置必须与其一致，case② 故意不一致）。 */
const SERVER_TOKEN = "st-e2e-relay-0001";

/** 假 claude 经 `AIMI_FAKE_CLI_PATH` 注入（共享脚本见 fakeCli.ts）；spawn 即回放一轮（REPLAY_ON_START）。 */
import { writeFakeCli } from "./fakeCli.js";

const cleanups: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of cleanups.splice(0)) await removeDir(dir);
});

/** 删除临时目录：假 claude 异步自退出，句柄释放有时间窗——重试规避 Windows EBUSY/EPERM 抖动。 */
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

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** ws 连接的 open 事件（错误一并拒绝）。 */
function opened(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });
}

/**
 * 造假 CLI 目录：写回放样本与共享假 CLI（`AIMI_FAKE_CLI_PATH` 注入目标）。
 * 回放样本缺省复用基线 `normal-turn.jsonl`。
 */
function fakeClaudeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aimi-e2e-relay-cli-"));
  cleanups.push(dir);
  writeFakeCli(dir, { "normal-turn.jsonl": readFileSync(FIXTURE, "utf8") });
  vi.stubEnv("AIMI_FAKE_CLI_PATH", join(dir, "fake-cli.mjs"));
  vi.stubEnv("AIMI_FAKE_REPLAY_ON_START", "1"); // spawn 即回放（与 LAN 用例同形）
  return dir;
}

/**
 * 内嵌 fake relay（S2 relay 本体的测试替身）：单端口两路由——
 * - `/server`：server→relay 的**拨入**路由。升级层校验 header `x-aimi-server-token`
 *   （S2 对接点：relay 本体将按其契约校验；fake 不符即 HTTP 401 拒绝升级，
 *   使拨入方表现为「dial 失败」而非「建链后被关」——与"无连接产生"的验收口径一致）；
 * - `/phone`：手机侧接入路由。
 * 两端 socket **原样转发**（哑管道：Buffer 直传，不 JSON.parse——协议透传，relay 不懂帧语义）。
 */
class FakeRelay {
  readonly #server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  readonly #wss = new WebSocketServer({ noServer: true });
  readonly #serverToken: string;
  /** 拨入被拒次数（升级层 401）——case② 的观测面。 */
  rejected = 0;
  readonly #servers = new Set<ServerSocket>();
  readonly #phones = new Set<ServerSocket>();

  constructor(serverToken: string) {
    this.#serverToken = serverToken;
  }

  /** 当前活着的 /server 端连接数（case③ 恢复判据）。 */
  get serverConnected(): number {
    return this.#servers.size;
  }

  /** 监听（端口 0 = OS 分配；或传入预留端口供「先拨入失败后上线」场景复用）。 */
  async start(port = 0): Promise<number> {
    this.#server.on("upgrade", (req: IncomingMessage, socket, head) => {
      if (req.url === "/server") {
        if (req.headers["x-aimi-server-token"] !== this.#serverToken) {
          this.rejected += 1;
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        this.#wss.handleUpgrade(req, socket, head, (ws) => this.#wss.emit("connection", ws, req));
      } else if (req.url === "/phone") {
        this.#wss.handleUpgrade(req, socket, head, (ws) => this.#wss.emit("connection", ws, req));
      } else {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    });
    this.#wss.on("connection", (socket: ServerSocket, req: IncomingMessage) => {
      const isServer = req.url === "/server";
      const bucket = isServer ? this.#servers : this.#phones;
      const other = isServer ? this.#phones : this.#servers;
      bucket.add(socket);
      socket.on("message", (data) => {
        // 原样转发（Buffer 直传）：不 JSON.parse、不重编码——relay 是哑管道。
        for (const peer of other) {
          if (peer.readyState === WebSocket.OPEN) peer.send(data);
        }
      });
      socket.on("close", () => {
        bucket.delete(socket);
        for (const peer of other) {
          try { peer.close(1000, "peer gone"); } catch { /* 已关闭 */ }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, "127.0.0.1", () => resolve());
    });
    return (this.#server.address() as AddressInfo).port;
  }

  /** 停服：强制断开两端连接并收口 HTTP server（测试清理面）。 */
  async stop(): Promise<void> {
    for (const socket of [...this.#servers, ...this.#phones]) {
      try { socket.terminate(); } catch { /* 已关闭 */ }
    }
    this.#servers.clear();
    this.#phones.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

/** 占一个端口号再释放（case③：app 配置先指向它、fake relay 稍后监听同端口）。 */
async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("占位 server 未取得端口"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

/** 数日志文件里命中正则的行数（relay 拨入失败的可见面：warn 日志计数）。 */
function countLogMatches(logDir: string, re: RegExp): number {
  try {
    return (readFileSync(join(logDir, "server.log"), "utf8").match(re) ?? []).length;
  } catch {
    return 0;
  }
}

/** 帧流：把 ws 文本消息解析为对象；队列 + 等位者两态，`until` 从不漏帧。 */
class MsgStream {
  readonly #queue: any[] = [];
  readonly #waiters: ((frame: any) => void)[] = [];

  constructor(ws: WebSocket) {
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data));
      // welcome 后直发的 update.info（更新通道）与本文件的帧序断言无关，统一丢弃。
      if (frame.type === "update.info") return;
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

  /** 连续收帧直到 `pred` 命中；返回途中全部帧（含命中帧）。 */
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

/** 收帧直到 `ack`；返回 ack 与其**之前**已到达的帧（`starting` 等会话事件可能先于 ack）。 */
async function untilAck(stream: MsgStream): Promise<{ ack: any; pre: any[] }> {
  const frames = await stream.until((f) => f.type === "ack", 15000);
  return { ack: frames[frames.length - 1], pre: frames };
}

describe("Task 9 e2e：server→relay 出站拨入（fake relay 哑管道透传）", () => {
  it("case① relay 全链：hello→welcome→create→事件流→指令，帧序列与 LAN 用例等价", async () => {
    if (process.platform !== "win32") return; // 假 CLI 走 Windows .cmd 垫片（与 LAN 用例同口径）
    const root = mkdtempSync(join(tmpdir(), "aimi-e2e-relay-"));
    cleanups.push(root);
    const dataDir = join(root, "data");
    const workDir = join(root, "work");
    mkdirSync(workDir, { recursive: true });
    fakeClaudeDir(); // 注入 AIMI_FAKE_CLI_PATH（PATH 注入已废弃）

    const relay = new FakeRelay(SERVER_TOKEN);
    const relayPort = await relay.start();
    const app = new Application({
      port: 0,
      dataDir,
      logDir: join(root, "logs"),
      logLevel: "ERROR",
      watchdogMs: 600_000, serverVersion: "0.1.0",
      relay: { url: `ws://127.0.0.1:${relayPort}/server`, serverToken: SERVER_TOKEN },
    });
    try {
      await app.start();
      const token = (await new ConfigProvisioner(new MemoryDeviceRepository(), join(dataDir, "lan-token.txt")).ensureLanToken()).token;

      // 手机连 relay 的 /phone 路由：全链不经 LAN 直连，帧经 fake relay 原样转发。
      const phone = new WebSocket(`ws://127.0.0.1:${relayPort}/phone`);
      const stream = new MsgStream(phone);
      await opened(phone);
      phone.send(JSON.stringify({ v: 1, type: "hello", token, resume: null }));
      const welcome = await stream.next();
      expect(welcome.type).toBe("welcome");
      expect(welcome.sessions).toEqual([]); // 全新库

      // 会话 1：create 后事件流至 finished；seq 严格递增、首事件 starting（与 LAN 等价）。
      phone.send(JSON.stringify({
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

      // 会话 2：running 后打断 + 同 clientId 重发（幂等经 relay 链同样生效）。
      phone.send(JSON.stringify({
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
        v: 1, type: "session.command", sessionId: sid2, clientId: "cid-relay-0001", cmd: { cmd: "interrupt" },
      });
      phone.send(interrupt);
      // SDK 传输下 interrupt 由服务端事实落地 stopped（假 CLI 回执后自退，无归一化 notice）。
      await stream.until(
        (f) => f.type === "session.event" && f.sessionId === sid2 && f.agentEvent?.type === "state" && f.agentEvent.state === "stopped",
        8000,
      );
      phone.send(interrupt); // 重发同 clientId：不得再执行
      await sleep(400);

      // 错误帧映射：不存在会话 → session.not_found + at-most-once 提示。
      phone.send(JSON.stringify({
        v: 1, type: "session.command", sessionId: "no-such-session", clientId: "cid-relay-0002", cmd: { cmd: "stop" },
      }));
      const notFound = await stream.until((f) => f.type === "error", 5000).then((frames) => frames[frames.length - 1]);
      expect(notFound.code).toBe("session.not_found");
      expect(notFound.message).toMatch(/at-most-once/);
      phone.close();
    } finally {
      await app.close();
      await relay.stop();
    }

    // 假 CLI 实际收到的 interrupt 恰一次（幂等去重经 relay 链生效）。
    const stdinLog = readFileSync(join(workDir, "stdin.log"), "utf8");
    expect(stdinLog.split("\n").filter((l) => l.includes('"subtype":"interrupt"'))).toHaveLength(1);
  }, 60_000);

  it("case② 错 token：拨入被 relay 401 拒——无连接产生（手机发 hello 得不到任何应答）", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-e2e-relay-bad-"));
    cleanups.push(root);
    const dataDir = join(root, "data");
    const relay = new FakeRelay(SERVER_TOKEN); // relay 只认 SERVER_TOKEN，app 携带错 token
    const relayPort = await relay.start();
    const app = new Application({
      port: 0,
      dataDir,
      logDir: join(root, "logs"),
      logLevel: "ERROR",
      watchdogMs: 600_000, serverVersion: "0.1.0",
      relay: { url: `ws://127.0.0.1:${relayPort}/server`, serverToken: "st-wrong-token" },
    });
    try {
      await app.start();
      // 拨入在升级层被拒至少一次（HTTP 401——dial 侧表现为失败，重拨循环持续）。
      await vi.waitFor(() => {
        expect(relay.rejected).toBeGreaterThanOrEqual(1);
      }, { timeout: 10_000, interval: 50 });
      // 无连接产生：手机连 /phone 发 hello，等不到 welcome（relay 侧无 server 端可转发）。
      const phone = new WebSocket(`ws://127.0.0.1:${relayPort}/phone`);
      const stream = new MsgStream(phone);
      await opened(phone);
      phone.send(JSON.stringify({ v: 1, type: "hello", token: "whatever-token", resume: null }));
      await expect(stream.next(800)).rejects.toThrow(/等待帧超时/);
      phone.close();
    } finally {
      await app.close();
      await relay.stop();
    }
  }, 30_000);

  it("case③ 重拨恢复：relay 未上线时按退避持续拨入（失败可见），上线后建立连接恢复服务", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-e2e-relay-redial-"));
    cleanups.push(root);
    const dataDir = join(root, "data");
    const logDir = join(root, "logs");
    // 先占号再释放：app 启动时 relay 未监听（dial 失败序列），fake relay 稍后监听同一端口。
    const reserved = await reservePort();
    const app = new Application({
      port: 0,
      dataDir,
      logDir,
      logLevel: "INFO", // INFO 才落 warn 行——重拨失败经日志可见（观测面）
      watchdogMs: 600_000, serverVersion: "0.1.0",
      relay: { url: `ws://127.0.0.1:${reserved}/server`, serverToken: SERVER_TOKEN },
    });
    await app.start();
    try {
      // relay 未上线：重拨循环在跑（至少两次失败日志），且始终无 /server 连接。
      await vi.waitFor(() => {
        expect(countLogMatches(logDir, /relay dial failed/g)).toBeGreaterThanOrEqual(2);
      }, { timeout: 10_000, interval: 100 });

      // relay 上线（真实起停）：下一个重拨窗口建立连接。
      const relay = new FakeRelay(SERVER_TOKEN);
      await relay.start(reserved);
      try {
        await vi.waitFor(() => {
          expect(relay.serverConnected).toBe(1);
        }, { timeout: 10_000, interval: 50 });

        // 服务恢复：手机经 /phone 全链 hello→welcome→ping→pong（哑管道双向通）。
        const token = (await new ConfigProvisioner(new MemoryDeviceRepository(), join(dataDir, "lan-token.txt")).ensureLanToken()).token;
        const phone = new WebSocket(`ws://127.0.0.1:${reserved}/phone`);
        const stream = new MsgStream(phone);
        await opened(phone);
        phone.send(JSON.stringify({ v: 1, type: "hello", token, resume: null }));
        const welcome = await stream.next();
        expect(welcome.type).toBe("welcome");
        phone.send(JSON.stringify({ v: 1, type: "ping", nonce: 42 }));
        const pong = await stream.next();
        expect(pong).toEqual({ v: 1, type: "pong", nonce: 42 });
        phone.close();
      } finally {
        await relay.stop();
      }
    } finally {
      await app.close();
    }
  }, 40_000);
});
