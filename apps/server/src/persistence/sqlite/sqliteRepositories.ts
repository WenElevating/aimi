import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AuditEntry,
  AuditRepository,
  CommandDedupRepository,
  DeviceRecord,
  DeviceRepository,
} from "../types.js";

/** 共享连接类型：与 `openMigrated` 的返回同型。 */
type Db = Database.Database;

/** `devices` 行（snake_case 列）。 */
interface DeviceRow {
  readonly id: string;
  readonly name: string;
  readonly last_seen_at: number;
}

/** `audit` 行；audit_seq 仅用于排序，不进 AuditEntry。 */
interface AuditRow {
  readonly ts: number;
  readonly device_id: string;
  readonly session_id: string | null;
  readonly action: string;
  readonly detail: string;
}

/**
 * DeviceRepository 的 SQLite 实现（auth/ 专用）。
 * 只落库 `tokenSha256`，明文令牌永不进本层（库泄露 ≠ 令牌泄露）。
 * 连接由构造注入（与其它仓储共享同一 `db`），故 `close()` 不关闭连接。
 */
export class SqliteDeviceRepository implements DeviceRepository {
  /**
   * @param db 已迁移的连接（通常来自 `openMigrated`）；生命周期由注入方持有。
   */
  constructor(private readonly db: Db) {}

  /** 表由 `openMigrated` 统一建好，故此处 no-op（幂等）。 */
  async init(): Promise<void> {
    /* no-op：schema 在 openMigrated 中一次性执行 */
  }

  /**
   * 登记设备并返回生成的 deviceId（uuid，落库前生成，不依赖自增）。
   * 同一 `tokenSha256` 二次登记由 UNIQUE 约束拒绝（一次配对一次登记），
   * 错误消息带哈希以便定位。
   */
  async put(name: string, tokenSha256: string): Promise<string> {
    const id = randomUUID();
    try {
      this.db
        .prepare("INSERT INTO devices (id, name, token_sha256, revoked_at, last_seen_at) VALUES (?, ?, ?, NULL, ?)")
        .run(id, name, tokenSha256, Date.now());
    } catch (err) {
      if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new Error("device token already registered: " + tokenSha256);
      }
      throw err;
    }
    return id;
  }

  /** 命中且未吊销才返回；已吊销等同不存在（认证入口只需一个 null 分支）。 */
  async findByTokenHash(tokenSha256: string): Promise<{ id: string; name: string } | null> {
    const row = this.db
      .prepare("SELECT id, name FROM devices WHERE token_sha256 = ? AND revoked_at IS NULL")
      .get(tokenSha256) as { id: string; name: string } | undefined;
    return row ?? null;
  }

  /** 置 revoked_at=Date.now()；未知 id 静默 no-op。 */
  async revoke(deviceId: string): Promise<void> {
    this.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(Date.now(), deviceId);
  }

  /** 全量设备记录，不区分吊销状态（由消费方过滤）。 */
  async list(): Promise<DeviceRecord[]> {
    const rows = this.db.prepare("SELECT id, name, last_seen_at FROM devices").all() as DeviceRow[];
    return rows.map((r) => ({ id: r.id, name: r.name, lastSeenAt: r.last_seen_at }));
  }

  /** 连接由注入方持有：此处 no-op，避免误关共享 db。 */
  async close(): Promise<void> {
    /* no-op：连接归注入方所有 */
  }
}

/**
 * CommandDedupRepository 的 SQLite 实现（手机重发同一 clientId 收敛为一次）。
 * `cmd_dedup.client_id` 为主键，`INSERT OR IGNORE` 把幂等交给约束而非先查后插。
 * 连接由构造注入（与其它仓储共享同一 `db`），故 `close()` 不关闭连接。
 */
export class SqliteCommandDedupRepository implements CommandDedupRepository {
  /**
   * @param db 已迁移的连接（通常来自 `openMigrated`）；生命周期由注入方持有。
   */
  constructor(private readonly db: Db) {}

  /** 表由 `openMigrated` 统一建好，故此处 no-op（幂等）。 */
  async init(): Promise<void> {
    /* no-op：schema 在 openMigrated 中一次性执行 */
  }

  /** 首次见到 clientId 返回 true；重复返回 false（changes=0 即被约束挡住）。 */
  async putIfAbsent(clientId: string): Promise<boolean> {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO cmd_dedup (client_id, ts) VALUES (?, ?)")
      .run(clientId, Date.now());
    return info.changes === 1;
  }

  /** 连接由注入方持有：此处 no-op，避免误关共享 db。 */
  async close(): Promise<void> {
    /* no-op：连接归注入方所有 */
  }
}

/**
 * AuditRepository 的 SQLite 实现（auditlog/ 专用，只增不改）。
 * `audit_seq` 为 AUTOINCREMENT 排序键：同毫秒内的先后仍可区分。
 * 连接由构造注入（与其它仓储共享同一 `db`），故 `close()` 不关闭连接。
 */
export class SqliteAuditRepository implements AuditRepository {
  /**
   * @param db 已迁移的连接（通常来自 `openMigrated`）；生命周期由注入方持有。
   */
  constructor(private readonly db: Db) {}

  /** 表由 `openMigrated` 统一建好，故此处 no-op（幂等）。 */
  async init(): Promise<void> {
    /* no-op：schema 在 openMigrated 中一次性执行 */
  }

  /** 追加一条审计；排序键由库自增，调用方不感知。 */
  async record(entry: AuditEntry): Promise<void> {
    this.db
      .prepare("INSERT INTO audit (ts, device_id, session_id, action, detail) VALUES (?, ?, ?, ?, ?)")
      .run(entry.ts, entry.deviceId, entry.sessionId, entry.action, entry.detail);
  }

  /** 按 audit_seq 倒序取最近 n 条（最新在前）；n<=0 返回 []。 */
  async recent(n: number): Promise<AuditEntry[]> {
    if (n <= 0) return [];
    const rows = this.db
      .prepare("SELECT ts, device_id, session_id, action, detail FROM audit ORDER BY audit_seq DESC LIMIT ?")
      .all(n) as AuditRow[];
    return rows.map((r) => ({
      ts: r.ts,
      deviceId: r.device_id,
      sessionId: r.session_id,
      action: r.action,
      detail: r.detail,
    }));
  }

  /** 连接由注入方持有：此处 no-op，避免误关共享 db。 */
  async close(): Promise<void> {
    /* no-op：连接归注入方所有 */
  }
}
