import { MetricRecorder } from "../observability/metrics.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, AgentSession } from "./types.js";
import { AgentRegistry } from "./registry.js";
import { ClaudeAdapter } from "./claude/claudeAdapter.js";
import type { Logger } from "../logging/logger.js";

/**
 * 造一个只记录 WARN 的假日志门面，供断言「覆盖注册是否告警」。
 *
 * @returns 假日志门面，另带一个收集到的 WARN 记录数组
 */
function fakeLogger(): Logger & { warns: { msg: string; fields?: Record<string, unknown> }[] } {
  const warns: { msg: string; fields?: Record<string, unknown> }[] = [];
  return {
    warns,
    debug: () => {},
    info: () => {},
    warn: (msg, fields) => {
      warns.push({ msg, fields });
    },
    error: () => {},
  };
}

/**
 * 造一个最小假适配器，只填注册表关心的三个面（身份、安装探测、创建会话）。
 *
 * @param id - 适配器标识，同时用作缺省展示名
 * @param label - 展示名；缺省与 `id` 相同
 * @returns 一个恒装得上、拉起后为空壳句柄的假适配器
 */
function stubAdapter(id: string, label = id): AgentAdapter {
  return {
    metrics: () => new MetricRecorder({ sourceId: "test.adapter", component: "agent" }),
    meta: { id, label },
    isInstalled: async () => ({ ok: true }),
    create: (): AgentSession => ({
      metrics: () => new MetricRecorder({ sourceId: "test.session", component: "agent" }),
      start: async () => {},
      send: async () => {},
      dispose: async () => {},
    }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
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

  /**
   * SDK 时代探测面：isInstalled 直跑随包 CLI（`bundledCliPath`），不再经 PATH——
   * 注入缝与全局 CLI 都不再参与，测试断言"依赖树内二进制存在即 ok 且带版本"。
   */
  describe.skipIf(process.platform !== "win32")("detectAll 的随包 CLI 探测", () => {
    it("随包 claude.exe 可解析 → claude ok:true 且带版本", async () => {
      const registry = new AgentRegistry();
      registry.register(new ClaudeAdapter());
      const results = await registry.detectAll();
      expect(results).toEqual([{ id: "claude", ok: true, version: expect.stringMatching(/^\d+\.\d+\.\d+/) }]);
    });
  });

  it("detectAll：探测超时视为未安装，且并发探测全部适配器（顺序即注册序）", async () => {
    const registry = new AgentRegistry({ installTimeoutMs: 50 });
    const hang: AgentAdapter = {
      metrics: () => new MetricRecorder({ sourceId: "test.hang", component: "agent" }),
      meta: { id: "hang", label: "Hang" },
      isInstalled: () => new Promise(() => {}), // 永不 settle
      create: (): AgentSession => ({
        metrics: () => new MetricRecorder({ sourceId: "test.session", component: "agent" }),
        start: async () => {},
        send: async () => {},
        dispose: async () => {},
      }),
    };
    registry.register(hang);
    registry.register(stubAdapter("ok"));
    const results = await registry.detectAll();
    expect(results).toEqual([
      { id: "hang", ok: false },
      { id: "ok", ok: true },
    ]);
  });
});

describe("AgentRegistry 标灰面（协议探测失败 → 看板选项 S3 渲染的内存态）", () => {
  it("gray → isGrayed true + grayedSnapshot 带原因；未知再灰化前恒 false", () => {
    const registry = new AgentRegistry();
    expect(registry.isGrayed("claude")).toBe(false);
    expect(registry.grayedSnapshot()).toEqual([]);
    const reason = "适配器协议未确认（30s 内未收到 initialize 应答）";
    registry.gray("claude", reason);
    expect(registry.isGrayed("claude")).toBe(true);
    expect(registry.grayedSnapshot()).toEqual([{ id: "claude", reason }]);
    expect(registry.isGrayed("other")).toBe(false); // 故障隔离面：只灰问题适配器，不殃及他人
  });

  it("重复 gray 覆盖原因（保留最后一次——同一问题只呈现最新结论）", () => {
    const registry = new AgentRegistry();
    registry.gray("claude", "第一次探测失败");
    registry.gray("claude", "第二次探测失败");
    expect(registry.grayedSnapshot()).toEqual([{ id: "claude", reason: "第二次探测失败" }]);
  });
});
