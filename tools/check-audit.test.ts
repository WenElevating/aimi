import { describe, expect, it } from "vitest";
import { isExempt } from "../check-audit.mjs";

/** audit 豁免判定固定样本：有效期/包名/理由三要素与过期自动失效口径。 */
describe("check-audit isExempt 固定样本", () => {
  const vuln = { id: 12345, moduleName: "some-pkg" };
  const NOW = new Date("2026-10-24T00:00:00Z");

  it("有效豁免：id+包名匹配、reason 非空、未过期", () => {
    const verdict = isExempt(
      vuln,
      [{ id: 12345, package: "some-pkg", reason: "无修复版本，等上游", expires: "2026-12-31" }],
      NOW,
    );
    expect(verdict.exempt).toBe(true);
    expect(verdict.reason).toContain("2026-12-31");
  });

  it.each([
    ["包名不匹配", [{ id: 12345, package: "other-pkg", reason: "x", expires: "2026-12-31" }], "不在豁免清单"],
    ["id 不匹配", [{ id: 99999, package: "some-pkg", reason: "x", expires: "2026-12-31" }], "不在豁免清单"],
    ["缺 reason", [{ id: 12345, package: "some-pkg", reason: "", expires: "2026-12-31" }], "缺 reason"],
    ["已过期", [{ id: 12345, package: "some-pkg", reason: "x", expires: "2026-01-01" }], "已过期"],
    ["非法日期", [{ id: 12345, package: "some-pkg", reason: "x", expires: "forever" }], "非法日期"],
  ])("无效豁免：%s → 按未豁免阻塞", (_label, exemptions, reasonPart) => {
    const verdict = isExempt(vuln, exemptions, NOW);
    expect(verdict.exempt).toBe(false);
    expect(verdict.reason).toContain(reasonPart);
  });

  it("id 为字符串/数字均可匹配（pnpm 版本间类型漂移防御）", () => {
    const verdict = isExempt(vuln, [{ id: "12345", package: "some-pkg", reason: "x", expires: "2026-12-31" }], NOW);
    expect(verdict.exempt).toBe(true);
  });
});
