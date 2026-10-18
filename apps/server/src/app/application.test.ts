import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Application } from "./application.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 占住一个端口（绑定 `0.0.0.0`，与 `LanWsServer` 同 host，确保后续监听报 `EADDRINUSE`）。
 *
 * @returns Promise，resolve 为已占用的端口号与释放该端口的回调
 */
function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("占位 server 未取得端口"));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise<void>((done) => { server.close(() => done()); }),
      });
    });
  });
}

describe("Application 部分启动失败的资源回收（评审 Fix 1/2）", () => {
  it("listen 失败 → start rejects；close 不抛且释放 DB 句柄（数据目录可删）", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-app-fail-"));
    dirs.push(root);
    const dataDir = join(root, "data");
    // 让 logger 写必抛（EISDIR）：把 `logs/server.log` 先建成目录，再以 INFO 级别装配——
    // 关停路径经 #safeLog 写 "aimi-server shutting down"，若未兜住写失败则 close 会 reject。
    mkdirSync(join(root, "logs", "server.log"), { recursive: true });
    const occupied = await occupyPort();
    try {
      const app = new Application({
        port: occupied.port,
        dataDir,
        logDir: join(root, "logs"),
        logLevel: "INFO",
        serverVersion: "0.1.0",
      });
      // DB 在 listen 之前已打开，故 listen 失败（端口被占）时也必须可被 close 回收。
      await expect(app.start()).rejects.toThrow();
      // close 不得抛：既要释放 DB，又要保证关停路径的 logger 写失败不中断收尾。
      await expect(app.close()).resolves.toBeUndefined();
    } finally {
      await occupied.close();
    }
    // 连接已释放：删掉整个 dataDir（含 aimi.db / -wal / -shm）不应抛（Windows 下被占用则 EBUSY/EPERM）。
    rmSync(dataDir, { recursive: true, force: true });
    expect(existsSync(dataDir)).toBe(false);
  }, 30_000);
});
