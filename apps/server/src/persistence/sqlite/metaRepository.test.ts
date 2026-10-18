import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteMetaRepository } from "./sqliteRepositories.js";
import { openMigrated } from "./migrate.js";

describe("Sqlite MetaRepository 契约", () => {
  let dir: string;
  let db: Database.Database;
  let meta: SqliteMetaRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aimi-meta-"));
    db = openMigrated(join(dir, "meta.db"));
    meta = new SqliteMetaRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("get 宽松读（不存在=null）；set UPSERT 覆盖；键间互不影响", async () => {
    await meta.init();
    expect(await meta.get("server_id")).toBeNull();
    await meta.set("server_id", "srv-abc");
    await meta.set("replay_capped:s1", "1700000000000");
    expect(await meta.get("server_id")).toBe("srv-abc");
    expect(await meta.get("replay_capped:s1")).toBe("1700000000000");
    await meta.set("server_id", "srv-abd"); // 同键覆盖（UPSERT，不撞主键）
    expect(await meta.get("server_id")).toBe("srv-abd");
    expect(await meta.get("no-such-key")).toBeNull();
  });
});
