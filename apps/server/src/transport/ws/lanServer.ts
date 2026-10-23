import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { Conveyor } from "../conveyor.js";
import { createServerSideConveyor } from "./messagePipe.js";

/** 服务端主动关闭所有通道时使用的统一原因。 */
const SHUTDOWN_REASON = "server shutting down";

/** HTTP 请求回调：由编排层注入业务处理（如 APK 下载端点）；传输层不解析任何业务。 */
export type HttpRequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * LAN WebSocket 入站监听器（传输层的唯一监听端）。
 * 每个入站 socket 包一个独立的 `Conveyor` 交给 `onConnection` 回调；
 * 本类不 parse 任何帧，也不懂业务——只负责接纳连接与生命周期收口。
 *
 * 同一监听端口上可注册 `onRequest` 处理普通 HTTP 请求（非 WS 升级请求；
 * 升级请求由 WSS 消化不会进入 request 回调），用于附加小体积 HTTP 端点。
 * TLS 与明文两种模式都经底层 http(s) server 挂载 WSS，行为一致。
 */
export class LanWsServer {
  readonly #wss: WebSocketServer;
  /** 底层 HTTP(S) server：两种模式统一挂载点（WSS 与 request 回调共用）。 */
  readonly #base: HttpServer | HttpsServer;
  readonly #port: number;
  readonly #host: string;
  /** 单槽：重复注册会覆盖前一次回调，只保留最后注册者（当前只有一个消费者） */
  #connCb: ((conveyor: Conveyor, remote: string) => void) | null = null;
  /** HTTP 请求单槽回调；未注册时一律回 404。 */
  #reqCb: HttpRequestHandler | null = null;
  /** 活跃连接表：仅在 `connection` 时加入，socket 真正 close 时移除。 */
  readonly #active = new Set<Conveyor>();
  /** 幂等闸门：`close()` 重复调用返回同一 Promise */
  #closing: Promise<void> | null = null;

  /**
   * @param opts.port - 监听端口；`0` 表示由 OS 随机分配（测试用）。绑定 `0.0.0.0`（LAN 可见）
   */
  constructor(opts: { port: number; host?: string; tls?: { certFile: string; keyFile: string }; maxPayload?: number }) {
    const host = opts.host ?? "127.0.0.1";
    this.#port = opts.port;
    this.#host = host;
    const maxPayload = opts.maxPayload ?? 8 * 1024 * 1024;
    if (opts.tls !== undefined) {
      // TLS：构造不监听，`listen()` 时才 `listen(port, host)`（保持既有时序）。
      this.#base = createHttpsServer({ cert: readFileSync(opts.tls.certFile), key: readFileSync(opts.tls.keyFile) });
    } else {
      // 明文：构造即监听（对齐既有 `WebSocketServer({port,host})` 构造即 listen 的行为）。
      this.#base = createHttpServer();
      this.#base.listen(opts.port, host);
    }
    this.#base.on("request", (req, res) => {
      if (this.#reqCb === null) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      this.#reqCb(req, res);
    });
    this.#wss = new WebSocketServer({ server: this.#base, maxPayload });
    this.#wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
      const remote = remoteOf(req);
      const conveyor = createServerSideConveyor(socket, remote);
      // 用底层 socket 的 close 事件维护连接表：与 Conveyor 单槽 onClose 互不干扰。
      this.#active.add(conveyor);
      socket.once("close", () => this.#active.delete(conveyor));
      this.#connCb?.(conveyor, remote);
    });
  }

  /**
   * 注册入站连接回调（`remote` = "ip:port"）。
   * 可在 `listen()` 之前调用；单槽覆盖语义：重复注册会覆盖前一次回调。
   *
   * @param cb - 每接纳一条连接时调用的回调
   */
  onConnection(cb: (conveyor: Conveyor, remote: string) => void): void {
    this.#connCb = cb;
  }

  /**
   * 注册普通 HTTP 请求回调（单槽覆盖语义，对齐 `onConnection`）。
   * 只会收到非 WS 升级请求；未注册时一律 404。可在 `listen()` 之前调用。
   *
   * @param cb - 每个到达的 HTTP 请求的处理器（必须自行结束响应）
   */
  onRequest(cb: HttpRequestHandler): void {
    this.#reqCb = cb;
  }

  /**
   * 等待监听就绪并返回实际端口（`port: 0` 时由 OS 分配）。
   * TLS 模式在此发起 `listen(port, host)`；明文模式构造时已监听，此处只等就绪。
   *
   * @returns Promise，resolve 为实际监听端口
   * @throws 监听失败（如端口被占用）时抛出底层错误
   */
  async listen(): Promise<number> {
    if (this.#base.listening === false) {
      await new Promise<void>((resolve, reject) => {
        const onListening = (): void => { cleanup(); resolve(); };
        const onError = (err: Error): void => { cleanup(); reject(err); };
        const cleanup = (): void => {
          this.#base.off("listening", onListening);
          this.#base.off("error", onError);
        };
        this.#base.once("listening", onListening);
        this.#base.once("error", onError);
        this.#base.listen(this.#port, this.#host);
      });
    }
    await new Promise<void>((resolve, reject) => {
      // WSS 挂载模式把底层 server 的 listening/error 转发为自身同名事件；
      // 构造即监听的明文模式可能在注册前已触发，故先以 address() 判定。
      if (this.#wss.address() !== null) {
        resolve();
        return;
      }
      const onListening = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const cleanup = (): void => {
        this.#wss.off("listening", onListening);
        this.#wss.off("error", onError);
      };
      this.#wss.once("listening", onListening);
      this.#wss.once("error", onError);
    });
    const addr = this.#wss.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("LanWsServer: 监听已就绪但未取得 TCP 地址");
    }
    return addr.port;
  }

  /**
   * 关闭监听并断开全部活跃连接（各自 `close("server shutting down")`），随后收口 `ws` 服务端。
   * 幂等：重复调用返回同一 Promise，不再触碰底层。
   *
   * @returns Promise，resolve 表示监听与全部活跃连接均已收口
   */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    await Promise.all([...this.#active].map((c) => c.close(SHUTDOWN_REASON)));
    await new Promise<void>((resolve, reject) => {
      this.#wss.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => this.#base.close((err) => (err ? reject(err) : resolve())));
  }
}

/** `net.Socket` 的 remote 可能缺省，统一降级为 "unknown:0"。 */
function remoteOf(req: IncomingMessage): string {
  return `${req.socket.remoteAddress ?? "unknown"}:${req.socket.remotePort ?? 0}`;
}
