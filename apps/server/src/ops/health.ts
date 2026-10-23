import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../app/config.js";
import { ConfigProvisioner } from "../auth/configProvisioner.js";
import { openMigrated } from "../persistence/sqlite/migrate.js";
import { SqliteConversationRepository } from "../persistence/sqlite/sqliteConversationRepository.js";
import { SqliteDeviceRepository } from "../persistence/sqlite/sqliteRepositories.js";

/** `status` 子命令的输出结构（由 ops/ 聚合，CLI 只负责打印）。 */
export interface HealthSnapshot {
  /** 配置端口（非运行端口——`status` 不连进程，只读配置与库） */
  readonly port: number;
  /** 库中会话总数 */
  readonly sessions: number;
  /** 库中设备总数（含已吊销设备，当前不做吊销过滤） */
  readonly devices: number;
}

/** 打开数据目录下的权威库（确保目录存在后走幂等迁移）；调用方负责 `db.close()`。 */
function openDataDb(cfg: ServerConfig): ReturnType<typeof openMigrated> {
  mkdirSync(cfg.dataDir, { recursive: true });
  return openMigrated(join(cfg.dataDir, "aimi.db"));
}

/**
 * 采集运行状态快照（`status` 子命令的唯一实现，CLI 只绑参数）。
 * 只读：打开库后立即统计会话数与设备数，不写任何行。
 *
 * @param cfg - 已加载配置（用其 `port`/`dataDir`）
 * @returns Promise，resolve 为 `{ port, sessions, devices }`
 * 副作用：打开并随即关闭数据目录下的数据库
 */
export async function healthSnapshot(cfg: ServerConfig): Promise<HealthSnapshot> {
  const db = openDataDb(cfg);
  try {
    const conversations = new SqliteConversationRepository(db);
    const devices = new SqliteDeviceRepository(db);
    return {
      port: cfg.port,
      sessions: (await conversations.listSessions()).length,
      devices: (await devices.list()).length,
    };
  } finally {
    db.close();
  }
}

/**
 * 读取（不存在则生成）LAN 明文令牌，是 `lan-token` 子命令的唯一实现。
 * 幂等：文件在则复用，连续调用返回同一 token（`ConfigProvisioner.ensureLanToken`）。
 *
 * @param cfg - 已加载配置（令牌文件为 `<dataDir>/lan-token.txt`）
 * @returns Promise，resolve 为明文令牌（调用方负责只在运维者终端打印一次）
 * 副作用：令牌或设备行缺失时生成并落盘
 */
export async function readLanToken(cfg: ServerConfig): Promise<string> {
  const db = openDataDb(cfg);
  try {
    const devices = new SqliteDeviceRepository(db);
    const provisioner = new ConfigProvisioner(devices, join(cfg.dataDir, "lan-token.txt"));
    return (await provisioner.ensureLanToken()).token;
  } finally {
    db.close();
  }
}

/**
 * 组装手机可直连的 LAN URL（`start` 子命令打印用；**不含 token**——明文凭证只经 `lan-token` 打印一次）。
 *
 * @param port - 实际监听端口
 * @returns 形如 `ws://<LAN IP>:<port>` 的地址；无可用网卡时退化为 `127.0.0.1`
 */
export function lanUrl(port: number, cfg?: Pick<ServerConfig, "host" | "tls">): string {
  const scheme = cfg?.tls === undefined ? "ws" : "wss";
  const host = cfg?.host === "127.0.0.1" || cfg?.host === "::1" ? "127.0.0.1" : lanIp();
  return scheme + "://" + host + ":" + port;
}

/**
 * 计算服务端 TLS 证书的 SHA-256 指纹（小写 hex、无冒号，DER 编码口径）。
 * 手机端以同一口径对自签证书做指纹比对（TOFU 信任锚：QR 携带 → 落库 → 握手时核对）。
 *
 * @param tls - 已解析的 TLS 配置（certFile 必须可读）
 * @returns 64 位小写十六进制指纹
 * @throws 证书文件不可读或 PEM 形态非法时抛错
 */
export function tlsFingerprintOf(tls: { certFile: string; keyFile: string }): string {
  const pem = readFileSync(tls.certFile, "utf8");
  const body = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem)?.[1];
  if (body === undefined) {
    throw new Error("证书文件不是合法 PEM: " + tls.certFile);
  }
  const der = Buffer.from(body.replace(/\s+/g, ""), "base64");
  return createHash("sha256").update(der).digest("hex");
}

/** 选首个非回环 IPv4 地址；无可用网卡时降级 `127.0.0.1`（单机自测）。 */
function lanIp(): string {
  for (const ifaceList of Object.values(networkInterfaces())) {
    for (const iface of ifaceList ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}
