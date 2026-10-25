import type { AgentCommand, AgentEvent, AgentModelOption, PermissionModeDescriptor, SessionSpec } from "@aimi/protocol";

/** 适配器身份投影：UI 展示用（`id` 是 `SessionSpec.agentId` 的取值域）。 */
export interface AgentMeta {
  readonly id: string;
  readonly label: string;
}

/**
 * 适配器向编排层上报事件的出口（同步 void）。
 * 实现方只管调用；顺序、落库、扇出均由 `SessionManager` 与 `EventBus` 保证。
 */
export type Emit = (event: AgentEvent) => void;

/**
 * 编排层交给适配器的会话上下文（内部契约扩展，非协议帧）：aimi 侧会话 id 与服务端数据目录。
 * why 经 `create` 末参透传：适配器由编排层拉起，create 是唯一的会话工厂——上下文与
 * 「这条 aimi 会话」绑定在 create 点最自然；适配器据此派生自身域内的目录（如 claude 审批闸 permDir）。
 */
export interface AdapterContext {
  /** aimi 侧会话 id（目录派生的确定性成分；调试/清理/测试断言直接可寻址） */
  readonly sessionId: string;
  /** 服务端数据目录（目录派生的根） */
  readonly dataDir: string;
  /** 仅当服务端策略允许时预备 SDK 的完全放行开关，初始权限不因此改变。 */
  readonly allowDangerouslySkipPermissions?: boolean;
  /** SDK 状态消息无时间线事件时仍需采集事实。 */
  readonly onRuntimeChanged?: () => void;
}

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
   * @param context - aimi 会话上下文（可选；缺省时适配器关闭依赖上下文的功能面，如审批闸）
   * @returns agent 侧会话句柄；创建与启动分离，可先 `send` 再 `start`
   */
  create(spec: SessionSpec, emit: Emit, resume?: { hint: string }, context?: AdapterContext): AgentSession;
  /**
   * 模型清单能力面（可选）：返回该 agent 当前已知的模型选项（welcome agents 投影的数据源）。
   * why 可选：不是所有接入方式都有可枚举的模型面——缺省时手机回退内置清单。
   * 同步返回缓存值（探测在 `refreshModels` 异步完成）。
   */
  currentModels?(): readonly AgentModelOption[];
  /**
   * 刷新模型清单（可选）：异步探测并更新 `currentModels` 的缓存；失败保持原值不抛。
   * 装配层启动预热与后续刷新点调用。
   */
  refreshModels?(): Promise<void>;
  /**
   * 返回适配器已知模式；运行时约束由会话句柄进一步收紧。
   */
  permissionModes?(): readonly PermissionModeDescriptor[];
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
  readonly permissionMode?: string;
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
  /**
   * 句柄活性探针：底层进程是否仍可交付指令（进程退出/崩溃即 `false`，句柄未 dispose 与否无关）。
   * why 可选：M0 起家的假适配器/简易实现可不带——编排层缺省按"句柄在即活"口径（向后兼容）；
   * claude 实现以「进程是否已退出」为准——CLI 自终止/崩溃后句柄仍在，dead 句柄的 send
   * 写 stdin 是静默丢弃，不探活则手机端永远等不到回应（评审 Task 6 gotcha 2）。
   *
   * @returns true 表示进程仍可交付
   */
  isAlive?(): boolean;
  /** 当前句柄的切换能力；未确认的能力以 unknown 明示。 */
  permissionModes?(): readonly PermissionModeDescriptor[];
}

/**
 * 编排层查找适配器的最小接口。
 * 未注册的 agentId 返回 `undefined`（由调用方决定错误语义）。
 */
export interface AgentLookup {
  get(agentId: string): AgentAdapter | undefined;
}
