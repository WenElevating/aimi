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
  it("缺省 configPath → 全默认（port 8787 / watchdogMs 600_000 / 版本单源）", () => {
    const cfg = loadConfig(undefined);
    expect(cfg.port).toBe(8787);
    expect(cfg.logLevel).toBe("INFO");
    expect(cfg.watchdogMs).toBe(600_000);
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

  it("watchdogMs yaml 覆盖生效", () => {
    const path = join(tmpDir(), "config.yaml");
    writeFileSync(path, "watchdogMs: 120000\n", "utf8");
    const cfg = loadConfig(path);
    expect(cfg.watchdogMs).toBe(120_000);
    expect(cfg.port).toBe(8787); // 未覆盖字段取默认
  });

  it("watchdogMs 低于 5000 或非整数即拒（防误配 0 把停滞防护反转成告警轰炸）", () => {
    const below = join(tmpDir(), "below.yaml");
    writeFileSync(below, "watchdogMs: 4999\n", "utf8");
    expect(() => loadConfig(below)).toThrow(/config 校验失败/);

    const fractional = join(tmpDir(), "fractional.yaml");
    writeFileSync(fractional, "watchdogMs: 100.5\n", "utf8");
    expect(() => loadConfig(fractional)).toThrow(/config 校验失败/);
  });

  it("文件不存在即抛（不静默退回默认）", () => {
    expect(() => loadConfig(join(tmpDir(), "nope.yaml"))).toThrow(/config 读取失败/);
  });

  it("relay 嵌套配置：url/serverToken 生效（Task 9 出站拨入）", () => {
    const path = join(tmpDir(), "relay.yaml");
    writeFileSync(path, "relay:\n  url: wss://relay.example/serve\n  serverToken: relay-token-01\n", "utf8");
    const cfg = loadConfig(path);
    expect(cfg.relay).toEqual({ url: "wss://relay.example/serve", serverToken: "relay-token-01" });
  });

  it("relay 缺省 → undefined（可选键：未启用 relay 的部署零改动，不重演必填字面量牵连）", () => {
    expect(loadConfig(undefined).relay).toBeUndefined();
  });

  it("relay 内未知键即拒（strict——拼写错误显式暴露而非静默吞掉）", () => {
    const path = join(tmpDir(), "relay-unknown.yaml");
    writeFileSync(path, "relay:\n  url: wss://relay.example/serve\n  serverToken: t-01\n  extra: 1\n", "utf8");
    expect(() => loadConfig(path)).toThrow(/config 校验失败/);
  });

  it("relay 缺 serverToken 即拒（拨入无凭证在 relay 侧必被拒——缺省直接不让启动）", () => {
    const path = join(tmpDir(), "relay-notoken.yaml");
    writeFileSync(path, "relay:\n  url: wss://relay.example/serve\n", "utf8");
    expect(() => loadConfig(path)).toThrow(/config 校验失败/);
  });

  it("relay 缺 url 即拒", () => {
    const path = join(tmpDir(), "relay-nourl.yaml");
    writeFileSync(path, "relay:\n  serverToken: t-01\n", "utf8");
    expect(() => loadConfig(path)).toThrow(/config 校验失败/);
  });
});
