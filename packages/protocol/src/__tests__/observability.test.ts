import { describe, expect, it } from "vitest";
import { metricBatchSchema } from "../observability.js";

describe("观测契约", () => {
  /** 限定指标结构，禁止把正文或任意标签写入观测链路。 */
  it("拒绝自由正文、未知维度和非有限指标", () => {
    const batch = {
      source: { instanceId: "run-1", sourceId: "claude", component: "agent" },
      descriptors: [
        {
          name: "agent.output.length",
          kind: "counter",
          unit: "utf16",
          description: "正文长度",
          boundary: "SDK正文交付",
          availability: "available",
        },
      ],
      records: [
        { sequence: 1, name: "agent.output.length", value: 4, ts: 1000, monoMs: 1, context: { sessionId: "s1" } },
      ],
      dropped: 0,
      closed: false,
    };
    expect(metricBatchSchema.safeParse(batch).success).toBe(true);
    expect(metricBatchSchema.safeParse({ ...batch, body: "secret" }).success).toBe(false);
    expect(
      metricBatchSchema.safeParse({ ...batch, records: [{ ...batch.records[0], context: { prompt: "secret" } }] })
        .success,
    ).toBe(false);
    expect(metricBatchSchema.safeParse({ ...batch, records: [{ ...batch.records[0], value: Infinity }] }).success).toBe(
      false,
    );
  });
});
