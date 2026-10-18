import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, ApprovalDecision } from "@aimi/protocol";
import type { Emit } from "../../types.js";

/** permDir 轮询周期（毫秒）。why 100：手机审批是秒级人因操作，轮询延迟可忽略；测试注入更短周期提速。 */
const POLL_MS = 100;

/** 手机审批三选项（permission 事件的固定选项集；label 面向手机渲染，kind 是 approve 指令回传值）。 */
const APPROVAL_OPTIONS = [
  { label: "本次允许", kind: "once" },
  { label: "一直允许", kind: "always" },
  { label: "拒绝", kind: "reject" },
] as const;

/** 拒绝决定的固定文案：闸回灌的 message 会进入模型的协调上下文（软拒——模型继续换路重试）。 */
const REJECT_MESSAGE = "手机端拒绝";

/**
 * 审批闸的 aimi 侧后端（watch-发布-响应一条路）。
 *
 * claude CLI 把审批请求落成 `<permDir>/<toolUseId>.request.json`（经 `gate.mjs` 或测试的假 CLI）；
 * 本类轮询该目录：新请求 → 向手机发 `permission` 卡片 + `waiting_approval` 状态；手机 `approve`
 * 指令经 `answer` 写回 `<toolUseId>.decision.txt`，闸进程读走回灌 CLI。
 *
 * **「一直允许」的会话内近似**（S1 口径）：always 决定把工具名记入内存 allowlist，此后同工具名
 * 的请求不再发手机事件、直接写 allow 决定 + 一条可见性 notice（适配器无审计面，事件流即可见性
 * ——偏差记录在案）。why 近似：一次决策管本会话内全部后续调用；不跨进程持久化，会话收尾即失效。
 *
 * 生命周期与 claude 会话同生共死：`watch` 在 `start()` 时布防，`stop` 在 dispose/进程收尾时清算；
 * 目录级清理由静态 `cleanup` 承担（确定性目录名 `<dataDir>/perms/<aimiSessionId>/`——调试/清理/
 * 测试断言都直接可寻址）。
 */
export class PermissionRelay {
  readonly #dir: string;
  readonly #pollMs: number;
  /** 轮询定时器；`watch` 布防、`stop` 清算（重复 watch 不叠加） */
  #timer: ReturnType<typeof setInterval> | undefined;
  /** 发布出口；`watch` 注入（轮询拍上发布 permission 卡与状态） */
  #emit: Emit | undefined;
  /** 请求账本：toolUseId → 工具名（首次观测即记账——幂等去重与 always 记名共用） */
  readonly #seen = new Map<string, string>();
  /** 已答复请求：二次 answer 视为失效，决定文件不得被二次改写 */
  readonly #answered = new Set<string>();
  /** 「一直允许」记名工具（会话内近似——不跨进程持久化，重挂新句柄后失效） */
  readonly #alwaysTools = new Set<string>();

  /**
   * @param deps.dir - 本会话的请求目录（permDir；调用方保证已建立）
   * @param deps.pollMs - 轮询周期（毫秒）；缺省 100，测试注入更短值提速
   */
  constructor(deps: { dir: string; pollMs?: number }) {
    this.#dir = deps.dir;
    this.#pollMs = deps.pollMs ?? POLL_MS;
  }

  /**
   * 开始轮询请求目录并把事件交给 `emit`（顺序权威在 EventBus）。
   * 副作用：置轮询定时器；重复调用不叠加（幂等）。
   *
   * @param emit - 归一化事件出口（同步 void）
   */
  watch(emit: Emit): void {
    if (this.#timer !== undefined) return;
    this.#emit = emit;
    this.#timer = setInterval(() => { this.#poll(); }, this.#pollMs);
  }

  /** 停止轮询（dispose/进程收尾路径调用；幂等）。挂起请求的目录级清理由静态 `cleanup` 承担。 */
  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * 回答一条已观测的审批请求：写决定文件（闸进程读走回灌 CLI）。
   * - `once` → `{behavior:'allow'}`；
   * - `always` → allow 并把工具名记入会话 allowlist（后续同工具请求自动放行）；
   * - `reject` → `{behavior:'deny',message:'手机端拒绝'}`。
   *
   * @param requestId - 审批请求 id（= toolUseId = 请求文件名主干）
   * @param decision - 手机决定
   * @returns true 表示已受理并写出决定文件；false 表示请求未知/已答复/目录已清（调用方据此
   *          发失效提示，**不写文件**——晚到审批不静默吞、不代答）
   */
  answer(requestId: string, decision: ApprovalDecision): boolean {
    const toolName = this.#seen.get(requestId);
    if (toolName === undefined || this.#answered.has(requestId)) return false;
    this.#answered.add(requestId);
    try {
      if (decision === "reject") {
        writeFileSync(join(this.#dir, requestId + ".decision.txt"), JSON.stringify({ behavior: "deny", message: REJECT_MESSAGE }));
      } else {
        writeFileSync(join(this.#dir, requestId + ".decision.txt"), JSON.stringify({ behavior: "allow" }));
        if (decision === "always") this.#alwaysTools.add(toolName);
      }
    } catch {
      return false; // 目录已随 dispose 清理：请求悬空，视同失效
    }
    return true;
  }

  /**
   * 目录级清理（尽力而为）：删除整个 permDir。
   * why 静态方法：claudeSession dispose 收尾持有目录路径而非 relay 实例（relay 可能已 stop 并置空）。
   * Windows 句柄未释放时 rm 可能抖动——失败静默（目录残留由上层重试/下次覆盖写兜住）。
   *
   * @param dir - 待清理目录
   */
  static cleanup(dir: string): void {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  }

  /** 单次轮询：观测新请求文件 →「一直允许」自动放行，否则发布审批卡 + 等待态。 */
  #poll(): void {
    let names: string[];
    try {
      names = readdirSync(this.#dir);
    } catch {
      return; // 目录尚未建立/已随收尾清理：本轮无事
    }
    for (const name of names) {
      if (!name.endsWith(".request.json")) continue;
      // 请求 id = 文件名主干（gate.mjs 以 toolUseId 命名请求与决定文件——手机事件 id 与文件名同源）。
      const requestId = name.slice(0, -".request.json".length);
      if (this.#seen.has(requestId)) continue; // 同 toolUseId 只发一次（幂等账本）
      let toolName: string;
      let input: unknown;
      try {
        const parsed = JSON.parse(readFileSync(join(this.#dir, name), "utf8")) as { toolName?: unknown; input?: unknown };
        if (typeof parsed?.toolName !== "string") continue; // 形状不符：留待下一轮（容错优先，不炸流）
        toolName = parsed.toolName;
        input = parsed.input;
      } catch {
        continue; // 半写/损坏：留待下一轮
      }
      this.#seen.set(requestId, toolName);
      const emit = this.#emit;
      if (emit === undefined) continue; // 防御：轮询只在 watch 之后开跑
      if (this.#alwaysTools.has(toolName)) {
        // 自动放行：先落决定文件再发可见性 notice——手机看到 notice 时文件必已在位。
        try {
          writeFileSync(join(this.#dir, requestId + ".decision.txt"), JSON.stringify({ behavior: "allow" }));
          this.#answered.add(requestId);
        } catch { /* 目录竞态：决定缺失由 CLI 悬挂面暴露 */ }
        emit({ type: "notice", severity: "info", text: '已按"一直允许"自动放行 ' + toolName });
        continue;
      }
      emit({ type: "permission", id: requestId, title: toolName, detail: JSON.stringify(input ?? null), options: APPROVAL_OPTIONS });
      emit({ type: "state", state: "waiting_approval" });
    }
  }
}
