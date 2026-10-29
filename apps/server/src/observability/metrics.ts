import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  metricContextSchema,
  metricDescriptorSchema,
  metricSourceSchema,
  type MetricContext,
  type MetricDescriptor,
  type MetricRecord,
  type MetricSource,
  type MetricsProvider,
  type MetricsReadRequest,
  type MetricsReadResult,
} from "@aimi/protocol";

export type { MetricsProvider } from "@aimi/protocol";
export type { MetricsRegistry } from "./collector.js";

/** 有界指标环形缓冲；写入不进行日志、网络或 SQLite I/O。 */
export class MetricRecorder implements MetricsProvider {
  readonly source: MetricSource;
  readonly #context: MetricContext;
  readonly #capacity: number;
  readonly #descriptors = new Map<string, MetricDescriptor>();
  readonly #records: Array<MetricRecord | undefined>;
  #sequence = 0;
  #count = 0;
  #closed = false;
  #contextRejected = 0;

  /** 为独立组件创建来源实例，容量固定且关闭后禁止继续写入。 */
  constructor(options: {
    sourceId: string;
    component: MetricSource["component"];
    context?: MetricContext;
    capacity?: number;
    instanceId?: string;
  }) {
    this.source = metricSourceSchema.parse({
      sourceId: options.sourceId,
      component: options.component,
      instanceId: options.instanceId ?? randomUUID(),
    });
    this.#context = metricContextSchema.parse(options.context ?? {});
    this.#capacity = Math.max(1, Math.min(8192, Math.floor(options.capacity ?? 1024)));
    this.#records = new Array<MetricRecord | undefined>(this.#capacity);
  }

  /** 注册稳定的技术指标，禁止同名改变口径。 */
  define(descriptor: MetricDescriptor): void {
    const parsed = metricDescriptorSchema.parse(descriptor);
    const previous = this.#descriptors.get(parsed.name);
    if (!previous && this.#descriptors.size >= 128) {
      throw new Error("metric descriptor capacity exceeded");
    }
    if (previous && JSON.stringify(previous) !== JSON.stringify(parsed)) {
      throw new Error("metric descriptor changed");
    }
    this.#descriptors.set(parsed.name, parsed);
  }

  /** 仅记录已声明的有限非负数；不会同步触发持久化。 */
  record(name: string, value: number, context?: MetricContext, detail?: MetricRecord["detail"]): void {
    const descriptor = this.#descriptors.get(name);
    // 组件关闭后的旁路观测不能把传输层的静默丢弃语义变成异常；未声明指标仍按编程错误拒绝。
    if (!descriptor || descriptor.availability !== "available" || !Number.isFinite(value) || value < 0) {
      throw new Error("invalid or closed metric");
    }
    if (this.#closed) return;
    // context 含运行时数据（如 CLI 回报的模型名），可能不满足 identifier 白名单：
    // 降级为丢弃该条记录而不是抛出——record 位于 agent 事件 emit 的同步路径上，
    // 一次 ZodError 未捕获就会打死整个进程（1.3.8 真机实测：model 含括号触发）。
    const merged = metricContextSchema.safeParse({ ...this.#context, ...context });
    if (!merged.success) {
      this.#contextRejected += 1;
      return;
    }
    const mergedContext = merged.data;
    this.#sequence += 1;
    const record: MetricRecord = {
      sequence: this.#sequence,
      name,
      value,
      ts: Date.now(),
      monoMs: performance.now(),
      context: mergedContext,
      ...(detail === undefined ? {} : { detail }),
    };
    this.#count = Math.min(this.#count + 1, this.#capacity);
    this.#records.splice((this.#sequence - 1) % this.#capacity, 1, record);
  }

  /** 因 context 不满足白名单而被丢弃的记录数（可观测性：静默丢弃也留痕）。 */
  get contextRejectedCount(): number {
    return this.#contextRejected;
  }

  /** 返回只读目录副本，采集器不依赖实现细节。 */
  describeMetrics(): readonly MetricDescriptor[] {
    return [...this.#descriptors.values()].map((descriptor) => ({ ...descriptor }));
  }

  /** 按稳定序号读取；重读不消费数据，溢出由 dropped 明示。 */
  async readMetrics(request: MetricsReadRequest): Promise<MetricsReadResult> {
    const start = Math.max(request.afterSequence + 1, this.#sequence - this.#count + 1);
    const limit = Math.min(128, Math.max(1, Math.floor(request.limit)));
    const records: MetricRecord[] = [];
    for (let sequence = start; sequence <= this.#sequence && records.length < limit; sequence += 1) {
      const record = this.#records.at((sequence - 1) % this.#capacity);
      if (record) {
        records.push({ ...record, context: { ...record.context } });
      }
    }
    const dropped = Math.max(0, this.#sequence - this.#count - request.afterSequence);
    return {
      batch: {
        source: { ...this.source },
        descriptors: [...this.describeMetrics()],
        records,
        dropped,
        closed: this.#closed,
      },
      nextSequence: records.at(-1)?.sequence ?? request.afterSequence,
    };
  }

  /** 结束来源但保留未采集数据，允许退役采集完成后再释放。 */
  close(): void {
    this.#closed = true;
  }
}
