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
 * §7 预算：落库吞吐 ≥ 500 events/s。
 * 断言的是**顺序 await 单条写**的速率——即真实 appendEvent 路径（每事件一个事务），
 * 不是批量的乐观上限：预算一旦失守，说明持久性实现退化。
 */
describe("落库吞吐（§7 预算）", () => {
  it("≥ 500 events/s（1000 次顺序 append，临时库）", async () => {
    await repo.init();
    await repo.createSession({ id: "s1", agentId: "claude", cwd: dir, permissionMode: "default" }, null);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      await repo.appendEvent("s1", { type: "text_delta", text: "x".repeat(512) }, i);
    }
    const rate = 1000 / ((performance.now() - t0) / 1000);
    // eslint 无关：实测值写进任务报告，console 输出留作 CI 日志证据。
    console.log(`[bench] appendEvent 实测 ${rate.toFixed(0)} events/s（1000 条顺序事务写）`);
    expect(rate).toBeGreaterThanOrEqual(500);
  }, 60_000);
});
