/**
 * 配对提交失败限速（core-loop §5.3 防线）：每远端在滚动窗口 `windowMs` 内至多承受 `max` 次
 * 失败提交，到线（第 `max+1` 次起）即拒——把无凭据的 10^8 码空间在线穷举挡在门外。
 * why 只记失败不记成功：正常用户一次配对成功即离开，成功不消耗额度；历史失败也**不清账**
 * （它仍是风险信号），由窗口自然滚动遗忘。限速的 key 由调用方给出（进程内状态，不落库）：
 * 配对只发生在运行中的服务进程上，CLI pair 只签发码不提交，故无需跨进程共享计数。
 */
/** 限速滚动窗口（毫秒，默认 10 分钟）：一次「服务端出码 → 手机键入」人工往返的充分时长；
 * 穷举者在该窗口内至多 8 次尝试，10^8 空间的命中率可忽略。 */
export const PAIRING_LIMITER_WINDOW_MS = 600_000;
/** 窗口内失败提交上限（次）：对误抄一两码的人工重试足够宽松，对自动化穷举足够致命。 */
export const PAIRING_LIMITER_MAX_FAILURES = 8;

/**
 * 配对失败限速器：`allow` 询问是否放行下一次提交，`fail` 在一次失败后记账。
 * 计数是**滚动窗口**内的失败次数（半开区间 `now - t < windowMs`，恰等窗口的旧账视为过期）。
 * 单调不重入：`allow` 不产生任何记账副作用（成功路径零痕迹）。
 */
export class PairingLimiter {
  readonly #windowMs: number;
  readonly #max: number;
  readonly #now: () => number;
  /** key → 窗口内失败时刻序列；过期条目在读写时惰性裁剪（无独立定时器，免空转）。 */
  readonly #hits = new Map<string, number[]>();

  /**
   * @param deps - 缺省即生产形态（600_000ms 窗口 / 8 次上限 / 系统时钟）；测试注入
   *   `windowMs`/`max` 收紧阈值、注入 `now` 推进虚拟时间（不依赖系统定时器粒度）
   */
  constructor(deps?: { windowMs?: number; max?: number; now?: () => number }) {
    this.#windowMs = deps?.windowMs ?? PAIRING_LIMITER_WINDOW_MS;
    this.#max = deps?.max ?? PAIRING_LIMITER_MAX_FAILURES;
    this.#now = deps?.now ?? Date.now;
  }

  /**
   * 该 key 的下一次配对提交是否放行：窗口内失败次数不足 `max` 才放行。
   *
   * @param key - 远端标识（调用方归一的远端主机地址）
   * @returns true = 放行；false = 已到线（调用方应拒绝并保持沉默计数）
   */
  allow(key: string): boolean {
    return this.#prune(key).length < this.#max;
  }

  /**
   * 记一次失败提交（核销失败/限速拒绝路径之外的真实失败）。
   *
   * @param key - 远端标识
   */
  fail(key: string): void {
    const hits = this.#prune(key);
    hits.push(this.#now());
    this.#hits.set(key, hits);
  }

  /** 裁剪掉已滑出窗口的旧账并回写；返回窗口内的失败序列（空则顺手清 key，防 Map 膨胀）。 */
  #prune(key: string): number[] {
    const now = this.#now();
    const alive = (this.#hits.get(key) ?? []).filter((t) => now - t < this.#windowMs);
    if (alive.length === 0) this.#hits.delete(key);
    else this.#hits.set(key, alive);
    return alive;
  }
}
