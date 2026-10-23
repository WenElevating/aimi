import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Application } from "../src/app/application.js";
import { ConfigProvisioner } from "../src/auth/configProvisioner.js";
import { MemoryDeviceRepository } from "../src/persistence/memory/index.js";
import type { ServerConfig } from "../src/app/config.js";

const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** ws 连接的 open 事件（错误一并拒绝）。 */
function opened(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });
}

/** 顺序收帧工具：next 按到达序返回。 */
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
}

/** 组装 Application 并返回 lan token 与端口（不建会话，更新面不需要假 claude）。 */
async function startServer(): Promise<{ app: Application; port: number; token: string; dataDir: string; updatesDir: string }> {
  const root = mkdtempSync(join(tmpdir(), "aimi-e2e-updates-"));
  cleanups.push(root);
  const dataDir = join(root, "data");
  const updatesDir = join(dataDir, "updates");
  const cfg: ServerConfig = {
    port: 0,
    dataDir,
    logDir: join(root, "logs"),
    logLevel: "ERROR",
    watchdogMs: 600_000, serverVersion: "0.1.0",
  };
  const app = new Application(cfg);
  const { port } = await app.start();
  const provision = new ConfigProvisioner(new MemoryDeviceRepository(), join(dataDir, "lan-token.txt"));
  const token = (await provision.ensureLanToken()).token;
  return { app, port, token, dataDir, updatesDir };
}

/** 完成 hello 握手并返回帧流（welcome/update.info 已在流中排队）。 */
async function dial(port: number, token: string): Promise<{ ws: WebSocket; stream: MsgStream }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const stream = new MsgStream(ws);
  await opened(ws);
  ws.send(JSON.stringify({ v: 1, type: "hello", token, resume: null }));
  return { ws, stream };
}

/** 直接落盘一份发布（不经 CLI，专注服务端行为面）。 */
function publishFixture(updatesDir: string, versionCode: number, body: string): void {
  mkdirSync(updatesDir, { recursive: true });
  writeFileSync(join(updatesDir, `app-${versionCode}.apk`), body, "utf8");
  writeFileSync(join(updatesDir, "manifest.json"), JSON.stringify({
    versionName: `1.0.${versionCode}`,
    versionCode,
    size: Buffer.byteLength(body),
    sha256: "b".repeat(64),
    downloadPath: `/updates/app-${versionCode}.apk`,
    notes: `第 ${versionCode} 版`,
    publishedAt: 1,
  }), "utf8");
}

describe("M2 e2e：更新检查与 APK 下载", () => {
  it("无发布：hello 后直发 update.info(latest:null)；update.check 同样回 null", async () => {
    const { app, port, token } = await startServer();
    const { ws, stream } = await dial(port, token);
    try {
      const welcome = await stream.next();
      expect(welcome.type).toBe("welcome");
      const info = await stream.next();
      expect(info).toEqual({ v: 1, type: "update.info", latest: null });
      ws.send(JSON.stringify({ v: 1, type: "update.check" }));
      expect(await stream.next()).toEqual({ v: 1, type: "update.info", latest: null });
    } finally {
      ws.close();
      await app.close();
    }
  });

  it("发布落盘后 refresh 通知：在线连接立即收到新 update.info；update.check 应答一致", async () => {
    const { app, port, token, updatesDir } = await startServer();
    const { ws, stream } = await dial(port, token);
    try {
      await stream.next(); // welcome
      await stream.next(); // update.info(null)
      publishFixture(updatesDir, 7, "apk-body-7");
      const res = await fetch(`http://127.0.0.1:${port}/internal/updates/refresh`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ versionCode: 7 });
      const pushed = await stream.next();
      expect(pushed.type).toBe("update.info");
      expect(pushed.latest).toMatchObject({ versionCode: 7, downloadPath: "/updates/app-7.apk", sha256: "b".repeat(64) });
      expect(pushed.latest).not.toHaveProperty("publishedAt");
      ws.send(JSON.stringify({ v: 1, type: "update.check" }));
      expect((await stream.next()).latest.versionCode).toBe(7);
    } finally {
      ws.close();
      await app.close();
    }
  });

  it("HTTP 下载：正确 token 200 回 APK 字节；错 token 401；清单外文件 404", async () => {
    const { app, port, token, updatesDir } = await startServer();
    publishFixture(updatesDir, 3, "apk-body-3");
    try {
      await fetch(`http://127.0.0.1:${port}/internal/updates/refresh`, { method: "POST" });
      const base = `http://127.0.0.1:${port}`;
      const ok = await fetch(`${base}/updates/app-3.apk?token=${encodeURIComponent(token)}`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("apk-body-3");
      expect((await fetch(`${base}/updates/app-3.apk?token=wrong-token-0`)).status).toBe(401);
      expect((await fetch(`${base}/updates/app-99.apk?token=${encodeURIComponent(token)}`)).status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("服务重启后启动读缓存：新连接 hello 后直发带已发布版本", async () => {
    const first = await startServer();
    publishFixture(first.updatesDir, 4, "apk-body-4");
    await first.app.close();
    // 同一 dataDir 重启（复用 cleanups 里的同一根目录）：启动即读 manifest。
    const root = mkdtempSync(join(tmpdir(), "aimi-e2e-updates-"));
    cleanups.push(root);
    const app2 = new Application({
      port: 0,
      dataDir: first.dataDir,
      logDir: join(root, "logs"),
      logLevel: "ERROR",
      watchdogMs: 600_000, serverVersion: "0.1.0",
    });
    const { port } = await app2.start();
    const provision = new ConfigProvisioner(new MemoryDeviceRepository(), join(first.dataDir, "lan-token.txt"));
    const token = (await provision.ensureLanToken()).token;
    const { ws, stream } = await dial(port, token);
    try {
      await stream.next(); // welcome
      const info = await stream.next();
      expect(info.type).toBe("update.info");
      expect(info.latest.versionCode).toBe(4);
    } finally {
      ws.close();
      await app2.close();
    }
  });
});
