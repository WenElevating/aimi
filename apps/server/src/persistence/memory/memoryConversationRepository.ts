import type { AgentEvent, SessionMeta, SessionState } from "@aimi/protocol";
import type { ConversationRepository, SessionRowInput } from "../types.js";

/** 内存态会话行；字段与 sqlite `sessions` 表一一对应。 */
interface StoredSession {
  readonly id: string;
  readonly agentId: string;
  readonly cwd: string;
  readonly permissionMode: SessionRowInput["permissionMode"];
  readonly initialPrompt: string | undefined;
  state: SessionState;
  lastSeq: number;
  readonly createdAt: number;
  updatedAt: number;
}

/** 内存态事件行；seq 为会话内单调序号（首事件 seq=0）。 */
interface StoredEvent {
  readonly seq: number;
  readonly ts: number;
  readonly agentEvent: AgentEvent;
}

/**
 * ConversationRepository 的内存实现（测试专用）。
 * 无 IO、无并发调度：`createSession` 的原子性由同步块天然保证。
 * 契约仍是 async，以便 Sqlite 实现原地替换而调用方零改动。
 */
export class MemoryConversationRepository implements ConversationRepository {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly events = new Map<string, StoredEvent[]>();

  /** 内存态无 schema，no-op。 */
  async init(): Promise<void> {
    /* no-op */
  }

  /**
   * 原子写入会话行与首事件（seq=0，仅当首事件非 null）；state 恒置 starting。
   *
   * @param row - 会话行字段
   * @param initialAgentEvent - 会话首事件；null 表示无首事件
   * @returns Promise，resolve 表示已写入
   */
  async createSession(row: SessionRowInput, initialAgentEvent: AgentEvent | null): Promise<void> {
    const now = Date.now();
    this.sessions.set(row.id, {
      id: row.id,
      agentId: row.agentId,
      cwd: row.cwd,
      permissionMode: row.permissionMode,
      initialPrompt: row.initialPrompt,
      state: "starting",
      lastSeq: 0,
      createdAt: now,
      updatedAt: now,
    });
    this.events.set(
      row.id,
      initialAgentEvent === null ? [] : [{ seq: 0, ts: now, agentEvent: initialAgentEvent }],
    );
  }

  /**
   * 按显式 seq 落库（seq 的分配权威在 EventBus，本仓储只执行写入）：
   * 存入后按 seq 升序归位（`getEvents` 恒按 seq 升序），回写 `lastSeq=seq` 与 `updatedAt=ts`。
   * 会话不存在抛 `session not found: <sessionId>`；乱序/重复 seq 不做容错（权威在调用方）。
   *
   * @param sessionId - 目标会话
   * @param seq - 事件序号，由 EventBus 统一分配
   * @param agentEvent - 归一化后的 agent 事件
   * @param ts - 事件发出时刻（毫秒）
   * @returns Promise，resolve 表示已写入
   * @throws 会话不存在时抛出 `session not found: <sessionId>`
   */
  async appendEvent(sessionId: string, seq: number, agentEvent: AgentEvent, ts: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error("session not found: " + sessionId);
    const rows = this.events.get(sessionId) ?? [];
    rows.push({ seq, ts, agentEvent });
    rows.sort((a, b) => a.seq - b.seq);
    this.events.set(sessionId, rows);
    session.lastSeq = seq;
    session.updatedAt = ts;
  }

  /**
   * 宽松读：会话不存在返回 []（重放目标可能已被清理）。
   *
   * @param sessionId - 目标会话
   * @param opts - 可选过滤：`sinceSeq` 为排他下界，`limit` 限制条数
   * @returns Promise，resolve 为事件数组（按 seq 升序）；会话不存在时为空数组
   */
  async getEvents(
    sessionId: string,
    opts?: { sinceSeq?: number; limit?: number },
  ): Promise<{ seq: number; ts: number; agentEvent: AgentEvent }[]> {
    const sinceSeq = opts?.sinceSeq;
    const rows = this.events.get(sessionId) ?? [];
    let picked = sinceSeq === undefined ? rows : rows.filter((r) => r.seq > sinceSeq);
    const limit = opts?.limit;
    if (limit !== undefined) picked = picked.slice(0, limit);
    return picked.map((r) => ({ seq: r.seq, ts: r.ts, agentEvent: r.agentEvent }));
  }

  /**
   * createdAt 升序保证 welcome 帧的顺序稳定（不随 Map 插入序漂移）。
   *
   * @returns Promise，resolve 为会话元数据数组（按 createdAt 升序）
   */
  async listSessions(): Promise<SessionMeta[]> {
    return [...this.sessions.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => ({
        id: s.id,
        agentId: s.agentId,
        cwd: s.cwd,
        permissionMode: s.permissionMode,
        state: s.state,
        lastSeq: s.lastSeq,
        // 内存行尚无 resume_hint 投影，暂断言"不可续接"；Task 3 内存仓储接真实 hint 后改真值
        resumable: false,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));
  }

  /**
   * 仅做增量更新：patch 未提供的字段保持原值。
   *
   * @param id - 目标会话
   * @param patch - 只包含需要改动的字段
   * @returns Promise，resolve 表示已更新
   * @throws 会话不存在时抛出 `session not found: <id>`
   */
  async updateSession(id: string, patch: { state?: SessionState; lastSeq?: number }): Promise<void> {
    const session = this.sessions.get(id);
    if (session === undefined) throw new Error("session not found: " + id);
    if (patch.state !== undefined) session.state = patch.state;
    if (patch.lastSeq !== undefined) session.lastSeq = patch.lastSeq;
    session.updatedAt = Date.now();
  }

  /** 内存态无资源可释放；no-op。 */
  async close(): Promise<void> {
    /* no-op */
  }
}
