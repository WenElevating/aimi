import type { SessionEventFrame } from "@aimi/protocol";
import type { Conveyor } from "../transport/conveyor.js";
import type { EventBus, SessionRecord } from "./eventBus.js";

/**
 * 会话事件 → `SessionEventFrame` 广播给全部挂接 Conveyor（M0 全量广播；M1 加订阅过滤）。
 * 构造即接管 EventBus 的 ui 单槽（`subscribe` 为字段级覆盖）：**UiFanout 是 ui 路的唯一消费者**，
 * 装配层（T11）不要再自行注册 ui handler，否则会顶掉广播。
 * 无挂接时静默；`send` 即发即忘（丢弃/背压语义在 Conveyor 层，本层不做缓冲——YAGNI）。
 */
export class UiFanout {
  readonly #conveyors = new Set<Conveyor>();

  /**
   * @param eventBus 事件总线；构造时注册 ui 路由（接管单槽）。
   */
  constructor(eventBus: EventBus) {
    eventBus.subscribe({ ui: (rec) => { this.#broadcast(rec); } });
  }

  /**
   * 挂接一条通道。幂等：同实例重复挂接只算一次（Set 语义）。
   * @param conveyor 已建立（或即将建立）的传输通道。
   */
  attach(conveyor: Conveyor): void {
    this.#conveyors.add(conveyor);
  }

  /**
   * 摘除一条通道（T11 在连接关闭时调用）。未挂接时无副作用。
   * @param conveyor 要摘除的通道。
   */
  detach(conveyor: Conveyor): void {
    this.#conveyors.delete(conveyor);
  }

  /** 当前挂接数（装配自检/测试用）。 */
  attachedCount(): number {
    return this.#conveyors.size;
  }

  /** 一条会话事件按全量广播；无挂接时直接返回。 */
  #broadcast(rec: SessionRecord): void {
    if (this.#conveyors.size === 0) return;
    const frame: SessionEventFrame = {
      v: 1,
      type: "session.event",
      sessionId: rec.sessionId,
      seq: rec.seq,
      ts: rec.ts,
      agentEvent: rec.agentEvent,
    };
    for (const conveyor of this.#conveyors) conveyor.send(frame);
  }
}
