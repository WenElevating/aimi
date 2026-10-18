import { WebSocket } from "ws";
import type { Logger } from "../../logging/logger.js";
import type { Conveyor } from "../conveyor.js";
import { createClientSideConveyor } from "./messagePipe.js";

/**
 * 重拨退避基数（毫秒）：首败后 1s 再拨。why 1s：relay 短暂重启的空窗是秒级可愈的，
 * 1s 起算的重连延迟手机端无感；更激进（如 100ms）会在 relay 停机时形成无效拨号风暴。
 */
export const DIAL_RETRY_BASE_MS = 1_000;

/**
 * 重拨退避封顶（毫秒）：relay 长时间不可用时退避不再增长（60s 一试）。why 60s：既避免无限
 * 退避把 relay 恢复后的重连延迟拖到难以观测，又保证常驻服务在 relay 长时间下线期间的开销可忽略。
 */
export const DIAL_RETRY_MAX_MS = 60_000;

/**
 * 抖动半宽（比例）：重拨延迟在名义值 ±20% 内随机化。why：多实例同时拨入失败时，若按同一
 * 名义延迟重拨会周期性踩踏 relay 的恢复窗口；随机化把重拨时刻摊开。
 */
const JITTER_HALF = 0.2;

/**
 * 拨入请求携带 server-token 的 header 名。
 * S2 对接点：relay 侧按同名 header 校验（不符在升级层拒绝——dial 侧表现为拨入失败）。
 */
export const SERVER_TOKEN_HEADER = "x-aimi-server-token";

/** 拨入连接在应用编排层的远端标签：relay 链路的 `remote` 恒为该值（诊断与审计归属）。 */
export const REMOTE_LABEL = "relay";

/** 本地关停 relay 通道的原因（与 LanWsServer 的 "server shutting down" 同语义位）。 */
const RELAY_CLOSED_REASON = "relay client closed";

/**
 * 一次成功拨入的产物：`conveyor` 供编排层接管（同帧协议透传——来自 relay 的客户端帧直接进
 * Application 入站编排）；`close` 是该连接的归寂面，任何原因终结（对端关/本地关/错误）时 resolve。
 */
export interface DialResult {
  readonly conveyor: Conveyor;
  /** 拨入连接的归寂面：resolve 表示该连接已终结 */
  readonly close: Promise<void>;
}

/** 拨入函数形态（缺省 = 真 ws 拨号；测试注入 fake 观测退避序列）。 */
export type Dial = (url: string, headers: Record<string, string>) => Promise<DialResult>;

/** 一次拨号尝试的内部结果（永不 reject——失败的细节进 `failed.error`）。 */
type AttemptOutcome =
  | { kind: "established"; conveyor: Conveyor; close: Promise<void> }
  | { kind: "failed"; error: unknown };

/** 缺省日志门面：装配层不传 logger 时静默（RelayClient 可脱离日志系统独立使用）。 */
const SILENT_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** 把任意抛出物收敛为可读消息（自身绝不抛出；与仓内同 idiom）。 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 真 ws 拨号：拨入 header 携带 server-token，open 落定即产 Conveyor（此刻 socket 必已 open——
 * `createClientSideConveyor` 的前提）。open 前的 error 即拨入失败（relay 401 拒升级、
 * ECONNREFUSED 等）；open 后的 error/close 由 Conveyor 契约收口，只余归寂面。
 *
 * @param url - relay 的 server 拨入路由完整地址
 * @param headers - 拨入请求头（含 `x-aimi-server-token`）
 * @returns Promise，resolve 为拨入产物
 * @throws open 前底层错误（升级被拒/连接失败）时 reject
 */
function wsDial(url: string, headers: Record<string, string>): Promise<DialResult> {
  return new Promise<DialResult>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => {
      const close = new Promise<void>((res) => socket.once("close", () => res()));
      resolve({ conveyor: createClientSideConveyor(socket, REMOTE_LABEL), close });
    });
    socket.once("error", (err) => reject(err));
  });
}

/**
 * server→relay 出站拨入：拨入 header 携带 server-token（relay 侧校验——S2 对接点），
 * 建链后同帧协议透传：该连接上来自 relay 的客户端帧直接进 Application 入站编排。
 *
 * 断线/拨入失败一律**无限重拨**（指数退避 1s 起 ×2^n、封顶 60s、±20% 抖动；成功 dial 即归零
 * 计数），直至 `close()` 介入。生命周期按**代际**收口：`close()` 递增代际使在途拨号的产物
 * 失效——close 后才落定的 dial 不得再进 `onConnection`，其拨到的连接就地关闭（不外漏半开
 * socket），此收口被 `close()` 的 Promise 覆盖（resolve 时清理已完成）。
 */
export class RelayClient {
  readonly #url: string;
  readonly #serverToken: string;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #dial: Dial;

  #onConnection: ((conveyor: Conveyor, remote: string) => void) | null = null;
  /** 生命周期闸：false = 未 start 或 close() 已介入——拨号循环每步前复核。 */
  #running = false;
  /** 生命周期代际：close() 递增，使在途 dial 的产物失效（close 后落定的 dial 不得再 onConnection）。 */
  #generation = 0;
  /** 连续失败计数（含连接终结）：成功 dial 归零；重拨延迟 = min(基数×2^(n-1), 封顶)±抖动。 */
  #attempts = 0;
  /** 当前已建立的 relay 连接（close() 负责收口；正常终结后清空）。 */
  #current: Conveyor | null = null;
  /** 退避计时的唤醒柄：close() 用它取消退避等待（循环唤醒后代际复核退出，不悬挂 promise）。 */
  #wakeup: (() => void) | null = null;
  /** 在途拨号尝试（含竞态清理）的收口面：close() 等它，确保 resolve 时清理已完成。 */
  #inflight: Promise<AttemptOutcome> | null = null;
  #closing: Promise<void> | null = null;

  /**
   * @param deps.url - relay 的 server 拨入路由完整地址
   * @param deps.serverToken - 拨入凭证明文（进 header，relay 侧校验）
   * @param deps.logger - 日志门面；缺省静默
   * @param deps.now - 时间源注入（连接存活时长日志用）；缺省 `Date.now`
   * @param deps.random - 随机源注入（抖动）；缺省 `Math.random`
   * @param deps.dial - 拨入函数注入（退避测试用）；缺省真 ws 拨号
   */
  constructor(deps: {
    url: string;
    serverToken: string;
    logger?: Logger;
    now?: () => number;
    random?: () => number;
    dial?: Dial;
  }) {
    this.#url = deps.url;
    this.#serverToken = deps.serverToken;
    this.#log = deps.logger ?? SILENT_LOGGER;
    this.#now = deps.now ?? Date.now;
    this.#random = deps.random ?? Math.random;
    this.#dial = deps.dial ?? wsDial;
  }

  /**
   * 开始拨入循环：首拨立即发起，成功即回调 `onConnection`；失败按退避无限重拨直至 `close()`。
   *
   * @param onConnection - 每次成功拨入时回调（`remote` 恒为 `"relay"`）；单槽语义
   * @throws 重复调用（`relay client already started`）；或 close 后调用（`relay client already closed`）
   */
  start(onConnection: (conveyor: Conveyor, remote: string) => void): void {
    if (this.#running) throw new Error("relay client already started");
    if (this.#closing !== null) throw new Error("relay client already closed");
    this.#onConnection = onConnection;
    this.#running = true;
    void this.#run();
  }

  /**
   * 收口：取消退避计时、关闭既有连接、等在途拨号收口（其产物按代际失效）。
   * 幂等：重复调用返回同一 Promise。close 后落定的 dial 不再 `onConnection`（代际闸）。
   *
   * @returns Promise，resolve 表示重拨循环已停、无残留连接
   */
  close(): Promise<void> {
    this.#closing ??= this.#doClose();
    return this.#closing;
  }

  async #doClose(): Promise<void> {
    this.#generation += 1;
    this.#running = false;
    this.#wakeup?.(); // 取消退避计时：循环唤醒后按代际退出，不再重拨
    this.#wakeup = null;
    const current = this.#current;
    this.#current = null;
    if (current !== null) await current.close(RELAY_CLOSED_REASON).catch(() => {});
    const inflight = this.#inflight;
    if (inflight !== null) await inflight.catch(() => {}); // 在途尝试含竞态清理，等它收口
  }

  /**
   * 拨号主循环（start 起常驻，close 后退出）：拨入失败/连接终结都按计数退避后重拨；
   * 每一步前后复核代际——close 介入即退出，不做任何后续动作。
   */
  async #run(): Promise<void> {
    for (;;) {
      if (!this.#running) return;
      const gen = this.#generation;
      const attempt = this.#attempt(gen);
      this.#inflight = attempt;
      const outcome = await attempt;
      this.#inflight = null;
      if (this.#generation !== gen) return; // close 介入：在途产物已由 #attempt 就地收口
      if (outcome.kind === "established") {
        this.#attempts = 0; // 成功 dial 归零：连接终结后重拨从基数起算
        this.#current = outcome.conveyor;
        const openedAt = this.#now();
        this.#log.info("relay dial established", { url: this.#url });
        this.#onConnection?.(outcome.conveyor, REMOTE_LABEL);
        await outcome.close; // 等该连接终结（close() 收口它时此面随之落定）
        if (this.#generation !== gen) return;
        this.#current = null;
        this.#attempts += 1;
        this.#log.warn("relay connection lost, redialing", { url: this.#url, uptimeMs: this.#now() - openedAt });
      } else {
        this.#attempts += 1;
        this.#log.warn("relay dial failed, retrying", {
          url: this.#url,
          attempt: this.#attempts,
          error: errorMessage(outcome.error),
        });
      }
      if (this.#generation !== gen) return;
      await this.#waitBackoff();
    }
  }

  /**
   * 一次拨号尝试（永不 reject）：成功按代际复核——失配即就地关闭产物（close 竞态收口，
   * close() 的等待面覆盖此清理）；失败原样返回。此后调用方以代际复核决定去留。
   *
   * @param gen - 发起本次尝试时的代际
   * @returns 尝试结果（established 携产物 / failed 携错误）
   */
  async #attempt(gen: number): Promise<AttemptOutcome> {
    try {
      const result = await this.#dial(this.#url, { [SERVER_TOKEN_HEADER]: this.#serverToken });
      if (this.#generation !== gen) {
        // close 竞态：拨入成功但生命周期已终结——该连接不得进编排，就地关闭后再返回。
        await result.conveyor.close(RELAY_CLOSED_REASON).catch(() => {});
        return { kind: "failed", error: new Error("relay client closed during dial") };
      }
      return { kind: "established", conveyor: result.conveyor, close: result.close };
    } catch (err) {
      return { kind: "failed", error: err };
    }
  }

  /**
   * 退避等待：延迟 = min(基数×2^(n-1), 封顶)±20% 抖动。可被 close() 经 `#wakeup` 提前取消
   * （唤醒后循环顶的代际复核即退出——不悬挂 promise、不在 close 后重拨）。
   */
  async #waitBackoff(): Promise<void> {
    const nominal = Math.min(DIAL_RETRY_BASE_MS * 2 ** (this.#attempts - 1), DIAL_RETRY_MAX_MS);
    const delay = Math.round(nominal * (1 - JITTER_HALF + 2 * JITTER_HALF * this.#random()));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#wakeup = null;
        resolve();
      }, delay);
      this.#wakeup = () => {
        this.#wakeup = null;
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
