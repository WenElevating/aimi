import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentCommand, SessionSpec } from "@aimi/protocol";
import type { AdapterContext, AgentRuntime, AgentSession, Emit } from "../types.js";
import type { Logger } from "../../logging/logger.js";
import { parseLine, type ControlResponse } from "./claudeProtocol.js";
import { PermissionRelay } from "./gate/permissionRelay.js";

/**
 * `dispose` 等 `close` 的上限 3 秒：超时即发 WARN + 强杀（SIGKILL/树杀）并**立即返回**，
 * 不再挂起调用方。
 */
const DISPOSE_WAIT_MS = 3000;

/**
 * `system/init` 看门狗上限 30 秒（Task 1 spike 实测校准：首条 user 帧写入后，正常 init 在秒级到达；
 * 30s 仍未确认即判定"适配器协议未确认"，标灰全流程的前端事实落点）。
 * why 常量并命名：协议漂移（CLI 大版本变更致 init 缺失）的唯一可观测面就在这里，
 * 禁止散落魔数延迟阈值。
 */
const INIT_TIMEOUT_MS = 30_000;

/** MCP 闸工具名：`--permission-prompt-tool` 的取值，与 mcp.json 里的服务器名 `aimi_gate` 配对（FACT4）。 */
const GATE_TOOL = "mcp__aimi_gate__request_permission";

/** stderr 末段摘录上限：崩溃原因（参数错误/环境错误）集中在退出前的最后几行，600 字符足够定位。 */
const STDERR_TAIL_MAX = 600;

/** ANSI 转义序列（CLI 彩色输出）：进摘录前剥离，避免日志与手机时间线出现不可读控制符。 */
const ANSI_PATTERN = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[A-Za-z]", "g");

/**
 * gate.mjs 资产的绝对路径：与 claudeSession 同域的 `gate/gate.mjs`，按 `import.meta.url` 就近解析。
 * why 资产而非编译产物：闸是零依赖 stdio MCP（纯 .mjs，不进 TS 编译面），src 直跑与打包部署
 * 都按本文件实际落点寻址（打包步需随行拷贝——与 schema.sql 同类资产，见收尾清单）。
 */
const GATE_SCRIPT = fileURLToPath(new URL("./gate/gate.mjs", import.meta.url));

/**
 * 终止一个进程**树**（Windows 下经 `shell:true` 拉起时，直接子进程是 `cmd.exe`、
 * CLI 本体是孙进程——只杀 shell 会遗弃孙进程）。
 *
 * **永不抛**：pid 缺失/已退出（ESRCH）/权限不足（EPERM）时静默降级——终止是尽力而为，
 * 不该把收尾路径的失败升级成会话流程的异常。Windows 无优雅信号可用，一律 `taskkill /T /F`。
 *
 * @param pid - 目标进程 pid（通常为 spawn 出的直接子进程）；`undefined` 时什么都不做
 * @param signal - 非 Windows 下先发的信号（缺省 `SIGTERM`；强杀时传 `SIGKILL`）
 */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      .on("error", () => { /* taskkill 不可用（罕见）：终止失败不阻塞收尾 */ });
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* 已退出/无权限：尽力而为 */
  }
}

/**
 * claude 启动参数。
 * `--input-format/--output-format stream-json` 让 claude 走双向 NDJSON 流；
 * `--include-partial-messages` 才有 `stream_event` 增量（thinking/text 的流式来源）；
 * `--verbose` 是 `-p` 模式下带增量输出的前置条件。
 *
 * 权限档位映射（SPIKE FACT4——审批闸环路）：
 * - 有闸（permDir 给定）：`default` 显式改 `manual`——default 模式的 auto 安全分类器直接放行
 *   （连 del 都不问），审批闸会被整体绕开；`plan` 显式 `plan`（本就人工把关）。两档都挂
 *   `--permission-prompt-tool mcp__aimi_gate__request_permission` + per-session `--mcp-config`。
 * - 无闸（无 aimi 会话上下文）：维持 M0 形态——只对 `plan` 显式下发（default 是 claude 自身缺省，
 *   手机不可升权）；real CLI 在 manual 且无 prompt tool 时会拒尽工具，缺闸的句柄不得误入此形态。
 *
 * @param spec - 会话描述，取其权限模式
 * @param resumeHint - 续接线索；非空时追加 `--resume`
 * @param permDir - 审批闸请求目录；给定时挂闸参数（mcp.json 由 `start()` 先行落盘）
 * @returns 交给 claude 的命令行参数数组
 */
export function buildArgs(spec: SessionSpec, resumeHint: string | undefined, permDir: string | undefined): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
  ];
  if (spec.model !== undefined && spec.model !== "") args.push("--model", spec.model);
  const permissionMode = spec.permissionMode === "default" ? "manual" : spec.permissionMode;
  if (permDir === undefined) {
    args.push("--permission-mode", permissionMode);
  } else {
    args.push("--permission-mode", permissionMode);
    args.push("--permission-prompt-tool", GATE_TOOL);
    args.push("--mcp-config", join(permDir, "mcp.json"));
  }
  if (resumeHint !== undefined && resumeHint !== "") args.push("--resume", resumeHint);
  return args;
}

/**
 * 构造一条用户消息的 NDJSON 帧（初始 prompt 与后续 `send` 共用同一形状——claude 侧无区别对待）。
 *
 * @param text - 手机发来的纯文本（附件当前不转换）
 * @returns 序列化后的单条 NDJSON 帧文本
 */
function userFrame(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
}

/**
 * claude code 的一条 agent 侧会话：**每会话独立子进程**（不共享进程、不池化）。
 *
 * - 读：stdout 行缓冲后经 `claudeProtocol` 归一化并交给 `emit`；
 * - 写：`send` 与初始 prompt 写 stdin 行；`start()` 之前下发的指令先排队，start 后按序写出；
 * - 续接线索：捕获 `system/init.session_id`（`getResumeHint()` 暴露），不 emit；
 * - 打断：官方 headless 控制帧 `control_request/interrupt`；
 * - 审批：MCP 闸环路（有 aimi 会话上下文时）——spawn 参数挂闸 + relay 轮询请求目录承接、
 *   `approve` 写决定文件；收尾路径停 relay 并清请求目录；
 * - 释放：终止进程树并等 `close`，随后发 `exit` 事件（`dispose` 在 `close` 后返回，保证不留下孤儿）。
 *
 * **stderr 末段摘录随异常退出带出**：stderr 多为 --verbose 噪声、不进事件流（端到端测试会断言
 * 精确事件序），但保留末段原文——异常退出（exitCode≠0）时作为 `exit.stderrTail` 带出，崩溃原因
 * （参数/环境错误在 init 之前就退）不再不可知；正常退出不带。监听排空管道防写满卡死的职责不变。
 *
 * **生命周期单向**：`dispose()` 之后句柄作废——`start()` 抛
 * `claude session disposed`。防止"dispose 竞态后又拉起子进程"产生无人持有的不可杀孤儿；
 * 需要重新拉起时由 `SessionManager` 走适配器 `create()` 拿**新句柄**，绝不复用旧句柄。
 *
 * **已知噪声（Node 24）**：`shell:true` + args 数组会触发 `DEP0190` 弃用告警——当前只能采用这种
 * spawn 形态（Windows `.cmd` 垫片解析所必需），改用整串命令需自造引号规则，暂不处理；
 * 参数全部来自受控常量（`buildArgs`）与 claude 会话 id，无手机输入拼接。
 *
 * 不做 `protocolVersion` 协商、不做 `canUseTool` 审批回落（审批走 MCP 闸环路）、不做附件转换。
 */
export class ClaudeSession implements AgentSession {
  readonly #spec: SessionSpec;
  readonly #emit: Emit;
  readonly #resumeHint: string | undefined;
  /** 子进程；`start()` 前为 `undefined`（此间下发的指令进入 `#stdinQueue`） */
  #child: ChildProcessWithoutNullStreams | undefined;
  /** stdout 行缓冲残段（跨 chunk 拼接；`close` 时冲刷，保证末行不丢）。 */
  #stdoutTail = "";
  /** start 前下发的 stdin 帧（保持调用顺序——手机可能在会话就绪窗口内抢发打断） */
  readonly #stdinQueue: string[] = [];
  /** start 前是否已有 user 帧排队；真正写入子进程后才开始 init 看门狗。 */
  #userFrameQueued = false;
  /** `system/init` 捕获的 claude 侧会话 id（resume 线索） */
  #sessionId: string | undefined;
  /** 子进程拉起时刻（`exit.durationMs` 基准）。 */
  #startedAt = 0;
  /** `close` 是否已处理（防 'error' 与 'close' 双触发重复 emit exit）。 */
  #exited = false;
  /** 是否已 dispose（生命周期单向：置位后 `start()` 一律拒绝）。 */
  #disposed = false;
  /** 可选日志门面：dispose 超时告警等；缺省时不产生日志 */
  readonly #logger: Logger | undefined;
  /** init 看门狗上限（毫秒）；测试注入缩短等待。 */
  readonly #initTimeoutMs: number;
  /** 协议未确认回调：装配层借此把适配器标灰（进程内内存态）。 */
  readonly #onProtocolFailure: (() => void) | undefined;
  /** init 看门狗定时器（`system/init` 到达 / close / dispose 时清算）。 */
  #initTimer: ReturnType<typeof setTimeout> | undefined;
  /** `close` 后兑现（`dispose` 等它——保证返回时进程已收尸） */
  readonly #closed: Promise<void>;
  #closeResolve: (() => void) | undefined;
  /** 审批闸请求目录（确定性：`<dataDir>/perms/<aimiSessionId>/`）；无上下文为 `undefined` */
  readonly #permDir: string | undefined;
  /** 审批闸后端（`start()` 布防 watch、收尾路径 stop）；无上下文为 `undefined` */
  #relay: PermissionRelay | undefined;
  /** stderr 末段环形摘录（异常退出时随 `exit` 事件带出——崩溃原因唯一观测面）；正常退出为空串 */
  #stderrTail = "";
  /** 在途控制请求：request_id → 结果提示文案（control_response 到达时据此发 notice） */
  readonly #pendingControls = new Map<string, string>();
  /** 控制请求自增序号（request_id 组成部分，保证会话内唯一） */
  #controlSeq = 0;

  /**
   * @param spec - 会话描述（`cwd` 为子进程工作目录；`initialPrompt` 非空时在 `start()` 写入 stdin）
   * @param emit - 归一化事件出口（同步 void，顺序权威在 `EventBus`）
   * @param resume - 续接线索（存在时追加 `--resume <hint>`）
   * @param deps.logger - 可选日志门面（缺省时不产生日志）
   * @param deps.initTimeoutMs - init 看门狗上限（缺省 30s；注入点仅为测试可缩短等待）
   * @param deps.onProtocolFailure - 看门狗判定协议未确认时的回调（装配层标灰用；缺省不做）
   * @param deps.context - aimi 会话上下文（缺省无闸——审批/打断的闸参数与目录清理全部关闭）
   */
  constructor(
    spec: SessionSpec,
    emit: Emit,
    resume?: { hint: string },
    deps: { logger?: Logger; initTimeoutMs?: number; onProtocolFailure?: () => void; context?: AdapterContext } = {},
  ) {
    this.#spec = spec;
    this.#emit = emit;
    this.#resumeHint = resume?.hint;
    this.#logger = deps.logger;
    this.#initTimeoutMs = deps.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.#onProtocolFailure = deps.onProtocolFailure;
    this.#permDir = deps.context === undefined
      ? undefined
      : join(deps.context.dataDir, "perms", deps.context.sessionId);
    this.#closed = new Promise<void>((resolve) => { this.#closeResolve = resolve; });
  }

  /**
   * 拉起子进程并开始读流。`spawn` 成功（进程确实启动）即 resolve；
   * 进程级错误（如无权限执行）直接 reject（命令不存在不属此类——Windows `shell:true` 下由 shell 兜底成非零退出）。
   *
   * @returns Promise，resolve 表示子进程已启动并接管读流
   * @throws `claude session disposed`：句柄已 `dispose`（生命周期单向，需重挂请用适配器 `create()` 取新句柄）
   * @throws 子进程 `error` 事件携带的原始错误。
   * @throws `claude session already started`：同一句柄重复 start。
   */
  async start(): Promise<void> {
    if (this.#disposed) throw new Error("claude session disposed");
    if (this.#child !== undefined) throw new Error("claude session already started");
    // 闸配置先行（spawn 前落盘）：mcp.json 引用的闸进程由 CLI 拉起，文件必须在 CLI 读到它之前就位；
    // relay 的 watch 也先于 spawn——闸请求文件可能在首轮输出前到达。
    if (this.#permDir !== undefined) {
      this.#writeGateConfig();
      this.#relay = new PermissionRelay({ dir: this.#permDir });
      this.#relay.watch(this.#emit);
    }
    const child = spawn("claude", buildArgs(this.#spec, this.#resumeHint, this.#permDir), {
      cwd: this.#spec.cwd,
      shell: process.platform === "win32", // 生产同构：Windows 需 shell 才能解析 `claude.cmd` 垫片
      windowsHide: true, // 不闪控制台窗口（Windows 下 shell 垫片会弹黑框）
      // 闸目录经环境变量随行（假 CLI 的闸环路据此拿到真实 permDir——真 CLI 不认识该变量、零影响；
      // 这是唯一能让 e2e 免预知 aimi sessionId 就接上闸环路的 seam）。
      env: this.#permDir === undefined ? undefined : { ...process.env, AIMI_FAKE_PERM_DIR: this.#permDir },
    });
    this.#child = child;
    this.#startedAt = Date.now();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { this.#onStdout(chunk); });
    // stderr 刻意不落地为事件（多为 --verbose 噪声），但保留末段原文：进程异常退出时
    // 它常是唯一的崩溃原因（参数/环境错误在 CLI 打出 init 之前就退出）；ANSI 剥离在收尾时做，
    // 避免转义序列被 chunk 边界截断后漏删。
    child.stderr.on("data", (chunk: string) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_TAIL_MAX);
    });
    child.stdin.on("error", () => { /* 子进程异常早退时写入会 EPIPE/ERR_STREAM_DESTROYED——吞掉，
      会话失败由随后的 exit 事件表达；不接的话流级 'error' 会升级成进程级未捕获异常 */ });
    child.on("close", (code) => { this.#onClose(code); });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => { resolve(); });
      child.once("error", (err) => { reject(err); });
    });

    const prompt = this.#spec.initialPrompt;
    if (prompt !== undefined && prompt !== "") this.#writeFrame(userFrame(prompt), true);
    this.#flushQueue();
  }

  /**
   * 写 per-session 闸配置（幂等照写）：mcp.json 把 `aimi_gate` 指向 gate.mjs（绝对路径）+ 请求目录。
   * 同 permDir 的上一条句柄残留文件被覆盖（内容恒同——重挂零漂移）；e2e 的假 CLI 不经此路
   * （走 `AIMI_FAKE_PERM_DIR` 环境变量），照写无副作用。
   * 副作用：mkdir -p 请求目录、写 mcp.json
   */
  #writeGateConfig(): void {
    const permDir = this.#permDir!;
    mkdirSync(permDir, { recursive: true });
    writeFileSync(join(permDir, "mcp.json"), JSON.stringify({
      mcpServers: { aimi_gate: { command: "node", args: [GATE_SCRIPT, permDir] } },
    }));
  }

  /**
   * 闸收尾（dispose 与进程 close 两条路共用，幂等）：停 relay 轮询 + 整目录删除（尽力而为）。
   * why 在 `exit` 事件发布**之前**清目录：续接路径（send 即续接）会用同一 permDir 拉起新句柄，
   * 新句柄的 `start()` 依赖旧目录已净——残留的请求/决定文件会让下轮误吃旧决定（评审重点 9）。
   * 副作用：停轮询定时器、rm -rf 请求目录（不存在/被占用时静默）
   */
  #teardownGate(): void {
    this.#relay?.stop();
    this.#relay = undefined;
    if (this.#permDir !== undefined) PermissionRelay.cleanup(this.#permDir);
  }

  /**
   * 布 `system/init` 看门狗：首条 user 帧写入后起算，`#initTimeoutMs` 内未捕获 init 即按协议未确认处置
   * （notice → failed → 标灰回调 → dispose——SPIKE FACT1 之"协议握手在秒级"的反面即故障判定）。
   * 空会话不布防；已经捕获 init 或已有计时器时重复调用不延长原 deadline。
   * 副作用：置 watchdog 定时器
   */
  #armInitWatchdog(): void {
    if (this.#disposed || this.#exited || this.#sessionId !== undefined || this.#initTimer !== undefined) return;
    this.#initTimer = setTimeout(() => { this.#onInitTimeout(); }, this.#initTimeoutMs);
  }

  /** 清算看门狗定时器（init 到达/close/dispose 三处收口），避免泄漏 deadline handle。 */
  #clearInitWatchdog(): void {
    if (this.#initTimer === undefined) return;
    clearTimeout(this.#initTimer);
    this.#initTimer = undefined;
  }

  /**
   * 看门狗到点：emit `notice{error,"适配器协议未确认"}` → `state:failed`（白名单 starting→failed 合法）
   * → `onProtocolFailure` 回调（装配层借此标灰）→ `void dispose("init watchdog")`（不成对 await：
   * 看门狗是事件驱动收尾，不得让 start() 的调用方再回ящий等一个 dispose）。
   * 副作用：发两条事件、可能调用回调、引发 dispose；该回调一次性（#exited/#disposed 已收口）
   */
  #onInitTimeout(): void {
    if (this.#exited || this.#disposed) return;
    this.#logger?.error("claude init watchdog fired", { pid: this.#child?.pid, timeoutMs: this.#initTimeoutMs });
    this.#emit({ type: "notice", severity: "error", text: "适配器协议未确认" });
    this.#emit({ type: "state", state: "failed" });
    this.#onProtocolFailure?.();
    void this.dispose("init watchdog").catch(() => { /* dispose 终止是尽力而为，失败已由日志承载 */ });
  }

  /**
   * 下发一条手机指令（已归一化）。
   * - `send`：附件当前不转换（有附件即发 `warn` notice，文本仍照发）；空文本不产生空帧；
   * - `interrupt`：写官方控制帧 `control_request/interrupt`；
   * - `approve`：写审批闸决定文件（relay 承接；请求未知/已答复即发失效提示，不写文件）；
   * - `answer`：提问通道无（FACT5），发占位 notice；
   * - `configure`：写 `control_request/set_model` 与 `set_permission_mode`（会话内生效，免重启）；
   * - `stop`/`restart`：生命周期指令由 `SessionManager` 直接处置（`commands.ts` 已分流），此处不重复实现。
   *
   * @param cmd - 归一化手机指令
   * @returns Promise，resolve 表示指令已写出（或已按占位规则处理，不 reject）
   * 副作用：写 stdin；附件、审批占位等会先经 `emit` 发 notice
   */
  async send(cmd: AgentCommand): Promise<void> {
    switch (cmd.cmd) {
      case "send": {
        const files = cmd.files ?? [];
        if (files.length > 0) {
          this.#emit({ type: "notice", severity: "warn", text: "附件 M1 接入，已忽略 " + files.length + " 个" });
        }
        if (cmd.text !== "") this.#writeFrame(userFrame(cmd.text), true);
        return;
      }
      case "interrupt":
        this.#writeFrame(JSON.stringify({
          type: "control_request",
          request_id: randomUUID(),
          request: { subtype: "interrupt" },
        }));
        return;
      case "approve": {
        // 审批闸环路（Task 7）：决定经 relay 写决定文件（闸进程读走回灌 CLI），成功后状态回运行态
        // （waiting→running 白名单内；CLI 若自发 running 由编排层同状态去重兜住）。
        // 请求未知/已答复/目录已清 → 失效提示，**不写文件**（晚到审批不静默吞、不代答）。
        const answered = this.#relay?.answer(cmd.requestId, cmd.decision) ?? false;
        if (!answered) {
          this.#emit({ type: "notice", severity: "warn", text: "审批已失效（请求不存在或已答复）" });
          return;
        }
        this.#emit({ type: "state", state: "running" });
        return;
      }
      case "answer":
        // 提问通道无（SPIKE FACT5：headless 无提问面）——维持占位提示，等待态的通用门在编排层。
        this.#emit({ type: "notice", severity: "info", text: "审批/提问交互 M1 接入" });
        return;
      case "configure": {
        // 会话内配置（免重启）：CLI 的 stream-json 控制请求原生支持 set_model / set_permission_mode
        // （实测 2.1.303 均回 control_response success），模型切换不再重启子进程——重启路径会把
        // 配置动作伪装成"agent 运行失败"，且秒挂类故障直接呈现在用户时间线上。
        if (this.#child === undefined || this.#exited) {
          this.#emit({ type: "notice", severity: "warn", text: "会话未运行，配置将在下次启动时生效" });
          return;
        }
        if (cmd.model !== undefined && cmd.model !== "") {
          this.#writeControlRequest({ subtype: "set_model", model: cmd.model }, `模型切换（${cmd.model}）`);
        }
        if (cmd.permissionMode !== undefined) {
          // 与 buildArgs 同一映射：default 档显式 manual——default 的 auto 安全分类器会绕开审批闸。
          const mode = cmd.permissionMode === "default" ? "manual" : cmd.permissionMode;
          this.#writeControlRequest({ subtype: "set_permission_mode", mode }, `权限档位切换（${cmd.permissionMode}）`);
        }
        return;
      }
      case "stop":
      case "restart":
        return;
    }
  }

  /**
   * 写一条 `control_request` 并登记在途应答；`control_response` 到达时按成败发 notice。
   * @param request - 请求负载（subtype 与参数，不含信封）
   * @param label - 结果提示用的动作名（如「模型切换（sonnet）」）
   */
  #writeControlRequest(request: Record<string, unknown>, label: string): void {
    const requestId = randomUUID();
    this.#pendingControls.set(requestId, label);
    this.#writeFrame(JSON.stringify({ type: "control_request", request_id: requestId, request }));
  }

  /**
   * 处理 `control_response`：按登记的动作名发成败 notice。未登记的 request_id 静默丢弃——
   * 实测 CLI 会对同一应答多次重发，删除式消费天然去重。
   */
  #onControlResponse(response: ControlResponse): void {
    const label = this.#pendingControls.get(response.requestId);
    if (label === undefined) return;
    this.#pendingControls.delete(response.requestId);
    if (response.success) {
      this.#emit({ type: "notice", severity: "info", text: `${label}已生效` });
      return;
    }
    this.#emit({ type: "notice", severity: "error", text: `${label}失败：${response.errorMessage ?? "CLI 未说明原因"}` });
  }

  /**
   * 释放会话：终止子进程树（含 `shell:true` 拉起的孙进程）并等 `close` 后返回。
   *
   * **幂等 + 单向**：未 start 或已退出时直接返回；无论如何**置 `#disposed`**——
   * 句柄此后作废（`start()` 抛 `claude session disposed`），重挂必须由编排层经适配器 `create()` 取新句柄。
   * **有界等待**：等 `close` 上限 3s；超时记 WARN + 强杀（`SIGKILL`/树杀）
   * 后立即返回，绝不把调用方（`SessionManager.stop`）永久挂起。
   *
   * @param reason - 仅用于诊断（参数为满足 `AgentSession` 接口契约而保留）
   * @returns Promise，resolve 表示子进程已收尸或已放弃等待
   * 副作用：终止子进程树、置句柄作废（此后 `start` 一律拒绝）
   */
  async dispose(reason?: string): Promise<void> {
    void reason;
    if (this.#disposed) return;
    try {
      const child = this.#child;
      if (child === undefined || this.#exited) return;
      killTree(child.pid); // 先礼（SIGTERM / Windows 树杀）
      if (await this.#waitClosed(DISPOSE_WAIT_MS)) {
        this.#logger?.warn("claude session dispose timeout——强杀并不再等待 close", {
          pid: child.pid,
          timeoutMs: DISPOSE_WAIT_MS,
        });
        killTree(child.pid, "SIGKILL"); // 后兵（Windows 忽略信号参数，仍是树杀）
      }
    } finally {
      this.#disposed = true;
      this.#child = undefined;
      this.#teardownGate(); // 句柄作废即闸收尾（relay 停轮询 + 目录清理），杜绝悬挂的审批卡
      this.#clearInitWatchdog(); // 句柄作废即清算看门狗，防止 dispose 后仍触发协议失效路径
      this.#pendingControls.clear(); // 句柄作废后在途控制请求永无应答，清账防泄漏
    }
  }

  /**
   * 等 `#closed`，上限 `ms`。
   *
   * @param ms - 等待上限（毫秒）
   * @returns Promise，resolve 为 true 表示超时、false 表示已 `close`；**不抛**，定时器两条路径都清理
   */
  #waitClosed(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { resolve(true); }, ms);
      this.#closed.then(() => { clearTimeout(timer); resolve(false); });
    });
  }

  /**
   * claude 侧会话 id（`system/init` 捕获）——`SessionManager` 建"可续接"会话时的 resume 线索。
   * @returns 已捕获的会话 id；尚未收到 `system/init` 时为 `undefined`。
   */
  getResumeHint(): string | undefined {
    return this.#sessionId;
  }

  /**
   * 被采集运行时事实快照（`AgentSession.runtime` 契约实现）：
   * pid 取 `#child?.pid`（spawn 后才知），续接线索取 `#sessionId`（`system/init` 后才有）。
   * why 收敛 null：编排层据此整段跳过采集（"未知"与"可采集空快照"是两种语义）。
   * dispose 后 pid 消失但**已捕获的 hint 保留**——孤儿清点/审计仍需线索，不随收尸蒸发。
   *
   * @returns pid/hint 任一已知时的快照；两者皆未知时返回 `null`
   */
  runtime(): AgentRuntime | null {
    const pid = this.#child?.pid;
    const resumeHint = this.#sessionId;
    if (pid === undefined && resumeHint === undefined) return null;
    return { pid, resumeHint };
  }

  /**
   * 句柄活性探针（`AgentSession.isAlive` 契约实现）：进程已退出即 `false`。
   * `#exited` 在 close/error 收口处置位——dispose 前进程自终止（CLI 回合结束自退/崩溃）
   * 的窗口里句柄仍在，但 stdin 已是死管道，编排层据此把 send 分流到续接路径。
   *
   * @returns true 表示进程仍可交付指令
   */
  isAlive(): boolean {
    return !this.#exited;
  }

  /** 把 stdout 分片并入行缓冲（残段留待下一片拼接，末行在 `close` 时冲刷）。 */
  #onStdout(chunk: string): void {
    this.#stdoutTail += chunk;
    const lines = this.#stdoutTail.split("\n");
    this.#stdoutTail = lines.pop() ?? "";
    for (const line of lines) this.#handleLine(line);
  }

  /** 处理一整行：剥离 CRLF 的 `\r`，归一化后捕获续接线索并逐事件 emit（空白行静默）。 */
  #handleLine(line: string): void {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed === "") return;
    const parsed = parseLine(trimmed);
    if (parsed.sessionId !== undefined) {
      this.#sessionId = parsed.sessionId;
      this.#clearInitWatchdog(); // `system/init` 已确认：协议握手成立，看门狗使命结束
    }
    if (parsed.controlResponse !== undefined) this.#onControlResponse(parsed.controlResponse);
    for (const event of parsed.events) this.#emit(event);
  }

  /** 进程收尾：冲刷残行、闸收尾（先于 exit 事件——续接路依赖旧目录已净）、发 `exit` 事件并兑现 `#closed`。 */
  #onClose(code: number | null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#clearInitWatchdog(); // 进程比 init 先逝：看门狗不会再有信息量，释放 handle
    if (this.#stdoutTail !== "") {
      const tail = this.#stdoutTail;
      this.#stdoutTail = "";
      this.#handleLine(tail);
    }
    this.#teardownGate(); // 自终止（崩溃/被打断后退出）同样清闸目录：挂起请求不得泄漏给续接轮
    this.#pendingControls.clear(); // 进程已逝：在途控制请求永无应答，清账防泄漏
    // 异常退出时 stderr 末段是崩溃原因的唯一观测面，随事件带出（正常退出/干净收尾不带）。
    const tail = this.#stderrTail.replace(ANSI_PATTERN, "").trim();
    const stderrTail = (code ?? 1) !== 0 && tail !== "" ? tail.slice(-STDERR_TAIL_MAX) : undefined;
    this.#stderrTail = "";
    this.#emit({
      type: "exit",
      exitCode: code,
      durationMs: Date.now() - this.#startedAt,
      ...(stderrTail !== undefined ? { stderrTail } : {}),
    });
    this.#stdinQueue.length = 0;
    this.#closeResolve?.();
  }

  /** 写一帧 NDJSON；子进程未起时入队（`start()` 后按序冲刷）。 */
  #writeFrame(frame: string, startsProtocol = false): void {
    const line = frame + "\n";
    if (this.#child === undefined) {
      this.#stdinQueue.push(line);
      if (startsProtocol) this.#userFrameQueued = true;
      return;
    }
    if (this.#exited) return;
    this.#child.stdin.write(line);
    if (startsProtocol) this.#armInitWatchdog();
  }

  /** 冲刷 start 前排队的帧（在初始 prompt 之后——初始 prompt 是会话的第一条输入）。 */
  #flushQueue(): void {
    const queued = this.#stdinQueue.splice(0);
    for (const line of queued) this.#child?.stdin.write(line);
    if (this.#userFrameQueued) {
      this.#userFrameQueued = false;
      this.#armInitWatchdog();
    }
  }
}
