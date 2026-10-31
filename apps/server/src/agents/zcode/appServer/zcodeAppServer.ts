import { randomUUID } from "node:crypto";
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
  /** 运行时模型目录（state.updated patch.model.available；比 provider 配置文件更权威——含可用性与标签） */
  #modelCatalog: readonly ZcodeRuntimeModel[] | undefined;

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

  /** 运行时模型目录（任一会话的 state.updated 上报；无会话前为 undefined）。 */
  get runtimeModels(): readonly ZcodeRuntimeModel[] | undefined {
    return this.#modelCatalog;
  }

  /** 注册某会话的事件泵回调（session/event 通知；params 与 batch 流信封同构）。 */
  setEventHandler(sessionId: string, handler: ((event: ZcodeSessionEventParams) => void) | undefined): void {
    if (handler === undefined) this.#eventHandlers.delete(sessionId);
    else this.#eventHandlers.set(sessionId, handler);
  }

  /**
   * 新建会话；返回 sessionId 与初始投影。
   *
   * **sessionId 由客户端生成**（`sess_` 前缀，探针实证：create 的 result 只有
   * `{messages, projection}`，不含 id——会话身份经 params 传入、lifecycle 通知确认）。
   *
   * 模型选型（键 `model`、扁平值，见 [parseModelSelection]）经 [withReasoningRetry]：
   * reasoning 必选模型在缺档时按档位梯自动补齐（实机审计反馈 20261031-213405）。
   */
  async createSession(params: {
    cwd: string;
    mode: string;
    model?: string;
    sessionId?: string;
    timeoutMs?: number;
  }): Promise<{ sessionId: string; projection: unknown }> {
    const sessionId = params.sessionId ?? "sess_" + randomUUID();
    const selection = params.model !== undefined ? parseModelSelection(params.model) : undefined;
    const attempt = (reasoningLevel?: string): Promise<{ messages?: unknown; projection?: unknown }> =>
      this.#client.request(
        "session/create",
        {
          sessionId,
          workspace: { workspacePath: params.cwd, workspaceKey: params.cwd },
          ...(params.mode !== "" ? { mode: params.mode } : {}),
          // 选型键是 `model`（实机审计实证：modelSelection 在 create 根上是 Unrecognized
          // key，而旧错误的 `model.providerId` 路径证明根 schema 认识 model 键）。
          ...(selection !== undefined
            ? { model: { ...selection, ...(reasoningLevel !== undefined ? { options: { reasoningLevel } } : {}) } }
            : {}),
        },
        params.timeoutMs,
      ) as Promise<{ messages?: unknown; projection?: unknown }>;
    const result = await withReasoningRetry(selection, attempt);
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

  /** 会话级切模型（model 必须扁平 `{providerId, modelId}`，reasoning 档位同 create 走梯）。 */
  async setModel(sessionId: string, model: string, timeoutMs?: number): Promise<void> {
    const selection = parseModelSelection(model);
    await withReasoningRetry(selection, (reasoningLevel) =>
      this.#client.request(
        "session/setModel",
        {
          sessionId,
          ...(selection !== undefined
            ? { model: { ...selection, ...(reasoningLevel !== undefined ? { options: { reasoningLevel } } : {}) } }
            : {}),
        },
        timeoutMs,
      ),
    );
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
    if (method === "state.updated") {
      const patch = p as { patch?: { model?: { available?: unknown } } };
      const available = patch.patch?.model?.available;
      if (Array.isArray(available)) {
        this.#modelCatalog = available
          .map((entry) => {
            if (typeof entry !== "object" || entry === null) return undefined;
            const m = entry as {
              ref?: { providerId?: unknown; modelId?: unknown };
              label?: unknown;
              providerLabel?: unknown;
            };
            const providerId = typeof m.ref?.providerId === "string" ? m.ref.providerId : undefined;
            const modelId = typeof m.ref?.modelId === "string" ? m.ref.modelId : undefined;
            if (providerId === undefined || modelId === undefined) return undefined;
            const label = typeof m.label === "string" && m.label !== "" ? m.label : modelId;
            const providerLabel = typeof m.providerLabel === "string" ? m.providerLabel : providerId;
            return {
              value: providerId + ":" + modelId,
              name: label,
              detail: "provider: " + providerLabel,
              group: providerLabel,
            };
          })
          .filter((m): m is ZcodeRuntimeModel => m !== undefined);
      }
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

/** 运行时模型目录条目（state.updated patch.model.available 的投影）。 */
export interface ZcodeRuntimeModel {
  readonly value: string;
  readonly name: string;
  readonly detail: string;
  readonly group: string;
}

/** 会话事件通知的防御式投影（params 与 batch 流信封同构）。 */
export interface ZcodeSessionEventParams {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly sessionId: string;
}

/**
 * `providerId:modelId` 编码解析为 zcode ModelSelection——**扁平 `{providerId, modelId}`**。
 *
 * 形状实证：zcode 桌面 bundle 的 zod schema `Nl = {providerId: string, modelId: string,
 * options?}`，两键同级；嵌套 `{provider: {providerId}}` 被 strict schema 拒绝（-32602
 * "model.providerId expected string / Unrecognized key provider"），曾致带模型选型的回合
 * 秒败（反馈 20261031-213405）。非法串返回 undefined。
 */
export function parseModelSelection(value: string): { providerId: string; modelId: string } | undefined {
  const sep = value.indexOf(":");
  if (sep <= 0 || sep === value.length - 1) return undefined;
  const providerId = value.slice(0, sep);
  const modelId = value.slice(sep + 1);
  if (providerId === "" || modelId === "") return undefined;
  return { providerId, modelId };
}

/** reasoning 档位梯的首猜（常见档位表的中间档；不支持时错误 data 会带全表）。 */
const REASONING_LEVEL_GUESS = "high";

/** 判定错误是否为「reasoning 档位缺失」（zcode -32603 业务校验，实机审计反馈 20261031-213405）。 */
function isReasoningLevelRequired(err: unknown): boolean {
  return /Reasoning level is required/.test(err instanceof Error ? err.message : String(err));
}

/** 从 not-supported 错误的 data 提取 supportedLevels（data 直接挂或嵌套一层都容错）。 */
function supportedLevelsOf(err: unknown): readonly string[] | undefined {
  const data = (err as { data?: unknown } | undefined)?.data;
  for (const candidate of [data, (data as { data?: unknown } | undefined)?.data]) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const levels = (candidate as { supportedLevels?: unknown }).supportedLevels;
    if (Array.isArray(levels)) {
      const parsed = levels.filter((level): level is string => typeof level === "string");
      if (parsed.length > 0) return parsed;
    }
  }
  return undefined;
}

/**
 * reasoning 必选模型的档位重试梯。
 *
 * why：zcode 每模型的档位表只在错误里披露——缺档 -32603（无表）、错档 -32603
 * not-supported（data.supportedLevels 带全表）；运行时目录虽含 reasoning.defaultLevel
 * 但冷启动不推送（实机探针实证：create+subscribe 后无 send 就没有目录）。
 * 梯：缺省 → 首猜 high → 全表末档（zcode 缺省口径 defaultLevel = values.at(-1)）。
 * selection 为 undefined（未带模型选型）时直接透传请求。
 */
async function withReasoningRetry<T>(
  selection: { providerId: string; modelId: string } | undefined,
  attempt: (reasoningLevel?: string) => Promise<T>,
): Promise<T> {
  if (selection === undefined) return attempt();
  try {
    return await attempt();
  } catch (err) {
    if (!isReasoningLevelRequired(err)) throw err;
    try {
      return await attempt(REASONING_LEVEL_GUESS);
    } catch (guessErr) {
      const levels = supportedLevelsOf(guessErr);
      if (levels === undefined || levels.includes(REASONING_LEVEL_GUESS)) throw guessErr;
      return await attempt(levels[levels.length - 1]);
    }
  }
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
    // 协议入口参数：缺省 ["app-server", "--stdio"]（ZCODE_AGENT_RUNTIME.spawnArgs 同款）。
    const server = await ZcodeAppServer.connect(
      this.#deps.cli.file,
      [...this.#deps.cli.args, "app-server", "--stdio"],
      { logger: this.#deps.logger },
    );
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

  /**
   * 立即回收全部空闲进程（引用为 0）；引用被持有的（会话进行中）不动。
   *
   * why：app-server 进程内的模型目录可能滞后于磁盘配置（zcode 进程不保证热重载），
   * provider 配置变化时由适配器调用——下一次会话用新配置拉起，忙进程收尾自然回收。
   */
  recycleIdle(): void {
    for (const [key, entry] of this.#entries) {
      if (entry.refcount !== 0 || entry.server.closed) continue;
      if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
      this.#entries.delete(key);
      void entry.server.close().catch(() => {
        /* 回收失败交由 close handler 清台账；不阻断清单刷新路径 */
      });
    }
  }

  /** 运行时模型目录：任一活跃 app-server 上报过的最新目录（无则 undefined，调用方回退配置文件）。 */
  latestModels(): readonly ZcodeRuntimeModel[] | undefined {
    for (const entry of this.#entries.values()) {
      if (!entry.server.closed && entry.server.runtimeModels !== undefined) {
        return entry.server.runtimeModels;
      }
    }
    return undefined;
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
