/** 手机可申请的权限模式白名单：只允许 default 与 plan，手机侧不能申请更高权限。 */
export type PhonePermissionMode = "default" | "plan";

/** 手机创建会话的入参；permissionMode 只能取手机侧允许的模式，不能借此申请升权。 */
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
