import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteConversationRepository } from "./sqliteConversationRepository.js";
import { openMigrated } from "./migrate.js";

const dirs: string[] = [];
let migratedDb: Database.Database | undefined;

afterEach(() => {
  migratedDb?.close();
  migratedDb = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 创建 M0 旧 sessions/events 表并写入一条带事件的历史行，模拟升级前的磁盘库。 */
function createLegacyDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        permission_mode TEXT NOT NULL CHECK (permission_mode IN ('default','plan')),
        state TEXT NOT NULL,
        resume_hint TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0,
        initial_prompt TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE events (
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      INSERT INTO sessions
        (id, agent_id, cwd, permission_mode, state, resume_hint, last_seq, initial_prompt, created_at, updated_at)
        VALUES ('legacy-session', 'claude', 'D:/legacy', 'plan', 'running', 'legacy-hint', 4, 'legacy prompt', 100, 200);
      INSERT INTO events (session_id, seq, ts, payload)
        VALUES ('legacy-session', 4, 200, '{"type":"text_delta","text":"legacy event"}');
      CREATE TABLE observer(session_id TEXT);
      CREATE INDEX sessions_agent_lookup ON sessions(agent_id);
      CREATE TRIGGER sessions_observer AFTER UPDATE OF permission_mode ON sessions BEGIN INSERT INTO observer VALUES(new.id); END;
      CREATE VIEW session_summary AS SELECT id,permission_mode FROM sessions;
      PRAGMA user_version = 11;
    `);
  } finally {
    db.close();
  }
}

describe("SQLite sessions model/CHECK migration", () => {
  it("rebuilds the legacy table while preserving session and event rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aimi-migrate-legacy-"));
    dirs.push(dir);
    const dbPath = join(dir, "aimi.db");
    createLegacyDatabase(dbPath);

    migratedDb = openMigrated(dbPath);
    const table = migratedDb
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
      .get() as { sql: string };
    expect(table.sql).not.toContain("permission_mode IN");
    expect(table.sql).toContain("128");
    expect(
      (migratedDb.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((row) => row.name),
    ).toContain("model");

    expect(migratedDb.prepare("SELECT * FROM session_summary").get()).toEqual({
      id: "legacy-session",
      permission_mode: "plan",
    });
    expect(migratedDb.pragma("user_version", { simple: true })).toBe(11);
    expect(migratedDb.prepare("SELECT name FROM sqlite_master WHERE name='sessions_agent_lookup'").get()).toBeDefined();
    migratedDb.prepare("UPDATE sessions SET permission_mode='plan' WHERE id='legacy-session'").run();
    expect(migratedDb.prepare("SELECT count(*) AS count FROM observer").get()).toEqual({ count: 1 });
    const conversations = new SqliteConversationRepository(migratedDb);
    expect(await conversations.listSessions()).toEqual([
      expect.objectContaining({
        id: "legacy-session",
        agentId: "claude",
        cwd: "D:/legacy",
        permissionMode: "plan",
        state: "running",
        lastSeq: 4,
        resumable: true,
      }),
    ]);
    expect(await conversations.getEvents("legacy-session")).toEqual([
      { seq: 4, ts: 200, agentEvent: { type: "text_delta", text: "legacy event" } },
    ]);

    await conversations.createSession(
      {
        id: "new-session",
        agentId: "claude",
        cwd: "D:/new",
        permissionMode: "acceptEdits",
        model: "opus",
      },
      null,
    );
    expect((await conversations.listSessions()).find((row) => row.id === "new-session")).toMatchObject({
      permissionMode: "acceptEdits",
      model: "opus",
    });
  });
});

/** 四模式库升级不能重置模型、历史事件、进程外键及用户附加查询结构。 */
describe("SQLite 不透明权限模式前向迁移", () => {
  it("四模式库升级保留全部数据、索引、触发器、视图及 user_version，重复打开不回迁", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aimi-migrate-modes-"));
    dirs.push(dir);
    const dbPath = join(dir, "aimi.db");
    const before = new Database(dbPath);
    before.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, cwd TEXT NOT NULL,
        permission_mode TEXT NOT NULL CHECK (permission_mode IN ('default','plan','acceptEdits','bypassPermissions')),
        model TEXT, state TEXT NOT NULL, resume_hint TEXT, last_seq INTEGER NOT NULL DEFAULT 0,
        initial_prompt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE events (session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL,
        ts INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id,seq));
      CREATE TABLE session_processes (session_id TEXT PRIMARY KEY REFERENCES sessions(id), pid INTEGER NOT NULL, started_at INTEGER NOT NULL);
      CREATE TABLE observer (session_id TEXT);
      CREATE INDEX sessions_agent_lookup ON sessions(agent_id);
      CREATE TRIGGER sessions_observer AFTER UPDATE OF permission_mode ON sessions BEGIN INSERT INTO observer VALUES(new.id); END;
      CREATE VIEW session_summary AS SELECT id, model, permission_mode FROM sessions;
      INSERT INTO sessions VALUES ('existing', 'claude', 'D:/old', 'bypassPermissions', 'custom-model', 'stopped', 'hint', 7, 'prompt', 111, 222);
      INSERT INTO events VALUES ('existing',7,222,'{"type":"text_delta","text":"preserved"}');
      INSERT INTO session_processes VALUES ('existing',12345,111);
      PRAGMA user_version = 17;
    `);
    before.close();
    migratedDb = openMigrated(dbPath);
    expect(migratedDb.prepare("SELECT * FROM sessions").get()).toEqual({
      id: "existing",
      agent_id: "claude",
      cwd: "D:/old",
      permission_mode: "bypassPermissions",
      model: "custom-model",
      state: "stopped",
      resume_hint: "hint",
      last_seq: 7,
      initial_prompt: "prompt",
      created_at: 111,
      updated_at: 222,
    });
    expect(migratedDb.prepare("SELECT count(*) AS count FROM events").get()).toEqual({ count: 1 });
    expect(migratedDb.prepare("SELECT pid FROM session_processes").get()).toEqual({ pid: 12345 });
    expect(migratedDb.pragma("foreign_key_check")).toEqual([]);
    expect(migratedDb.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(migratedDb.pragma("user_version", { simple: true })).toBe(17);
    expect(migratedDb.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions_agent_lookup'").get()).toEqual({
      name: "sessions_agent_lookup",
    });
    for (const mode of ["auto", "dontAsk", "sandbox-review"]) {
      migratedDb.prepare("UPDATE sessions SET permission_mode = ? WHERE id = 'existing'").run(mode);
    }
    expect(migratedDb.prepare("SELECT count(*) AS count FROM observer").get()).toEqual({ count: 3 });
    expect(migratedDb.prepare("SELECT * FROM session_summary").get()).toMatchObject({
      model: "custom-model",
      permission_mode: "sandbox-review",
    });
    migratedDb.close();
    migratedDb = openMigrated(dbPath);
    expect(migratedDb.prepare("SELECT * FROM session_summary").get()).toMatchObject({
      model: "custom-model",
      permission_mode: "sandbox-review",
    });
    expect(migratedDb.pragma("foreign_key_check")).toEqual([]);
  });
});

/** 失败必须回滚整个升级并释放连接，不能留下半张替换表或锁住用户库。 */
describe("SQLite 权限迁移失败恢复", () => {
  it("关联数据已损坏时保留旧表及记录，关闭失败连接", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimi-migrate-failed-"));
    dirs.push(dir);
    const path = join(dir, "aimi.db");
    createLegacyDatabase(path);
    const before = new Database(path);
    try {
      before.pragma("foreign_keys = OFF");
      before.exec("INSERT INTO events VALUES('missing-session',1,1,'{}')");
    } finally {
      before.close();
    }
    expect(() => openMigrated(path)).toThrow("foreign key validation failed");
    migratedDb = new Database(path);
    expect(migratedDb.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 1 });
    expect(migratedDb.prepare("SELECT count(*) AS count FROM events").get()).toEqual({ count: 2 });
    expect(
      migratedDb.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions_permission_modes_new'").get(),
    ).toBeUndefined();
    expect(
      (migratedDb.prepare("SELECT sql FROM sqlite_master WHERE name = 'sessions'").get() as { sql: string }).sql,
    ).toContain("permission_mode IN");
  });
});
