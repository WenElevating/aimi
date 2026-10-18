import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteCommandDedupRepository } from "./sqliteRepositories.js";
import { SqliteConversationRepository } from "./sqliteConversationRepository.js";
import { openMigrated } from "./migrate.js";

/**
 * 与内存实现的测试逐字对应：把 Memory 换成 Sqlite（临时文件库），
 * 断言一字不改——两实现必须服务同一契约。
 */
describe("Sqlite 仓储必须与 Memory 同一契约", () => {
  let dir: string;
  let repo: SqliteConversationRepository;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "aimi-sqlite-"));
    repo = new SqliteConversationRepository(join(dir, "aimi.db"));
    await repo.init();
  });

  afterEach(async () => {
    await repo.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("createSession 原子后按显式 seq 落库（首事件 seq 0）", async () => {
    await repo.createSession({ id: "s1", agentId: "claude", cwd: "D:\\x", permissionMode: "default" },
      { type: "state", state: "starting" });
    await repo.appendEvent("s1", 1, { type: "text_delta", text: "a" }, 1);
    await repo.appendEvent("s1", 2, { type: "text_delta", text: "b" }, 2);
    // seq 由调用方（EventBus 单权威）给出：断言落库顺序而非返回值。
    expect((await repo.getEvents("s1")).map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("getEvents sinceSeq 重放点查", async () => {
    await repo.createSession({ id: "s1", agentId: "claude", cwd: "D:\\x", permissionMode: "default" }, null);
    for (let i = 0; i < 5; i++) await repo.appendEvent("s1", i, { type: "text_delta", text: String(i) }, i);
    expect((await repo.getEvents("s1", { sinceSeq: 3 })).map((e) => e.seq)).toEqual([4]);
  });

  it("clientId 去重：第二次 put 返回 false（异常 #7）", async () => {
    const db = openMigrated(join(dir, "dedup.db"));
    const dedup = new SqliteCommandDedupRepository(db);
    await dedup.init();
    expect(await dedup.putIfAbsent("cid-1")).toBe(true);
    expect(await dedup.putIfAbsent("cid-1")).toBe(false);
    db.close();
  });

  it("createSession 重复 id 抛错（与 Memory 的静默覆盖分叉为显式错误）", async () => {
    await repo.createSession({ id: "s1", agentId: "claude", cwd: "D:\\x", permissionMode: "default" }, null);
    await expect(
      repo.createSession({ id: "s1", agentId: "claude", cwd: "D:\\x", permissionMode: "default" }, null),
    ).rejects.toThrow("session already exists: s1");
  });

  it("resumeHint 空会话：getSessionHint 为 null、listSessions.resumable=false", async () => {
    await repo.createSession({ id: "s1", agentId: "claude", cwd: "D:\\x", permissionMode: "default" }, null);
    expect(await repo.getSessionHint("s1")).toBeNull();
    expect((await repo.listSessions())[0]!.resumable).toBe(false);
  });

  it("resumeHint 回写 → getSessionHint 读回 → listSessions.resumable=true；变更才覆盖", async () => {
    await repo.createSession({ id: "s1", agentId: "claude", cwd: "D:\\x", permissionMode: "default" }, null);
    await repo.updateSession("s1", { resumeHint: "cls-abc123" });
    expect(await repo.getSessionHint("s1")).toBe("cls-abc123");
    expect((await repo.listSessions())[0]!.resumable).toBe(true);
    // fork 场景：二次变更覆盖旧 hint（SPIKE FACT3：session_id 稳定，仅变更才回写）
    await repo.updateSession("s1", { resumeHint: "cls-fork999" });
    expect(await repo.getSessionHint("s1")).toBe("cls-fork999");
  });

  it("updateSession 带 resumeHint 的 patch 不碰 state/lastSeq（只动指定列）", async () => {
    await repo.createSession({ id: "s1", agentId: "claude", cwd: "D:\\x", permissionMode: "default" },
      { type: "state", state: "starting" });
    await repo.appendEvent("s1", 1, { type: "text_delta", text: "a" }, 1);
    await repo.updateSession("s1", { state: "running" });
    await repo.updateSession("s1", { resumeHint: "cls-h1" });
    const meta = (await repo.listSessions())[0]!;
    expect(meta.state).toBe("running");
    expect(meta.lastSeq).toBe(1);
    expect(meta.resumable).toBe(true);
  });

  it("countEvents 排他下界：-1 全量（含首事件）、0 起排除首事件（语义同 getEvents）", async () => {
    await repo.createSession({ id: "s1", agentId: "claude", cwd: "D:\\x", permissionMode: "default" }, null);
    for (let i = 0; i < 3; i++) await repo.appendEvent("s1", i, { type: "text_delta", text: String(i) }, i);
    expect(await repo.countEvents("s1", -1)).toBe(3); // 全量基线（首事件 seq=0 也在内）
    expect(await repo.countEvents("s1", 0)).toBe(2);  // 光标 0 = 手机已见首事件，重放从 seq 1 起
    expect(await repo.countEvents("s1", 1)).toBe(1);
  });

  it("countEvents 宽松读：空会话与不存在会话均为 0", async () => {
    await repo.createSession({ id: "s1", agentId: "claude", cwd: "D:\\x", permissionMode: "default" }, null);
    expect(await repo.countEvents("s1", 0)).toBe(0);
    expect(await repo.countEvents("s-missing", 0)).toBe(0);
  });

  it("payload JSON 往返保真：嵌套结构深比较无损", async () => {
    await repo.createSession({ id: "s1", agentId: "claude", cwd: "D:\\x", permissionMode: "default" }, null);
    await repo.appendEvent(
      "s1",
      1,
      { type: "tool_call", id: "t1", name: "Bash", summary: "ls", inputDigest: "abc123def456" },
      1,
    );
    // permission 事件带嵌套数组（options），补足「含嵌套数组」的往返覆盖。
    await repo.appendEvent(
      "s1",
      2,
      {
        type: "permission",
        id: "p1",
        title: "Write file",
        detail: "allow?",
        options: [
          { label: "Once", kind: "once" },
          { label: "Always", kind: "always" },
          { label: "Reject", kind: "reject" },
        ],
      },
      2,
    );
    expect((await repo.getEvents("s1", { sinceSeq: 0 })).map((e) => e.agentEvent)).toEqual([
      { type: "tool_call", id: "t1", name: "Bash", summary: "ls", inputDigest: "abc123def456" },
      {
        type: "permission",
        id: "p1",
        title: "Write file",
        detail: "allow?",
        options: [
          { label: "Once", kind: "once" },
          { label: "Always", kind: "always" },
          { label: "Reject", kind: "reject" },
        ],
      },
    ]);
  });
});
