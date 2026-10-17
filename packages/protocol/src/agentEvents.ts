/** 会话当前状态；waiting_approval 与 waiting_input 需在手机侧提示（红点/通知/徽标）。 */
export type SessionState =
  | "starting" | "running" | "waiting_approval" | "waiting_input"
  | "finished" | "failed" | "stopped";

/** 通知分类；当前版本只保留取值域、不单独产生帧，供前台长连接据此驱动通知与红点。 */
export type NotificationKind =
  | "pending_approval" | "pending_question" | "finished" | "failed" | "stalled";

/** 归一化事件：各家 agent 的私有输出都统一翻译成这组事件，手机只消费这一种形态。 */
export type AgentEvent =
  | { readonly type: "state"; readonly state: SessionState }
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "tool_call"; readonly id: string; readonly name: string; readonly summary: string; readonly inputDigest: string }
  | { readonly type: "tool_result"; readonly id: string; readonly ok: boolean; readonly outputExcerpt: string; readonly exitCode?: number }
  | { readonly type: "permission"; readonly id: string; readonly title: string; readonly detail: string; readonly options: readonly ApprovalOption[] }
  | { readonly type: "question"; readonly id: string; readonly prompt: string; readonly options: readonly Choice[] }
  | { readonly type: "usage"; readonly tokensIn: number; readonly tokensOut: number; readonly cost?: number }
  | { readonly type: "notice"; readonly severity: "info" | "warn" | "error"; readonly text: string }
  | { readonly type: "exit"; readonly exitCode: number | null; readonly durationMs: number };

/** 权限请求给出的候选项；kind 即手机 approve 指令需要回传的选择结果。 */
export interface ApprovalOption { readonly label: string; readonly kind: ApprovalDecision }
/** 审批结果的唯一取值：once（本次）/ always（本会话内持续）/ reject（拒绝）；approve 指令只接受这三个值。 */
export type ApprovalDecision = "once" | "always" | "reject";
/** 提问事件的候选项：value 回填 answer 指令，label 仅用于展示。 */
export interface Choice { readonly label: string; readonly value: string }
