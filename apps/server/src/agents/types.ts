import type { AgentCommand, AgentEvent, SessionSpec } from "@aimi/protocol";

/** 适配器身份投影：UI 展示用（`id` 是 `SessionSpec.agentId` 的取值域）。 */
export interface AgentMeta { readonly id: string; readonly label: string }

/**
 * 适配器 → 编排层的事件出口（同步 void）。
 * 实现方（`AgentSession`）只管调用；顺序、落库、扇出均由 `SessionManager`/`EventBus` 保证。
 */
export type Emit = (event: AgentEvent) => void;

/**
 * 统一适配器接口：各家异构 agent 的私有协议都封装在实现内部，
 * 编排层只认这里的三件事——是否装得上、怎么拉起、拉起后拿到什么句柄。
 */
export interface AgentAdapter {
  readonly meta: AgentMeta;
  /** 探测本机是否装得上该 agent（如执行 `claude --version`）；探测失败不抛异常，以 `{ok:false}` 表达。 */
  isInstalled(): Promise<{ ok: boolean; version?: string }>;
  /** 拉起（或续接）agent 侧会话；传入 `resume.hint` 时续接既有会话（如 `claude --resume`）。 */
  create(spec: SessionSpec, emit: Emit, resume?: { hint: string }): AgentSession;
}

/** 单个 agent 侧会话句柄（一条子进程/一次远端会话）；生命周期由 `SessionManager` 驱动。 */
export interface AgentSession {
  /** 启动会话：拉起底层进程并开始读取事件流。 */
  start(): Promise<void>;
  /** 下发一条手机指令（已归一化）。 */
  send(cmd: AgentCommand): Promise<void>;
  /** 释放会话资源（终止底层进程）；`reason` 仅用于诊断。 */
  dispose(reason?: string): Promise<void>;
}

/**
 * 编排层查找适配器的最小接口。
 * 未注册的 agentId 返回 `undefined`（由调用方决定错误语义）。
 */
export interface AgentLookup { get(agentId: string): AgentAdapter | undefined }
