import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryMetaRepository } from "../persistence/memory/index.js";
import { openMigrated } from "../persistence/sqlite/migrate.js";
import { SqliteMetaRepository } from "../persistence/sqlite/sqliteRepositories.js";
import { ensureServerId, SERVER_ID_KEY } from "./serverId.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ensureServerId（meta_kv server_id 单例标记）", () => {
  it("首见生成 UUID 并落库，此后复用同值（memory 与 sqlite 两实现同语义）", async () => {
    const memory = new MemoryMetaRepository();
    const first = await ensureServerId(memory);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await memory.get(SERVER_ID_KEY)).toBe(first);
    expect(await ensureServerId(memory)).toBe(first); // 幂等复用

    const root = mkdtempSync(join(tmpdir(), "aimi-serverid-"));
    dirs.push(root);
    const db = openMigrated(join(root, "aimi.db"));
    try {
      const sqlite = new SqliteMetaRepository(db);
      const sqliteFirst = await ensureServerId(sqlite);
      expect(sqliteFirst).toMatch(/^[0-9a-f-]{36}$/);
      expect(await ensureServerId(sqlite)).toBe(sqliteFirst);
      expect(await sqlite.get(SERVER_ID_KEY)).toBe(sqliteFirst);
    } finally {
      db.close();
    }
  });

  it("库里已有值时直接复用（跨进程：CLI 出码与运行服务看到同一 serverId）", async () => {
    const meta = new MemoryMetaRepository();
    await meta.set(SERVER_ID_KEY, "fixed-id");
    expect(await ensureServerId(meta)).toBe("fixed-id");
  });
});
