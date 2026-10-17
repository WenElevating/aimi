import type { ApprovalDecision } from "./agentEvents.js";

/** 手机→agent 的统一指令（§5.1）。所有写操作共享 clientId 幂等（异常 #7）。 */
export type AgentCommand =
  | { readonly cmd: "send"; readonly text: string; readonly files?: readonly { readonly name: string; readonly b64: string }[] }
  | { readonly cmd: "interrupt" }
  | { readonly cmd: "approve"; readonly requestId: string; readonly decision: ApprovalDecision }
  | { readonly cmd: "answer"; readonly questionId: string; readonly value: string }
  | { readonly cmd: "stop" }
  | { readonly cmd: "restart" };
