import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, AgentSession } from "../agents/types.js";
import { AgentRegistry } from "../agents/registry.js";
import { openMigrated } from "../persistence/sqlite/migrate.js";
import { SqliteConversationRepository } from "../persistence/sqlite/sqliteConversationRepository.js";
import { SqliteDeviceRepository } from "../persistence/sqlite/sqliteRepositories.js";
import type { ServerConfig } from "./config.js";
import { detectAgentsSnapshot, statusSnapshot } from "./detectAgents.js";

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 造一份把数据目录与日志目录都指向本用例临时目录的配置，互不干扰。
 *
 * @returns 指向新建临时目录的配置；该目录登记进清理表，由 afterEach 删除
 */
function tmpCfg(): ServerConfig {
  const root = mkdtempSync(join(tmpdir(), "aimi-detect-"));
  dirs.push(root);
  return {
    port: 8787,
    dataDir: join(root, "data"),
    logDir: join(root, "logs"),
    logLevel: "INFO",
    watchdogMs: 600_000, serverVersion: "0.1.0",
  };
}

/**
 * 造一个最小假适配器，安装探测结果由调用方给定（其余两个面是空壳——检测快照只消费 isInstalled）。
 *
 * @param id - 适配器标识
 * @param isInstalled - 安装探测的固定返回
 * @returns 只关心检测面的假适配器
 */
function stubAdapter(id: string, isInstalled: () => Promise<{ ok: boolean; version?: string }>): AgentAdapter {
  return {
    meta: { id, label: id },
    isInstalled,
    create: (): AgentSession => ({ start: async () => {}, send: async () => {}, dispose: async () => {} }),
  };
}

describe("detectAgentsSnapshot（app 层小装配——status 不拉全 Application 只装检测面）", () => {
  it("注入注册表 + 标灰：快照含 ok/version 且带 grayed 原因（detectAll 与 grayedSnapshot 合并）", async () => {
    const registry = new AgentRegistry();
    registry.register(stubAdapter("claude", async () => ({ ok: true, version: "claude 1.2.3" })));
    const reason = "适配器协议未确认（30s 内未收到 initialize 应答）";
    registry.gray("claude", reason);

    expect(await detectAgentsSnapshot(registry)).toEqual([
      { id: "claude", ok: true, version: "claude 1.2.3", grayed: reason },
    ]);
  });

  it("注入注册表 + 未标灰：快照不含 grayed 键（JSON 序列化后无灰态字段）", async () => {
    const registry = new AgentRegistry();
    registry.register(stubAdapter("claude", async () => ({ ok: true, version: "claude 1.2.3" })));

    const snapshot = await detectAgentsSnapshot(registry);
    expect(snapshot).toEqual([{ id: "claude", ok: true, version: "claude 1.2.3" }]);
    expect(JSON.stringify(snapshot)).not.toContain("grayed");
  });
});

/**
 * SDK 时代探测面：缺省装配的 ClaudeAdapter 直跑随包 CLI（依赖树内二进制恒在），
 * PATH 注入与全局 CLI 不再参与——版本断言放宽为形态匹配（随 SDK 锁定版本变化）。
 */
const ANY_VERSION: { id: string; ok: boolean; version: unknown } = {
  id: "claude",
  ok: true,
  version: expect.stringMatching(/^\d+\.\d+\.\d+/),
};

describe.skipIf(process.platform !== "win32")("detectAgentsSnapshot / statusSnapshot 的真实装配路径", () => {
  it("缺省装配探测随包 CLI → {id:claude, ok:true, version}", async () => {
    expect(await detectAgentsSnapshot()).toEqual([ANY_VERSION]);
  });

  it("statusSnapshot：healthSnapshot 只读快照 + agents 检测面合并为 {port,sessions,devices,agents}", async () => {
    const cfg = tmpCfg();
    mkdirSync(cfg.dataDir, { recursive: true });
    const db = openMigrated(join(cfg.dataDir, "aimi.db"));
    const conversations = new SqliteConversationRepository(db);
    await conversations.createSession({ id: "s1", agentId: "claude", cwd: "C:/w", permissionMode: "default" }, null);
    await conversations.createSession({ id: "s2", agentId: "claude", cwd: "C:/w", permissionMode: "default" }, null);
    await new SqliteDeviceRepository(db).put("lan-default", "a".repeat(64));
    db.close();

    expect(await statusSnapshot(cfg)).toEqual({
      port: 8787,
      sessions: 2,
      devices: 1,
      agents: [ANY_VERSION],
    });
  });
});
