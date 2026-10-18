import { describe, expect, it } from "vitest";
import { PairingLimiter } from "./pairingLimiter.js";

/**
 * 受控时钟：测试自行推进虚拟时间，断言不依赖系统定时器粒度（计划 §3.8 Windows 定时器口径）。
 *
 * @param start - 起始时刻（毫秒）
 * @returns `now` 读取与 `advance` 推进两个把手
 */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

describe("PairingLimiter（配对提交失败限速）", () => {
  it("到线拒：窗内第 1..8 次失败放行，第 9 次起拒绝", () => {
    const c = clock();
    const limiter = new PairingLimiter({ now: c.now });
    for (let i = 0; i < 8; i++) {
      expect(limiter.allow("r")).toBe(true);
      limiter.fail("r");
    }
    expect(limiter.allow("r")).toBe(false);
    // 拒绝是持续状态：不 fail 也继续拒（额度只在窗口滑过后恢复）。
    expect(limiter.allow("r")).toBe(false);
  });

  it("滚动窗口：最早的失败滑出窗口后重新放行", () => {
    const c = clock();
    const limiter = new PairingLimiter({ now: c.now });
    for (let i = 0; i < 8; i++) limiter.fail("r");
    expect(limiter.allow("r")).toBe(false);
    c.advance(600_000); // 差值恰等于窗口：now - t < window 判据下不算窗内 → 全部过期
    expect(limiter.allow("r")).toBe(true);
  });

  it("部分滑出：滑出一次即腾出一个名额", () => {
    const c = clock();
    const limiter = new PairingLimiter({ now: c.now });
    for (let i = 0; i < 8; i++) limiter.fail("r");
    expect(limiter.allow("r")).toBe(false);
    c.advance(100);
    limiter.fail("r"); // 第 9 次失败本身已不可能被 allow 放行，但 fail 面仍记账
    c.advance(600_000 - 100); // 最早一批滑出，仅最后一次（t0+100）仍在窗内
    expect(limiter.allow("r")).toBe(true);
    c.advance(100);
    expect(limiter.allow("r")).toBe(true); // 最后一批也滑出
  });

  it("key 隔离：一个远端到线不影响其它远端", () => {
    const c = clock();
    const limiter = new PairingLimiter({ now: c.now });
    for (let i = 0; i < 8; i++) limiter.fail("10.0.0.1");
    expect(limiter.allow("10.0.0.1")).toBe(false);
    expect(limiter.allow("10.0.0.2")).toBe(true);
  });

  it("成功不计：只读 allow 不消耗额度（无 fail 时反复询问恒放行）", () => {
    const c = clock();
    const limiter = new PairingLimiter({ now: c.now });
    for (let i = 0; i < 20; i++) expect(limiter.allow("r")).toBe(true);
  });

  it("自定义 windowMs/max 生效（含同一边界判据）", () => {
    const c = clock();
    const limiter = new PairingLimiter({ windowMs: 100, max: 2, now: c.now });
    expect(limiter.allow("r")).toBe(true);
    limiter.fail("r");
    expect(limiter.allow("r")).toBe(true);
    limiter.fail("r");
    expect(limiter.allow("r")).toBe(false);
    c.advance(100);
    expect(limiter.allow("r")).toBe(true);
  });
});
