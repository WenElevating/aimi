/** 手机可建会话的描述。permissionMode 白名单锁死（C3：手机不可升权）。 */
export type PhonePermissionMode = "default" | "plan";

/** 手机建会话的入参；permissionMode 只能取 PhonePermissionMode（C3：手机不可升权）。 */
export interface SessionSpec {
  readonly agentId: string;
  readonly cwd: string;
  readonly model?: string;
  readonly permissionMode: PhonePermissionMode;
  readonly initialPrompt?: string;
}

/** 会话列表项（welcome 帧携带）；state 与 lastSeq 供手机恢复红点与断线补齐。 */
export interface SessionMeta {
  readonly id: string;
  readonly agentId: string;
  readonly cwd: string;
  readonly permissionMode: PhonePermissionMode;
  readonly state: import("./agentEvents.js").SessionState;
  readonly lastSeq: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
