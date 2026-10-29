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

  it("context 不满足白名单时丢弃该条且不抛（运行时数据不得打死 emit 路径）", () => {
    const recorder = new MetricRecorder({ sourceId: "fake-sdk", component: "agent" });
    recorder.define({
      name: "agent.output.utf16",
      kind: "counter",
      unit: "utf16",
      description: "长度",
      boundary: "输出",
      availability: "available",
    });
    // model 含括号：identifier 白名单（[\w.:/@+ -]）拒绝——1.3.8 真机崩溃的触发值形态。
    expect(() => recorder.record("agent.output.utf16", 3, { model: "claude-opus(legacy)" })).not.toThrow();
    expect(recorder.contextRejectedCount).toBe(1);
    // 合法 context 照常入册。
    recorder.record("agent.output.utf16", 4, { model: "claude-opus" });
    recorder.close();
  });
});
