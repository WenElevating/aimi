import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentCommand, SessionSpec } from "@aimi/protocol";
import type { AgentSession, Emit } from "../types.js";
import type { Logger } from "../../logging/logger.js";
import { parseLine } from "./claudeProtocol.js";

/**
 * `dispose` 等 `close` 的上限（**评审裁决 3s**，取代简报原 5s 升级窗口）：
 * 超时即发 WARN + 强杀（SIGKILL/树杀）并**立即返回**，不再挂起调用方。
 */
const DISPOSE_WAIT_MS = 3000;

/**
 * 终止一个进程**树**（Windows 下经 `shell:true` 拉起时，直接子进程是 `cmd.exe`、
 * CLI 本体是孙进程——只杀 shell 会遗弃孙进程）。
 *
 * **永不抛**：pid 缺失/已退出（ESRCH）/权限不足（EPERM）时静默降级——终止是尽力而为，
 * 不该把收尾路径的失败升级成会话流程的异常。Windows 无优雅信号可用，一律 `taskkill /T /F`。
 * @param pid 目标进程 pid（通常为 spawn 出的直接子进程）。
 * @param signal 非 Windows 下先发的信号（缺省 `SIGTERM`；强杀时传 `SIGKILL`）。
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
 * claude 启动参数（M0 冻结）。
 * `--input-format/--output-format stream-json` 让 claude 走双向 NDJSON 流；
 * `--include-partial-messages` 才有 `stream_event` 增量（thinking/text 的流式来源）；
 * `--verbose` 是 `-p` 模式下带增量输出的前置条件。
 * `--permission-mode` 只对 `plan` 显式下发（`default` 是 claude 自身缺省——C3 手机不可升权）。
 */
function buildArgs(spec: SessionSpec, resumeHint: string | undefined): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
  ];
  if (spec.permissionMode === "plan") args.push("--permission-mode", "plan");
  if (resumeHint !== undefined && resumeHint !== "") args.push("--resume", resumeHint);
  return args;
}

/**
 * 一条用户消息的 wire 帧（初始 prompt 与后续 `send` 共用同一形状——claude 侧无区别对待）。
 * @param text 手机发来的纯文本（附件 M0 不转换，见 `ClaudeSession.send`）。
 */
function userFrame(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
}

/**
 * claude code 的一条 agent 侧会话：**每会话独立子进程**（M0 不共享进程、不池化）。
 *
 * - 读：stdout 行缓冲 → `claudeProtocol` 归一化 → `emit`；
 * - 写：stdin 行写（`send`/初始 prompt）；`start()` 之前下发的指令排队，start 后按序落盘；
 * - 续接线索：捕获 `system/init.session_id`（`getResumeHint()`，M1 由 `SessionManager` 取用），不 emit；
 * - 打断：官方 headless 控制帧 `control_request/interrupt`；
 * - 释放：终止进程树 → 等 `close` → 发 `exit` 事件（`dispose` 在 `close` 后返回，保证不留下孤儿）。
 *
 * **stderr 刻意不落地**：M0 事件流取值域面向手机（T11 e2e 会断言精确事件序），
 * stderr 多为 --verbose 噪声；但必须挂监听排空管道，否则子进程写满 stderr 缓冲会卡死。
 *
 * **生命周期单向（评审 Fix 1）**：`dispose()` 之后句柄作废——`start()` 抛
 * `claude session disposed`。防止"dispose 竞态后又拉起子进程"产生无人持有的不可杀孤儿；
 * 需要重新拉起时由 `SessionManager` 走适配器 `create()` 拿**新句柄**，绝不复用旧句柄。
 *
 * **已知噪声（Node 24）**：`shell:true` + args 数组会触发 `DEP0190` 弃用告警——这是简报冻结的
 * spawn 形态（Windows `.cmd` 垫片解析所必需），改用整串命令需自造引号规则，M0 不做；
 * 参数全部来自受控常量（`buildArgs`）与 claude 会话 id，无手机输入拼接。
 *
 * YAGNI 边界（M1）：不做 `protocolVersion` 协商、不做 `canUseTool` 审批回落、不做附件转换。
 */
export class ClaudeSession implements AgentSession {
  readonly #spec: SessionSpec;
  readonly #emit: Emit;
  readonly #resumeHint: string | undefined;
  /** 子进程；`start()` 前为 `undefined`（此间下发的指令进入 `#stdinQueue`）。 */
  #child: ChildProcessWithoutNullStreams | undefined;
  /** stdout 行缓冲残段（跨 chunk 拼接；`close` 时冲刷，保证末行不丢）。 */
  #stdoutTail = "";
  /** start 前下发的 stdin 帧（保持调用顺序——手机可能在会话就绪窗口内抢发打断）。 */
  readonly #stdinQueue: string[] = [];
  /** `system/init` 捕获的 claude 侧会话 id（resume 线索）。 */
  #sessionId: string | undefined;
  /** 子进程拉起时刻（`exit.durationMs` 基准）。 */
  #startedAt = 0;
  /** `close` 是否已处理（防 'error' 与 'close' 双触发重复 emit exit）。 */
  #exited = false;
  /** 是否已 dispose（生命周期单向：置位后 `start()` 一律拒绝）。 */
  #disposed = false;
  /** 可选日志门面（§13）：dispose 超时告警等；缺省时不产生日志。 */
  readonly #logger: Logger | undefined;
  /** `close` 后兑现（`dispose` 等它——保证返回时进程已收尸）。 */
  readonly #closed: Promise<void>;
  #closeResolve: (() => void) | undefined;

  /**
   * @param spec 会话描述（`cwd` 为子进程工作目录；`initialPrompt` 非空时在 `start()` 写入 stdin）。
   * @param emit 归一化事件出口（同步 void，顺序权威在 `EventBus`）。
   * @param resume 续接线索（存在时追加 `--resume <hint>`）。
   * @param deps.logger 可选日志门面（缺省时不产生日志）。
   */
  constructor(spec: SessionSpec, emit: Emit, resume?: { hint: string }, deps: { logger?: Logger } = {}) {
    this.#spec = spec;
    this.#emit = emit;
    this.#resumeHint = resume?.hint;
    this.#logger = deps.logger;
    this.#closed = new Promise<void>((resolve) => { this.#closeResolve = resolve; });
  }

  /**
   * 拉起子进程并开始读流。`spawn` 成功（进程确实启动）即 resolve；
   * 进程级错误（如无权限执行）直接 reject（命令不存在不属此类——Windows `shell:true` 下由 shell 兜底成非零退出）。
   * @throws `claude session disposed`：句柄已 `dispose`（生命周期单向，需重挂请用适配器 `create()` 取新句柄）。
   * @throws 子进程 `error` 事件携带的原始错误。
   * @throws `claude session already started`：同一句柄重复 start。
   */
  async start(): Promise<void> {
    if (this.#disposed) throw new Error("claude session disposed");
    if (this.#child !== undefined) throw new Error("claude session already started");
    const child = spawn("claude", buildArgs(this.#spec, this.#resumeHint), {
      cwd: this.#spec.cwd,
      shell: process.platform === "win32", // 生产同构：Windows 需 shell 才能解析 `claude.cmd` 垫片
      windowsHide: true, // 不闪控制台窗口（Windows 下 shell 垫片会弹黑框）
    });
    this.#child = child;
    this.#startedAt = Date.now();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { this.#onStdout(chunk); });
    child.stderr.on("data", () => { /* 排空防背压；M0 不落地（见类 TSDoc） */ });
    child.stdin.on("error", () => { /* 子进程异常早退时写入会 EPIPE/ERR_STREAM_DESTROYED——吞掉，
      会话失败由随后的 exit 事件表达；不接的话流级 'error' 会升级成进程级未捕获异常 */ });
    child.on("close", (code) => { this.#onClose(code); });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => { resolve(); });
      child.once("error", (err) => { reject(err); });
    });

    const prompt = this.#spec.initialPrompt;
    if (prompt !== undefined && prompt !== "") this.#writeFrame(userFrame(prompt));
    this.#flushQueue();
  }

  /**
   * 下发一条手机指令（已归一化）。
   * - `send`：附件 M0 不转换（有附件即发 `warn` notice，文本仍照发）；空文本不产生空帧；
   * - `interrupt`：写官方控制帧 `control_request/interrupt`；
   * - `approve`/`answer`：M1 接入前只发 `info` notice 占位（不改 claude 侧状态）；
   * - `stop`/`restart`：生命周期指令由 `SessionManager` 直接处置（`commands.ts` 已分流），此处不重复实现。
   * @param cmd 归一化手机指令。
   */
  async send(cmd: AgentCommand): Promise<void> {
    switch (cmd.cmd) {
      case "send": {
        const files = cmd.files ?? [];
        if (files.length > 0) {
          this.#emit({ type: "notice", severity: "warn", text: "附件 M1 接入，已忽略 " + files.length + " 个" });
        }
        if (cmd.text !== "") this.#writeFrame(userFrame(cmd.text));
        return;
      }
      case "interrupt":
        this.#writeFrame(JSON.stringify({
          type: "control_request",
          request_id: randomUUID(),
          request: { subtype: "interrupt" },
        }));
        return;
      case "approve":
      case "answer":
        this.#emit({ type: "notice", severity: "info", text: "审批/提问交互 M1 接入" });
        return;
      case "stop":
      case "restart":
        return;
    }
  }

  /**
   * 释放会话：终止子进程树（含 `shell:true` 拉起的孙进程）→ 等 `close` → 返回。
   *
   * **幂等 + 单向**：未 start 或已退出时直接返回；无论如何**置 `#disposed`**——
   * 句柄此后作废（`start()` 抛 `claude session disposed`），重挂必须由编排层经适配器 `create()` 取新句柄。
   * **有界等待（评审 Fix 3/随行 Minor）**：等 `close` 上限 3s；超时记 WARN + 强杀（`SIGKILL`/树杀）
   * 后立即返回，绝不把调用方（`SessionManager.stop`）永久挂起。
   * @param reason 仅用于诊断（保留参数以对齐 `AgentSession` 契约）。
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
    }
  }

  /**
   * 等 `#closed`，上限 `ms`。
   * @param ms 等待上限（毫秒）。
   * @returns 超时（`true`）或已 `close`（`false`）——**不抛**，定时器两条路径都清理。
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

  /** stdout 分片 → 行缓冲（残段留待下一片拼接，末行在 `close` 时冲刷）。 */
  #onStdout(chunk: string): void {
    this.#stdoutTail += chunk;
    const lines = this.#stdoutTail.split("\n");
    this.#stdoutTail = lines.pop() ?? "";
    for (const line of lines) this.#handleLine(line);
  }

  /** 单行：剥 `\r`（CRLF）→ 归一化 → 捕获续接线索 → 逐事件 emit（空白行静默）。 */
  #handleLine(line: string): void {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed === "") return;
    const parsed = parseLine(trimmed);
    if (parsed.sessionId !== undefined) this.#sessionId = parsed.sessionId;
    for (const event of parsed.events) this.#emit(event);
  }

  /** 进程收尾：冲刷残行 → 发 `exit`（`durationMs` 自 start 起算）→ 兑现 `#closed`。 */
  #onClose(code: number | null): void {
    if (this.#exited) return;
    this.#exited = true;
    if (this.#stdoutTail !== "") {
      const tail = this.#stdoutTail;
      this.#stdoutTail = "";
      this.#handleLine(tail);
    }
    this.#emit({ type: "exit", exitCode: code, durationMs: Date.now() - this.#startedAt });
    this.#stdinQueue.length = 0;
    this.#closeResolve?.();
  }

  /** 写一帧 NDJSON；子进程未起时入队（`start()` 后按序冲刷）。 */
  #writeFrame(frame: string): void {
    const line = frame + "\n";
    if (this.#child === undefined) {
      this.#stdinQueue.push(line);
      return;
    }
    if (this.#exited) return;
    this.#child.stdin.write(line);
  }

  /** 冲刷 start 前排队的帧（在初始 prompt 之后——初始 prompt 是会话的第一条输入）。 */
  #flushQueue(): void {
    const queued = this.#stdinQueue.splice(0);
    for (const line of queued) this.#child?.stdin.write(line);
  }
}
