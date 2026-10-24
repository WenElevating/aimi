import { describe, expect, it } from "vitest";
import { checkIncremental, checkRatchet, normalizePath, parseLcov, round1 } from "./check-coverage.mjs";

/** 覆盖率门禁脚本固定样本：lcov 解析 / 棘轮 / 增量计算三类核心逻辑的对错锚点。 */
describe("check-coverage 核心逻辑固定样本", () => {
  const LCOV_SAMPLE = [
    "TN:",
    "SF:apps/server/src/foo.ts",
    "DA:1,1",
    "DA:2,0",
    "DA:3,1",
    "end_of_record",
    "SF:apps/server/src/bar.ts",
    "DA:1,0",
    "end_of_record",
  ].join("\n");

  it("parseLcov：按文件聚合 DA 明细，行号粒度保留", () => {
    const { byFile } = parseLcov(LCOV_SAMPLE);
    expect(byFile.get("apps/server/src/foo.ts")).toMatchObject({ total: 3, hit: 2 });
    expect(byFile.get("apps/server/src/foo.ts")!.da.get(2)).toBe(0);
    expect(byFile.get("apps/server/src/foo.ts")!.da.get(1)).toBe(1);
    expect(byFile.get("apps/server/src/bar.ts")).toMatchObject({ total: 1, hit: 0 });
  });

  it("normalizePath：Windows 盘符与反斜杠归一", () => {
    expect(normalizePath("D:\\AiProject\\aimi\\apps\\server\\src\\a.ts")).toBe("apps/server/src/a.ts");
    expect(normalizePath("apps/server/src/a.ts")).toBe("apps/server/src/a.ts");
  });

  it("棘轮：任一套件低于基线即失败；相等/高于通过；到期日产出 WARN", () => {
    const baseline = {
      suites: {
        server: { lines: 85.8 },
        mobile: { lines: 59.4, effectiveFrom: "2020-01-01" },
      },
    };
    const down = checkRatchet({ server: { lines: 80 }, mobile: { lines: 59.4 } }, baseline);
    expect(down.ok).toBe(false);
    expect(down.failures[0]).toContain("server: 全局行覆盖 80% < 基线 85.8%");
    expect(down.warnings[0]).toContain("爬升到期日");

    const ok = checkRatchet({ server: { lines: 85.8 }, mobile: { lines: 61 } }, baseline);
    expect(ok.ok).toBe(true);
    expect(ok.failures).toHaveLength(0);

    const unknown = checkRatchet({ newsuite: { lines: 10 } }, baseline);
    expect(unknown.ok).toBe(true); // 未登记套件 WARN 不阻塞
    expect(unknown.warnings[0]).toContain("newsuite");
  });

  it("增量：diff 新增行对账 lcov 行级命中；未测文件视为未覆盖；无新增行跳过", () => {
    const baseline = { incremental: { default: 80, mobile: 60 } };
    const { byFile } = parseLcov(LCOV_SAMPLE);

    // foo.ts 新增 3 行（新行 2/3/4，新行 1 是 context）：2 命中 1 未命中 → 66.7% < 80 → 失败并列出未覆盖行。
    const diff1 = [
      "+++ b/apps/server/src/foo.ts",
      "@@ -1,3 +1,6 @@",
      " context",
      "+covered line", // 新行 2 → DA:2 是 0 → 应为未覆盖？注意 lcov 样本 DA:2,0
      "+uncovered line",
      "+another covered",
    ].join("\n");
    // 样本对齐：context 占新行 1；新增行 2/3/4 对应 DA:2(未命中)/DA:3(命中)/DA:4(lcov 无记录=未命中)。
    // 即 1 命中 2 未命中 → 33.3% < 80 → 失败。
    const r1 = checkIncremental(diff1, byFile, "server", baseline);
    expect(r1.ok).toBe(false);
    expect(r1.message).toContain("1/3 = 33.3%");
    expect(r1.message).toContain("foo.ts:2");

    // 修正对齐样本：@@ +1,4 且无 context——新增行 1/2/3 = DA 命中 1/未命中/命中 → 66.7%。
    const diffAligned = [
      "+++ b/apps/server/src/foo.ts",
      "@@ -0,0 +1,3 @@",
      "+first covered",
      "+second uncovered",
      "+third covered",
    ].join("\n");
    const r1b = checkIncremental(diffAligned, byFile, "server", baseline);
    expect(r1b.ok).toBe(false);
    expect(r1b.message).toContain("2/3 = 66.7%");
    expect(r1b.message).toContain("foo.ts:2");

    // mobile 阈值 60：同形 66.7% 的 mobile 路径样本通过（60 < 66.7；过滤器也须放行 mobile 根）。
    const mobileLcov = parseLcov(
      ["SF:apps/mobile/lib/baz.dart", "DA:1,1", "DA:2,0", "DA:3,1", "end_of_record"].join("\n"),
    );
    const diffMobile = [
      "+++ b/apps/mobile/lib/baz.dart",
      "@@ -0,0 +1,3 @@",
      "+first covered",
      "+second uncovered",
      "+third covered",
    ].join("\n");
    const r2 = checkIncremental(diffMobile, mobileLcov.byFile, "mobile", baseline);
    expect(r2.ok).toBe(true);
    expect(r2.message).toContain("阈值 60%");

    // 全新未测文件：新增行全部未覆盖 → 0%。
    const diff3 = ["+++ b/apps/server/src/newfile.ts", "@@ -0,0 +1,2 @@", "+brand new", "+no tests"].join("\n");
    const r3 = checkIncremental(diff3, byFile, "server", baseline);
    expect(r3.ok).toBe(false);
    expect(r3.message).toContain("0/2 = 0%");

    // 非生产路径（tests）不计入分母。
    const diff4 = ["+++ b/apps/server/src/foo.test.ts", "@@ -0,0 +1,1 @@", "+test only"].join("\n");
    const r4 = checkIncremental(diff4, byFile, "server", baseline);
    expect(r4.ok).toBe(true);
    expect(r4.message).toContain("跳过");

    // 删除行不增加分母；上下文行推进行号。
    const diff5 = ["+++ b/apps/server/src/foo.ts", "@@ -1,3 +1,3 @@", "-removed", " kept", "+kept covered"].join("\n");
    const r5 = checkIncremental(diff5, byFile, "server", baseline);
    // 新行号=2（context 后），foo.ts:2 未命中 → 0/1。
    expect(r5.message).toContain("0/1");
  });

  it("round1：0.1 精度四舍五入", () => {
    expect(round1(66.66666)).toBe(66.7);
    expect(round1(85.84)).toBe(85.8);
  });
});
