/** 不透明权限标识；具体模式及可用性由适配器和服务端策略裁决。 */
export type PhonePermissionMode = string;

/** agent 提供的权限目录；标识不由手机枚举，可用性不是权限授权。 */
export interface PermissionModeDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly availability: "available" | "unavailable" | "unknown";
  readonly reason?: string;
}

/** 模型清单项（welcome agents 投影与手机 picker 共用形状）。 */
export interface AgentModelOption {
  /** 协议值（`configure.model` / `SessionSpec.model` 直接回传） */
  readonly value: string;
  /** 显示名（picker 行主标签） */
  readonly name: string;
  /** 一行差异说明（picker 行副文本）；缺省不显示 */
  readonly detail?: string;
}

/**
 * 单个 agent 的能力投影（welcome 帧携带）：手机据此渲染模型清单与权限档位，
 * 替代端上硬编码；旧客户端仍读 permissionCeiling，新客户端按描述及可用性渲染。
 */
export interface AgentCapability {
  /** 适配器标识（`SessionSpec.agentId` 取值域） */
  readonly id: string;
  /** 展示名（如 Claude Code） */
  readonly label: string;
  /** 服务端配置的权限上限 */
  readonly permissionCeiling: PhonePermissionMode;
  /** 模型清单；空数组表示适配器无清单概念（手机回退内置清单） */
  readonly models: readonly AgentModelOption[];
  readonly permissionModes?: readonly PermissionModeDescriptor[];
}

/** 手机创建会话的入参；服务端必须校验适配器支持及配置授权。 */
export interface SessionSpec {
  /** 目标适配器标识，取值域由服务端注册表决定 */
  readonly agentId: string;
  /** agent 侧工作目录 */
  readonly cwd: string;
  /** 模型名；缺省表示用 agent 自身默认 */
  readonly model?: string;
  /** 权限模式；标识通过结构校验后仍须通过服务端策略授权。 */
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
  /** 最近确认的实际权限模式，运行时回退会更新此值。 */
  readonly permissionMode: PhonePermissionMode;
  /** 创建或 configure 后持久化的模型；缺省表示跟随 CLI 默认。 */
  readonly model?: string;
  /** 会话当前状态 */
  readonly permissionModes?: readonly PermissionModeDescriptor[];
  readonly state: import("./agentEvents.js").SessionState;
  /** 会话内最后一条事件的序号；手机据此补齐断线期间漏掉的事件 */
  readonly lastSeq: number;
  /** 续接可用：server 依 resume_hint 有无派生；S3 手机端据此渲染"续接入口" */
  readonly resumable: boolean;
  /** 创建时刻（毫秒时间戳） */
  readonly createdAt: number;
  /** 最近更新时刻（毫秒时间戳） */
  readonly updatedAt: number;
}
