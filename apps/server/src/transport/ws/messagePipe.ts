import { MetricRecorder, type MetricsProvider } from "../../observability/metrics.js";
import type { ServerFrame } from "@aimi/protocol";
import { WebSocket } from "ws";
import type { Conveyor, ConveyorState } from "../conveyor.js";

/** WS close 帧 reason 的字节上限为 123 字节（RFC 6455 规定）；超出需本地截断，否则 `ws` 会抛 RangeError。 */
const MAX_CLOSE_REASON_BYTES = 123;
const MAX_OUTBOUND_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * 把 reason 截断到 WS 规范上限（123 字节），并避免切裂 UTF-8 多字节序列。
 *
 * @param reason - 原始关闭原因（可为任意长度的中文字符串）
 * @returns 不超过 123 字节、且为合法 UTF-8 的关闭原因
 */
function truncateCloseReason(reason: string): string {
  const buf = Buffer.from(reason, "utf8");
  if (buf.length <= MAX_CLOSE_REASON_BYTES) return reason;
  let end = MAX_CLOSE_REASON_BYTES;
  // buf[end] 是首个被排除的字节；若它是续字节（10xxxxxx），说明切在了多字节序列中间，向前回退。
  // eslint-disable-next-line security/detect-object-injection -- end is a bounded byte index.
  while (end > 0 && ((buf[end] as number) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * 把 JSON 文本帧解码为值；非 JSON 原文原样返回字符串。
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
 * WS socket 的共用 Conveyor 实现（每 socket 一实例）。
 * 服务端入站与客户端拨入（Task 9）两侧**同构共用**本类：协议透传下 relay 链路的语义必须与 LAN
 * 完全等价——state 语义、JSON 文本帧解码（非 JSON 原样交付）、close 原因截断均不分支。
 * 前提：构造时底层 socket 已建立（服务端 `connection` 事件与客户端 dial 的 open 落定都满足），
 * 故初始 `state = "open"`；`open()` 恒为幂等 no-op。
 */
class WsConveyor implements Conveyor {
  readonly #metrics = new MetricRecorder({ sourceId: "server.websocket", component: "server" });
  #state: ConveyorState;
  /** 单槽：重复注册会覆盖前一次回调，只保留最后注册者 */
  #frameCb: ((raw: unknown) => void) | null = null;
  /** 单槽：重复注册会覆盖前一次回调，只保留最后注册者 */
  #closeCb: ((reason: string) => void) | null = null;
  /** 本地 `close(reason)` 传入的原因；对端 close 帧未带 reason 时用它回填 */
  #localReason: string | undefined;
  /** 闭合终结的幂等闸门：close/error 事件只允许首批一次收口 */
  #settled = false;
  #closedResolve!: () => void;
  readonly #closed: Promise<void>;

  /**
   * 包装一个已建立的 socket（服务端入站或客户端拨入侧皆可——两侧口径一致）。
   *
   * @param socket - 底层 `ws` socket（构造时必已 open）
   * @param remote - 远端标签（LAN 为 "ip:port"，relay 链路为 "relay"），供诊断与装配层展示
   */
  constructor(
    private readonly socket: WebSocket,
    readonly remote: string,
  ) {
    const definitions = [
      [
        "server.transport.submit.ms",
        "histogram",
        "ms",
        "序列化与 socket.send 提交耗时",
        "send entry to socket.send return, not network delivery",
      ],
      [
        "server.transport.buffer.bytes",
        "gauge",
        "bytes",
        "提交时 WebSocket 待发送字节",
        "socket.bufferedAmount before send",
      ],
      ["server.transport.sent.bytes", "counter", "bytes", "向 WebSocket 提交的字节", "socket.send accepted"],
      ["server.transport.dropped", "counter", "count", "关闭或慢消费者丢弃帧", "send rejected before socket.send"],
    ] as const;
    for (const [name, kind, unit, description, boundary] of definitions) {
      this.#metrics.define({ name, kind, unit, description, boundary, availability: "available" });
    }
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

  /**
   * 一次性收口：落终态、放行 `close()` 等待者、回调 close 订阅者（至多一次）。
   *
   * @param reason - 通道终结的原因
   */
  #settle(reason: string): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#state = "closed";
    this.#metrics.close();
    this.#closedResolve();
    this.#closeCb?.(reason);
  }

  /** 入站 socket 天然 open：直接 resolve（幂等）。 */
  async open(): Promise<void> {}

  /**
   * 序列化为单条 JSON 文本帧发送。
   * 静默丢弃语义：`state !== 'open'` 或底层 socket 未就绪时静默丢弃（就绪判据以底层 socket
   * readyState 为准，是 state 的超集——闭合竞态窗口内宁可多丢）。
   *
   * @param frame - 要发送的服务端帧
   */
  send(frame: ServerFrame): void {
    const context = frame.type === "session.event" ? { sessionId: frame.sessionId, seq: frame.seq } : {};
    if (this.socket.readyState !== WebSocket.OPEN) {
      this.#metrics.record("server.transport.dropped", 1, context);
      return;
    }
    const invokedAt = performance.now();
    const payload = JSON.stringify(frame);
    const bytes = Buffer.byteLength(payload);
    this.#metrics.record("server.transport.buffer.bytes", this.socket.bufferedAmount, context);
    if (this.socket.bufferedAmount + bytes > MAX_OUTBOUND_BUFFER_BYTES) {
      this.#metrics.record("server.transport.dropped", 1, context);
      void this.close("slow consumer");
      return;
    }
    this.socket.send(payload);
    this.#metrics.record("server.transport.sent.bytes", bytes, context);
    this.#metrics.record("server.transport.submit.ms", performance.now() - invokedAt, context);
  }

  /** 仅返回当前连接的本地传输指标，不读取对端或触发网络请求。 */
  metrics(): MetricsProvider {
    return this.#metrics;
  }

  /** 单槽覆盖：仅保留最后一次注册的 raw 帧回调。 */
  onFrame(cb: (raw: unknown) => void): void {
    this.#frameCb = cb;
  }

  /** 单槽覆盖：仅保留最后一次注册的关闭回调。 */
  onClose(cb: (reason: string) => void): void {
    this.#closeCb = cb;
  }

  /**
   * 幂等关闭：已 closed 直接 resolve；否则发 close 帧并等待 close 事件落定。
   *
   * @param reason - 关闭原因；超 123 字节时截断后发送
   * @returns Promise，resolve 表示底层已确认关闭
   */
  async close(reason?: string): Promise<void> {
    if (this.#state === "closed") return;
    this.#localReason = reason;
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
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
 *
 * @param socket - `ws` 服务端侧 socket（`connection` 事件带来，天然 open）
 * @param remote - 远端地址（"ip:port"），用于诊断与后续装配层展示
 * @returns 该 socket 独占的 Conveyor（每 socket 一实例，单槽回调语义）
 */
export function createServerSideConveyor(socket: WebSocket, remote: string): Conveyor {
  return new WsConveyor(socket, remote);
}

/**
 * 客户端侧 Conveyor 工厂（server→relay 拨入链路用）：把一个**已建立**的出站 socket 包成 `Conveyor`。
 * 与 `createServerSideConveyor` 共用同一收发核（`WsConveyor`）——协议透传零语义分叉。
 *
 * @param socket - 客户端侧 socket（dial 的 open 事件落定后传入——前提已 open，初值即 `open`）
 * @param remote - 远端标签（拨入链路恒为 "relay"），用于诊断与装配层展示
 * @returns 该 socket 独占的 Conveyor（每 socket 一实例，单槽回调语义）
 */
export function createClientSideConveyor(socket: WebSocket, remote: string): Conveyor {
  return new WsConveyor(socket, remote);
}
