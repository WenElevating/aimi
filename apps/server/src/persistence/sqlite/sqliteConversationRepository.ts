import type { AgentEvent, SessionMeta, SessionState } from "@aimi/protocol";
import type Database from "better-sqlite3";
import type { ConversationRepository, SessionRowInput } from "../types.js";
import { openMigrated } from "./migrate.js";

/** 连接类型：借用 `openMigrated` 的返回签名，替身连接与生产连接同一类型。 */
type Db = Database.Database;

/** `sessions` 行（snake_case 列）→ 读取用投影。 */
interface SessionRow {
  readonly id: string;
  readonly agent_id: string;
  readonly cwd: string;
  readonly permission_mode: string;
  readonly state: string;
  readonly last_seq: number;
  readonly created_at: number;
  readonly updated_at: number;
}

/** `events` 行：payload 为 agent 事件的 JSON 文本（重放即点查）。 */
interface EventRow {
  readonly seq: number;
  readonly ts: number;
  readonly payload: string;
}

/**
 * ConversationRepository 的 SQLite 实现（唯一能写 sessions/events 的表）。
 *
 * 持久性：WAL + `synchronous=NORMAL`，**每次 appendEvent 一个独立事务**——
 * `await appendEvent` 返回即已落库（崩溃零丢失窗口），不依赖任何后台 flush。
 * 所有方法体同步执行（better-sqlite3 同步 API），async 仅是与契约同形。
 * **seq 的分配权威在 EventBus**：本仓储按调用方给出的显式 seq 写入，不再读改写 `last_seq` 分配序号，
 * 因此不存在序号分配竞态；seq 重复由 `(session_id, seq)` 主键拦截。
 */
export class SqliteConversationRepository implements ConversationRepository {
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
   * 原子写入会话行与首事件（seq=0，仅当首事件非 null）；state 恒置 starting。
   *
   * @param row - 会话行字段
   * @param initialAgentEvent - 会话首事件；null 表示无首事件
   * @returns Promise，resolve 表示已落库
   * @throws 会话 id 已存在时抛出 `session already exists: <id>`——重复建会话是调用方 bug，静默覆盖会丢事件
   */
  async createSession(row: SessionRowInput, initialAgentEvent: AgentEvent | null): Promise<void> {
    const db = this.requireDb();
    const now = Date.now();
    const exists = db.prepare("SELECT 1 FROM sessions WHERE id = ?");
    const insertSession = db.prepare(
      "INSERT INTO sessions (id, agent_id, cwd, permission_mode, state, last_seq, initial_prompt, created_at, updated_at)" +
        " VALUES (?, ?, ?, ?, 'starting', 0, ?, ?, ?)",
    );
    const insertEvent = db.prepare("INSERT INTO events (session_id, seq, ts, payload) VALUES (?, 0, ?, ?)");
    // 探重与两条 INSERT 同一事务：检查-写入不可分割，失败整体回滚。
    db.transaction(() => {
      if (exists.get(row.id) !== undefined) throw new Error("session already exists: " + row.id);
      insertSession.run(row.id, row.agentId, row.cwd, row.permissionMode, row.initialPrompt ?? null, now, now);
      if (initialAgentEvent !== null) insertEvent.run(row.id, now, JSON.stringify(initialAgentEvent));
    })();
  }

  /**
   * 按显式 seq 追加事件（seq 的分配权威在 EventBus）：单事务内 INSERT + `UPDATE sessions SET last_seq=?, updated_at=ts`，
   * `(session_id, seq)` 主键冲突即编程错误，由 better-sqlite3 自然抛出（不做容错）。
   *
   * @param sessionId - 目标会话
   * @param seq - 事件序号，由 EventBus 统一分配
   * @param agentEvent - 归一化后的 agent 事件
   * @param ts - 事件发出时刻（毫秒）
   * @returns Promise，resolve 表示事件与 `last_seq`、`updated_at` 已同事务落库
   * @throws 会话不存在时抛出 `session not found: <sessionId>`；seq 冲突时抛出底层约束错误
   */
  async appendEvent(sessionId: string, seq: number, agentEvent: AgentEvent, ts: number): Promise<void> {
    const db = this.requireDb();
    const exists = db.prepare("SELECT 1 FROM sessions WHERE id = ?");
    const insertEvent = db.prepare("INSERT INTO events (session_id, seq, ts, payload) VALUES (?, ?, ?, ?)");
    const bumpSession = db.prepare("UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?");
    db.transaction(() => {
      if (exists.get(sessionId) === undefined) throw new Error("session not found: " + sessionId);
      insertEvent.run(sessionId, seq, ts, JSON.stringify(agentEvent));
      bumpSession.run(seq, ts, sessionId);
    })();
  }

  /**
   * seq 升序点查：`sinceSeq` 为排他下界（默认 -1，故首事件 seq=0 也在内），`limit` 为条数上限。
   * 会话不存在返回 []（宽松读：重放目标可能已被清理）。`limit <= 0` 视为 0 条。
   *
   * @param sessionId - 目标会话
   * @param opts - 可选过滤：`sinceSeq` 排他下界（缺省 -1，故首事件 seq=0 也在内），`limit` 条数上限
   * @returns Promise，resolve 为事件数组（按 seq 升序）；会话不存在时为空数组
   */
  async getEvents(
    sessionId: string,
    opts?: { sinceSeq?: number; limit?: number },
  ): Promise<{ seq: number; ts: number; agentEvent: AgentEvent }[]> {
    const db = this.requireDb();
    const sinceSeq = opts?.sinceSeq ?? -1;
    const limit = opts?.limit === undefined ? -1 : Math.max(0, opts.limit);
    const rows = db
      .prepare("SELECT seq, ts, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
      .all(sessionId, sinceSeq, limit) as EventRow[];
    return rows.map((r) => ({ seq: r.seq, ts: r.ts, agentEvent: JSON.parse(r.payload) as AgentEvent }));
  }

  /**
   * 全量会话元数据，created_at 升序（welcome 帧据此恢复红点/断线补齐）。
   *
   * @returns Promise，resolve 为会话元数据数组（按 createdAt 升序）
   */
  async listSessions(): Promise<SessionMeta[]> {
    const db = this.requireDb();
    const rows = db
      .prepare(
        "SELECT id, agent_id, cwd, permission_mode, state, last_seq, created_at, updated_at" +
          " FROM sessions ORDER BY created_at ASC",
      )
      .all() as SessionRow[];
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      cwd: r.cwd,
      permissionMode: r.permission_mode as SessionRowInput["permissionMode"],
      state: r.state as SessionState,
      lastSeq: r.last_seq,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * 增量更新：patch 未提供的列保持原值（COALESCE 语义），updated_at 恒置 Date.now()。
   *
   * @param id - 目标会话
   * @param patch - 只包含需要改动的字段
   * @returns Promise，resolve 表示已更新
   * @throws 会话不存在时抛出 `session not found: <id>`
   */
  async updateSession(id: string, patch: { state?: SessionState; lastSeq?: number }): Promise<void> {
    const db = this.requireDb();
    if (db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id) === undefined) {
      throw new Error("session not found: " + id);
    }
    db.prepare(
      "UPDATE sessions SET state = COALESCE(?, state), last_seq = COALESCE(?, last_seq), updated_at = ? WHERE id = ?",
    ).run(patch.state ?? null, patch.lastSeq ?? null, Date.now(), id);
  }

  /**
   * 关闭连接（仅自建模式；注入模式由注入方持有连接，此处不动以免误关共享 db）。
   * 重复调用无副作用。
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
