import type { ServerFrame } from "@aimi/protocol";
import { WebSocket } from "ws";
import type { Conveyor, ConveyorState } from "../conveyor.js";

/** WS close 帧 reason 的字节上限（RFC 6455 §5.5）；超出需本地截断，否则 `ws` 会抛 RangeError。 */
const MAX_CLOSE_REASON_BYTES = 123;

/**
 * 把 reason 截断到 WS 规范上限（123 字节），并避免切裂 UTF-8 多字节序列。
 * @param reason 原始关闭原因（可为任意长度的中文字符串）。
 * @returns 不超过 123 字节、且为合法 UTF-8 的关闭原因。
 */
function truncateCloseReason(reason: string): string {
  const buf = Buffer.from(reason, "utf8");
  if (buf.length <= MAX_CLOSE_REASON_BYTES) return reason;
  let end = MAX_CLOSE_REASON_BYTES;
  // buf[end] 是首个被排除的字节；若它是续字节（10xxxxxx），说明切在了多字节序列中间，向前回退。
  while (end > 0 && ((buf[end] as number) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * JSON 文本帧 → 解码值；非 JSON 原文原样返回字符串。
 * 本层只做「JSON 文本帧」这一链路语法解码，不做帧结构/type 白名单校验（那是上层 parse 的职责）。
 */
function decodeTextFrame(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * LAN 入站 socket 的 Conveyor 实现（每 socket 一实例）。
 * 服务端入站连接在 `connection` 事件时底层已 open，故初始 `state = "open"`。
 */
class ServerSideConveyor implements Conveyor {
  #state: ConveyorState;
  /** 单槽：重复注册覆盖（见 `Conveyor.onFrame`）。 */
  #frameCb: ((raw: unknown) => void) | null = null;
  /** 单槽：重复注册覆盖（见 `Conveyor.onClose`）。 */
  #closeCb: ((reason: string) => void) | null = null;
  /** 本地 `close(reason)` 传入的原因；对端 close 帧未带 reason 时用它回填。 */
  #localReason: string | undefined;
  /** 闭合终结的幂等闸门：close/error 事件只允许首批一次收口。 */
  #settled = false;
  #closedResolve!: () => void;
  readonly #closed: Promise<void>;

  constructor(
    private readonly socket: WebSocket,
    /** 远端地址（"ip:port"）；本层契约暂不外露，由 `LanWsServer.onConnection` 交给调用方。 */
    readonly remote: string,
  ) {
    this.#state = socket.readyState === WebSocket.OPEN ? "open" : "closed";
    this.#closed = new Promise<void>((resolve) => {
      this.#closedResolve = resolve;
    });

    socket.on("message", (data) => {
      // 只做文本帧的 JSON 语法解码；帧结构/白名单校验是上层职责（本层不懂业务）。
      this.#frameCb?.(decodeTextFrame(String(data)));
    });
    socket.on("close", (code, reasonBuf) => {
      this.#settle(reasonBuf.toString() || this.#localReason || `code ${code}`);
    });
    socket.on("error", (err) => {
      // 传输层错误视为通道终结，reason 优先暴露底层错误信息。
      this.#settle("socket error: " + err.message);
    });
  }

  /** 一次性收口：落终态、放行 `close()` 等待者、回调 close 订阅者（至多一次）。 */
  #settle(reason: string): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#state = "closed";
    this.#closedResolve();
    this.#closeCb?.(reason);
  }

  /** 入站 socket 天然 open：直接 resolve（幂等）。 */
  async open(): Promise<void> {}

  /**
   * 序列化为单条 JSON 文本帧发送。
   * 静默丢弃语义：`state !== 'open'` 或底层 socket 未就绪时静默丢弃（就绪判据以底层 socket
   * readyState 为准，是 state 的超集——闭合竞态窗口内宁可多丢）。
   */
  send(frame: ServerFrame): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(frame));
  }

  /** 单槽覆盖：仅保留最后一次注册的 raw 帧回调。 */
  onFrame(cb: (raw: unknown) => void): void {
    this.#frameCb = cb;
  }

  /** 单槽覆盖：仅保留最后一次注册的关闭回调。 */
  onClose(cb: (reason: string) => void): void {
    this.#closeCb = cb;
  }

  /** 幂等关闭：已 closed 直接 resolve；否则发 close 帧并等待 close 事件落定。 */
  async close(reason?: string): Promise<void> {
    if (this.#state === "closed") return;
    this.#localReason = reason;
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close(1000, reason === undefined ? undefined : truncateCloseReason(reason));
    }
    await this.#closed;
  }

  get state(): ConveyorState {
    return this.#state;
  }
}

/**
 * LAN WS 的 Conveyor 工厂：把一个已建立的入站 `ws` socket 包成 `Conveyor`。
 * @param socket `ws` 服务端侧 socket（`connection` 事件带来，天然 open）。
 * @param remote 远端地址（"ip:port"），用于诊断与后续装配层展示。
 * @returns 该 socket 独占的 Conveyor（每 socket 一实例，单槽回调语义）。
 */
export function createServerSideConveyor(socket: WebSocket, remote: string): Conveyor {
  return new ServerSideConveyor(socket, remote);
}
