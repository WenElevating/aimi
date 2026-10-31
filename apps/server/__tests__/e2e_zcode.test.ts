import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Application } from "../src/app/application.js";
import { ConfigProvisioner } from "../src/auth/configProvisioner.js";
import { MemoryDeviceRepository } from "../src/persistence/memory/index.js";

import type { ServerConfig } from "../src/app/config.js";

/**
 * 假 zcode CLI：与 zcodeSession.test 的 fake 同源——一个回合的完整成功事件流（点分命名、
 * 带 sessionId 信封），argv 落 `AIMI_ZCODE_ARGS_LOG` 供 `--resume` 断言。走
 * `AIMI_ZCODE_CLI_PATH` 注入缝（claude 的 AIMI_FAKE_CLI_PATH 等价物）。
 */
const FAKE_ZCODE = `
const fs = require("node:fs");
if (process.env.AIMI_ZCODE_ARGS_LOG) fs.appendFileSync(process.env.AIMI_ZCODE_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const sid = "sess_e2e_zcode";
const line = (type, payload) => process.stdout.write(
  JSON.stringify({ eventId: "e" + Math.random(), payload, seq: 1, sessionId: sid, timestamp: 1, traceId: "t", turnId: "tn", type }) + "\\n");
line("turn.started", { turnNumber: 0, input: "x" });
line("model.streaming", { assistantMessageId: "m", delta: "回合输出", done: false, kind: "text_delta" });
line("tool_call.scheduled", { toolCallId: "call_1", toolName: "Read", input: { file_path: "D:\\\\w\\\\a.ts" } });
line("streaming_tool_ledger.updated", { toolCallId: "call_1", toolName: "Read", status: "tool_result_committed", input: {} });
line("model.complete", { content: "", stopReason: "end-turn", usage: { inputTokens: 10, outputTokens: 5 } });
line("session.updated", { messageCount: 1, providerId: "p1", modelId: "glm-e2e", toolCount: 1, iteration: 0 });
line("turn.complete", { response: "done" });
process.exit(0);
`;

const cleanups: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function opened(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });
}

/** 帧流：与 e2e_fork 同构（队列 + 等位者，until 不漏帧）。 */
class MsgStream {
  readonly #queue: any[] = [];
  readonly #waiters: ((frame: any) => void)[] = [];

  constructor(ws: WebSocket) {
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data));
      const waiter = this.#waiters.shift();
      if (waiter !== undefined) waiter(frame);
      else this.#queue.push(frame);
    });
  }

  next(timeoutMs = 5000): Promise<any> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待帧超时")), timeoutMs);
      this.#waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  async until(pred: (frame: any) => boolean, timeoutMs = 15000): Promise<any[]> {
    const collected: any[] = [];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("until 超时");
      const frame = await this.next(remaining);
      collected.push(frame);
      if (pred(frame)) return collected;
    }
  }
}

/**
 * zcode 适配器 e2e：注册探测（welcome 投影双 agent）→ create 拉起首回合（事件流至 finished、
 * configured 上报实测模型）→ send 经死句柄+hint 路径 `--resume` 续接 → fork 明确拒绝。
 */
describe.skipIf(process.platform !== "win32")("zcode 适配器 e2e", () => {
  it("welcome 双 agent → create 事件流 → send --resume 续接 → fork 拒绝", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-e2e-zcode-"));
    cleanups.push(root);
    const dataDir = join(root, "data");
    const workDir = join(root, "work");
    const argsLog = join(root, "zcode-argv.log");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    const cliPath = join(root, "fake-zcode.cjs");
    writeFileSync(cliPath, FAKE_ZCODE);
    vi.stubEnv("AIMI_ZCODE_CLI_PATH", cliPath);
    vi.stubEnv("AIMI_ZCODE_ARGS_LOG", argsLog);
    vi.stubEnv("AIMI_ZCODE_SID", "sess_e2e_zcode");

    const cfg: ServerConfig = {
      port: 0,
      dataDir,
      logDir: join(root, "logs"),
      logLevel: "ERROR",
      watchdogMs: 600_000,
      serverVersion: "0.1.0",
    };
    const app = new Application(cfg);
    const { port } = await app.start();
    try {
      const token = (
        await new ConfigProvisioner(new MemoryDeviceRepository(), join(dataDir, "lan-token.txt")).ensureLanToken()
      ).token;
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const stream = new MsgStream(ws);
      await opened(ws);
      ws.send(JSON.stringify({ v: 1, type: "hello", token, resume: null }));
      const welcome = await stream.next();

      // welcome 投影：双 agent（zcode 在注册序第二位；模型清单随本机 provider 配置漂移，不逐一断言）。
      const zcodeAgent = welcome.agents.find((a: any) => a.id === "zcode");
      expect(zcodeAgent).toBeDefined();
      expect(zcodeAgent.label).toBe("ZCode");
      expect(welcome.agents.some((a: any) => a.id === "claude")).toBe(true);

      // create：首回合事件流至 finished，工具卡/用量/configured 齐备。
      ws.send(
        JSON.stringify({
          v: 1,
          type: "session.create",
          spec: { agentId: "zcode", cwd: workDir, permissionMode: "edit", initialPrompt: "任务一" },
        }),
      );
      const createAck = await stream.until((f) => f.type === "ack", 15000);
      const sid: string = createAck[createAck.length - 1].sessionId;
      const turnFrames = await stream.until(
        (f) =>
          f.type === "session.event" &&
          f.sessionId === sid &&
          f.agentEvent?.type === "state" &&
          f.agentEvent.state === "finished",
        20000,
      );
      const events = [...createAck, ...turnFrames].filter((f) => f.type === "session.event" && f.sessionId === sid);
      const agentEvents = events.map((f) => f.agentEvent);
      expect(agentEvents.some((e: any) => e.type === "text_delta" && e.text === "回合输出")).toBe(true);
      expect(agentEvents.some((e: any) => e.type === "tool_call" && e.name === "Read")).toBe(true);
      expect(agentEvents.some((e: any) => e.type === "tool_result" && e.ok === true)).toBe(true);
      expect(agentEvents.some((e: any) => e.type === "usage" && e.tokensIn === 10)).toBe(true);
      expect(agentEvents.some((e: any) => e.type === "configured" && e.model === "glm-e2e")).toBe(true);

      // send：死句柄+hint 路径 → 第二回合 spawn 带 --resume（argv 落盘断言）。
      ws.send(
        JSON.stringify({
          v: 1,
          type: "session.command",
          sessionId: sid,
          clientId: "cid-zcode-0001",
          cmd: { cmd: "send", text: "任务二" },
        }),
      );
      await stream.until(
        (f) =>
          f.type === "session.event" &&
          f.sessionId === sid &&
          f.agentEvent?.type === "state" &&
          f.agentEvent.state === "finished" &&
          events.indexOf(f) === -1,
        20000,
      );
      const argvs = readFileSync(argsLog, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l) as string[])
        .filter((argv) => !argv.includes("--version")); // 排除 isInstalled 探测
      expect(argvs).toHaveLength(2);
      expect(argvs[1]!).toContain("--resume");
      expect(argvs[1]![argvs[1]!.indexOf("--resume") + 1]).toBe("sess_e2e_zcode");

      // fork：zcode 源会话明确拒绝（protocol.bad_frame + 文案）。
      ws.send(JSON.stringify({ v: 1, type: "session.fork", sourceId: sid }));
      const forkError = await stream.next(10000);
      expect(forkError.type).toBe("error");
      expect(forkError.code).toBe("protocol.bad_frame");
      expect(forkError.message).toContain("session.fork.unsupported");
      ws.close();
    } finally {
      await app.close();
    }
  }, 60_000);
});
