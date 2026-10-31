import { ProtocolClient } from "./protocolClient.js";
import type { Logger } from "../../../logging/logger.js";
import { killTree } from "../../killTree.js";

/**
 * 单个 `zcode app-server --stdio` 进程的协议门面。
 *
 * 职责：能力协商、会话面方法封装（create/resume/subscribe/send/stop/setModel/setMode）、
 * 反向请求应答（runtimePreferences 固定 `nativeSearchEnhancementsEnabled:false`；MCP auth
 * 头等未知反向请求回空对象——探针实证形状）、按 sessionId 路由通知。
 *
 * 进程级事实（探针冻结）：连接即收 `startup/storageState` 通知（无握手首消息）；
 * `session/create` 的 result 为 `{messages, projection}`；`session/subscribe` result 为
 * `{eventSeq, events, sessionId}`；`session/send` result 为 `{accepted, sessionId, stateRevision}`；
 * 反向请求 `session/requestRuntimePreferences` 的应答**必须**含布尔
 * `nativeSearchEnhancementsEnabled`（缺失即 ZodError 拒绝、会话卡 starting）。
 */
export class ZcodeAppServer {
  readonly #client: ProtocolClient;
  readonly #logger: Logger | undefined;
  readonly #permissionHandlers = new Map<string, (request: ZcodePermissionRequest) => void>();
  readonly #lifecycleHandlers = new Map<string, (state: string, lastError: unknown) => void>();
  readonly #eventHandlers = new Map<string, (event: ZcodeSessionEventParams) => void>();

  private constructor(client: ProtocolClient, logger: Logger | undefined) {
    this.#client = client;
    this.#logger = logger;
  }

  /** spawn + 能力协商（-32601 视为旧 CLI 正常降级）。 */
  static async connect(
    file: string,
    args: readonly string[],
    deps: { logger?: Logger; requestTimeoutMs?: number } = {},
  ): Promise<ZcodeAppServer> {
    const client = ProtocolClient.connect(file, args, {
      onNotification: (method, params, frameId) => instance.#onNotification(method, params, frameId),
      onServerRequest: (method) => instance.#onServerRequest(method),
      onClose: (reason) => {
        instance.#closed = true;
        instance.#onClose?.(reason);
        deps.logger?.warn?.("zcode app-server closed", { reason });
      },
    });
    const instance = new ZcodeAppServer(client, deps.logger);
    try {
      await client.request("runtime/capabilities", { hostCapabilities: {} }, deps.requestTimeoutMs);
    } catch (error) {
      // 旧 CLI 对未知方法回 -32601：正常降级（官方宿主同款容错）；其余错误照常抛。
      if (!/-32601/.test(String(error))) {
        client.kill();
        throw error;
      }
    }
    return instance;
  }

  /** 进程关闭回调（连接意外断开时由 protocolClient 触发）；装配层据此回收池条目。 */
  #onClose: ((reason: string) => void) | undefined = undefined;

  installCloseHandler(handler: (reason: string) => void): void {
    this.#onClose = handler;
  }

  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  get pid(): number | undefined {
    return this.#client.pid;
  }

  /** 注册某会话的审批回调（反向请求按 params.sessionId 路由）。 */
  setPermissionHandler(sessionId: string, handler: ((request: ZcodePermissionRequest) => void) | undefined): void {
    if (handler === undefined) this.#permissionHandlers.delete(sessionId);
    else this.#permissionHandlers.set(sessionId, handler);
  }

  /** 注册某会话的生命周期回调（ready/unloaded 等）。 */
  setLifecycleHandler(sessionId: string, handler: ((state: string, lastError: unknown) => void) | undefined): void {
    if (handler === undefined) this.#lifecycleHandlers.delete(sessionId);
    else this.#lifecycleHandlers.set(sessionId, handler);
  }

  /** 注册某会话的事件泵回调（session/event 通知；params 与 batch 流信封同构）。 */
  setEventHandler(sessionId: string, handler: ((event: ZcodeSessionEventParams) => void) | undefined): void {
    if (handler === undefined) this.#eventHandlers.delete(sessionId);
    else this.#eventHandlers.set(sessionId, handler);
  }

  /** 新建会话；返回 sessionId 与初始投影（含 mode/contextWindow 等）。 */
  async createSession(params: {
    cwd: string;
    mode: string;
    model?: string;
    sessionId?: string;
    timeoutMs?: number;
  }): Promise<{ sessionId: string; projection: unknown }> {
    const result = (await this.#client.request(
      "session/create",
      {
        workspace: { workspacePath: params.cwd, workspaceKey: params.cwd },
        ...(params.mode !== "" ? { mode: params.mode } : {}),
        ...(params.model !== undefined ? { model: parseModelSelection(params.model) } : {}),
        ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      },
      params.timeoutMs,
    )) as { sessionId?: string; projection?: unknown };
    const sessionId =
      result?.sessionId ??
      (() => {
        throw new Error("zcode session/create 未返回 sessionId");
      })();
    return { sessionId, projection: result?.projection };
  }

  /** 恢复既有会话（重挂路径）。 */
  async resumeSession(params: { sessionId: string; timeoutMs?: number }): Promise<unknown> {
    return this.#client.request("session/resume", { sessionId: params.sessionId }, params.timeoutMs);
  }

  /** 订阅会话事件流（session/event 通知经 onNotification 路由给订阅方）。 */
  async subscribe(sessionId: string, timeoutMs?: number): Promise<void> {
    await this.#client.request("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" }, timeoutMs);
  }

  /** 发送一条输入（回合中发送由 zcode 原生 steer 队列接管）。 */
  async send(sessionId: string, content: string, timeoutMs?: number): Promise<void> {
    await this.#client.request("session/send", { sessionId, content }, timeoutMs);
  }

  /** 中断当前回合（stop 在官方旁路名单，模型请求占队时仍即时送达）。 */
  async stop(sessionId: string, timeoutMs?: number): Promise<void> {
    await this.#client.request("session/stop", { sessionId }, timeoutMs);
  }

  /** 会话级切模型（modelSelection 形如 `{provider:{providerId}, modelId}`；value 编码见 parseModelSelection）。 */
  async setModel(sessionId: string, model: string, timeoutMs?: number): Promise<void> {
    await this.#client.request("session/setModel", { sessionId, model: parseModelSelection(model) }, timeoutMs);
  }

  /** 会话级切权限档（plan/build/edit/yolo/guarded）。 */
  async setMode(sessionId: string, mode: string, timeoutMs?: number): Promise<void> {
    await this.#client.request("session/setMode", { sessionId, mode }, timeoutMs);
  }

  /** 应答审批反向请求。 */
  respondPermission(requestId: number | string, result: unknown): void {
    this.#client.respond(requestId, result);
  }

  /** 优雅关闭（stdin EOF）；进程管理负责超时后强杀。 */
  async close(killAfterMs = 1800): Promise<void> {
    this.#closed = true;
    this.#client.close();
    const pid = this.#client.pid;
    if (pid === undefined) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killTree(pid, "SIGKILL");
        resolve();
      }, killAfterMs);
      this.#onClose = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** 立即强杀。 */
  kill(): void {
    this.#closed = true;
    this.#client.kill();
  }

  #onNotification(method: string, params: unknown, frameId?: number | string): void {
    if (typeof params !== "object" || params === null) return;
    const p = params as {
      sessionId?: unknown;
      state?: unknown;
      lastError?: unknown;
      type?: unknown;
      payload?: unknown;
      toolName?: unknown;
      input?: unknown;
      options?: unknown;
    };
    if (method === "session/lifecycle/changed" && typeof p.sessionId === "string") {
      this.#lifecycleHandlers.get(p.sessionId)?.(String(p.state ?? ""), p.lastError);
      return;
    }
    if (method === "interaction/requestPermission" && typeof p.sessionId === "string") {
      // 应答 id 是反向请求帧本身的 id（server-N），不是 params.requestId（业务 id）。
      const options = Array.isArray(p.options) ? p.options : [];
      this.#permissionHandlers.get(p.sessionId)?.({
        raw: params,
        requestId: frameId ?? "",
        sessionId: p.sessionId,
        toolName: typeof p.toolName === "string" ? p.toolName : "unknown",
        input: p.input,
        options,
      });
      return;
    }
    if (method === "session/event" && typeof p.sessionId === "string" && typeof p.type === "string") {
      const payload = typeof p.payload === "object" && p.payload !== null ? p.payload : {};
      this.#eventHandlers.get(p.sessionId)?.({
        type: p.type,
        payload: payload as Record<string, unknown>,
        sessionId: p.sessionId,
      });
    }
  }

  #onServerRequest(method: string): unknown {
    // runtimePreferences：探针实证必填 nativeSearchEnhancementsEnabled（缺失即 ZodError、会话卡 starting）。
    if (method === "session/requestRuntimePreferences") return { nativeSearchEnhancementsEnabled: false };
    // MCP auth 头与未知反向请求：空对象应答（探针实证可接受）。
    return {};
  }
}

/** zcode 审批反向请求的防御式投影（字段以探针冻结样本为准）。 */
export interface ZcodePermissionRequest {
  readonly raw: unknown;
  /** 反向请求应答所需的原帧 id（`server-N`） */
  readonly requestId: number | string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly input: unknown;
  /** 可选审批项（optionId/name + response.decision；approve 应答从中选取） */
  readonly options: readonly unknown[];
}

/** 会话事件通知的防御式投影（params 与 batch 流信封同构）。 */
export interface ZcodeSessionEventParams {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly sessionId: string;
}

/** `providerId:modelId` 编码解析为 zcode ModelSelection；非法串返回 undefined。 */
export function parseModelSelection(value: string): { provider: { providerId: string }; modelId: string } | undefined {
  const sep = value.indexOf(":");
  if (sep <= 0 || sep === value.length - 1) return undefined;
  const providerId = value.slice(0, sep);
  const modelId = value.slice(sep + 1);
  if (providerId === "" || modelId === "") return undefined;
  return { provider: { providerId }, modelId };
}

/**
 * 按 cwd 共享的 app-server 进程池：懒加载、引用计数、空闲树杀回收（对齐官方常驻池口径）。
 *
 * why 按 cwd：桌面端「每 workspaceKey 一个 CLI 进程」，workspaceKey 由项目目录派生；
 * 一个进程内多会话是官方形态（sessions Map + 常驻池）。
 */
export class ZcodeAppServerPool {
  readonly #entries = new Map<
    string,
    { server: ZcodeAppServer; refcount: number; idleTimer: ReturnType<typeof setTimeout> | undefined }
  >();
  readonly #deps: {
    cli: { file: string; args: readonly string[] };
    logger?: Logger | undefined;
    idleTimeoutMs: number;
  };

  constructor(deps: { cli: { file: string; args: readonly string[] }; logger?: Logger; idleTimeoutMs?: number }) {
    this.#deps = { ...deps, idleTimeoutMs: deps.idleTimeoutMs ?? 600_000 };
  }

  /** 取得（或拉起）cwd 对应的进程；引用 +1。进程意外断开时下次 acquire 自动重拉。 */
  async acquire(cwd: string): Promise<ZcodeAppServer> {
    const key = cwd.toLowerCase();
    const existing = this.#entries.get(key);
    if (existing !== undefined && !existing.server.closed) {
      existing.refcount++;
      if (existing.idleTimer !== undefined) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = undefined;
      }
      return existing.server;
    }
    const server = await ZcodeAppServer.connect(this.#deps.cli.file, this.#deps.cli.args, {
      logger: this.#deps.logger,
    });
    const entry = { server, refcount: 1, idleTimer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.#entries.set(key, entry);
    server.installCloseHandler(() => {
      this.#entries.delete(key);
    });
    return server;
  }

  /** 释放一次引用；引用归零启动空闲回收计时。 */
  release(cwd: string): void {
    const entry = this.#entries.get(cwd.toLowerCase());
    if (entry === undefined) return;
    entry.refcount = Math.max(0, entry.refcount - 1);
    if (entry.refcount > 0 || entry.idleTimer !== undefined) return;
    entry.idleTimer = setTimeout(() => {
      this.#entries.delete(cwd.toLowerCase());
      void entry.server.close();
    }, this.#deps.idleTimeoutMs);
  }

  /** 全量回收（服务关闭）。 */
  async disposeAll(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
        await entry.server.close();
      }),
    );
  }

  get size(): number {
    return this.#entries.size;
  }
}
