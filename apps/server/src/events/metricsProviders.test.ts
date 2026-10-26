import { describe, expect, it } from "vitest";
import { EventBus } from "./eventBus.js";
import { UiFanout } from "./uiFanout.js";

describe("事件链路指标提供者", () => {
  it("聚合与写库记录关联同一事件序号，读取不替换已有观测路由", async () => {
    const bus = new EventBus();
    const fanout = new UiFanout(bus);
    const observed: number[] = [];
    bus.subscribe({
      persist: async () => {},
      observe: (record) => {
        observed.push(record.seq);
      },
    });
    const a = bus.publish("session", { type: "text_delta", text: "a" });
    const b = bus.publish("session", { type: "text_delta", text: "b" });
    await bus.flush();
    const [seqA, seqB] = await Promise.all([a, b]);
    expect(seqA).toBe(seqB);
    expect(observed).toEqual([seqA]);
    const result = await bus.metrics().readMetrics({ afterSequence: 0, limit: 256 });
    expect(
      result.batch.records.some((record) => record.name === "server.aggregate.wait.ms" && record.context.seq === seqA),
    ).toBe(true);
    expect(
      result.batch.records.some((record) => record.name === "server.persist.ms" && record.context.seq === seqA),
    ).toBe(true);
    expect(fanout.metrics().describeMetrics().length).toBeGreaterThan(0);
  });
});
