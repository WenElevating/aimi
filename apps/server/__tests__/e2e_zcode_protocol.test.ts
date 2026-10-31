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
 * 假 zcode app-server（NDJSON 协议子集，行为以实机探针冻结样本为准）：
 * - runtime/capabilities → 空 result；
 * - session/create → sess_e2e_proto；session/subscribe → 空补快照；
 * - session/send → accepted，随后按序推 session/event（running → text_delta → 审批反向请求
 *   interaction/requestPermission → [应答后] 工具提交 → usage → turn.complete）；
 * - session/setModel → 记录 ModelSelection 并推 session.updated（modelId 回显）；
 * - session/setMode / session/stop → 空 result。
 * 收到的反向请求应答与 setModel 参数全量落 AIMI_PROTO_LOG 供断言。
 */
const FAKE_APP_SERVER = `
const fs = require("node:fs");
if (process.argv.includes("--version")) { process.stdout.write("0.0.0-proto\\n"); process.exit(0); }
const logFile = process.env.AIMI_PROTO_LOG;
const log = (obj) => { if (logFile) fs.appendFileSync(logFile, JSON.stringify(obj) + "\\n"); };
const sid = "sess_e2e_proto";
let buf = "";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
const event = (type, payload) => send({ method: "session/event", params: { deliveryKind: "desktop-continuous", eventId: "e" + Math.random(), seq: 1, sessionId: sid, timestamp: 1, traceId: "t", turnId: "tn", type, payload } });
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx = buf.indexOf("\\n");
  while (idx >= 0) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
    if (line === "") { idx = buf.indexOf("\\n"); continue; }
    let frame; try { frame = JSON.parse(line); } catch { idx = buf.indexOf("\\n"); continue; }
    log(frame);
    // 审批应答（{id:"server-9"}）到达 → 续播回合尾段：工具提交 + usage + turn.complete。
    if (frame.id === "server-9" && frame.result !== undefined) {
      event("streaming_tool_ledger.updated", { toolCallId: "call_1", toolName: "Bash", status: "tool_result_committed", input: {} });
      event("model.complete", { content: "", stopReason: "end-turn", usage: { inputTokens: 10, outputTokens: 4 } });
      event("turn.complete", { response: "done", resultType: "success" });
      idx = buf.indexOf("\\n"); continue;
    }
    if (frame.id === undefined) { idx = buf.indexOf("\\n"); continue; }
    switch (frame.method) {
      case "runtime/capabilities":
        send({ id: frame.id, result: { sessionWorkspaceRouting: true } });
        break;
      case "session/create":
        send({ id: frame.id, result: { sessionId: sid, messages: [], projection: { mode: "edit" } } });
        send({ method: "session/lifecycle/changed", params: { sessionId: sid, state: "ready", generation: 1, revision: 1, lastError: null } });
        break;
      case "session/resume":
        send({ id: frame.id, result: { sessionId: sid } });
        break;
      case "session/subscribe":
        send({ id: frame.id, result: { eventSeq: 0, events: [], sessionId: sid } });
        break;
      case "session/send": {
        send({ id: frame.id, result: { accepted: true, sessionId: sid, stateRevision: 1 } });
        event("turn.started", { turnNumber: 0, input: frame.params.content });
        event("model.streaming", { assistantMessageId: "m", delta: "需要执行命令", done: false, kind: "text_delta" });
        // 审批反向请求：客户端应答（{id:"server-9", result:{decision}}）到达前工具挂起。
        send({ id: "server-9", method: "interaction/requestPermission", params: { requestId: "perm-e2e-1", sessionId: sid, toolCallId: "call_1", toolName: "Bash", riskLevel: "medium", reason: "需要执行命令", input: { command: "echo hi" }, options: [ { optionId: "allowOnce", name: "Allow once", response: { decision: "allow" } }, { optionId: "deny", name: "Deny", response: { decision: "deny" } } ] } });
        break;
      }
      case "session/setModel": {
        log({ setModel: frame.params });
        send({ id: frame.id, result: {} });
        event("session.updated", { messageCount: 1, providerId: frame.params.model.provider.providerId, modelId: frame.params.model.modelId, toolCount: 1, iteration: 0 });
        break;
      }
      case "session/setMode":
        send({ id: frame.id, result: {} });
        break;
      case "session/stop":
        send({ id: frame.id, result: {} });
        event("turn.complete", { response: "", resultType: "cancelled" });
        break;
      default:
        send({ id: frame.id, result: {} });
    }
  }
});
setInterval(() => {}, 1000);
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
 * zcode 协议模式 e2e：create（app-server 会话）→ 事件流 → 审批反向请求转手机 permission 卡 →
 * 手机 approve 应答回 zcode → 工具继续 → finished → configure 切模型（configured 回显）→
 * 回合中 send（steer）→ 中断 stop（cancelled→stopped）。
 */
describe.skipIf(process.platform !== "win32")("zcode 协议模式 e2e", () => {
  it("create → 审批往返 → finished → setModel 回显 → steer → stop→stopped", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-e2e-zproto-"));
    cleanups.push(root);
    const dataDir = join(root, "data");
    const workDir = join(root, "work");
    const protoLog = join(root, "proto.log");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    const cliPath = join(root, "fake-app-server.cjs");
    writeFileSync(cliPath, FAKE_APP_SERVER);
    vi.stubEnv("AIMI_ZCODE_CLI_PATH", cliPath);
    vi.stubEnv("AIMI_PROTO_LOG", protoLog);

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
      await stream.next(); // welcome

      // create：initialPrompt 触发首回合，事件至审批卡（waiting_approval）。
      ws.send(
        JSON.stringify({
          v: 1,
          type: "session.create",
          spec: { agentId: "zcode", cwd: workDir, permissionMode: "edit", initialPrompt: "任务一" },
        }),
      );
      const created = await stream.until((f) => f.type === "ack", 15000);
      const sid: string = created[created.length - 1].sessionId;
      const approval = await stream.until(
        (f) => f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "permission",
        20000,
      );
      const permEvent = approval[approval.length - 1].agentEvent;
      expect(permEvent.id).toBe("perm-e2e-1");
      expect(permEvent.title).toBe("Bash");
      expect(permEvent.options.map((o: any) => o.kind)).toEqual(["once", "always", "reject"]);

      // 手机 approve（once）→ 应答回 zcode（allow）→ 工具继续 → finished。
      ws.send(
        JSON.stringify({
          v: 1,
          type: "session.command",
          sessionId: sid,
          clientId: "cid-zproto-approve",
          cmd: { cmd: "approve", requestId: "perm-e2e-1", decision: "once" },
        }),
      );
      const settled = await stream.until(
        (f) =>
          f.type === "session.event" &&
          f.sessionId === sid &&
          f.agentEvent?.type === "state" &&
          f.agentEvent.state === "finished",
        20000,
      );
      const events = [...approval, ...settled].filter((f) => f.type === "session.event" && f.sessionId === sid);
      const agentEvents = events.map((f) => f.agentEvent);
      expect(agentEvents.some((e: any) => e.type === "state" && e.state === "waiting_approval")).toBe(true);
      expect(agentEvents.some((e: any) => e.type === "state" && e.state === "running")).toBe(true);
      expect(agentEvents.some((e: any) => e.type === "tool_result" && e.ok === true)).toBe(true);
      // 应答内容断言：once → allowOnce option 的 response（decision allow）。
      const answers = readFileSync(protoLog, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((frame) => frame.result !== undefined && frame.id === "server-9");
      expect((answers[0]?.result as { decision?: string }).decision).toBe("allow");

      // configure：切模型（providerId:modelId 编码）→ setModel 下发 + configured 回显。
      ws.send(
        JSON.stringify({
          v: 1,
          type: "session.command",
          sessionId: sid,
          clientId: "cid-zproto-model",
          cmd: { cmd: "configure", model: "prov-1:glm-e2e" },
        }),
      );
      const modelSettled = await stream.until(
        (f) => f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "configured",
        20000,
      );
      // configured 语义 = CLI 实测模型（裸 modelId）；编码值只用于 setModel 下发。
      expect(modelSettled[modelSettled.length - 1].agentEvent.model).toBe("glm-e2e");

      // 回合中 send（steer）+ 中断（stop → cancelled → stopped）。
      ws.send(
        JSON.stringify({
          v: 1,
          type: "session.command",
          sessionId: sid,
          clientId: "cid-zproto-send2",
          cmd: { cmd: "send", text: "任务二" },
        }),
      );
      await stream.until(
        (f) =>
          f.type === "session.event" &&
          f.sessionId === sid &&
          f.agentEvent?.type === "state" &&
          f.agentEvent.state === "running",
        20000,
      );
      ws.send(
        JSON.stringify({
          v: 1,
          type: "session.command",
          sessionId: sid,
          clientId: "cid-zproto-stop",
          cmd: { cmd: "interrupt" },
        }),
      );
      const stopped = await stream.until(
        (f) =>
          f.type === "session.event" &&
          f.sessionId === sid &&
          f.agentEvent?.type === "state" &&
          f.agentEvent.state === "stopped",
        20000,
      );
      expect(stopped[stopped.length - 1].agentEvent.state).toBe("stopped");
      ws.close();
    } finally {
      await app.close();
    }
  }, 60_000);
});
