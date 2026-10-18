import { describe, expect, it } from "vitest";
import { SessionManager } from "./sessionManager.js";
import { PhoneCommandPipe } from "./commands.js";
import { EventBus } from "../events/eventBus.js";
import { MemoryConversationRepository } from "../persistence/memory/memoryConversationRepository.js";
import { MemoryCommandDedupRepository } from "../persistence/memory/memoryCommandDedupRepository.js";
import { MemoryAuditRepository } from "../persistence/memory/memoryAuditRepository.js";
import { MemoryProcessLedgerRepository } from "../persistence/memory/memoryProcessLedgerRepository.js";
import { AuditWriter } from "../audit/auditWriter.js";
import type { AgentAdapter, AgentLookup, AgentRuntime, AgentSession } from "../agents/types.js";
import type { ProcessLedgerRepository } from "../persistence/types.js";
import type { AgentEvent, SessionSpec } from "@aimi/protocol";

/**
 * 造一个可脚本化的假适配器：可配置是否装得上、start 内可注入同步 emit 或抛错、
 * 可注入 `runtime()` 快照（运行时采集面），并统计 send/dispose/start 次数与每次 create 的续接线索。
 *
 * @param opts.installed - 安装探测结果；缺省视为已安装
 * @param opts.onStart - `start()` 期间调用的钩子，可借它同步 emit 事件
 * @param opts.startThrows - 非空时 `start()` 抛出该错误
 * @param opts.runtime - 非空时句柄携带该 `runtime()` 实现（pid/hint 采集测试用）
 * @returns 假适配器，另带 emit 句柄、send/dispose/start 计数与 resumes（每次 create 收到的 hint）
 */
function fakeAdapter(opts: {
  installed?: boolean;
  onStart?: (emit: (e: AgentEvent) => void) => void;
  startThrows?: Error;
  runtime?: () => AgentRuntime | null;
  isAlive?: () => boolean;
} = {}): AgentAdapter & {
  emit: (e: AgentEvent) => void;
  readonly emits: readonly ((e: AgentEvent) => void)[];
  sends: unknown[];
  disposes: number;
  starts: number;
  resumes: (string | undefined)[];
} {
  let emitFn: ((e: AgentEvent) => void) | undefined;
  const emits: ((e: AgentEvent) => void)[] = [];
  const state = { sends: [] as unknown[], disposes: 0, starts: 0 };
  const resumes: (string | undefined)[] = [];
  const session: AgentSession = {
    start: async () => { state.starts++; if (opts.startThrows !== undefined) throw opts.startThrows; opts.onStart?.(emitFn!); }, // 真适配器可在 start() 内同步 emit
    send: async (cmd) => { state.sends.push(cmd); },
    dispose: async () => { state.disposes++; },
    runtime: opts.runtime, // 可选采集面：缺省不携带（编排层须跳过）
    isAlive: opts.isAlive, // 可选探针：缺省不携带（编排层按"句柄在即活"兼容口径）
  };
  return {
    meta: { id: "fake", label: "Fake" },
    isInstalled: async () => ({ ok: opts.installed ?? true }),
    create: (_spec, emit, resume) => { emitFn = emit; emits.push(emit); resumes.push(resume?.hint); return session; },
    get emit() { return emitFn!; },
    /** 按句柄序取 emit（0=首个句柄）：残流抑制按句柄 token 的测试用——旧句柄/新句柄分轨发帧 */
    emits,
    get sends() { return state.sends; },
    get disposes() { return state.disposes; },
    get starts() { return state.starts; },
    get resumes() { return resumes; },
  } satisfies AgentAdapter & {
    emit: (e: AgentEvent) => void;
    emits: ((e: AgentEvent) => void)[];
    sends: unknown[];
    disposes: number;
    starts: number;
    resumes: (string | undefined)[];
  };
}

/**
 * 用假适配器装配一套最小编排环境（事件总线 + 内存仓储 + 会话管理器）。
 *
 * @param adapter - 唯一可被查到的假适配器
 * @param opts.ledger - 非空时注入进程台账（运行时采集/dispose 清行测试用）
 * @returns 该环境的各部件句柄，供断言落库事件与仓储状态
 */
function harness(adapter: AgentAdapter, opts: { ledger?: ProcessLedgerRepository } = {}) {
  const bus = new EventBus();
  const conversations = new MemoryConversationRepository();
  const bus2 = bus; // 与返回的 bus 是同一实例，仅换个名字传入
  const persisted: { sessionId: string; seq: number; agentEvent: AgentEvent }[] = [];
  bus.subscribe({
    persist: async (rec) => { persisted.push(rec); await conversations.appendEvent(rec.sessionId, rec.seq, rec.agentEvent, rec.ts); },
  });
  const agents: AgentLookup = { get: (id) => (id === adapter.meta.id ? adapter : undefined) };
  const sessions = new SessionManager({
    conversations,
    bus: bus2,
    agents,
    ledger: opts.ledger, // 可缺省：不测台账面时保持极简装配
  });
  return { bus, conversations, persisted, sessions, ledger: opts.ledger };
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

  it("停止后会话命令 → notice error（会话已过期，仅可查阅历史）", async () => {
    // 停止后 resume hint 仍在、历史可查，属 expired 分流；"session not active"
    // 仅留给连会话都找不到的 inactive 路（见"不可用分流②"）。
    const adapter = fakeAdapter();
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");
    await h.sessions.stop(meta.id);
    const auditRepo = new MemoryAuditRepository(); await auditRepo.init();
    const pipe = new PhoneCommandPipe({ sessions: h.sessions, bus: h.bus, dedup: new MemoryCommandDedupRepository(), audit: new AuditWriter(auditRepo) });
    await pipe.handle({ v: 1, type: "session.command", sessionId: meta.id, clientId: "cid-87654321", cmd: { cmd: "send", text: "hi" } }, { deviceId: "d1", name: "phone" });
    await settle(h.bus);
    const last = h.persisted.at(-1)!.agentEvent as { type: "notice"; text: string };
    expect(last.text).toContain("会话已过期");
  });

  it("不可用分流②：未知会话命令 → notice error（session not active）", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    await h.sessions.create(SPEC, "new");
    const auditRepo = new MemoryAuditRepository(); await auditRepo.init();
    const pipe = new PhoneCommandPipe({ sessions: h.sessions, bus: h.bus, dedup: new MemoryCommandDedupRepository(), audit: new AuditWriter(auditRepo) });
    await pipe.handle(
      { v: 1, type: "session.command", sessionId: "no-such", clientId: "cid-inactive-1", cmd: { cmd: "send", text: "hi" } },
      { deviceId: "d1", name: "phone" },
    );
    await settle(h.bus);
    const last = h.persisted.at(-1)!.agentEvent as { type: "notice"; text: string };
    expect(last.text).toContain("session not active");
  });
});

/**
 * Task 4：会话门三路 / 停止语义 / 运行时台账（core-loop §5.1 与计划 4.2-4.5 的单测面）。
 */
describe("Task 4：会话门三路/停止语义/运行时台账", () => {
  /** 只看事件形态序列（state 展开为 `state:<值>`），供守门/抑制断言复用。 */
  const kindsOf = (rows: { agentEvent: AgentEvent }[]): string[] =>
    rows.map((p) => (p.agentEvent.type === "state" ? `state:${p.agentEvent.state}` : p.agentEvent.type));

  /**
   * 带 pid 采集留痕的内存台账：register 一侧车记录，便于断言「首现/变更」与浮动链收账次序。
   *
   * @returns 台账（注入 SessionManager）、登记留痕数组、被包住的原生内存实现
   */
  async function captureLedger(): Promise<{
    ledger: ProcessLedgerRepository;
    registered: [string, number][];
    inner: MemoryProcessLedgerRepository;
  }> {
    const inner = new MemoryProcessLedgerRepository();
    await inner.init();
    const registered: [string, number][] = [];
    const ledger: ProcessLedgerRepository = {
      init: async () => {},
      register: async (sessionId, pid) => { await inner.register(sessionId, pid); registered.push([sessionId, pid]); },
      clear: (sessionId) => inner.clear(sessionId),
      list: () => inner.list(),
      close: async () => {},
    };
    return { ledger, registered, inner };
  }

  it("会话门路1：活句柄原路交付；自然终态句柄开新回合先行 starting（服务端事实）", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");
    expect(await h.sessions.send(meta.id, { cmd: "send", text: "hi" })).toBe("delivered");
    await settle(h.bus);
    expect(kindsOf(h.persisted)).toEqual(["state:starting"]); // 非终态交付零额外帧
    expect(adapter.sends).toEqual([{ cmd: "send", text: "hi" }]);

    adapter.emit({ type: "state", state: "running" });         // starting→running 合法跃迁
    adapter.emit({ type: "state", state: "finished" });        // 自然终态：句柄不回收（免冷启动红利）
    await settle(h.bus);
    expect(adapter.disposes).toBe(0);
    const before = h.persisted.length;
    expect(await h.sessions.send(meta.id, { cmd: "send", text: "again" })).toBe("delivered");
    await settle(h.bus);
    expect(kindsOf(h.persisted.slice(before))).toEqual(["state:starting"]); // 新回合 starting 先行入册
    expect(adapter.sends).toEqual([{ cmd: "send", text: "hi" }, { cmd: "send", text: "again" }]);
  });

  it("会话门路2：死句柄 resumable+hint → send 即续接（starting 先行、create 带线索、seq 接续）", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    await h.conversations.createSession({ id: "s-old", agentId: "fake", cwd: "D:\\w", permissionMode: "default" }, null);
    await h.conversations.updateSession("s-old", { state: "finished", lastSeq: 2 });
    const meta = (await h.conversations.listSessions())[0]!;
    await h.sessions.adopt(meta, "cls-hint-1");                 // hint 有 → 派生 resumable
    expect(await h.sessions.send("no-such", { cmd: "send", text: "x" })).toBe("inactive");

    expect(await h.sessions.send("s-old", { cmd: "send", text: "resume!" })).toBe("delivered");
    expect(adapter.resumes).toEqual(["cls-hint-1"]);            // adapter.create(spec, emit, {hint})
    expect(adapter.starts).toBe(1);                             // 重挂恰一次
    expect(adapter.sends).toEqual([{ cmd: "send", text: "resume!" }]);
    await settle(h.bus);
    expect(kindsOf(h.persisted)).toEqual(["state:starting"]);   // 服务端事实先行
    expect(h.persisted[0]!.seq).toBe(3);                        // seq 接续仓储 lastSeq+1（seedSession 生效）
  });

  it("会话门路3：死句柄无 hint → expired（不起进程不交付零事件）；未知 → inactive", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");
    await h.sessions.stop(meta.id);                             // 死句柄（kind=new、无 hint）
    const starts = adapter.starts;
    expect(await h.sessions.send(meta.id, { cmd: "send", text: "x" })).toBe("expired");
    expect(await h.sessions.interrupt(meta.id)).toBe("expired"); // interrupt 同口径，绝不复活子进程
    expect(adapter.starts).toBe(starts);
    expect(adapter.sends).toHaveLength(0);
    expect(h.persisted.every((p) => p.agentEvent.type !== "notice")).toBe(true); // 三路零副作用：不产帧
    expect(await h.sessions.send("no-such", { cmd: "send", text: "x" })).toBe("inactive");
  });

  it("会话门探针：进程已退出（isAlive=false）的僵句柄 → send 自动续接、interrupt 查询语义", async () => {
    let alive = true;
    const adapter = fakeAdapter({ isAlive: () => alive, runtime: () => ({ pid: 101, resumeHint: "cls-dead-1" }) });
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");
    adapter.emit({ type: "state", state: "running" });
    await settle(h.bus);

    // 进程死亡（崩溃/自退）：句柄仍在（未 dispose）但探针报死——send 必须分流到续接路径，
    // 而不是把指令写进死 stdin 被静默丢弃（评审 Task 6 gotcha 2：手机端会永远等不到回应）。
    alive = false;
    const starts = adapter.starts;
    expect(await h.sessions.send(meta.id, { cmd: "send", text: "after crash" })).toBe("delivered");
    expect(adapter.resumes).toEqual([undefined, "cls-dead-1"]); // 首次 create 无线索；续接 create 带 --resume（hint 来自运行时采集）
    expect(adapter.starts).toBe(starts + 1);          // 重挂恰一次
    expect(adapter.sends).toEqual([{ cmd: "send", text: "after crash" }]); // 交付给新句柄

    expect(await h.sessions.interrupt(meta.id)).toBe("inactive"); // 死句柄查询语义：不复活、不写帧
  });

  it("interrupt：控制帧 + 服务端事实 stopped（不 dispose）；迟到同态 stopped 去重零新帧", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");
    expect(await h.sessions.interrupt(meta.id)).toBe("delivered");
    expect(adapter.sends).toEqual([{ cmd: "interrupt" }]);
    expect(adapter.disposes).toBe(0);                           // SPIKE FACT2：进程存活，同进程可再开回合
    await settle(h.bus);
    expect(kindsOf(h.persisted)).toEqual(["state:starting", "state:stopped"]);
    expect(h.persisted.at(-1)!.agentEvent).toEqual({ type: "state", state: "stopped" });

    adapter.emit({ type: "state", state: "stopped" });          // CLI 迟到的 result→stopped 同态帧
    await settle(h.bus);
    expect(h.persisted).toHaveLength(2);                        // 同状态去重：静默忽略，无新帧

    expect(await h.sessions.send(meta.id, { cmd: "send", text: "next" })).toBe("delivered"); // 同进程开新回合
    await settle(h.bus);
    expect(adapter.sends).toEqual([{ cmd: "interrupt" }, { cmd: "send", text: "next" }]);
    expect(h.persisted.at(-1)!.agentEvent).toEqual({ type: "state", state: "starting" });
  });

  it("停止/重启残流抑制：旧句柄迟到 state 帧一律丢弃（exit 例外照常放行）", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");
    await h.sessions.stop(meta.id);                             // stopped 服务端事实已先入册
    adapter.emit({ type: "state", state: "running" });          // killTree 后的迟到帧
    adapter.emit({ type: "exit", exitCode: 1, durationMs: 5 }); // 非 state 事件放行
    await settle(h.bus);
    expect(kindsOf(h.persisted)).toEqual(["state:starting", "state:stopped", "exit"]); // running 被抑制

    await h.sessions.restart(meta.id);                          // 句柄已被 stop 清 → 末尾不重新置位
    adapter.emit({ type: "state", state: "running" });          // 新句柄正常流：starting→running 合法
    await settle(h.bus);
    expect(kindsOf(h.persisted)).toEqual(["state:starting", "state:stopped", "exit", "state:starting", "state:running"]);

    await h.sessions.restart(meta.id);                          // 活动句柄重启 → 旧句柄 token 作废、新句柄 token 独立
    adapter.emits[1]!({ type: "state", state: "waiting_approval" }); // 旧句柄（刚被回收）残流 → 丢弃
    adapter.emit({ type: "state", state: "running" });          // 新句柄正常流：starting→running 合法（评审①：不得被旧残流抑制染指）
    adapter.emit({ type: "exit", exitCode: 99, durationMs: 1 }); // 非 state 事件照常放行
    await settle(h.bus);
    expect(kindsOf(h.persisted)).toEqual([
      "state:starting", "state:stopped", "exit", "state:starting", "state:running",
      "state:stopped", "state:starting", "state:running", "exit", // 旧句柄 waiting_approval 丢弃；新句柄 running 照常入册
    ]);
  });

  it("运行时台账：pid 首现/变更即登记，hint 首现/变更即回写；dispose 清台账不动已捕获线索", async () => {
    const { ledger, registered, inner } = await captureLedger();
    let snap: AgentRuntime = { pid: 100, resumeHint: "cls-rt-1" };
    const adapter = fakeAdapter({ runtime: () => ({ ...snap }) });
    const h = harness(adapter, { ledger });
    const meta = await h.sessions.create(SPEC, "new");

    adapter.emit({ type: "text_delta", text: "a" });            // 事件触发拉取式采集（浮动链）
    await settle(h.bus);                                        // 宏任务排空前微任务必已清——浮动链已落账
    expect(registered).toEqual([[meta.id, 100]]);               // pid 首现登记
    expect(await h.conversations.getSessionHint(meta.id)).toBe("cls-rt-1"); // hint 首现回写

    snap = { pid: 200, resumeHint: "cls-rt-1" };
    adapter.emit({ type: "text_delta", text: "b" });
    await settle(h.bus);
    expect(registered).toEqual([[meta.id, 100], [meta.id, 200]]); // pid 变更重拉覆盖
    expect(await inner.list()).toEqual([{ sessionId: meta.id, pid: 200 }]); // 台账一行一会话

    snap = { pid: 200, resumeHint: "cls-fork" };
    adapter.emit({ type: "text_delta", text: "c" });
    await settle(h.bus);
    expect(registered).toHaveLength(2);                         // pid 未变不重拉
    expect(await h.conversations.getSessionHint(meta.id)).toBe("cls-fork"); // fork 口径：变更才写

    await h.sessions.stop(meta.id);                             // 收尸与撤销同事务语义
    expect(await inner.list()).toEqual([]);                     // 台账行清空
    expect(await h.conversations.getSessionHint(meta.id)).toBe("cls-fork"); // 已捕获线索保留（历史可查）
  });

  it("restart 以 managed.hint 续接同一 agent 侧上下文（修 M0 重启断上下文缺口）", async () => {
    const { ledger, registered } = await captureLedger();
    const adapter = fakeAdapter({ runtime: () => ({ pid: 77, resumeHint: "cls-restart" }) });
    const h = harness(adapter, { ledger });
    const meta = await h.sessions.create(SPEC, "new");
    adapter.emit({ type: "text_delta", text: "x" });            // hint 首现采集进 ManagedSession
    await settle(h.bus);
    expect(registered).toEqual([[meta.id, 77]]);

    await h.sessions.restart(meta.id);                          // 非终态：先 stop 再以线索重挂
    expect(adapter.resumes).toEqual([undefined, "cls-restart"]); // 首次无线索，重启续接同上下文
    expect(adapter.starts).toBe(2);
  });

  it("adopt：带 hint → resumable（门路2 可续接）；无 hint → archived（send 恒 expired）", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    await h.conversations.createSession({ id: "s-arch", agentId: "fake", cwd: "D:\\w", permissionMode: "default" }, null);
    await h.conversations.updateSession("s-arch", { state: "failed" });
    await h.conversations.createSession({ id: "s-hint", agentId: "fake", cwd: "D:\\w", permissionMode: "default" }, null);
    await h.conversations.updateSession("s-hint", { state: "finished" });
    const metas = await h.conversations.listSessions();
    await h.sessions.adopt(metas.find((m) => m.id === "s-arch")!, null);
    await h.sessions.adopt(metas.find((m) => m.id === "s-hint")!, "cls-b");

    expect(await h.sessions.send("s-arch", { cmd: "send", text: "x" })).toBe("expired");
    expect(adapter.starts).toBe(0);                             // archived 绝不起进程
    expect(await h.sessions.send("s-hint", { cmd: "send", text: "resume!" })).toBe("delivered");
    expect(adapter.resumes).toEqual(["cls-b"]);
    expect(adapter.starts).toBe(1);
  });
});

/**
 * Task 7：审批 waiting 门（晚到失效）与恢复挂起卡失效标注（core-loop §5.5）。
 * 原则：不静默吞、不代答——晚到/悬空的 approve 消费为一条失效 notice。
 */
describe("Task 7：waiting 门与中断挂起失效", () => {
  it("waiting 门：非 waiting 态 approve → 失效 warn notice + delivered，CLI 未收指令（starting/running 两形）", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");          // state=starting
    expect(await h.sessions.send(meta.id, { cmd: "approve", requestId: "perm-x", decision: "once" })).toBe("delivered");
    await settle(h.bus);
    expect(h.persisted.at(-1)!.agentEvent).toEqual({ type: "notice", severity: "warn", text: "审批已失效（会话已不在等待态）" });
    expect(adapter.sends).toHaveLength(0);                     // 未写 CLI（不代答）

    adapter.emit({ type: "state", state: "running" });
    await settle(h.bus);
    expect(await h.sessions.send(meta.id, { cmd: "approve", requestId: "perm-y", decision: "always" })).toBe("delivered");
    await settle(h.bus);
    expect(h.persisted.at(-1)!.agentEvent).toEqual({ type: "notice", severity: "warn", text: "审批已失效（会话已不在等待态）" });
    expect(adapter.sends).toHaveLength(0);
  });

  it("waiting 态 approve 原路交付（门不拦合法审批）", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");
    adapter.emit({ type: "state", state: "running" });
    adapter.emit({ type: "state", state: "waiting_approval" });
    await settle(h.bus);
    expect(await h.sessions.send(meta.id, { cmd: "approve", requestId: "perm-1", decision: "once" })).toBe("delivered");
    expect(adapter.sends).toEqual([{ cmd: "approve", requestId: "perm-1", decision: "once" }]);
  });

  it("answer 门：非 waiting_input 态 answer → 失效 warn notice + delivered，CLI 未收指令（协议面对未来 agent 生效）", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    const meta = await h.sessions.create(SPEC, "new");          // state=starting
    expect(await h.sessions.send(meta.id, { cmd: "answer", questionId: "q-1", value: "yes" })).toBe("delivered");
    await settle(h.bus);
    expect(h.persisted.at(-1)!.agentEvent).toEqual({ type: "notice", severity: "warn", text: "提问已失效（会话已不在等待态）" });
    expect(adapter.sends).toHaveLength(0);                     // 未写 CLI（不代答）
  });

  it("中断挂起失效：waiting 态死句柄 → send 续接先发「审批已失效（会话中断）」再 starting（seq 接续）", async () => {
    const adapter = fakeAdapter();
    const h = harness(adapter);
    await h.conversations.createSession({ id: "s-wait", agentId: "fake", cwd: "D:\\w", permissionMode: "default" }, null);
    await h.conversations.updateSession("s-wait", { state: "waiting_approval", lastSeq: 1 });
    const meta = (await h.conversations.listSessions())[0]!;
    await h.sessions.adopt(meta, "cls-hint-w");

    expect(await h.sessions.send("s-wait", { cmd: "send", text: "continue" })).toBe("delivered");
    await settle(h.bus);
    const kinds = h.persisted.map((p) => (p.agentEvent.type === "state" ? `state:${p.agentEvent.state}` : p.agentEvent.type));
    expect(kinds).toEqual(["notice", "state:starting"]);
    expect(h.persisted[0]!.agentEvent).toEqual({ type: "notice", severity: "info", text: "审批已失效（会话中断）" });
    expect(h.persisted[0]!.seq).toBe(2);                       // seq 接续仓储 lastSeq+1
    expect(adapter.resumes).toEqual(["cls-hint-w"]);           // 续接线索原样交给适配器
  });
});
