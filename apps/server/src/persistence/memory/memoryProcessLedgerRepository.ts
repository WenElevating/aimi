import type { ProcessLedgerRepository } from "../types.js";

/** 内存态台账行；字段与 sqlite `session_processes` 表一一对应。 */
interface StoredProcess {
  readonly sessionId: string;
  pid: number;
  startedAt: number;
}

/**
 * ProcessLedgerRepository 的内存实现（测试专用）。
 * 台账一行一会话：register 即覆盖式登记（重拉场景后到者胜出），与 Sqlite 的 UPSERT 同一语义。
 * `list` 以 startedAt 升序、sessionId 同序仲裁，保证与 Sqlite 实现同一确定序（测试断言依赖）。
 */
export class MemoryProcessLedgerRepository implements ProcessLedgerRepository {
  /** Map 插入序即登记序；同 key 重拉用 set 覆盖旧行（pid/startedAt 同步刷新）。 */
  private readonly processes = new Map<string, StoredProcess>();

  /** 内存态无 schema，no-op。 */
  async init(): Promise<void> {
    /* no-op */
  }

  /**
   * 登记或覆盖（同会话重拉覆盖旧行）；started_at 由实现取 now。
   *
   * @param sessionId - 目标会话
   * @param pid - agent 子进程号
   * @returns Promise，resolve 表示已登记
   */
  async register(sessionId: string, pid: number): Promise<void> {
    this.processes.set(sessionId, { sessionId, pid, startedAt: Date.now() });
  }

  /**
   * 撤销台账行；未知 sessionId 静默 no-op（与 Sqlite 的 DELETE 0 行同口径）。
   *
   * @param sessionId - 目标会话
   * @returns Promise，resolve 表示已撤销
   */
  async clear(sessionId: string): Promise<void> {
    this.processes.delete(sessionId);
  }

  /**
   * 全量台账行（排序同 Sqlite：startedAt 升序、sessionId 仲裁）。
   *
   * @returns Promise，resolve 为台账行数组
   */
  async list(): Promise<{ sessionId: string; pid: number }[]> {
    return [...this.processes.values()]
      .sort((a, b) => a.startedAt - b.startedAt || (a.sessionId < b.sessionId ? -1 : 1))
      .map((p) => ({ sessionId: p.sessionId, pid: p.pid }));
  }

  /** 内存态无资源可释放；no-op。 */
  async close(): Promise<void> {
    /* no-op */
  }
}
