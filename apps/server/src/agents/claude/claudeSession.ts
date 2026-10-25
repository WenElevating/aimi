import { CLAUDE_PERMISSION_MODES, claudePermissionMode } from "./claudePermissions.js";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { query, resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import type { AgentCommand, SessionSpec } from "@aimi/protocol";
import type { AgentRuntime, AgentSession, Emit } from "../types.js";
import type { Logger } from "../../logging/logger.js";
import { parseLine } from "./claudeProtocol.js";
import { friendlyAgentError } from "./agentErrorText.js";

/**
 * `system/init` 看门狗上限 30 秒（CLI 懒 init 事实不变：首条 user 帧写入后 init 才会在秒级到达；
 * 30s 仍未确认即判定"适配器协议未确认"，标灰全流程的前端事实落点）。
 * why 常量并命名：协议漂移（CLI 大版本变更致 init 缺失）的唯一可观测面就在这里，
 * 禁止散落魔数延迟阈值。
 */
const INIT_TIMEOUT_MS = 30_000;

/** `dispose` 等消费循环收尾的上限：`q.close()` 后流应即刻结束，超时即放弃等待（防挂起调用方）。 */
const DISPOSE_WAIT_MS = 3000;

/** stderr 末段摘录上限：崩溃原因（参数错误/环境错误）集中在退出前的最后几行，600 字符足够定位。 */
const STDERR_TAIL_MAX = 600;

/** ANSI 转义序列（CLI 彩色输出）：进摘录前剥离，避免日志与手机时间线出现不可读控制符。 */
const ANSI_PATTERN = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[A-Za-z]", "g");

/** 手机审批三选项（与历史 PermissionRelay 逐字一致——手机 UI 零改动；kind 是 approve 指令回传值）。 */
const APPROVAL_OPTIONS = [
  { label: "本次允许", kind: "once" },
  { label: "一直允许", kind: "always" },
  { label: "拒绝", kind: "reject" },
] as const;

/** 拒绝决定的固定文案：SDK 会把 message 进入模型的协调上下文（软拒——模型继续换路重试）。 */
const REJECT_MESSAGE = "手机端拒绝";

/**
 * claude code 的一条 agent 侧会话：基于官方 Agent SDK（`@anthropic-ai/claude-agent-sdk`）。
 *
 * - **进程与传输**：SDK 负责拉起/终止内置 claude CLI 子进程与 stream-json 双向协议；本类只保留
 *   生命周期编排（start/send/dispose）与事件归一化——`parseLine(JSON.stringify(message))`
 *   复用既有纯归一化层，行为与手搓线协议逐字一致（SDK 消息即 wire 帧的解析形态）。
 * - **输入**：流式输入模式——受控 async generator 作 `prompt`；`send` 的文本推入队列、
 *   generator 按需 yield（start 前的推送排队语义与旧 stdin 队列等价）。控制请求
 *   （setModel/setPermissionMode/interrupt）仅在该模式可用。
 * - **审批**：`canUseTool` 进程内回调桥——CLI 的 `can_use_tool` 控制请求到达即发 `permission`
 *   卡 + `waiting_approval`，手机 `approve` 决定 resolve 挂起的 Promise（once/always/reject）；
 *   「一直允许」为会话内记名（内存 allowlist，同工具后续请求自动放行 + 可见性 notice）。
 * - **stderr 末段摘录**：`Options.stderr` 回调环形保留末段，异常流终止时随 `exit.stderrTail` 带出。
 * - **续接线索**：`system/init.session_id` 捕获（`getResumeHint()`）；init 的 `model`（CLI 实际
 *   解析值）另存 `getResolvedModel()`。
 * - **生命周期单向**：`dispose()` 之后句柄作废——`start()` 抛 `claude session disposed`。
 *   重挂由 `SessionManager` 经适配器 `create()` 取新句柄。
 */
export class ClaudeSession implements AgentSession {
  readonly #spec: SessionSpec;
  readonly #allowDangerouslySkipPermissions: boolean;
  readonly #onRuntimeChanged: (() => void) | undefined;
  #permissionMode: string | undefined;
  #permissionRevision = 0;
  readonly #unavailableModes = new Map<string, string>();
  readonly #policyDisabledModes = new Set<string>();
  readonly #emit: Emit;
  readonly #resumeHint: string | undefined;
  /** SDK 查询句柄；`start()` 前为 `undefined`（此间下发的输入进入 `#inputQueue`） */
  #q: Query | undefined;
  #startRequested = false;
  /** 消费循环（`for await` 消息流）；`start()` 启动，`dispose` 有界等待其收尾 */
  #consumer: Promise<void> | undefined;
  /** 流式输入队列：手机消息先入队，generator 被拉取时按序 yield */
  readonly #inputQueue: SDKUserMessage[] = [];
  /** 唤醒挂起中的输入 generator（新消息入队时置位） */
  #inputWake: (() => void) | undefined;
  /** 消息流是否已终止（正常收尾或错误）——终止后 send 静默丢弃 */
  #exited = false;
  /** 是否已 dispose（生命周期单向：置位后 `start()` 一律拒绝） */
  #disposed = false;
  /** 会话拉起时刻（`exit.durationMs` 基准） */
  #startedAt = 0;
  /** `system/init` 捕获的 claude 侧会话 id（resume 线索） */
  #sessionId: string | undefined;
  /** `system/init` 捕获的 CLI 实际解析模型（如 `claude-opus-5`） */
  #resolvedModel: string | undefined;
  /** stderr 末段环形原文（异常终止时剥 ANSI 后随 exit 带出） */
  #stderrTail = "";
  /** init 看门狗定时器（`system/init` 到达 / 流终止 / dispose 时清算） */
  #initTimer: ReturnType<typeof setTimeout> | undefined;
  /** 首条输入是否已交付 generator（懒 init 看门狗的起算点） */
  #firstInputDelivered = false;
  /** 挂起审批：permission 卡 id（= canUseTool 的 toolUseID）→ 决定落点们与工具名（SDK 可能按 id 幂等重发，多等待者共用同一决定） */
  readonly #pendingApprovals = new Map<
    string,
    { resolvers: Array<(result: PermissionResult) => void>; toolName: string }
  >();
  /** 已答复的审批 id（二次 approve 视为失效——晚到审批不静默吞、不代答） */
  readonly #answeredApprovals = new Set<string>();
  /** 「一直允许」记名工具（会话内近似——不跨进程持久化，句柄收尾即失效） */
  readonly #alwaysTools = new Set<string>();
  /** 可选日志门面：dispose 超时告警等；缺省时不产生日志 */
  readonly #logger: Logger | undefined;
  /** init 看门狗上限（毫秒）；测试注入缩短等待。 */
  readonly #initTimeoutMs: number;
  /** 协议未确认回调：装配层借此把适配器标灰（进程内内存态）。 */
  readonly #onProtocolFailure: (() => void) | undefined;

  /**
   * @param spec - 会话描述（`cwd` 为子进程工作目录；`initialPrompt` 非空时随首条输入推入）
   * @param emit - 归一化事件出口（同步 void，顺序权威在 `EventBus`）
   * @param resume - 续接线索（存在时经 SDK `options.resume` 续接既有 claude 会话）
   * @param deps.logger - 可选日志门面（缺省时不产生日志）
   * @param deps.initTimeoutMs - init 看门狗上限（缺省 30s；注入点仅为测试可缩短等待）
   * @param deps.onProtocolFailure - 看门狗判定协议未确认时的回调（装配层标灰用；缺省不做）
   */
  constructor(
    spec: SessionSpec,
    emit: Emit,
    resume?: { hint: string },
    deps: {
      logger?: Logger;
      initTimeoutMs?: number;
      onProtocolFailure?: () => void;
      allowDangerouslySkipPermissions?: boolean;
      onRuntimeChanged?: () => void;
    } = {},
  ) {
    this.#spec = spec;
    this.#onRuntimeChanged = deps.onRuntimeChanged;
    this.#allowDangerouslySkipPermissions =
      deps.allowDangerouslySkipPermissions ?? spec.permissionMode === "bypassPermissions";
    this.#emit = emit;
    this.#resumeHint = resume?.hint;
    this.#logger = deps.logger;
    this.#initTimeoutMs = deps.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.#onProtocolFailure = deps.onProtocolFailure;
  }

  /**
   * 建立 SDK 查询并启动消息消费循环。SDK 惰性拉起 CLI 子进程（首个拉取即 spawn）；
   * 进程级失败（可执行缺失等）经消息流异步到达，由消费循环收敛为 notice + failed + exit——
   * 与旧实现的差异：`start()` 本身不再因 spawn 失败同步抛错（创建路径由 `isInstalled` 前置把门）。
   *
   * @returns Promise，resolve 表示查询已建立、消费循环已在跑
   * @throws `claude session disposed`：句柄已 `dispose`（生命周期单向，需重挂请用适配器 `create()` 取新句柄）
   * @throws `claude session already started`：同一句柄重复 start。
   */
  async start(): Promise<void> {
    if (this.#disposed) throw new Error("claude session disposed");
    if (this.#startRequested) throw new Error("claude session already started");
    this.#startRequested = true;
    try {
      // settings 只提供已知限制提示；SDK 仍负责完整策略及模型判断，不据此授予能力。
      const settings = await resolveSettings({ cwd: this.#spec.cwd, settingSources: [] });
      if (settings.effective.permissions?.disableBypassPermissionsMode === "disable") {
        this.#policyDisabledModes.add("bypassPermissions");
        this.#unavailableModes.set("bypassPermissions", "Claude 管理策略禁止完全放行");
      }
      if (settings.effective.disableAutoMode === "disable") {
        this.#policyDisabledModes.add("auto");
        this.#unavailableModes.set("auto", "Claude 管理策略禁止自动判断");
      }
    } catch (err) {
      this.#logger?.warn("permission settings hints unavailable", { error: this.#errText(err) });
    }
    if (this.#disposed) throw new Error("claude session disposed");
    // 测试通过该环境变量让 SDK 使用假 CLI，生产环境继续使用内置 CLI。
    const fakeCli = process.env.AIMI_FAKE_CLI_PATH;
    const q = query({
      prompt: this.#inputStream(),
      options: {
        cwd: this.#spec.cwd,
        ...(this.#spec.model !== undefined && this.#spec.model !== "" ? { model: this.#spec.model } : {}),
        permissionMode: claudePermissionMode(this.#spec.permissionMode),
        allowDangerouslySkipPermissions:
          this.#allowDangerouslySkipPermissions && !this.#unavailableModes.has("bypassPermissions"),
        ...(this.#resumeHint !== undefined && this.#resumeHint !== "" ? { resume: this.#resumeHint } : {}),
        includePartialMessages: true,
        canUseTool: (toolName, input, options) => this.#onCanUseTool(toolName, input, options.toolUseID),
        stderr: (data: string) => {
          // 末段原文保留（ANSI 剥离在收尾时做，避免转义序列被 chunk 边界截断后漏删）。
          this.#stderrTail = (this.#stderrTail + data).slice(-STDERR_TAIL_MAX);
        },
        ...(fakeCli !== undefined && fakeCli !== ""
          ? { pathToClaudeCodeExecutable: fakeCli, executable: "node" as const }
          : {}),
      },
    });
    this.#q = q;
    this.#startedAt = Date.now();
    this.#consumer = this.#consume(q);
    this.#onRuntimeChanged?.();
  }

  /**
   * 下发一条手机指令（已归一化）。
   * - `send`：附件当前不转换（有附件即发 `warn` notice，文本仍照发）；空文本不产生空帧；
   * - `interrupt`：`q.interrupt()`（官方控制请求；CLI ≥2.1.205 附带回执）；
   * - `approve`：resolve 挂起的 canUseTool Promise（once→allow；always→allow+记名；reject→deny）；
   * - `configure`：`q.setModel()/q.setPermissionMode()`，失败发 notice 并抛出，成功由独立状态面确认；
   * - `answer`：提问通道无（FACT5），发占位 notice；
   * - `stop`/`restart`：生命周期指令由 `SessionManager` 直接处置（`commands.ts` 已分流），此处不重复实现。
   *
   * @param cmd - 归一化手机指令
   * @returns Promise，resolve 表示指令已写出或已按占位规则处理
   * @throws 仅修改模型的 SDK 控制请求失败时抛出原始错误
   * 副作用：写输入流/控制请求；附件、审批占位等会先经 `emit` 发 notice
   */
  async send(cmd: AgentCommand): Promise<void> {
    switch (cmd.cmd) {
      case "send": {
        const files = cmd.files ?? [];
        if (files.length > 0) {
          this.#emit({ type: "notice", severity: "warn", text: "附件 M1 接入，已忽略 " + files.length + " 个" });
        }
        if (cmd.text !== "") this.#pushUser(cmd.text);
        return;
      }
      case "interrupt":
        // 服务端事实先行：编排层随后发布 stopped；此处失败只记日志（打断是尽力而为）。
        try {
          await this.#q?.interrupt();
        } catch (err) {
          this.#logger?.warn("interrupt failed", { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      case "approve":
        this.#answerApproval(cmd.requestId, cmd.decision);
        return;
      case "configure":
        await this.#configure(cmd);
        return;
      case "answer":
        // 提问通道无（SPIKE FACT5：headless 无提问面）——维持占位提示，等待态的通用门在编排层。
        this.#emit({ type: "notice", severity: "info", text: "审批/提问交互 M1 接入" });
        return;
      case "stop":
      case "restart":
        return;
    }
  }

  /**
   * 释放会话：`q.close()` 终止 CLI 子进程并清理 SDK 侧资源，随后有界等待消费循环收尾
   * （`exit` 事件在返回前已发布）。挂起审批一律落地为拒绝（CLI 已逝，永无手机决定）。
   *
   * **幂等 + 单向**：未 start 或已退出时直接返回；无论如何**置 `#disposed`**——
   * 句柄此后作废，重挂必须由编排层经适配器 `create()` 取新句柄。
   *
   * @param reason - 仅用于诊断（参数为满足 `AgentSession` 接口契约而保留）
   * @returns Promise，resolve 表示子进程已收尸或已放弃等待
   * 副作用：终止 CLI 子进程、清挂起审批、清算看门狗、置句柄作废
   */
  async dispose(reason?: string): Promise<void> {
    void reason;
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.#q?.close();
    } catch {
      /* close 尽力而为：流已终止时再关不视为错误 */
    }
    this.#clearInitWatchdog();
    for (const pending of this.#pendingApprovals.values()) {
      for (const resolve of pending.resolvers) resolve({ behavior: "deny", message: "会话已收尾" });
    }
    this.#pendingApprovals.clear();
    if (this.#consumer !== undefined) {
      await Promise.race([
        this.#consumer,
        new Promise<void>((resolve) => {
          setTimeout(resolve, DISPOSE_WAIT_MS);
        }),
      ]);
    }
  }

  /**
   * claude 侧会话 id（`system/init` 捕获）——`SessionManager` 建"可续接"会话时的 resume 线索。
   * @returns 已捕获的会话 id；尚未收到 `system/init` 时为 `undefined`。
   */
  getResumeHint(): string | undefined {
    return this.#sessionId;
  }

  /**
   * CLI 实际解析模型（`system/init.model`，如 `claude-opus-5`）——手机显示"当前实测模型"的数据源。
   * @returns 已捕获的模型名；尚未收到 `system/init` 时为 `undefined`。
   */
  getResolvedModel(): string | undefined {
    return this.#resolvedModel;
  }

  /**
   * 被采集运行时事实快照（`AgentSession.runtime` 契约实现）。
   * SDK 不暴露子进程 pid——台账降级为只登记续接线索（孤儿回收兜底靠 resume 语义）。
   * dispose 后线索**保留**——孤儿清点/审计仍需线索，不随收尸蒸发。
   *
   * @returns 续接线索已知时的快照（仅 `resumeHint`）；未知时 `null`
   */
  runtime(): AgentRuntime | null {
    if (this.#sessionId === undefined && this.#permissionMode === undefined) return null;
    return {
      ...(this.#sessionId === undefined ? {} : { resumeHint: this.#sessionId }),
      ...(this.#permissionMode === undefined ? {} : { permissionMode: this.#permissionMode }),
    };
  }

  /** 启动开关和 SDK 拒绝结果收紧静态目录，不为探测自动切换权限。 */
  permissionModes() {
    return CLAUDE_PERMISSION_MODES.map((mode) => {
      const reason =
        mode.id === "bypassPermissions" && !this.#allowDangerouslySkipPermissions
          ? "当前会话启动时未预备完全放行，需要新建会话"
          : this.#unavailableModes.get(mode.id);
      return reason === undefined ? mode : { ...mode, availability: "unavailable" as const, reason };
    });
  }

  /**
   * 句柄活性探针（`AgentSession.isAlive` 契约实现）：消息流已终止或句柄已 dispose 即 `false`。
   * CLI 自终止（回合结束/崩溃）后 stdin 已是死管道，编排层据此把 send 分流到续接路径。
   *
   * @returns true 表示进程仍可交付指令
   */
  isAlive(): boolean {
    return !this.#disposed && !this.#exited;
  }

  /**
   * 受控输入流：初始 prompt 恒为首项（SDK 会在 query 构造期急切拉取首项，队列顺序不可依赖——
   * 结构上保证「初始 prompt 先于 start 前入队指令」），此后按需 yield 队列消息；
   * 首条交付布防懒 init 看门狗（与旧 stdin 写入同口径）。
   */
  async *#inputStream(): AsyncGenerator<SDKUserMessage> {
    const initial = this.#spec.initialPrompt;
    if (initial !== undefined && initial !== "") {
      this.#markFirstDelivered();
      yield {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: initial }] },
        parent_tool_use_id: null,
      };
    }
    for (;;) {
      while (this.#inputQueue.length > 0) {
        const message = this.#inputQueue.shift()!;
        this.#markFirstDelivered();
        yield message;
      }
      await new Promise<void>((resolve) => {
        this.#inputWake = resolve;
      });
    }
  }

  /** 首条输入交付标记：置位并布防懒 init 看门狗（幂等）。 */
  #markFirstDelivered(): void {
    if (this.#firstInputDelivered) return;
    this.#firstInputDelivered = true;
    this.#armInitWatchdog();
  }

  /** 推入一条用户文本（流式输入队列）；句柄已 dispose/退出时静默丢弃（与旧死管道写入口径一致）。 */
  #pushUser(text: string): void {
    if (this.#disposed || this.#exited) return;
    this.#inputQueue.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    });
    this.#inputWake?.();
    this.#inputWake = undefined;
  }

  /**
   * 消费 SDK 消息流：逐消息经 `parseLine` 归一化（SDK 消息即 wire 帧，语义与手搓线协议逐字一致）；
   * 流终止（正常收尾或错误）收敛为 `exit` 事件。
   */
  async #consume(q: Query): Promise<void> {
    try {
      for await (const message of q) {
        if (this.#exited) break;
        this.#onMessage(message);
      }
      this.#onStreamEnd(undefined);
    } catch (err) {
      this.#onStreamEnd(err);
    }
  }

  /** 单条 SDK 消息：归一化并 emit；`system/init` 时捕获续接线索与实测模型、清算看门狗。 */
  #onMessage(message: unknown): void {
    let permissionChanged = false;
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "system" &&
      "subtype" in message &&
      (message.subtype === "init" || message.subtype === "status") &&
      "permissionMode" in message &&
      typeof message.permissionMode === "string" &&
      CLAUDE_PERMISSION_MODES.some((mode) => mode.id === message.permissionMode)
    ) {
      this.#permissionRevision += 1;
      permissionChanged = this.#permissionMode !== message.permissionMode;
      this.#permissionMode = message.permissionMode;
    }
    if (permissionChanged) this.#onRuntimeChanged?.();
    const parsed = parseLine(JSON.stringify(message));
    if (parsed.sessionId !== undefined) {
      this.#sessionId = parsed.sessionId;
      this.#clearInitWatchdog(); // `system/init` 已确认：协议握手成立，看门狗使命结束
    }
    for (const event of parsed.events) this.#emit(event);
    // 实测模型变化才发 configured（回合重发的 init 同值不重复；configure 后下回合新值即达手机）。
    if (parsed.resolvedModel !== undefined && parsed.resolvedModel !== this.#resolvedModel) {
      this.#resolvedModel = parsed.resolvedModel;
      this.#emit({ type: "configured", model: this.#resolvedModel });
    }
  }

  /**
   * 消息流终止收口：清算看门狗、挂起审批全部拒绝、发布 `exit`。
   * 异常终止时错误原因（SDK 错误消息常含退出码与 stderr 摘要）与 stderr 末段合并为
   * `exit.stderrTail`——崩溃原因不再不可知；正常终止不带（SDK 不暴露退出码，`exitCode` 恒 null）。
   */
  #onStreamEnd(err: unknown): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#clearInitWatchdog();
    for (const pending of this.#pendingApprovals.values()) {
      for (const resolve of pending.resolvers) resolve({ behavior: "deny", message: "agent 进程已退出" });
    }
    this.#pendingApprovals.clear();
    const tail = this.#stderrTail.replace(ANSI_PATTERN, "").trim();
    // 正常终止不携带（旧口径：exitCode 0 不带）；异常终止把错误消息（SDK 常内嵌 stderr 原文，
    // 含 ANSI）与本地 stderr 末段合并，整体剥 ANSI 后带出。
    const stderrTail =
      err === undefined
        ? undefined
        : ((err instanceof Error ? err.message : String(err)) + (tail === "" ? "" : "\n" + tail))
            .replace(ANSI_PATTERN, "")
            .slice(0, STDERR_TAIL_MAX);
    this.#emit({
      type: "exit",
      exitCode: null,
      durationMs: Date.now() - this.#startedAt,
      ...(stderrTail !== undefined ? { stderrTail } : {}),
    });
  }

  /**
   * `canUseTool` 回调（审批桥入口）：「一直允许」记名的工具直接放行（附可见性 notice）；
   * 否则向手机发 `permission` 卡 + `waiting_approval`，挂起 Promise 等手机 approve。
   * 事件形状与历史 PermissionRelay 逐字一致（id=toolUseID、detail=input JSON）——手机 UI 零改动。
   */
  #onCanUseTool(toolName: string, input: Record<string, unknown>, toolUseId: string): Promise<PermissionResult> {
    if (this.#alwaysTools.has(toolName)) {
      this.#emit({ type: "notice", severity: "info", text: '已按"一直允许"自动放行 ' + toolName });
      return Promise.resolve({ behavior: "allow" });
    }
    this.#emit({
      type: "permission",
      id: toolUseId,
      title: toolName,
      detail: JSON.stringify(input ?? null),
      options: APPROVAL_OPTIONS,
    });
    this.#emit({ type: "state", state: "waiting_approval" });
    // SDK 文档要求回调按 request_id 幂等：同 id 重发复用同一挂起条目（一次决定唤醒全部等待者），
    // 但 permission 卡只发一次（上方已 emit）。
    let entry = this.#pendingApprovals.get(toolUseId);
    if (entry === undefined) {
      entry = { resolvers: [], toolName };
      this.#pendingApprovals.set(toolUseId, entry);
    }
    return new Promise<PermissionResult>((resolve) => {
      entry!.resolvers.push(resolve);
    });
  }

  /**
   * 回答一条挂起审批：resolve 对应 Promise 并回运行态。
   * - `once` → `{behavior:'allow'}`；
   * - `always` → allow 并把工具名记入会话 allowlist（后续同工具请求自动放行）；
   * - `reject` → `{behavior:'deny', message:'手机端拒绝'}`（软拒——模型继续换路重试）。
   * 请求未知/已答复 → 失效 notice，不代答（晚到审批不静默吞）。
   */
  #answerApproval(requestId: string, decision: "once" | "always" | "reject"): void {
    const entry = this.#pendingApprovals.get(requestId);
    if (entry === undefined) {
      this.#emit({ type: "notice", severity: "warn", text: "审批已失效（请求不存在或已答复）" });
      return;
    }
    this.#pendingApprovals.delete(requestId);
    if (decision === "reject") {
      for (const resolve of entry.resolvers) resolve({ behavior: "deny", message: REJECT_MESSAGE });
    } else {
      for (const resolve of entry.resolvers) resolve({ behavior: "allow" });
      if (decision === "always") this.#alwaysTools.add(entry.toolName);
    }
    // 审批落地回运行态（与旧闸路径一致；CLI 随后继续本回合）。
    this.#emit({ type: "state", state: "running" });
  }

  /**
   * 会话内配置（免重启）：SDK 控制请求 set_model / set_permission_mode，失败时发送 notice。
   * 所有失败向上抛出，避免编排层把未生效字段保存并确认成功；组合请求由编排层逐字段处理。
   * 未启动/已退出时仅提示；下次启动配置的持久化由 SessionManager 负责。
   */
  async #configure(cmd: { model?: string; permissionMode?: SessionSpec["permissionMode"] }): Promise<void> {
    const q = this.#q;
    if (q === undefined || this.#exited) {
      this.#emit({ type: "notice", severity: "warn", text: "会话未运行，配置将在下次启动时生效" });
      return;
    }
    if (cmd.model !== undefined && cmd.model !== "") {
      try {
        await q.setModel(cmd.model);
        // 模型/提供商变化后旧拒绝不再代表新会话条件；管理策略限制仍保留。
        for (const id of this.#unavailableModes.keys()) {
          if (!this.#policyDisabledModes.has(id)) this.#unavailableModes.delete(id);
        }
        // 成功状态由 command.ack 与 welcome/model 投影承载，不污染会话时间线。
      } catch (err) {
        this.#emit({
          type: "notice",
          severity: "error",
          text: `模型切换（${cmd.model}）失败：${friendlyAgentError(this.#errText(err))}`,
        });
        throw err;
      }
    }
    if (cmd.permissionMode !== undefined) {
      const mode = claudePermissionMode(cmd.permissionMode);
      const revision = this.#permissionRevision;
      try {
        await q.setPermissionMode(mode);
        // 控制等待期间可能已收到模型/策略回退；实际状态比请求值更权威。
        if (revision === this.#permissionRevision) this.#permissionMode = cmd.permissionMode;
        this.#unavailableModes.delete(cmd.permissionMode);
      } catch (err) {
        this.#emit({
          type: "notice",
          severity: "error",
          text: `权限档位切换（${cmd.permissionMode}）失败：${friendlyAgentError(this.#errText(err))}`,
        });
        this.#unavailableModes.set(cmd.permissionMode, friendlyAgentError(this.#errText(err)));
        throw err;
      }
    }
  }

  /** 错误文案收敛：截 200 字符防刷屏。 */
  #errText(err: unknown): string {
    const text = err instanceof Error ? err.message : String(err);
    return text.slice(0, 200);
  }

  /**
   * 布 `system/init` 看门狗：首条输入交付 CLI 后起算，`#initTimeoutMs` 内未捕获 init 即按协议未确认处置
   * （notice → failed → 标灰回调 → dispose）。空会话不布防；已捕获 init 或已有计时器时重复调用不延长原 deadline。
   * 副作用：置 watchdog 定时器
   */
  #armInitWatchdog(): void {
    if (this.#disposed || this.#exited || this.#sessionId !== undefined || this.#initTimer !== undefined) return;
    this.#initTimer = setTimeout(() => {
      this.#onInitTimeout();
    }, this.#initTimeoutMs);
  }

  /** 清算看门狗定时器（init 到达/流终止/dispose 三处收口），避免泄漏 deadline handle。 */
  #clearInitWatchdog(): void {
    if (this.#initTimer === undefined) return;
    clearTimeout(this.#initTimer);
    this.#initTimer = undefined;
  }

  /**
   * 看门狗到点：emit `notice{error,"适配器协议未确认"}` → `state:failed`（白名单 starting→failed 合法）
   * → `onProtocolFailure` 回调（装配层借此标灰）→ `void dispose("init watchdog")`（不成对 await：
   * 看门狗是事件驱动收尾，不得让调用方再回等一个 dispose）。
   * 副作用：发两条事件、可能调用回调、引发 dispose
   */
  #onInitTimeout(): void {
    if (this.#exited || this.#disposed) return;
    this.#logger?.error("claude init watchdog fired", { timeoutMs: this.#initTimeoutMs });
    this.#emit({ type: "notice", severity: "error", text: "适配器协议未确认" });
    this.#emit({ type: "state", state: "failed" });
    this.#onProtocolFailure?.();
    void this.dispose("init watchdog").catch(() => {
      /* dispose 终止是尽力而为，失败已由日志承载 */
    });
  }
}
