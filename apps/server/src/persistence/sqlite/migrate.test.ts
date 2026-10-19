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
    expect(table.sql).toContain("acceptEdits");
    expect(table.sql).toContain("bypassPermissions");
    expect((migratedDb.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((row) => row.name))
      .toContain("model");

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

    await conversations.createSession({
      id: "new-session",
      agentId: "claude",
      cwd: "D:/new",
      permissionMode: "acceptEdits",
      model: "opus",
    }, null);
    expect((await conversations.listSessions()).find((row) => row.id === "new-session"))
      .toMatchObject({ permissionMode: "acceptEdits", model: "opus" });
  });
});
