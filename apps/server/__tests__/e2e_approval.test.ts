import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Application } from "../src/app/application.js";
import { ConfigProvisioner } from "../src/auth/configProvisioner.js";
import { MemoryDeviceRepository } from "../src/persistence/memory/index.js";
import type { ServerConfig } from "../src/app/config.js";

/** 三份闸回放样本（fixture 静态存放，按 `AIMI_FAKE_TURN` 选场）。 */
const FIXTURE_DIR = fileURLToPath(new URL("../src/agents/claude/__fixtures__/", import.meta.url));
const GATE_FIXTURES = ["permission-gate-turn.jsonl", "permission-gate-always-turn.jsonl", "permission-gate-deny-turn.jsonl"] as const;

/**
 * 审批闸回放假 CLI（M0 基线脚本 + e2e_session_resume 多回合脚本的合流变体）：
 * - `claude --version` 探测**即刻 exit(0)**（探测进程不得进闸环路——否则 isInstalled 挂死）；
 * - 启动把自身 pid 写 `cwd/pid.txt`（「waiting 中杀假 CLI」用例的真杀数据源）；
 * - **每个收到的 user 帧全文重放一次 fixture**（FACT1：每条 user 帧触发一轮新回合），
 *   标线 `{"__aimi_perm__":{id,toolName,input}}` 不进 stdout——写
   * `<AIMI_FAKE_PERM_DIR>/<id>.request.json` 并轮询 `.decision.txt`（无内置超时——FACT6 同款挂起），
 *   决定内容与全部回放行镜像到 `cwd/stdout.log`（deny 收尾的 permission_denials 断言面——
 *   归一化流会丢弃 result 行的未知字段）；每回合收尾布 500ms 静默退出 timer（新 user 帧先清旧
 *   timer），stdin EOF 亦退出——测试不留孤儿。
 *
 * `AIMI_FAKE_PERM_DIR` 由 ClaudeSession spawn 时注入（真实 permDir）——假 CLI 与 aimi 侧
 * PermissionRelay 就地握手，测试无需预知 aimi sessionId。
 */
const FAKE_CLAUDE_SCRIPT = [
  'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
  'import { dirname, join } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  "",
  "const here = dirname(fileURLToPath(import.meta.url));",
  'const turn = process.env.AIMI_FAKE_TURN || "permission-gate-turn.jsonl";',
  'const lines = readFileSync(join(here, turn), "utf8").split(/\\r?\\n/).filter((l) => l !== "");',
  'if (process.argv.includes("--version")) process.exit(0);',
  'writeFileSync(join(process.cwd(), "pid.txt"), String(process.pid));',
  "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
  "async function gateWait(marker) {",
  '  const dir = process.env.AIMI_FAKE_PERM_DIR;',
  '  writeFileSync(join(dir, marker.id + ".request.json"), JSON.stringify({ toolName: marker.toolName, input: marker.input, toolUseId: marker.id }));',
  '  const decisionPath = join(dir, marker.id + ".decision.txt");',
  "  for (;;) {",
  "    if (existsSync(decisionPath)) {",
  '      const raw = readFileSync(decisionPath, "utf8");',
  '      if (raw.trim() !== "") {',
  '        appendFileSync(join(process.cwd(), "stdout.log"), raw + "\\n");',
  "        return;",
  "      }",
  "    }",
  "    await sleep(25);",
  "  }",
  "}",
  "let pending = Promise.resolve();",
  "let exitTimer = null;",
  "function enqueue() {",
  "  pending = pending.then(async () => {",
  "    for (const row of lines) {",
  "      let marker = null;",
  "      try { const obj = JSON.parse(row); if (obj && obj.__aimi_perm__) marker = obj.__aimi_perm__; } catch {}",
  '      if (marker !== null) { await gateWait(marker); continue; }',
  '      process.stdout.write(row + "\\n");',
  '      appendFileSync(join(process.cwd(), "stdout.log"), row + "\\n");',
  "    }",
  "    if (exitTimer !== null) clearTimeout(exitTimer);",
  "    exitTimer = setTimeout(() => process.exit(0), 500);",
  "  });",
  "}",
  'process.stdin.setEncoding("utf8");',
  'let buf = "";',
  'process.stdin.on("data", (chunk) => {',
  "  buf += chunk;",
  '  const parts = buf.split("\\n");',
  "  buf = parts.pop();",
  "  for (const part of parts) {",
  '    const line = part.replace(/\\r$/, "");',
  '    if (line === "") continue;',
  '    appendFileSync(join(process.cwd(), "stdin.log"), line + "\\n");',
  "    enqueue();",
  "  }",
  "});",
  'process.stdin.on("end", () => process.exit(0));',
].join("\n");

const cleanups: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of cleanups.splice(0)) await removeDir(dir);
});

/** 删除临时目录：假 claude 异步自退出，句柄释放有时间窗——重试规避 Windows EBUSY/EPERM 抖动。 */
async function removeDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 19) throw err;
      await sleep(50);
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * 造假 CLI 目录：写脚本 + `claude.cmd` 垫片（**转发 `%*`**——探测短路依赖 argv）+ 三份回放样本。
 *
 * @returns 该临时目录的绝对路径；登记进清理表由 afterEach 删除
 */
function approvalFakeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aimi-e2e-approval-bin-"));
  cleanups.push(dir);
  writeFileSync(join(dir, "fake-claude.mjs"), FAKE_CLAUDE_SCRIPT, "utf8");
  writeFileSync(join(dir, "claude.cmd"), '@echo off\r\n"' + process.execPath + '" "%~dp0fake-claude.mjs" %*\r\n');
  for (const name of GATE_FIXTURES) {
    writeFileSync(join(dir, name), readFileSync(join(FIXTURE_DIR, name), "utf8"));
  }
  return dir;
}

/** ws 连接的 open 事件（错误一并拒绝）。 */
function opened(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });
}

/** 帧流：把 ws 文本消息解析为对象，未消费的入队（`until` 从不会漏帧）。 */
class MsgStream {
  readonly #queue: any[] = [];
  readonly #waiters: ((frame: any) => void)[] = [];

  constructor(ws: WebSocket) {
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data));
      const waiter = this.#waiters.shift();
      if (waiter !== undefined) waiter(frame); else this.#queue.push(frame);
    });
  }

  /** 取下一条帧（队列空则挂起等待），超时即拒绝。 */
  next(timeoutMs = 5000): Promise<any> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待帧超时")), timeoutMs);
      this.#waiters.push((frame) => { clearTimeout(timer); resolve(frame); });
    });
  }

  /** 连续收帧直到 `pred` 命中；返回途中收到的全部帧（含命中帧）。 */
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

/** 收帧直到 `ack`；返回 ack 与其**之前**已到达的帧（starting 等会话事件可能先于 ack）。 */
async function untilAck(stream: MsgStream): Promise<{ ack: any; pre: any[] }> {
  const frames = await stream.until((f) => f.type === "ack", 15000);
  return { ack: frames[frames.length - 1], pre: frames };
}

/** 审批 e2e 的装配把手（应用实例/客户端连接/帧流/目录组）。 */
interface ApprovalHarness {
  readonly app: Application;
  readonly ws: WebSocket;
  readonly stream: MsgStream;
  readonly workDir: string;
  readonly dataDir: string;
}

/**
 * 起一套真应用 + 真 ws + 假 claude（PATH 注入 + 选定回放样本），完成 hello→welcome 握手。
 *
 * @param fixtureName - 假 CLI 的回放样本名（`AIMI_FAKE_TURN` 注入）
 * @returns Promise，resolve 为装配把手
 */
async function bootApproval(fixtureName: string): Promise<ApprovalHarness> {
  const binDir = approvalFakeDir();
  const root = mkdtempSync(join(tmpdir(), "aimi-e2e-approval-"));
  cleanups.push(root);
  const dataDir = join(root, "data");
  const workDir = join(root, "work");
  mkdirSync(workDir, { recursive: true });
  vi.stubEnv("PATH", binDir + ";" + (process.env.PATH ?? ""));
  vi.stubEnv("AIMI_FAKE_TURN", fixtureName);

  const cfg: ServerConfig = { port: 0, dataDir, logDir: join(root, "logs"), logLevel: "ERROR", watchdogMs: 600_000, serverVersion: "0.1.0" };
  const app = new Application(cfg);
  const { port } = await app.start();
  const token = (await new ConfigProvisioner(new MemoryDeviceRepository(), join(dataDir, "lan-token.txt")).ensureLanToken()).token;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const stream = new MsgStream(ws);
  await opened(ws);
  ws.send(JSON.stringify({ v: 1, type: "hello", token, resume: null }));
  const welcome = await stream.next();
  if (welcome.type !== "welcome") throw new Error("期望 welcome，实收 " + JSON.stringify(welcome));
  return { app, ws, stream, workDir, dataDir };
}

/** create 一条 default 档会话（initialPrompt 触发首轮回放）；返回会话 id。 */
async function createGateSession(h: ApprovalHarness, permissionMode: "default" | "plan" = "default"): Promise<string> {
  h.ws.send(JSON.stringify({
    v: 1, type: "session.create",
    spec: { agentId: "claude", cwd: h.workDir, permissionMode, initialPrompt: "hi" },
  }));
  const { ack } = await untilAck(h.stream);
  return ack.sessionId as string;
}

/** 发一条 approve 命令。 */
function approve(h: ApprovalHarness, sid: string, clientId: string, requestId: string, decision: "once" | "always" | "reject"): void {
  h.ws.send(JSON.stringify({
    v: 1, type: "session.command", sessionId: sid, clientId, cmd: { cmd: "approve", requestId, decision },
  }));
}

/** 本会话的确定性闸目录（permDir 派生规则与实现同源）。 */
const permDirOf = (h: ApprovalHarness, sid: string): string => join(h.dataDir, "perms", sid);

/** 会话事件流 → 归一化事件种类序（state 展开，供断言）。 */
function kindsOf(frames: any[], sid: string): string[] {
  return frames
    .filter((f) => f.type === "session.event" && f.sessionId === sid)
    .map((f) => (f.agentEvent.type === "state" ? `state:${f.agentEvent.state}` : f.agentEvent.type));
}

const waitingFrame = (sid: string) => (f: any) =>
  f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "state" && f.agentEvent.state === "waiting_approval";
const finishedFrame = (sid: string) => (f: any) =>
  f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "state" && f.agentEvent.state === "finished";

/**
 * 平台卫语句（C3：server 仅 Windows；假 `.cmd` 垫片 + PATH 分号语义）。非 Windows 整块跳过。
 *
 * 六例（Task 7.8）：①happy ②always ③reject ④晚到失效 ⑤中断挂起失效 ⑥协议守卫。
 * 权限请求的时序由「闸请求文件 → relay 轮询 → 决定文件 → 假 CLI 续流」两级轮询天然错峰，
 * 断言不依赖系统定时器粒度（100ms/25ms 双方各自轮询，事件序由闸等待屏障固定）。
 */
describe.skipIf(process.platform !== "win32")("Task 7 e2e：MCP 审批闸环路", () => {
  it("① happy：permission 卡 + waiting_approval → approve once → 决定文件 → CLI 续流 → finished", async () => {
    const h = await bootApproval("permission-gate-turn.jsonl");
    try {
      h.ws.send(JSON.stringify({
        v: 1, type: "session.create",
        spec: { agentId: "claude", cwd: h.workDir, permissionMode: "default", initialPrompt: "hi" },
      }));
      // starting(seq0) 可能先于 ack 广播——ack.pre 一并入账（M0 口径）。
      const { ack, pre: ackPre } = await untilAck(h.stream);
      const sid: string = ack.sessionId;
      const pre = [...ackPre, ...(await h.stream.until(waitingFrame(sid)))];
      expect(kindsOf(pre, sid)).toEqual([
        "state:starting", "state:running", "text_delta",
        "permission", "state:waiting_approval",
      ]);
      const permission = pre.filter((f) => f.type === "session.event" && f.sessionId === sid).map((f) => f.agentEvent).find((e) => e.type === "permission");
      expect(permission).toEqual({
        type: "permission", id: "perm-1", title: "Bash", detail: JSON.stringify({ command: "ls -la" }),
        options: [
          { label: "本次允许", kind: "once" },
          { label: "一直允许", kind: "always" },
          { label: "拒绝", kind: "reject" },
        ],
      });

      approve(h, sid, "cid-appr-happy-1", "perm-1", "once");
      const rest = await h.stream.until(finishedFrame(sid), 20000);
      expect(kindsOf([...pre, ...rest], sid)).toEqual([
        "state:starting", "state:running", "text_delta",
        "permission", "state:waiting_approval", "state:running",
        "tool_call", "tool_result", "text_delta", "usage", "state:finished",
      ]);
      // 决定文件全等（手机决定 → 闸回灌；读取在假 CLI 500ms 自退清目录之前）。
      expect(readFileSync(join(permDirOf(h, sid), "perm-1.decision.txt"), "utf8")).toBe(JSON.stringify({ behavior: "allow" }));
    } finally {
      await h.app.close();
    }
  }, 40_000);

  it("② always：同回合第二个同工具请求自动放行（无新 permission 事件 + 自动放行 notice + 决定直写）", async () => {
    const h = await bootApproval("permission-gate-always-turn.jsonl");
    try {
      const sid = await createGateSession(h);
      const pre = await h.stream.until(waitingFrame(sid));
      expect(kindsOf(pre, sid).filter((k) => k === "permission")).toHaveLength(1); // 恰 perm-1 一张卡

      approve(h, sid, "cid-appr-always-1", "perm-1", "always");
      const rest = await h.stream.until(finishedFrame(sid), 20000);
      const events = [...pre, ...rest].filter((f) => f.type === "session.event" && f.sessionId === sid).map((f) => f.agentEvent);
      // 第二次过闸（perm-2）不发手机事件：permission 卡仍只有一张、waiting 态只进过一次。
      expect(events.filter((e) => e.type === "permission")).toHaveLength(1);
      expect(kindsOf([...pre, ...rest], sid).filter((k) => k === "state:waiting_approval")).toHaveLength(1);
      expect(events).toContainEqual({ type: "notice", severity: "info", text: '已按"一直允许"自动放行 Bash' });
      // 自动放行的决定文件直写（读在假 CLI 自退清目录之前）。
      expect(readFileSync(join(permDirOf(h, sid), "perm-2.decision.txt"), "utf8")).toBe(JSON.stringify({ behavior: "allow" }));
    } finally {
      await h.app.close();
    }
  }, 40_000);

  it("③ reject：is_error 工具结果到达 + 模型侧收尾 result success（软拒，不标 failed）", async () => {
    const h = await bootApproval("permission-gate-deny-turn.jsonl");
    try {
      const sid = await createGateSession(h);
      await h.stream.until(waitingFrame(sid));
      approve(h, sid, "cid-appr-reject-1", "perm-1", "reject");
      const rest = await h.stream.until(finishedFrame(sid), 20000);
      const toolResults = rest.map((f) => f.agentEvent).filter((e) => e.type === "tool_result");
      expect(toolResults).toEqual([{ type: "tool_result", id: "tu-1", ok: false, outputExcerpt: "用户拒绝了该工具调用" }]);
      expect(readFileSync(join(permDirOf(h, sid), "perm-1.decision.txt"), "utf8"))
        .toBe(JSON.stringify({ behavior: "deny", message: "手机端拒绝" }));
      // deny 收尾的 result 行（permission_denials 累积）确实被假 CLI 播出（归一化流丢弃该字段，镜像日志可断）。
      const stdoutLog = readFileSync(join(h.workDir, "stdout.log"), "utf8");
      expect(stdoutLog).toContain("permission_denials");
      expect(stdoutLog).toContain("手机端拒绝");
    } finally {
      await h.app.close();
    }
  }, 40_000);

  it("④ 晚到：finished 后 approve → 失效 warn notice + 决定文件未写（不代答）", async () => {
    const h = await bootApproval("permission-gate-turn.jsonl");
    try {
      const sid = await createGateSession(h);
      await h.stream.until(waitingFrame(sid));
      approve(h, sid, "cid-appr-late-1", "perm-1", "once");
      await h.stream.until(finishedFrame(sid), 20000);

      approve(h, sid, "cid-appr-late-2", "perm-late", "once");
      const notice = await h.stream.until(
        (f) => f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "notice" && f.agentEvent.text === "审批已失效（会话已不在等待态）",
        8000,
      );
      expect(notice[notice.length - 1].agentEvent.severity).toBe("warn");
      expect(existsSync(join(permDirOf(h, sid), "perm-late.decision.txt"))).toBe(false);
    } finally {
      await h.app.close();
    }
  }, 40_000);

  it("⑤ 中断挂起：waiting 时杀假 CLI → send 续接 →「审批已失效（会话中断）」→ 重挂后重走审批闭环", async () => {
    const h = await bootApproval("permission-gate-turn.jsonl");
    try {
      const sid = await createGateSession(h);
      await h.stream.until(waitingFrame(sid));

      // 真杀假 CLI 进程树（pid 由假 CLI 启动时落盘）——闸环路悬起态下的中断现场。
      const pid = readFileSync(join(h.workDir, "pid.txt"), "utf8").trim();
      spawnSync("taskkill", ["/pid", pid, "/T", "/F"], { stdio: "ignore", windowsHide: true });
      await h.stream.until((f) => f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "exit", 10000);
      // 收尾在 exit 事件之前清闸目录（评审重点 9）：挂起请求不得泄漏给续接轮。
      expect(existsSync(permDirOf(h, sid))).toBe(false);

      h.ws.send(JSON.stringify({
        v: 1, type: "session.command", sessionId: sid, clientId: "cid-appr-resume-1", cmd: { cmd: "send", text: "continue" },
      }));
      const invalidated = await h.stream.until(
        (f) => f.type === "session.event" && f.sessionId === sid && f.agentEvent?.type === "notice" && f.agentEvent.text === "审批已失效（会话中断）",
        10000,
      );
      expect(invalidated[invalidated.length - 1].agentEvent.severity).toBe("info");

      // 续接轮重新走到闸：新 permission 卡照常承接，once 允许后收尾 finished。
      const waiting = await h.stream.until(waitingFrame(sid), 20000);
      expect(kindsOf(waiting, sid).filter((k) => k === "permission")).toHaveLength(1);
      approve(h, sid, "cid-appr-resume-2", "perm-1", "once");
      const rest = await h.stream.until(finishedFrame(sid), 20000);
      expect(kindsOf(rest, sid).at(-1)).toBe("state:finished");
      expect(readFileSync(join(permDirOf(h, sid), "perm-1.decision.txt"), "utf8")).toBe(JSON.stringify({ behavior: "allow" }));
    } finally {
      await h.app.close();
    }
  }, 45_000);

  it("⑥ 协议守卫：permissionMode=bypassPermissions 的 session.create → error 帧（手机不可升权）", async () => {
    const h = await bootApproval("permission-gate-turn.jsonl");
    try {
      h.ws.send(JSON.stringify({
        v: 1, type: "session.create",
        spec: { agentId: "claude", cwd: h.workDir, permissionMode: "bypassPermissions" },
      }));
      const errors = await h.stream.until((f) => f.type === "error", 8000);
      expect(errors[errors.length - 1].code).toBe("protocol.bad_frame");
    } finally {
      await h.app.close();
    }
  }, 30_000);
});
