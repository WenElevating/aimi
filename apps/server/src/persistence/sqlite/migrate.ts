import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  db.exec(sql);
  return db;
}
