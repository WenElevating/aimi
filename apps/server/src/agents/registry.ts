import type { Logger } from "../logging/logger.js";
import type { AgentAdapter, AgentLookup } from "./types.js";

/** `detectAll` 的单条结果（`version` 仅在探测到且适配器给出时出现）。 */
export interface AgentDetection {
  /** 适配器 id（`SessionSpec.agentId` 取值域） */
  readonly id: string;
  /** 是否可用（探测成功且进程正常退出） */
  readonly ok: boolean;
  /** 版本摘要（如 `claude 1.2.3`）；探测失败或无输出时省略 */
  readonly version?: string;
}

/** 安装探测默认超时 2s（未响应视为未安装，防启动被卡死的 CLI 拖住）。 */
const DEFAULT_INSTALL_TIMEOUT_MS = 2000;

/**
 * 在 `ms` 内取 `promise` 结果；超时或拒绝一律退化为 `fallback`（不抛）。
 * 定时器在两种退出路径上都清理，不留挂起的 handle（否则会拖住测试进程退出）。
 *
 * @param promise - 被限时的探测
 * @param ms - 超时上限（毫秒）
 * @param fallback - 超时或拒绝时的退化结果
 * @returns Promise，resolve 为原结果或 `fallback`
 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => { resolve(fallback); }, ms);
    const settle = (value: T) => { clearTimeout(timer); resolve(value); };
    promise.then(settle, () => { settle(fallback); });
  });
}

/**
 * agent 适配器注册表：`SessionManager` 经 `lookup()` 拿查找面，
 * 装配层在这里逐个注册各家适配器；`detectAll()` 供启动自检与 `status` 命令消费；
 * `gray()/isGrayed()/grayedSnapshot()` 是协议探测失败后的标灰面（看板选项 S3 渲染用）。
 *
 * 职责边界：本类**只管注册与查找**，不做安装缓存、不做生命周期管理——
 * 适配器是无状态单例，会话状态在 `AgentSession` 里。
 */
export class AgentRegistry {
  readonly #adapters = new Map<string, AgentAdapter>();
  /** 标灰注册表（agentId → 原因）：纯进程内内存态，server 重启即清空（标灰是"本进程内发现问题"而非持久权威）。 */
  readonly #grayed = new Map<string, string>();
  readonly #logger: Logger | undefined;
  readonly #installTimeoutMs: number;

  /**
   * @param deps.logger - 可选日志门面：重复注册/标灰时告警；缺省时不产生日志
   * @param deps.installTimeoutMs - 安装探测超时（缺省 2s；注入点仅为测试可缩短等待）
   */
  constructor(deps: { logger?: Logger; installTimeoutMs?: number } = {}) {
    this.#logger = deps.logger;
    this.#installTimeoutMs = deps.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  }

  /**
   * 把某适配器标灰（本进程内不可靠，UI 展示为降级）。**不改变注册表行为**：`create/resume`
   * 依旧照常可用（故障隔离的修复面在会话编排层，不在注册表封口——封口会让已锁会话炸整窗）。
   * 重复标灰以最后一次原因为准（覆盖语义，保留最新诊断现场）。
   *
   * @param agentId - `SessionSpec.agentId`
   * @param reason - 人类可读的标灰原因（如"适配器协议未确认"）
   * 副作用：写入标灰注册表；记一条 WARN
   */
  gray(agentId: string, reason: string): void {
    this.#grayed.set(agentId, reason);
    this.#logger?.warn("agent grayed", { id: agentId, reason });
  }

  /**
   * 查询适配器是否已标灰。
   *
   * @param agentId - `SessionSpec.agentId`
   * @returns true 表示已标灰（含原因，见 `grayedSnapshot`）
   */
  isGrayed(agentId: string): boolean {
    return this.#grayed.has(agentId);
  }

  /**
   * 全量标灰快照（看板选项 S3 渲染）。
   *
   * @returns 冻结的只读数组（`id`/`reason`）；与注册表的内部 Map 无关，调用方不可借此改状态
   */
  grayedSnapshot(): readonly { id: string; reason: string }[] {
    return Object.freeze([...this.#grayed].map(([id, reason]) => ({ id, reason })));
  }

  /**
   * 注册一个适配器（以 `meta.id` 为键）。
   * 重复 id **覆盖**并 WARN——装配层重跑注册（如热重载）不应炸，
   * 但"后注册者胜"必须留痕，否则适配器被静默换掉无从排查。
   *
   * @param adapter - 待注册适配器（无状态；会话级状态在它 `create` 出的句柄里）
   * 副作用：写入注册表；同 id 覆盖时记一条 WARN
   */
  register(adapter: AgentAdapter): void {
    if (this.#adapters.has(adapter.meta.id)) {
      this.#logger?.warn("agent adapter replaced", { id: adapter.meta.id });
    }
    this.#adapters.set(adapter.meta.id, adapter);
  }

  /**
   * 取适配器。
   *
   * @param agentId - `SessionSpec.agentId`
   * @returns 已注册的适配器；未注册返回 `undefined`（错误语义由调用方决定）
   */
  get(agentId: string): AgentAdapter | undefined {
    return this.#adapters.get(agentId);
  }

  /**
   * 满足编排层最小查找面。
   * @returns 绑定本表当前状态的 `AgentLookup`（后续 `register` 立即可见——每次调用都闭包到本表的 `get`）。
   */
  lookup(): AgentLookup {
    return { get: (agentId: string) => this.#adapters.get(agentId) };
  }

  /**
   * 并发探测全部已注册适配器的安装情况（单家超时即视为该家未安装，不影响其他家）。
   *
   * @returns Promise，resolve 为与注册顺序一致的探测结果（`version` 仅在拿到时出现）
   */
  async detectAll(): Promise<AgentDetection[]> {
    return Promise.all(
      [...this.#adapters.values()].map(async (adapter): Promise<AgentDetection> => {
        const probe = await withTimeout(adapter.isInstalled(), this.#installTimeoutMs, { ok: false });
        return probe.version === undefined
          ? { id: adapter.meta.id, ok: probe.ok }
          : { id: adapter.meta.id, ok: probe.ok, version: probe.version };
      }),
    );
  }
}
