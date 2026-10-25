import type { MetricsProvider, MetricDescriptor, MetricSource } from "@aimi/protocol";
import type { MetricsStore } from "./store.js";

/** 组合根将所有来源注册到同一接口，组件不反向依赖采集实现。 */
export interface MetricsRegistry {
  register(provider: MetricsProvider): () => void;
}

interface RegisteredProvider {
  provider: MetricsProvider;
  cursor: number;
  retired: boolean;
  reading: boolean;
  failures: number;
  lastSuccess: number | null;
  dropped: number;
}

/** 有界轮询采集；只有持久化成功才推进来源游标。 */
export class MetricsCollector implements MetricsRegistry {
  readonly #store: MetricsStore;
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  readonly #providers = new Map<string, RegisteredProvider>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #collecting: Promise<void> | undefined;
  #errors = 0;
  #dropped = 0;
  #closed = false;

  /** 注入独立存储，采集周期和超时只用于调度，不改变业务输出。 */
  constructor(store: MetricsStore, options: { intervalMs?: number; timeoutMs?: number } = {}) {
    this.#store = store;
    this.#intervalMs = options.intervalMs ?? 2000;
    this.#timeoutMs = options.timeoutMs ?? 1000;
  }

  /** 注册来源；返回退役动作，排干后才释放来源引用。 */
  register(provider: MetricsProvider): () => void {
    if (this.#closed || this.#providers.has(provider.source.instanceId) || this.#providers.size >= 256) {
      throw new Error("metrics provider registration rejected");
    }
    const state: RegisteredProvider = {
      provider,
      cursor: 0,
      retired: false,
      reading: false,
      failures: 0,
      lastSuccess: null,
      dropped: 0,
    };
    this.#providers.set(provider.source.instanceId, state);
    return () => {
      state.retired = true;
    };
  }

  /** 启动常态采集，timer 不单独维持进程存活。 */
  start(): void {
    if (this.#timer || this.#closed) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.collect();
    }, this.#intervalMs);
    this.#timer.unref();
  }

  /** 每轮最多采集 8192 条，来源依次读取以限制瞬时队列。 */
  async collect(): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (this.#collecting) {
      return this.#collecting;
    }
    this.#collecting = this.#collect();
    try {
      await this.#collecting;
    } finally {
      this.#collecting = undefined;
    }
  }

  /** 单一异常来源不能阻断其他来源，读取超时后禁止重叠读取。 */
  async #collect(): Promise<void> {
    let budget = 8192;
    for (const [instanceId, state] of this.#providers) {
      if (state.reading || budget <= 0) {
        continue;
      }
      let exhausted = false;
      while (!exhausted && budget > 0 && !this.#closed) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        state.reading = true;
        try {
          const read = Promise.resolve()
            .then(() => state.provider.readMetrics({ afterSequence: state.cursor, limit: Math.min(128, budget) }))
            .finally(() => {
              state.reading = false;
            });
          const result = await Promise.race([
            read,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => reject(new Error("metrics provider timed out")), this.#timeoutMs);
            }),
          ]);
          if (
            result.batch.source.instanceId !== instanceId ||
            result.nextSequence < state.cursor ||
            (result.batch.records.at(-1)?.sequence ?? state.cursor) !== result.nextSequence
          ) {
            throw new Error("invalid metrics provider cursor");
          }
          if (this.#closed) {
            return;
          }
          const lost = Math.max(0, (result.batch.records[0]?.sequence ?? state.cursor + 1) - state.cursor - 1);
          await this.#store.ingest({ ...result.batch, dropped: state.dropped + lost });
          state.dropped += lost;
          this.#dropped += lost;
          state.cursor = result.nextSequence;
          state.lastSuccess = Date.now();
          budget -= result.batch.records.length;
          exhausted = result.batch.records.length < 128;
          if (exhausted && (state.retired || result.batch.closed)) {
            this.#providers.delete(instanceId);
          }
        } catch {
          this.#errors += 1;
          state.failures += 1;
          exhausted = true;
        } finally {
          clearTimeout(timeout);
        }
      }
    }
  }

  /** 目录可在首轮落库前查询，动态状态只附来源级健康信息。 */
  catalog(): { sources: Array<{ source: MetricSource; descriptors: readonly MetricDescriptor[]; retired: boolean }> } {
    return {
      sources: [...this.#providers.values()].map((state) => ({
        source: state.provider.source,
        descriptors: state.provider.describeMetrics(),
        retired: state.retired,
      })),
    };
  }

  /** 报告采集失败和最后成功时间，禁止把停摆来源展示为正常零值。 */
  health(): {
    providers: number;
    errors: number;
    dropped: number;
    collecting: boolean;
    sources: Array<{
      source: MetricSource;
      failures: number;
      lastSuccess: number | null;
      reading: boolean;
      retired: boolean;
    }>;
  } {
    return {
      providers: this.#providers.size,
      errors: this.#errors,
      dropped: this.#dropped,
      collecting: this.#collecting !== undefined,
      sources: [...this.#providers.values()].map((state) => ({
        source: state.provider.source,
        failures: state.failures,
        lastSuccess: state.lastSuccess,
        reading: state.reading,
        retired: state.retired,
      })),
    };
  }

  /** 停止轮询并限时收尾；未完成来源以丢样状态报告。 */
  async close(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.collect(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 1500);
      }),
    ]);
    clearTimeout(timeout);
    this.#closed = true;
    this.#dropped += [...this.#providers.values()].filter((state) => state.reading).length;
    this.#providers.clear();
  }
}
