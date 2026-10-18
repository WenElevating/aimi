import type { SessionEventFrame } from "@aimi/protocol";
import type { Conveyor } from "../transport/conveyor.js";
import type { EventBus, SessionRecord } from "./eventBus.js";

/**
 * per-connection 重放闸（断连缺口重放，core-loop §5.2）：attach 时带闸的通道，live 广播先
 * 进 per-conveyor FIFO 暂存，经 `UiFanout.release` 开闸后才按**入队序**冲刷。去重是**两道**：
 * 1. **入队口**：`rec.seq <= replayedMax.get(sessionId)`（此刻该 seq 的行已被直送）即丢——
 *    拦掉大头，FIFO 只存真正的候选缺口帧；
 * 2. **冲刷终判**：release 冲刷时对每帧再判一次（此刻分页已毕、replayedMax=终值）——
 *    拦掉"入队后 replayedMax 才推进到它"的重复（分页 await 期间 publish→persist 提交→
 *    下一页 SELECT 读到同一行直发 + FIFO 副本，不经终判必双发）。
 * why 两道不丢帧：`replayedMax` 仅由直发行推进，直发序连续——"seq ≤ 终值却从未直发"
 * 不可构造，故终判丢弃的必是已直发行的重复副本；seq > 终值的帧（persist 滞后未入页）
 * 照常冲出，零丢失。
 */
export class ReplayGate {
  /**
   * 重放已直送到的最大 seq（按会话）：重放循环直发一帧即 `set` 推进一格，广播入队据此判定。
   * 运行时是可变 Map（只有编排层写）；会话缺项视作 -1（该会话一条都没送过，零去重）。
   */
  readonly replayedMax = new Map<string, number>();

  #opened = false;

  /**
   * 开闸（幂等）。开闸的**可见效果**由 `UiFanout.release` 统一兑现（冲刷 FIFO + 摘除闸
   * 一次完成，保证"开闸"与"补发"之间不存在 live 抢跑窗口）——本方法只落状态标记。
   */
  open(): void {
    this.#opened = true;
  }

  /** 是否已开闸（观测面；广播路由的判据是"闸是否仍挂在通道上"，见 `UiFanout`）。 */
  get opened(): boolean {
    return this.#opened;
  }
}

/** 挂着闸的通道：未开闸期间 live 广播的暂存队列（按入队序冲刷）。 */
interface GatedEntry {
  readonly gate: ReplayGate;
  readonly fifo: SessionEventFrame[];
}

/**
 * 把会话事件包成 `SessionEventFrame` 广播给全部挂接的 Conveyor（当前是全量广播，不做订阅过滤）。
 * 构造即接管 EventBus 的 ui 单槽（`subscribe` 为字段级覆盖）：**UiFanout 是 ui 路的唯一消费者**，
 * 调用方不要再自行注册 ui handler，否则会顶掉广播。
 * 无挂接时静默；`send` 即发即忘（丢弃/背压语义在 Conveyor 层，本层不做缓冲——YAGNI）。
 *
 * **重放栅**：`attach(conveyor, gate)` 提供闸的通道在 release 前把 live 广播先进 FIFO
 * （入队口按 `gate.replayedMax` 去重）；`release` 开闸 + 按入队序冲刷（**冲刷终判**再去重一次）
 * + 摘除闸，通道仍在广播集合。路由判据是"闸是否仍挂载"（release 是唯一开闸出口——open 与冲刷同刻
 * 兑现，不存在"已开闸但帧还在 FIFO"的中间态）。不提供闸的通道零行为变化（M0 直发）。
 */
export class UiFanout {
  readonly #conveyors = new Set<Conveyor>();
  readonly #gates = new Map<Conveyor, GatedEntry>();

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
   * @param gate - 重放闸；提供则该通道在 `release` 前 live 广播先进 FIFO（hello 重放编排用），
   *   缺省 = M0 行为（广播直发）
   * 副作用：加入广播集合，立即开始接收后续会话事件（带闸时改为暂存）
   */
  attach(conveyor: Conveyor, gate?: ReplayGate): void {
    this.#conveyors.add(conveyor);
    if (gate !== undefined) this.#gates.set(conveyor, { gate, fifo: [] });
  }

  /**
   * 摘除一条通道（连接关闭时调用）；未挂接时什么都不做。
   *
   * @param conveyor - 要摘除的通道
   * 副作用：移出广播集合；带闸通道的 FIFO 与闸一并废弃（重连会重走重放，弃帧无害）
   */
  detach(conveyor: Conveyor): void {
    this.#conveyors.delete(conveyor);
    this.#gates.delete(conveyor);
  }

  /**
   * 开闸并冲刷：把 attach 以来排队的帧按**入队序**补发，冲刷时对每帧做**终判去重**
   * （`seq <= replayedMax.get(sessionId)` 丢弃——此刻分页已毕、replayedMax 为终值，
   * 凡 ≤ 终值者必已直发，丢弃的是重复副本；> 终值者照常冲出，零丢失——见 `ReplayGate`
   * 契约注释的两道判定），随后摘除闸；通道此后回到直发（仍在广播集合，不 detach）。
   *
   * @param conveyor - 目标通道
   * @param gate - attach 时提供的同一闸实例（不匹配视作未挂闸，幂等 no-op）
   * 副作用：冲刷 FIFO（含终判去重）、摘除闸条目；此后该通道的广播直发
   */
  release(conveyor: Conveyor, gate: ReplayGate): void {
    const entry = this.#gates.get(conveyor);
    if (entry === undefined || entry.gate !== gate) return;
    gate.open();
    this.#gates.delete(conveyor); // 先摘闸再冲刷：冲刷期间的新广播直发（同步循环，无重入窗口）
    for (const frame of entry.fifo.splice(0)) {
      // 冲刷终判（两道判定的第二道）：入队后 replayedMax 推进越过的帧在此拦下，不双发。
      if (frame.seq <= (gate.replayedMax.get(frame.sessionId) ?? -1)) continue;
      conveyor.send(frame);
    }
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
    for (const conveyor of this.#conveyors) {
      const entry = this.#gates.get(conveyor);
      if (entry !== undefined) {
        // 未开闸：按入队时刻的 replayedMax 一次性去重（seq <= 视为重放已直送，丢弃）；
        // 会话缺项视作 -1（重放尚未触达该会话，零去重）。
        if (rec.seq <= (entry.gate.replayedMax.get(rec.sessionId) ?? -1)) continue;
        entry.fifo.push(frame);
        continue;
      }
      conveyor.send(frame);
    }
  }
}
