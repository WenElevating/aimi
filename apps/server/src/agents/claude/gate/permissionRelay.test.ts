import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@aimi/protocol";
import { PermissionRelay } from "./permissionRelay.js";

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 造一个受控 permDir（确定性目录——测试断言直接可寻址）。 */
function permDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aimi-perm-"));
  dirs.push(dir);
  return dir;
}

/** 写一份闸请求文件（与 gate.mjs 的产出同形：{toolName, input, toolUseId}）。 */
function writeRequest(dir: string, id: string, toolName: string, input: unknown): void {
  writeFileSync(join(dir, id + ".request.json"), JSON.stringify({ toolName, input, toolUseId: id }));
}

/** 轮询等待条件成立（relay 的轮询是异步节拍）。 */
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await sleep(10);
  }
}

describe("PermissionRelay（watch-发布-响应）", () => {
  it("请求文件 → 精确事件序（permission 字段全等 + waiting_approval）；同 toolUseId 只发一次", async () => {
    const dir = permDir();
    mkdirSync(dir, { recursive: true });
    const events: AgentEvent[] = [];
    const relay = new PermissionRelay({ dir, pollMs: 15 });
    relay.watch((event) => { events.push(event); });

    writeRequest(dir, "tu-1", "Bash", { command: "ls -la" });
    await waitFor(() => events.some((e) => e.type === "state" && e.state === "waiting_approval"));
    await sleep(60); // 再吃几轮轮询拍：重复文件不得再发

    expect(events).toEqual([
      {
        type: "permission", id: "tu-1", title: "Bash", detail: JSON.stringify({ command: "ls -la" }),
        options: [
          { label: "本次允许", kind: "once" },
          { label: "一直允许", kind: "always" },
          { label: "拒绝", kind: "reject" },
        ],
      },
      { type: "state", state: "waiting_approval" },
    ]);
    relay.stop();
  });

  it("once → 决定文件 = {behavior:'allow'}；二次 answer 视为已答复（不写文件）", async () => {
    const dir = permDir();
    const events: AgentEvent[] = [];
    const relay = new PermissionRelay({ dir, pollMs: 15 });
    relay.watch((event) => { events.push(event); });
    writeRequest(dir, "tu-2", "Bash", { command: "ls" });
    await waitFor(() => events.length > 0);

    expect(relay.answer("tu-2", "once")).toBe(true);
    expect(readFileSync(join(dir, "tu-2.decision.txt"), "utf8")).toBe(JSON.stringify({ behavior: "allow" }));

    expect(relay.answer("tu-2", "reject")).toBe(false); // 已答复：不再受理
    expect(readFileSync(join(dir, "tu-2.decision.txt"), "utf8")).toBe(JSON.stringify({ behavior: "allow" }));
    relay.stop();
  });

  it("always → allow + 会话内记名；第二个同工具请求自动放行（无 permission 事件 + notice info + 决定直写）", async () => {
    const dir = permDir();
    const events: AgentEvent[] = [];
    const relay = new PermissionRelay({ dir, pollMs: 15 });
    relay.watch((event) => { events.push(event); });

    writeRequest(dir, "tu-a1", "Bash", { command: "ls" });
    await waitFor(() => events.length > 0);
    expect(relay.answer("tu-a1", "always")).toBe(true);
    expect(readFileSync(join(dir, "tu-a1.decision.txt"), "utf8")).toBe(JSON.stringify({ behavior: "allow" }));

    // 第二个同工具请求：自动放行——不发 permission/waiting 事件，只发一条可见性 notice。
    const before = events.length;
    writeRequest(dir, "tu-a2", "Bash", { command: "ls -R" });
    await waitFor(() => existsSync(join(dir, "tu-a2.decision.txt")));
    await sleep(40);
    expect(readFileSync(join(dir, "tu-a2.decision.txt"), "utf8")).toBe(JSON.stringify({ behavior: "allow" }));
    const added = events.slice(before);
    expect(added).toEqual([
      { type: "notice", severity: "info", text: '已按"一直允许"自动放行 Bash' },
    ]);
    relay.stop();
  });

  it("reject → 决定文件 = {behavior:'deny',message:'手机端拒绝'}", async () => {
    const dir = permDir();
    const events: AgentEvent[] = [];
    const relay = new PermissionRelay({ dir, pollMs: 15 });
    relay.watch((event) => { events.push(event); });
    writeRequest(dir, "tu-r", "Write", { file_path: "D:\\w\\x.txt" });
    await waitFor(() => events.length > 0);

    expect(relay.answer("tu-r", "reject")).toBe(true);
    expect(readFileSync(join(dir, "tu-r.decision.txt"), "utf8"))
      .toBe(JSON.stringify({ behavior: "deny", message: "手机端拒绝" }));
    relay.stop();
  });

  it("未知请求 answer → false（调用方发失效提示）；stop() 后新请求不再发布", async () => {
    const dir = permDir();
    const events: AgentEvent[] = [];
    const relay = new PermissionRelay({ dir, pollMs: 15 });
    relay.watch((event) => { events.push(event); });

    expect(relay.answer("no-such", "once")).toBe(false); // 账本外：不写决定文件
    expect(existsSync(join(dir, "no-such.decision.txt"))).toBe(false);

    relay.stop();
    const before = events.length;
    writeRequest(dir, "tu-late", "Bash", { command: "ls" });
    await sleep(80);
    expect(events.length).toBe(before); // 轮询已停：挂起请求不再发布
  });

  it("目录清理：静态 cleanup 删除整个 permDir（尽力而为）", () => {
    const dir = permDir();
    writeRequest(dir, "tu-c", "Bash", { command: "ls" });
    PermissionRelay.cleanup(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
