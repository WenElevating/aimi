import type { CommandDedupRepository } from "../types.js";

/**
 * CommandDedupRepository 的内存实现（测试专用）。
 * 进程内 `Set` 实现异常 #7 的写入幂等：同一 clientId 只认第一次。
 */
export class MemoryCommandDedupRepository implements CommandDedupRepository {
  private readonly seen = new Set<string>();

  /** 内存态无 schema，no-op。 */
  async init(): Promise<void> {
    /* no-op */
  }

  /** 先查后插（内存下同步，无竞态）：首次 true，重复 false。 */
  async putIfAbsent(clientId: string): Promise<boolean> {
    if (this.seen.has(clientId)) return false;
    this.seen.add(clientId);
    return true;
  }

  /** 内存态无资源可释放；no-op。 */
  async close(): Promise<void> {
    /* no-op */
  }
}
