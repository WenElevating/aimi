import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 日志级别（四级语义，由低到高）：
 * - `DEBUG`：开发排查细节，默认不落盘；
 * - `INFO`：正常业务流程的关键节点（默认过滤基线——设计 §13）；
 * - `WARN`：可自愈但需关注的异常；
 * - `ERROR`：业务失败或不可用。
 * 低于 `createLogger` 的 `minLevel`（默认 `INFO`）的记录不会写入。
 */
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
const LEVEL_RANK: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

/**
 * 结构化日志门面（消费方唯一依赖的日志契约）。
 * 四个方法对应四个级别，契约一致：`msg` 为人类可读摘要，
 * 可选 `fields` 作为结构化附加键平铺进日志对象顶层。
 * 写日志失败不向业务调用方抛出：该语义由 Task 11 装配层保证
 * （本层当前为同步实现，失败会直接抛出——装配层负责包裹与降级）。
 */
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
