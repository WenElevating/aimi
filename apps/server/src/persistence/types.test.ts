import { describe, expect, it } from "vitest";
import { MemoryConversationRepository } from "./memory/memoryConversationRepository.js";
import { MemoryCommandDedupRepository } from "./memory/memoryCommandDedupRepository.js";

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
});
