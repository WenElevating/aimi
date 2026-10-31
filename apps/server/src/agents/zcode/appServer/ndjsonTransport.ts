import { spawn, type ChildProcess } from "node:child_process";

/**
 * zcode app-server stdio 传输：NDJSON 行协议（LF 分帧，`JSON.stringify(message)+"\n"`）。
 *
 * **刻意不用 readline**：readline 会把 U+2028/U+2029 当换行，模型文本包含这类字符时会把
 * 合法 JSON 帧切成半帧（zcode 官方宿主 zcodeStdioTransport.ts 同款注释与手写分帧算法）。
 * stdout 非 JSON 行即协议违约——按连接关闭处理（对端 stderr 是日志流，不参与协议）。
 */
export interface NdjsonTransportHandlers {
  /** 收到一帧完整 JSON（已 parse）；解析失败由传输层自行关闭并回调 onClose */
  onMessage: (message: unknown) => void;
  /** 连接关闭（进程退出/解析违约/显式 stop）；reason 仅诊断 */
  onClose: (reason: string) => void;
  /** stderr 原始片段旁路（日志用；协议外） */
  onStderr?: (chunk: string) => void;
}

export class NdjsonTransport {
  readonly #child: ChildProcess;
  readonly #handlers: NdjsonTransportHandlers;
  #buffer = "";
  #closed = false;

  private constructor(child: ChildProcess, handlers: NdjsonTransportHandlers) {
    this.#child = child;
    this.#handlers = handlers;
  }

  /** spawn `app-server --stdio` 并装配传输；进程错误/提前退出即 onClose。 */
  static spawn(file: string, args: readonly string[], handlers: NdjsonTransportHandlers): NdjsonTransport {
    const child = spawn(file, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const transport = new NdjsonTransport(child, handlers);
    const stdout = child.stdout;
    if (stdout === null) throw new Error("app-server stdout 缺失");
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => transport.#onData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => handlers.onStderr?.(chunk));
    child.on("error", (error: Error) => transport.#close("spawn error: " + error.message));
    child.on("exit", (code, signal) => transport.#close(`process exit code=${String(code)} signal=${String(signal)}`));
    return transport;
  }

  /** 写一帧（JSON.stringify + LF）；进程已退/流背压异常即返回 false（调用方按断连收口）。 */
  send(message: unknown): boolean {
    const stdin = this.#child.stdin;
    if (this.#closed || stdin === null || this.#child.exitCode !== null) return false;
    try {
      stdin.write(JSON.stringify(message) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /** 关闭连接：结束 stdin（官方契约：EOF → 优雅退出）并树杀兜底。 */
  close(): void {
    if (this.#closed) return;
    this.#child.stdin?.end();
    // EOF 宽限由进程自然退出；kill 兜底交给调用方的进程管理（避免这里立刻杀掉排水中的会话）。
  }

  /** 强杀（进程管理回收用）。 */
  kill(): void {
    this.#child.kill("SIGKILL");
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let idx = this.#buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.#buffer.slice(0, idx).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(idx + 1);
      if (line !== "") {
        try {
          this.#handlers.onMessage(JSON.parse(line));
        } catch (error) {
          this.#close("protocol parse error: " + String(error).slice(0, 200));
          return;
        }
      }
      idx = this.#buffer.indexOf("\n");
    }
  }

  #close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#handlers.onClose(reason);
  }
}
