import type { SessionState } from "@aimi/protocol";

/**
 * 会话状态跃迁白名单：表格式穷举，无隐式跃迁。
 * 行 = 当前状态，值是允许的下一状态；`finished`/`failed`/`stopped` 出度为 0（终态）。
 * 唯一消费者是 `SessionManager` 的 emit 包装层（agent 事件先过此表；非法跃迁改发 notice 且状态保持）。
 */
export const TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  starting: ["running", "failed", "stopped"],
  running: ["waiting_approval", "waiting_input", "finished", "failed", "stopped"],
  waiting_approval: ["running", "failed", "stopped"],
  waiting_input: ["running", "finished", "failed", "stopped"],
  finished: [], failed: [], stopped: [],
};

/**
 * 判定一次跃迁是否在白名单内（纯查表，无副作用）。
 * @param from 当前状态。
 * @param to 目标状态。
 */
export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].includes(to);
}
