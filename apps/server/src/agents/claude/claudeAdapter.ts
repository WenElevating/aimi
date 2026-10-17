import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import type { SessionSpec } from "@aimi/protocol";
import type { AgentAdapter, AgentMeta, AgentSession, Emit } from "../types.js";
import { ClaudeSession } from "./claudeSession.js";

/** `claude --version` 探测超时（简报冻结：2s 未响应视为未安装）。 */
const VERSION_TIMEOUT_MS = 2000;

/**
 * claude code 适配器（M0 范围）：`send`/`interrupt` 走真实流式双向管道，
 * `approve`/`answer` 发 notice 占位（M1 接 `canUseTool` 审批回落）。
 *
 * 安装探测：`claude --version`（Windows 下经 `shell:true` 解析 `.cmd`/`.exe` 垫片），
 * 2s 未回或非零退出即 `{ok:false}`——**不抛**（契约要求以返回值表达失败）。
 *
 * YAGNI 边界（M1）：不做 `protocolVersion` 探测与协商——M0 只面向本机已装 claude 的当前线格式。
 */
export class ClaudeAdapter implements AgentAdapter {
  /** 适配器身份：`id` 即 `SessionSpec.agentId` 的取值域（T11 装配时以此注册）。 */
  readonly meta: AgentMeta = { id: "claude", label: "Claude Code" };

  /**
   * 探测本机是否装有 claude。
   * @returns `{ok:true, version}`（探测进程 0 退出；`version` 取 stdout 首个非空行）；
   *          否则 `{ok:false}`（二进制缺失/无权限/超时/非零退出，一律收敛为同一结果，不抛）。
   */
  isInstalled(): Promise<{ ok: boolean; version?: string }> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (result: { ok: boolean; version?: string }): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(result);
      };

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn("claude", ["--version"], { shell: process.platform === "win32" });
      } catch {
        finish({ ok: false });
        return;
      }

      timer = setTimeout(() => {
        child.kill(); // 探测进程（`--version` 无孙进程）直接终止即可
        finish({ ok: false });
      }, VERSION_TIMEOUT_MS);

      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", () => { /* 排空防背压；版本探测不消费 stderr */ });
      child.on("error", () => { finish({ ok: false }); });
      child.on("close", (code) => {
        if (code !== 0) {
          finish({ ok: false });
          return;
        }
        const version = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "");
        finish(version === undefined ? { ok: true } : { ok: true, version });
      });
    });
  }

  /**
   * 拉起一条 claude 侧会话（子进程的创建与读流在 `start()` 里发生，见 `ClaudeSession`）。
   * @param spec 会话描述（`cwd`/`permissionMode`/可选 `initialPrompt`）。
   * @param emit 归一化事件出口。
   * @param resume 续接线索（存在时追加 `--resume <hint>`）。
   * @returns 惰性句柄——`start()` 前可先 `send`（指令排队，见 `ClaudeSession`）。
   */
  create(spec: SessionSpec, emit: Emit, resume?: { hint: string }): AgentSession {
    return new ClaudeSession(spec, emit, resume);
  }
}
