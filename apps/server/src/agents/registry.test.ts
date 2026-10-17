import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, AgentSession } from "./types.js";
import { AgentRegistry } from "./registry.js";
import { ClaudeAdapter } from "./claude/claudeAdapter.js";
import type { Logger } from "../logging/logger.js";

/** 记录 WARN 的假日志门面（只关心「覆盖注册是否告警」）。 */
function fakeLogger(): Logger & { warns: { msg: string; fields?: Record<string, unknown> }[] } {
  const warns: { msg: string; fields?: Record<string, unknown> }[] = [];
  return {
    warns,
    debug: () => {},
    info: () => {},
    warn: (msg, fields) => { warns.push({ msg, fields }); },
    error: () => {},
  };
}

/** 最小假适配器：只填 registry 关心的三个面。 */
function stubAdapter(id: string, label = id): AgentAdapter {
  return {
    meta: { id, label },
    isInstalled: async () => ({ ok: true }),
    create: (): AgentSession => ({
      start: async () => {},
      send: async () => {},
      dispose: async () => {},
    }),
  };
}

const dirs: string[] = [];
/** 造一个临时目录并注册进 afterEach 清理表。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aimi-registry-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("AgentRegistry", () => {
  it("register/get/lookup：注册即可取；未注册返回 undefined", () => {
    const registry = new AgentRegistry();
    const adapter = stubAdapter("claude", "Claude Code");
    registry.register(adapter);
    expect(registry.get("claude")).toBe(adapter);
    expect(registry.get("zcode")).toBeUndefined();
    const lookup = registry.lookup();
    expect(lookup.get("claude")).toBe(adapter);
    expect(lookup.get("nope")).toBeUndefined();
  });

  it("重复 id 覆盖并 WARN（保留最后一次注册）", () => {
    const logger = fakeLogger();
    const registry = new AgentRegistry({ logger });
    const first = stubAdapter("claude", "Claude Code v1");
    const second = stubAdapter("claude", "Claude Code v2");
    registry.register(first);
    registry.register(second);
    expect(registry.get("claude")).toBe(second);
    expect(logger.warns.map((w) => w.msg)).toEqual(["agent adapter replaced"]);
    expect(logger.warns[0]!.fields).toMatchObject({ id: "claude" });
  });

  it("detectAll：PATH 注入假 `claude.cmd` → claude ok:true 且带版本", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "claude.cmd"), "@echo off\necho claude 1.2.3\r\n");
    vi.stubEnv("PATH", dir + ";" + process.env.PATH);

    const registry = new AgentRegistry();
    registry.register(new ClaudeAdapter());
    const results = await registry.detectAll();
    expect(results).toEqual([{ id: "claude", ok: true, version: "claude 1.2.3" }]);
  });

  it("detectAll：PATH 清空（仅系统目录）→ claude ok:false", async () => {
    vi.stubEnv("PATH", "C:\\Windows\\System32;C:\\Windows");

    const registry = new AgentRegistry();
    registry.register(new ClaudeAdapter());
    const results = await registry.detectAll();
    expect(results).toEqual([{ id: "claude", ok: false }]);
  });

  it("detectAll：探测超时视为未安装，且并发探测全部适配器（顺序即注册序）", async () => {
    const registry = new AgentRegistry({ installTimeoutMs: 50 });
    const hang: AgentAdapter = {
      meta: { id: "hang", label: "Hang" },
      isInstalled: () => new Promise(() => {}), // 永不 settle
      create: (): AgentSession => ({ start: async () => {}, send: async () => {}, dispose: async () => {} }),
    };
    registry.register(hang);
    registry.register(stubAdapter("ok"));
    const results = await registry.detectAll();
    expect(results).toEqual([{ id: "hang", ok: false }, { id: "ok", ok: true }]);
  });
});
