import type { CommandAckStatus, FrameErrorCode, SessionCommandFrame } from "@aimi/protocol";
import type { AuditWriter } from "../audit/auditWriter.js";
import type { DeviceIdentity } from "../auth/authenticator.js";
import type { EventBus } from "../events/eventBus.js";
import type { CommandDedupRepository } from "../persistence/types.js";
import type { SessionManager } from "./sessionManager.js";
import { KeyedSerialQueue } from "./commandQueue.js";

export interface CommandResult {
  readonly status: CommandAckStatus;
  readonly code?: FrameErrorCode;
}

/**
 * 指令不可用分流的提示文案（会话门 `send/interrupt` 三态中的两个"不可用"面各自一条；`delivered` 无言）。
 * why 分流：会话历史仍在但已无续接可能（`expired`）与"连会话都找不到"（`inactive`）对手机的
 * 语义不同——前者引导查阅历史，后者提示会话不存在；application 层的 `/not active/` 静默映射
 * 依赖 inactive 文案含该业务分词，改文案须同步考察。
 *
 * @param sessionId - 命令所属会话（提示螟回显，便于手机侧对账）
 * @returns 直接可入流的提示文本
 */
function sessionNotActiveMessage(sessionId: string): string {
  return "session not active: " + sessionId;
}

function sessionExpiredMessage(sessionId: string): string {
  return "会话已过期，仅可查阅历史: " + sessionId;
}

/**
 * 手机命令编排的唯一入口：先过幂等闸门，再审计，最后分发。
 *
 * - 幂等：先过 `CommandDedupRepository.putIfAbsent(clientId)`；命中重复只补一条
 *   `command.duplicate` 审计后丢弃，**绝不执行两遍**。
 * - 审计：每条首次到达的命令经 `AuditWriter.command` 留痕（`command.<cmd>`）。
 * - 分发：`stop`/`restart` 直接调 `SessionManager` 对应方法；`send` 走会话门三路，
 *   `interrupt` 走专用打断门（服务端事实 stopped 先行、不 dispose）；两个"不可用"态
 *   分别以 `session not active` / 会话已过期文案经 bus 发 `notice{severity:"error"}` 回手机
 *   （不抛——手机侧只需看到提示）。
 */
export class PhoneCommandPipe {
  readonly #sessions: SessionManager;
  readonly #bus: EventBus;
  readonly #dedup: CommandDedupRepository;
  readonly #audit: AuditWriter;
  readonly #queue = new KeyedSerialQueue();

  /**
   * @param deps.sessions - 会话编排核心（指令的实际落点）
   * @param deps.bus - 事件总线（「会话不可用」提示经它回到手机）
   * @param deps.dedup - 写操作幂等表（clientId 首次判据）
   * @param deps.audit - 审计门面（业务命令与幂等命中同一出口）
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
   *
   * @param frame - 手机命令帧（会话、clientId、指令）
   * @param identity - 已鉴权的设备身份（审计归属）
   * @returns Promise，resolve 表示处理结束（重复被丢弃、指令已分发或已发提示均 resolve，不 reject）
   * 副作用：写审计、转发指令给会话；会话不可用时经总线发对应文案的 notice
   */
  async handle(frame: SessionCommandFrame, identity: DeviceIdentity): Promise<CommandResult> {
    return this.#queue.run(frame.sessionId, async () => {
      if (!(await this.#dedup.putIfAbsent(frame.clientId))) {
        await this.#audit.duplicate(frame.clientId, identity, frame.sessionId);
        return { status: "duplicate" };
      }
      await this.#audit.command(frame.cmd, identity, frame.sessionId);

      const cmd = frame.cmd;
      if (cmd.cmd === "stop") {
        await this.#sessions.stop(frame.sessionId);
        return { status: "delivered" };
      }
      if (cmd.cmd === "restart") {
        await this.#sessions.restart(frame.sessionId);
        return { status: "delivered" };
      }
      if (cmd.cmd === "configure") {
        await this.#sessions.configure(frame.sessionId, {
          model: cmd.model,
          permissionMode: cmd.permissionMode,
        });
        return { status: "delivered" };
      }
      // 会话门三态：deliver/inactive/expired 按"不可用即发对应提示"收口。
      const outcome = cmd.cmd === "interrupt"
        ? await this.#sessions.interrupt(frame.sessionId)
        : await this.#sessions.send(frame.sessionId, cmd);
      if (outcome === "inactive") {
        await this.#bus.publish(frame.sessionId, {
          type: "notice",
          severity: "error",
          text: sessionNotActiveMessage(frame.sessionId),
        });
        return { status: "rejected", code: "session.not_found" };
      }
      if (outcome === "expired") {
        await this.#bus.publish(frame.sessionId, {
          type: "notice",
          severity: "error",
          text: sessionExpiredMessage(frame.sessionId),
        });
        return { status: "rejected", code: "session.not_found" };
      }
      return { status: "delivered" };
    });
  }
}
