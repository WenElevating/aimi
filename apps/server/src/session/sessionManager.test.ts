import { describe, expect, it } from "vitest";
import { SessionManager } from "./sessionManager.js";
import { PhoneCommandPipe } from "./commands.js";
import { EventBus } from "../events/eventBus.js";
import { MemoryConversationRepository } from "../persistence/memory/memoryConversationRepository.js";
import { MemoryCommandDedupRepository } from "../persistence/memory/memoryCommandDedupRepository.js";
import { MemoryAuditRepository } from "../persistence/memory/memoryAuditRepository.js";
import { AuditWriter } from "../audit/auditWriter.js";
import type { AgentAdapter, AgentSession, AgentLookup } from "../agents/types.js";
import type { AgentEvent, SessionSpec } from "@aimi/protocol";

/**
 * 造一个可脚本化的假适配器：可配置是否装得上、start 内可注入同步 emit 或抛错，并统计 send/dispose/start 次数。
 *
 * @param opts.installed - 安装探测结果；缺省视为已安装
 * @param opts.onStart - `start()` 期间调用的钩子，可借它同步 emit 事件
 * @param opts.startThrows - 非空时 `start()` 抛出该错误
 * @returns 假适配器，另带 emit 句柄与 send/dispose/start 计数
 */
function fakeAdapter(opts: { installed?: boolean; onStart?: (emit: (e: AgentEvent) => void) => void; startThrows?: Error } = {}): AgentAdapter & {
  emit: (e: AgentEvent) => void;
  sends: unknown[];
  disposes: number;
  starts: number;
} {
  let emitFn: ((e: AgentEvent) => void) | undefined;
  const state = { sends: [] as unknown[], disposes: 0, starts: 0 };
  const session: AgentSession = {
    start: async () => { state.starts++; if (opts.startThrows !== undefined) throw opts.startThrows; opts.onStart?.(emitFn!); }, // 真适配器可在 start() 内同步 emit
    send: async (cmd) => { state.sends.push(cmd); },
    dispose: async () => { state.disposes++; },
  };
  return {
    meta: { id: "fake", label: "Fake" },
    isInstalled: async () => ({ ok: opts.installed ?? true }),
    create: (_spec, emit) => { emitFn = emit; return session; },
    get emit() { return emitFn!; },
    get sends() { return state.sends; },
    get disposes() { return state.disposes; },
    get starts() { return state.starts; },
  };
}

/**
 * 用假适配器装配一套最小编排环境（事件总线 + 内存仓储 + 会话管理器）。
 *
 * @param adapter - 唯一可被查到的假适配器
 * @returns 该环境的各部件句柄，供断言落库事件与仓储状态
 */
function harness(adapter: AgentAdapter) {
  const bus = new EventBus();
  const conversations = new MemoryConversationRepository();
  const bus2 = bus; // 与返回的 bus 是同一实例，仅换个名字传入
  const persisted: { sessionId: string; seq: number; agentEvent: AgentEvent }[] = [];
  bus.subscribe({
    persist: async (rec) => { persisted.push(rec); await conversations.appendEvent(rec.sessionId, rec.seq, rec.agentEvent, rec.ts); },
  });
  const agents: AgentLookup = { get: (id) => (id === adapter.meta.id ? adapter : undefined) };
  const sessions = new SessionManager({ conversations, bus: bus2, agents });
  return { bus, conversations, persisted, sessions };
}

/**
 * 让浮空的发布到落库链跑完。
 * `EventBus.flush()` 只冲刷 delta 聚合槽；非 delta 事件的落库链是异步续跑，
 * 故再让出一轮宏任务（宏任务开始前微任务必已排空）。
 *
 * @param bus - 待冲刷的事件总线
 * @returns Promise，resolve 表示本轮发布与落库已完成
 */
async function settle(bus: EventBus): Promise<void> {
  await bus.flush();
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

const SPEC: SessionSpec = { agentId: "fake", cwd: "D:\\w", permissionMode: "default" };

describe("SessionManager 编排（§C 三态）", () => {
  it("new：初始 starting(seq0)→running 合法跃迁落库；非法跃迁改发 notice 且状态保持", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");
    adapter.emit({ type: "state", state: "running" });          // 合法：starting→running
    adapter.emit({ type: "state", state: "waiting_approval" }); // 合法：running→waiting_approval
    adapter.emit({ type: "state", state: "waiting_input" });    // 非法：waiting_approval→waiting_input 不在白名单
    await settle(h.bus);
    const kinds = h.persisted.map((p) => (p.agentEvent.type === "state" ? `state:${p.agentEvent.state}` : p.agentEvent.type));
    expect(kinds).toEqual(["state:starting", "state:running", "state:waiting_approval", "notice"]);
    const notice = h.persisted.at(-1)!.agentEvent as { type: "notice"; text: string };
    expect(notice.text).toContain("waiting_approval→waiting_input");
    const after = (await h.conversations.listSessions()).find((s) => s.id === meta.id)!;
    expect(after.state).toBe("waiting_approval");
  });

  it("create 对未安装/未知 agent 抛 agent_missing", async () => {
    const notInstalled = fakeAdapter({ installed: false });
    const h1 = harness(notInstalled);
    await expect(h1.sessions.create(SPEC, "new")).rejects.toThrow(/agent_missing/);
    const h2 = harness(fakeAdapter());
    await expect(h2.sessions.create({ ...SPEC, agentId: "unknown" }, "new")).rejects.toThrow(/agent_missing/);
  });

  it("stop：dispose + state stopped（幂等）；restart：重挂 + starting", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");
    await h.sessions.stop(meta.id);
    expect(adapter.disposes).toBe(1);
    await h.sessions.stop(meta.id);                    // 幂等
    expect(adapter.disposes).toBe(1);
    const states = h.persisted.filter((p) => p.agentEvent.type === "state").map((p) => (p.agentEvent as any).state);
    expect(states).toEqual(["starting", "stopped"]);
    await h.sessions.restart(meta.id);
    expect(adapter.disposes).toBe(1);                  // 已终态 stop 不重复 dispose
    expect(adapter.starts).toBe(2);                    // 重新 create+start
    await settle(h.bus);
    expect(h.persisted.at(-1)!.agentEvent).toEqual({ type: "state", state: "starting" });
  });

  it("resumable 恢复不拉子进程；resume 重挂并 starting", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");
    await h.sessions.stop(meta.id);
    // 重建 manager 模拟 server 重启：从仓储恢复
    const h2bus = new EventBus();
    const h2persisted: { seq: number; agentEvent: AgentEvent }[] = [];
    h2bus.subscribe({ persist: async (rec) => { h2persisted.push(rec); } });
    const sessions2 = new SessionManager({ conversations: h.conversations, bus: h2bus, agents: { get: () => adapter } });
    const adopted = await sessions2.create(SPEC, "resumable"); // 同 agentId+cwd 的已有会话——返回其 meta，不拉子进程
    expect(adopted.id).toBe(meta.id);
    expect(adapter.starts).toBe(1);                    // 恢复路径不拉子进程
    await sessions2.resume(meta.id);
    expect(adapter.starts).toBe(2);
    await settle(h2bus);
    expect(h2persisted.at(-1)!.agentEvent).toEqual({ type: "state", state: "starting" });
  });

  it("archived=历史可查不可续跑：恢复不拉子进程，resume 一律拒绝", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");
    await h.sessions.stop(meta.id);
    const h2bus = new EventBus();
    const sessions2 = new SessionManager({ conversations: h.conversations, bus: h2bus, agents: { get: () => adapter } });
    const adopted = await sessions2.create(SPEC, "archived"); // 同 agentId+cwd 的已有会话——返回其 meta，不拉子进程
    expect(adopted.id).toBe(meta.id);
    expect(adopted.state).toBe("stopped");
    expect(adapter.starts).toBe(1);                    // 恢复路径不拉子进程
    await expect(sessions2.resume(meta.id)).rejects.toThrow(/not resumable/);
    expect(adapter.starts).toBe(1);                    // 拒绝路径也不重挂
  });

  it("起始态窗口：resume/restart 时 start() 内同步 emit running 不被误判（无 notice，starting 先行）", async () => {
    const adapter = fakeAdapter({ onStart: (emit) => { emit({ type: "state", state: "running" }); } });
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");
    await h.sessions.stop(meta.id);
    await settle(h.bus);
    // create 路同样起始态先行：先 starting(seq0)，再适配器 start 内 emit 的 running，最后 stopped
    const created = h.persisted.map((p) => (p.agentEvent.type === "state" ? `state:${p.agentEvent.state}` : p.agentEvent.type));
    expect(created).toEqual(["state:starting", "state:running", "state:stopped"]);
    // 重建 manager 模拟 server 重启：resumable 才有续接线索
    const h2bus = new EventBus();
    const h2persisted: { seq: number; agentEvent: AgentEvent }[] = [];
    h2bus.subscribe({ persist: async (rec) => { h2persisted.push(rec); } });
    const sessions2 = new SessionManager({ conversations: h.conversations, bus: h2bus, agents: { get: () => adapter } });
    await sessions2.create(SPEC, "resumable");
    await sessions2.resume(meta.id);                        // start() 内同步 emit running
    await sessions2.restart(meta.id);                       // 活动态重启：start() 内同步 emit running
    await settle(h2bus);
    const kinds = h2persisted.map((p) => (p.agentEvent.type === "state" ? `state:${p.agentEvent.state}` : p.agentEvent.type));
    // resume：starting 到 running；restart：stopped 到 starting 再到 running（起始态先入 seq，runng 合法跟随）
    expect(kinds).toEqual([
      "state:starting", "state:running",
      "state:stopped", "state:starting", "state:running",
    ]);
    expect(h2persisted.some((p) => p.agentEvent.type === "notice")).toBe(false); // 无 invalid transition 误判
  });

  it("restart 回收自然终态的遗留句柄（agent emit finished 后句柄未清）", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");
    adapter.emit({ type: "state", state: "running" });
    adapter.emit({ type: "state", state: "finished" });     // 自然终态：不经过 stop，句柄仍在
    await settle(h.bus);
    expect(adapter.disposes).toBe(0);
    await h.sessions.restart(meta.id);
    expect(adapter.disposes).toBe(1);                       // 旧句柄被回收
    expect(adapter.starts).toBe(2);                         // 新句柄拉起
    await settle(h.bus);
    expect(h.persisted.at(-1)!.agentEvent).toEqual({ type: "state", state: "starting" });
  });

  it("start 抛错 → 幽灵行恢复：落 failed、清理句柄，原错误仍抛出", async () => {
    const adapter = fakeAdapter({ startThrows: new Error("spawn failed: ENOENT") });
    const h = harness(adapter);
    await expect(h.sessions.create(SPEC, "new")).rejects.toThrow("spawn failed: ENOENT");
    await settle(h.bus);
    const all = await h.conversations.listSessions();
    expect(all).toHaveLength(1);
    expect(all[0]!.state).toBe("failed");                 // 幽灵行恢复为 failed（非残留 starting）
    expect(adapter.disposes).toBe(1);                     // 幽灵句柄被清理
    const kinds = h.persisted.map((p) => (p.agentEvent.type === "state" ? `state:${p.agentEvent.state}` : p.agentEvent.type));
    expect(kinds).toEqual(["state:starting", "state:failed"]); // 持久化流含 failed
  });

  it("恢复路径无匹配会话 → session not found；未注册/非终态会话不可 resume", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    await expect(h.sessions.create(SPEC, "archived")).rejects.toThrow(/session not found/);
    const meta = await h.sessions.create(SPEC, "new");
    await expect(h.sessions.resume(meta.id)).rejects.toThrow(/not resumable/); // kind=new 且状态非终态
    await expect(h.sessions.stop("no-such-session")).rejects.toThrow(/session not found/);
    expect(adapter.starts).toBe(1);                    // 失败路径不重挂
  });
});

describe("PhoneCommandPipe（幂等/审计/分发）", () => {
  it("重复 clientId 不执行两遍；审计 command.interrupt + command.duplicate", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");
    const auditRepo = new MemoryAuditRepository(); await auditRepo.init();
    const pipe = new PhoneCommandPipe({
      sessions: h.sessions, bus: h.bus,
      dedup: await (async () => { const d = new MemoryCommandDedupRepository(); await d.init(); return d; })(),
      audit: new AuditWriter(auditRepo),
    });
    const frame = { v: 1 as const, type: "session.command" as const, sessionId: meta.id, clientId: "cid-12345678", cmd: { cmd: "interrupt" } as const };
    await pipe.handle(frame, { deviceId: "d1", name: "phone" });
    await pipe.handle(frame, { deviceId: "d1", name: "phone" });
    expect(adapter.sends).toHaveLength(1);             // 只执行一遍
    const rows = await auditRepo.recent(10);
    expect(rows.map((r) => r.action).sort()).toEqual(["command.duplicate", "command.interrupt"]);
  });

  it("非活动会话命令 → notice error（session not active）", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");
    await h.sessions.stop(meta.id);
    const auditRepo = new MemoryAuditRepository(); await auditRepo.init();
    const pipe = new PhoneCommandPipe({ sessions: h.sessions, bus: h.bus, dedup: new MemoryCommandDedupRepository(), audit: new AuditWriter(auditRepo) });
    await pipe.handle({ v: 1, type: "session.command", sessionId: meta.id, clientId: "cid-87654321", cmd: { cmd: "send", text: "hi" } }, { deviceId: "d1", name: "phone" });
    await settle(h.bus);
    const last = h.persisted.at(-1)!.agentEvent as { type: "notice"; text: string };
    expect(last.text).toContain("session not active");
  });
});
