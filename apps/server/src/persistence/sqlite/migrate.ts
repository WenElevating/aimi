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
  return db;
}
