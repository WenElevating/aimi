import type { AgentEvent, SessionState } from "@aimi/protocol";
import type { SessionMeta, SessionSpec } from "@aimi/protocol";

/**
 * 建会话所需的会话行字段。
 * 与手机侧 `SessionSpec` 的差别：`id`/`cwd` 由 server 侧确定，故为独立结构而非直接复用；
 * `permissionMode` 与手机侧同一取值域（手机不可升权），避免两处取值不一致。
 */
export interface SessionRowInput {
  /** 会话标识，由服务端生成（uuid），创建后不变 */
  readonly id: string;
  /** 目标适配器标识，取值域同手机侧的 agentId */
  readonly agentId: string;
  /** agent 侧工作目录，由服务端确定 */
  readonly cwd: string;
  /** 权限模式；取值域与手机侧同一套，不接受升权 */
  readonly permissionMode: SessionSpec["permissionMode"];
  /** 首条输入；缺省表示不预置输入 */
  readonly initialPrompt?: string;
}

/**
 * events+sessions 仓储：唯一能写这两张表的地方。
 * `initialAgentEvent` 与会话行同事务落库（seq=0）；事务边界在此接口内封闭，调用方不感知。
 */
export interface ConversationRepository {
  /**
   * 建表并建索引；幂等，重复调用无副作用。
   *
   * @returns Promise，resolve 表示结构已就绪
   */
  init(): Promise<void>;
  /**
   * 原子写入会话行与首事件；两者要么同成，要么同败。
   *
   * @param row - 会话行字段
   * @param initialAgentEvent - 会话首事件；null 表示无首事件
   * @returns Promise，resolve 表示已落库
   */
  createSession(row: SessionRowInput, initialAgentEvent: AgentEvent | null): Promise<void>;
  /**
   * 按 **EventBus 分配的显式 seq** 追加事件（该会话首事件 seq=0）；同事务回写 `last_seq=seq` 与 `updated_at=ts`。
   * **seq 的分配权威在 EventBus**——本仓储只执行写入，不自行分配序号；
   * seq 冲突（`(session_id, seq)` 主键重复）视为编程错误，由底层自然抛出，不做容错。
   *
   * @param sessionId - 目标会话
   * @param seq - 事件序号，由 EventBus 统一分配
   * @param agentEvent - 归一化后的 agent 事件
   * @param ts - 事件发出时刻（毫秒）
   * @returns Promise，resolve 表示已落库
   * @throws 会话不存在或 seq 冲突时抛出底层错误
   */
  appendEvent(sessionId: string, seq: number, agentEvent: AgentEvent, ts: number): Promise<void>;
  /**
   * 按 seq 升序读事件。
   *
   * @param sessionId - 目标会话
   * @param opts - 可选过滤：`sinceSeq` 为排他下界（只返回更大的 seq），`limit` 限制条数
   * @returns Promise，resolve 为事件数组（按 seq 升序）；无匹配时为空数组
   */
  getEvents(sessionId: string, opts?: { sinceSeq?: number; limit?: number }): Promise<{ seq: number; ts: number; agentEvent: AgentEvent }[]>;
  /**
   * 读取全量会话元数据。
   *
   * @returns Promise，resolve 为会话元数据数组，按 createdAt 升序（welcome 帧据此恢复红点与断线补齐）
   */
  listSessions(): Promise<SessionMeta[]>;
  /**
   * 增量更新会话状态与最新 seq。
   *
   * @param id - 目标会话
   * @param patch - 只包含需要改动的字段
   * @returns Promise，resolve 表示已更新
   * @throws 会话不存在时抛出
   */
  updateSession(id: string, patch: { state?: SessionState; lastSeq?: number }): Promise<void>;
  /**
   * 释放底层资源（连接/语句句柄）；内存实现为 no-op。
   *
   * @returns Promise，resolve 表示资源已释放
   */
  close(): Promise<void>;
}

/** 设备读取投影：不含令牌哈希，消费方无需经手凭据。 */
export interface DeviceRecord { readonly id: string; readonly name: string; readonly lastSeenAt: number }

/**
 * 设备令牌面（auth/ 专用）。
 * 只存 SHA-256 哈希，永不存明文——库泄露不等于令牌泄露。
 */
export interface DeviceRepository {
  /**
   * 建表并建索引；幂等。
   *
   * @returns Promise，resolve 表示结构已就绪
   */
  init(): Promise<void>;
  /**
   * 登记设备并返回生成的 deviceId（uuid）。
   *
   * @param name - 设备展示名
   * @param tokenSha256 - 令牌的 SHA-256 十六进制哈希，全库唯一
   * @returns Promise，resolve 为新设备的 deviceId
   * @throws 该哈希已登记过时抛出（SQLite 与内存两种实现都遵守）
   */
  put(name: string, tokenSha256: string): Promise<string>;
  /**
   * 按令牌哈希查活设备。
   *
   * @param tokenSha256 - 令牌的 SHA-256 十六进制哈希
   * @returns Promise，resolve 为命中的设备（id/name）；未命中或已吊销时为 null
   */
  findByTokenHash(tokenSha256: string): Promise<{ id: string; name: string } | null>;
  /**
   * 吊销设备：此后查活设备不再命中（不做物理删除）。
   *
   * @param deviceId - 目标设备
   * @returns Promise，resolve 表示已吊销
   */
  revoke(deviceId: string): Promise<void>;
  /**
   * 读取全量设备记录（不区分吊销与否）。
   *
   * @returns Promise，resolve 为设备记录数组
   */
  list(): Promise<DeviceRecord[]>;
  /**
   * 释放底层资源；内存实现为 no-op。
   *
   * @returns Promise，resolve 表示资源已释放
   */
  close(): Promise<void>;
}

/**
 * 写操作幂等：手机重发同一 clientId 的效果收敛为一次。
 * false = 重复，调用方据此回 `session.duplicate_command` 或静默忽略。
 */
export interface CommandDedupRepository {
  /**
   * 建表并建索引；幂等。
   *
   * @returns Promise，resolve 表示结构已就绪
   */
  init(): Promise<void>;
  /**
   * 首次见到 clientId 返回 true；重复返回 false。
   *
   * @param clientId - 手机为每条写命令生成的幂等键
   * @returns Promise，resolve 为 true 表示首次见到（放行），false 表示重复（丢弃）
   */
  putIfAbsent(clientId: string): Promise<boolean>;
  /**
   * 释放底层资源；内存实现为 no-op。
   *
   * @returns Promise，resolve 表示资源已释放
   */
  close(): Promise<void>;
}

/** 审计条目：`sessionId` 为 null 表示设备级动作（如配对）；`action` 为稳定动作用语，`detail` 为人类可读补充。 */
export interface AuditEntry { readonly ts: number; readonly deviceId: string; readonly sessionId: string | null; readonly action: string; readonly detail: string }

/** 审计仓储（auditlog/ 专用，只增不改）。 */
export interface AuditRepository {
  /**
   * 建表并建索引；幂等。
   *
   * @returns Promise，resolve 表示结构已就绪
   */
  init(): Promise<void>;
  /**
   * 追加一条审计；实现内部维护自增 audit_seq 用于排序。
   *
   * @param entry - 待写入的审计条目
   * @returns Promise，resolve 表示已写入
   */
  record(entry: AuditEntry): Promise<void>;
  /**
   * 按 audit_seq 倒序取最近 n 条（最新在前）。
   *
   * @param n - 取用条数；<= 0 时返回空数组
   * @returns Promise，resolve 为审计条目数组（最新在前）
   */
  recent(n: number): Promise<AuditEntry[]>;
  /**
   * 释放底层资源；内存实现为 no-op。
   *
   * @returns Promise，resolve 表示资源已释放
   */
  close(): Promise<void>;
}
