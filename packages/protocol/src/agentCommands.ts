import type { ApprovalDecision } from "./agentEvents.js";

/** 手机发给 agent 会话的指令合集；所有写指令以 clientId 作幂等键，重复投递同一 clientId 只会执行一次。 */
export type AgentCommand =
  | { readonly cmd: "send"; readonly text: string; readonly files?: readonly { readonly name: string; readonly b64: string }[] }
  | { readonly cmd: "interrupt" }
  | { readonly cmd: "approve"; readonly requestId: string; readonly decision: ApprovalDecision }
  | { readonly cmd: "answer"; readonly questionId: string; readonly value: string }
  | { readonly cmd: "configure"; readonly model?: string; readonly permissionMode?: import("./sessionSpec.js").PhonePermissionMode }
  | { readonly cmd: "stop" }
  | { readonly cmd: "restart" };
