import type { MetricsRegistry } from "../observability/metrics.js";
import { randomUUID } from "node:crypto";
import type {
  AgentCommand,
  AgentEvent,
  SessionMeta,
  SessionSpec,
  SessionState,
  SessionPermissionsFrame,
} from "@aimi/protocol";
import type { AgentAdapter, AgentLookup, AgentSession, Emit } from "../agents/types.js";
import { friendlyAgentError, isKnownAgentError } from "../agents/claude/agentErrorText.js";
import type { EventBus } from "../events/eventBus.js";
import type { Logger } from "../logging/logger.js";
import type { ConversationRepository, ProcessLedgerRepository } from "../persistence/types.js";
import { allowedModes, applyPermissionPolicy, legacyPermissionModes } from "../agents/permissions.js";
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
  return Object.entries(TRANSITIONS).some(([candidate, targets]) => candidate === state && targets.length === 0);
}

/** 编排层持有的一条会话（唯一状态源在进程内；`conversations` 的 state 列与之同步维护）。 */
interface ManagedSession {
  /** 拉起/重挂所用的 spec：`new` 为调用方原样传入；恢复路径由仓储元数据重建（不带 initialPrompt） */
  spec: SessionSpec;
  /** 生命周期形态（`create`/`adopt` 时确定） */
  readonly kind: LifecycleKind;
  /** 当前状态 */
  state: SessionState;
  /** 活动 agent 侧会话；恢复态（不拉子进程）与已停止的会话为 `undefined` */
  agent: AgentSession | undefined;
  /** 续接线索：运行时从 `runtime()` 采集回写/` willinglyadopt` 注入，`resume` 与 send 续接路径取出交给适配器 */
  hint: string | undefined;
  /** 活动句柄的抑制令牌：每次 `adapter.create` 生成新 token；无句柄（恢复态/已回收）为 `undefined` */
  handleToken: symbol | undefined;
  /**
   * 已作废句柄的 token 集：stop/restart/启动失败作废旧句柄后，其 stdout 残流里的迟到
   * `state` 帧一律丢弃（`exit` 等非 state 事件照常放行）。**按句柄而非按会话抑制**——
   * 新句柄的 token 不在集内，正常事件流不受染（restart 后新句柄的 init→running 必须照常入册）。
   */
  readonly staleTokens: Set<symbol>;
  /** 已登记台账的 pid（运行时采集用：pid 变更才重复登记）。 */
  registeredPid: number | undefined;
  /** 当前句柄在等待态异常退出后，下一次续接需先使挂起卡失效。 */
  pendingCardInvalidation: boolean;
  /**
   * fork 延迟启动标记（持久化于 sessions.fork_pending，经 adopt 恢复）：首条 send/续接
   * 必须带 fork 旗——CLI 侧产出**新**会话 id；否则 fork 会与源会话共用同一条 CLI 线程。
   * 首次 init 回写新 hint 后本标记自然失效（fork_pending 随后清零）。
   */
  forkOnResume: boolean;
}

/** 把错误收敛为日志字段（不抛地记日志）。 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 会话编排核心：三种生命周期形态的统一入口、状态跃迁白名单把关、指令转发与会话门三路。
 *
 * - `create`：
 *   - `"new"`：先校验适配器（未注册或未安装时报 `session.agent_missing`），再原子建会话行，
 *     经 bus 发布 `{state:"starting"}`（seq 0，先于适配器落地），最后拉起 agent 侧会话。
 *   - `"resumable"`/`"archived"`：按 `agentId + cwd` 认领仓储里的既有会话并记 lifecycle，
 *     **不拉子进程**（防重启后半夜复活烧 token）。两者差别只在 `resume`：`"resumable"`
 *     （有续接线索）可重挂；`"archived"`（历史可查不可续跑）一律拒绝续接。
 * - `adopt(meta, resumeHint?)`：启动恢复专用——kind 依 hint 有无派生（resumable/archived），
 *   同名同源 `bus.seedSession` 播种序号。
 * - 状态白名单只在本类的 emit 包装层生效（`bus` 本身不做校验）；生命周期自身驱动的
 *   `starting`/`stopped` 属于服务端事实，不经白名单（从 `stopped` 到 `starting` 不在表内）。
 * - **会话门三路（send 语义）**：活句柄原路交付（终态开新回合先发服务端事实 starting——
 *   FACT1：同进程下一回合 CLI 重发 init→running，白名单自此合法）；死句柄 + resumable + hint
 *   → send 即续接；死句柄无 hint / archived → `"expired"`（不改库不起进程）；未知会话 → `"inactive"`。
 * - **运行时采集**（emit 包装层每次事件后）：`agent.runtime?.()` 拉取 pid/hint——pid 首现/变更
 *   登记 `ledger`（F5 防线数据面），hint 首现/变更回写 `resume_hint`；`#dispose` 后清台账。
 * - seq 唯一权威在 `EventBus`：本类只发布，不自行编号。
 *
 * **start 失败自动落 failed 并清理句柄（幽灵行恢复）**：三条拉起路径（`create("new")`/`resume`/
 * send 续接/`restart`）中 `adapter.start()` 抛错时，先 `#dispose` 已建句柄、把内存状态与
 * `sessions.state` 置 `failed`，并经 bus 发布 `{state:"failed"}`（从 `starting` 到 `failed` 在白名单内），
 * **随后仍把原错误抛出**——装配层据错误文案映射 error 帧，不得吞掉。
 *
 * **遗留警示（当前版本不处理）**：
 * - 恢复路径（`"resumable"`/`"archived"`）**仅供装配层启动时逐会话调用一次**：对已持有且活动的
 *   会话重复认领会用新条目顶掉旧条目，导致活的 agent 侧句柄无人 `dispose`（子进程泄漏）。
 */
export class SessionManager {
  /** 编排层视图，按 sessionId 索引。 */
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #metricsRegistry: MetricsRegistry | undefined;
  readonly #metricRetire = new WeakMap<AgentSession, { retire: () => void; close: () => void }>();
  readonly #turnStarts = new Map<string, number>();
  readonly #conversations: ConversationRepository;
  readonly #bus: EventBus;
  readonly #agents: AgentLookup;
  /** 进程台账（可缺省——单测极简环境不挂）：采集登记 pid、dispose 撤销。 */
  readonly #ledger: ProcessLedgerRepository | undefined;
  readonly #logger: Logger | undefined;
  /** 服务端数据目录（可选）：审批闸 permDir 派生用；缺省（极简单测）时 create 不带闸上下文 */
  readonly #dataDir: string | undefined;
  readonly #permissionCeiling: SessionSpec["permissionMode"];
  readonly #allowedPermissionModes: Readonly<Record<string, readonly string[]>> | undefined;
  readonly #onPermissions: ((frame: SessionPermissionsFrame) => void) | undefined;
  readonly #configuring = new Set<string>();
  readonly #permissionSync = new Map<string, Promise<void>>();

  /**
   * @param deps.conversations - 会话/事件仓储（唯一能写 sessions+events 的人）
   * @param deps.bus - 事件总线（seq 唯一权威；本类经它发布全部 agent 事件）
   * @param deps.agents - 适配器查找面
   * @param deps.ledger - 可选进程台账（缺省 no-op——缺省时运行时不登记 pid）
   * @param deps.logger - 可选日志门面；缺省时不产生日志
   * @param deps.dataDir - 可选服务端数据目录（审批闸 permDir 派生根；缺省时适配器不收闸上下文）
   */
  constructor(deps: {
    conversations: ConversationRepository;
    bus: EventBus;
    agents: AgentLookup;
    ledger?: ProcessLedgerRepository;
    logger?: Logger;
    dataDir?: string;
    permissionCeiling?: SessionSpec["permissionMode"];
    allowedPermissionModes?: Readonly<Record<string, readonly string[]>>;
    onPermissions?: (frame: SessionPermissionsFrame) => void;
    metrics?: MetricsRegistry;
  }) {
    this.#metricsRegistry = deps.metrics;
    this.#conversations = deps.conversations;
    this.#bus = deps.bus;
    this.#agents = deps.agents;
    this.#ledger = deps.ledger;
    this.#logger = deps.logger;
    this.#dataDir = deps.dataDir;
    this.#permissionCeiling = deps.permissionCeiling ?? "default";
    this.#allowedPermissionModes = deps.allowedPermissionModes;
    this.#onPermissions = deps.onPermissions;
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
   * 分叉：以源会话的 agent 侧续接线索新开一个 aimi 会话（SDK `forkSession` 语义——
   * 源会话历史与其续接线索不动，新会话从分叉点继续，事件流不复制历史）。
   * 源会话无论运行中或终态都可分叉；线索以仓储为准（运行时 hint 变更已回写），
   * 仓储缺失时兜底内存值。新会话的 agent 侧 id 由 init 事件回写（forkSession 产出新 id）。
   *
   * 分叉走适配器能力声明（`AgentAdapter.forkCapable`）：没有「从既有线索派生新 agent
   * 会话」机制的 CLI（如 zcode）拒绝分叉——伪分叉会让两条 aimi 会话争写同一续接线索。
   *
   * @param sourceId - 源会话 id（aimi 侧）
   * @returns Promise，resolve 为新会话元数据
   * @throws `session not found`：源会话未登记
   * @throws `session.fork.unsupported`：源会话 agent 不支持分叉（zcode）
   * @throws `session.fork.no_hint`：源会话无续接线索（archived），不可分叉
   * 副作用：新会话行落库（finished/fork_pending/resume_hint）并登记编排层；不拉子进程
   */
  async fork(sourceId: string): Promise<SessionMeta> {
    const managed = this.#sessions.get(sourceId);
    if (managed === undefined) throw new Error("session not found: " + sourceId);
    if (this.#agents.get(managed.spec.agentId)?.forkCapable !== true) {
      throw new Error("session.fork.unsupported: " + managed.spec.agentId);
    }
    const stored = await this.#conversations.getSessionHint(sourceId);
    const hint = stored ?? managed.hint;
    if (hint === undefined || hint === "") throw new Error("session.fork.no_hint");
    return this.#createDeferredFork(managed.spec, hint);
  }

  /**
   * 启动恢复（装配层装配期专用）：把仓储既有会话登记进编排层并播种 seq 计数器到 `lastSeq + 1`，
   * 保证重启后新事件序号不与既有事件撞车。kind 依 `resumeHint` 有无派生：
   * 有 → `"resumable"`（有续接线索，`resume`/send 续接可跑）；无 → `"archived"`
   * （历史可查不可续跑）。状态经 [#reconcileAdoptedState] 收敛：重启后不可能有活句柄，
   * 活动态幽灵行一律落 `failed`（与 start 失败自动落 failed 同口径），不再如实呈现。
   * **仅启动装配期逐会话调用一次**：重复认领会用新条目顶掉活动句柄导致子进程泄漏。
   *
   * @param meta - 仓储读回的会话元数据（`id`/`lastSeq` 以它为准，`state` 可能被收敛改写）
   * @param resumeHint - 仓储侧续接线索（`getSessionHint` 读出）；null 缺省即按 archived 认领
   * @returns Promise，resolve 表示该会话已登记且计数器已播种
   * 副作用：写入编排层会话表，播种事件总线计数器，活动态行落库改写为 failed
   */
  async adopt(meta: SessionMeta, resumeHint?: string | null): Promise<void> {
    const hint = resumeHint ?? undefined;
    const effective = await this.#reconcileAdoptedState(meta);
    const forkPending = await this.#conversations.getForkPending(effective.id);
    this.#sessions.set(effective.id, {
      spec: {
        agentId: effective.agentId,
        cwd: effective.cwd,
        permissionMode: effective.permissionMode,
        model: effective.model,
      },
      kind: hint !== undefined && hint !== "" ? "resumable" : "archived",
      state: effective.state,
      agent: undefined,
      hint,
      handleToken: undefined,
      staleTokens: new Set(),
      registeredPid: undefined,
      pendingCardInvalidation: false,
      forkOnResume: forkPending,
    });
    this.#bus.seedSession(effective.id, effective.lastSeq + 1);
    this.#logger?.info("session adopted", {
      sessionId: effective.id,
      agentId: effective.agentId,
      lastSeq: effective.lastSeq,
      resumable: this.#sessions.get(effective.id)?.kind === "resumable",
    });
  }

  /**
   * 启动认领的活动态收敛：重启后不可能有活句柄（孤儿清点在先、句柄台账为空），
   * 仓储里 `starting`/`running` 的行是崩溃/重启前遗留的幽灵呈现——一律落 `failed`
   * 并以修正后的 meta 返回；终态行原样返回不改库。
   * resume_hint/fork_pending 不动：failed + hint 走既有「send 即续接」路径，会话可救。
   *
   * @param meta - 仓储读回的会话元数据
   * @returns 修正后的元数据（活动态 → failed；其余原样引用）
   * 副作用：活动态行经 updateSession 落库改写为 failed
   */
  async #reconcileAdoptedState(meta: SessionMeta): Promise<SessionMeta> {
    if (meta.state !== "starting" && meta.state !== "running") return meta;
    await this.#conversations.updateSession(meta.id, { state: "failed" });
    this.#logger?.info("session reconciled", {
      sessionId: meta.id,
      from: meta.state,
      state: "failed",
    });
    return { ...meta, state: "failed" };
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
    this.#validatePermission(managed.spec.agentId, managed.spec.permissionMode);
    await this.#invalidatePendingCards(sessionId, managed); // 防御性对称：守卫放宽时挂起卡失效先行（见 TSDoc）
    await this.#publishState(sessionId, "starting");
    const token = Symbol("agent-handle");
    managed.handleToken = token;
    const agent =
      managed.hint === undefined
        ? adapter.create(managed.spec, this.#emit(sessionId, token), undefined, this.#gateContext(sessionId))
        : adapter.create(
            managed.spec,
            this.#emit(sessionId, token),
            { hint: managed.hint },
            this.#gateContext(sessionId),
          );
    await this.#startOrRecover(sessionId, managed, agent);
    this.#logger?.info("session resumed", { sessionId, agentId: managed.spec.agentId });
    return this.#meta(sessionId);
  }

  /**
   * 停止会话：经 bus 发布 `{state:"stopped"}`（服务端事实先行）+ dispose agent 侧会话。
   * **幂等**：已处终态直接返回（不重复 dispose、不重复发事件）。
   * **残流抑制先行**：决定停止的一刻起，当前句柄 token 即入弃置名单——killTree 前后旧进程的迟到
   * `state` 事件被 emit 包装层丢弃（`exit` 等非 state 照常放行），不再洗掉服务端事实状态。
   *
   * @param sessionId - 目标会话
   * @returns Promise，resolve 表示会话已停止（原本已终态时立即 resolve）
   * @throws `session not found: <sessionId>`：本实例未持有该会话
   * 副作用：发布 stopped 事件、释放 agent 侧子进程并清台账
   */
  async stop(sessionId: string): Promise<void> {
    const managed = this.#require(sessionId);
    if (isTerminal(managed.state)) return;
    // 残流抑制先行（按句柄 token）：决定停止的一刻起，该句柄的迟到 state 帧即入弃置名单。
    if (managed.handleToken !== undefined) managed.staleTokens.add(managed.handleToken);
    await this.#publishState(sessionId, "stopped");
    await this.#dispose(sessionId, managed, "stop");
  }

  /**
   * 重启会话：非终态先 `stop`（stopped 事件 + dispose），再以原 spec 重新拉起 agent 侧会话
   * （**同一 aimi sessionId**，seq 连续，**带 `managed.hint` 续接同一 agent 侧上下文**）并发布
   * `{state:"starting"}`（服务端事实先行）。
   *
   * **句柄回收**：重挂前凡持有 agent 句柄一律 dispose——自然终态（agent 自报
   * `finished`/`failed`）不经过 `stop`，句柄仍在，跳过回收会让旧子进程孤儿。`stop` 的终态幂等语义不变。
   * **残流抑制**：被回收句柄的 token 随 `#dispose` 入弃置名单，其迟到的 `state` 帧永久丢弃；
   * 新句柄持有**新 token**，正常事件流（init→running）不受染、照常入册。
   *
   * @param sessionId - 目标会话
   * @returns Promise，resolve 表示已重新拉起（终态直接重启，非终态先停止）
   * @throws `session not found: <sessionId>`：本实例未持有该会话
   * 副作用：必要时停止并回收旧句柄、发布 starting 事件并以续接线索拉起新子进程
   */
  async restart(sessionId: string): Promise<void> {
    const managed = this.#require(sessionId);
    this.#validatePermission(managed.spec.agentId, managed.spec.permissionMode);
    if (!isTerminal(managed.state)) await this.stop(sessionId);
    if (managed.agent !== undefined) await this.#dispose(sessionId, managed, "restart");
    const adapter = this.#adapter(managed.spec.agentId);
    await this.#publishState(sessionId, "starting");
    const token = Symbol("agent-handle");
    managed.handleToken = token;
    await this.#startOrRecover(
      sessionId,
      managed,
      adapter.create(
        managed.spec,
        this.#emit(sessionId, token),
        managed.hint !== undefined && managed.hint !== ""
          ? { hint: managed.hint, fork: managed.forkOnResume || undefined }
          : undefined,
        this.#gateContext(sessionId),
      ),
    );
    this.#logger?.info("session restarted", {
      sessionId,
      agentId: managed.spec.agentId,
      resumedFromHint: managed.hint ?? null,
    });
  }

  /**
   * 会话门三路：把一条手机指令交给会话（`PhoneCommandPipe` 的唯一出口）。
   *
   * 1. **活句柄**：原路交付。自然终态（`finished`/`stopped` 且句柄在）也开新回合交付——
   *    claude 多回合事实（spike FACT1：同进程下一回合 CLI 重发 init），交付前先发服务端事实
   *    `starting`，否则下一回合 init 映射的 running 会被白名单判非法（终态出度为 0）。
   *    `approve` 只在 `waiting_approval` 放行（waiting 门，Task 7）——其余状态消费为失效 notice。
   * 2. **死句柄 + `"resumable"` + hint**：`send` 即续接——挂起卡失效标注（waiting 前置态）→
   *    发布 starting（服务端事实）→ `adapter.create(spec, emit, {hint}, context)`（`--resume`
   *    拉起新进程 + 闸上下文）→ `#startOrRecover` → 交付指令。
   * 3. **死句柄，无 hint 或 `"archived"`**：返 `"expired"`（不改库、不起进程、不发事件）。
   *    未知会话返 `"inactive"`。
   *
   * @param sessionId - 目标会话
   * @param cmd - 已归一化的手机指令（`stop`/`restart` 走本类的 `stop`/`restart`，不经此路）
   * @returns `delivered`=已交付（含续接后的首条指令）；`inactive`=会话未知/不可达；
   *          `expired`=历史仍在但已无续接可能
   * @throws `session.agent_missing: <agentId>`：续接路径适配器未注册或未装（与 create 同源）
   * @throws `start()` 的原始错误：续接路径幽灵行已恢复为 failed（会话仍保留，可再走续接）
   * 副作用：路 1/2 交付指令（路 2 拉起子进程并登记台账，waiting 前置态先发失效标注）；
   *         非等待态的 approve 消费为一条失效 notice；路 3 无副作用
   */
  async send(sessionId: string, cmd: AgentCommand): Promise<"delivered" | "inactive" | "expired"> {
    const managed = this.#sessions.get(sessionId);
    if (managed === undefined) return "inactive";

    // 审批/提问 waiting 门（Task 7）：晚到的 approve/answer 不静默吞、不代答（v1 Q3）——
    // 消费为一条失效 notice 即返回（不写 CLI、不改状态、不触发续接）。
    if (cmd.cmd === "approve" && managed.state !== "waiting_approval") {
      await this.#bus.publish(sessionId, { type: "notice", severity: "warn", text: "审批已失效（会话已不在等待态）" });
      return "delivered";
    }
    if (cmd.cmd === "answer" && managed.state !== "waiting_input") {
      // why 同款门：claude 无提问通道（spike FACT5）当前不可达，但 waiting_input 是协议态——
      // 其他 agent 未来进入该态时 answer 门必须已在；顺带堵"死句柄 answer 触发无谓续接拉进程"。
      await this.#bus.publish(sessionId, { type: "notice", severity: "warn", text: "提问已失效（会话已不在等待态）" });
      return "delivered";
    }

    // 会话门路 1：活句柄（isAlive 探针——进程退出/崩溃后句柄仍在但 stdin 已是死管道，
    // 写入会被静默丢弃，必须分流到续接路径；无探针的简易实现按"句柄在即活"兼容口径）。
    if (managed.agent !== undefined && (managed.agent.isAlive?.() ?? true)) {
      if (isTerminal(managed.state)) await this.#publishState(sessionId, "starting");
      // 当前句柄的 token 不可能在弃置名单（入名单必先回收句柄）——新回合事件流天然照常入册。
      await managed.agent.send(cmd);
      return "delivered";
    }

    // 会话门路 2：死句柄/无句柄 + 续接线索 → send 即续接（免冷启动窗口里的状态等待，即刻拉起）。
    // 判据只看 hint 不看 kind：`new` 会话进程死后同样有 hint 可续（运行时采集所得）；
    // `archived` 天然无 hint，被 hint 判定自然排除。
    if (managed.hint !== undefined && managed.hint !== "") {
      this.#validatePermission(managed.spec.agentId, managed.spec.permissionMode);
      await this.#invalidatePendingCards(sessionId, managed); // 恢复前置态的挂起审批卡失效标注（先于 starting）
      await this.#publishState(sessionId, "starting");
      const adapter = this.#adapter(managed.spec.agentId);
      const token = Symbol("agent-handle");
      managed.handleToken = token;
      const agent = adapter.create(
        managed.spec,
        this.#emit(sessionId, token),
        { hint: managed.hint, fork: managed.forkOnResume || undefined },
        this.#gateContext(sessionId),
      );
      await this.#startOrRecover(sessionId, managed, agent);
      await agent.send(cmd);
      return "delivered";
    }

    // 会话门路 3：历史定格（stopped/new 且无 hint、archived）——send 只能拒之门外。
    return "expired";
  }

  /** 返回服务端策略和当前句柄共同裁决后的目录，不假定模式存在大小关系。 */
  permissionModes(agentId: string, sessionId?: string) {
    const managed = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    const modes =
      managed?.agent?.permissionModes?.() ?? this.#agents.get(agentId)?.permissionModes?.() ?? legacyPermissionModes();
    return applyPermissionPolicy(modes, this.#allowed(agentId));
  }

  /** 每个字段先得到 SDK 确认再持久化；组合修改部分失败时保留已确认字段。 */
  async configure(
    sessionId: string,
    patch: { model?: string; permissionMode?: SessionSpec["permissionMode"] },
  ): Promise<void> {
    const managed = this.#require(sessionId);
    if (managed.state === "waiting_approval" || managed.state === "waiting_input") {
      throw new Error("session configure unavailable while waiting");
    }
    if (patch.permissionMode !== undefined) {
      this.#validatePermission(managed.spec.agentId, patch.permissionMode);
    }
    await this.#permissionSync.get(sessionId);
    this.#configuring.add(sessionId);
    try {
      const agent = managed.agent;
      if (agent !== undefined && (agent.isAlive?.() ?? true)) {
        if (patch.model !== undefined) {
          await this.#configureField(sessionId, managed, agent, { model: patch.model });
        }
        if (patch.permissionMode !== undefined) {
          this.#validatePermission(managed.spec.agentId, patch.permissionMode, sessionId);
          await this.#configureField(sessionId, managed, agent, { permissionMode: patch.permissionMode });
        }
      } else {
        // 无运行进程时只是下次启动配置；重启失败仍保留明确请求的配置。
        await this.#conversations.updateSession(sessionId, patch);
        managed.spec = { ...managed.spec, ...patch };
        if (agent !== undefined || managed.hint !== undefined) {
          await this.restart(sessionId);
        }
      }
    } finally {
      this.#configuring.delete(sessionId);
      await this.#collectRuntime(sessionId);
      this.#notifyPermissions(sessionId);
    }
  }

  /** 保存失败时尝试恢复 SDK；恢复不了就回收句柄，不继续运行未保存配置。 */
  async #configureField(
    sessionId: string,
    managed: ManagedSession,
    agent: AgentSession,
    patch: { model?: string; permissionMode?: string },
  ): Promise<void> {
    const previous =
      patch.permissionMode === undefined
        ? { model: managed.spec.model }
        : { permissionMode: managed.spec.permissionMode };
    await agent.send({ cmd: "configure", ...patch });
    const confirmed =
      patch.permissionMode === undefined
        ? patch
        : { permissionMode: agent.runtime?.()?.permissionMode ?? patch.permissionMode };
    try {
      await this.#conversations.updateSession(sessionId, confirmed);
    } catch (err) {
      let restored = false;
      if (previous.permissionMode !== undefined || previous.model !== undefined) {
        try {
          await agent.send({ cmd: "configure", ...previous });
          restored = true;
        } catch {
          // 回滚失败走统一回收分支，原始持久化错误仍是命令失败原因。
        }
      }
      if (!restored) {
        try {
          await this.#dispose(sessionId, managed, "configuration persistence failed");
        } finally {
          await this.#publishState(sessionId, "failed");
        }
      }
      throw err;
    }
    managed.spec = { ...managed.spec, ...confirmed };
  }

  /** 所有入口复用同一授权集合，未知模式不得绕过适配器目录。 */
  #validatePermission(agentId: string, mode: string, sessionId?: string): void {
    const descriptor = this.permissionModes(agentId, sessionId).find((candidate) => candidate.id === mode);
    if (descriptor === undefined || descriptor.availability === "unavailable") {
      throw new Error("permission mode exceeds configured ceiling or unavailable: " + (descriptor?.reason ?? mode));
    }
  }

  /** 新配置集合覆盖该 agent 的旧上限迁移结果。 */
  #allowed(agentId: string): ReadonlySet<string> {
    const explicit = Object.entries(this.#allowedPermissionModes ?? {}).find(([id]) => id === agentId)?.[1];
    return allowedModes(this.#permissionCeiling, explicit);
  }

  /** 权限状态不占事件序号、不写时间线，只通知支持动态能力的连接。 */
  #notifyPermissions(sessionId: string): void {
    const managed = this.#sessions.get(sessionId);
    if (managed === undefined) return;
    this.#onPermissions?.({
      v: 1,
      type: "session.permissions",
      sessionId,
      currentMode: managed.spec.permissionMode,
      modes: this.permissionModes(managed.spec.agentId, sessionId),
    });
  }

  /**
   * 打断活动会话：写 interrupt 控制帧，随后经 bus 发布 `{state:"stopped"}`（服务端事实先行，
   * SPIKE FACT2 校准——CLI 随后到货的 `error_during_execution` 映射同态重复，由 emit 包装层去重）。
   * **不 dispose**：headless CLI 打断后进程存活，会话门路 1 可立即同进程开新回合（免冷启动红利）。
   * 死句柄下是查询语义：不可用分流与 `send` 同口径（resumable+hint → `inactive`，否则 `expired`），
   * 但**绝不复活子进程**。
   *
   * @param sessionId - 目标会话
   * @returns `delivered`=控制帧已发出（含服务端事实落地）；`inactive`=会话未知或统一非鲜活可引；
   *          `expired`=已无任何交互可能
   * 副作用：活句柄写控制帧、发布 stopped 事件；死句柄无副作用
   */
  async interrupt(sessionId: string): Promise<"delivered" | "inactive" | "expired"> {
    const managed = this.#sessions.get(sessionId);
    if (managed === undefined) return "inactive";

    if (managed.agent === undefined || !(managed.agent.isAlive?.() ?? true)) {
      // 死句柄（含进程已退出的僵句柄）是查询语义：绝不复活子进程，分流口径与 send 一致。
      return managed.hint !== undefined && managed.hint !== "" ? "inactive" : "expired";
    }
    await managed.agent.send({ cmd: "interrupt" });
    if (managed.state !== "stopped") {
      // 服务端事实先行：stopped 即刻入册（不经白名单），CLI 迟到的同态帧由 emit 层去重。
      await this.#publishState(sessionId, "stopped");
    }
    return "delivered";
  }

  /** 全新会话的拉起路径：校验适配器、原子建行、发布 starting 后再拉起子进程。 */
  async #createNew(spec: SessionSpec): Promise<SessionMeta> {
    const adapter = this.#adapter(spec.agentId);
    this.#validatePermission(spec.agentId, spec.permissionMode);
    const installed = await adapter.isInstalled();
    if (!installed.ok) throw new Error("session.agent_missing: " + spec.agentId);

    const sessionId = randomUUID();
    await this.#conversations.createSession(
      {
        id: sessionId,
        agentId: spec.agentId,
        cwd: spec.cwd,
        permissionMode: spec.permissionMode,
        model: spec.model,
        initialPrompt: spec.initialPrompt,
      },
      null,
    );

    const managed: ManagedSession = {
      spec,
      kind: "new",
      state: "starting",
      agent: undefined,
      hint: undefined,
      handleToken: undefined,
      staleTokens: new Set(),
      registeredPid: undefined,
      pendingCardInvalidation: false,
      forkOnResume: false,
    };
    this.#sessions.set(sessionId, managed);
    // 起始态先入 seq（与其它拉起路径同一处理）：`starting` 恒为该会话第一条事件，
    // 适配器在 `start()` 期间同步 emit 的任何事件都只会在其后（白名单语义不变——内存状态早已是 starting）。
    await this.#publishState(sessionId, "starting");
    const token = Symbol("agent-handle");
    managed.handleToken = token;
    await this.#startOrRecover(
      sessionId,
      managed,
      adapter.create(spec, this.#emit(sessionId, token), undefined, this.#gateContext(sessionId)),
    );
    this.#logger?.info("session created", { sessionId, agentId: spec.agentId });
    return this.#meta(sessionId);
  }

  /**
   * 分叉的延迟启动落库（反馈 #8d81bf②）：**不拉子进程、不发 starting**——只建会话行
   * （hint=源 hint、fork_pending=1、state=finished「就绪未跑」）并登记编排层。
   *
   * why 不在 fork 时拉起：fork 没有首条 user 帧，init 看门狗永不武装，CLI init 一旦
   * 失败即永久 `starting`（真机表现为看板上永久转圈）；且 fork 即拉起会立刻烧 token。
   * 延迟后，首条 send 走「死句柄+resumable+hint → send 即续接」路径，看门狗随首帧武装。
   *
   * why state=finished：渲染为「就绪」勾形而非转圈；首条 send 经 `#publishState`
   * 翻回 starting（服务端事实），语义连贯。
   *
   * @param spec - 源会话 spec（initialPrompt 剥离——分叉不预置输入）
   * @param hint - 源会话的 agent 侧续接线索
   * @returns Promise，resolve 为新会话元数据
   * 副作用：会话行落库（finished/fork_pending=1/resume_hint=hint）、登记编排层
   */
  async #createDeferredFork(spec: SessionSpec, hint: string): Promise<SessionMeta> {
    const sessionId = randomUUID();
    await this.#conversations.createSession(
      {
        id: sessionId,
        agentId: spec.agentId,
        cwd: spec.cwd,
        permissionMode: spec.permissionMode,
        model: spec.model,
        forkPending: true,
      },
      null,
    );
    const managed: ManagedSession = {
      spec: { ...spec, initialPrompt: undefined },
      kind: "resumable",
      state: "finished",
      agent: undefined,
      hint,
      handleToken: undefined,
      staleTokens: new Set(),
      registeredPid: undefined,
      pendingCardInvalidation: false,
      forkOnResume: true,
    };
    this.#sessions.set(sessionId, managed);
    // 行级补写：createSession 恒置 starting，延迟启动行要的就绪态/继承线索/分叉标记在此落库。
    await this.#conversations.updateSession(sessionId, { state: "finished", resumeHint: hint });
    // state 事件广播给在线手机（新会话无首事件无法被镜像收录，但 Seq 水位先入册；
    // 手机侧会话元数据在下次 welcome 对齐——与 1.3.6 的 starting 广播同口径）。
    await this.#publishState(sessionId, "finished");
    this.#logger?.info("session forked (deferred)", { sessionId, agentId: spec.agentId });
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
    const found = [...metas].reverse().find((m) => m.agentId === spec.agentId && m.cwd === spec.cwd);
    if (found === undefined) throw new Error("session not found: " + spec.agentId + " @ " + spec.cwd);
    // 同 adopt：认领即收敛活动态幽灵行（重启后不可能有活句柄）。
    const meta = await this.#reconcileAdoptedState(found);
    const forkPending = await this.#conversations.getForkPending(meta.id);
    this.#sessions.set(meta.id, {
      spec: { agentId: meta.agentId, cwd: meta.cwd, permissionMode: meta.permissionMode, model: meta.model },
      kind,
      state: meta.state,
      agent: undefined,
      hint: resumeHint,
      handleToken: undefined,
      staleTokens: new Set(),
      registeredPid: undefined,
      pendingCardInvalidation: false,
      forkOnResume: forkPending,
    });
    this.#logger?.info("session adopted", {
      sessionId: meta.id,
      agentId: meta.agentId,
      lifecycle: kind,
      state: meta.state,
    });
    return meta;
  }

  /**
   * 释放 agent 侧会话句柄（可缺省——恢复态没有子进程），随后撤销台账登记：
   * dispose 即收尸，pid 不再值得复认（孤儿清点只对"落库滞留"行负责）。
   *
   * @param sessionId - 目标会话
   * @param managed - 编排层持有的会话条目
   * @param reason - 释放原因，仅用于诊断
   * @returns Promise，resolve 表示句柄与台账均已回收
   * 副作用：清空条目的 agent 引用并终止底层子进程、调 `ledger.clear`（可缺省）
   */
  async #dispose(sessionId: string, managed: ManagedSession, reason: string): Promise<void> {
    const agent = managed.agent;
    managed.agent = undefined;
    // 作废句柄的 token 入弃置名单：其残流的迟到 state 帧此后永久丢弃（stop 的决策点已加过一次，幂等）。
    if (managed.handleToken !== undefined) managed.staleTokens.add(managed.handleToken);
    try {
      if (agent !== undefined) await agent.dispose(reason);
    } finally {
      if (agent !== undefined) this.#retireMetrics(agent);
      await this.#ledger?.clear(sessionId); // 收尸与撤销同一事务语义：清点面不再出现已收尸的 pid
    }
    this.#logger?.info("session disposed", { sessionId, reason });
  }

  /** 退休后的提供者仍由采集器排干尾部记录，不因句柄替换立即丢失。 */
  #retireMetrics(agent: AgentSession): void {
    const registration = this.#metricRetire.get(agent);
    registration?.retire();
    this.#metricRetire.delete(agent);
    registration?.close();
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
    if (this.#metricsRegistry !== undefined) {
      const provider = agent.metrics();
      const retire = this.#metricsRegistry.register(provider);
      const close =
        typeof (provider as unknown as { close?: unknown }).close === "function"
          ? () => (provider as unknown as { close: () => void }).close()
          : () => {};
      this.#metricRetire.set(agent, { retire, close });
    }
    try {
      await agent.start();
      this.#notifyPermissions(sessionId);
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
    const seq = await this.#bus.publish(sessionId, { type: "state", state });
    if (state === "starting") this.#turnStarts.set(sessionId, seq);
  }

  /**
   * agent 事件出口（交给适配器的 `emit`）。
   * `state` 事件先过白名单：非法跃迁改发 `notice{severity:"error", text:"invalid transition <from>→<to>"}` 并保持原状态；
   * 合法跃迁回写 `sessions.state` 后放行。其余事件直通 bus。
   * **每次事件后拉取运行时事实**（`#collectRuntime`）：pid/hint 的登记与回写是台账/续接面的数据源。
   * 契约为同步 `void`：内部用浮动 Promise 承载异步发布，失败自吞（记日志），不产生未处理拒绝。
   *
   * @param sessionId - 事件所属会话
   * @param token - 发出事件的句柄 token（残流抑制的判定键）
   * @returns 交给适配器的同步 emit 回调；内部异步发布失败只记日志，不向外抛
   */
  #emit(sessionId: string, token: symbol | undefined): Emit {
    return (event: AgentEvent): Promise<unknown> => {
      let done: Promise<unknown>;
      if (event.type === "state") {
        done = this.#applyAgentState(sessionId, event.state, token);
      } else if (event.type === "exit") {
        const managed = this.#sessions.get(sessionId);
        const isCurrentHandle =
          token !== undefined && managed?.handleToken === token && !managed.staleTokens.has(token);
        done = isCurrentHandle ? this.#applyAgentExit(sessionId, managed, event) : this.#bus.publish(sessionId, event);
      } else {
        // 错误类 text_delta（CLI 合成回复，如 API 403）：已知特征映射为友好文案再下发，
        // 原文先落服务端日志——手机与库里的文本是产品文案，排障靠日志原文。
        if (event.type === "text_delta" && event.error === true && isKnownAgentError(event.text)) {
          this.#logger?.warn("agent error output", { sessionId, raw: event.text });
          done = this.#bus.publish(sessionId, { ...event, text: friendlyAgentError(event.text) });
        } else {
          done = this.#bus.publish(sessionId, event);
        }
      }
      void done.catch((err: unknown) => {
        this.#logger?.error("agent event publish failed", { sessionId, error: errorMessage(err) });
      });
      // 运行时采集为独立浮动链：台账/回写故障不得反向影响事件流（内部自吞异常）。
      void this.#collectRuntime(sessionId);
      return done;
    };
  }

  /**
   * 把当前句柄退出收敛为失败态；终态退出只保留原始 exit 时间线事件。
   * notice 与 failed 必须先于 exit 发布，使客户端先看到结果状态再看到进程事实。
   *
   * @param sessionId - 事件所属会话
   * @param managed - 当前会话条目
   * @param event - agent 子进程退出事实
   * @returns Promise，resolve 表示必要的失败状态与原始退出事件均已发布
   * 副作用：活动会话时发布 notice、回写 failed 状态并发布 exit
   */
  async #applyAgentExit(
    sessionId: string,
    managed: ManagedSession,
    event: Extract<AgentEvent, { type: "exit" }>,
  ): Promise<void> {
    if (
      managed.state === "starting" ||
      managed.state === "running" ||
      managed.state === "waiting_approval" ||
      managed.state === "waiting_input"
    ) {
      managed.pendingCardInvalidation = managed.state === "waiting_approval" || managed.state === "waiting_input";
      // 原始现场先落服务端日志（秒挂类崩溃的唯一线索）；exit.stderrTail 事件本身也保留原文。
      const rawTail = event.stderrTail ?? null;
      this.#logger?.warn("agent process exited", { sessionId, exitCode: event.exitCode, stderrTail: rawTail });
      // 手机通知：已知特征给友好文案（用户可自愈动作）；未知保留原文——对排障更有价值。
      const text =
        rawTail !== null && isKnownAgentError(rawTail)
          ? `agent 运行失败：${friendlyAgentError(rawTail)}`
          : `agent 子进程异常退出（exitCode: ${event.exitCode ?? "null"}）${rawTail !== null ? `：${rawTail}` : ""}`;
      await this.#bus.publish(sessionId, {
        type: "notice",
        severity: "error",
        text,
      });
      await this.#publishState(sessionId, "failed");
    }
    await this.#bus.publish(sessionId, event);
    if (managed.agent !== undefined) this.#retireMetrics(managed.agent);
  }

  /**
   * 白名单校验 + 状态落地（emit 路的 `state` 分支）。
   * 判定顺序（先同步发起 `bus.publish`——同批 emit 的入队顺序即调用顺序，seq 单调——白名单
   * 判定与内存状态都在同步段完成，再回写状态列）：1) **残流抑制**——按句柄 token 判定：
   * stop/restart/启动失败已作废的句柄，其迟到 state 事件一律丢弃（防迟到帧洗掉服务端事实；
   * 新句柄 token 不在名单内，正常流不受染）；`exit` 等非 state 事件不受此约束；
   * 2) **同状态去重**——目标 state 等于当前 state 时静默忽略（服务端事实先行的 CLI 迟到帧属
   * 正常重复，如 interrupt 后 result 的 `error_during_execution→stopped` 同态帧）；
   * 3) 白名单。
   *
   * @param sessionId - 目标会话
   * @param to - agent 上报的目标状态
   * @param token - 发出事件的句柄 token；`undefined`（无句柄期）仅跳过抑制判定
   * @returns Promise，resolve 表示校验与落地结束（抑制/去重/非法三种路径都不发 state 帧）
   * 副作用：合法时改内存状态、发布 state 事件并回写状态列；非法时发布 notice；抑制/去重时仅记日志
   */
  async #applyAgentState(sessionId: string, to: SessionState, token: symbol | undefined): Promise<void> {
    const managed = this.#sessions.get(sessionId);
    if (managed === undefined) {
      this.#logger?.warn("agent state for unknown session dropped", { sessionId, to });
      return;
    }
    if (token !== undefined && managed.staleTokens.has(token)) {
      // 残流抑制：被作废句柄的迟到状态帧不再洗状态（服务端事实已先入册）。
      this.#logger?.debug("suppressed agent state dropped", { sessionId, to });
      return;
    }
    if (managed.state === to) return;
    const from = managed.state;
    if (!canTransition(from, to)) {
      this.#logger?.warn("invalid state transition", { sessionId, from, to });
      await this.#bus.publish(sessionId, {
        type: "notice",
        severity: "error",
        text: `invalid transition ${from}→${to}`,
      });
      return;
    }
    managed.state = to;
    const published = this.#bus.publish(sessionId, { type: "state", state: to });
    await this.#conversations.updateSession(sessionId, { state: to });
    await published;
  }

  /**
   * 运行时事实采集（emit 包装层每次事件后调用）：`agent.runtime?.()` 拉取 pid/hint——
   * pid 首现/变更即 `ledger.register`（"一行一会话"重拉覆盖，spawn 后才知 pid 故为拉动式登记）；
   * hint 首现/变更即回写 `resume_hint` 并更新 `managed.hint`（fork 回写口径与Fact3 一致：
   * `--resume` 后 agent 侧 session_id 稳定，变更才写）。
   * 未知会话/无句柄/句柄无法提供 runtime() 时整段跳过；内部失败只记日志，绝不外抛。
   *
   * @param sessionId - 目标会话
   * 副作用：可能写进程台账行、回写会话行的 resume_hint 列
   */
  async #collectRuntime(sessionId: string): Promise<void> {
    try {
      const managed = this.#sessions.get(sessionId);
      const agent = managed?.agent;
      if (managed === undefined || agent === undefined) return;
      const runtime = agent.runtime?.();
      if (runtime === null || runtime === undefined) return;
      if (
        !this.#configuring.has(sessionId) &&
        runtime.permissionMode !== undefined &&
        (runtime.permissionMode !== managed.spec.permissionMode || this.#permissionSync.has(sessionId))
      ) {
        const current = this.#permissionSync.get(sessionId) ?? Promise.resolve();
        const actualMode = runtime.permissionMode;
        const pending = current
          .catch(() => {})
          .then(async () => {
            if (managed.agent !== agent || this.#configuring.has(sessionId)) return;
            try {
              await this.#conversations.updateSession(sessionId, { permissionMode: actualMode });
            } catch (err) {
              // 实际权限已变化但无法保存时不能继续运行漂移的句柄。
              try {
                await this.#dispose(sessionId, managed, "runtime permission persistence failed");
              } finally {
                await this.#publishState(sessionId, "failed");
              }
              throw err;
            }
            managed.spec = { ...managed.spec, permissionMode: actualMode };
            this.#notifyPermissions(sessionId);
          });
        this.#permissionSync.set(sessionId, pending);
        try {
          await pending;
        } finally {
          if (this.#permissionSync.get(sessionId) === pending) this.#permissionSync.delete(sessionId);
        }
      }
      if (runtime.pid !== undefined && runtime.pid !== managed.registeredPid) {
        managed.registeredPid = runtime.pid;
        await this.#ledger?.register(sessionId, runtime.pid);
        this.#logger?.info("runtime pid registered", { sessionId, pid: runtime.pid });
      }
      if (runtime.resumeHint !== undefined && runtime.resumeHint !== "" && runtime.resumeHint !== managed.hint) {
        managed.hint = runtime.resumeHint;
        // fork 首跑的 init 产出新 CLI 会话 id：标记即时失效，后续续接回到常规 resume。
        if (managed.forkOnResume) {
          managed.forkOnResume = false;
          await this.#conversations.updateSession(sessionId, { resumeHint: runtime.resumeHint, forkPending: false });
        } else {
          await this.#conversations.updateSession(sessionId, { resumeHint: runtime.resumeHint });
        }
      }
    } catch (err) {
      this.#logger?.warn("runtime collect failed", { sessionId, error: errorMessage(err) });
    }
  }

  /** 取适配器；未注册即 `session.agent_missing`（与未安装同文案，手机侧只需一个分支）。 */
  #adapter(agentId: string): AgentAdapter {
    const adapter = this.#agents.get(agentId);
    if (adapter === undefined) throw new Error("session.agent_missing: " + agentId);
    return adapter;
  }

  /**
   * 审批闸上下文（Task 7，内部契约 `AdapterContext`）：aimi 会话 id + 数据目录——
   * 适配器据此派生确定性 permDir（`<dataDir>/perms/<sessionId>/`）。
   * `dataDir` 未注入（极简单测装配）时整段不交——适配器侧闸功能面完全关闭。
   *
   * @param sessionId - 目标会话
   * @returns 完整上下文；dataDir 未知时为 `undefined`
   */
  #gateContext(sessionId: string): import("../agents/types.js").AdapterContext {
    const managed = this.#require(sessionId);
    return {
      sessionId,
      dataDir: this.#dataDir ?? "",
      metricsContext: () => {
        const turnStartSeq = this.#turnStarts.get(sessionId);
        return { sessionId, ...(turnStartSeq === undefined ? {} : { turnStartSeq }) };
      },
      allowDangerouslySkipPermissions: this.#allowed(managed.spec.agentId).has("bypassPermissions"),
      onRuntimeChanged: () => {
        void this.#collectRuntime(sessionId);
      },
    };
  }

  /**
   * 恢复前置态的挂起审批卡失效标注（Task 7.6）：恢复前 state ∈ waiting_* → 先经 bus 发一条
   * 「审批已失效（会话中断）」再 starting——挂起的审批卡已随中断失效，续接后的请求账本
   * 从零开始，旧卡不得被误答（不静默吞：手机可见地作废）。
   *
   * @param sessionId - 目标会话
   * @param managed - 编排层持有的会话条目（读恢复前置态）
   * @returns Promise，resolve 表示标注结束（非 waiting_* 且无退出挂起标记时零事件）
   * 副作用：waiting_* 前置态或等待态异常退出后的首次续接经总线发布一条 info notice
   */
  async #invalidatePendingCards(sessionId: string, managed: ManagedSession): Promise<void> {
    const waiting = managed.state === "waiting_approval" || managed.state === "waiting_input";
    if (!waiting && !managed.pendingCardInvalidation) return;
    managed.pendingCardInvalidation = false;
    // resume() 的终态守卫当前使 waiting 前置态不可达；调用保留为单源不变量——守卫若放宽
    // （如恢复 waiting 挂起会话），失效标注必须先行，不依赖调用点各自记得。
    await this.#bus.publish(sessionId, { type: "notice", severity: "info", text: "审批已失效（会话中断）" });
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
