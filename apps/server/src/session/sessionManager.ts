import { randomUUID } from "node:crypto";
import type {
  AgentCommand,
  AgentEvent,
  SessionMeta,
  SessionSpec,
  SessionState,
} from "@aimi/protocol";
import type { AgentAdapter, AgentLookup, AgentSession, Emit } from "../agents/types.js";
import type { EventBus } from "../events/eventBus.js";
import type { Logger } from "../logging/logger.js";
import type { ConversationRepository } from "../persistence/types.js";
import { canTransition, TRANSITIONS } from "./sessionMachine.js";

/** 会话生命周期三态：新建 / 可续接 / 已归档。重启恢复时由装配层逐会话调用认领。 */
export type LifecycleKind =
  /** 全新会话：`create` 即拉起 agent 侧会话 */
  | "new"
  /** 恢复态：**有续接线索**（如 claude 会话 id），`resume` 可重挂 agent 侧会话 */
  | "resumable"
  /** 恢复态：**历史可查不可续跑**（无续接线索）——只登记元数据，`resume` 一律拒绝 */
  | "archived";

/** 终态判据：白名单出度为 0（`finished`/`failed`/`stopped`）。 */
function isTerminal(state: SessionState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** 编排层持有的一条会话（唯一状态源在进程内；`conversations` 的 state 列与之同步维护）。 */
interface ManagedSession {
  /** 拉起/重挂所用的 spec：`new` 为调用方原样传入；恢复路径由仓储元数据重建（不带 initialPrompt） */
  readonly spec: SessionSpec;
  /** 生命周期形态（`create` 时确定） */
  readonly kind: LifecycleKind;
  /** 当前状态 */
  state: SessionState;
  /** 活动 agent 侧会话；恢复态（不拉子进程）为 `undefined` */
  agent: AgentSession | undefined;
  /** `resumeHint` 暂存：`create` 时记下，`resume` 时取出交给适配器 */
  readonly hint: string | undefined;
}

/** 把错误收敛为日志字段（不抛地记日志）。 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 会话编排核心：三种生命周期形态的统一入口、状态跃迁白名单把关、指令转发。
 *
 * - `create`：
 *   - `"new"`：先校验适配器（未注册或未安装时报 `session.agent_missing`），再原子建会话行，
 *     经 bus 发布 `{state:"starting"}`（seq 0，先于适配器落地），最后拉起 agent 侧会话。
 *   - `"resumable"`/`"archived"`：按 `agentId + cwd` 认领仓储里的既有会话并记 lifecycle，
 *     **不拉子进程**（防重启后半夜复活烧 token）。两者差别只在 `resume`：`"resumable"`
 *     （有续接线索）可重挂；`"archived"`（历史可查不可续跑）一律拒绝续接。
 * - 状态白名单只在本类的 emit 包装层生效（`bus` 本身不做校验）；生命周期自身驱动的
 *   `starting`/`stopped` 属于服务端事实，不经白名单（从 `stopped` 到 `starting` 不在表内）。
 * - seq 唯一权威在 `EventBus`：本类只发布，不自行编号。
 *
 * **start 失败自动落 failed 并清理句柄（幽灵行恢复）**：三条拉起路径（`create("new")`/`resume`/`restart`）
 * 中 `adapter.start()` 抛错时，先 `#dispose` 已建句柄、把内存状态与 `sessions.state` 置 `failed`，
 * 并经 bus 发布 `{state:"failed"}`（从 `starting` 到 `failed` 在白名单内），**随后仍把原错误抛出**——
 * 装配层据错误文案映射 error 帧，不得吞掉。
 *
 * **遗留警示（当前版本不处理）**：
 * - 恢复路径（`"resumable"`/`"archived"`）**仅供装配层启动时逐会话调用一次**：对已持有且活动的
 *   会话重复认领会用新条目顶掉旧条目，导致活的 agent 侧句柄无人 `dispose`（子进程泄漏）。
 */
export class SessionManager {
  /** 编排层视图，按 sessionId 索引。 */
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #conversations: ConversationRepository;
  readonly #bus: EventBus;
  readonly #agents: AgentLookup;
  readonly #logger: Logger | undefined;

  /**
   * @param deps.conversations - 会话/事件仓储（唯一能写 sessions+events 的人）
   * @param deps.bus - 事件总线（seq 唯一权威；本类经它发布全部 agent 事件）
   * @param deps.agents - 适配器查找面
   * @param deps.logger - 可选日志门面；缺省时不产生日志
   */
  constructor(deps: {
    conversations: ConversationRepository;
    bus: EventBus;
    agents: AgentLookup;
    logger?: Logger;
  }) {
    this.#conversations = deps.conversations;
    this.#bus = deps.bus;
    this.#agents = deps.agents;
    this.#logger = deps.logger;
  }

  /**
   * 建立（`"new"`）或认领（`"resumable"`/`"archived"`）一条会话。
   *
   * @param spec - 手机侧会话描述（`agentId`/`cwd`/`permissionMode`）
   * @param kind - 生命周期形态：只有 `"new"` 会拉起子进程
   * @param resumeHint - `"resumable"`/`"archived"` 续接 agent 侧会话的提示（如 claude 会话 id）
   * @returns Promise，resolve 为该会话的元数据（状态、最新 seq、时间戳）
   * @throws `session.agent_missing: <agentId>`：`"new"` 且适配器未注册或其 `isInstalled` 失败
   * @throws `session not found`：恢复路径按 `agentId + cwd` 找不到既有会话
   * @throws 适配器 `start()` 的原始错误：会话已自动落 `failed` 并清理句柄
   * 副作用：`"new"` 落库会话行与首事件、发布 starting 事件并拉起子进程
   */
  async create(spec: SessionSpec, kind: LifecycleKind, resumeHint?: string): Promise<SessionMeta> {
    return kind === "new" ? this.#createNew(spec) : this.#adopt(spec, kind, resumeHint);
  }

  /**
   * 启动恢复（装配层装配期专用）：把仓储既有会话登记为 `"archived"`（没有续接线索，**不拉子进程**），
   * 并把 seq 计数器播种到 `meta.lastSeq + 1`，保证重启后新事件序号不与既有事件撞车。
   * 状态以仓储为准（崩溃前 `running` 的会话如实呈现给 `welcome`，但不会复活子进程）。
   * **仅启动装配期逐会话调用一次**：重复认领会用新条目顶掉活动句柄导致子进程泄漏。
   *
   * @param meta - 仓储读回的会话元数据（`id`/`lastSeq`/`state` 均以它为准）
   * @returns Promise，resolve 表示该会话已登记且计数器已播种
   * 副作用：写入编排层会话表，播种事件总线计数器
   */
  async adopt(meta: SessionMeta): Promise<void> {
    this.#sessions.set(meta.id, {
      spec: { agentId: meta.agentId, cwd: meta.cwd, permissionMode: meta.permissionMode },
      kind: "archived",
      state: meta.state,
      agent: undefined,
      hint: undefined,
    });
    this.#bus.seedSession(meta.id, meta.lastSeq + 1);
    this.#logger?.info("session adopted", { sessionId: meta.id, agentId: meta.agentId, lastSeq: meta.lastSeq });
  }

  /**
   * 重挂 agent 侧会话（`adapter.create(spec, emit, {hint})` + `start`）并经 bus 发布 `{state:"starting"}`。
   * 仅 **`kind === "resumable"`** 且当前处于终态时可重挂——`"archived"` 是历史可查不可续跑，
   * `"new"` 则已然有活动会话；活动态重挂会叠挂第二条子进程，故一并拒绝。
   *
   * **起始态窗口**：`starting` 必须先于适配器落地——先 `#publishState("starting")`
   * （同步置内存状态 + 占更早的 seq），再 `create`/`start`。真适配器会在 `start()` 内同步
   * emit `state:"running"`：若此刻状态仍停在旧终态，白名单会把合法跃迁误判为非法（发 bogus notice）；
   * 若把 `starting` 放到 `start()` 之后发，则事件序倒置（running 在前）且状态列被回写成 `starting`。
   *
   * @param sessionId - 目标会话
   * @returns Promise，resolve 为重挂后的会话元数据
   * @throws `session not resumable: <sessionId>`：会话非 `"resumable"`（含 `"archived"`/`"new"`/未知），或仍处于活动状态
   * 副作用：发布 starting 事件并拉起 agent 侧子进程
   */
  async resume(sessionId: string): Promise<SessionMeta> {
    const managed = this.#sessions.get(sessionId);
    if (managed === undefined || managed.kind !== "resumable" || !isTerminal(managed.state)) {
      throw new Error("session not resumable: " + sessionId);
    }
    const adapter = this.#adapter(managed.spec.agentId);
    await this.#publishState(sessionId, "starting");
    const agent = managed.hint === undefined
      ? adapter.create(managed.spec, this.#emit(sessionId))
      : adapter.create(managed.spec, this.#emit(sessionId), { hint: managed.hint });
    await this.#startOrRecover(sessionId, managed, agent);
    this.#logger?.info("session resumed", { sessionId, agentId: managed.spec.agentId });
    return this.#meta(sessionId);
  }

  /**
   * 停止会话：dispose agent 侧会话 + 经 bus 发布 `{state:"stopped"}`。
   * **幂等**：已处终态直接返回（不重复 dispose、不重复发事件）。
   *
   * @param sessionId - 目标会话
   * @returns Promise，resolve 表示会话已停止（原本已终态时立即 resolve）
   * @throws `session not found: <sessionId>`：本实例未持有该会话
   * 副作用：释放 agent 侧子进程、经总线发布 stopped 事件
   */
  async stop(sessionId: string): Promise<void> {
    const managed = this.#require(sessionId);
    if (isTerminal(managed.state)) return;
    await this.#dispose(sessionId, managed, "stop");
    await this.#publishState(sessionId, "stopped");
  }

  /**
   * 重启会话：非终态先 `stop`（dispose + stopped 事件），再以原 spec 重新拉起 agent 侧会话
   * （**同一 aimi sessionId**，seq 连续）并发布 `{state:"starting"}`。
   *
   * **句柄回收**：重挂前凡持有 agent 句柄一律 dispose——自然终态（agent 自报
   * `finished`/`failed`）不经过 `stop`，句柄仍在，跳过回收会让旧子进程孤儿。`stop` 的终态幂等语义不变。
   * **起始态窗口**：同 `resume`，`starting` 先于适配器落地。
   *
   * @param sessionId - 目标会话
   * @returns Promise，resolve 表示已重新拉起（终态直接重启，非终态先停止）
   * @throws `session not found: <sessionId>`：本实例未持有该会话
   * 副作用：必要时停止并回收旧句柄、发布 starting 事件并拉起新子进程
   */
  async restart(sessionId: string): Promise<void> {
    const managed = this.#require(sessionId);
    if (!isTerminal(managed.state)) await this.stop(sessionId);
    if (managed.agent !== undefined) await this.#dispose(sessionId, managed, "restart");
    const adapter = this.#adapter(managed.spec.agentId);
    await this.#publishState(sessionId, "starting");
    await this.#startOrRecover(sessionId, managed, adapter.create(managed.spec, this.#emit(sessionId)));
    this.#logger?.info("session restarted", { sessionId, agentId: managed.spec.agentId });
  }

  /**
   * 把一条手机指令转发给活动会话的 agent 侧会话（`PhoneCommandPipe` 的唯一出口）。
   * 不抛：会话不存在、已终态、或处于恢复态（无子进程）时返回 `false`，由调用方决定提示。
   *
   * @param sessionId - 目标会话
   * @param cmd - 已归一化的手机指令（`stop`/`restart` 走本类的 `stop`/`restart`，不经此路）
   * @returns Promise，resolve 为 true 表示已投递给活动会话
   * 副作用：把指令下发给 agent 侧会话
   */
  async send(sessionId: string, cmd: AgentCommand): Promise<boolean> {
    const managed = this.#sessions.get(sessionId);
    if (managed === undefined || managed.agent === undefined || isTerminal(managed.state)) return false;
    await managed.agent.send(cmd);
    return true;
  }

  /** 全新会话的拉起路径：校验适配器、原子建行、发布 starting 后再拉起子进程。 */
  async #createNew(spec: SessionSpec): Promise<SessionMeta> {
    const adapter = this.#adapter(spec.agentId);
    const installed = await adapter.isInstalled();
    if (!installed.ok) throw new Error("session.agent_missing: " + spec.agentId);

    const sessionId = randomUUID();
    await this.#conversations.createSession({
      id: sessionId,
      agentId: spec.agentId,
      cwd: spec.cwd,
      permissionMode: spec.permissionMode,
      initialPrompt: spec.initialPrompt,
    }, null);

    const managed: ManagedSession = { spec, kind: "new", state: "starting", agent: undefined, hint: undefined };
    this.#sessions.set(sessionId, managed);
    // 起始态先入 seq（与其它拉起路径同一处理）：`starting` 恒为该会话第一条事件，
    // 适配器在 `start()` 期间同步 emit 的任何事件都只会在其后（白名单语义不变——内存状态早已是 starting）。
    await this.#publishState(sessionId, "starting");
    await this.#startOrRecover(sessionId, managed, adapter.create(spec, this.#emit(sessionId)));
    this.#logger?.info("session created", { sessionId, agentId: spec.agentId });
    return this.#meta(sessionId);
  }

  /**
   * 恢复路径：按 `agentId + cwd` 认领既有会话（取最新一条），只记元数据、不拉子进程。
   * **仅供装配层启动时逐会话调用一次**（重复认领会顶掉活动的 agent 侧句柄）。
   *
   * @param spec - 手机侧会话描述，取其 `agentId`/`cwd` 匹配既有会话
   * @param kind - 认领后的生命周期形态
   * @param resumeHint - 续接线索；`archived` 态为 `undefined`
   * @returns Promise，resolve 为认证领会话的元数据
   * @throws `session not found`：找不到匹配的既有会话
   * 副作用：写入编排层会话表
   */
  async #adopt(spec: SessionSpec, kind: LifecycleKind, resumeHint: string | undefined): Promise<SessionMeta> {
    const metas = await this.#conversations.listSessions();
    // 取最新一条（listSessions 按 createdAt 升序）：同 (agentId, cwd) 的历史会话可能不止一条。
    const meta = [...metas].reverse().find((m) => m.agentId === spec.agentId && m.cwd === spec.cwd);
    if (meta === undefined) throw new Error("session not found: " + spec.agentId + " @ " + spec.cwd);
    this.#sessions.set(meta.id, {
      spec: { agentId: meta.agentId, cwd: meta.cwd, permissionMode: meta.permissionMode },
      kind,
      state: meta.state,
      agent: undefined,
      hint: resumeHint,
    });
    this.#logger?.info("session adopted", { sessionId: meta.id, agentId: meta.agentId, lifecycle: kind, state: meta.state });
    return meta;
  }

  /**
   * 释放 agent 侧会话句柄（可缺省——恢复态没有子进程）。
   *
   * @param sessionId - 目标会话
   * @param managed - 编排层持有的会话条目
   * @param reason - 释放原因，仅用于诊断
   * @returns Promise，resolve 表示句柄已回收
   * 副作用：清空条目的 agent 引用并终止底层子进程
   */
  async #dispose(sessionId: string, managed: ManagedSession, reason: string): Promise<void> {
    const agent = managed.agent;
    managed.agent = undefined;
    if (agent !== undefined) await agent.dispose(reason);
    this.#logger?.info("session disposed", { sessionId, reason });
  }

  /**
   * 拉起 agent 侧会话，并把 `start()` 失败收敛为「幽灵行恢复」：
   * (1) 已持有句柄则 `#dispose`（不留不可杀子进程）；(2) 置内存状态 `failed`；
   * (3) 经 bus 发布 `{state:"failed"}`（从 `starting` 到 `failed` 在白名单内）并回写 `sessions.state`；
   * (4) **原错误向调用方重新抛出**——装配层据错误文案映射 error 帧，不得吞掉。
   * 三条拉起路径（`create("new")`/`resume`/`restart`）共用此收口，避免失败处理三处漂移。
   * @param sessionId - 目标会话
   * @param managed - 编排层持有的会话条目（`agent` 由本方法写入）
   * @param agent - 刚从适配器 `create()` 得到、尚未 `start()` 的句柄
   * @returns Promise，resolve 表示子进程已成功启动
   * @throws 原 `start()` 抛出的错误（幽灵行已恢复为 `failed`）
   * 副作用：写入条目 agent、必要时回收句柄并发布 failed 事件
   */
  async #startOrRecover(sessionId: string, managed: ManagedSession, agent: AgentSession): Promise<void> {
    managed.agent = agent;
    try {
      await agent.start();
    } catch (err) {
      // (1) 句柄清理（2）失败态落地（3）经 bus 广播 都在 rethrow 之前完成，绝不静默吞错。
      if (managed.agent !== undefined) await this.#dispose(sessionId, managed, "start failed");
      await this.#publishState(sessionId, "failed");
      throw err;
    }
  }

  /**
   * 服务端事实驱动的状态落地：先写内存状态，再回写 `sessions.state`，随后经 bus 发布。
   * 与 emit 路（agent 驱动）分开：`starting`/`stopped` 由编排层定义，属服务端事实，
   * 不过白名单（从 `stopped` 到 `starting` 本就合法但不在表内——表只约束 agent 上报的跃迁）。
   *
   * @param sessionId - 目标会话
   * @param state - 要落地的服务端状态
   * @returns Promise，resolve 表示状态已回写并发布
   * 副作用：改内存状态、回写 sessions.state 列、经总线发布 state 事件
   */
  async #publishState(sessionId: string, state: SessionState): Promise<void> {
    const managed = this.#sessions.get(sessionId);
    if (managed !== undefined) managed.state = state;
    await this.#conversations.updateSession(sessionId, { state });
    await this.#bus.publish(sessionId, { type: "state", state });
  }

  /**
   * agent 事件出口（交给适配器的 `emit`）。
   * `state` 事件先过白名单：非法跃迁改发 `notice{severity:"error", text:"invalid transition <from>→<to>"}` 并保持原状态；
   * 合法跃迁回写 `sessions.state` 后放行。其余事件直通 bus。
   * 契约为同步 `void`：内部用浮动 Promise 承载异步发布，失败自吞（记日志），不产生未处理拒绝。
   *
   * @param sessionId - 事件所属会话
   * @returns 交给适配器的同步 emit 回调；内部异步发布失败只记日志，不向外抛
   */
  #emit(sessionId: string): Emit {
    return (event: AgentEvent): void => {
      const done = event.type === "state"
        ? this.#applyAgentState(sessionId, event.state)
        : this.#bus.publish(sessionId, event);
      void done.catch((err: unknown) => {
        this.#logger?.error("agent event publish failed", { sessionId, error: errorMessage(err) });
      });
    };
  }

  /**
   * 白名单校验 + 状态落地（emit 路的 `state` 分支）。
   * 先同步发起 `bus.publish`（同批 emit 的入队顺序即调用顺序，seq 单调——白名单判定与内存状态
   * 都在同步段完成），再回写状态列（异步 IO 不参与顺序决策）。
   *
   * @param sessionId - 目标会话
   * @param to - agent 上报的目标状态
   * @returns Promise，resolve 表示校验与落地结束（非法跃迁只发 notice）
   * 副作用：合法时改内存状态、发布 state 事件并回写状态列；非法时发布 notice
   */
  async #applyAgentState(sessionId: string, to: SessionState): Promise<void> {
    const managed = this.#sessions.get(sessionId);
    const from = managed?.state ?? "starting";
    if (!canTransition(from, to)) {
      this.#logger?.warn("invalid state transition", { sessionId, from, to });
      await this.#bus.publish(sessionId, { type: "notice", severity: "error", text: `invalid transition ${from}→${to}` });
      return;
    }
    if (managed !== undefined) managed.state = to;
    const published = this.#bus.publish(sessionId, { type: "state", state: to });
    await this.#conversations.updateSession(sessionId, { state: to });
    await published;
  }

  /** 取适配器；未注册即 `session.agent_missing`（与未安装同文案，手机侧只需一个分支）。 */
  #adapter(agentId: string): AgentAdapter {
    const adapter = this.#agents.get(agentId);
    if (adapter === undefined) throw new Error("session.agent_missing: " + agentId);
    return adapter;
  }

  /** 取本实例持有的会话；未知即 `session not found`。 */
  #require(sessionId: string): ManagedSession {
    const managed = this.#sessions.get(sessionId);
    if (managed === undefined) throw new Error("session not found: " + sessionId);
    return managed;
  }

  /**
   * 从仓储读回会话元数据（单一事实源，避免自造 lastSeq/时间戳）。
   *
   * @param sessionId - 目标会话
   * @returns Promise，resolve 为仓储中的会话元数据
   * @throws `session not found`：仓储中找不到该会话
   */
  async #meta(sessionId: string): Promise<SessionMeta> {
    const meta = (await this.#conversations.listSessions()).find((s) => s.id === sessionId);
    if (meta === undefined) throw new Error("session not found: " + sessionId);
    return meta;
  }
}
