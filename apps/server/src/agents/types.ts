import type { AgentCommand, AgentEvent, SessionSpec } from "@aimi/protocol";

/** 适配器身份投影：UI 展示用（`id` 是 `SessionSpec.agentId` 的取值域）。 */
export interface AgentMeta { readonly id: string; readonly label: string }

/**
 * 适配器向编排层上报事件的出口（同步 void）。
 * 实现方只管调用；顺序、落库、扇出均由 `SessionManager` 与 `EventBus` 保证。
 */
export type Emit = (event: AgentEvent) => void;

/**
 * 统一适配器接口：各家异构 agent 的私有协议都封装在实现内部，
 * 编排层只认这里的三件事——是否装得上、怎么拉起、拉起后拿到什么句柄。
 */
export interface AgentAdapter {
  readonly meta: AgentMeta;
  /**
   * 探测本机是否装得上该 agent（如执行 `claude --version`）；探测失败不抛异常，以 `{ok:false}` 表达。
   *
   * @returns Promise，resolve 为探测结果：成功时 `{ok:true, version?}`，失败时 `{ok:false}`
   */
  isInstalled(): Promise<{ ok: boolean; version?: string }>;
  /**
   * 拉起（或续接）agent 侧会话。
   *
   * @param spec - 会话描述（工作目录、权限模式、可选首条输入）
   * @param emit - 归一化事件出口
   * @param resume - 续接线索；传入时续接既有 agent 侧会话（如 `claude --resume`）
   * @returns agent 侧会话句柄；创建与启动分离，可先 `send` 再 `start`
   */
  create(spec: SessionSpec, emit: Emit, resume?: { hint: string }): AgentSession;
}

/**
 * agent 侧会话的被采集运行时事实（皆可缺省——IPC 建立前拿不到）。
 * why 拉取式：pid 在 spawn 后才知、续接线索要到 `system/init` 才到，编排层与适配器
 * 之间不传班车消息，改为编排层在每次事件后按需拉取（变更才写，幂等）。
 */
export interface AgentRuntime {
  /** agent 子进程号；`start()` 前为 `undefined` */
  readonly pid?: number;
  /** agent 侧续接线索（如 claude `system/init.session_id`）；协议握手前为 `undefined` */
  readonly resumeHint?: string;
}

/** 单个 agent 侧会话句柄（一条子进程/一次远端会话）；生命周期由 `SessionManager` 驱动。 */
export interface AgentSession {
  /**
   * 启动会话：拉起底层进程并开始读取事件流。
   *
   * @returns Promise，resolve 表示底层进程已就绪
   */
  start(): Promise<void>;
  /**
   * 下发一条手机指令（已归一化）。
   *
   * @param cmd - 已归一化的手机指令
   * @returns Promise，resolve 表示指令已写入 agent 侧会话
   */
  send(cmd: AgentCommand): Promise<void>;
  /**
   * 释放会话资源（终止底层进程）。
   *
   * @param reason - 释放原因，仅用于诊断
   * @returns Promise，resolve 表示底层进程已回收
   */
  dispose(reason?: string): Promise<void>;
  /**
   * 被采集运行时事实快照。
   * why 拉取：编排层据此维护进程台账（pid）与续接线索（resume_hint），不依赖适配器主动申报；
   * 实现方按引用维持快照语义（同一对象字段可后续更新），编排层以「变更才写」口径消费。
   *
   * @returns pid/hint 任一已知时的快照；两者皆未知（未拉起）时返回 `null`
   */
  runtime?(): AgentRuntime | null;
}

/**
 * 编排层查找适配器的最小接口。
 * 未注册的 agentId 返回 `undefined`（由调用方决定错误语义）。
 */
export interface AgentLookup { get(agentId: string): AgentAdapter | undefined }
