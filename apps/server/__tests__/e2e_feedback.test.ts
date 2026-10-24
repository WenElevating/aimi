import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Application } from "../src/app/application.js";
import { ConfigProvisioner } from "../src/auth/configProvisioner.js";
import { MemoryDeviceRepository } from "../src/persistence/memory/index.js";
import { showFeedback } from "../src/ops/feedback.js";
import type { ServerConfig } from "../src/app/config.js";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 起一个完整 Application（随机端口）并返回 lan token。 */
async function startServer(dataDir: string): Promise<{ app: Application; port: number; token: string }> {
  const logDir = mkdtempSync(join(tmpdir(), "aimi-fb-logs-"));
  roots.push(logDir);
  const cfg: ServerConfig = {
    port: 0,
    dataDir,
    logDir,
    logLevel: "ERROR",
    watchdogMs: 600_000, serverVersion: "0.1.0",
  };
  const app = new Application(cfg);
  const { port } = await app.start();
  const provision = new ConfigProvisioner(new MemoryDeviceRepository(), join(dataDir, "lan-token.txt"));
  const token = (await provision.ensureLanToken()).token;
  return { app, port, token };
}

describe("feedback 全链路（Application 组合分发 + CLI 查看）", () => {
  it("POST /feedback 经真实鉴权落盘；CLI list/show 可读；/updates 路由不受影响", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-fb-e2e-"));
    roots.push(root);
    const dataDir = join(root, "data");
    const { app, port, token } = await startServer(dataDir);

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const res = await fetch(`http://127.0.0.1:${port}/feedback`, {
      method: "POST",
      headers: { "x-aimi-token": token },
      body: JSON.stringify({
        desc: "会话页卡住不动了",
        app: { version: "1.0.8", build: "9", platform: "Android 16" },
        logZipB64: Buffer.from("fake-zip-bytes").toString("base64"),
        images: [{ name: "screenshot.jpg", b64: jpeg.toString("base64") }],
      }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    // CLI 读面（同 dataDir 跨进程共享）。
    const entry = await showFeedback(cfgOf(dataDir), id);
    expect(entry.desc).toBe("会话页卡住不动了");
    expect(entry.hasLog).toBe(true);
    expect(entry.images).toHaveLength(1);
    expect(existsSync(join(entry.dir, "log.zip"))).toBe(true);
    expect(readFileSync(join(entry.dir, "images", "00.jpg")).subarray(0, 3)).toEqual(
      Buffer.from([0xff, 0xd8, 0xff]),
    );

    // 错 token：401（真实 verifyToken 拒绝）。
    const bad = await fetch(`http://127.0.0.1:${port}/feedback`, {
      method: "POST",
      headers: { "x-aimi-token": "wrong-token-000" },
      body: JSON.stringify({ desc: "x", app: { version: "1", build: "1", platform: "p" } }),
    });
    expect(bad.status).toBe(401);

    // 组合分发的另一半（/updates 面的 refresh）不受影响。
    const refresh = await fetch(`http://127.0.0.1:${port}/internal/updates/refresh`, { method: "POST" });
    expect(refresh.status).toBe(200);

    await app.close();
    writeFileSync(join(root, "keep"), "x"); // 防 afterEach 误删断言前目录（dataDir 由根目录统一清理）
  });
});

function cfgOf(dataDir: string): ServerConfig {
  roots.push(dataDir);
  return {
    port: 0,
    dataDir,
    logDir: join(dataDir, "logs"),
    logLevel: "ERROR",
    watchdogMs: 600_000, serverVersion: "0.1.0",
  };
}
