import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("观测采集开关", () => {
  /** 显式关闭用于同环境开销对照；未知配置仍必须报错。 */
  it("识别观测开关而不放松配置校验", () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-observability-config-"));
    const path = join(root, "config.yaml");
    try {
      writeFileSync(path, "observability:\n  enabled: false\n");
      expect(loadConfig(path)).toMatchObject({ observability: { enabled: false } });
      writeFileSync(path, "observability:\n  enabled: true\n  unknown: true\n");
      expect(() => loadConfig(path)).toThrow("config 校验失败");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
