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

  it("冲刷终判去重：入队后 replayedMax 推进越过的帧拦下（重复副本）；越过终值的照常冲出", async () => {
    const fanout = new UiFanout(bus);
    const gated = stubConveyor();
    const gate = new ReplayGate();
    fanout.attach(gated.conveyor, gate);

    await bus.publish("s1", { type: "state", state: "starting" });          // seq 0 入队（此刻进度空）
    gate.replayedMax.set("s1", 0);            // 重放随后直送 seq 0（模拟分页读到该行、推进进度）
    await bus.publish("s1", { type: "usage", tokensIn: 1, tokensOut: 1 });  // seq 1 入队（1 > 0）

    fanout.release(gated.conveyor, gate);
    // 冲刷终判：seq 0 的行已直送（replayedMax=0 即终值），FIFO 副本属重复——拦下不双发；
    // seq 1 > 终值照常冲出（persist 滞后未入页的帧由此保住——两道判定均不丢帧）。
    expect(seqs(gated.sent)).toEqual([1]);
  });

  it("重复窗口回归：重放期间发布的帧，直发与冲刷两路相遇时恰一次（不双发不丢帧）", async () => {
    const fanout = new UiFanout(bus);
    const gated = stubConveyor();
    const gate = new ReplayGate();
    fanout.attach(gated.conveyor, gate);

    // 重放已直送 seq 0..2（进度=2）：这三条即便此刻发布也属"行已直发"，入队口即丢。
    gate.replayedMax.set("s1", 2);
    await bus.publish("s1", { type: "state", state: "running" });             // seq 0 → 入队口丢
    await bus.publish("s1", { type: "usage", tokensIn: 1, tokensOut: 1 });   // seq 1 → 丢
    await bus.publish("s1", { type: "notice", severity: "info", text: "old" }); // seq 2 → 丢（边界）
    // 分页 await 期间：CLI 产出 seq 3 → 入队（3 > 2，入队口保留）；persist 提交后下一页
    // SELECT 读到 3 → 重放循环直发并把进度推到 3（此处 set 模拟直发推进）。
    await bus.publish("s1", { type: "usage", tokensIn: 2, tokensOut: 3 });   // seq 3 → FIFO
    gate.replayedMax.set("s1", 3);
    // persist 滞后帧：seq 4 在分页结束后才提交（未入任何页）——冲刷时 4 > 终值 3，照常冲出。
    await bus.publish("s1", { type: "notice", severity: "info", text: "late" }); // seq 4 → FIFO

    fanout.release(gated.conveyor, gate);
    expect(seqs(gated.sent)).toEqual([4]);    // seq 3 双路相遇 → 终判拦下恰一次；seq 4 冲出
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
