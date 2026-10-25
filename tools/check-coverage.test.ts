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

  it("parseLcov：Flutter 包相对 SF 路径（含反斜杠）按包根补全后可与 diff 对账", () => {
    // 真实 Flutter lcov 形态：SF 相对包根且 Windows 下是反斜杠；不补全则
    // 增量覆盖恒为 0%（PR #7 实测暴露的缺陷）。
    const flutterLcov = ["SF:lib\\app\\theme.dart", "DA:10,1", "end_of_record"].join("\n");
    const { byFile } = parseLcov(flutterLcov, "apps/mobile");
    expect(byFile.has("apps/mobile/lib/app/theme.dart")).toBe(true);
  });

  it("parseLcov：已带包根前缀不重复拼接，绝对路径不受前缀影响", () => {
    const mixed = [
      "SF:apps/mobile/lib/a.dart",
      "DA:1,1",
      "end_of_record",
      "SF:D:/repo/aimi/apps/mobile/lib/b.dart",
      "DA:1,0",
      "end_of_record",
    ].join("\n");
    const { byFile } = parseLcov(mixed, "apps/mobile");
    expect(byFile.has("apps/mobile/lib/a.dart")).toBe(true);
    expect(byFile.has("apps/mobile/lib/b.dart")).toBe(true);
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

    // foo.ts 新增 3 行（新行 2/3/4）：DA2 未命中、DA3 命中、DA4 无明细（不可归属，
    // 不占分母）→ 1/2 = 50% < 80 → 失败并列出未覆盖行。
    const diff1 = [
      "+++ b/apps/server/src/foo.ts",
      "@@ -1,3 +1,6 @@",
      " context",
      "+covered line", // 新行 2 → DA:2 是 0 → 未覆盖
      "+uncovered line",
      "+another covered", // 新行 4 → lcov 无 DA:4 记录 → 不占分母
    ].join("\n");
    const r1 = checkIncremental(diff1, byFile, "server", baseline);
    expect(r1.ok).toBe(false);
    expect(r1.message).toContain("1/2 = 50%");
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

  it("增量：无 DA 明细的行不占分母（Dart 稀疏 lcov），文件缺席 lcov 仍全算未覆盖", () => {
    const baseline = { incremental: { default: 80 } };
    // 目标文件只有 DA:2 有记录：新增行 1（无 DA 明细，const/声明类行）不占分母，
    // 新增行 2 命中 → 1/1 = 100%。
    const sparseLcov = parseLcov(["SF:apps/mobile/lib/x.dart", "DA:2,1", "end_of_record"].join("\n"), "apps/mobile");
    const diffSparse = [
      "+++ b/apps/mobile/lib/x.dart",
      "@@ -0,0 +1,2 @@",
      "+const token = 1; // 无 DA 明细行",
      "+runtime line",
    ].join("\n");
    const ok = checkIncremental(diffSparse, sparseLcov.byFile, "mobile", baseline);
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain("1/1 = 100%");

    // 对照：文件完全不在 lcov（未被任何测试加载）→ 缺 DA 记录不能救它。
    const diffGhost = ["+++ b/apps/mobile/lib/y.dart", "@@ -0,0 +1,1 @@", "+orphan"].join("\n");
    const bad = checkIncremental(diffGhost, sparseLcov.byFile, "mobile", baseline);
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("0/1");
  });

  it("round1：0.1 精度四舍五入", () => {
    expect(round1(66.66666)).toBe(66.7);
    expect(round1(85.84)).toBe(85.8);
  });
});
