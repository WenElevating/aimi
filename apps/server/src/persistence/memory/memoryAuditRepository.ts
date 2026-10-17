import type { AuditEntry, AuditRepository } from "../types.js";

/** 内存态审计行：包住 AuditEntry 并附自增排序键。 */
interface StoredAudit {
  readonly auditSeq: number;
  readonly entry: AuditEntry;
}

/**
 * AuditRepository 的内存实现（测试专用）。
 * 数组 + 自增 `auditSeq`：`recent` 按写序倒序取 n 条，与 sqlite 的 `ORDER BY audit_seq DESC` 同语义。
 */
export class MemoryAuditRepository implements AuditRepository {
  private readonly rows: StoredAudit[] = [];
  private nextSeq = 1;

  /** 内存态无 schema，no-op。 */
  async init(): Promise<void> {
    /* no-op */
  }

  /** 追加即写序；auditSeq 递增保证同毫秒内的先后仍可区分。 */
  async record(entry: AuditEntry): Promise<void> {
    this.rows.push({ auditSeq: this.nextSeq++, entry });
  }

  /** 最新在前；n<=0 返回 []（避免 slice(-0) 退化为全量）。 */
  async recent(n: number): Promise<AuditEntry[]> {
    if (n <= 0) return [];
    return this.rows
      .slice(-n)
      .reverse()
      .map((r) => r.entry);
  }

  /** 内存态无资源可释放；no-op。 */
  async close(): Promise<void> {
    /* no-op */
  }
}
