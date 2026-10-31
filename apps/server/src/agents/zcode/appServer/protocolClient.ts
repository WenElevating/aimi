import { NdjsonTransport } from "./ndjsonTransport.js";

/**
 * ZCode Protocol 客户端：请求/通知/反向请求三路分派（JSON-RPC 风格但无 `jsonrpc` 字段）。
 *
 * 线格式（官方 `docs/zcode-protocol.md` + `packages/shared/src/zcode-protocol/index.ts`）：
 * - 我方请求 `{id, method, params}` → 对端 `{id, result}` 或 `{id, error:{code,message,data}}`；
 * - 我方应答反向请求 `{id, result}`（id 形如 `server-N`）；
 * - 对端通知 `{method, params}`（`startup/storageState`、`session/lifecycle/changed`、
 *   `session/event`、`state.updated` 等）与反向请求（`interaction/*`、`session/requestRuntimePreferences`）。
 *
 * 防御式解析：帧不是对象/缺 method/result 的合法 JSON 静默丢弃；反向请求无注册处理器时
 * 回 `{}`（探针实证：官方宿主对 MCP auth 头等反向请求的应答即为空对象）。
 */
export interface ProtocolClientHandlers {
  /** 对端通知（含 session/event / state.updated / lifecycle 等） */
  onNotification: (method: string, params: unknown) => void;
  /** 反向请求：返回应答 result（同步；异步场景在处理器内部先登记后应答） */
  onServerRequest: (method: string, params: unknown) => unknown;
  onClose: (reason: string) => void;
}

/** 请求超时缺省 15s（session/create 含 MCP 拉起实测秒级；stop/控制类远小于此）。 */
const REQUEST_TIMEOUT_MS = 15_000;

export class ProtocolClient {
  readonly #transport: NdjsonTransport;
  readonly #handlers: ProtocolClientHandlers;
  #nextId = 1;
  readonly #pending = new Map<
    number | string,
    { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  #closed = false;

  private constructor(transport: NdjsonTransport, handlers: ProtocolClientHandlers) {
    this.#transport = transport;
    this.#handlers = handlers;
  }

  static connect(file: string, args: readonly string[], handlers: ProtocolClientHandlers): ProtocolClient {
    const client = new ProtocolClient(
      NdjsonTransport.spawn(file, args, {
        onMessage: (message) => client.#onMessage(message),
        onClose: (reason) => client.#onClosed(reason),
        onStderr: undefined,
      }),
      handlers,
    );
    return client;
  }

  /** 发请求并等 result；error 帧拒绝为 `Error(zcode <code>: <message>)`；超时拒绝。 */
  request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("zcode app-server 连接已关闭"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`zcode 请求超时: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#transport.send({ id, method, params });
    });
  }

  /** 发通知（无 id、无应答）。 */
  notify(method: string, params: unknown): void {
    this.#transport.send({ method, params });
  }

  /** 应答反向请求。 */
  respond(requestId: number | string, result: unknown): void {
    this.#transport.send({ id: requestId, result });
  }

  /** 优雅关闭（stdin EOF → 对端排水退出）；随后 kill 由调用方在 onClose 后兜底。 */
  close(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("zcode app-server 连接已关闭"));
    }
    this.#pending.clear();
    this.#transport.close();
  }

  kill(): void {
    this.#closed = true;
    this.#transport.kill();
  }

  get pid(): number | undefined {
    return this.#transport.pid;
  }

  #onMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const frame = message as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    // 反向请求：id 为 server 前缀字符串且带 method。
    if (typeof frame.id === "string" && typeof frame.method === "string") {
      let result: unknown = {};
      try {
        result = this.#handlers.onServerRequest(frame.method, frame.params);
      } catch {
        result = {};
      }
      this.#transport.send({ id: frame.id, result });
      return;
    }
    // 请求应答：id 为我方数字计数。
    if (typeof frame.id === "number" && (frame.result !== undefined || frame.error !== undefined)) {
      const pending = this.#pending.get(frame.id);
      if (pending === undefined) return;
      this.#pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error !== undefined && typeof frame.error === "object" && frame.error !== null) {
        const err = frame.error as { code?: unknown; message?: unknown };
        pending.reject(new Error(`zcode ${String(err.code)}: ${String(err.message ?? "unknown error")}`));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    // 通知。
    if (typeof frame.method === "string") {
      this.#handlers.onNotification(frame.method, frame.params);
      return;
    }
    // 其余形状（裸 id 无 result 等）：防御式静默。
  }

  #onClosed(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("zcode app-server 连接已关闭: " + reason));
    }
    this.#pending.clear();
    this.#handlers.onClose(reason);
  }
}
