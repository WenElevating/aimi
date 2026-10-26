import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MetricRecorder } from "./metrics.js";
import { MetricsStore } from "./store.js";
import { MetricsCollector } from "./collector.js";

describe("独立观测存储与采集", () => {
  /** 同一来源重复提交只累计一次，任意适配器实现共用同一采集路径。 */
  it("持久化幂等、来源退役排干和基准环境比较", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aimi-observability-"));
    const store = new MetricsStore(join(dir, "observability.db"));
    const collector = new MetricsCollector(store);
    try {
      for (const sourceId of ["fake-cli", "fake-remote-sdk"]) {
        const recorder = new MetricRecorder({
          sourceId,
          component: "agent",
          context: { scenario: "stream", appVersion: "test", buildMode: "profile" },
        });
        recorder.define({
          name: "agent.gap",
          kind: "histogram",
          unit: "ms",
          description: "间隔",
          boundary: "adapter",
          availability: "available",
        });
        const retire = collector.register(recorder);
        recorder.record("agent.gap", 10, { sessionId: "s1" });
        recorder.record("agent.gap", 30, { sessionId: "s1" });
        const { batch } = await recorder.readMetrics({ afterSequence: 0, limit: 128 });
        await store.ingest(batch);
        await store.ingest(batch);
        recorder.close();
        retire();
      }
      await collector.collect();
      expect(collector.health().providers).toBe(0);
      const result = await store.series({ name: "agent.gap" });
      expect(result.series.reduce((sum, item) => sum + item.count, 0)).toBe(4);
      expect(result.series[0]?.p95).toBeGreaterThanOrEqual(30);
      expect((await store.traces({ sessionId: "s1" })).records).toHaveLength(4);
      const baseline = await store.createBaseline({ label: "first", query: { name: "agent.gap" } });
      const comparison = await store.baselines({ compareId: baseline.id, name: "agent.gap" });
      expect(comparison.comparison?.comparable).toBe(true);
    } finally {
      await collector.close();
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
