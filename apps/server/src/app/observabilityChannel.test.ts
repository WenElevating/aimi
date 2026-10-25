import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ObservabilityChannel } from "./observabilityChannel.js";
import { MetricsStore } from "../observability/store.js";
import { MetricsCollector } from "../observability/collector.js";

describe("观测 HTTP 接口", () => {
  /** 用真实 HTTP/SQLite 验证鉴权、身份覆盖、幂等和错误结构。 */
  it("持久化后确认并隔离客户端来源身份", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aimi-metrics-http-"));
    const store = new MetricsStore(join(dir, "observability.db"));
    const collector = new MetricsCollector(store);
    const channel = new ObservabilityChannel({
      collector,
      store,
      verifyToken: async (token) => (token === "test-observability-token" ? "device1" : null),
    });
    const server = createServer((req, res) => {
      void channel.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing test listener");
    }
    const base = `http://127.0.0.1:${address.port}/observability/v1`;
    const headers = { "x-aimi-token": "test-observability-token", "content-type": "application/json" };
    const batch = {
      source: { instanceId: "spoof-server", sourceId: "render", component: "client" },
      descriptors: [
        {
          name: "render.frame",
          unit: "ms",
          kind: "histogram",
          description: "帧耗时",
          boundary: "Flutter raster",
          availability: "available",
        },
      ],
      records: [
        {
          sequence: 1,
          name: "render.frame",
          value: 35,
          ts: Date.now(),
          monoMs: 1,
          context: { sessionId: "s1", buildMode: "profile" },
        },
      ],
      dropped: 0,
      closed: false,
    };
    try {
      expect((await fetch(`${base}/health`)).status).toBe(401);
      expect((await fetch(`${base}/batches`, { method: "POST", headers, body: JSON.stringify(batch) })).status).toBe(
        201,
      );
      expect((await fetch(`${base}/batches`, { method: "POST", headers, body: JSON.stringify(batch) })).status).toBe(
        201,
      );
      const traces = (await (await fetch(`${base}/traces?sessionId=s1`, { headers })).json()) as {
        records: Array<{ source: { instanceId: string } }>;
      };
      expect(traces.records).toHaveLength(1);
      expect(traces.records[0]?.source.instanceId).not.toBe("spoof-server");
      expect((await fetch(`${base}/traces?prompt=forbidden`, { headers })).status).toBe(400);
      expect(
        (
          await fetch(`${base}/batches`, {
            method: "POST",
            headers,
            body: JSON.stringify({ ...batch, source: { ...batch.source, component: "server" } }),
          })
        ).status,
      ).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await collector.close();
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
