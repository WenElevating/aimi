import type { AgentEvent, SessionMeta, SessionState } from "@aimi/protocol";
import type { ConversationRepository, SessionRowInput } from "../types.js";

/** 内存态会话行；字段与 sqlite `sessions` 表一一对应（Task 5 同契约）。 */
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
 * 契约仍是 async，以便 Task 5 的 Sqlite 实现原地替换而调用方零改动。
 */
export class MemoryConversationRepository implements ConversationRepository {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly events = new Map<string, StoredEvent[]>();

  /** 内存态无 schema，no-op。 */
  async init(): Promise<void> {
    /* no-op */
  }

  /** 原子写入会话行 + 首事件（seq=0，仅当 initialAgentEvent 非 null）。state 恒置 starting。 */
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

  /** seq = lastSeq + 1（读改写同一会话，内存下同步完成）；回写 lastSeq 与 updatedAt=ts。 */
  async appendEvent(sessionId: string, agentEvent: AgentEvent, ts: number): Promise<number> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error("session not found: " + sessionId);
    const seq = session.lastSeq + 1;
    const rows = this.events.get(sessionId) ?? [];
    rows.push({ seq, ts, agentEvent });
    this.events.set(sessionId, rows);
    session.lastSeq = seq;
    session.updatedAt = ts;
    return seq;
  }

  /** 宽松读：会话不存在返回 []（重放目标可能已被清理）。 */
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

  /** createdAt 升序保证 welcome 帧的顺序稳定（不随 Map 插入序漂移）。 */
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
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));
  }

  /** 仅做增量更新：patch 未提供的字段保持原值。 */
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
