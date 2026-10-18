import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AuditEntry,
  AuditRepository,
  CommandDedupRepository,
  DeviceRecord,
  DeviceRepository,
  MetaRepository,
  ProcessLedgerRepository,
} from "../types.js";
import { PAIRING_CODE_MAX_RETRIES, PAIRING_TTL_MS, randomPairingCode } from "../pairingCode.js";
import { openMigrated } from "./migrate.js";

/** 共享连接类型：与 `openMigrated` 的返回同型。 */
type Db = Database.Database;

/** `devices` 行（snake_case 列）。 */
interface DeviceRow {
  readonly id: string;
  readonly name: string;
  readonly last_seen_at: number;
  readonly revoked_at: number | null;
}

/** `session_processes` 行（snake_case 列）。 */
interface ProcessRow {
  readonly session_id: string;
  readonly pid: number;
  readonly started_at: number;
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
 * 配对码落 `pairing_codes` 表——CLI `aimi-server pair` 与运行服务跨进程共库消费（review §3.3）。
 * 连接由构造注入（与其它仓储共享同一 `db`），故 `close()` 不关闭连接。
 */
export class SqliteDeviceRepository implements DeviceRepository {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly code: () => string;

  /**
   * @param db - 已迁移的连接（通常来自 `openMigrated`）；生命周期由注入方持有
   * @param opts - 测试注入口：`now` 可控时钟（markSeen/配对期限断言用）、`code` stub 码源
   *   （唯一冲突重试路径用）；缺省取系统时钟与 crypto 随机，生产零感知
   */
  constructor(db: Db, opts?: { now?: () => number; code?: () => string }) {
    this.db = db;
    this.now = opts?.now ?? Date.now;
    this.code = opts?.code ?? randomPairingCode;
  }

  /** 表由 `openMigrated` 统一建好，故此处 no-op（幂等）。 */
  async init(): Promise<void> {
    /* no-op：schema 在 openMigrated 中一次性执行 */
  }

  /**
   * 登记设备并返回生成的 deviceId（uuid，落库前生成，不依赖自增）。
   * 同一哈希二次登记由 UNIQUE 约束拒绝（一次配对一次登记）。
   *
   * @param name - 设备展示名
   * @param tokenSha256 - 令牌的 SHA-256 十六进制哈希
   * @returns Promise，resolve 为新设备的 deviceId
   * @throws 该哈希已登记过时抛出（错误消息带哈希以便定位）
   */
  async put(name: string, tokenSha256: string): Promise<string> {
    const id = randomUUID();
    try {
      this.db
        .prepare("INSERT INTO devices (id, name, token_sha256, revoked_at, last_seen_at) VALUES (?, ?, ?, NULL, ?)")
        .run(id, name, tokenSha256, this.now());
    } catch (err) {
      if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new Error("device token already registered: " + tokenSha256);
      }
      throw err;
    }
    return id;
  }

  /**
   * 命中且未吊销才返回；已吊销等同不存在（认证入口只需一个 null 分支）。
   *
   * @param tokenSha256 - 令牌的 SHA-256 十六进制哈希
   * @returns Promise，resolve 为命中的设备（id/name）；未命中或已吊销时为 null
   */
  async findByTokenHash(tokenSha256: string): Promise<{ id: string; name: string } | null> {
    const row = this.db
      .prepare("SELECT id, name FROM devices WHERE token_sha256 = ? AND revoked_at IS NULL")
      .get(tokenSha256) as { id: string; name: string } | undefined;
    return row ?? null;
  }

  /**
   * 置 revoked_at=Date.now()；未知 id 静默 no-op。
   *
   * @param deviceId - 目标设备
   * @returns Promise，resolve 表示更新已执行（未知 id 亦 resolve）
   */
  async revoke(deviceId: string): Promise<void> {
    this.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(this.now(), deviceId);
  }

  /**
   * 全量设备记录，不区分吊销状态（由消费方过滤）；投影带 `revokedAt` 供渲染/巡检。
   *
   * @returns Promise，resolve 为设备记录数组
   */
  async list(): Promise<DeviceRecord[]> {
    const rows = this.db
      .prepare("SELECT id, name, last_seen_at, revoked_at FROM devices")
      .all() as DeviceRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      lastSeenAt: r.last_seen_at,
      revokedAt: r.revoked_at ?? null,
    }));
  }

  /**
   * 更新最近活跃时刻；未知 id 静默 no-op（UPDATE 0 行）。
   *
   * @param deviceId - 目标设备
   * @returns Promise，resolve 表示更新已执行（未知 id 亦 resolve）
   */
  async markSeen(deviceId: string): Promise<void> {
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(this.now(), deviceId);
  }

  /**
   * 身份到投影的解析（**不隐藏吊销行**——吊销巡检与设备列表都要读 `revokedAt`）。
   *
   * @param deviceId - 目标设备
   * @returns Promise，resolve 为设备投影；未登记时为 null
   */
  async findById(deviceId: string): Promise<{ id: string; name: string; revokedAt: number | null } | null> {
    const row = this.db.prepare("SELECT id, name, revoked_at FROM devices WHERE id = ?").get(deviceId) as
      | { id: string; name: string; revoked_at: number | null }
      | undefined;
    return row === undefined ? null : { id: row.id, name: row.name, revokedAt: row.revoked_at ?? null };
  }

  /**
   * 签发配对码：随机 8 位数字 + 绝对过期时刻（签发时刻 + `PAIRING_TTL_MS`）。
   * 同码 UNIQUE 冲突（跨进程两发撞码、stub 注入）换码重试至上限；生产 10^8 空间碰撞概率可忽略，
   * 重试只是一致性兜底。主键与 UNIQUE 的 SQLite 扩展码不同名（`SQLITE_CONSTRAINT_PRIMARYKEY` /
   * `..._UNIQUE`），按公共前缀识别——行内对本 INSERT 只可能出现"code 重复"一类约束冲突。
   *
   * @param opts - `now` 注入时钟（测试）；缺省取系统时钟
   * @returns Promise，resolve 为新码与绝对过期时刻（毫秒）
   * @throws 冲突重试耗尽时抛出（码空间被 stub 病态占满的情形）
   */
  async issuePairingCode(opts?: { now?: () => number }): Promise<{ code: string; expiresAt: number }> {
    const at = (opts?.now ?? this.now)();
    const expiresAt = at + PAIRING_TTL_MS;
    const insert = this.db.prepare(
      "INSERT INTO pairing_codes (code, created_at, expires_at, used_at) VALUES (?, ?, ?, NULL)",
    );
    for (let attempt = 0; attempt <= PAIRING_CODE_MAX_RETRIES; attempt++) {
      const code = this.code();
      try {
        insert.run(code, at, expiresAt);
        return { code, expiresAt };
      } catch (err) {
        if ((err as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT") !== true) throw err;
        // 同码撞约束：换一码重试（上限见 PAIRING_CODE_MAX_RETRIES 的 why 注释）
      }
    }
    throw new Error("pairing code collision persisted");
  }

  /**
   * 核销配对码：先 SELECT 预判（unknown/expired/used，供错误文案与限速计数），
   * 再原子 UPDATE `… WHERE used_at IS NULL AND expires_at > now` 由**影响行数**裁定并发——
   * 影响 0 行而预判为可核销 ⇒ 核销窗口内必有另一进程先到（跨进程 CLI/服务共库），收敛 "used"。
   *
   * @param code - 待核销的配对码
   * @param opts - `now` 注入时钟（测试）；缺省取系统时钟
   * @returns Promise，resolve 为 "ok" | "unknown" | "expired" | "used"
   */
  async consumePairingCode(code: string, opts?: { now?: () => number }): Promise<"ok" | "unknown" | "expired" | "used"> {
    const at = (opts?.now ?? this.now)();
    const row = this.db.prepare("SELECT expires_at, used_at FROM pairing_codes WHERE code = ?").get(code) as
      | { expires_at: number; used_at: number | null }
      | undefined;
    if (row === undefined) return "unknown";
    if (row.used_at !== null) return "used"; // 预判只定文案，裁定权在下方 UPDATE
    if (row.expires_at <= at) return "expired";
    const info = this.db
      .prepare("UPDATE pairing_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?")
      .run(at, code, at);
    // 预判 ok 却打空行：并发双消费（或过期边际恰好跨过时钟）→ 统一按"已被兑现"报告
    return info.changes === 1 ? "ok" : "used";
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
   * @param db - 已迁移的连接（通常来自 `openMigrated`）；生命周期由注入方持有
   */
  constructor(private readonly db: Db) {}

  /** 表由 `openMigrated` 统一建好，故此处 no-op（幂等）。 */
  async init(): Promise<void> {
    /* no-op：schema 在 openMigrated 中一次性执行 */
  }

  /**
   * 首次见到 clientId 返回 true；重复返回 false（changes=0 即被约束挡住）。
   *
   * @param clientId - 手机为每条写命令生成的幂等键
   * @returns Promise，resolve 为 true 表示首次见到（放行），false 表示重复（丢弃）
   */
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
   * @param db - 已迁移的连接（通常来自 `openMigrated`）；生命周期由注入方持有
   */
  constructor(private readonly db: Db) {}

  /** 表由 `openMigrated` 统一建好，故此处 no-op（幂等）。 */
  async init(): Promise<void> {
    /* no-op：schema 在 openMigrated 中一次性执行 */
  }

  /**
   * 追加一条审计；排序键由库自增，调用方不感知。
   *
   * @param entry - 待写入的审计条目
   * @returns Promise，resolve 表示已写入
   */
  async record(entry: AuditEntry): Promise<void> {
    this.db
      .prepare("INSERT INTO audit (ts, device_id, session_id, action, detail) VALUES (?, ?, ?, ?, ?)")
      .run(entry.ts, entry.deviceId, entry.sessionId, entry.action, entry.detail);
  }

  /**
   * 按 audit_seq 倒序取最近 n 条（最新在前）。
   *
   * @param n - 取用条数；<= 0 时返回空数组
   * @returns Promise，resolve 为审计条目数组（最新在前）
   */
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

/**
 * MetaRepository 的 SQLite 实现（meta_kv 基础键值，跨进程单例标记面）。
 * 连接由构造注入（与其它仓储共享同一 `db`），故 `close()` 不关闭连接。
 */
export class SqliteMetaRepository implements MetaRepository {
  /**
   * @param db - 已迁移的连接（通常来自 `openMigrated`）；生命周期由注入方持有
   */
  constructor(private readonly db: Db) {}

  /** 表由 `openMigrated` 统一建好（meta_kv 为 M0 起始表），故此处 no-op（幂等）。 */
  async init(): Promise<void> {
    /* no-op：schema 在 openMigrated 中一次性执行 */
  }

  /**
   * 键点查；不存在返回 null（宽松读——"从未写过"即 null，调用方单分支处理）。
   *
   * @param key - 稳定标记键
   * @returns Promise，resolve 为键值文本；不存在时为 null
   */
  async get(key: string): Promise<string | null> {
    const row = this.db.prepare("SELECT value FROM meta_kv WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /**
   * 键写入（UPSERT：`ON CONFLICT(key)` 覆盖旧值，标记语义取最新时点）。
   *
   * @param key - 稳定标记键
   * @param value - 键值文本
   * @returns Promise，resolve 表示已落库
   */
  async set(key: string, value: string): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO meta_kv (key, value) VALUES (?, ?)" +
          " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /** 连接由注入方持有：此处 no-op，避免误关共享 db。 */
  async close(): Promise<void> {
    /* no-op：连接归注入方所有 */
  }
}

/**
 * ProcessLedgerRepository 的 SQLite 实现（子进程台账，session/ 域消费）。
 * `session_processes` 一行一会话：register 走 UPSERT（同会话重拉覆盖 pid/started_at），
 * dispose 后 clear 撤销——孤儿清点只对"落库滞留"的行负责（F5 防线）。
 * 连接可自建（`openMigrated`）或注入共享 `db`；自建模式下 `close()` 负责关闭。
 */
export class SqliteProcessLedgerRepository implements ProcessLedgerRepository {
  private db: Db;
  private readonly ownsDb: boolean;
  private closed = false;

  /**
   * @param source - 库文件路径（内部 `openMigrated`：开 WAL + 幂等建表）或已迁移的连接
   *   （与其它仓储共享同一 `db` 时注入；注入模式下本类不负责关闭）
   */
  constructor(source: string | Db) {
    if (typeof source === "string") {
      this.db = openMigrated(source);
      this.ownsDb = true;
    } else {
      this.db = source;
      this.ownsDb = false;
    }
  }

  /** 表由构造期的 `openMigrated` 幂等建好（自建模式）；注入模式下由注入方保证，故此处 no-op。 */
  async init(): Promise<void> {
    /* no-op：schema 在 openMigrated 中一次性执行 */
  }

  /**
   * 登记（首见）或覆盖（同会话重拉）：`ON CONFLICT(session_id)` 把"一行一会话"交给约束，
   * 不先查后写——两条注册链并发时后到者同样胜出，无读改写竞态。
   *
   * @param sessionId - 目标会话
   * @param pid - agent 子进程号
   * @returns Promise，resolve 表示已落库
   */
  async register(sessionId: string, pid: number): Promise<void> {
    this.requireDb()
      .prepare(
        "INSERT INTO session_processes (session_id, pid, started_at) VALUES (?, ?, ?)" +
          " ON CONFLICT(session_id) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at",
      )
      .run(sessionId, pid, Date.now());
  }

  /**
   * 撤销台账行（dispose 收尸后调用）；未知 sessionId 静默 no-op（DELETE 0 行）。
   *
   * @param sessionId - 目标会话
   * @returns Promise，resolve 表示已撤销
   */
  async clear(sessionId: string): Promise<void> {
    this.requireDb().prepare("DELETE FROM session_processes WHERE session_id = ?").run(sessionId);
  }

  /**
   * 全量台账行，按 `started_at` 升序、sessionId 同序仲裁（清点顺序确定化仅利于测试断言，
   * 行集合才是清点关心的事实）。
   *
   * @returns Promise，resolve 为台账行数组
   */
  async list(): Promise<{ sessionId: string; pid: number }[]> {
    const rows = this.requireDb()
      .prepare("SELECT session_id, pid, started_at FROM session_processes ORDER BY started_at ASC, session_id ASC")
      .all() as ProcessRow[];
    return rows.map((r) => ({ sessionId: r.session_id, pid: r.pid }));
  }

  /**
   * 关闭连接（仅自建模式；注入模式由注入方持有连接，此处不动以免误关共享 db）。
   *
   * @returns Promise，resolve 表示连接已关闭（注入模式或已关闭时立即 resolve）
   */
  async close(): Promise<void> {
    if (!this.ownsDb || this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** close 后再调用即编程错误：早失败好过静默用坏连接。 */
  private requireDb(): Db {
    if (this.closed) throw new Error("sqlite connection closed");
    return this.db;
  }
}
