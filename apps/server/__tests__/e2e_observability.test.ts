import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Application } from "../src/app/application.js";
import { E2E_FAKE_CLI } from "./fakeCli.js";

describe("观测 HTTP 与应用生命周期", () => {
  /** 新路由与现有业务共用监听和鉴权，客户端重试不能重复累计。 */
  it("鉴权后记录客户端指标并可查询；关闭后释放独立存储", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-observability-e2e-"));
    writeFileSync(join(root, "fake-cli.mjs"), E2E_FAKE_CLI);
    vi.stubEnv("AIMI_FAKE_CLI_PATH", join(root, "fake-cli.mjs"));
    const app = new Application({
      port: 0,
      dataDir: join(root, "data"),
      logDir: join(root, "logs"),
      logLevel: "ERROR",
      watchdogMs: 600000,
      serverVersion: "observability-test",
    });
    try {
      const { port } = await app.start();
      const base = `http://127.0.0.1:${port}/observability/v1`;
      expect((await fetch(`${base}/catalog`)).status).toBe(401);
      const token = readFileSync(join(root, "data", "lan-token.txt"), "utf8").trim();
      const headers = { "x-aimi-token": token, "content-type": "application/json" };
      const batch = {
        source: { instanceId: "integration-instance", sourceId: "client.connection", component: "client" },
        descriptors: [
          {
            name: "client.receive_gap",
            kind: "histogram",
            unit: "ms",
            description: "手机接收间隔",
            boundary: "client.websocket.receive",
            availability: "available",
          },
        ],
        records: [
          {
            sequence: 1,
            name: "client.receive_gap",
            value: 45,
            ts: Date.now(),
            monoMs: 10,
            context: { sessionId: "diagnostic-session", seq: 3, scenario: "integration" },
          },
        ],
        dropped: 0,
        closed: false,
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(`${base}/batches`, { method: "POST", headers, body: JSON.stringify(batch) });
        expect(response.ok).toBe(true);
      }
      const response = await fetch(`${base}/traces?sessionId=diagnostic-session`, { headers });
      expect(response.ok).toBe(true);
      const traces = (await response.json()) as { records: { name: string; value: number }[] };
      expect(traces.records.filter((record) => record.name === "client.receive_gap")).toHaveLength(1);
      expect(traces.records[0]).toMatchObject({ value: 45 });
      expect((await fetch(`${base}/health`, { headers })).ok).toBe(true);
    } finally {
      await app.close();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});
