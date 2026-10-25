import { describe, expect, it } from "vitest";
import { MetricRecorder } from "./metrics.js";

describe("指标提供者", () => {
  /** 只读游标允许采集失败后重读，且环形容量不会随会话增长。 */
  it("有界保留、稳定重读并暴露丢样", async () => {
    const recorder = new MetricRecorder({ sourceId: "fake-sdk", component: "agent", capacity: 2 });
    recorder.define({
      name: "agent.output",
      kind: "counter",
      unit: "utf16",
      description: "长度",
      boundary: "输出",
      availability: "available",
    });
    recorder.record("agent.output", 1);
    recorder.record("agent.output", 2);
    recorder.record("agent.output", 3);
    const request = { afterSequence: 0, limit: 128 };
    const first = await recorder.readMetrics(request);
    expect(first.batch.records.map((r) => r.value)).toEqual([2, 3]);
    expect(first.batch.dropped).toBe(1);
    expect((await recorder.readMetrics(request)).batch.records).toEqual(first.batch.records);
    recorder.close();
    expect((await recorder.readMetrics({ afterSequence: 3, limit: 128 })).batch.closed).toBe(true);
    expect(() => recorder.record("unknown", 1)).toThrow();
  });
});
