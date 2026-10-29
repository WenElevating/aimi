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
      const delay = BUSY_RETRY_DELAYS_MS.at(attempt);
      if (!retryable || delay === undefined) throw err;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * 打开数据库并执行幂等迁移；CHECK 约束变更在事务中复制并保留关联数据。
 *
 * @param dbPath - 数据库文件路径
 * @returns 已完成迁移的连接；调用方负责关闭
 * @throws 文件不可读或 schema 执行失败时抛出底层错误
 */
export function openMigrated(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(here, "schema.sql"), "utf8");
    db.exec(sql);
    migratePermissionIdentifiers(db);
    // 补列必须在表重建迁移之后：重建会按旧列集显式重造 sessions，先补列会被吞掉。
    migrateForkPendingColumn(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * 幂等补列：v11 及更早的库缺 `sessions.fork_pending`（fork 延迟启动标记，
 * 反馈 #8d81bf② 引入）。schema.sql 已含该列，此处只为存量库 ALTER 补齐；
 * 重复打开按列存在性跳过。
 */
function migrateForkPendingColumn(db: Database.Database): void {
  const has = db
    .prepare("PRAGMA table_info(sessions)")
    .all()
    .some((c) => (c as { name: string }).name === "fork_pending");
  if (has) return;
  db.exec("ALTER TABLE sessions ADD COLUMN fork_pending INTEGER NOT NULL DEFAULT 0");
}

/** 两档/四档旧库一次事务升级，缺少的 model 置空；保留数据、关联结构和版本，重复打开不回迁。 */
function migratePermissionIdentifiers(db: Database.Database): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get() as {
    sql: string;
  };
  if (!table.sql.includes("permission_mode IN")) return;
  const previousLegacyAlter = db.pragma("legacy_alter_table", { simple: true });
  db.pragma("foreign_keys = OFF");
  // 视图在 DROP 与 RENAME 的事务中短暂引用旧表名，关闭 rename 的视图重写校验。
  db.pragma("legacy_alter_table = ON");
  try {
    db.transaction(() => {
      const current = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get() as {
        sql: string;
      };
      if (!current.sql.includes("permission_mode IN")) return;
      const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      const modelColumn = columns.some((column) => column.name === "model") ? "model" : "NULL";
      const extras = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE tbl_name = 'sessions' AND type IN ('index','trigger') AND sql IS NOT NULL",
        )
        .all() as Array<{ sql: string }>;
      db.exec(`
        CREATE TABLE sessions_permission_modes_new (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          permission_mode TEXT NOT NULL CHECK (length(permission_mode) BETWEEN 1 AND 128),
          model TEXT,
          state TEXT NOT NULL,
          resume_hint TEXT,
          last_seq INTEGER NOT NULL DEFAULT 0,
          initial_prompt TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO sessions_permission_modes_new
          SELECT id, agent_id, cwd, permission_mode, ${modelColumn}, state, resume_hint, last_seq, initial_prompt, created_at, updated_at FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_permission_modes_new RENAME TO sessions;
      `);
      for (const extra of extras) db.exec(extra.sql);
      if ((db.pragma("foreign_key_check") as unknown[]).length > 0) {
        throw new Error("permission migration foreign key validation failed");
      }
    }).immediate();
  } finally {
    db.pragma(`legacy_alter_table = ${previousLegacyAlter === 1 ? "ON" : "OFF"}`);
    db.pragma("foreign_keys = ON");
  }
}
