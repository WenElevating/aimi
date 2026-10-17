import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentCommand, SessionSpec } from "@aimi/protocol";
import type { AgentSession, Emit } from "../types.js";
import { parseLine } from "./claudeProtocol.js";

/** 强杀升级阈值（简报冻结）：`kill()` 后 5s 仍未退，才升级到 SIGKILL/再次强杀。 */
const KILL_ESCALATION_MS = 5000;

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
  /** `close` 后兑现（`dispose` 等它——保证返回时进程已收尸）。 */
  readonly #closed: Promise<void>;
  #closeResolve: (() => void) | undefined;

  /**
   * @param spec 会话描述（`cwd` 为子进程工作目录；`initialPrompt` 非空时在 `start()` 写入 stdin）。
   * @param emit 归一化事件出口（同步 void，顺序权威在 `EventBus`）。
   * @param resume 续接线索（存在时追加 `--resume <hint>`）。
   */
  constructor(spec: SessionSpec, emit: Emit, resume?: { hint: string }) {
    this.#spec = spec;
    this.#emit = emit;
    this.#resumeHint = resume?.hint;
    this.#closed = new Promise<void>((resolve) => { this.#closeResolve = resolve; });
  }

  /**
   * 拉起子进程并开始读流。`spawn` 成功（进程确实启动）即 resolve；
   * 进程级错误（如无权限执行）直接 reject（命令不存在不属此类——Windows `shell:true` 下由 shell 兜底成非零退出）。
   * @throws 子进程 `error` 事件携带的原始错误。
   * @throws `claude session already started`：同一句柄重复 start。
   */
  async start(): Promise<void> {
    if (this.#child !== undefined) throw new Error("claude session already started");
    const child = spawn("claude", buildArgs(this.#spec, this.#resumeHint), {
      cwd: this.#spec.cwd,
      shell: process.platform === "win32", // 生产同构：Windows 需 shell 才能解析 `claude.cmd` 垫片
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
   * 释放会话：终止子进程（含 `shell:true` 拉起的孙进程）→ 等 `close` → 返回。
   * **幂等**：未 start 或已退出时直接返回。5s 内未退再强杀一次（简报冻结的升级路径）。
   * @param reason 仅用于诊断（M0 无日志出口，不落地；保留参数以对齐 `AgentSession` 契约）。
   */
  async dispose(reason?: string): Promise<void> {
    void reason;
    const child = this.#child;
    if (child === undefined || this.#exited) return;
    this.#terminate(child);
    const escalation = setTimeout(() => { if (!this.#exited) this.#escalate(child); }, KILL_ESCALATION_MS);
    try {
      await this.#closed;
    } finally {
      clearTimeout(escalation);
      this.#child = undefined;
    }
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

  /**
   * 终止进程树。Windows 上 `shell:true` 使**直接子进程是 cmd.exe**、CLI 本体是孙进程——
   * 只 `child.kill()` 会留下孤儿，故用 `taskkill /T /F` 按树强杀；非 Windows 走 `child.kill()`。
   */
  #terminate(child: ChildProcessWithoutNullStreams): void {
    if (process.platform === "win32" && child.pid !== undefined) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {
        child.kill();
      });
      return;
    }
    child.kill();
  }

  /** 5s 未退的升级强杀（Windows 无 POSIX 信号语义，直接 TerminateProcess）。 */
  #escalate(child: ChildProcessWithoutNullStreams): void {
    if (process.platform === "win32") {
      child.kill();
      return;
    }
    child.kill("SIGKILL");
  }
}
