import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { metricBatchSchema } from "@aimi/protocol";
import type { MetricsCollector } from "../observability/collector.js";
import { metricsQuerySchema, type MetricsQuery, type MetricsStore } from "../observability/store.js";

const BODY_LIMIT = 256 * 1024;
const PREFIX = "/observability/v1";
const baselineInputSchema = z
  .object({
    label: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[\w. -]+$/),
    query: metricsQuerySchema.optional(),
  })
  .strict();

/** 只允许有界 JSON 请求体，超限后丢弃剩余数据以便返回明确错误。 */
async function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let length = 0;
    const chunks: Buffer[] = [];
    let rejected = false;
    request.on("data", (chunk: Buffer) => {
      if (rejected) {
        return;
      }
      length += chunk.length;
      if (length > BODY_LIMIT) {
        rejected = true;
        chunks.length = 0;
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    request.once("error", reject);
    request.once("aborted", () => reject(new Error("request_aborted")));
    request.once("end", () => {
      if (rejected) {
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
  });
}

/** 只将已定义的数值查询键转换为数字，未知键交给严格 schema 拒绝。 */
function queryOf(url: URL): MetricsQuery {
  const numeric = new Set(["from", "to", "limit", "turnStartSeq", "refreshRate"]);
  const entries: Array<[string, string | number]> = [];
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key)) {
      throw new Error("duplicate_query_key");
    }
    seen.add(key);
    entries.push([key, numeric.has(key) ? Number(value) : value]);
  }
  return metricsQuerySchema.parse(Object.fromEntries(entries));
}

/** 身份命名空间由服务端生成，客户端不能伪造 agent 或其他设备来源。 */
function sourceInstanceOf(deviceId: string, instanceId: string): string {
  return `client.${createHash("sha256").update(deviceId).update("\0").update(instanceId).digest("hex")}`;
}

/** 观测 HTTP 只编排鉴权、校验与存储，不访问 agent/CLI/SDK 内部对象。 */
export class ObservabilityChannel {
  readonly #options: {
    collector: MetricsCollector;
    store: MetricsStore;
    verifyToken: (token: string, remote: string) => Promise<string | null>;
  };
  readonly #rates = new Map<string, { start: number; count: number }>();

  /** 复用应用 token 验证和独立观测存储，不另建业务身份体系。 */
  constructor(options: {
    collector: MetricsCollector;
    store: MetricsStore;
    verifyToken: (token: string, remote: string) => Promise<string | null>;
  }) {
    this.#options = options;
  }

  /** 仅认领观测前缀，所有错误返回有界 JSON，内部错误不泄漏文件路径。 */
  async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://aimi.internal");
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
      return false;
    }
    try {
      await this.#serve(request, response, url);
    } catch (error) {
      const message = error instanceof Error ? error.message : "storage_unavailable";
      const invalid =
        error instanceof z.ZodError ||
        message.startsWith("invalid") ||
        message === "duplicate_query_key" ||
        message === "record time out of range";
      this.#respond(response, message === "body_too_large" ? 413 : invalid ? 400 : 503, {
        error: message === "body_too_large" ? message : invalid ? "invalid_request" : "observability_unavailable",
      });
    }
    return true;
  }

  /** 执行鉴权与每设备限流，成功 POST 必须等待实际持久化确认。 */
  async #serve(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const token = request.headers["x-aimi-token"];
    const identity =
      typeof token === "string"
        ? await this.#options.verifyToken(
            token,
            `${request.socket.remoteAddress ?? "unknown"}:${request.socket.remotePort ?? 0}`,
          )
        : null;
    if (!identity) {
      this.#respond(response, 401, { error: "unauthorized" });
      return;
    }
    const now = Date.now();
    const previous = this.#rates.get(identity);
    const rate = previous && now - previous.start < 60_000 ? previous : { start: now, count: 0 };
    rate.count += 1;
    this.#rates.delete(identity);
    this.#rates.set(identity, rate);
    if (this.#rates.size > 1024) {
      const oldest = this.#rates.keys().next().value;
      if (oldest !== undefined) {
        this.#rates.delete(oldest);
      }
    }
    if (rate.count > 120) {
      response.setHeader("Retry-After", "60");
      this.#respond(response, 429, { error: "rate_limited" });
      return;
    }
    const route = url.pathname.slice(PREFIX.length);
    if (request.method === "POST" && route === "/batches") {
      const batch = metricBatchSchema.parse(await readBody(request));
      if (batch.source.component !== "client") {
        this.#respond(response, 400, { error: "client_source_required" });
        return;
      }
      const batchForDevice = {
        ...batch,
        source: { ...batch.source, instanceId: sourceInstanceOf(identity, batch.source.instanceId) },
      };
      const result = await this.#options.store.ingest(batchForDevice);
      this.#respond(response, 201, result);
      return;
    }
    if (request.method === "POST" && route === "/baselines") {
      const input = baselineInputSchema.parse(await readBody(request));
      this.#respond(response, 201, await this.#options.store.createBaseline(input));
      return;
    }
    if (request.method !== "GET") {
      this.#respond(response, 404, { error: "not_found" });
      return;
    }
    const query = queryOf(url);
    if (route === "/catalog") {
      const persisted = await this.#options.store.catalog();
      const sources = new Map(persisted.sources.map((item) => [item.source.instanceId, item]));
      const active = this.#options.collector.catalog().sources;
      for (const item of active) {
        if (!sources.has(item.source.instanceId)) {
          sources.set(item.source.instanceId, {
            ...item,
            descriptors: [...item.descriptors],
            dropped: 0,
            closed: false,
            updated: now,
          });
        }
      }
      this.#respond(response, 200, { sources: [...sources.values()] });
    } else if (route === "/series") {
      this.#respond(response, 200, await this.#options.store.series(query));
    } else if (route === "/traces") {
      this.#respond(response, 200, await this.#options.store.traces(query));
    } else if (route === "/baselines") {
      this.#respond(response, 200, await this.#options.store.baselines(query));
    } else if (route === "/health") {
      this.#respond(response, 200, {
        collector: this.#options.collector.health(),
        storage: await this.#options.store.health(),
      });
    } else {
      this.#respond(response, 404, { error: "not_found" });
    }
  }

  /** 统一 JSON 与禁止缓存，响应不携带 token 或内部错误细节。 */
  #respond(response: ServerResponse, status: number, value: unknown): void {
    if (response.headersSent || response.destroyed) {
      return;
    }
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
  }

  /** 清理限流内存，存储与采集生命周期由组合根统一关闭。 */
  close(): void {
    this.#rates.clear();
  }
}
