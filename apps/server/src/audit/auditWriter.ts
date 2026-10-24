import type { AgentCommand } from "@aimi/protocol";
import type { AuditRepository } from "../persistence/types.js";

/** `detail` 截断上限：审计可读但不得因超大 payload 撑爆单行。 */
const DETAIL_LIMIT = 2048;

/**
 * 审计所需的身份投影（结构化类型）。
 *
 * 审计层不直接依赖鉴权层：身份以结构化类型承接，任何带 deviceId 与 name 的对象都能直接传入，
 * 无需适配代码。
 */
export interface AuditIdentity {
  /** 设备标识，由鉴权层从设备记录带出 */
  readonly deviceId: string;
  /** 设备展示名 */
  readonly name: string;
}

/**
 * 审计出口：业务命令审计与鉴权事件审计汇聚于此，与排障日志分离。
 * 只负责把语义翻译成审计条目；排序与持久化交给审计仓储。
 */
export class AuditWriter {
  /**
   * @param auditRepo - 审计仓储（只增不改）
   */
  constructor(private readonly auditRepo: AuditRepository) {}

  /**
   * 记录一条业务命令；`action` 取 `command.<cmd>`，`detail` 为命令载荷 JSON（截断 2048 字符）。
   *
   * @param cmd - 已归一化的手机指令
   * @param identity - 发令设备身份
   * @param sessionId - 命令所属会话
   * @returns Promise，resolve 表示审计已写入
   */
  async command(cmd: AgentCommand, identity: AuditIdentity, sessionId: string): Promise<void> {
    await this.auditRepo.record({
      ts: Date.now(),
      deviceId: identity.deviceId,
      sessionId,
      action: "command." + cmd.cmd,
      detail: JSON.stringify(cmd).slice(0, DETAIL_LIMIT),
    });
  }

  /**
   * 记录一条被幂等丢弃的重复指令；`action` 取 `command.duplicate`，`detail` 为被丢弃命令的 clientId。
   *
   * @param clientId - 被丢弃命令的幂等键
   * @param identity - 发令设备身份
   * @param sessionId - 命令所属会话
   * @returns Promise，resolve 表示审计已写入
   */
  async duplicate(clientId: string, identity: AuditIdentity, sessionId: string): Promise<void> {
    await this.auditRepo.record({
      ts: Date.now(),
      deviceId: identity.deviceId,
      sessionId,
      action: "command.duplicate",
      detail: clientId,
    });
  }

  /**
   * 记录一条鉴权事件；`action` 取 `auth.<event>`。设备级动作，故 `deviceId` 恒为 `"-"`、`sessionId` 恒为 null。
   *
   * @param event - 鉴权事件类型
   * @param detail - 人类可读补充（如远端地址）
   * @returns Promise，resolve 表示审计已写入
   */
  async auth(event: "pair" | "revoke" | "auth_fail", detail: string): Promise<void> {
    await this.auditRepo.record({
      ts: Date.now(),
      deviceId: "-",
      sessionId: null,
      action: "auth." + event,
      detail,
    });
  }

  /**
   * 记录一次会话创建；`action` 取 `command.session_create`，`detail` 截断 2048 字符。
   * 成功时 `sessionId` 为新建会话 id、`detail` 为 spec JSON；失败时 `sessionId` 为 null、`detail` 含错误摘要。
   * 创建不是一条普通命令（命令审计的 action 由 `cmd` 派生，没有 create 变体），故单独设本方法。
   *
   * @param identity - 发起设备身份
   * @param sessionId - 新建会话 id；创建失败时为 null
   * @param detail - 成功为 spec JSON、失败为错误摘要
   * @returns Promise，resolve 表示审计已写入
   */
  async sessionCreate(identity: AuditIdentity, sessionId: string | null, detail: string): Promise<void> {
    await this.auditRepo.record({
      ts: Date.now(),
      deviceId: identity.deviceId,
      sessionId,
      action: "command.session_create",
      detail: detail.slice(0, DETAIL_LIMIT),
    });
  }

  /**
   * 记录一次启动孤儿清点；`action` 取 `session.orphan_reaped`。
   * 清点由装配层在启动期发起，无发起设备，故 `deviceId` 恒为 `"-"`；被清行落库滞留无会话归属语义，
   * `sessionId` 恒为 null（pids 明细独占 `detail`）。
   *
   * @param detail - 被终止进程摘要（如 `{"count":1,"pids":[123]}`）
   * @returns Promise，resolve 表示审计已写入
   */
  async orphanReaped(detail: string): Promise<void> {
    await this.auditRepo.record({
      ts: Date.now(),
      deviceId: "-",
      sessionId: null,
      action: "session.orphan_reaped",
      detail: detail.slice(0, DETAIL_LIMIT),
    });
  }

  /**
   * 记录一条问题反馈提交（action `feedback.upload`）；反馈正文/附件本体落
   * `{dataDir}/feedback/` 目录，审计只留元数据摘要（deviceId 归属上传设备，
   * detail 截 2048 字符）。
   *
   * @param deviceId - 上传设备标识
   * @param id - 反馈 id（与目录名一致）
   * @param summary - 元数据 JSON（描述摘要/app 信息/图片数/是否带日志）
   * @returns Promise，resolve 表示审计已写入
   */
  async feedback(deviceId: string, id: string, summary: string): Promise<void> {
    await this.auditRepo.record({
      ts: Date.now(),
      deviceId,
      sessionId: null,
      action: "feedback.upload",
      detail: `id=${id} ${summary}`.slice(0, DETAIL_LIMIT),
    });
  }
}
