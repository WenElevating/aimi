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

/**
 * 续接回放假 CLI（M0 基线脚本的多回合变体，契约与被测实现零耦合）：
 * - `claude --version` 探测即刻 exit(0)（否则 isInstalled 挂等拉黑建会话——e2e 元命令不算回合）；
 * - 启动即把 `argv` 拼成**恰好一行**追加到 args 日志（每进程 1 行——进程数即冷启动数）；
 *   日志路径取 `AIMI_ARGS_LOG`：探测进程由 `isInstalled()` 无 cwd 拉起、其 `process.cwd()` 是
 *   vitest 工作目录，落 repo 会污染工作树，故必须显式重定向进临时工作目录；
 * - 设了 `AIMI_FAKE_EXPECT_RESUME` 时校验 argv 含 `--resume <期望值>`，否则 exit(3)
 *   （`--resume` 未生效即失败——续接面退化为无痕新会话时测试必红）；
 * - 收到的每个 user 帧同步**全文重放** resume-turn.jsonl（含 init——同进程新回合 CLI 会重发 init 的
 *   FACT1 口径），随后布 500ms 静默退出 timer；新 user 帧先清旧 timer（陈旧沉默不折断会话）；
 * - stdin EOF 或静默 500ms 后进程退出，测试不留孤儿。
 */
const RESUME_FAKE_SCRIPT = [
  'import { appendFileSync, readFileSync } from "node:fs";',
  'import { dirname, join } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  "",
  "const here = dirname(fileURLToPath(import.meta.url));",
  'const lines = readFileSync(join(here, "resume-turn.jsonl"), "utf8").split(/\\r?\\n/).filter((l) => l !== "");',
  'appendFileSync(process.env.AIMI_ARGS_LOG ?? join(process.cwd(), "args.log"), process.argv.slice(2).join(" ") + "\\n");',
  "if (process.argv.includes(\"--version\")) process.exit(0);",
  "const expected = process.env.AIMI_FAKE_EXPECT_RESUME;",
  "if (expected !== undefined) {",
  '  const i = process.argv.indexOf("--resume");',
  "  if (i === -1 || process.argv[i + 1] !== expected) process.exit(3);",
  "}",
  'process.stdin.setEncoding("utf8");',
  'let buf = "";',
  "let exitTimer = null;",
  'process.stdin.on("data", (chunk) => {',
  "  buf += chunk;",
  '  const parts = buf.split("\\n");',
  "  buf = parts.pop();",
  "  for (const part of parts) {",
  '    const line = part.replace(/\\r$/, "");',
  '    if (line === "") continue;',
  '    appendFileSync(join(process.cwd(), "stdin.log"), line + "\\n");',
  "    if (exitTimer !== null) { clearTimeout(exitTimer); exitTimer = null; }",
  "    for (const row of lines) process.stdout.write(row + \"\\n\");",
  "    exitTimer = setTimeout(() => process.exit(0), 500);",
  "  }",
  "});",
  'process.stdin.on("end", () => process.exit(0));',
].join("\n");

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
 * 造假 CLI 目录：写回放样本、脚本与 `claude.cmd` 垫片（PATH 解析目标）。
 *
 * @returns 该临时目录的绝对路径；登记进清理表由 afterEach 删除
 */
function fakeClaudeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aimi-resume-bin-"));
  cleanups.push(dir);
  writeFileSync(join(dir, "resume-turn.jsonl"), RESUME_TURN, "utf8");
  writeFileSync(join(dir, "fake-claude.mjs"), RESUME_FAKE_SCRIPT, "utf8");
  // 生产同构：Windows 下 `claude` 经 `shell:true` 由 cmd.exe 按 PATH+PATHEXT 解析到 `.cmd` 垫片；
  // 末尾 `%*` 全量转发参数——isInstalled 的 `--version` 与续接回合的 `--resume` 都必须到达假 CLI。
  writeFileSync(join(dir, "claude.cmd"), '@echo off\r\n"' + process.execPath + '" "%~dp0fake-claude.mjs" %*\r\n');
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
    const binDir = fakeClaudeDir();
    vi.stubEnv("PATH", binDir + ";" + (process.env.PATH ?? ""));
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
    expect(seqs1).toEqual([0, 1, 2, 3, 4]);
    ws1.close();

    // 运行时采集已落账：台账 pid 行滞留（close 对自然终态句柄不回收——这正是 reaper 的存在理由）。
    expect(ledgerCount(dataDir)).toBeGreaterThanOrEqual(1);

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
    expect(kinds).toEqual(["state:starting", "state:running", "text_delta", "usage", "state:finished"]); // 流式增量全链在位

    ws2.send(JSON.stringify({
      v: 1, type: "session.command", sessionId: sid, clientId: "cid-resume-0002", cmd: { cmd: "send", text: "again" },
    }));
    const turn3 = await s2.until(
      (f) => f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "state" && f.agentEvent.state === "finished",
      15000,
    );
    ws2.close();

    // 零冷启动：第二回合同进程交付（args.log 停在 3 行不增新行）。
    // 3 行 = A 探测（--version）→ A create 裸拉起 → B 经 --resume 续接（校验圈否则早已 exit 3）。
    const argsLog = readFileSync(join(workDir, "args.log"), "utf8").trim().split("\n");
    expect(argsLog).toHaveLength(3);
    expect(argsLog[0]).not.toContain("--resume");            // 探测与首拉起皆无线索
    expect(argsLog[1]).not.toContain("--resume");
    expect(argsLog[2]).toMatch(new RegExp(`--resume\\s+${R_SESSION.replace(/[-]/g, "\\$&")}`)); // 续接生效
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
