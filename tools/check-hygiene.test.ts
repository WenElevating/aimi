import { describe, expect, it } from "vitest";
import { checkPaths } from "./check-hygiene.mjs";

/** 洁净检查黑名单固定样本：真实垃圾形态必命中，正式素材路径必放行。 */
describe("check-hygiene checkPaths 固定样本", () => {
  it("禁止清单命中：会话产物/根目录截图/.env/覆盖率/插件残留/JVM 转储", () => {
    const { ok, violations } = checkPaths([
      ".omx/state/x.json",
      ".zcode/plans/a.md",
      ".superpowers/sdd/task.md",
      "dash3.png",
      ".env.local",
      "apps/server/coverage/lcov.info",
      "plugins/token-speed/README.md",
      "hs_err_pid28732.log",
    ]);
    expect(ok).toBe(false);
    expect(violations).toHaveLength(8);
    expect(violations[2]).toEqual({ path: ".superpowers/sdd/task.md", label: "子代理执行台账（.superpowers/）" });
  });

  it("放行：子目录正式图片、源码、文档、合法命名", () => {
    const { ok, violations } = checkPaths([
      "resources/icon/logo.png",
      "docs/research/refs/bloomberg-terminal.jpg",
      "docs/assets/coverage-trend.png", // docs/assets 是留档白区
      "apps/server/src/app/application.ts",
      "apps/mobile/lib/ui/session/composer.dart",
      "tools/check-hygiene.mjs",
      "subdir/report.png", // 只禁根目录平铺，子目录不禁
    ]);
    expect(ok).toBe(true);
    expect(violations).toHaveLength(0);
  });

  it(".env 前缀变形全命中；普通 env 命名不误伤", () => {
    expect(checkPaths([".env"]).ok).toBe(false);
    expect(checkPaths([".env.production"]).ok).toBe(false);
    expect(checkPaths(["apps/server/src/app/env.ts"]).ok).toBe(true);
  });
});
