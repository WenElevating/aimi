import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@aimi/protocol";
import { EventBus } from "../events/eventBus.js";
import { SessionWatchdog, stallNoticeText } from "./watchdog.js";

/**
 * 真时钟小睡（计划 §3.8 口径：阈值断言不依赖系统定时器粒度——告警等待远大于阈值留足余量，
 * "未告警"断言只用不依赖唤醒时机的形态，见各组内注释）。
 *
 * @param ms - 睡眠时长（毫秒）
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 已定序记录的测试投影：会话归属 + 事件本体（断言 stalled 告警的条数与归属用）。 */
type SeenRecord = { sessionId: string; agentEvent: AgentEvent };

/**
 * 造一条带 persist 采集器的总线：watchdog 走 observe 槽位，测试经 persist 路收集全部产出
 * （publish resolve 时 persist 已完成，采集与断言之间零竞态）。
 *
 * @returns 总线与已见记录数组（引用共享，实时可见）
 */
function makeBus(): { bus: EventBus; seen: SeenRecord[] } {
  const bus = new EventBus();
  const seen: SeenRecord[] = [];
  bus.subscribe({
    persist: async (rec) => { seen.push({ sessionId: rec.sessionId, agentEvent: rec.agentEvent }); },
  });
  return { bus, seen };
}

/** 筛出 watchdog 的停滞告警（notice{warn} 且文案以"会话疑似停滞"起——外部 notice 文案不含此前缀）。 */
function stallAlerts(seen: SeenRecord[], sessionId?: string): SeenRecord[] {
  return seen.filter((r) =>
    r.agentEvent.type === "notice"
    && r.agentEvent.severity === "warn"
    && r.agentEvent.text.startsWith("会话疑似停滞")
    && (sessionId === undefined || r.sessionId === sessionId));
}

describe("SessionWatchdog（running 停滞提示，恰一次/事件恢复）", () => {
  it("① running 后静默超阈值 → 恰一条 warn；持续静默无第二条（自反馈环切断）", async () => {
    const { bus, seen } = makeBus();
    const wd = new SessionWatchdog({ bus, thresholdMs: 200 });
    await bus.publish("s1", { type: "state", state: "running" });
    // 挂载发生在 publish 的产出段内（observe 于 produce 时被调），此刻距告警 ≥ 阈值——
    // 不依赖唤醒时机的确定性断言：计时器最快也要 thresholdMs 后才触发。
    expect(stallAlerts(seen, "s1")).toHaveLength(0);
    await sleep(400); // 400 ≫ 200：即使定时器晚触发一两个事件循环也已在册
    const alerts = stallAlerts(seen, "s1");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.agentEvent).toEqual({ type: "notice", severity: "warn", text: stallNoticeText(200) });
    // 告警自身也是事件、会回到 observe——若被当作"下一真实事件"重置计时，这里会再响。
    await sleep(400);
    expect(stallAlerts(seen, "s1")).toHaveLength(1);
  });

  it("② 外部 notice 到达不算活跃证据：告警后 notice 不恢复挂载（notice 一律不重置 running 计时）", async () => {
    const { bus, seen } = makeBus();
    const wd = new SessionWatchdog({ bus, thresholdMs: 200 });
    await bus.publish("s1", { type: "state", state: "running" });
    await sleep(400);
    expect(stallAlerts(seen, "s1")).toHaveLength(1);
    // 告警后到达一条外部 notice（如"审批已失效"）：notice 是服务端派生事实、非 agent 产出，
    // 不得让计时恢复挂载——否则会话仍停滞却因服务端自言自语再次被告警。
    await bus.publish("s1", { type: "notice", severity: "info", text: "审批已失效（会话已不在等待态）" });
    await sleep(400);
    expect(stallAlerts(seen, "s1")).toHaveLength(1);
  });

  it("③ 下一真实事件到达 → 恢复挂载 → 再静默再告警（各场恰一次）", async () => {
    const { bus, seen } = makeBus();
    const wd = new SessionWatchdog({ bus, thresholdMs: 200 });
    await bus.publish("s1", { type: "state", state: "running" });
    await sleep(400);
    expect(stallAlerts(seen, "s1")).toHaveLength(1);
    // 真实事件（usage 非增量、即时产出）：恢复挂载——此刻距再告警 ≥ 阈值，确定性断言仍为 1。
    await bus.publish("s1", { type: "usage", tokensIn: 1, tokensOut: 1 });
    expect(stallAlerts(seen, "s1")).toHaveLength(1);
    await sleep(400);
    expect(stallAlerts(seen, "s1")).toHaveLength(2);
  });

  it("④ waiting/finished/starting 不计时；running 中转 finished 即清", async () => {
    const { bus, seen } = makeBus();
    const wd = new SessionWatchdog({ bus, thresholdMs: 200 });
    await bus.publish("s1", { type: "state", state: "waiting_approval" });
    await bus.publish("s2", { type: "state", state: "waiting_input" });
    await bus.publish("s3", { type: "state", state: "starting" });
    await sleep(400);
    expect(stallAlerts(seen)).toHaveLength(0);
    // running 挂载后立刻转 finished：清除计时，不因"曾经 running"而告警。
    await bus.publish("s4", { type: "state", state: "running" });
    await bus.publish("s4", { type: "state", state: "finished" });
    await sleep(400);
    expect(stallAlerts(seen)).toHaveLength(0);
  });

  it("⑤ 双会话隔离：s1 的告警不波及非 running 的 s2；s2 转 running 后各自恰一条", async () => {
    const { bus, seen } = makeBus();
    const wd = new SessionWatchdog({ bus, thresholdMs: 200 });
    await bus.publish("s1", { type: "state", state: "running" });
    await sleep(120);
    await bus.publish("s2", { type: "state", state: "waiting_approval" }); // 非 running：不计时
    await sleep(300); // s1 已过阈值（120+300 ≫ 200）；s2 全程未挂计时
    expect(stallAlerts(seen, "s1")).toHaveLength(1);
    expect(stallAlerts(seen, "s2")).toHaveLength(0);
    await bus.publish("s2", { type: "state", state: "running" });
    await sleep(400);
    expect(stallAlerts(seen, "s1")).toHaveLength(1); // s1 告警后静默，不受 s2 影响
    expect(stallAlerts(seen, "s2")).toHaveLength(1);
  });

  it("⑥ stop 后零行为：已挂计时即清；此后事件不再挂载", async () => {
    const { bus, seen } = makeBus();
    const wd = new SessionWatchdog({ bus, thresholdMs: 200 });
    await bus.publish("s1", { type: "state", state: "running" });
    wd.stop(); // publish 已完成产出 → 计时器已挂载，stop 即清
    await sleep(400);
    expect(stallAlerts(seen)).toHaveLength(0);
    await bus.publish("s1", { type: "state", state: "running" }); // stop 后到达的事件不得再挂载
    await sleep(400);
    expect(stallAlerts(seen)).toHaveLength(0);
  });

  it("文案是阈值换算的纯函数：600_000 → 超 10 分钟（不等待真实时长即可断言契约文案）", () => {
    expect(stallNoticeText(600_000)).toBe("会话疑似停滞（超 10 分钟无新事件）");
  });
});
