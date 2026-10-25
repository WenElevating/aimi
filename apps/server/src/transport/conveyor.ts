import type { MetricsProvider } from "../observability/metrics.js";
import type { ServerFrame } from "@aimi/protocol";

/**
 * 通道生命周期状态。
 * - `opening`：正在建立底层通道（客户端实现会经历；LAN 服务端入站 socket 天然已 open）；
 * - `open`：可收发；仅此时 `send` 才会真正落到链路；
 * - `closed`：终态，闭合后不可再打开（同一 Conveyor 实例一次性）。
 */
export type ConveyorState = "opening" | "open" | "closed";

/**
 * 全系统唯一的传输抽象——业务层只依赖本接口，不关心 ws/TCP 细节。
 * 心跳、重连、帧重放、会话恢复属协议层，均不在此层。
 * 本层不懂业务：`onFrame` 只做「JSON 文本帧」的链路语法解码，帧结构/白名单校验由上层完成。
 */
export interface Conveyor {
  /** 真实传输暴露本地提交与缓冲指标；外部兼容通道可不具备此能力。 */
  metrics?(): MetricsProvider;
  /**
   * 打开通道（两侧实现都在建链落定后才创建——服务端 `connection` 事件、客户端 dial 的 open
   * 落定——故均为幂等 no-op，不重复建链）。
   *
   * @returns Promise，resolve 表示通道已就绪；已就绪时立即 resolve
   */
  open(): Promise<void>;
  /**
   * 发送一帧 `server` 帧。即发即忘（交由内核缓冲），序列化为单条 WS 消息（JSON 文本）。
   * 静默丢弃语义：`state !== 'open'` 或底层 socket 未就绪时静默丢弃（就绪判据以底层 socket
   * readyState 为准，是 state 的超集——闭合竞态窗口内宁可多丢）；丢弃时不做任何事也不抛——
   * 调用方无需自行判断状态，也不需要 try/catch。
   *
   * @param frame - 要发送的服务端帧
   */
  send(frame: ServerFrame): void;
  /**
   * 注册原始帧回调。`raw` 为 `unknown`：JSON 文本帧已做 JSON 解码（对象/原始值），
   * 非 JSON 原文则原样以字符串交付。**不做帧结构/type 校验——那是上层职责，本层不懂业务。**
   * 单槽覆盖语义：重复注册会覆盖前一次回调，只保留最后一个（单一消费者）。
   *
   * @param cb - 收到一条入站帧时调用的回调
   */
  onFrame(cb: (raw: unknown) => void): void;
  /**
   * 注册关闭回调，`reason` 来自对端 close 帧，或本地 `close(reason)` 传入的原因。
   * 单槽覆盖语义：重复注册会覆盖前一次回调；每条通道至多触发一次。
   *
   * @param cb - 通道关闭时调用的回调
   */
  onClose(cb: (reason: string) => void): void;
  /**
   * 主动关闭（发 close 帧并清理）。幂等：已 closed 直接 resolve。
   *
   * @param reason - 关闭原因；缺省时以对端 close 帧带来的原因回填
   * @returns Promise，resolve 表示通道已关闭；已关闭时立即 resolve
   */
  close(reason?: string): Promise<void>;
  /** 当前状态；`send` 的丢弃判据与消费者分支判断均以此为准 */
  readonly state: ConveyorState;
}
