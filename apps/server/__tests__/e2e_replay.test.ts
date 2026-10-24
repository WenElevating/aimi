import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Application, REPLAY_HARD_CAP } from "../src/app/application.js";
import type { ServerConfig } from "../src/app/config.js";
import { ConfigProvisioner } from "../src/auth/configProvisioner.js";
import { MemoryDeviceRepository } from "../src/persistence/memory/index.js";
import { openMigrated } from "../src/persistence/sqlite/migrate.js";
import { SqliteConversationRepository } from "../src/persistence/sqlite/sqliteConversationRepository.js";
import { SqliteDeviceRepository } from "../src/persistence/sqlite/sqliteRepositories.js";

/** 续接目标 agent 侧会话 id（与回放样本首行 init 的 session_id 同源）。 */
const R_SESSION = "cls-e2e-replay";

/** 超限用例的会话 id（进程内直灌种子，不经 CLI）。 */
const CAP_SESSION = "s-replay-cap";

/**
 * 一轮对话的回放样本：首行 `system/init` 保协议握手与同 id 口径（SPIKE FACT1/FACT3），
 * 随后 text_delta 与 result（→ usage + finished）。每个 user 帧全文重放一份——
 * 每轮在事件流里落 6 个 seq：starting / running / text_delta / usage / finished / exit
 * （末位 exit 来自假 CLI 的自终止，见下）。
 */
const GAP_TURN =
  JSON.stringify({ type: "system", subtype: "init", session_id: R_SESSION, model: "claude-e2e", cwd: "D:\\w" }) + "\n" +
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi!" } }, session_id: R_SESSION }) + "\n" +
  JSON.stringify({ type: "result", subtype: "success", result: "done", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, duration_ms: 1 }) + "\n";

/** 假 claude 经 `AIMI_FAKE_CLI_PATH` 注入（共享脚本见 fakeCli.ts）；每 user 帧重放一轮 + EXPECT_RESUME 校验。 */
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

/** 取帧序列里 session.event 的 seq（重放断言的唯一序源）。 */
function seqs(frames: any[]): number[] {
  return frames.filter((f) => f.type === "session.event").map((f) => f.seq as number);
}

/**
 * 造假 CLI 目录：写回放样本与共享假 CLI（`AIMI_FAKE_CLI_PATH` 注入目标）。
 *
 * @returns 该临时目录的绝对路径；登记进清理表由 afterEach 删除
 */
function fakeClaudeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aimi-replay-bin-"));
  cleanups.push(dir);
  writeFakeCli(dir, { "gap-turn.jsonl": GAP_TURN });
  vi.stubEnv("AIMI_FAKE_CLI_PATH", join(dir, "fake-cli.mjs"));
  vi.stubEnv("AIMI_FAKE_TURN", "gap-turn.jsonl");
  return dir;
}

/**
 * 平台卫语句（C3：server 仅 Windows；假 `.cmd` 垫片 + PATH 分号语义）。非 Windows 整块跳过。
 * 缺口重放全链：断开期间的缺口（同会话经会话门续接补上）→ 新连接按光标恰好续传。
 */
describe.skipIf(process.platform !== "win32")("Task 5 e2e：断连缺口重放", () => {
  it("缺口续传：ws1 断开期间的增量恰好补齐（N+1..lastSeq，无重复无丢号）；resume:{} 从 0 全量", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-e2e-replay-"));
    cleanups.push(root);
    const dataDir = join(root, "data");
    const workDir = join(root, "work");
    mkdirSync(workDir, { recursive: true });
    fakeClaudeDir(); // 注入 AIMI_FAKE_CLI_PATH

    const cfg: ServerConfig = {
      port: 0, dataDir, logDir: join(root, "logs"), logLevel: "ERROR", watchdogMs: 600_000, serverVersion: "0.1.0",
    };

    // ===== 进程 A：全新会话跑完一回合（finished + CLI 自终止的 exit），记手机光标 =====
    const app1 = new Application(cfg);
    const { port: port1 } = await app1.start();
    const token = (await new ConfigProvisioner(new MemoryDeviceRepository(), join(dataDir, "lan-token.txt")).ensureLanToken()).token;

    // 每轮 7 个 seq：starting / running / configured（每进程首轮 init 的实测模型）/ text_delta /
    // usage / finished / exit（exit 来自 CLI 自终止）——两轮各起一个新句柄，各自首 init 都发一条 configured。
    const ROUND_SEQS = 7;
    const cursor = ROUND_SEQS - 1;        // 6：第一轮最大 seq（手机断线前见到的最后一条）
    const lastSeq = cursor + ROUND_SEQS;  // 13：第二轮（缺口轮）的最大 seq
    let sid: string;
    try {
      const ws1 = new WebSocket(`ws://127.0.0.1:${port1}`);
      const s1 = new MsgStream(ws1);
      await opened(ws1);
      ws1.send(JSON.stringify({ v: 1, type: "hello", token, resume: null })); // M0 形态：不触发重放
      const welcome1 = await s1.next();
      expect(welcome1.type).toBe("welcome");
      expect(welcome1.sessions).toEqual([]);

      ws1.send(JSON.stringify({
        v: 1, type: "session.create",
        spec: { agentId: "claude", cwd: workDir, permissionMode: "default", initialPrompt: "hi" },
      }));
      const ackFrames = await s1.until((f) => f.type === "ack", 15000);
      sid = ackFrames[ackFrames.length - 1].sessionId;
      // 等到 exit（假 CLI 自终止）才断开：光标定格在"手机确实见过的最大 seq"。
      await s1.until(
        (f) => f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "exit",
        15000,
      );
      ws1.close();
    } finally {
      await app1.close();
    }

    // ===== 进程 B（同 dataDir）：ws1 缺席期间，第二个连接经会话门续接同会话再跑一回合 =====
    // resume 校验圈只对开启后的新进程生效——首轮拉起不受 exit(3) 影响。
    vi.stubEnv("AIMI_FAKE_EXPECT_RESUME", R_SESSION);
    const app2 = new Application(cfg);
    const { port: port2 } = await app2.start();
    try {
      const ws1b = new WebSocket(`ws://127.0.0.1:${port2}`);
      const s1b = new MsgStream(ws1b);
      await opened(ws1b);
      ws1b.send(JSON.stringify({ v: 1, type: "hello", token, resume: null }));
      await s1b.next(); // welcome

      // 死句柄 + resumable + hint → send 即续接（--resume 拉起）→ 第二轮 6 个 seq 接续。
      ws1b.send(JSON.stringify({
        v: 1, type: "session.command", sessionId: sid, clientId: "cid-replay-0001", cmd: { cmd: "send", text: "round-2" },
      }));
      const turn2 = await s1b.until(
        (f) => f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "exit",
        15000,
      );
      expect(turn2[turn2.length - 1].seq).toBe(lastSeq); // 缺口轮终点 = 6 + 7
      ws1b.close();

      // ===== ws2 携光标重连：settle 后的快照读必须把缺口恰好补齐 =====
      const ws2 = new WebSocket(`ws://127.0.0.1:${port2}`);
      const s2 = new MsgStream(ws2);
      await opened(ws2);
      ws2.send(JSON.stringify({ v: 1, type: "hello", token, resume: { [sid]: cursor } }));
      const welcome2 = await s2.next();
      expect(welcome2.type).toBe("welcome");
      const gapFrames: any[] = [];
      for (let i = cursor + 1; i <= lastSeq; i++) gapFrames.push(await s2.next(5000)); // 缺口 = 6..11
      // 归寂判定：重放恰好缺口条数后不得再多一条（多即重复，少即丢号——序断言在下方合查）。
      await expect(s2.next(500)).rejects.toThrow("等待帧超时");
      expect(seqs(gapFrames)).toEqual([7, 8, 9, 10, 11, 12, 13]);
      expect(gapFrames.every((f) => f.sessionId === sid)).toBe(true);
      ws2.close();

      // ===== 全量拉：resume 不含该会话光标（{}）= 从 seq 0 全量，每条恰一次 =====
      const ws3 = new WebSocket(`ws://127.0.0.1:${port2}`);
      const s3 = new MsgStream(ws3);
      await opened(ws3);
      ws3.send(JSON.stringify({ v: 1, type: "hello", token, resume: {} }));
      const welcome3 = await s3.next();
      expect(welcome3.type).toBe("welcome");
      const allFrames: any[] = [];
      for (let i = 0; i <= lastSeq; i++) allFrames.push(await s3.next(5000));
      await expect(s3.next(500)).rejects.toThrow("等待帧超时");
      expect(seqs(allFrames)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]); // 无重复无丢号
      ws3.close();
    } finally {
      await app2.close();
    }
    // 假 CLI 的 500ms 自退窗口过后句柄才释放，先等它退净再交 afterEach 清理（M0 惯例）。
    await sleep(600);
  }, 60_000);
});

/**
 * 超限降级（跨平台——种子直灌，不经 CLI）：待重放条数超过 REPLAY_HARD_CAP 时逐帧未发，
 * 只落一条 warn notice；标记按设备记账（meta_kv `replay_capped:<sid>:<deviceId>`）——
 * 同设备后续重连静默（warn 已随首次连接实时送达；重复提示既无限堆积历史、又永不重放，
 * 直发又无不与后续真事件冲突的 seq 可用——评审 S2）。
 */
describe("Task 5 e2e：重放超限降级（meta_kv 按设备一次性标记）", () => {
  it("首次重连 warn 恰一条 + 逐帧未发；同设备二次重连静默；另一设备首次仍 warn", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-e2e-cap-"));
    cleanups.push(root);
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });

    // 种子：会话行（首事件 seq 0）+ 直灌 seq 1..REPLAY_HARD_CAP → 待重放共 10_001 条（> 上限）。
    const db: Database.Database = openMigrated(join(dataDir, "aimi.db"));
    const conv = new SqliteConversationRepository(db);
    await conv.createSession(
      { id: CAP_SESSION, agentId: "claude", cwd: "D:\\w", permissionMode: "default" },
      { type: "state", state: "starting" },
    );
    // 测试种子直灌（单事务 prepared 循环，绕过仓储仅限测试）：逐条 await appendEvent 在
    // Windows 下每行一事务、可达数十秒，超出测试预算；行形态与仓储写入逐字同构。
    const insert = db.prepare("INSERT INTO events (session_id, seq, ts, payload) VALUES (?, ?, ?, ?)");
    db.transaction(() => {
      for (let seq = 1; seq <= REPLAY_HARD_CAP; seq++) {
        insert.run(CAP_SESSION, seq, Date.now(), JSON.stringify({ type: "text_delta", text: "s" + seq }));
      }
    })();
    await conv.updateSession(CAP_SESSION, { lastSeq: REPLAY_HARD_CAP });
    db.close();

    const app = new Application({
      port: 0, dataDir, logDir: join(root, "logs"), logLevel: "ERROR", watchdogMs: 600_000, serverVersion: "0.1.0",
    });
    const { port } = await app.start();
    try {
      const token = (await new ConfigProvisioner(new MemoryDeviceRepository(), join(dataDir, "lan-token.txt")).ensureLanToken()).token;

      // 第一次重连：resume {}（光标缺该会话 = 全量口径）→ 计数超限 → warn 恰一条、逐帧未发。
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
      const s2 = new MsgStream(ws2);
      await opened(ws2);
      ws2.send(JSON.stringify({ v: 1, type: "hello", token, resume: {} }));
      expect((await s2.next()).type).toBe("welcome");
      const warned = await s2.next(5000); // 超限后唯一应收的帧：warn notice（经 bus 持久化+广播）
      expect(warned.type).toBe("session.event");
      expect(warned.sessionId).toBe(CAP_SESSION);
      expect(warned.agentEvent).toEqual({
        type: "notice", severity: "warn", text: `重放过大（${REPLAY_HARD_CAP + 1} 条），该段历史不可读`,
      });
      // 逐帧未发：notice 之后归于寂静（10_000 条种子一条都没补发）。
      await expect(s2.next(500)).rejects.toThrow("等待帧超时");
      ws2.close();

      // 第二次重连：同一设备标记已在 → 静默（评审 S2：不 warn 不 info——warn 已实时送达过该设备）。
      const ws3 = new WebSocket(`ws://127.0.0.1:${port}`);
      const s3 = new MsgStream(ws3);
      await opened(ws3);
      ws3.send(JSON.stringify({ v: 1, type: "hello", token, resume: {} }));
      expect((await s3.next()).type).toBe("welcome");
      await expect(s3.next(500)).rejects.toThrow("等待帧超时");
      ws3.close();

      // 另一设备首次重连：标记按设备记账 → 该设备仍得一条 warn（每设备恰一次）。
      const tokenB = randomBytes(32).toString("base64url");
      const db2 = openMigrated(join(dataDir, "aimi.db")); // WAL 多连接：运行中的库可并发读改
      try {
        await new SqliteDeviceRepository(db2).put("phone-b", createHash("sha256").update(tokenB).digest("hex"));
      } finally {
        db2.close();
      }
      const ws4 = new WebSocket(`ws://127.0.0.1:${port}`);
      const s4 = new MsgStream(ws4);
      await opened(ws4);
      ws4.send(JSON.stringify({ v: 1, type: "hello", token: tokenB, resume: {} }));
      expect((await s4.next()).type).toBe("welcome");
      const warnedB = await s4.next(5000);
      expect(warnedB.type).toBe("session.event");
      // 设备 B 的计数比设备 A 多 1：warn#1 自身经 bus 占了一格 seq——逐设备首连各自加一。
      expect(warnedB.agentEvent).toEqual({
        type: "notice", severity: "warn", text: `重放过大（${REPLAY_HARD_CAP + 2} 条），该段历史不可读`,
      });
      await expect(s4.next(500)).rejects.toThrow("等待帧超时");
      ws4.close();
    } finally {
      await app.close();
    }
  }, 30_000);
});
