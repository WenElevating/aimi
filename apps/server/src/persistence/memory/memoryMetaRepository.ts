import type { MetaRepository } from "../types.js";

/**
 * MetaRepository 的内存实现（测试专用）：键值同构 `meta_kv` 表，进程内即终。
 * 无 IO、无并发调度：UPSERT 语义由同步 Map 覆盖天然保证。契约仍是 async，
 * 以便 Sqlite 实现原地替换而调用方零改动。
 */
export class MemoryMetaRepository implements MetaRepository {
  private readonly rows = new Map<string, string>();

  /** 内存态无 schema，no-op。 */
  async init(): Promise<void> {
    /* no-op */
  }

  /**
   * 键点查；宽松读（不存在与从未写过同态 null，与 Sqlite 同口径）。
   *
   * @param key - 稳定标记键
   * @returns Promise，resolve 为键值文本；不存在时为 null
   */
  async get(key: string): Promise<string | null> {
    return this.rows.get(key) ?? null;
  }

  /**
   * 键写入（UPSERT：同键覆盖旧值）。
   *
   * @param key - 稳定标记键
   * @param value - 键值文本
   * @returns Promise，resolve 表示已写入
   */
  async set(key: string, value: string): Promise<void> {
    this.rows.set(key, value);
  }

  /** 内存态无资源可释放；no-op。 */
  async close(): Promise<void> {
    /* no-op */
  }
}
