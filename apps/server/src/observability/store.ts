import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import {
  metricBatchSchema,
  metricContextSchema,
  type MetricBatch,
  type MetricSource,
  type MetricDescriptor,
  type MetricRecord,
} from "@aimi/protocol";
import { metricsWorkerSource } from "./storeWorker.js";

/** 查询只接收白名单维度和有界分页，不透传 SQL 或任意标签。 */
export const metricsQuerySchema = metricContextSchema
  .omit({ seq: true, seqEnd: true })
  .extend({
    name: z
      .string()
      .max(96)
      .regex(/^[a-z][a-z0-9_.]*$/)
      .optional(),
    sourceId: z.string().max(128).optional(),
    instanceId: z.string().max(128).optional(),
    component: z.enum(["agent", "server", "client"]).optional(),
    from: z.number().int().nonnegative().optional(),
    to: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    cursor: z
      .string()
      .regex(/^\d{1,12}$/)
      .optional(),
    compareId: z.string().uuid().optional(),
  })
  .strict();

export type MetricsQuery = z.infer<typeof metricsQuerySchema>;
export interface MetricsCatalog {
  sources: Array<{
    source: MetricSource;
    descriptors: MetricDescriptor[];
    dropped: number;
    closed: boolean;
    updated: number;
  }>;
}
export interface MetricsSeries {
  series: Array<{
    bucket: number;
    source: MetricSource;
    name: string;
    count: number;
    total: number;
    min: number;
    max: number;
    mean: number;
    p50: number;
    p95: number;
    p99: number;
    histogram: number[];
  }>;
  nextCursor: string | null;
  bucketBounds: number[];
  approximate: boolean;
  windowMs: number;
}
export interface MetricsTraces {
  records: Array<MetricRecord & { source: MetricSource; id: number }>;
  nextCursor: string | null;
}
export interface MetricsBaseline {
  id: string;
  label: string;
  created: number;
  complete: boolean;
  environments: string[];
}
export interface MetricsBaselineResult {
  baselines: MetricsBaseline[];
  comparison?: {
    baselineId: string;
    comparable: boolean;
    reason: string | null;
    candidate: unknown;
    baseline: unknown;
  };
}

/** 把对外可选参数归一化为有限时间窗，分页游标只表示查询位置。 */
function normalizeQuery(
  query: MetricsQuery,
): MetricsQuery & { from: number; to: number; limit: number; offset: number } {
  const parsed = metricsQuerySchema.parse(query);
  const to = parsed.to ?? Date.now();
  const from = parsed.from ?? to - 15 * 60_000;
  if (from < 0 || to < from || to - from > 30 * 86_400_000) {
    throw new Error("invalid metrics time range");
  }
  return { ...parsed, from, to, limit: parsed.limit ?? 128, offset: Number(parsed.cursor ?? 0) };
}

/** 主线程只传递有界消息，所有同步 SQLite 操作均在线程内执行。 */
export class MetricsStore {
  readonly #worker: Worker;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  #sequence = 0;
  #closed = false;
  #failure: Error | undefined;

  /** 初始化独立观测文件，worker 使用解析后的原生模块绝对路径。 */
  constructor(path: string, options: { budgetBytes?: number } = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.#worker = new Worker(metricsWorkerSource, {
      eval: true,
      workerData: {
        path,
        budgetBytes: options.budgetBytes ?? 256 * 1024 * 1024,
        sqliteModule: createRequire(import.meta.url).resolve("better-sqlite3"),
      },
    });
    this.#worker.on("message", (message: { id: number; result?: unknown; error?: string }) => {
      const request = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      clearTimeout(request?.timer);
      if (message.error) {
        request?.reject(new Error(message.error));
      } else {
        request?.resolve(message.result);
      }
    });
    this.#worker.on("error", (error) => this.#fail(error));
    this.#worker.on("exit", (code) => {
      if (!this.#closed || code !== 0) {
        this.#fail(new Error("observability worker exited"));
      }
    });
  }

  /** worker 异常时拒绝所有等待者，禁止留下无限等待的业务请求。 */
  #fail(error: Error): void {
    this.#failure = error;
    for (const request of this.#pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.#pending.clear();
  }

  /** 有界请求队列避免慢存储把主线程内存耗尽。 */
  #request<T>(method: string, payload?: unknown): Promise<T> {
    if (this.#closed || this.#failure || this.#pending.size >= 64) {
      return Promise.reject(this.#failure ?? new Error("observability storage unavailable"));
    }
    this.#sequence += 1;
    const id = this.#sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("observability worker timed out");
        this.#fail(error);
        void this.#worker.terminate();
      }, 5000);
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.#worker.postMessage({ id, method, payload });
    });
  }

  /** 校验并持久化去重；返回时已完成事务，可推进采集游标。 */
  async ingest(batch: MetricBatch): Promise<{ accepted: number }> {
    return this.#request("ingest", metricBatchSchema.parse(batch));
  }

  /** 返回持久化来源目录，包括不支持但已声明的指标。 */
  async catalog(): Promise<MetricsCatalog> {
    return this.#request("catalog");
  }

  /** 查询分钟桶分布，结果显式携带近似分位数口径。 */
  async series(query: MetricsQuery = {}): Promise<MetricsSeries> {
    return this.#request("series", normalizeQuery(query));
  }

  /** 按数据库游标查询有序明细，保持同时间戳记录完整。 */
  async traces(query: MetricsQuery = {}): Promise<MetricsTraces> {
    return this.#request("traces", normalizeQuery(query));
  }

  /** 新建不可变摘要，记录可比较环境和采样完整性。 */
  async createBaseline(input: { label: string; query?: MetricsQuery }): Promise<MetricsBaseline> {
    const label = z
      .string()
      .min(1)
      .max(80)
      .regex(/^[\w. -]+$/)
      .parse(input.label);
    return this.#request("createBaseline", { id: randomUUID(), label, query: normalizeQuery(input.query ?? {}) });
  }

  /** 查询基准或与当前窗口比较，环境不一致时只返回不可比较原因。 */
  async baselines(query: MetricsQuery = {}): Promise<MetricsBaselineResult> {
    return this.#request("baselines", normalizeQuery(query));
  }

  /** 报告存储占用及已记录丢样，不将未知状态替换成零。 */
  async health(): Promise<{
    records: number;
    aggregateRows: number;
    dropped: number;
    bytes: number;
    budgetBytes: number;
  }> {
    return this.#request("health");
  }

  /** 等待已排队工作完成并释放原生数据库；异常时终止独立线程。 */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    try {
      await this.#request("close");
    } finally {
      this.#closed = true;
      await this.#worker.terminate();
    }
  }
}
