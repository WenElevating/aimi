import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteConversationRepository } from "./sqliteConversationRepository.js";
import { SqliteProcessLedgerRepository } from "./sqliteRepositories.js";
import { openMigrated } from "./migrate.js";

/**
 * 台账挂的是真实会话（schema 外键 `REFERENCES sessions(id)` 在 better-sqlite3 下强制启用），
 * 故 sqlite 侧先经 ConversationRepository 种会话行，再 register——与生产时序一致
 * （SessionManager 建会话后才会登记 pid）。memory 对齐用例在 `../types.test.ts`（memory 契约的家）。
 */
async function seedSession(conv: SqliteConversationRepository, sessionId: string): Promise<void> {
  await conv.createSession({ id: sessionId, agentId: "claude", cwd: "D:\\x", permissionMode: "default" }, null);
}

describe("Sqlite ProcessLedgerRepository 契约", () => {
  let dir: string;
  let db: Database.Database;
  let conv: SqliteConversationRepository;
  let ledger: SqliteProcessLedgerRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aimi-ledger-"));
    db = openMigrated(join(dir, "ledger.db"));
    conv = new SqliteConversationRepository(db);
    ledger = new SqliteProcessLedgerRepository(db);
  });

  afterEach(async () => {
    await conv.close();
    await ledger.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("register 对不存在会话拒绝（外键守卫——台账只挂真实会话的不变量）", async () => {
    await ledger.init();
    // why：better-sqlite3 出厂即强制外键，此用例钉住该依赖行为——升级若关闭外键会立刻报警，
    // 而不是让孤儿 pid 行静默落入台账（Task 4 孤儿清点的正确性前提）。
    await expect(ledger.register("no-such-session", 4242)).rejects.toThrow(/FOREIGN KEY/);
  });

  it("register 登记成行（started_at 由实现取 now，不外暴露）", async () => {
    await ledger.init();
    await seedSession(conv, "s1");
    await ledger.register("s1", 4242);
    expect(await ledger.list()).toEqual([{ sessionId: "s1", pid: 4242 }]);
  });

  it("upsert：同会话重拉覆盖 pid（台账一行一会话，不追加）", async () => {
    await ledger.init();
    await seedSession(conv, "s1");
    await ledger.register("s1", 100);
    await ledger.register("s1", 999);
    expect(await ledger.list()).toEqual([{ sessionId: "s1", pid: 999 }]);
  });

  it("clear 撤销；未知 sessionId 静默 no-op", async () => {
    await ledger.init();
    await seedSession(conv, "s1");
    await ledger.register("s1", 1);
    await ledger.clear("s-missing");
    expect(await ledger.list()).toEqual([{ sessionId: "s1", pid: 1 }]);
    await ledger.clear("s1");
    expect(await ledger.list()).toEqual([]);
  });

  it("list 多行全量，重挂一席不清其它会话", async () => {
    await ledger.init();
    await seedSession(conv, "s1");
    await seedSession(conv, "s2");
    await ledger.register("s1", 1);
    await ledger.register("s2", 2);
    await ledger.register("s1", 11);
    expect(await ledger.list()).toEqual([
      { sessionId: "s1", pid: 11 },
      { sessionId: "s2", pid: 2 },
    ]);
  });
});
