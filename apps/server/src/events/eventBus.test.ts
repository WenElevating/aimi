import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ServerFrame } from "@aimi/protocol";
import type { Conveyor } from "../transport/conveyor.js";
import type { Logger } from "../logging/logger.js";
import { EventBus } from "./eventBus.js";
import { UiFanout } from "./uiFanout.js";
import { MemoryConversationRepository } from "../persistence/memory/memoryConversationRepository.js";

let bus: EventBus;
let persisted: { sessionId: string; seq: number; ts: number; agentEvent: AgentEvent }[];

beforeEach(() => {
  vi.useFakeTimers();
  bus = new EventBus();
  persisted = [];
  bus.subscribe({
    persist: async (rec) => { persisted.push(rec); },
    ui: () => {},
  });
});
afterEach(() => { vi.useRealTimers(); });

describe("EventBus（保序/seq/洪水）", () => {
  it("同会话 200 次 publish：seq 严格 0..199 递增", async () => {
    for (let i = 0; i < 200; i++) {
      await bus.publish("s1", { type: "state", state: i % 2 ? "running" : "waiting_input" });
    }
    expect(persisted.map((r) => r.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });

  it("100ms 窗口内 3 条 text_delta 聚合为 1 条（文本顺序连接，同一 seq）", async () => {
    const p1 = bus.publish("s1", { type: "text_delta", text: "a" });
    const p2 = bus.publish("s1", { type: "text_delta", text: "b" });
    const p3 = bus.publish("s1", { type: "text_delta", text: "c" });
    await vi.advanceTimersByTimeAsync(150);
    const [s1, s2, s3] = await Promise.all([p1, p2, p3]);
    expect(s1).toBe(s2);
    expect(s2).toBe(s3);
    const deltas = persisted.filter((r) => r.agentEvent.type === "text_delta");
    expect(deltas).toHaveLength(1);
    expect((deltas[0]!.agentEvent as { text: string }).text).toBe("abc");
  });

  it("9000 字符 outputExcerpt 截断为 8192 + 标记", async () => {
    await bus.publish("s1", { type: "tool_result", id: "t1", ok: true, outputExcerpt: "x".repeat(9000) });
    const rec = persisted.at(-1)!;
    const ev = rec.agentEvent as { type: "tool_result"; outputExcerpt: string };
    expect(ev.outputExcerpt.length).toBe(8192 + "…(truncated)".length);
    expect(ev.outputExcerpt.endsWith("…(truncated)")).toBe(true);
  });

  it("persist 失败不阻塞 ui 路（§11）", async () => {
    bus.subscribe({ persist: async () => { throw new Error("db down"); } });
    let uiSeen = 0;
    bus.subscribe({ ui: () => { uiSeen++; } });
    // 简报此处断言 toBe(1)，与「计数器从 0 起」（简报接口 TSDoc + 行为规格 1 + 本文件用例 1 的 0..199）矛盾：
    // 本调用是该会话的第一次 publish，故为 seq 0（详见报告「简报矛盾」一节）。
    await expect(bus.publish("s1", { type: "state", state: "running" })).resolves.toBe(0);
    expect(uiSeen).toBe(1);
  });
});

describe("UiFanout（会话事件广播）", () => {
  /** 只关心 send 的桩 Conveyor；其余方法 no-op（满足冻结接口）。 */
  function stubConveyor(): { conveyor: Conveyor; sent: ServerFrame[] } {
    const sent: ServerFrame[] = [];
    return {
      sent,
      conveyor: {
        open: async () => {},
        send: (frame) => { sent.push(frame); },
        onFrame: () => {},
        onClose: () => {},
        close: async () => {},
        state: "open",
      },
    };
  }

  it("挂接 2 个 Conveyor：每条事件各收 1 帧 session.event（字段齐；重复挂接幂等）", async () => {
    const fanout = new UiFanout(bus);
    const a = stubConveyor();
    const b = stubConveyor();
    fanout.attach(a.conveyor);
    fanout.attach(b.conveyor);
    fanout.attach(a.conveyor); // 幂等：同实例重复挂接只算一次
    expect(fanout.attachedCount()).toBe(2);

    const seq = await bus.publish("s1", { type: "state", state: "running" });

    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]).toEqual({
      v: 1,
      type: "session.event",
      sessionId: "s1",
      seq,
      ts: expect.any(Number),
      agentEvent: { type: "state", state: "running" },
    });
    expect(b.sent).toEqual(a.sent);
  });

  it("detach 后不再收；无挂接时静默", async () => {
    const fanout = new UiFanout(bus);
    const a = stubConveyor();
    const b = stubConveyor();
    fanout.attach(a.conveyor);
    fanout.attach(b.conveyor);
    fanout.detach(b.conveyor);
    expect(fanout.attachedCount()).toBe(1);

    await bus.publish("s1", { type: "state", state: "running" });
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0);

    fanout.detach(a.conveyor); // 无挂接：静默（不抛、不发）
    await expect(bus.publish("s1", { type: "state", state: "finished" })).resolves.toBe(1);
    expect(a.sent).toHaveLength(1);
  });
});

describe("EventBus 洪水补充（非简报冻结用例，覆盖行为规格 2/3 未冻结的边）", () => {
  it("非 delta 事件到达先冲刷 pending：合并事件 seq 在前", async () => {
    const p1 = bus.publish("s1", { type: "text_delta", text: "a" });
    const p2 = bus.publish("s1", { type: "text_delta", text: "b" });
    const stateSeq = await bus.publish("s1", { type: "state", state: "finished" });
    expect(await p1).toBe(0);
    expect(await p2).toBe(0);
    expect(stateSeq).toBe(1);
    expect(persisted.map((r) => [r.seq, r.agentEvent.type])).toEqual([[0, "text_delta"], [1, "state"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("跨会话缓冲互不影响；flush() 提前兑现聚合且不留定时器", async () => {
    const p1 = bus.publish("s1", { type: "text_delta", text: "a" });
    const p2 = bus.publish("s2", { type: "text_delta", text: "b" });
    expect(vi.getTimerCount()).toBe(2); // 两会话各一个窗口定时器
    await bus.flush();
    expect(vi.getTimerCount()).toBe(0); // 定时器已取消：无泄漏
    expect(await p1).toBe(0);
    expect(await p2).toBe(0); // seq 按会话独立，各自从 0 起
    expect(persisted.map((r) => [r.sessionId, r.seq])).toEqual([["s1", 0], ["s2", 0]]);
  });

  it("9000 字符 text_delta 截断后仍受聚合；合并产物亦不超上限", async () => {
    const p1 = bus.publish("s1", { type: "text_delta", text: "x".repeat(9000) });
    const p2 = bus.publish("s1", { type: "text_delta", text: "tail" });
    await vi.advanceTimersByTimeAsync(150);
    expect(await p1).toBe(0);
    expect(await p2).toBe(0);
    const ev = persisted[0]!.agentEvent as { type: string; text: string };
    expect(ev.type).toBe("text_delta");
    expect(ev.text.length).toBe(8192 + "…(truncated)".length);
    expect(ev.text.endsWith("…(truncated)")).toBe(true);
  });

  it("落库按会话串行：慢 persist 不会被后来的 publish 越过（§12 保序）", async () => {
    const order: number[] = [];
    bus.subscribe({
      persist: async (rec) => {
        if (rec.seq === 0) await new Promise((resolve) => setTimeout(resolve, 50));
        order.push(rec.seq);
      },
    });
    const p1 = bus.publish("s1", { type: "state", state: "running" });
    const p2 = bus.publish("s1", { type: "state", state: "finished" });
    await vi.advanceTimersByTimeAsync(60);
    expect(await Promise.all([p1, p2])).toEqual([0, 1]);
    expect(order).toEqual([0, 1]);
  });

  it("R1：bus seq 单权威——persist 经 ConversationRepository 落库后库内 seq 与广播 seq 一致", async () => {
    const repo = new MemoryConversationRepository();
    await repo.init();
    await repo.createSession(
      { id: "s1", agentId: "claude", cwd: "D:\\x", permissionMode: "default" },
      null, // 初始事件改由 T9 经 publish 发布（seq 0）
    );
    bus.subscribe({ persist: (rec) => repo.appendEvent(rec.sessionId, rec.seq, rec.agentEvent, rec.ts) });

    const seqs: number[] = [];
    for (let i = 0; i < 3; i++) seqs.push(await bus.publish("s1", { type: "state", state: "running" }));

    expect(seqs).toEqual([0, 1, 2]);
    expect((await repo.getEvents("s1")).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect((await repo.listSessions())[0]!.lastSeq).toBe(2);
  });

  it("persist 失败记 ERROR 日志（复核注入的 logger 收到一次 error）", async () => {
    const errors: { msg: string; fields: Record<string, unknown> | undefined }[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg, fields) => { errors.push({ msg, fields }); },
    };
    const bus2 = new EventBus({ logger });
    bus2.subscribe({ persist: async () => { throw new Error("db down"); } });
    await bus2.publish("s1", { type: "state", state: "running" });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.fields).toMatchObject({ sessionId: "s1", seq: 0 });
  });
});
