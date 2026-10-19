import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.tls).toBeUndefined();
    expect(cfg.logLevel).toBe("INFO");
    expect(cfg.watchdogMs).toBe(600_000);
    expect(cfg.dataDir).toContain(".aimi-server");
    expect(cfg.logDir).toContain(".aimi-server");
    expect(isAbsolute(cfg.dataDir)).toBe(true);
    expect(isAbsolute(cfg.logDir)).toBe(true);
    expect(cfg.serverVersion).toBe(SERVER_VERSION);
    expect(cfg.agents).toEqual({ permissionCeiling: "default" });
  });

  it("host 与 tls 配置生效", () => {
    const path = join(tmpDir(), "tls.yaml");
    writeFileSync(path, "host: 0.0.0.0\ntls:\n  certFile: cert.pem\n  keyFile: key.pem\n", "utf8");
    expect(loadConfig(path)).toMatchObject({
      host: "0.0.0.0",
      tls: { certFile: join(path, "..", "cert.pem"), keyFile: join(path, "..", "key.pem") },
    });
  });

  it("配置中的相对目录与 TLS 文件路径以配置文件目录解析，与启动 CWD 无关", () => {
    const dir = tmpDir();
    const elsewhere = tmpDir();
    const path = join(dir, "config.yaml");
    writeFileSync(path, "dataDir: ./state\nlogDir: ../logs\ntls:\n  certFile: certs/server.pem\n  keyFile: ./private/server.key\n", "utf8");
    const originalCwd = process.cwd();
    try {
      process.chdir(elsewhere);
      expect(loadConfig(path)).toMatchObject({
        dataDir: resolve(dir, "state"),
        logDir: resolve(dir, "../logs"),
        tls: { certFile: resolve(dir, "certs/server.pem"), keyFile: resolve(dir, "private/server.key") },
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("绝对目录与证书路径保持原值", () => {
    const dir = tmpDir();
    const dataDir = join(dir, "absolute-data");
    const logDir = join(dir, "absolute-logs");
    const certFile = join(dir, "server.pem");
    const keyFile = join(dir, "server.key");
    const path = join(dir, "config.yaml");
    writeFileSync(path, `dataDir: "${dataDir.replaceAll("\\", "\\\\")}"\nlogDir: "${logDir.replaceAll("\\", "\\\\")}"\ntls:\n  certFile: "${certFile.replaceAll("\\", "\\\\")}"\n  keyFile: "${keyFile.replaceAll("\\", "\\\\")}"\n`, "utf8");

    expect(loadConfig(path)).toMatchObject({ dataDir, logDir, tls: { certFile, keyFile } });
  });

  it("tls 缺少证书字段时拒绝", () => {
    const path = join(tmpDir(), "tls-invalid.yaml");
    writeFileSync(path, "tls:\n  certFile: cert.pem\n", "utf8");
    expect(() => loadConfig(path)).toThrow(/config 校验失败/);
  });

  it("非 loopback host 未配置 tls 时拒绝", () => {
    const path = join(tmpDir(), "insecure-host.yaml");
    writeFileSync(path, "host: 0.0.0.0\n", "utf8");
    expect(() => loadConfig(path)).toThrow(/必须配置 tls/);
  });

  it("yaml 覆盖 + 未提供字段取默认", () => {
    const path = join(tmpDir(), "config.yaml");
    writeFileSync(path, "port: 9000\nlogLevel: WARN\n", "utf8");
    const cfg = loadConfig(path);
    expect(cfg.port).toBe(9000);
    expect(cfg.logLevel).toBe("WARN");
    expect(cfg.dataDir).toContain(".aimi-server"); // 未覆盖 → 默认
    expect(cfg.agents).toEqual({ permissionCeiling: "default" });
  });

  it("agents.permissionCeiling 支持四档并拒绝未知档位", () => {
    const path = join(tmpDir(), "agents.yaml");
    writeFileSync(path, "agents:\n  permissionCeiling: acceptEdits\n", "utf8");
    expect(loadConfig(path).agents).toEqual({ permissionCeiling: "acceptEdits" });

    const invalid = join(tmpDir(), "agents-invalid.yaml");
    writeFileSync(invalid, "agents:\n  permissionCeiling: danger\n", "utf8");
    expect(() => loadConfig(invalid)).toThrow(/config 校验失败/);
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
