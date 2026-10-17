/** agent 会话状态（§5.1 灵魂：waiting_* 驱动红点/通知/徽标）。M0 仅 flowing 子集运行。 */
export type SessionState =
  | "starting" | "running" | "waiting_approval" | "waiting_input"
  | "finished" | "failed" | "stopped";

/** 通知分类：M1 前台服务长连接据此驱动通知/红点，M0 只冻结取值域，不产生独立帧。 */
export type NotificationKind =
  | "pending_approval" | "pending_question" | "finished" | "failed" | "stalled";

/** 归一化事件流：四家 agent 的私有协议都被翻译成它（§5.1 契约）。 */
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

/** 权限请求的可选项：kind 即手机 approve 指令要回传的裁决值。 */
export interface ApprovalOption { readonly label: string; readonly kind: ApprovalDecision }
/** 权限裁决唯一取值域：once（本次）/ always（本会话内持续）/ reject；approve 指令只接受这三个值。 */
export type ApprovalDecision = "once" | "always" | "reject";
/** 提问事件的候选项：value 回填 answer 指令，label 仅用于展示。 */
export interface Choice { readonly label: string; readonly value: string }
