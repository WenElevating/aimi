import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "../app/config.js";
import { openMigrated, withSqliteBusyRetry } from "../persistence/sqlite/migrate.js";
import {
  SqliteAuditRepository,
  SqliteDeviceRepository,
  SqliteMetaRepository,
} from "../persistence/sqlite/sqliteRepositories.js";
import type { DeviceRecord } from "../persistence/types.js";
import { lanUrl } from "./health.js";
import { ensureServerId } from "./serverId.js";

/** LAN 明文令牌文件名（与 `ConfigProvisioner`、`ops/health.ts` 同一约定）。 */
const LAN_TOKEN_FILE = "lan-token.txt";

/** 打开数据目录下的权威库（确保目录存在后走幂等迁移）；调用方负责 `db.close()`。 */
function openDataDb(cfg: ServerConfig): ReturnType<typeof openMigrated> {
  mkdirSync(cfg.dataDir, { recursive: true });
  return openMigrated(join(cfg.dataDir, "aimi.db"));
}

/** 明文令牌的 SHA-256 十六进制摘要（与 `DeviceRepository` 存储契约一致）。 */
function sha256hex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * 全量设备清单（`devices` 子命令的唯一实现）。
 * 只读：不区分吊销与否——吊销与否由行内 `revokedAt` 呈现，CLI 渲染成表格。
 *
 * @param cfg - 已加载配置（用其 `dataDir`）
 * @returns Promise，resolve 为设备记录数组
 * 副作用：打开并随即关闭数据目录下的数据库
 */
export async function listDevices(cfg: ServerConfig): Promise<DeviceRecord[]> {
  const db = openDataDb(cfg);
  try {
    return await new SqliteDeviceRepository(db).list();
  } finally {
    db.close();
  }
}

/**
 * 吊销一台设备（`revoke` 子命令的唯一实现）。
 * 吊销生效面：运行中的服务经吊销巡检（`REVOKE_SWEEP_MS` 轮询 `findById`）在至多一个周期内
 * 踢线；其后旧 token 重连由既有 `verifyToken` 拒绝。
 * **同步报废 lan-token.txt**（core-loop §5.3）：被吊销设备恰是持有 LAN 明文令牌的那行时，
 * 删除令牌文件并注明——否则下次服务重启 `ConfigProvisioner` 会按同一明文补建设备行，吊销复活。
 *
 * @param cfg - 已加载配置（用其 `dataDir`）
 * @param deviceId - 目标设备
 * @returns Promise，resolve 为 `"ok"`（已吊销）或 `"not_found"`（设备不存在，未写任何行）
 * 副作用：命中时写 devices.revoked_at 与一条 `auth.revoke` 审计；lan-token 系设备同时删除令牌文件
 */
export async function revokeDevice(cfg: ServerConfig, deviceId: string): Promise<"ok" | "not_found"> {
  const db = openDataDb(cfg);
  try {
    const devices = new SqliteDeviceRepository(db);
    const row = await withSqliteBusyRetry(() => devices.findById(deviceId));
    if (row === null) return "not_found";

    // 报废判据须在 revoke 之前算：`findByTokenHash` 隐藏已吊销行，吊销后返回 null 就再也对不上了。
    const tokenFile = join(cfg.dataDir, LAN_TOKEN_FILE);
    const destroysLanToken =
      existsSync(tokenFile) &&
      (await withSqliteBusyRetry(() => devices.findByTokenHash(sha256hex(readFileSync(tokenFile, "utf8").trim()))))?.id === deviceId;

    const detail = "device=" + deviceId + " name=" + row.name + (destroysLanToken ? " lan-token.txt destroyed" : "");
    await withSqliteBusyRetry(async () => {
      const transaction = db.transaction(() => {
        db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(Date.now(), deviceId);
        db.prepare("INSERT INTO audit (ts, device_id, session_id, action, detail) VALUES (?, ?, ?, ?, ?)")
          .run(Date.now(), "-", null, "auth.revoke", detail);
      });
      transaction();
    });
    if (destroysLanToken) {
      rmSync(tokenFile, { force: true });
    }
    return "ok";
  } finally {
    db.close();
  }
}

/**
 * 签发一次性配对码（`pair` 子命令的唯一实现）：码 + 绝对过期时刻 + 稳定 serverId + LAN 地址。
 * 码落库（`pairing_codes` 表）——运行中的服务进程靠**库**消费同一行，CLI 与服务跨进程共库
 * （review §3.3）；serverId 同理由 meta_kv 共库（`ensureServerId`）。
 *
 * @param cfg - 已加载配置（`port` 进 LAN 地址；`relay` 启用时其 `url` 随码出）
 * @returns Promise，resolve 为出码结果（`code` 8 位数字、`expiresAt` 绝对毫秒、
 *   `serverId` UUID 文本、`lanUrl` 形如 `ws://<LAN IP>:<port>`、`relayUrl` 仅 relay 启用时
 *   存在——S3 手机端按有无该键分流直连/拨入）
 * 副作用：写入一行 pairing_codes；server_id 首见时写一行 meta_kv
 */
export async function issuePairing(
  cfg: ServerConfig,
): Promise<{ code: string; expiresAt: number; serverId: string; lanUrl: string; relayUrl?: string }> {
  const db = openDataDb(cfg);
  try {
    const devices = new SqliteDeviceRepository(db);
    const meta = new SqliteMetaRepository(db);
    const { code, expiresAt } = await devices.issuePairingCode();
    const serverId = await ensureServerId(meta);
    return {
      code,
      expiresAt,
      serverId,
      lanUrl: lanUrl(cfg.port, cfg),
      // relay 启用才随码出 relayUrl（结果缺省不含该键——QR payload 形态按启用与否自然分流）。
      ...(cfg.relay === undefined ? {} : { relayUrl: cfg.relay.url }),
    };
  } finally {
    db.close();
  }
}
