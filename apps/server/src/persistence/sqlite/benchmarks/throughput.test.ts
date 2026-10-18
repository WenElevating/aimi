import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteConversationRepository } from "../sqliteConversationRepository.js";

let dir: string;
let repo: SqliteConversationRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aimi-bench-"));
  repo = new SqliteConversationRepository(join(dir, "bench.db"));
});

// 先关连接再删目录：Windows 上悬挂的 -wal/-shm 句柄会让 rmSync 失败。
afterEach(async () => {
  await repo.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 性能预算：落库吞吐 ≥ 500 events/s。
 * 断言的是**顺序 await 单条写**的速率——即真实 appendEvent 路径（每事件一个事务），
 * 不是批量的乐观上限：预算一旦失守，说明持久性实现退化。
 */
describe("落库吞吐（§7 预算）", () => {
  it("≥ 500 events/s（1000 次顺序 append，临时库）", async () => {
    await repo.init();
    await repo.createSession({ id: "s1", agentId: "claude", cwd: dir, permissionMode: "default" }, null);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      await repo.appendEvent("s1", i, { type: "text_delta", text: "x".repeat(512) }, i);
    }
    const rate = 1000 / ((performance.now() - t0) / 1000);
    // 实测速率随 console 输出留作 CI 日志证据。
    console.log(`[bench] appendEvent 实测 ${rate.toFixed(0)} events/s（1000 条顺序事务写）`);
    expect(rate).toBeGreaterThanOrEqual(500);
  }, 60_000);

  /**
   * 重放读回吞吐 ≥ 500 events/s（M0 补发断言口径）。
   * 断言的是**重放编排的读路径**：sinceSeq 游标 + limit 500 分页点查循环取完（Application
   * `#replayGap` 同口径）。**环境预算注释**：预算针对本机磁盘（Windows CI / 本地 NVMe），
   * 与写吞吐同源——低于 500/s 先查 WAL/事务配置再看硬件；真机 NAS/网络盘不在本断言范围。
   */
  it("重放读回 ≥ 500 events/s（预灌 1000 行，分页 500 点查取完）", async () => {
    await repo.init();
    await repo.createSession({ id: "s1", agentId: "claude", cwd: dir, permissionMode: "default" }, null);
    // 预灌走生产同款 appendEvent（每事件一事务）：写成本已被上一用例钉在 ≥500/s，1000 行 ≤2s。
    for (let i = 0; i < 1000; i++) {
      await repo.appendEvent("s1", i, { type: "text_delta", text: "x".repeat(512) }, i);
    }
    const t0 = performance.now();
    let total = 0;
    let sinceSeq = -1; // -1 = 全量含首事件（与 getEvents 缺省同口径）
    for (;;) {
      const rows = await repo.getEvents("s1", { sinceSeq, limit: 500 });
      if (rows.length === 0) break;
      total += rows.length;
      sinceSeq = rows[rows.length - 1]!.seq;
    }
    const rate = total / ((performance.now() - t0) / 1000);
    console.log(`[bench] 重放读回实测 ${rate.toFixed(0)} events/s（${total} 条，分页 500）`);
    expect(total).toBe(1000); // 循环取完：分页边界（500/500/...）不丢行
    expect(rate).toBeGreaterThanOrEqual(500);
  }, 60_000);
});
