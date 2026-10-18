import type { SessionState } from "@aimi/protocol";
import type { EventBus, SessionRecord } from "../events/eventBus.js";
import type { Logger } from "../logging/logger.js";

/** 警报文案的分钟数下限（1）：亚分钟阈值仅供测试提速注入，文案取整后仍须可读（不出「超 0 分钟」）。 */
const STALL_MINUTES_FLOOR = 1;

/**
 * 生成停滞告警的用户可读文案（纯函数）。why 纯函数化：文案是手机端呈现的契约面，
 * 以真实阈值（600_000 → 10 分钟）直接断言无需等待真实时长。
 *
 * @param thresholdMs - 停滞判定阈值（毫秒）；按分钟四舍五入换算，不足 1 分钟按 1 分钟计
 * @returns 如 `会话疑似停滞（超 10 分钟无新事件）`
 */
export function stallNoticeText(thresholdMs: number): string {
  const minutes = Math.max(STALL_MINUTES_FLOOR, Math.round(thresholdMs / 60_000));
  return `会话疑似停滞（超 ${minutes} 分钟无新事件）`;
}

/**
 * running 会话停滞看门狗：会话进入 running 后超阈值无新事件 → 经总线发一条
 * `notice{warn}`（文案见 `stallNoticeText`；通知分类 stalled 由手机本地派生——server 只发
 * 语义 notice）。**一段停滞只提示一次**：告警后不重挂计时，静默直至下一真实事件到达才恢复
 * 计时——防「告警自身触发重计时」的定时轰炸。
 *
 * 消费形态：构造即 `bus.subscribe({ observe })`——observe 是总线的内部观测槽位（不占通知路
 * 语义），每条事件产出后同步回调；本类据此自观察每会话最近状态与活跃时刻，不回读编排层。
 *
 * **自反馈环的切断（评审重点）**：本类发出的 notice 本身也是事件、会回到 observe——若把它
 * 当作「下一真实事件」重置计时，一次告警就会自我续期成每阈值一条的定时轰炸。选型为
 * **notice 事件一律不重置 running 计时**（对比另一选型「发布前置标记、observe 按引用忽略
 * 自产 notice」）：notice 是服务端派生事实（审批失效/重放超限/打断提示等），不代表 agent
 * 侧有产出，作为「会话仍活跃」的证据本就不足；一刀切「notice 不算活跃」无需维护自产标记
 * 的置位/复位时序，也不给未来其他 notice 来源留同类坑。
 */
export class SessionWatchdog {
  readonly #bus: EventBus;
  readonly #thresholdMs: number;
  readonly #now: () => number;
  readonly #logger: Logger | undefined;
  /** 会话 id → 最近一次真实事件（非 notice）的时刻（毫秒）；仅供告警时的静默时长诊断日志。 */
  readonly #lastTs = new Map<string, number>();
  /** 会话 id → 观察到的最近状态（自观察，不回读 SessionManager）；非 running 的会话不计时。 */
  readonly #states = new Map<string, SessionState>();
  /** 会话 id → 停滞计时器；缺项 = 未挂载（未 running/已告警进入静默/非 running 已清/已 stop）。 */
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** stop 后置位：observe 全失活——stop 后到达的事件不再挂载（stop 后零行为）。 */
  #stopped = false;

  /**
   * @param deps.bus - 事件总线；观察自 observe 槽位，告警经 publish 回流
   * @param deps.thresholdMs - 停滞判定阈值（毫秒）；来自 config `watchdogMs`（zod 下限 5000）
   * @param deps.now - 可注入时钟（毫秒），供测试/诊断；缺省系统时间
   * @param deps.logger - 可选日志门面；告警触发与发布失败时留痕
   * 副作用：接管总线的 observe 槽位（observe 每槽位单消费者——重复注册以最后者为准，
   *   装配层不得另注册 observe 消费者）
   */
  constructor(deps: { bus: EventBus; thresholdMs: number; now?: () => number; logger?: Logger }) {
    this.#bus = deps.bus;
    this.#thresholdMs = deps.thresholdMs;
    this.#now = deps.now ?? Date.now;
    this.#logger = deps.logger;
    deps.bus.subscribe({ observe: (rec) => { this.#observe(rec); } });
  }

  /**
   * 停止看门狗：清全部会话的停滞计时器并使 observe 失活（Application close 时调用）。
   * 幂等；重复调用无副作用。
   */
  stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#lastTs.clear();
    this.#states.clear();
  }

  /**
   * 观测一条已产出事件：更新会话活跃记账并维护计时挂载。
   *
   * @param rec - 已定序事件
   */
  #observe(rec: SessionRecord): void {
    if (this.#stopped) return;
    const event = rec.agentEvent;
    // 自反馈环切断（见类注释）：notice 一律不算活跃证据，不重置/不恢复计时。
    if (event.type === "notice") return;
    if (event.type === "state") {
      this.#states.set(rec.sessionId, event.state);
      if (event.state === "running") this.#arm(rec.sessionId);
      else this.#disarm(rec.sessionId); // 非 running（含 waiting/终态/starting）：清计时
      return;
    }
    // 非状态事件：运行中的会话视为活跃证据 → 重置计时（含告警后静默期的恢复挂载）。
    if (this.#states.get(rec.sessionId) === "running") this.#arm(rec.sessionId);
  }

  /**
   * 为会话挂载（或重置）停滞计时器：任一真实事件即重置——计时器本身就是「自上次活跃起
   * 已等待多久」的载体，无需再比对时刻。
   *
   * @param sessionId - 目标会话
   */
  #arm(sessionId: string): void {
    const prev = this.#timers.get(sessionId);
    if (prev !== undefined) clearTimeout(prev);
    this.#lastTs.set(sessionId, this.#now());
    this.#timers.set(
      sessionId,
      setTimeout(() => { void this.#stall(sessionId); }, this.#thresholdMs),
    );
  }

  /** 摘除会话的停滞计时器（未挂载时无事发生）；活跃时刻记账一并清（已不计时，无诊断意义）。 */
  #disarm(sessionId: string): void {
    const timer = this.#timers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(sessionId);
    }
    this.#lastTs.delete(sessionId);
  }

  /**
   * 计时器到点：会话仍处 running → 发一条停滞 warn notice；**发后不重挂计时**——静默直至
   * 下一真实事件（observe 的 `#arm` 恢复挂载），保证一段停滞只提示一次。
   *
   * @param sessionId - 目标会话
   */
  async #stall(sessionId: string): Promise<void> {
    this.#timers.delete(sessionId); // 先摘表项：告警路径不重挂（下一真实事件才恢复）
    if (this.#stopped) return;
    if (this.#states.get(sessionId) !== "running") return; // 防御：非 running 不该有计时器在途
    const last = this.#lastTs.get(sessionId);
    const silentMs = last === undefined ? this.#thresholdMs : this.#now() - last;
    this.#logger?.warn("session stalled", { sessionId, thresholdMs: this.#thresholdMs, silentMs });
    try {
      await this.#bus.publish(sessionId, { type: "notice", severity: "warn", text: stallNoticeText(this.#thresholdMs) });
    } catch (err) {
      // publish 契约不 reject；此处兜基础设施级异常，告警失败不拖垮看门狗本身。
      this.#logger?.error("watchdog alert publish failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
