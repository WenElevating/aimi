import type { AgentEvent } from "@aimi/protocol";
import type { Logger } from "../logging/logger.js";
import { DeltaAggregator, FLOOD, isDeltaEvent, truncatePayload } from "./eventFlood.js";

/**
 * 一条已定序的会话事件：持久化/界面/通知三条路由共用此唯一形态。
 */
export interface SessionRecord {
  /** 事件所属会话，由服务端创建会话时生成，此后不变 */
  readonly sessionId: string;
  /** 会话内单调递增的序号：从 0 起、严格 +1；落库顺序与手机端呈现顺序均以它为准 */
  readonly seq: number;
  /** 事件发出时刻（毫秒时间戳）；合并事件取窗口内首条增量的时刻 */
  readonly ts: number;
  /** 归一化后的 agent 事件本体；文本/输出类长载荷已在发布入口截断 */
  readonly agentEvent: AgentEvent;
}

/**
 * 会话事件总线的三条扇出路由槽位，由服务端装配层注册、总线在每条事件产出后逐条调用。
 * 同一槽位重复注册时以最后注册者为准（每槽位单消费者），各槽位互不影响；
 * 注册时未提供的槽位保留原值——未提供不等于清除。
 */
export interface EventBusHandlers {
  /** 持久化路：把事件追加写入会话历史。序号由总线统一分配，实现按收到的值落库、不得自行编序；允许拒绝，总线记错误日志后继续，不中断其余路由 */
  persist?: (rec: SessionRecord) => Promise<void>;
  /** 界面路：把事件实时推送给当前在线的手机端。同步调用，回调抛错由总线隔离 */
  ui?: (rec: SessionRecord) => void;
  /** 通知路：有新事件到达时向用户发提醒；当前版本可以暂不注册 */
  notify?: (rec: SessionRecord) => void;
}

/** 一个会话正在聚合中的增量窗口，以及产出后向各次发布请求回执序号的挂起状态。 */
interface PendingSlot {
  /** 窗口首条增量的时刻（毫秒），作为合并事件的发出时刻 */
  readonly ts: number;
  /** 产出本窗口时使用的时钟（取首条增量带入的那份，保证同一窗口内计时一致） */
  readonly now: () => number;
  /** 等待本窗口产出的各次发布请求；产出后按登记顺序兑现为合并事件的序号 */
  readonly resolvers: ((seq: number) => void)[];
  /** 窗口到期定时器；提前产出时取消，避免泄漏 */
  timer?: ReturnType<typeof setTimeout>;
}

/** 兜底日志出口：装配层未注入日志门面时，错误仍以一行 JSON 打到标准错误流，保证失败可见、不被静默吞掉。 */
function logToStderr(msg: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ ts: Date.now(), level: "ERROR", component: "eventBus", msg, ...fields }));
}

/**
 * 会话事件总线：接收 agent 事件，统一分配序号并分发给持久化/界面/通知三条路由。
 *
 * 序号是本总线的独占职责：按会话独立计数，从 0 起、严格 +1（会话创建时的初始事件占 0）；
 * 其他任何模块（含会话历史仓储）都按收到的值落库，不得自行编序。
 *
 * 洪水控制集中在发布入口，别处不再实现：
 *   - 连续的文本/思考增量按不超过 100ms 的窗口合并成一条；非增量事件到达视为窗口边界，先产出已合并内容再处理自身；
 *   - 单条载荷超过 8KB 时，把文本/输出摘录截断到 8192 字符并追加"…(truncated)"。
 *
 * 同一会话的写库严格按序串行（前一条完成才写下一条），保证界面呈现顺序与序号一致；
 * **直播产出顺序 = 发布调用顺序**（每会话发布链，见 `#publishChains`）——适配器一行产出
 * 多事件或同同步段连发时，seq 赋值与 ui 分发都按调用序落位；同窗口增量按登记序兑现同一 seq。
 * 任一路由失败都不阻塞后续事件的处理。
 */
export class EventBus {
  #handlers: EventBusHandlers = {};
  readonly #logger: Logger | undefined;
  /** 每会话下一条事件的序号；缺省从 0 起，重启恢复的会话由启动装配播种续值 */
  readonly #nextSeq = new Map<string, number>();
  /** 每会话正在聚合中的增量窗口 */
  readonly #slots = new Map<string, PendingSlot>();
  /** 每会话的落库串行链，保证写库顺序与序号一致 */
  readonly #persistChains = new Map<string, Promise<void>>();
  /**
   * 每会话发布链（why 同步段登记即入队）：适配器一行可产出多事件、同一同步段也可连发多条——
   * 任何"先冲刷增量窗再产出自身"的中间 await 都会放行同批后继抢跑（seq 倒挂、直播乱序）。
   * 故每次 publish 在同步段把"产出动作"登记到链尾：前一条完成才开始下一条，调用顺序 =
   * 产出顺序 = seq 顺序 = 直播顺序。链尾 = 最近一条已登记步的完成；增量路登记的是"入列+
   * 布防"步（不等待窗口关闭——否则后继全被拖到窗口截止），产出兑现走各自的 resolver。
   */
  readonly #publishChains = new Map<string, Promise<unknown>>();
  readonly #aggregator = new DeltaAggregator();

  /**
   * @param opts.logger - 可选的日志门面；落库失败、路由回调抛错时用它记错误。
   *   缺省时退回标准错误流的兜底出口——装配层应注入真正落盘的实现。
   */
  constructor(opts?: { logger?: Logger }) {
    this.#logger = opts?.logger;
  }

  /**
   * 注册（或替换）扇出路由。
   *
   * @param handlers - 本次要生效的路由回调；只传需要新增或替换的槽位，未提及的槽位保持原值。同一槽位重复注册时以最后传入者为准
   * 副作用：修改内部路由表，立即对后续事件生效
   */
  subscribe(handlers: EventBusHandlers): void {
    this.#handlers = { ...this.#handlers, ...handlers };
  }

  /**
   * 启动恢复时为既有会话播种下一条事件的序号，使服务重启后新事件的序号紧接重启前的历史、不发生重复。
   * 只能在启动装配期调用一次：运行期重复播种会把计数器回拨，导致序号冲突。
   *
   * @param sessionId - 目标会话标识，须与其既有历史中的会话一致
   * @param nextSeq - 该会话下一条事件应使用的序号（取会话历史中最大序号 + 1）
   */
  seedSession(sessionId: string, nextSeq: number): void {
    this.#nextSeq.set(sessionId, nextSeq);
  }

  /**
   * 发布一条 agent 事件，由总线分配序号并分发给已注册的路由。
   *
   * @param sessionId - 事件所属会话；序号计数与增量聚合均按会话隔离
   * @param agentEvent - 归一化后的 agent 事件；长载荷截断在此统一处理，调用方无需预处理
   * @param opts.now - 可注入时钟（毫秒），供测试使用；缺省取系统时间，同一聚合窗口以首条增量带入的时钟为准
   * @returns Promise，resolve 为本次发布最终产出的最后一条事件的序号；连续增量被合并成一条时，同窗口的多次发布 resolve 同一序号
   * @throws 正常情况不会 reject：载荷截断、聚合与路由失败均在总线内部记错误日志并继续，不向外抛出
   * 副作用：为事件消耗一个序号；按注册情况写会话历史、触发界面/通知分发
   */
  publish(sessionId: string, agentEvent: AgentEvent, opts?: { now?: () => number }): Promise<number> {
    const now = opts?.now ?? Date.now;
    const event = truncatePayload(agentEvent);
    const at = now();

    if (isDeltaEvent(event)) {
      // 增量路：offer 与窗口布防在调用时刻同步完成（窗口锚点 = 本条调用时刻，定时器语义不变）；
      // offer 交出的旧窗产物（类型切换/旧窗已到截止——其内增量注册先于本条）的产出步登链，
      // 排在既有产出之后（注册序）并按登记序兑现旧窗的 await 者。
      const flushed = this.#aggregator.offer(sessionId, event, at);
      if (flushed !== null) {
        const stale = this.#takeSlot(sessionId);
        this.#enqueueProduce(sessionId, async () => {
          if (stale === undefined) {
            // 防御：槽与缓冲应一一对应；真发生时按当前时刻产出，宁可 seq 略偏也不丢事件。
            await this.#produce(sessionId, flushed, at);
            return;
          }
          const seq = await this.#produce(sessionId, flushed, stale.ts);
          for (const resolve of stale.resolvers) resolve(seq);
        });
      }
      return this.#awaitAggregate(sessionId, at, now);
    }

    // 非增量路（窗口边界）：**同步**兜干"注册先于本条"的增量窗（此刻缓冲内恰为注册序在本条
    // 之前的增量——晚于本条到货者不在窗内、开新窗，不被拖进本条边界），产出步（先窗后己）登链。
    // why 登链而非裸 produce：同一同步段连发多条（适配器一行产出 usage+finished）时，裸produce
    // 的中间 await 会放行同批后继抢跑——finished 先占 seq 又先落库，直播乱序 ≠ seq 序。
    // 登链后调用顺序 = 产出顺序 = seq 顺序 = 直播顺序。
    const slot = this.#takeSlot(sessionId);
    const flushed = this.#aggregator.flush(sessionId, at);
    let settle!: (seq: number) => void;
    const own = new Promise<number>((resolve) => { settle = resolve; });
    this.#enqueueProduce(sessionId, async () => {
      if (flushed !== null) {
        const winSeq = await this.#produce(sessionId, flushed, slot?.ts ?? at);
        if (slot !== undefined) for (const resolve of slot.resolvers) resolve(winSeq);
      }
      settle(await this.#produce(sessionId, event, at));
    });
    return own;
  }

  /**
   * 立即产出所有会话仍在聚合中的增量窗口，不等各自的窗口计时到期；没有待产出窗口时直接返回。
   * 供服务端关闭前调用，确保聚合中的增量不因关停而丢失。
   *
   * @returns Promise，resolve 时所有会话的聚合内容均已按序分发完成
   */
  async flush(): Promise<void> {
    for (const [sessionId, slot] of [...this.#slots]) {
      await this.#flushSession(sessionId, slot.now());
    }
  }

  /**
   * 等待"已发布"与"已落库"对齐：先 `flush()` 冲出仍在聚合中的增量窗口，再逐轮等待各会话
   * 发布链（`#publishChains`，含其内嵌的落库串行链）排干。供断连重放的**快照切点**调用
   * （core-loop §5.2）：重放读库前必须保证已发布事件全数落库，否则快照读漏帧、重放起点
   * 出现假缺口（review 重点 1）。
   *
   * why 循环而非单轮快照：链的登记发生在 publish 的同步段（offer 即入队），等待期间到达的
   * 新发布会把产出步挂到已快照链尾**之后**——单轮 await 只覆盖"快照时刻已登记"的步骤。
   * 故按"快照 → await → 再快照"循环，直到某一轮快照为空（发布停顿时必然收敛；
   * 持续发布的会话会让本方法一直等待，调用方须处在发布静默期——重放编排即如此）。
   *
   * @returns Promise，resolve 时所有已发布事件（含聚合产物）均已完成落库与路由分发
   */
  async settle(): Promise<void> {
    await this.flush();
    for (;;) {
      const snapshot = [...this.#publishChains.values()];
      if (snapshot.length === 0) return;
      await Promise.all(snapshot); // 链尾永不 reject（step 契约，见 #enqueueProduce）
    }
  }

  /**
   * 把一个产出动作登记到会话发布链尾（同步段调用）：前一条完成才开始本条——
   * 调用顺序即产出顺序。链尾完成即摘除计数项（下次发布会重新起链），避免长期空闲的会话仍占内存。
   *
   * @param sessionId - 会话 id
   * @param step - 产出动作（内部自含"先窗后己"等顺序约定；永不 reject——produce 已内部隔离）
   */
  #enqueueProduce(sessionId: string, step: () => Promise<void>): void {
    const prev = this.#publishChains.get(sessionId) ?? Promise.resolve();
    const run = prev.then(step);
    this.#publishChains.set(sessionId, run);
    void run.then(
      () => { if (this.#publishChains.get(sessionId) === run) this.#publishChains.delete(sessionId); },
      // 防御性兜底：step 契约永不 reject（produce 已内部隔离），此处仅防未来改动破坏契约时
      // 出现 unhandled rejection 拖垮进程；链条照常收尾。
      () => { if (this.#publishChains.get(sessionId) === run) this.#publishChains.delete(sessionId); },
    );
  }

  /**
   * 把当前发布登记为等待聚合产出；窗口内容合并产出后，按登记顺序回执同一序号。
   * 调用时刻同步布防（窗口定时器锚点 = 首条增量的调用时刻）。
   *
   * @param ts - 窗口首条增量的时刻（毫秒），用作合并事件的发出时刻
   * @param now - 本窗口使用的时钟
   * @returns Promise，resolve 为合并事件的序号
   */
  #awaitAggregate(sessionId: string, ts: number, now: () => number): Promise<number> {
    const existing = this.#slots.get(sessionId);
    if (existing !== undefined) {
      return new Promise<number>((resolve) => { existing.resolvers.push(resolve); });
    }
    const slot: PendingSlot = { ts, now, resolvers: [] };
    // 定时器兜出也登链：慢落库（>100ms）期间到点的窗口不得越过在途产出（注册序不可倒置）。
    slot.timer = setTimeout(() => {
      this.#enqueueProduce(sessionId, async () => {
        const s = this.#takeSlot(sessionId);
        if (s === undefined) return; // 已被边界冲刷兜出（登链前被先行者收走）
        const merged = this.#aggregator.flush(sessionId, s.now());
        if (merged === null) return; // 防御：槽与缓冲一一对应，正常不可达。
        const seq = await this.#produce(sessionId, merged, s.ts);
        for (const resolve of s.resolvers) resolve(seq);
      });
    }, FLOOD.deltaWindowMs);
    this.#slots.set(sessionId, slot);
    return new Promise<number>((resolve) => { slot.resolvers.push(resolve); });
  }

  /**
   * 产出某会话已到期的聚合窗口并分发；没有待产出窗口时直接返回。
   *
   * @param sessionId - 目标会话
   * @param now - 产出时刻（毫秒）
   */
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

  /**
   * 完成一条事件的产出：占用下一序号、按会话串行写库，随后触发界面与通知路由。
   *
   * @param sessionId - 目标会话
   * @param agentEvent - 要产出的归一化事件（已截断）
   * @param ts - 事件发出时刻（毫秒）
   * @returns Promise，resolve 为本条事件的序号；永不 reject——写库与路由失败均已在内部隔离并记日志
   * 副作用：消耗该会话下一个序号；按注册情况写库并触发界面/通知分发
   */
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
   * 让同一会话的事件按发布顺序依次写库：前一条完成才开始下一条，保证呈现顺序与序号一致。
   *
   * @param rec - 待写库的事件
   * @returns Promise，resolve 表示该条写库完成（或该事件无需写库）；永不 reject——写库失败会记错误日志后继续
   */
  #persistQueued(rec: SessionRecord): Promise<void> {
    const persist = this.#handlers.persist;
    if (persist === undefined) return Promise.resolve();
    const prev = this.#persistChains.get(rec.sessionId) ?? Promise.resolve();
    const run = prev.then(async () => {
      try {
        await persist(rec);
      } catch (err) {
        // 数据异常不影响后续处理：落库失败不阻塞 ui/notify，也不阻塞后续事件。
        this.#error("event persist failed", rec, err);
      }
    });
    this.#persistChains.set(rec.sessionId, run);
    // 链尾完成即摘除计数项（下次落库会重新起链），避免长期空闲的会话仍占内存。
    void run.then(() => {
      if (this.#persistChains.get(rec.sessionId) === run) this.#persistChains.delete(rec.sessionId);
    });
    return run;
  }

  /**
   * 同步调用一条界面/通知路由回调；回调抛错时记错误日志并继续，不影响后续事件分发。
   *
   * @param route - 目标路由
   * @param rec - 要分发的事件
   */
  #invoke(route: "ui" | "notify", rec: SessionRecord): void {
    const handler = this.#handlers[route];
    if (handler === undefined) return;
    try {
      handler(rec);
    } catch (err) {
      this.#error(`${route} handler failed`, rec, err);
    }
  }

  /**
   * 记一条错误日志：优先使用注入的日志门面，未注入时退回标准错误流；
   * 日志出口自身不可用时放弃本次记录，绝不反向影响事件分发。
   *
   * @param msg - 错误摘要
   * @param rec - 相关事件（取其会话与序号入日志字段）
   * @param err - 触发本次记录的错误
   */
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
