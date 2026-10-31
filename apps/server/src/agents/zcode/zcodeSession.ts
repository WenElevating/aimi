import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { MetricRecorder } from "../../observability/metrics.js";
import type { AgentCommand, SessionSpec } from "@aimi/protocol";
import type { AgentRuntime, AgentSession, Emit } from "../types.js";
import type { Logger } from "../../logging/logger.js";
import type { MetricContext } from "@aimi/protocol";
import { killTree } from "../killTree.js";
import { parseLine, parseSessionEvent } from "./zcodeProtocol.js";
import { ZCODE_DEFAULT_PERMISSION_MODE, ZCODE_PERMISSION_MODES } from "./zcodePermissions.js";
import {
  ZcodeAppServerPool,
  type ZcodeAppServer,
  type ZcodePermissionRequest,
  type ZcodeSessionEventParams,
} from "./appServer/zcodeAppServer.js";

/**
 * zcode 的一条 agent 侧会话：以「每回合一个 CLI 子进程」驱动 zcode 非交互模式。
 *
 * - **进程模型**：zcode 的文档化契约是批处理——一次 `--prompt` 跑一个回合后进程退出。
 *   本类保持**单个逻辑句柄跨回合存活**：回合结束（`turn_complete/turn_failed` 归一为
 *   `state:finished/failed`）后进程自然退出，句柄不 dispose、不发 `exit`；下一条 send
 *   由本类以 `--resume <sessionId>` 拉起新进程续接同一 zcode 会话。运行中新 send 进内部
 *   队列，当前回合结束后依序开新回合（与手机待发胶囊的排队语义对齐）。
 * - **事件流**：子进程 stdout 逐行 `parseLine`（纯归一化层）后 emit 送达编排层；
 *   stderr 环形保留末段，异常终止时随 `exit.stderrTail` 带出。
 * - **续接线索**：任一事件行的 `sessionId` 捕获为 resume hint（`runtime()` 供编排层
 *   回写 `resume_hint`）；`session_updated` 的 `modelId` 变化时发 `configured`（CLI 无
 *   `--model`，模型跟随全局 provider 配置——此处只是如实上报实测值）。
 * - **中断**：树杀当前回合进程（killTree）→ `notice:warn` + `state:stopped`（stopped
 *   先于进程 exit，终态后 exit 收口不再叠加 failed）。
 * - **看门狗**：每回合 30s 首事件超时——spawn 后无任何 stdout 事件即判协议未确认，
 *   `notice:error` + `state:failed` + 树杀 + `onProtocolFailure`（对齐 claude 08f9197 口径）。
 * - **生命周期单向**：`dispose()` 之后句柄作废——`start()` 抛 `zcode session disposed`。
 */
export class ZcodeSession implements AgentSession {
  readonly #spec: SessionSpec;
  readonly #metrics: MetricRecorder;
  readonly #metricsContext: (() => MetricContext) | undefined;
  readonly #emit: Emit;
  readonly #logger: Logger | undefined;
  readonly #initTimeoutMs: number;
  readonly #onRuntimeChanged: (() => void) | undefined;
  readonly #onProtocolFailure: (() => void) | undefined;
  /** CLI 启动描述：`file` 为可执行（node/zcode.exe），`args` 为其固定前缀（如 zcode.cjs 路径）。 */
  readonly #cli: { readonly file: string; readonly args: readonly string[] };
  /** resume 传入的续接线索（重挂路径）；与运行期捕获的 `#sessionId` 同源 */
  readonly #resumeHint: string | undefined;
  /** app-server 进程池（协议模式）；undefined = batch 模式 */
  readonly #pool: ZcodeAppServerPool | undefined;
  /** 协议模式下从池里借出的 server 实例（dispose 时归还引用） */
  #appServer: ZcodeAppServer | undefined;
  /** 协议模式挂起审批：aimi permission id → {serverFrameId, options} */
  readonly #pendingPermissions = new Map<string, { serverFrameId: number | string; options: readonly unknown[] }>();

  #permissionMode: string | undefined;
  /** zcode 侧会话 id（resume 传入或首回合事件捕获；`--resume` 续接线索） */
  #sessionId: string | undefined;
  /** 实测模型（`session_updated.modelId`）；变化时发 `configured` */
  #resolvedModel: string | undefined;
  /** 当前回合进程；回合间为 `undefined` */
  #child: ChildProcess | undefined;
  /** 运行中的 send 排队（当前回合结束后依序开新回合） */
  readonly #pendingSends: string[] = [];
  /** 当前回合是否活跃（进程存活且未见回合终态） */
  #turnActive = false;
  /** 是否已 dispose（生命周期单向） */
  #disposed = false;
  /** 句柄是否已不可交付（致命错误后置位；正常回合结束**不**置位——句柄跨回合存活） */
  #exited = false;
  /** 当前回合 spawn 时刻（exit.durationMs 基准） */
  #turnStartedAt = 0;
  /** stderr 末段环形原文 */
  #stderrTail = "";
  /** 每回合首事件看门狗 */
  #turnTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param spec - 会话描述（`cwd` 传给 CLI `--cwd`；`initialPrompt` 非空时 start 即开首回合）
   * @param emit - 归一化事件出口（同步 void，顺序权威在 `EventBus`）
   * @param resume - 续接线索（重挂路径：存在即以 `--resume <hint>` 续接；zcode 无 fork）
   * @param deps.cli - CLI 启动描述（适配器解析后的可执行与固定参数前缀）
   * @param deps.initTimeoutMs - 回合看门狗上限（缺省 30s；注入点仅为测试可缩短等待）
   * @param deps.onProtocolFailure - 看门狗判定协议未确认时的回调（装配层标灰用；缺省不做）
   */
  constructor(
    spec: SessionSpec,
    emit: Emit,
    resume: { hint: string } | undefined,
    deps: {
      cli: { file: string; args: readonly string[] };
      logger?: Logger;
      initTimeoutMs?: number;
      onProtocolFailure?: () => void;
      onRuntimeChanged?: () => void;
      metricsContext?: () => MetricContext;
      aimiSessionId?: string;
      /** app-server 进程池：存在即走协议会话（M2）；缺省回退 M1 batch 路径。 */
      pool?: ZcodeAppServerPool;
    },
  ) {
    this.#spec = spec;
    this.#emit = emit;
    this.#resumeHint = resume?.hint;
    this.#sessionId = resume?.hint;
    this.#pool = deps.pool;
    this.#cli = deps.cli;
    this.#logger = deps.logger;
    this.#initTimeoutMs = deps.initTimeoutMs ?? 30_000;
    this.#onProtocolFailure = deps.onProtocolFailure;
    this.#onRuntimeChanged = deps.onRuntimeChanged;
    this.#metricsContext = deps.metricsContext;
    // 会话缺省档位：编排层保证 spec.permissionMode 非空；空串兜底按用户裁决取 edit。
    this.#permissionMode = spec.permissionMode !== "" ? spec.permissionMode : ZCODE_DEFAULT_PERMISSION_MODE;
    this.#metrics = new MetricRecorder({
      sourceId: "zcode.session",
      component: "agent",
      context: {
        agentId: spec.agentId,
        ...(deps.aimiSessionId === undefined ? {} : { sessionId: deps.aimiSessionId }),
      },
    });
    const definitions = [
      ["agent.zcode.turn", "counter", "count", "zcode 回合数（每回合一个 CLI 子进程）", "turn spawn"],
      ["agent.output.utf16", "counter", "utf16", "正文输出 UTF-16 码元数", "normalized text delta"],
      ["agent.error", "counter", "count", "回合失败/异常退出次数", "turn failed or abnormal exit"],
      ["agent.exit", "counter", "count", "异常终止次数（正常回合退出不计）", "abnormal process exit"],
    ] as const;
    for (const [name, kind, unit, description, boundary] of definitions) {
      this.#metrics.define({ name, kind, unit, description, boundary, availability: "available" });
    }
  }

  metrics() {
    return this.#metrics;
  }

  /** 拉起会话：协议模式建/恢复 app-server 会话并订阅；batch 模式有 initialPrompt 即开首回合。 */
  async start(): Promise<void> {
    if (this.#disposed) throw new Error("zcode session disposed");
    if (this.#pool !== undefined) {
      await this.#protocolStart();
      return;
    }
    const prompt = this.#spec.initialPrompt;
    if (prompt !== undefined && prompt !== "") this.#beginTurn(prompt);
  }

  /** 协议模式启动：借出进程 → create/resume → 挂回调 → subscribe；initialPrompt 非空即首条 send。 */
  async #protocolStart(): Promise<void> {
    const pool = this.#pool!;
    this.#appServer = await pool.acquire(this.#spec.cwd);
    const server = this.#appServer;
    if (this.#resumeHint !== undefined && this.#resumeHint !== "") {
      this.#sessionId = this.#resumeHint;
      await server.resumeSession({ sessionId: this.#resumeHint });
    } else {
      const created = await server.createSession({ cwd: this.#spec.cwd, mode: this.#permissionMode ?? "edit" });
      this.#sessionId = created.sessionId;
    }
    const sid = this.#sessionId;
    const context = this.#metricsContext?.() ?? {};
    server.setEventHandler(sid, (event: ZcodeSessionEventParams) => {
      const parsed = parseSessionEvent(event.type.replaceAll(".", "_"), event.payload);
      if (parsed.modelId !== undefined && parsed.modelId !== this.#resolvedModel) {
        this.#resolvedModel = parsed.modelId;
        this.#emit({ type: "configured", model: parsed.modelId });
      }
      for (const agentEvent of parsed.events) {
        this.#emit(agentEvent);
        if (agentEvent.type === "text_delta")
          this.#metrics.record("agent.output.utf16", agentEvent.text.length, context);
      }
    });
    server.setPermissionHandler(sid, (request) => this.#onPermissionRequest(request));
    server.setLifecycleHandler(sid, (state, lastError) => {
      // unloaded/failed = 进程侧会话不可用（app-server 回收/崩溃）——落 failed 让编排层走续接路径。
      if (state === "unloaded" || state === "failed") {
        this.#exited = true;
        this.#metrics.record("agent.error", 1, context);
        this.#emit({
          type: "notice",
          severity: "error",
          text: `zcode 会话被宿主卸载（${state}${lastError === null ? "" : ": " + String(lastError).slice(0, 300)}）`,
        });
        this.#emit({ type: "state", state: "failed" });
        this.#onProtocolFailure?.();
      }
    });
    await server.subscribe(sid);
    const prompt = this.#spec.initialPrompt;
    if (prompt !== undefined && prompt !== "") await server.send(sid, prompt);
  }

  /** 审批反向请求 → 手机 permission 卡（三键零改动）+ 挂起登记；approve 指令回填应答。 */
  #onPermissionRequest(request: ZcodePermissionRequest): void {
    const raw = request.raw as { requestId?: unknown } | null;
    const businessId = typeof raw?.requestId === "string" ? raw.requestId : "";
    const permissionId = businessId !== "" ? businessId : String(request.requestId);
    this.#pendingPermissions.set(permissionId, { serverFrameId: request.requestId, options: request.options });
    this.#emit({
      type: "permission",
      id: permissionId,
      title: request.toolName,
      detail: JSON.stringify(request.input ?? null).slice(0, 8192),
      options: [
        { label: "本次允许", kind: "once" },
        { label: "一直允许", kind: "always" },
        { label: "拒绝", kind: "reject" },
      ],
    });
    this.#emit({ type: "state", state: "waiting_approval" });
  }

  /** 审批应答：按 decision 选取 zcode option（allowOnce/allowAlways/deny），无匹配宁拒。 */
  #answerPermission(permissionId: string, decision: "once" | "always" | "reject"): void {
    const pending = this.#pendingPermissions.get(permissionId);
    if (pending === undefined) return; // 晚到审批：静默（会话可能已被宿主回收）
    this.#pendingPermissions.delete(permissionId);
    const wanted = decision === "reject" ? "deny" : "allow";
    const preferAlways = decision === "always";
    let chosen: unknown = { decision: "deny" };
    for (const option of pending.options) {
      if (typeof option !== "object" || option === null) continue;
      const o = option as { optionId?: unknown; response?: { decision?: unknown } };
      const optionId = typeof o.optionId === "string" ? o.optionId.toLowerCase() : "";
      const responseDecision = typeof o.response?.decision === "string" ? o.response.decision : "";
      if (responseDecision !== wanted) continue;
      if (wanted === "allow" && preferAlways !== optionId.includes("always")) continue;
      chosen = o.response;
      break;
    }
    this.#appServer?.respondPermission(pending.serverFrameId, chosen);
    this.#emit({ type: "state", state: "running" });
  }

  async send(cmd: AgentCommand): Promise<void> {
    if (this.#disposed || this.#exited) throw new Error("zcode session exited");
    if (this.#pool !== undefined) {
      // 协议模式：回合中 send 由 zcode 原生 steer 队列接管（手机待发胶囊语义对齐）。
      switch (cmd.cmd) {
        case "send":
          await this.#appServer?.send(this.#sessionId ?? "", cmd.text);
          return;
        case "interrupt":
          await this.#appServer?.stop(this.#sessionId ?? "");
          this.#emit({ type: "notice", severity: "warn", text: "已发送中断" });
          return;
        case "configure": {
          if (cmd.model !== undefined && cmd.model !== this.#resolvedModel) {
            const server = this.#appServer;
            if (server === undefined) throw new Error("zcode app-server 未就绪");
            await server.setModel(this.#sessionId ?? "", cmd.model);
            // configured 不在此处发：单一来源是 CLI 的 session.updated 实测回显（事件泵统一发）。
            this.#resolvedModel = cmd.model;
          }
          if (cmd.permissionMode !== undefined && cmd.permissionMode !== this.#permissionMode) {
            await this.#appServer?.setMode(this.#sessionId ?? "", cmd.permissionMode);
            this.#permissionMode = cmd.permissionMode;
            this.#notifyRuntimeChanged();
          }
          return;
        }
        case "approve":
          this.#answerPermission(cmd.requestId, cmd.decision);
          return;
        default:
          throw new Error("zcode session unsupported command: " + String((cmd as { cmd: string }).cmd));
      }
    }
    switch (cmd.cmd) {
      case "send":
        this.#enqueueOrBegin(cmd.text);
        return;
      case "interrupt":
        this.#interruptActive();
        return;
      case "configure":
        // batch 模式：模型跟随全局 provider 配置（CLI 无 --model）——抛错让编排层不保存该字段。
        if (cmd.model !== undefined && cmd.model !== this.#resolvedModel) {
          throw new Error("zcode 模型跟随全局配置，暂不支持会话级切换");
        }
        if (cmd.permissionMode !== undefined) {
          this.#permissionMode = cmd.permissionMode;
          this.#notifyRuntimeChanged();
        }
        return;
      case "approve":
        return; // batch 无审批卡
      default:
        throw new Error("zcode session unsupported command: " + String((cmd as { cmd: string }).cmd));
    }
  }

  runtime(): AgentRuntime | null {
    if (this.#disposed) return null;
    return {
      pid: this.#child?.pid,
      resumeHint: this.#sessionId ?? this.#resumeHint,
      permissionMode: this.#permissionMode,
    };
  }

  /** 活性：句柄未作废即活（回合间无进程是常态，send 以新进程交付）。 */
  isAlive(): boolean {
    return !this.#disposed && !this.#exited;
  }

  /** 会话级模式目录：无运行时收紧，直接返回静态目录（目录权威在适配器）。 */
  permissionModes() {
    return ZCODE_PERMISSION_MODES;
  }

  /** 释放会话：协议模式归还进程引用（进程由池按空闲回收）；batch 模式树杀当前回合进程。幂等。 */
  async dispose(reason?: string): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#pool !== undefined) {
      const server = this.#appServer;
      this.#appServer = undefined;
      if (server !== undefined) {
        if (this.#sessionId !== undefined) {
          server.setEventHandler(this.#sessionId, undefined);
          server.setPermissionHandler(this.#sessionId, undefined);
          server.setLifecycleHandler(this.#sessionId, undefined);
        }
        this.#pool.release(this.#spec.cwd);
      }
      this.#logger?.info?.("zcode session disposed", { reason: reason ?? "" });
      return;
    }
    this.#clearTurnTimer();
    const child = this.#child;
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      killTree(child.pid, "SIGKILL");
    }
    this.#child = undefined;
    this.#turnActive = false;
    this.#logger?.info?.("zcode session disposed", { reason: reason ?? "" });
  }

  /** send 入口：回合活跃则排队，否则立即开回合。 */
  #enqueueOrBegin(text: string): void {
    if (this.#turnActive) {
      this.#pendingSends.push(text);
      return;
    }
    this.#beginTurn(text);
  }

  /**
   * 开一个回合：spawn `--prompt <text> [--resume <sessionId>]` 并接管 stdout/stderr/exit。
   * 事件经 parseLine 归一化后 emit；`sessionId` 捕获变更即通知编排层（回写 resume_hint）。
   */
  #beginTurn(text: string): void {
    if (this.#disposed || this.#exited) return;
    const mode = this.#permissionMode ?? ZCODE_DEFAULT_PERMISSION_MODE;
    const args = [
      ...this.#cli.args,
      "--prompt",
      text,
      "--cwd",
      this.#spec.cwd,
      "--mode",
      mode,
      "--output-format",
      "stream-json",
      "--no-color",
    ];
    if (this.#sessionId !== undefined && this.#sessionId !== "") args.push("--resume", this.#sessionId);

    let child: ChildProcess;
    try {
      child = spawn(this.#cli.file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      this.#failFatal("zcode 进程拉起失败：" + String(error));
      return;
    }
    this.#child = child;
    this.#turnActive = true;
    this.#turnStartedAt = Date.now();
    this.#stderrTail = "";
    this.#armTurnTimer();
    this.#metrics.record("agent.zcode.turn", 1, this.#metricsContext?.());

    // stdout：逐行归一化。首事件到达即撤看门狗；回合终态后收尾并排空队列。
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line: string) => {
      this.#clearTurnTimer();
      const parsed = parseLine(line);
      if (parsed.sessionId !== undefined && parsed.sessionId !== this.#sessionId) {
        this.#sessionId = parsed.sessionId;
        this.#notifyRuntimeChanged();
      }
      if (parsed.modelId !== undefined && parsed.modelId !== this.#resolvedModel) {
        this.#resolvedModel = parsed.modelId;
        this.#emit({ type: "configured", model: parsed.modelId });
      }
      let terminal = false;
      for (const event of parsed.events) {
        this.#emit(event);
        if (event.type === "text_delta")
          this.#metrics.record("agent.output.utf16", event.text.length, this.#metricsContext?.());
        if (event.type === "state" && (event.state === "finished" || event.state === "failed")) terminal = true;
      }
      if (terminal) this.#endTurn(child);
    });

    // stderr：环形保留末段（异常终止时随 exit 带出）。
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-600);
    });

    child.on("error", (error: Error) => {
      if (this.#child !== child || !this.#turnActive) return;
      this.#failFatal("zcode 进程错误：" + error.message);
    });

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#clearTurnTimer();
      if (!this.#turnActive) return; // 正常回合收尾（终态已 emit），进程退出是预期行为
      // 异常终止：进程在回合终态前退出（崩溃/被外部杀死）。
      this.#turnActive = false;
      this.#exited = true;
      this.#metrics.record("agent.error", 1, this.#metricsContext?.());
      this.#metrics.record("agent.exit", 1, this.#metricsContext?.());
      const tail = this.#stderrTail.trim();
      const detail = tail !== "" ? "；stderr: " + tail : "";
      this.#emit({
        type: "notice",
        severity: "error",
        text: `zcode 异常退出（code=${String(code)} signal=${String(signal)}${detail}）`.slice(0, 500),
      });
      this.#emit({ type: "state", state: "failed" });
      this.#emit({
        type: "exit",
        exitCode: code,
        durationMs: Math.max(0, Date.now() - this.#turnStartedAt),
        ...(tail === "" ? {} : { stderrTail: tail.slice(0, 600) }),
      });
    });
  }

  /** 回合正常收尾：撤看门狗、清句柄引用（进程自然退出）、排空排队 send。 */
  #endTurn(finishedChild: ChildProcess): void {
    this.#clearTurnTimer();
    this.#turnActive = false;
    if (this.#child === finishedChild) this.#child = undefined;
    const next = this.#pendingSends.shift();
    if (next !== undefined) this.#beginTurn(next);
  }

  /** 中断：树杀当前回合进程；stopped 先落（终态），exit 处理器按正常收尾分支处理。 */
  #interruptActive(): void {
    const child = this.#child;
    if (child === undefined || !this.#turnActive) return;
    this.#emit({ type: "notice", severity: "warn", text: "已发送中断，正在终止 zcode 回合" });
    this.#emit({ type: "state", state: "stopped" });
    this.#turnActive = false;
    this.#clearTurnTimer();
    killTree(child.pid, "SIGKILL");
  }

  /** 致命失败（spawn 失败/进程错误）：notice + failed + exit，句柄作废。 */
  #failFatal(message: string): void {
    this.#clearTurnTimer();
    this.#turnActive = false;
    this.#exited = true;
    this.#metrics.record("agent.error", 1, this.#metricsContext?.());
    this.#metrics.record("agent.exit", 1, this.#metricsContext?.());
    this.#emit({ type: "notice", severity: "error", text: message.slice(0, 500) });
    this.#emit({ type: "state", state: "failed" });
    this.#emit({ type: "exit", exitCode: null, durationMs: Math.max(0, Date.now() - this.#turnStartedAt) });
  }

  /** 每回合首事件看门狗：超时即协议未确认——notice + failed + 树杀 + 标灰回调（claude 08f9197 口径）。 */
  #armTurnTimer(): void {
    this.#clearTurnTimer();
    this.#turnTimer = setTimeout(() => {
      if (!this.#turnActive) return;
      const child = this.#child;
      this.#turnActive = false;
      this.#exited = true;
      this.#metrics.record("agent.error", 1, this.#metricsContext?.());
      this.#metrics.record("agent.exit", 1, this.#metricsContext?.());
      this.#emit({ type: "notice", severity: "error", text: "zcode 回合 30 秒无事件输出，判定协议未确认" });
      this.#emit({ type: "state", state: "failed" });
      if (child !== undefined) killTree(child.pid, "SIGKILL");
      this.#child = undefined;
      this.#onProtocolFailure?.();
    }, this.#initTimeoutMs);
  }

  #clearTurnTimer(): void {
    if (this.#turnTimer !== undefined) {
      clearTimeout(this.#turnTimer);
      this.#turnTimer = undefined;
    }
  }

  #notifyRuntimeChanged(): void {
    this.#onRuntimeChanged?.();
  }
}
