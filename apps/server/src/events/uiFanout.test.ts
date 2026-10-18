import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerFrame, SessionEventFrame } from "@aimi/protocol";
import type { Conveyor } from "../transport/conveyor.js";
import { EventBus } from "./eventBus.js";
import { ReplayGate, UiFanout } from "./uiFanout.js";

let bus: EventBus;

beforeEach(() => {
  vi.useFakeTimers();
  bus = new EventBus();
  bus.subscribe({ persist: async () => {}, ui: () => {} });
});

afterEach(() => { vi.useRealTimers(); });

/**
 * 造一个只关心 send 的假通道，把发出的帧记录下来供断言；其余方法 no-op。
 * 只发非增量事件（state/usage/notice）驱动广播——增量聚合窗会让时序依赖定时器，非本单测所关心。
 *
 * @returns 假通道本身与它发出的帧列表
 */
function stubConveyor(): { conveyor: Conveyor; sent: ServerFrame[] } {
  const sent: ServerFrame[] = [];
  return {
    sent,
    conveyor: {
      open: async () => {},
      send: (frame) => { sent.push(frame); },
      onFrame: () => {},
      onClose: () => {},
      close: async () => {},
      state: "open",
    },
  };
}

/** 取帧序列里的 seq（本套用例只发 session.event 形态的帧）。 */
function seqs(frames: ServerFrame[]): number[] {
  return frames.filter((f): f is SessionEventFrame => f.type === "session.event").map((f) => f.seq);
}

describe("UiFanout 重放栅（ReplayGate）", () => {
  it("带闸通道：live 广播先入 FIFO，release 按入队序冲刷，此后 live 直发", async () => {
    const fanout = new UiFanout(bus);
    const gated = stubConveyor();
    const gate = new ReplayGate();
    fanout.attach(gated.conveyor, gate);

    await bus.publish("s1", { type: "state", state: "starting" });          // seq 0 → FIFO
    await bus.publish("s1", { type: "usage", tokensIn: 1, tokensOut: 1 });  // seq 1 → FIFO
    expect(gated.sent).toEqual([]);           // 未开闸：一条都不直发（先进 FIFO）
    expect(fanout.attachedCount()).toBe(1);   // 摘除闸 ≠ 摘除广播：通道仍在集合

    fanout.release(gated.conveyor, gate);
    expect(seqs(gated.sent)).toEqual([0, 1]); // 按入队序（=seq 序）冲刷
    expect(gate.opened).toBe(true);

    await bus.publish("s1", { type: "state", state: "finished" });          // seq 2：开闸后直发
    expect(seqs(gated.sent)).toEqual([0, 1, 2]);
  });

  it("入队时按 replayedMax 一次性去重：seq <= 已送进度的帧到队即丢（不进 FIFO）", async () => {
    const fanout = new UiFanout(bus);
    const gated = stubConveyor();
    const gate = new ReplayGate();
    fanout.attach(gated.conveyor, gate);

    // 重放已直送到 seq 1（重放循环推进 replayedMax）：入队口对 0/1 直接丢弃。
    gate.replayedMax.set("s1", 1);
    await bus.publish("s1", { type: "state", state: "starting" });          // seq 0 → 丢
    await bus.publish("s1", { type: "usage", tokensIn: 1, tokensOut: 1 });  // seq 1 → 丢（<= 边界）
    await bus.publish("s1", { type: "notice", severity: "info", text: "n" }); // seq 2 → 入队

    fanout.release(gated.conveyor, gate);
    expect(seqs(gated.sent)).toEqual([2]);    // 只有新于进度的帧冲出来——旧 seq 在入队口已去重
  });

  it("冲刷不做二次去重：入队时保留的帧，即便 replayedMax 后来推进越过它也按序冲出", async () => {
    const fanout = new UiFanout(bus);
    const gated = stubConveyor();
    const gate = new ReplayGate();
    fanout.attach(gated.conveyor, gate);

    await bus.publish("s1", { type: "state", state: "starting" });          // seq 0 入队（此刻进度空）
    gate.replayedMax.set("s1", 0);            // 重放随后推进到 0（模拟直送完成）
    await bus.publish("s1", { type: "usage", tokensIn: 1, tokensOut: 1 });  // seq 1 入队（1 > 0）

    fanout.release(gated.conveyor, gate);
    // 冲刷期不再按 replayedMax 去重——把 seq 0 吞掉正是 review 重点 1 点名的坑
    // （落库串行链保证"已见 N+1 提交 ⇒ N 已提交"，入队时刻的一次性判定才完备）。
    expect(seqs(gated.sent)).toEqual([0, 1]);
  });

  it("混合双连接：带闸与无闸互不干扰（无闸 M0 直发零行为变化）", async () => {
    const fanout = new UiFanout(bus);
    const plain = stubConveyor();
    const gated = stubConveyor();
    const gate = new ReplayGate();
    fanout.attach(plain.conveyor);
    fanout.attach(gated.conveyor, gate);

    await bus.publish("s1", { type: "state", state: "starting" }); // seq 0
    expect(seqs(plain.sent)).toEqual([0]);    // 无闸通道：直发照旧
    expect(gated.sent).toEqual([]);           // 带闸通道：排队

    fanout.release(gated.conveyor, gate);
    await bus.publish("s1", { type: "usage", tokensIn: 1, tokensOut: 1 }); // seq 1：两路都直发
    expect(seqs(plain.sent)).toEqual([0, 1]);
    expect(seqs(gated.sent)).toEqual([0, 1]); // 冲刷帧在前、直发帧在后，序不乱
  });

  it("带闸通道中途断开：detach 连闸带 FIFO 一并废弃，release 幂等 no-op", async () => {
    const fanout = new UiFanout(bus);
    const gated = stubConveyor();
    const gate = new ReplayGate();
    fanout.attach(gated.conveyor, gate);

    await bus.publish("s1", { type: "state", state: "starting" }); // seq 0 → FIFO
    fanout.detach(gated.conveyor);
    expect(fanout.attachedCount()).toBe(0);

    fanout.release(gated.conveyor, gate);     // 不抛、不发（重连会重走重放，弃帧无害）
    expect(gated.sent).toEqual([]);
  });
});
