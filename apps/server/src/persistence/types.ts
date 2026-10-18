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
   * 增量更新会话状态、最新 seq 与续接线索。
   * `resumeHint` 变更才回写（SPIKE FACT3：`--resume` 后 agent 侧 session_id 稳定，无需每回合写）。
   *
   * @param id - 目标会话
   * @param patch - 只包含需要改动的字段；`resumeHint` 表示会话的最新续接线索（adapter 自述）
   * @returns Promise，resolve 表示已更新
   * @throws 会话不存在时抛出
   */
  updateSession(id: string, patch: { state?: SessionState; lastSeq?: number; resumeHint?: string }): Promise<void>;
  /**
   * 统计会话内 `seq` 大于 `sinceSeq` 的事件条数（重放体积预估用——Task 5 的重放编排先数后拉）。
   *
   * @param sessionId - 目标会话
   * @param sinceSeq - 排他下界（语义同 `getEvents`：只统计更大的 seq；0 = 全量首事件起）
   * @returns Promise，resolve 为命中条数；会话不存在时为 0（宽松读，与 `getEvents` 同口径）
   */
  countEvents(sessionId: string, sinceSeq: number): Promise<number>;
  /**
   * 读取会话的最新续接线索（adapter 自述的 agent 侧会话 id）。
   * 宽松读：会话不存在与"从未捕获"同态返回 null，调用方单分支处理不可续接。
   *
   * @param sessionId - 目标会话
   * @returns Promise，resolve 为线索文本；不可续接时为 null
   */
  getSessionHint(sessionId: string): Promise<string | null>;
  /**
   * 释放底层资源（连接/语句句柄）；内存实现为 no-op。
   *
   * @returns Promise，resolve 表示资源已释放
   */
  close(): Promise<void>;
}

/**
 * 子进程台账：spawn 记 pid、dispose 撤销、重启清点孤儿（core-loop §5.1 F5 防线）。
 * why 持久化：server 重启后 pid 是唯一可追认的现场，台账必须落库才兜得住跨生命周期；
 * 台账一行一会话（同会话重拉 UPSERT 覆盖旧行），表 = `session_processes`。
 */
export interface ProcessLedgerRepository {
  /**
   * 建表并建索引；幂等，重复调用无副作用。
   *
   * @returns Promise，resolve 表示结构已就绪
   */
  init(): Promise<void>;
  /**
   * 登记或覆盖（同会话重拉覆盖旧行）；started_at 由实现取 now。
   *
   * @param sessionId - 目标会话
   * @param pid - agent 子进程号（spawn 后才知，故为拉动式登记）
   * @returns Promise，resolve 表示已落库
   */
  register(sessionId: string, pid: number): Promise<void>;
  /**
   * dispose 撤销（子进程已被收尸）；未知 sessionId 静默 no-op。
   *
   * @param sessionId - 目标会话
   * @returns Promise，resolve 表示已撤销
   */
  clear(sessionId: string): Promise<void>;
  /**
   * 全量台账行（启动孤儿清点用）。
   *
   * @returns Promise，resolve 为台账行数组；`started_at` 不外暴露——清点只需 pid 身份
   */
  list(): Promise<{ sessionId: string; pid: number }[]>;
  /**
   * 释放底层资源（连接/语句句柄）；内存实现为 no-op。
   *
   * @returns Promise，resolve 表示资源已释放
   */
  close(): Promise<void>;
}

/**
 * 设备读取投影：不含令牌哈希，消费方无需经手凭据。
 * `revokedAt` 保留在投影中（null=未吊销）——吊销巡检与 devices 列表渲染都要读它；
 * 需要过滤活设备的调用方（认证入口）请走 `findByTokenHash`，那条路径已代为隐藏吊销行。
 */
export interface DeviceRecord {
  readonly id: string;
  readonly name: string;
  readonly lastSeenAt: number;
  readonly revokedAt: number | null;
}

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
   * @returns Promise，resolve 为设备记录数组（含 `revokedAt` 供消费方渲染/过滤）
   */
  list(): Promise<DeviceRecord[]>;
  /**
   * 更新设备最近活跃时刻（hello/配对成功后调用）——health 面与"设备多久没上线"判读的时基。
   *
   * @param deviceId - 目标设备
   * @returns Promise，resolve 表示更新已执行（未知 id 静默 no-op）
   */
  markSeen(deviceId: string): Promise<void>;
  /**
   * 按 deviceId 观测设备。与 `findByTokenHash` 的差别：**不隐藏吊销行**——
   * 吊销即时断连巡检（Task 6.4）与设备列表都要读 `revokedAt`，此处只做身份到投影的解析。
   *
   * @param deviceId - 目标设备
   * @returns Promise，resolve 为设备投影；未登记时为 null
   */
  findById(deviceId: string): Promise<{ id: string; name: string; revokedAt: number | null } | null>;
  /**
   * 签发一次性配对码：8 位数字、5min 有效（`PAIRING_TTL_MS`）、单次核销。
   * **跨进程共库**：`aimi-server pair` 是独立 CLI 进程，运行中的服务靠**库**消费同一行——
   * 码必须落库而非内存，否则 CLI 发的码服务进程看不见（review §3.3 坑清单）。
   *
   * @param opts - `now` 注入时钟（测试固定期限断言）；缺省取系统时钟
   * @returns Promise，resolve 为新码与绝对过期时刻（毫秒）
   */
  issuePairingCode(opts?: { now?: () => number }): Promise<{ code: string; expiresAt: number }>;
  /**
   * 核销配对码，返回四态：`"ok"`（核销成功）/`"unknown"`（无此码）/`"expired"`（已过有效期）/`"used"`（已被核销）。
   *
   * 原子性两条腿（review §3.3——CLI 与服务进程并发消费同一行的防线）：
   * 1. **SELECT 预判状态**：`unknown`/`used`/`expired` 先行判出，只为错误文案与限速计数可区分；
   * 2. **原子 UPDATE 裁定并发**：`UPDATE pairing_codes SET used_at=? WHERE code=? AND used_at IS NULL
   *    AND expires_at>now`——影响行数 1 = 本进程赢得核销（"ok"）；影响行数 0 且预判为可核销时
   *    收敛为 "used"（预判与裁定之间的窗口必有另一条连接先核销；过期边际恰好跨过时钟也归入此态，
   *    对调用方语义等价：这一次提交没有被兑现）。
   *
   * @param code - 待核销的配对码
   * @param opts - `now` 注入时钟（测试）；缺省取系统时钟
   * @returns Promise，resolve 为四态之一
   */
  consumePairingCode(code: string, opts?: { now?: () => number }): Promise<"ok" | "unknown" | "expired" | "used">;
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
