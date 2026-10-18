import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 日志级别（四级语义，由低到高）：
 * - `DEBUG`：开发排查细节，默认不落盘；
 * - `INFO`：正常业务流程的关键节点，也是默认过滤基线；
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
 * 写日志失败不向业务调用方抛出：本层是同步实现、失败会直接抛出，由装配层负责包裹与降级。
 */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * 创建写 JSON 行的日志门面（一行一对象），低于 `minLevel` 的记录不落盘。
 *
 * @param component - 记录到每行日志组件字段的来源名
 * @param logDir - 日志目录，不存在时创建
 * @param minLevel - 过滤基线；缺省 `INFO`
 * @returns 该组件的日志门面
 * @throws 目录创建或写文件失败时抛出（写失败的降级由装配层负责）
 */
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
