/** 手机可建会话的描述。permissionMode 白名单锁死（C3：手机不可升权）。 */
export type PhonePermissionMode = "default" | "plan";

export interface SessionSpec {
  readonly agentId: string;
  readonly cwd: string;
  readonly model?: string;
  readonly permissionMode: PhonePermissionMode;
  readonly initialPrompt?: string;
}

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
