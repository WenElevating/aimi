import type { AgentEvent, SessionState } from "@aimi/protocol";
import type { SessionMeta, SessionSpec } from "@aimi/protocol";

/**
 * 建会话所需的会话行字段。
 * 与手机侧 `SessionSpec` 的差别：`id`/`cwd` 由 server 侧确定，故为独立结构而非直接复用；
 * `permissionMode` 沿用 `SessionSpec` 的类型（C3：手机不可升权），杜绝两处取值域漂移。
 */
export interface SessionRowInput {
  readonly id: string;
  readonly agentId: string;
  readonly cwd: string;
  readonly permissionMode: SessionSpec["permissionMode"];
  readonly initialPrompt?: string;
}

/**
 * events+sessions 仓储（§D：唯一能写这两表的人）。
 * `initialAgentEvent` 与会话行同事务落库（seq=0）；事务边界在此接口内封闭，调用方不感知。
 */
export interface ConversationRepository {
  /** 建表/建索引，幂等：重复调用无副作用。 */
  init(): Promise<void>;
  /** 原子写入会话行与首事件（null 表示无首事件）；两者要么同成，要么同败。 */
  createSession(row: SessionRowInput, initialAgentEvent: AgentEvent | null): Promise<void>;
  /**
   * 按 **EventBus 分配的显式 seq** 追加事件（该会话首事件 seq=0）；同事务回写 `last_seq=seq` 与 `updated_at=ts`。
   * **seq 唯一权威在 EventBus**（`events/eventBus.ts`）——本仓储只执行写入，不自行分配序号；
   * seq 冲突（`(session_id, seq)` 主键重复）视为编程错误，由底层自然抛出，不做容错。
   * 会话不存在时抛错。
   */
  appendEvent(sessionId: string, seq: number, agentEvent: AgentEvent, ts: number): Promise<void>;
  /** 按 seq 升序读事件：`sinceSeq` 为排他下界（重放点查），`limit` 截断条数。 */
  getEvents(sessionId: string, opts?: { sinceSeq?: number; limit?: number }): Promise<{ seq: number; ts: number; agentEvent: AgentEvent }[]>;
  /** 全量会话元数据，按 createdAt 升序（welcome 帧据此恢复红点/断线补齐）。 */
  listSessions(): Promise<SessionMeta[]>;
  /** 增量更新会话状态与最新 seq；会话不存在时抛错。 */
  updateSession(id: string, patch: { state?: SessionState; lastSeq?: number }): Promise<void>;
  /** 释放底层资源（连接/语句句柄）；Memory 实现为 no-op。 */
  close(): Promise<void>;
}

/** 设备读取投影：不含令牌哈希，消费方无需经手凭据。 */
export interface DeviceRecord { readonly id: string; readonly name: string; readonly lastSeenAt: number }

/**
 * 设备令牌面（auth/ 专用）。
 * 只存 SHA-256 哈希，永不存明文——库泄露不等于令牌泄露。
 */
export interface DeviceRepository {
  /** 建表/建索引，幂等。 */
  init(): Promise<void>;
  /**
   * 登记设备并返回生成的 deviceId（uuid）；`tokenSha256` 为令牌的 SHA-256 十六进制哈希。
   * `tokenSha256` 全库唯一；重复注册抛错（契约对齐 Sqlite 与 Memory 两实现）。
   */
  put(name: string, tokenSha256: string): Promise<string>;
  /** 按令牌哈希查活设备；已吊销（revokedAt 非 null）→ null。 */
  findByTokenHash(tokenSha256: string): Promise<{ id: string; name: string } | null>;
  /** 吊销设备：此后 `findByTokenHash` 不再命中（M0 不做物理删除）。 */
  revoke(deviceId: string): Promise<void>;
  /** 全量设备记录（不区分吊销与否——M0 无消费方）。 */
  list(): Promise<DeviceRecord[]>;
  /** 释放底层资源；Memory 实现为 no-op。 */
  close(): Promise<void>;
}

/**
 * 写操作幂等（异常 #7：手机重发同一 clientId 的效果收敛为一次）。
 * false = 重复，调用方据此回 `session.duplicate_command` 或静默忽略。
 */
export interface CommandDedupRepository {
  /** 建表/建索引，幂等。 */
  init(): Promise<void>;
  /** 首次见到 clientId 返回 true；重复返回 false。 */
  putIfAbsent(clientId: string): Promise<boolean>;
  /** 释放底层资源；Memory 实现为 no-op。 */
  close(): Promise<void>;
}

/** 审计条目：`sessionId` 为 null 表示设备级动作（如配对）；`action` 为稳定动作用语，`detail` 为人类可读补充。 */
export interface AuditEntry { readonly ts: number; readonly deviceId: string; readonly sessionId: string | null; readonly action: string; readonly detail: string }

/** 审计仓储（auditlog/ 专用，只增不改）。 */
export interface AuditRepository {
  /** 建表/建索引，幂等。 */
  init(): Promise<void>;
  /** 追加一条审计；实现内部维护自增 audit_seq 用于排序。 */
  record(entry: AuditEntry): Promise<void>;
  /** 按 audit_seq 倒序取最近 n 条（最新在前）；n<=0 返回空数组。 */
  recent(n: number): Promise<AuditEntry[]>;
  /** 释放底层资源；Memory 实现为 no-op。 */
  close(): Promise<void>;
}
