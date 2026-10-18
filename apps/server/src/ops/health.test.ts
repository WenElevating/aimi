import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../app/config.js";
import { openMigrated } from "../persistence/sqlite/migrate.js";
import { SqliteConversationRepository } from "../persistence/sqlite/sqliteConversationRepository.js";
import { SqliteDeviceRepository } from "../persistence/sqlite/sqliteRepositories.js";
import { healthSnapshot, readLanToken } from "./health.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 造一份把数据目录与日志目录都指向本用例临时目录的配置，互不干扰。
 *
 * @returns 指向新建临时目录的配置；该目录登记进清理表，由 afterEach 删除
 */
function tmpCfg(): ServerConfig {
  const root = mkdtempSync(join(tmpdir(), "aimi-health-"));
  dirs.push(root);
  return {
    port: 8787,
    dataDir: join(root, "data"),
    logDir: join(root, "logs"),
    logLevel: "INFO",
    serverVersion: "0.1.0",
  };
}

describe("status 快照（ops/health.ts）", () => {
  it("预置 1 设备 2 会话 → {port, sessions:2, devices:1}", async () => {
    const cfg = tmpCfg();
    mkdirSync(cfg.dataDir, { recursive: true });
    const db = openMigrated(join(cfg.dataDir, "aimi.db"));
    const conversations = new SqliteConversationRepository(db);
    await conversations.createSession({ id: "s1", agentId: "claude", cwd: "C:/w", permissionMode: "default" }, null);
    await conversations.createSession({ id: "s2", agentId: "claude", cwd: "C:/w", permissionMode: "default" }, null);
    await new SqliteDeviceRepository(db).put("lan-default", "a".repeat(64));
    db.close();

    expect(await healthSnapshot(cfg)).toEqual({ port: 8787, sessions: 2, devices: 1 });
  });

  it("lan-token 幂等：两次调用同一 token（43 字符 base64url(32B)）", async () => {
    const cfg = tmpCfg();
    const first = await readLanToken(cfg);
    const second = await readLanToken(cfg);
    expect(second).toBe(first);
    expect(first).toHaveLength(43);
  });
});
