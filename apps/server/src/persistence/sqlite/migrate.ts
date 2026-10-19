import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BUSY_RETRY_DELAYS_MS = [25, 50, 100, 250, 500] as const;

/** SQLite 跨进程写锁的有限重试；非 busy/locked 错误立即原样抛出。 */
export async function withSqliteBusyRetry<T>(operation: () => T | Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const code = (err as { code?: string }).code;
      const retryable = code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT" || code === "SQLITE_LOCKED";
      const delay = BUSY_RETRY_DELAYS_MS[attempt];
      if (!retryable || delay === undefined) throw err;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * 打开数据库并执行幂等迁移（仅执行追加式 schema，不做 DROP 或改列）。
 *
 * @param dbPath - 数据库文件路径
 * @returns 已完成迁移的连接；调用方负责关闭
 * @throws 文件不可读或 schema 执行失败时抛出底层错误
 */
export function openMigrated(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  db.exec(sql);
  migrateSessionsModelAndPermission(db);
  return db;
}

/**
 * 把旧 sessions 表升级为支持四档权限和可选 model 的形态。
 * SQLite 不能直接修改 CHECK 约束，故采用事务内新表复制；旧行 id、状态、事件和时间戳全部保留。
 */
function migrateSessionsModelAndPermission(db: Database.Database): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get() as
    | { sql: string }
    | undefined;
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  const hasModel = columns.some((column) => column.name === "model");
  const hasFourModes = table?.sql.includes("acceptEdits") === true && table.sql.includes("bypassPermissions");
  if (hasModel && hasFourModes) return;

  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE sessions_new (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          permission_mode TEXT NOT NULL CHECK (permission_mode IN ('default','plan','acceptEdits','bypassPermissions')),
          model TEXT,
          state TEXT NOT NULL,
          resume_hint TEXT,
          last_seq INTEGER NOT NULL DEFAULT 0,
          initial_prompt TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO sessions_new (id, agent_id, cwd, permission_mode, model, state, resume_hint, last_seq, initial_prompt, created_at, updated_at)
          SELECT id, agent_id, cwd, permission_mode, NULL, state, resume_hint, last_seq, initial_prompt, created_at, updated_at
          FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
      `);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
