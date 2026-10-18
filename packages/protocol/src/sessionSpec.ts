/** 手机可申请的权限模式白名单：只允许 default 与 plan，手机侧不能申请更高权限。 */
export type PhonePermissionMode = "default" | "plan";

/** 手机创建会话的入参；permissionMode 只能取手机侧允许的模式，不能借此申请升权。 */
export interface SessionSpec {
  /** 目标适配器标识，取值域由服务端注册表决定 */
  readonly agentId: string;
  /** agent 侧工作目录 */
  readonly cwd: string;
  /** 模型名；缺省表示用 agent 自身默认 */
  readonly model?: string;
  /** 权限模式，只能取手机侧白名单值，不能借此申请升权 */
  readonly permissionMode: PhonePermissionMode;
  /** 首条输入；缺省表示不预置输入 */
  readonly initialPrompt?: string;
}

/** 会话列表项（welcome 帧携带）；state 与 lastSeq 供手机恢复红点与断线补齐。 */
export interface SessionMeta {
  /** 会话标识，由服务端生成，创建后不变 */
  readonly id: string;
  /** 适配器标识 */
  readonly agentId: string;
  /** agent 侧工作目录 */
  readonly cwd: string;
  /** 权限模式，与创建时申请的值一致 */
  readonly permissionMode: PhonePermissionMode;
  /** 会话当前状态 */
  readonly state: import("./agentEvents.js").SessionState;
  /** 会话内最后一条事件的序号；手机据此补齐断线期间漏掉的事件 */
  readonly lastSeq: number;
  /** 创建时刻（毫秒时间戳） */
  readonly createdAt: number;
  /** 最近更新时刻（毫秒时间戳） */
  readonly updatedAt: number;
}
