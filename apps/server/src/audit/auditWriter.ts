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
  readonly deviceId: string;
  readonly name: string;
}

/**
 * 审计出口：业务命令审计与鉴权事件审计汇聚于此，与排障日志分离。
 * 只做「语义 → AuditEntry」的翻译；排序/持久化交给 `AuditRepository`。
 */
export class AuditWriter {
  /**
   * @param auditRepo 审计仓储（auditlog/ 专用，只增不改）。
   */
  constructor(private readonly auditRepo: AuditRepository) {}

  /**
   * 业务命令：`action = "command.<cmd>"`，`detail` 为命令载荷 JSON（截断 2048 字符）。
   * `sessionId` 归属该命令所属会话。
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
   * 重复指令留痕：同一 `clientId` 的重复写操作被丢弃时记录一条审计。
   * `action = "command.duplicate"`，`detail` 为被丢弃命令的 clientId（重复判据即它）。
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
   * 鉴权事件：`action = "auth.<event>"`。
   * 设备级动作故 `deviceId` 填 `"-"`、`sessionId` 填 null（无归属）。
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
   * 会话创建审计：`action = "command.session_create"`。
   * 成功时 `sessionId` 为新建会话 id、`detail` 为 spec JSON（截断 2048 字符）；
   * 失败时 `sessionId` 为 null、`detail` 含错误摘要（调用方拼 `error: <message>`）。
   * 创建不是一条普通命令（命令审计的 action 由 `cmd` 派生，没有 create 变体），
   * 故单独设本方法，沿用同一 2048 字符截断口径。
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
}
