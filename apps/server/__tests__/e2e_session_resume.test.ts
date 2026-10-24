import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Application } from "../src/app/application.js";
import { ConfigProvisioner } from "../src/auth/configProvisioner.js";
import { MemoryDeviceRepository } from "../src/persistence/memory/index.js";

import type { ServerConfig } from "../src/app/config.js";

/** 续接目标 agent 侧会话 id（SPIKE FACT3：`--resume` 后同 id 回放，服务端以它作续接线索）。 */
const R_SESSION = "cls-e2e-r1";

/** 续接回合回放样本：每 user 帧同步全文重放——首行 `system/init` 保住协议握手与同 id 口径。 */
const RESUME_TURN =
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

/** 删除临时目录：子进程异步退出，句柄释放有时间窗——重试规避 Windows EBUSY/EPERM 抖动。 */
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

/** 直接数台账行数：跨两个 Application 进程的生命周期，唯一见证只有这张表。 */
function ledgerCount(dataDir: string): number {
  const db = new Database(join(dataDir, "aimi.db"));
  try {
    return (db.prepare("SELECT COUNT(*) AS c FROM session_processes").get() as { c: number }).c;
  } finally {
    db.close();
  }
}

/**
 * 造假 CLI 目录：写回放样本与共享假 CLI（`AIMI_FAKE_CLI_PATH` 注入目标；
 * 续接回合的 `--resume` 经 SDK argv 直达假 CLI——EXPECT_RESUME 校验的数据源）。
 *
 * @returns 该临时目录的绝对路径；登记进清理表由 afterEach 删除
 */
function fakeClaudeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aimi-resume-bin-"));
  cleanups.push(dir);
  writeFakeCli(dir, { "resume-turn.jsonl": RESUME_TURN });
  vi.stubEnv("AIMI_FAKE_CLI_PATH", join(dir, "fake-cli.mjs"));
  vi.stubEnv("AIMI_FAKE_TURN", "resume-turn.jsonl");
  return dir;
}

/**
 * 平台卫语句（C3：server 仅 Windows；假 `.cmd` 垫片 + PATH 分号语义）。非 Windows 整块跳过。
 */
describe.skipIf(process.platform !== "win32")("Task 4 e2e：会话续接（双 Application + 台账滞留清点）", () => {
  it("落库带 hint 重启 → welcome resumable → send 续接 --resume 拉起 → 同进程零冷启动再回合", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-e2e-resume-"));
    cleanups.push(root);
    const dataDir = join(root, "data");
    const workDir = join(root, "work");
    mkdirSync(workDir, { recursive: true });
    fakeClaudeDir(); // 注入 AIMI_FAKE_CLI_PATH
    // 假 CLI 的 args 日志显式进临时工作目录（探测进程无 cwd，缺省会写 vitest 工作目录）。
    vi.stubEnv("AIMI_ARGS_LOG", join(workDir, "args.log"));

    const cfg: ServerConfig = {
      port: 0, dataDir, logDir: join(root, "logs"), logLevel: "ERROR", watchdogMs: 600_000, serverVersion: "0.1.0",
    };

    // ===== 进程 A：全新会话跑完一回合（finished），落库 hint 与台账 pid，随后关停 =====
    const app1 = new Application(cfg);
    const { port: port1 } = await app1.start();
    const token = (await new ConfigProvisioner(new MemoryDeviceRepository(), join(dataDir, "lan-token.txt")).ensureLanToken()).token;

    const ws1 = new WebSocket(`ws://127.0.0.1:${port1}`);
    const s1 = new MsgStream(ws1);
    await opened(ws1);
    ws1.send(JSON.stringify({ v: 1, type: "hello", token, resume: null }));
    const welcome1 = await s1.next();
    expect(welcome1.type).toBe("welcome");
    expect(welcome1.sessions).toEqual([]); // 全新库

    ws1.send(JSON.stringify({
      v: 1, type: "session.create",
      spec: { agentId: "claude", cwd: workDir, permissionMode: "default", initialPrompt: "hi" },
    }));
    // M0 口径（e2e_lan_stream 的 untilAck）：starting(seq0) 先于 ack 广播——create 在 start 成功后
    // 才回 ack，`until(ack)` 已把它收进 ackFrames，seq 全序必须含 ack 前到达者。
    const ackFrames = await s1.until((f) => f.type === "ack", 15000);
    const sid: string = ackFrames[ackFrames.length - 1].sessionId;
    const turn1 = await s1.until(
      (f) => f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "state" && f.agentEvent.state === "finished",
      15000,
    );
    // seq 0..4 恰好：starting / running / text_delta / usage / finished——续接起点由它接续。
    const seqs1 = [...ackFrames, ...turn1]
      .filter((f) => f.type === "session.event" && f.sessionId === sid)
      .map((f) => f.seq as number);
    expect(seqs1).toEqual([0, 1, 2, 3, 4, 5]);
    ws1.close();

    // 运行时采集：SDK 不暴露子进程 pid——台账无行可登记（降级口径，孤儿回收兜底靠 resume 语义）；
    // 续接线索的持久化由 welcome 的 resumable 断言覆盖。
    expect(ledgerCount(dataDir)).toBe(0);

    await app1.close();

    // 续接校验圈（只对开启后的新进程生效——create 进程从此不受 exit(3) 影响）。
    vi.stubEnv("AIMI_FAKE_EXPECT_RESUME", R_SESSION);

    // ===== 进程 B：同 dataDir 新 Application——reaper 清点滞留行、adopt 带线索认领 resumable =====
    const app2 = new Application(cfg);
    const { port: port2 } = await app2.start();
    expect(ledgerCount(dataDir)).toBe(0); // 滞留行被清点（命中即杀或查无弃杀，两态之下都清——不重访）

    const ws2 = new WebSocket(`ws://127.0.0.1:${port2}`);
    const s2 = new MsgStream(ws2);
    await opened(ws2);
    ws2.send(JSON.stringify({ v: 1, type: "hello", token, resume: null }));
    const welcome2 = await s2.next();
    expect(welcome2.type).toBe("welcome");
    expect(welcome2.sessions.map((x: any) => x.id)).toEqual([sid]);
    expect(welcome2.sessions[0].resumable).toBe(true);       // resume_hint 有 → 续接入口渲染给手机

    // send 续接：死句柄 + resumable + hint → starting(服务端事实) → --resume 拉起 → 交付
    ws2.send(JSON.stringify({
      v: 1, type: "session.command", sessionId: sid, clientId: "cid-resume-0001", cmd: { cmd: "send", text: "resume!" },
    }));
    const turn2 = await s2.until(
      (f) => f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "state" && f.agentEvent.state === "finished",
      15000,
    );
    const resumed = turn2.filter((f) => f.type === "session.event" && f.sessionId === sid);
    const kinds = resumed.map((f) => f.agentEvent.type === "state" ? `state:${f.agentEvent.state}` : f.agentEvent.type);
    // 同连接 seq 全序（评审点1口径）：到达序必须等于 seq 序。
    const seqs2 = resumed.map((f) => f.seq as number);
    expect(seqs2).toEqual([...seqs2].sort((a, b) => a - b));
    expect(kinds[0]).toBe("state:starting");                 // 服务端事实先行（首帧）
    // seq 接续上一进程遗留的 lastSeq+1（残流 exit 及时到达与否都不影响相对连续性——无撞车）。
    expect(resumed[0].seq).toBe(welcome2.sessions[0].lastSeq + 1);
    expect(kinds).toEqual(["state:starting", "state:running", "configured", "text_delta", "usage", "state:finished"]); // 流式增量全链在位（configured=新句柄首 init 的实测模型）

    ws2.send(JSON.stringify({
      v: 1, type: "session.command", sessionId: sid, clientId: "cid-resume-0002", cmd: { cmd: "send", text: "again" },
    }));
    const turn3 = await s2.until(
      (f) => f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "state" && f.agentEvent.state === "finished",
      15000,
    );
    ws2.close();

    // 零冷启动：第二回合同进程交付（args.log 停在 2 行不增新行）。
    // 2 行 = A create 裸拉起 → B 经 --resume 续接（校验圈否则早已 exit 3）；
    // 探测行已不存在——SDK 时代 isInstalled 探测的是随包 CLI，不经假 CLI。
    const argsLog = readFileSync(join(workDir, "args.log"), "utf8").trim().split("\n");
    expect(argsLog).toHaveLength(2);
    expect(argsLog[0]).not.toContain("--resume");            // 首拉起无线索
    expect(argsLog[1]).toContain(`--resume=${R_SESSION}`);   // 续接生效（SDK 等号连写形式）
    const stdinLog = readFileSync(join(workDir, "stdin.log"), "utf8");
    expect(stdinLog).toContain('"text":"hi"');
    expect(stdinLog).toContain('"text":"resume!"');
    expect(stdinLog).toContain('"text":"again"');
    expect(turn3[turn3.length - 1].seq).toBeGreaterThan(resumed[resumed.length - 1].seq); // seq 继续单调

    await app2.close();
    // app.close 对自然终态句柄不回收（stop 幂等 no-op——M0 语义）：假 CLI 的 500ms 自退窗口
    // 过后文件句柄才释放，先等它退净再交 afterEach 清理，避免 Windows EBUSY/EPERM 抖动放大成用例红。
    await sleep(600);
  }, 45_000);
});
