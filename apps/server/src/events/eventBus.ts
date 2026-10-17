import type { AgentEvent } from "@aimi/protocol";
import type { Logger } from "../logging/logger.js";
import { DeltaAggregator, FLOOD, isDeltaEvent, truncatePayload } from "./eventFlood.js";

/**
 * 会话事件记录：`SessionRecord` 的唯一形态（§E 统一信封）。
 * `seq` 由 EventBus 按会话独立分配；`ts` 为该事件（聚合事件取首条 delta）的时刻。
 */
export interface SessionRecord {
  readonly sessionId: string;
  readonly seq: number;
  readonly ts: number;
  readonly agentEvent: AgentEvent;
}

/**
 * EventBus 的三条扇出路由。**per-slot override**：同一槽位（persist/ui/notify）重复注册即覆盖，
 * 各槽位互不影响；本次未提供的槽位保留原值（「未提供」不等于「清除」）。
 */
export interface EventBusHandlers {
  /**
   * 持久化路（T11 接 `ConversationRepository.appendEvent(sessionId, rec.seq, rec.agentEvent, rec.ts)`）
   * ——**seq 唯一权威在本总线**，仓储只执行写入、不自行分配序号。
   * EventBus 内部 await，失败不阻塞 ui 路——记 ERROR 日志后继续。
   */
  persist?: (rec: SessionRecord) => Promise<void>;
  /** UI 路（T11 接 UiFanout）。 */
  ui?: (rec: SessionRecord) => void;
  /** 通知路（M1；M0 允许缺省）。 */
  notify?: (rec: SessionRecord) => void;
}

/** 单会话待产出的聚合槽：与 DeltaAggregator 的 pending 一一对应，持有兑现器与窗口定时器。 */
interface PendingSlot {
  /** 窗口锚点：首条 delta 的 now（合并事件的 ts）。 */
  readonly ts: number;
  /** 该窗口使用的时钟（取首条 delta 的注入时钟，保证同一窗口内时钟一致）。 */
  readonly now: () => number;
  /** 等该合并事件的各次 publish 的兑现器。 */
  readonly resolvers: ((seq: number) => void)[];
  /** 窗口到期定时器；冲刷/产出时取消。 */
  timer?: ReturnType<typeof setTimeout>;
}

/** 兜底日志出口：未注入 logger 时把 ERROR 以一行 JSON 落 stderr（不静默吞掉 persist 失败）。 */
function logToStderr(msg: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ ts: Date.now(), level: "ERROR", component: "eventBus", msg, ...fields }));
}

/**
 * 事件总线（§E）：进程内单线程序列化分发（Node 事件循环天然保序——异常 #12 的根）。
 * **seq 唯一权威在此**：按会话独立、严格 +1、从 0 起（createSession 的初始事件占 seq 0——T9 负责）；
 * Repository 只按本总线给出的 seq 执行写入（评审裁决 R1）。
 * 洪水控制在 publish 入口生效（规则集中于此，别处不重复实现）：
 *   - text_delta/thinking：≤100ms 窗口聚合为一条（窗口边界 flush：非 delta 事件到达先冲刷 pending）；
 *   - 单事件 payload 超 8KB：`text`/`outputExcerpt` 截断为 8192 字符 + "…(truncated)"。
 * 落库按会话串行（seq 分配是同步的，若并发 await 则 ui 派发顺序可能与 seq 顺序不一致）；
 * 任一路失败都不阻塞后续事件处理（§11）。
 */
export class EventBus {
  #handlers: EventBusHandlers = {};
  readonly #logger: Logger | undefined;
  /** 每会话下一个 seq（从 0 起——本模块不预占 seq 0）。 */
  readonly #nextSeq = new Map<string, number>();
  /** 每会话待产出的 delta 聚合槽。 */
  readonly #slots = new Map<string, PendingSlot>();
  /** 每会话落库顺序链：前一条 persist 落定后才发下一条。 */
  readonly #persistChains = new Map<string, Promise<void>>();
  readonly #aggregator = new DeltaAggregator();

  /**
   * @param opts.logger 可选日志门面（§13）。persist 失败记 ERROR；缺省时走 stderr 兜底出口
   *   （装配层 T11 应注入落盘 logger）。
   */
  constructor(opts?: { logger?: Logger }) {
    this.#logger = opts?.logger;
  }

  /**
   * per-slot override：同一槽位（persist/ui/notify）重复注册即覆盖（单消费者语义，同 T7 单槽），
   * 各槽位互不影响；本次未提供的槽位保留原值（「未提供」不等于「清除」）。
   * @param handlers 要生效（或替换）的槽位回调。
   */
  subscribe(handlers: EventBusHandlers): void {
    this.#handlers = { ...this.#handlers, ...handlers };
  }

  /**
   * 发布一条 agent 事件：洪水变换 → seq 分配 → persist(等待) → ui/notify(同步)。
   * 返回该调用最终产出的最后一条事件的 seq（delta 被聚合时，聚合 flush 完成后三调用方拿到同一 seq）。
   * @param sessionId 会话 id（seq 计数器与聚合缓冲均按会话隔离）。
   * @param agentEvent 归一化 agent 事件（截断在此入口统一施加）。
   * @param opts.now 可注入时钟（默认 `Date.now`），供测试；同一聚合窗口取首条 delta 的时钟。
   */
  async publish(sessionId: string, agentEvent: AgentEvent, opts?: { now?: () => number }): Promise<number> {
    const now = opts?.now ?? Date.now;
    const event = truncatePayload(agentEvent);
    const at = now();

    if (isDeltaEvent(event)) {
      const flushed = this.#aggregator.offer(sessionId, event, at);
      if (flushed !== null) {
        // 缓冲本条之前先冲刷上一条聚合（窗口已过或 delta 类型切换）：旧聚合 seq 更早，顺序不可倒置。
        const stale = this.#takeSlot(sessionId);
        if (stale === undefined) {
          // 防御：槽与缓冲应一一对应；真发生时按当前时刻产出，宁可 seq 略偏也不丢事件。
          await this.#produce(sessionId, flushed, at);
        } else {
          void this.#produce(sessionId, flushed, stale.ts).then((seq) => {
            for (const resolve of stale.resolvers) resolve(seq);
          });
        }
      }
      return this.#awaitAggregate(sessionId, at, now);
    }

    // 非 delta = 窗口边界：先冲刷本会话 pending，再产出自身（顺序：合并事件在前）。
    await this.#flushSession(sessionId, at);
    return this.#produce(sessionId, event, at);
  }

  /**
   * 冲刷全部会话的 pending 聚合（装配层关闭时调用；测试用 fake timers 推进亦可）。无 pending 时空转。
   */
  async flush(): Promise<void> {
    for (const [sessionId, slot] of [...this.#slots]) {
      await this.#flushSession(sessionId, slot.now());
    }
  }

  /** 把本条 delta 计入聚合槽，返回在聚合产出时兑现为该合并事件 seq 的承诺。 */
  #awaitAggregate(sessionId: string, ts: number, now: () => number): Promise<number> {
    const existing = this.#slots.get(sessionId);
    if (existing !== undefined) {
      return new Promise<number>((resolve) => { existing.resolvers.push(resolve); });
    }
    const slot: PendingSlot = { ts, now, resolvers: [] };
    slot.timer = setTimeout(() => { void this.#flushSession(sessionId, slot.now()); }, FLOOD.deltaWindowMs);
    this.#slots.set(sessionId, slot);
    return new Promise<number>((resolve) => { slot.resolvers.push(resolve); });
  }

  /** 产出并兑现某会话的待产出聚合；无槽时为空转。 */
  async #flushSession(sessionId: string, now: number): Promise<void> {
    const slot = this.#takeSlot(sessionId);
    if (slot === undefined) return;
    const merged = this.#aggregator.flush(sessionId, now);
    if (merged === null) return; // 防御：槽与缓冲一一对应，正常不可达。
    const seq = await this.#produce(sessionId, merged, slot.ts);
    for (const resolve of slot.resolvers) resolve(seq);
  }

  /** 取出并摘除会话槽（同时取消其窗口定时器，避免定时器泄漏）。 */
  #takeSlot(sessionId: string): PendingSlot | undefined {
    const slot = this.#slots.get(sessionId);
    if (slot === undefined) return undefined;
    this.#slots.delete(sessionId);
    if (slot.timer !== undefined) {
      clearTimeout(slot.timer);
      slot.timer = undefined;
    }
    return slot;
  }

  /** 分配 seq（同步）→ 串行落库（等待）→ ui/notify（同步）；返回本次事件的 seq。本方法不 reject（落库/ui 失败均已隔离）。 */
  async #produce(sessionId: string, agentEvent: AgentEvent, ts: number): Promise<number> {
    const seq = this.#nextSeq.get(sessionId) ?? 0;
    this.#nextSeq.set(sessionId, seq + 1);
    const rec: SessionRecord = { sessionId, seq, ts, agentEvent };

    await this.#persistQueued(rec);
    this.#invoke("ui", rec);
    this.#invoke("notify", rec);
    return seq;
  }

  /**
   * 串行的落库：同一会话的 persist 严格按 publish 顺序依次执行（前一条落定才发下一条），
   * 保住 §12 保序（含 ui 派发顺序与 seq 顺序一致）。失败已隔离（记 ERROR 后继续），
   * 故返回的 Promise **永不 reject**。
   */
  #persistQueued(rec: SessionRecord): Promise<void> {
    const persist = this.#handlers.persist;
    if (persist === undefined) return Promise.resolve();
    const prev = this.#persistChains.get(rec.sessionId) ?? Promise.resolve();
    const run = prev.then(async () => {
      try {
        await persist(rec);
      } catch (err) {
        // §11「数据异常不影响后续处理」：落库失败不阻塞 ui/notify，也不阻塞后续事件。
        this.#error("event persist failed", rec, err);
      }
    });
    this.#persistChains.set(rec.sessionId, run);
    // 链尾落定后即可摘除（同一会话的下一次落库会重新以已解决的 Promise 起链），避免 Map 无界增长。
    void run.then(() => {
      if (this.#persistChains.get(rec.sessionId) === run) this.#persistChains.delete(rec.sessionId);
    });
    return run;
  }

  /** 同步派发一条路由回调；回调抛错记 ERROR 后继续（不阻塞后续事件、不产生未处理拒绝）。 */
  #invoke(route: "ui" | "notify", rec: SessionRecord): void {
    const handler = this.#handlers[route];
    if (handler === undefined) return;
    try {
      handler(rec);
    } catch (err) {
      this.#error(`${route} handler failed`, rec, err);
    }
  }

  /** 记 ERROR：注入 logger 优先；未注入时落 stderr 兜底。日志自身失败也不影响事件处理。 */
  #error(msg: string, rec: SessionRecord, err: unknown): void {
    const fields = { sessionId: rec.sessionId, seq: rec.seq, error: err instanceof Error ? err.message : String(err) };
    if (this.#logger === undefined) {
      logToStderr(msg, fields);
      return;
    }
    try {
      this.#logger.error(msg, fields);
    } catch {
      // 日志出口不可用（磁盘等）不得反向影响事件处理。
    }
  }
}
