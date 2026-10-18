import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Application, REVOKE_SWEEP_MS } from "../src/app/application.js";
import type { ServerConfig } from "../src/app/config.js";
import { openMigrated } from "../src/persistence/sqlite/migrate.js";
import { SqliteDeviceRepository } from "../src/persistence/sqlite/sqliteRepositories.js";

/**
 * 一轮对话的回放样本（与 e2e_replay 同形）：每轮落 6 个 seq
 * （starting / running / text_delta / usage / finished / exit——末位来自假 CLI 自终止）。
 */
const TURN =
  JSON.stringify({ type: "system", subtype: "init", session_id: "cls-e2e-lock", model: "claude-e2e", cwd: "D:\\w" }) + "\n" +
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi!" } }, session_id: "cls-e2e-lock" }) + "\n" +
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

/** ws 关闭事件。 */
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
  const dir = mkdtempSync(join(tmpdir(), "aimi-lock-bin-"));
  cleanups.push(dir);
  writeFileSync(join(dir, "turn.jsonl"), TURN, "utf8");
  writeFileSync(join(dir, "fake-claude.mjs"), FAKE_SCRIPT, "utf8");
  writeFileSync(join(dir, "claude.cmd"), '@echo off\r\n"' + process.execPath + '" "%~dp0fake-claude.mjs" %*\r\n');
  return dir;
}

/** 建应用并取 LAN 令牌（app.start 已经 provisioner 建好令牌文件与设备行）。 */
async function startedApp(root: string): Promise<{ app: Application; port: number; dataDir: string; workDir: string; token: string }> {
  const dataDir = join(root, "data");
  const workDir = join(root, "work");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  const app = new Application({
    port: 0, dataDir, logDir: join(root, "logs"), logLevel: "ERROR", serverVersion: "0.1.0",
  });
  const { port } = await app.start();
  const token = readFileSync(join(dataDir, "lan-token.txt"), "utf8").trim();
  return { app, port, dataDir, workDir, token };
}

/** 跨进程旁路：按令牌哈希从库里取真实 deviceId（M0 provisioner 的设备行）。 */
async function deviceIdByToken(dataDir: string, token: string): Promise<string> {
  const db: Database.Database = openMigrated(join(dataDir, "aimi.db"));
  try {
    const found = await new SqliteDeviceRepository(db).findByTokenHash(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(found).not.toBeNull();
    return found!.id;
  } finally {
    db.close();
  }
}

/**
 * 平台卫语句（C3：server 仅 Windows；假 `.cmd` 垫片 + PATH 分号语义）。非 Windows 整块跳过。
 * 单设备锁（core-loop §5.4）：同 token 至多一条活连接，后登者生效。
 */
describe.skipIf(process.platform !== "win32")("Task 6 e2e：单设备锁与吊销即时断连", () => {
  it("互踢：两 ws 同 token → 先者收 bye{taken_over} 断开，事件只达后者", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-e2e-lock-"));
    cleanups.push(root);
    vi.stubEnv("PATH", fakeClaudeDir() + ";" + (process.env.PATH ?? ""));
    const { app, port, workDir, token } = await startedApp(root);
    try {
      // 先者上线。
      const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
      const s1 = new MsgStream(ws1);
      await opened(ws1);
      ws1.send(JSON.stringify({ v: 1, type: "hello", token, resume: null }));
      expect((await s1.next()).type).toBe("welcome");

      // 后者上线 → 先者被接管（后登者生效）。
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
      const s2 = new MsgStream(ws2);
      await opened(ws2);
      ws2.send(JSON.stringify({ v: 1, type: "hello", token, resume: null }));
      expect((await s2.next()).type).toBe("welcome");
      expect(await s1.next()).toEqual({ v: 1, type: "bye", reason: "taken_over" });
      await closed(ws1);
      // 先者归寂后不再有任何帧（被摘出广播集合；残余帧按已断处理）。
      await expect(s1.next(500)).rejects.toThrow("等待帧超时");

      // 后者建会话跑两轮：全部事件只达后者（第一轮 create + 第二轮 command 续跑）。
      ws2.send(JSON.stringify({
        v: 1, type: "session.create",
        spec: { agentId: "claude", cwd: workDir, permissionMode: "default", initialPrompt: "hi" },
      }));
      const ackFrames = await s2.until((f) => f.type === "ack", 15000);
      const sid = ackFrames[ackFrames.length - 1].sessionId;
      await s2.until(
        (f) => f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "exit",
        15000,
      );
      // 第二回合走 `restart`（终态句柄在 → dispose 后带 hint 重挂——既定路径）：事件依然只达后者。
      // why 不用 `send` 续跑：假 CLI 500ms 自终止后句柄进程已死，路 1 对死 stdin 静默丢弃是
      // 现行设计口径（pid 探活归 Task 8），续接场景由 e2e_session_resume 的跨进程重启覆盖。
      ws2.send(JSON.stringify({
        v: 1, type: "session.command", sessionId: sid, clientId: "cid-lock-0001", cmd: { cmd: "restart" },
      }));
      const round2 = await s2.until(
        (f) => f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "exit",
        15000,
      );
      expect(round2.every((f) => f.type === "session.event")).toBe(true);
      ws2.close();
    } finally {
      await app.close();
    }
    await sleep(600); // 假 CLI 的 500ms 自退窗口过后句柄才释放（M0 惯例）
  }, 60_000);

  it("吊销：库内直接 revoke → 活连接 ≤" + (REVOKE_SWEEP_MS + 500) + "ms 收 bye{revoked}；旧 token 再 hello 被拒", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-e2e-revoked-"));
    cleanups.push(root);
    const { app, port, dataDir, token } = await startedApp(root);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const s = new MsgStream(ws);
      await opened(ws);
      ws.send(JSON.stringify({ v: 1, type: "hello", token, resume: null }));
      expect((await s.next()).type).toBe("welcome");

      // 跨进程旁路：直接库内吊销（CLI revoke 的核心动作；服务进程此刻毫不知情）。
      const deviceId = await deviceIdByToken(dataDir, token);
      const db: Database.Database = openMigrated(join(dataDir, "aimi.db"));
      try {
        await new SqliteDeviceRepository(db).revoke(deviceId);
      } finally {
        db.close();
      }

      // 吊销巡检周期 REVOKE_SWEEP_MS（3s）→ 上界一个周期 + 余量内必须踢线。
      const bye = await s.next(REVOKE_SWEEP_MS + 500);
      expect(bye).toEqual({ v: 1, type: "bye", reason: "revoked" });
      await closed(ws);

      // 吊销后旧 token 再 hello：verifyToken 拒（M0 语义——对新连接立即生效）。
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
      const s2 = new MsgStream(ws2);
      await opened(ws2);
      ws2.send(JSON.stringify({ v: 1, type: "hello", token, resume: null }));
      expect((await s2.next()).code).toBe("auth.invalid_token");
      await closed(ws2);
    } finally {
      await app.close();
    }
  }, 30_000);
});
