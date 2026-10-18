import type { SessionEventFrame } from "@aimi/protocol";
import type { Conveyor } from "../transport/conveyor.js";
import type { EventBus, SessionRecord } from "./eventBus.js";

/**
 * 把会话事件包成 `SessionEventFrame` 广播给全部挂接的 Conveyor（当前是全量广播，不做订阅过滤）。
 * 构造即接管 EventBus 的 ui 单槽（`subscribe` 为字段级覆盖）：**UiFanout 是 ui 路的唯一消费者**，
 * 调用方不要再自行注册 ui handler，否则会顶掉广播。
 * 无挂接时静默；`send` 即发即忘（丢弃/背压语义在 Conveyor 层，本层不做缓冲——YAGNI）。
 */
export class UiFanout {
  readonly #conveyors = new Set<Conveyor>();

  /**
   * 构造即接管事件总线的界面路，把后续会话事件转发给挂接的通道。
   *
   * @param eventBus - 事件总线；ui 路由由本类独占
   * 副作用：覆盖事件总线的 ui 路由，调用方不要再自行注册
   */
  constructor(eventBus: EventBus) {
    eventBus.subscribe({ ui: (rec) => { this.#broadcast(rec); } });
  }

  /**
   * 挂接一条通道；同实例重复挂接只算一次。
   *
   * @param conveyor - 已建立（或即将建立）的传输通道
   * 副作用：加入广播集合，立即开始接收后续会话事件
   */
  attach(conveyor: Conveyor): void {
    this.#conveyors.add(conveyor);
  }

  /**
   * 摘除一条通道（连接关闭时调用）；未挂接时什么都不做。
   *
   * @param conveyor - 要摘除的通道
   * 副作用：移出广播集合，此后不再收到会话事件
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
