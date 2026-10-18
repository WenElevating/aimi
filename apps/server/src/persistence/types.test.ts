import { describe, expect, it } from "vitest";
import { MemoryConversationRepository } from "./memory/memoryConversationRepository.js";
import { MemoryCommandDedupRepository } from "./memory/memoryCommandDedupRepository.js";
import { MemoryMetaRepository } from "./memory/memoryMetaRepository.js";
import { MemoryProcessLedgerRepository } from "./memory/memoryProcessLedgerRepository.js";

describe("Memory 仓储必须与生产实现同一契约", () => {
  it("createSession 原子后按显式 seq 落库（首事件 seq 0）", async () => {
    const repo = new MemoryConversationRepository();
    await repo.init();
    await repo.createSession({ id: "s1", agentId: "claude", cwd: "D:\\x", permissionMode: "default" },
      { type: "state", state: "starting" });
    await repo.appendEvent("s1", 1, { type: "text_delta", text: "a" }, 1);
    await repo.appendEvent("s1", 2, { type: "text_delta", text: "b" }, 2);
    // seq 由调用方（EventBus 单权威）给出：断言落库顺序而非返回值。
    expect((await repo.getEvents("s1")).map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("getEvents sinceSeq 重放点查", async () => {
    const repo = new MemoryConversationRepository();
    await repo.init();
    await repo.createSession({ id: "s1", agentId: "claude", cwd: "D:\\x", permissionMode: "default" }, null);
    for (let i = 0; i < 5; i++) await repo.appendEvent("s1", i, { type: "text_delta", text: String(i) }, i);
    expect((await repo.getEvents("s1", { sinceSeq: 3 })).map((e) => e.seq)).toEqual([4]);
  });

  it("clientId 去重：第二次 put 返回 false（异常 #7）", async () => {
    const dedup = new MemoryCommandDedupRepository();
    await dedup.init();
    expect(await dedup.putIfAbsent("cid-1")).toBe(true);
    expect(await dedup.putIfAbsent("cid-1")).toBe(false);
  });

  it("updateSession(resumeHint) 回写 → getSessionHint 读回 → listSessions.resumable 派生", async () => {
    const repo = new MemoryConversationRepository();
    await repo.init();
    await repo.createSession({ id: "s1", agentId: "claude", cwd: "D:\\x", permissionMode: "default" }, null);
    expect(await repo.getSessionHint("s1")).toBeNull();
    expect((await repo.listSessions())[0]!.resumable).toBe(false);
    await repo.updateSession("s1", { resumeHint: "cls-abc123" });
    expect(await repo.getSessionHint("s1")).toBe("cls-abc123");
    expect((await repo.listSessions())[0]!.resumable).toBe(true);
    // 变更才回写：二次变更覆盖旧 hint（与 Sqlite 同契约）
    await repo.updateSession("s1", { resumeHint: "cls-fork999" });
    expect(await repo.getSessionHint("s1")).toBe("cls-fork999");
  });

  it("countEvents 排他下界（-1 全量含首事件；语义同 getEvents）与宽松读（不存在会话=0）", async () => {
    const repo = new MemoryConversationRepository();
    await repo.init();
    await repo.createSession({ id: "s1", agentId: "claude", cwd: "D:\\x", permissionMode: "default" }, null);
    for (let i = 0; i < 3; i++) await repo.appendEvent("s1", i, { type: "text_delta", text: String(i) }, i);
    expect(await repo.countEvents("s1", -1)).toBe(3);
    expect(await repo.countEvents("s1", 0)).toBe(2);
    expect(await repo.countEvents("s-missing", 0)).toBe(0);
  });
});

describe("Memory MetaRepository 契约", () => {
  it("get 宽松读（不存在=null）；set UPSERT 覆盖（重放超限标记/server_id 共用此口）", async () => {
    const meta = new MemoryMetaRepository();
    await meta.init();
    expect(await meta.get("replay_capped:s1")).toBeNull();
    await meta.set("replay_capped:s1", "1700000000000");
    expect(await meta.get("replay_capped:s1")).toBe("1700000000000");
    await meta.set("replay_capped:s1", "1700000000001"); // 同键覆盖：标记只取最新时点
    expect(await meta.get("replay_capped:s1")).toBe("1700000000001");
    await meta.close();
  });
});

describe("Memory ProcessLedgerRepository 契约", () => {
  it("register/clear/list：同会话重拉覆盖 pid（台账一行一会话），未知清理静默 no-op", async () => {
    const ledger = new MemoryProcessLedgerRepository();
    await ledger.init();
    await ledger.register("s1", 100);
    await ledger.register("s2", 200);
    expect(await ledger.list()).toEqual([
      { sessionId: "s1", pid: 100 },
      { sessionId: "s2", pid: 200 },
    ]);
    await ledger.register("s1", 300);
    expect((await ledger.list()).filter((r) => r.sessionId === "s1")).toEqual([{ sessionId: "s1", pid: 300 }]);
    await ledger.clear("s1");
    expect((await ledger.list()).map((r) => r.sessionId)).toEqual(["s2"]);
    await ledger.clear("missing");
    await ledger.close();
  });
});
