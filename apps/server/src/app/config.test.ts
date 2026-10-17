import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { SERVER_VERSION } from "./version.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aimi-cfg-"));
  dirs.push(dir);
  return dir;
}

describe("config 加载（app/ 独家读盘）", () => {
  it("缺省 configPath → 全默认（port 8787 / 版本单源）", () => {
    const cfg = loadConfig(undefined);
    expect(cfg.port).toBe(8787);
    expect(cfg.logLevel).toBe("INFO");
    expect(cfg.dataDir).toContain(".aimi-server");
    expect(cfg.logDir).toContain(".aimi-server");
    expect(cfg.serverVersion).toBe(SERVER_VERSION);
  });

  it("yaml 覆盖 + 未提供字段取默认", () => {
    const path = join(tmpDir(), "config.yaml");
    writeFileSync(path, "port: 9000\nlogLevel: WARN\n", "utf8");
    const cfg = loadConfig(path);
    expect(cfg.port).toBe(9000);
    expect(cfg.logLevel).toBe("WARN");
    expect(cfg.dataDir).toContain(".aimi-server"); // 未覆盖 → 默认
  });

  it("非法结构即抛（port 越界）", () => {
    const path = join(tmpDir(), "config.yaml");
    writeFileSync(path, "port: 70000\n", "utf8");
    expect(() => loadConfig(path)).toThrow(/config 校验失败/);
  });

  it("文件不存在即抛（不静默退回默认）", () => {
    expect(() => loadConfig(join(tmpDir(), "nope.yaml"))).toThrow(/config 读取失败/);
  });
});
