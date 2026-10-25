import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { load } from "js-yaml";
import { z } from "zod";
import type { LogLevel } from "../logging/logger.js";
import { SERVER_VERSION } from "./version.js";

/**
 * relay 出站拨入配置（Task 9）：`url` 指向 relay 的 server 拨入路由（含路径），
 * `serverToken` 为拨入凭证——拨入 header `x-aimi-server-token` 携带，relay 侧校验（S2 对接点）。
 */
export interface RelayConfig {
  /** relay 的 server 拨入路由完整地址（如 `wss://relay.example/serve`） */
  readonly url: string;
  /** 拨入凭证明文（relay 侧核对；泄露面 = 本机配置文件） */
  readonly serverToken: string;
}

/** agent 授权策略：显式集合优先，缺省兼容旧上限配置。 */
export interface AgentsConfig {
  readonly permissionCeiling: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  /** 按 agent 显式授权模式集合；该 agent 配置后覆盖旧上限转换。 */
  readonly allowedPermissionModes?: Readonly<Record<string, readonly string[]>>;
}

/** 原生 WSS 证书配置；证书只在服务启动时加载，轮换通过重启生效。 */
export interface TlsConfig {
  readonly certFile: string;
  readonly keyFile: string;
}

/**
 * aimi-server 运行配置；只有 `app/` 读盘，其余模块只消费本结构。
 * 全部字段在加载后不可变（`readonly`）；`serverVersion` 不由外部覆盖，恒取 `SERVER_VERSION`。
 */
export interface ServerConfig {
  /** LAN WebSocket 监听端口（默认 8787；`0` 表示由 OS 分配——测试用） */
  readonly port: number;
  /** 监听地址；配置加载默认 loopback，测试/旧调用方缺省时由 Application 取 loopback。 */
  readonly host?: string;
  /** 原生 WSS 证书；缺省表示 loopback 明文 WS。 */
  readonly tls?: TlsConfig;
  /** 运行时数据目录（默认 `~/.aimi-server/data`；库文件 `aimi.db` 与 `lan-token.txt` 在此） */
  readonly dataDir: string;
  /** 日志目录（默认 `~/.aimi-server/logs`；JSON 行落 `server.log`） */
  readonly logDir: string;
  /** 日志过滤基线（默认 `INFO`） */
  readonly logLevel: LogLevel;
  /** running 会话停滞判定阈值（毫秒，默认 600_000=10 分钟）：超阈值无新事件发一条 warn notice（一段停滞恰一次） */
  readonly watchdogMs: number;
  /** relay 出站拨入（可选；缺省 = 未启用 relay，纯 LAN 形态——既有部署零改动） */
  readonly relay?: RelayConfig;
  /** agent 权限上限；默认只允许最安全的 default 档。 */
  readonly agents?: AgentsConfig;
  /** server 版本号；始终取 `SERVER_VERSION`，不接受外部覆盖 */
  readonly serverVersion: string;
}

/** 默认 LAN 端口 8787。 */
const DEFAULT_PORT = 8787;
/**
 * 默认 watchdog 停滞阈值（毫秒，10 分钟）：正常 LLM 回合内的思考/工具间隙是秒级～十秒级，
 * 10 分钟内不会误报；真正的「进程活着但不产出」在 10 分钟尺度上可辨且值得提示。
 */
const DEFAULT_WATCHDOG_MS = 600_000;
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
    host: z.string().min(1).default("127.0.0.1"),
    tls: z
      .object({ certFile: z.string().min(1), keyFile: z.string().min(1) })
      .strict()
      .optional(),
    dataDir: z.string().min(1).default(defaultDataDir),
    logDir: z.string().min(1).default(defaultLogDir),
    logLevel: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).default("INFO"),
    // watchdog 停滞阈值；下限 5000：防误配 0/极小值——阈值 0 会让看门狗每事件即告警，
    // 停滞防护反转成告警轰炸；正常回合内的思考间隙常达秒级，5s 是不误报正常停顿的最低可用值。
    watchdogMs: z.number().int().min(5_000).default(DEFAULT_WATCHDOG_MS),
    // relay 出站拨入（可选嵌套键）：缺省 = 未启用 relay（纯 LAN 形态），**可缺省**不强制填——
    // 未启用 relay 的部署零改动；strict 让 relay 内拼写错误显式报错而非静默吞掉。
    relay: z
      .object({
        url: z.string().min(1),
        serverToken: z.string().min(1),
      })
      .strict()
      .optional(),
    agents: z
      .object({
        permissionCeiling: z.enum(["default", "plan", "acceptEdits", "bypassPermissions"]).default("default"),
        allowedPermissionModes: z
          .record(
            z.array(
              z
                .string()
                .min(1)
                .max(128)
                .regex(/^[A-Za-z0-9_.:-]+$/),
            ),
          )
          .optional(),
      })
      .strict()
      .default({}),
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
  const configDir = configPath === undefined ? undefined : dirname(resolve(configPath));
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
  if (result.data.host !== "127.0.0.1" && result.data.host !== "::1" && result.data.tls === undefined) {
    throw new Error("config 校验失败: 非 loopback host 必须配置 tls.certFile 与 tls.keyFile");
  }
  /** 配置文件内的相对路径以配置文件目录为基准；无配置文件时保留默认目录。 */
  const resolveConfigPath = (path: string): string => {
    if (isAbsolute(path) || configDir === undefined) return path;
    return resolve(configDir, path);
  };
  return {
    ...result.data,
    dataDir: resolveConfigPath(result.data.dataDir),
    logDir: resolveConfigPath(result.data.logDir),
    ...(result.data.tls === undefined
      ? {}
      : {
          tls: {
            certFile: resolveConfigPath(result.data.tls.certFile),
            keyFile: resolveConfigPath(result.data.tls.keyFile),
          },
        }),
    agents: result.data.agents,
    serverVersion: SERVER_VERSION,
  };
}
