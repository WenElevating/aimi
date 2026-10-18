import { createServer, type Server as HttpServer } from "node:https";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Conveyor } from "../conveyor.js";
import { createServerSideConveyor } from "./messagePipe.js";

/** 服务端主动关闭所有通道时使用的统一原因。 */
const SHUTDOWN_REASON = "server shutting down";

/**
 * LAN WebSocket 入站监听器（传输层的唯一监听端）。
 * 每个入站 socket 包一个独立的 `Conveyor` 交给 `onConnection` 回调；
 * 本类不 parse 任何帧，也不懂业务——只负责接纳连接与生命周期收口。
 */
export class LanWsServer {
  readonly #wss: WebSocketServer;
  readonly #https: HttpServer | null;
  readonly #port: number;
  readonly #host: string;
  /** 单槽：重复注册会覆盖前一次回调，只保留最后注册者（当前只有一个消费者） */
  #connCb: ((conveyor: Conveyor, remote: string) => void) | null = null;
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
      this.#https = createServer({ cert: readFileSync(opts.tls.certFile), key: readFileSync(opts.tls.keyFile) });
      this.#wss = new WebSocketServer({ server: this.#https, maxPayload });
    } else {
      this.#https = null;
      this.#wss = new WebSocketServer({ port: opts.port, host, maxPayload });
    }
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
   * 等待监听就绪并返回实际端口（`port: 0` 时由 OS 分配）。
   * `ws` 在构造时已发起 listen，故此处兼容「尚未 listening」与「已 listening」两种时序。
   *
   * @returns Promise，resolve 为实际监听端口
   * @throws 监听失败（如端口被占用）时抛出底层错误
   */
  async listen(): Promise<number> {
    if (this.#https !== null && this.#https.listening === false) {
      await new Promise<void>((resolve, reject) => {
        const onListening = (): void => { cleanup(); resolve(); };
        const onError = (err: Error): void => { cleanup(); reject(err); };
        const cleanup = (): void => {
          this.#https!.off("listening", onListening);
          this.#https!.off("error", onError);
        };
        this.#https!.once("listening", onListening);
        this.#https!.once("error", onError);
        this.#https!.listen(this.#port, this.#host);
      });
    }
    await new Promise<void>((resolve, reject) => {
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
    if (this.#https !== null) {
      await new Promise<void>((resolve, reject) => this.#https!.close((err) => (err ? reject(err) : resolve())));
    }
  }
}

/** `net.Socket` 的 remote 可能缺省，统一降级为 "unknown:0"。 */
function remoteOf(req: IncomingMessage): string {
  return `${req.socket.remoteAddress ?? "unknown"}:${req.socket.remotePort ?? 0}`;
}
