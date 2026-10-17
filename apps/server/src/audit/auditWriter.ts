import type { AgentCommand } from "@aimi/protocol";
import type { AuditRepository } from "../persistence/types.js";

/** `detail` 截断上限：审计可读但不得因超大 payload 撑爆单行。 */
const DETAIL_LIMIT = 2048;

/**
 * 审计所需的身份投影（领域结构类型）。
 *
 * 横切层零核心依赖：`audit/` 不 import `auth/`，身份以**结构化类型**承接——
 * 调用方传入 `DefaultAuthenticator` 产出的 `DeviceIdentity` 天然兼容（TS 结构类型，零适配代码）。
 */
export interface AuditIdentity {
  readonly deviceId: string;
  readonly name: string;
}

/**
 * 审计门面（§F）：业务命令审计与鉴权事件审计同一出口，与排障日志分离。
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
   * 幂等命中（异常 #7）：同一 `clientId` 的重复写操作被丢弃时留痕。
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
}
