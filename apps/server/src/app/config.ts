import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { z } from "zod";
import type { LogLevel } from "../logging/logger.js";
import { SERVER_VERSION } from "./version.js";

/**
 * aimi-server 运行配置；只有 `app/` 读盘，其余模块只消费本结构。
 * 全部字段在加载后不可变（`readonly`）；`serverVersion` 不由外部覆盖，恒取 `SERVER_VERSION`。
 */
export interface ServerConfig {
  /** LAN WebSocket 监听端口（默认 8787；`0` 表示由 OS 分配——测试用） */
  readonly port: number;
  /** 运行时数据目录（默认 `~/.aimi-server/data`；库文件 `aimi.db` 与 `lan-token.txt` 在此） */
  readonly dataDir: string;
  /** 日志目录（默认 `~/.aimi-server/logs`；JSON 行落 `server.log`） */
  readonly logDir: string;
  /** 日志过滤基线（默认 `INFO`） */
  readonly logLevel: LogLevel;
  /** server 版本号；始终取 `SERVER_VERSION`，不接受外部覆盖 */
  readonly serverVersion: string;
}

/** 默认 LAN 端口 8787。 */
const DEFAULT_PORT = 8787;
/** 默认数据目录：用户主目录下的 `.aimi-server/data`。 */
function defaultDataDir(): string {
  return join(homedir(), ".aimi-server", "data");
}
/** 默认日志目录：用户主目录下的 `.aimi-server/logs`。 */
function defaultLogDir(): string {
  return join(homedir(), ".aimi-server", "logs");
}

/**
 * config 结构校验（zod 单源）。缺省即取默认值；`.strict()` 让拼写错误（未知键）显式报错，
 * 而非静默退回默认值把问题藏起来。
 */
const configSchema = z
  .object({
    port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
    dataDir: z.string().min(1).default(defaultDataDir),
    logDir: z.string().min(1).default(defaultLogDir),
    logLevel: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).default("INFO"),
  })
  .strict();

/** 把读取/解析异常收敛为可读消息（不改变抛错语义）。 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 加载并校验 config.yaml（`app/` 独家读盘）。
 *
 * @param configPath - YAML 文件路径；`undefined` 或缺省时取全默认配置
 * @returns 加载后不可变的 `ServerConfig`（`serverVersion` 恒为 `SERVER_VERSION`）
 * @throws 文件不可读（`config 读取失败: ...`）或结构非法（`config 校验失败: ...`）
 */
export function loadConfig(configPath: string | undefined): ServerConfig {
  let raw: unknown = {};
  if (configPath !== undefined) {
    let text: string;
    try {
      text = readFileSync(configPath, "utf8");
    } catch (err) {
      throw new Error("config 读取失败: " + configPath + " — " + errorMessage(err));
    }
    // 空文件时 js-yaml 返回 undefined，按「无覆盖」处理。
    raw = load(text) ?? {};
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new Error("config 校验失败: " + result.error.message);
  }
  return { ...result.data, serverVersion: SERVER_VERSION };
}
