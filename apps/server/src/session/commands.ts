import type { SessionCommandFrame } from "@aimi/protocol";
import type { AuditWriter } from "../audit/auditWriter.js";
import type { DeviceIdentity } from "../auth/authenticator.js";
import type { EventBus } from "../events/eventBus.js";
import type { CommandDedupRepository } from "../persistence/types.js";
import type { SessionManager } from "./sessionManager.js";

/**
 * 手机命令编排的唯一入口（§C/§11）：幂等闸门 → 审计 → 分发。
 *
 * - 幂等（异常 #7）：先过 `CommandDedupRepository.putIfAbsent(clientId)`；命中重复只补一条
 *   `command.duplicate` 审计后丢弃，**绝不执行两遍**。
 * - 审计（§F）：每条首次到达的命令经 `AuditWriter.command` 留痕（`command.<cmd>`）。
 * - 分发：`send`/`interrupt`/`approve`/`answer` 交给活动会话的 agent 侧会话；
 *   会话不存在或已终态时经 bus 发 `notice{severity:"error"}`（不抛——手机侧只需看到提示）；
 *   `stop`/`restart` 直接调 `SessionManager` 对应方法（终态语义由它把关）。
 */
export class PhoneCommandPipe {
  readonly #sessions: SessionManager;
  readonly #bus: EventBus;
  readonly #dedup: CommandDedupRepository;
  readonly #audit: AuditWriter;

  /**
   * @param deps.sessions 会话编排核心（指令的实际落点）。
   * @param deps.bus 事件总线（"会话不可用"提示经它回到手机）。
   * @param deps.dedup 写操作幂等表（clientId 首次判据）。
   * @param deps.audit 审计门面（业务命令与幂等命中同一出口）。
   */
  constructor(deps: {
    sessions: SessionManager;
    bus: EventBus;
    dedup: CommandDedupRepository;
    audit: AuditWriter;
  }) {
    this.#sessions = deps.sessions;
    this.#bus = deps.bus;
    this.#dedup = deps.dedup;
    this.#audit = deps.audit;
  }

  /**
   * 处理一条 `session.command` 帧（可能已被手机重发多次——同一 `clientId` 效果收敛为一次）。
   * @param frame 手机命令帧（会话、clientId、指令）。
   * @param identity 已鉴权的设备身份（审计归属）。
   */
  async handle(frame: SessionCommandFrame, identity: DeviceIdentity): Promise<void> {
    if (!(await this.#dedup.putIfAbsent(frame.clientId))) {
      await this.#audit.duplicate(frame.clientId, identity, frame.sessionId);
      return;
    }
    await this.#audit.command(frame.cmd, identity, frame.sessionId);

    const cmd = frame.cmd;
    if (cmd.cmd === "stop") {
      await this.#sessions.stop(frame.sessionId);
      return;
    }
    if (cmd.cmd === "restart") {
      await this.#sessions.restart(frame.sessionId);
      return;
    }
    const delivered = await this.#sessions.send(frame.sessionId, cmd);
    if (!delivered) {
      await this.#bus.publish(frame.sessionId, {
        type: "notice",
        severity: "error",
        text: "session not active: " + frame.sessionId,
      });
    }
  }
}
