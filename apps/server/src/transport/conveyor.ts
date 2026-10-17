import type { ServerFrame } from "@aimi/protocol";

/**
 * 通道生命周期状态（§A）。
 * - `opening`：正在建立底层通道（客户端实现会经历；LAN 服务端入站 socket 天然已 open）；
 * - `open`：可收发；仅此时 `send` 才会真正落到链路；
 * - `closed`：终态，闭合后不可再打开（同一 Conveyor 实例一次性）。
 */
export type ConveyorState = "opening" | "open" | "closed";

/**
 * §A：全系统唯一传输抽象——业务层（T8/T9/T11）只依赖本接口，不知 ws/TCP 细节。
 * 心跳、重连、帧重放、会话恢复属协议层，均不在此层。
 * 本层不懂业务：`onFrame` 只做「JSON 文本帧」的链路语法解码，帧结构/白名单校验由上层完成。
 */
export interface Conveyor {
  /**
   * 打开通道（服务端实现=等待底层就绪；M0 无客户端实现）。
   * 幂等：已 `open` 再调直接 resolve，不重复建链。
   */
  open(): Promise<void>;
  /**
   * 发送一帧 `server` 帧。即发即忘（交由内核缓冲），序列化为单条 WS 消息（JSON 文本）。
   * 静默丢弃语义：`state !== "open"`（含 closing/closed）时不做任何事也不抛——
   * 调用方无需自行判断状态，也不需要 try/catch。
   */
  send(frame: ServerFrame): void;
  /**
   * 注册原始帧回调。`raw` 为 `unknown`：JSON 文本帧已做 JSON 解码（对象/原始值），
   * 非 JSON 原文则原样以字符串交付。**不做帧结构/type 校验——那是上层职责，本层不懂业务。**
   * 单槽覆盖语义：重复注册会覆盖前一次回调，只保留最后一个（单一消费者）。
   */
  onFrame(cb: (raw: unknown) => void): void;
  /**
   * 注册关闭回调，`reason` 来自对端 close 帧，或本地 `close(reason)` 传入的原因。
   * 单槽覆盖语义：重复注册会覆盖前一次回调；每条通道至多触发一次。
   */
  onClose(cb: (reason: string) => void): void;
  /** 主动关闭（发 close 帧并清理）。幂等：已 closed 直接 resolve。 */
  close(reason?: string): Promise<void>;
  /** 当前状态；`send` 的丢弃判据与消费者分支判断均以此为准。 */
  readonly state: ConveyorState;
}
