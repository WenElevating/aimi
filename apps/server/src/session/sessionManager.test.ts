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

/** 可脚本化假适配器：安装可控、emit 可控、send/dispose 计数。 */
function fakeAdapter(opts: { installed?: boolean } = {}): AgentAdapter & {
  emit: (e: AgentEvent) => void;
  sends: unknown[];
  disposes: number;
  starts: number;
} {
  let emitFn: ((e: AgentEvent) => void) | undefined;
  const state = { sends: [] as unknown[], disposes: 0, starts: 0 };
  const session: AgentSession = {
    start: async () => { state.starts++; },
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

function harness(adapter: AgentAdapter) {
  const bus = new EventBus();
  const conversations = new MemoryConversationRepository();
  const bus2 = bus; // 别名，语义更清楚
  const persisted: { sessionId: string; seq: number; agentEvent: AgentEvent }[] = [];
  bus.subscribe({
    persist: async (rec) => { persisted.push(rec); await conversations.appendEvent(rec.sessionId, rec.seq, rec.agentEvent, rec.ts); },
  });
  const agents: AgentLookup = { get: (id) => (id === adapter.meta.id ? adapter : undefined) };
  const sessions = new SessionManager({ conversations, bus: bus2, agents });
  return { bus, conversations, persisted, sessions };
}

/**
 * 让浮空的 publish → persist 链跑完。
 * `EventBus.flush()` 只冲刷 delta 聚合槽；非 delta 事件的落库链是异步续跑，
 * 故再让出一轮宏任务（宏任务开始前微任务必已排空）。
 * ——这是本文件相对简报测试原文的唯一改动（原文仅 `await bus.flush()`，
 * 实测那时 persisted 尚未收到事件）；断言与语义未变。
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

  it("archived 恢复不拉子进程；resumable resume 重挂并 starting", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");
    await h.sessions.stop(meta.id);
    // 重建 manager 模拟 server 重启：从仓储恢复
    const h2bus = new EventBus();
    const h2persisted: { seq: number; agentEvent: AgentEvent }[] = [];
    h2bus.subscribe({ persist: async (rec) => { h2persisted.push(rec); } });
    const sessions2 = new SessionManager({ conversations: h.conversations, bus: h2bus, agents: { get: () => adapter } });
    const adopted = await sessions2.create(SPEC, "archived"); // 同 agentId+cwd 的已有会话——返回其 meta，不拉子进程
    expect(adopted.id).toBe(meta.id);
    expect(adapter.starts).toBe(1);                    // 恢复路径不拉子进程
    await sessions2.resume(meta.id);
    expect(adapter.starts).toBe(2);
    await settle(h2bus);
    expect(h2persisted.at(-1)!.agentEvent).toEqual({ type: "state", state: "starting" });
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
