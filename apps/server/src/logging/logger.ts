import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
const LEVEL_RANK: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** JSON 行：一行一对象。分级过滤由 minLevel 决定（默认 INFO——设计 §13）。 */
export function createLogger(
  component: string,
  logDir: string,
  minLevel: LogLevel = "INFO",
): Logger {
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const file = join(logDir, "server.log");
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
    const rec = { ts: Date.now(), level, component, msg, ...fields };
    appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
  };
  return {
    debug: (m, f) => write("DEBUG", m, f),
    info: (m, f) => write("INFO", m, f),
    warn: (m, f) => write("WARN", m, f),
    error: (m, f) => write("ERROR", m, f),
  };
}
