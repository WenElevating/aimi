import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Application } from "../src/app/application.js";
import type { ServerConfig } from "../src/app/config.js";
import { openMigrated } from "../src/persistence/sqlite/migrate.js";
import { SqliteDeviceRepository } from "../src/persistence/sqlite/sqliteRepositories.js";

/**
 * 一轮对话的回放样本（与 e2e_replay 同形）：首行 system/init 保协议握手，
 * 随后 text_delta 与 result（→ usage + finished）。配对全链要走到 session.create 与事件流。
 */
const TURN =
  JSON.stringify({ type: "system", subtype: "init", session_id: "cls-e2e-pair", model: "claude-e2e", cwd: "D:\\w" }) + "\n" +
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi!" } }, session_id: "cls-e2e-pair" }) + "\n" +
  JSON.stringify({ type: "result", subtype: "success", result: "done", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, duration_ms: 1 }) + "\n";

/** 假 CLI 脚本：每 user 帧同步全文重放一轮，回放后 500ms 自终止（M0 地基形态）。 */
const FAKE_SCRIPT = [
  'import { readFileSync } from "node:fs";',
  'import { dirname, join } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  "",
  "const here = dirname(fileURLToPath(import.meta.url));",
  'const lines = readFileSync(join(here, "turn.jsonl"), "utf8").split(/\\r?\\n/).filter((l) => l !== "");',
  "if (process.argv.includes(\"--version\")) process.exit(0);",
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
  "    if (exitTimer !== null) { clearTimeout(exitTimer); exitTimer = null; }",
  '    for (const row of lines) process.stdout.write(row + "\\n");',
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

/** ws 关闭事件（服务端拒绝路径的归寂判定）。 */
function closed(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve) => { ws.once("close", () => resolve()); });
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

/** 造假 CLI 目录：写回放样本、脚本与 `claude.cmd` 垫片（PATH 解析目标，`%*` 全量转发参数）。 */
function fakeClaudeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aimi-pair-bin-"));
  cleanups.push(dir);
  writeFileSync(join(dir, "turn.jsonl"), TURN, "utf8");
  writeFileSync(join(dir, "fake-claude.mjs"), FAKE_SCRIPT, "utf8");
  writeFileSync(join(dir, "claude.cmd"), '@echo off\r\n"' + process.execPath + '" "%~dp0fake-claude.mjs" %*\r\n');
  return dir;
}

/** 建一套装好假 CLI 的应用；测试以「独立库连接」旁路出码——与应用跨进程共库语义一致。 */
async function startedApp(root: string): Promise<{ app: Application; cfg: ServerConfig; port: number; dataDir: string; workDir: string }> {
  const dataDir = join(root, "data");
  const workDir = join(root, "work");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  const cfg: ServerConfig = { port: 0, dataDir, logDir: join(root, "logs"), logLevel: "ERROR", watchdogMs: 600_000, serverVersion: "0.1.0" };
  const app = new Application(cfg);
  const { port } = await app.start();
  return { app, cfg, port, dataDir, workDir };
}

/** 模拟 `aimi-server pair` CLI：独立连接对同一库签发一次性码（跨进程共库语义）。 */
async function issueViaOtherProcess(dataDir: string): Promise<{ code: string; expiresAt: number }> {
  const db: Database.Database = openMigrated(join(dataDir, "aimi.db")); // WAL 多连接可并发读改
  try {
    return await new SqliteDeviceRepository(db).issuePairingCode();
  } finally {
    db.close();
  }
}

/**
 * 平台卫语句（C3：server 仅 Windows；假 `.cmd` 垫片 + PATH 分号语义）。非 Windows 整块跳过。
 * 配对握手 e2e：模拟 CLI 独立进程出码 → 应用进程消费（review §3.3 跨进程语义）。
 */
describe.skipIf(process.platform !== "win32")("Task 6 e2e：配对（跨进程共库）", () => {
  it("①码配对全流程：hello{code,name}→paired→welcome→session.create 全链，token 可重连", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-e2e-pair-"));
    cleanups.push(root);
    vi.stubEnv("PATH", fakeClaudeDir() + ";" + (process.env.PATH ?? ""));
    const { app, port, dataDir, workDir } = await startedApp(root);
    try {
      const issued = await issueViaOtherProcess(dataDir);
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const s = new MsgStream(ws);
      await opened(ws);
      ws.send(JSON.stringify({ v: 1, type: "hello", pairingCode: issued.code, deviceName: "phone-e2e" }));

      // 直发应答序：paired（明文 token 只此一次）→ welcome（同连接转正）。
      const paired = await s.next();
      expect(paired.type).toBe("paired");
      expect(paired.token.length).toBeGreaterThanOrEqual(8);
      expect(typeof paired.deviceId).toBe("string");
      expect((await s.next()).type).toBe("welcome");

      // 转正后的连接就是普通设备连接：建会话全链（ack → 事件流 → exit）。
      ws.send(JSON.stringify({
        v: 1, type: "session.create",
        spec: { agentId: "claude", cwd: workDir, permissionMode: "default", initialPrompt: "hi" },
      }));
      const ackFrames = await s.until((f) => f.type === "ack", 15000);
      const sid = ackFrames[ackFrames.length - 1].sessionId;
      const events = await s.until(
        (f) => f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "exit",
        15000,
      );
      expect(events.some((f) => f.agentEvent?.type === "text_delta")).toBe(true);
      ws.close();

      // 配对所得 token 已持久化：新连接走 token 变体 hello 照常 welcome。
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
      const s2 = new MsgStream(ws2);
      await opened(ws2);
      ws2.send(JSON.stringify({ v: 1, type: "hello", token: paired.token, resume: null }));
      expect((await s2.next()).type).toBe("welcome");
      ws2.close();

      // 库内设备行：token 哈希入库、名字即 deviceName（跨进程读同一库核对）。
      const db: Database.Database = openMigrated(join(dataDir, "aimi.db"));
      try {
        const row = await new SqliteDeviceRepository(db)
          .findByTokenHash(createHash("sha256").update(paired.token).digest("hex"));
        expect(row).toEqual({ id: paired.deviceId, name: "phone-e2e" });
      } finally {
        db.close();
      }
    } finally {
      await app.close();
    }
    await sleep(600); // 假 CLI 的 500ms 自退窗口过后句柄才释放（M0 惯例）
  }, 60_000);

  it("②过期码 → auth.pairing_expired 且连接被关闭", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-e2e-pairexp-"));
    cleanups.push(root);
    const { app, port, dataDir } = await startedApp(root);
    try {
      // 直灌一条已过期的码（expires_at 早于 now）——签发 5min 前未用。
      const db: Database.Database = openMigrated(join(dataDir, "aimi.db"));
      try {
        db.prepare("INSERT INTO pairing_codes (code, created_at, expires_at, used_at) VALUES (?, ?, ?, NULL)")
          .run("12345678", Date.now() - 60_000, Date.now() - 30_000);
      } finally {
        db.close();
      }

      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const s = new MsgStream(ws);
      await opened(ws);
      ws.send(JSON.stringify({ v: 1, type: "hello", pairingCode: "12345678", deviceName: "phone-e2e" }));
      expect(await s.next()).toEqual({ v: 1, type: "error", code: "auth.pairing_expired", message: "配对码已过期" });
      await closed(ws);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("③已用码 → auth.pairing_failed 且连接被关闭", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-e2e-pairused-"));
    cleanups.push(root);
    const { app, port, dataDir } = await startedApp(root);
    try {
      // 另一进程先核销成功（模拟手机已用它配对）。
      const db: Database.Database = openMigrated(join(dataDir, "aimi.db"));
      let issued: { code: string; expiresAt: number };
      try {
        const devices = new SqliteDeviceRepository(db);
        issued = await devices.issuePairingCode();
        expect(await devices.consumePairingCode(issued.code)).toBe("ok");
      } finally {
        db.close();
      }

      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const s = new MsgStream(ws);
      await opened(ws);
      ws.send(JSON.stringify({ v: 1, type: "hello", pairingCode: issued.code, deviceName: "phone-e2e" }));
      expect(await s.next()).toEqual({ v: 1, type: "error", code: "auth.pairing_failed", message: "配对码已被使用" });
      await closed(ws);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("④错码×8 → 第 9 次即便拿新码也拒（limiter 到线，key=远端主机）", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-e2e-pairlimit-"));
    cleanups.push(root);
    const { app, port, dataDir } = await startedApp(root);
    try {
      // 前 8 次：未签发的错码（unknown → pairing_failed）逐次拒绝并计数。
      for (let i = 0; i < 8; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const s = new MsgStream(ws);
        await opened(ws);
        ws.send(JSON.stringify({ v: 1, type: "hello", pairingCode: "00000000", deviceName: "phone-e2e" }));
        expect((await s.next()).code).toBe("auth.pairing_failed");
        await closed(ws);
      }
      // 第 9 次： fresh 有效码也被拒——限速在核销之前拦下。
      const fresh = await issueViaOtherProcess(dataDir);
      const ws9 = new WebSocket(`ws://127.0.0.1:${port}`);
      const s9 = new MsgStream(ws9);
      await opened(ws9);
      ws9.send(JSON.stringify({ v: 1, type: "hello", pairingCode: fresh.code, deviceName: "phone-e2e" }));
      const err9 = await s9.next();
      expect(err9.code).toBe("auth.pairing_failed");
      expect(err9.message).toContain("尝试过多");
      await closed(ws9);

      // 限速拦截发生在核销之前：fresh 码未被烧掉，仍可核销成功。
      const db: Database.Database = openMigrated(join(dataDir, "aimi.db"));
      try {
        expect(await new SqliteDeviceRepository(db).consumePairingCode(fresh.code)).toBe("ok");
      } finally {
        db.close();
      }
    } finally {
      await app.close();
    }
  }, 30_000);
});
