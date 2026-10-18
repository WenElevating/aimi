import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** 被测闸脚本（同目录资产，非 TS——直接以子进程形态驱动）。 */
const GATE = fileURLToPath(new URL("./gate.mjs", import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 起一个真 stdio 闸进程（node 直拉，无 shell——资产路径确定）。 */
function spawnGate(dir: string): { stdin: (line: string) => void; nextLine: (timeoutMs?: number) => Promise<string>; child: ReturnType<typeof spawn> } {
  const child = spawn(process.execPath, [GATE, dir], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buf = "";
  const lines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(part); else lines.push(part);
    }
  });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr.push(chunk); });
  return {
    child,
    stdin: (line) => { child.stdin.write(line + "\n"); },
    nextLine: (timeoutMs = 5000) => {
      const queued = lines.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise<string>((resolve, reject) => {
        let waiter: (line: string) => void;
        const timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) waiters.splice(at, 1); // 超时退队：防陈旧 waiter 吞掉下一次应答的 resolve
          reject(new Error("闸应答超时: " + stderr.join("")));
        }, timeoutMs);
        waiter = (line) => { clearTimeout(timer); resolve(line); };
        waiters.push(waiter);
      });
    },
  };
}

describe("gate.mjs（真 stdio MCP 闸）", () => {
  it("initialize 回显 protocolVersion；tools/list 只挂 request_permission 一个工具", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aimi-gate-"));
    dirs.push(dir);
    const gate = spawnGate(dir);
    try {
      gate.stdin(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-cli", version: "1" } } }));
      const init = JSON.parse(await gate.nextLine());
      expect(init.id).toBe(1);
      expect(init.result.protocolVersion).toBe("2025-06-18");
      expect(init.result.serverInfo.name).toBe("aimi_gate");
      expect(init.result.capabilities.tools).toEqual({});

      gate.stdin(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
      const list = JSON.parse(await gate.nextLine());
      expect(list.id).toBe(2);
      expect(list.result.tools).toHaveLength(1);
      expect(list.result.tools[0].name).toBe("request_permission");
      expect(list.result.tools[0].inputSchema.required).toEqual(["tool_name", "input"]);
      expect(list.result.tools[0].inputSchema.properties).toHaveProperty("tool_name");
      expect(list.result.tools[0].inputSchema.properties).toHaveProperty("input");
    } finally {
      gate.child.kill();
    }
  });

  it("tools/call allow：请求文件内容全等 → 写 decision.txt → 回灌 raw JSON 全等", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aimi-gate-"));
    dirs.push(dir);
    const gate = spawnGate(dir);
    try {
      gate.stdin(JSON.stringify({
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "request_permission", arguments: { tool_name: "Bash", input: { command: "ls -la" }, tool_use_id: "tu-g1" } },
      }));

      // 请求文件出现且内容为闸契约形状（aimi 侧 PermissionRelay 的输入）。
      const requestPath = join(dir, "tu-g1.request.json");
      for (let i = 0; !existsSync(requestPath) && i < 100; i++) await sleep(20);
      expect(JSON.parse(readFileSync(requestPath, "utf8"))).toEqual({
        toolName: "Bash", input: { command: "ls -la" }, toolUseId: "tu-g1",
      });

      // 决定文件 raw 内容必须逐字回灌（纯文本判无效的判据在 CLI 侧——闸是哑管道）。
      const decision = JSON.stringify({ behavior: "allow", updatedInput: { command: "ls -la" } });
      writeFileSync(join(dir, "tu-g1.decision.txt"), decision, "utf8");
      const response = JSON.parse(await gate.nextLine());
      expect(response.id).toBe(3);
      expect(response.result.content).toEqual([{ type: "text", text: decision }]);
    } finally {
      gate.child.kill();
    }
  });

  it("tools/call deny：回灌 raw JSON 全等（软拒形态由内容承载）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aimi-gate-"));
    dirs.push(dir);
    const gate = spawnGate(dir);
    try {
      gate.stdin(JSON.stringify({
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "request_permission", arguments: { tool_name: "Write", input: { file_path: "D:\\w\\x.txt" }, tool_use_id: "tu-g2" } },
      }));
      const requestPath = join(dir, "tu-g2.request.json");
      for (let i = 0; !existsSync(requestPath) && i < 100; i++) await sleep(20);
      expect(JSON.parse(readFileSync(requestPath, "utf8"))).toEqual({
        toolName: "Write", input: { file_path: "D:\\w\\x.txt" }, toolUseId: "tu-g2",
      });

      const decision = JSON.stringify({ behavior: "deny", message: "手机端拒绝" });
      writeFileSync(join(dir, "tu-g2.decision.txt"), decision, "utf8");
      const response = JSON.parse(await gate.nextLine());
      expect(response.id).toBe(4);
      expect(response.result.content).toEqual([{ type: "text", text: decision }]);
    } finally {
      gate.child.kill();
    }
  });

  it("半写 decision 防线：非法/缺 behavior 的内容不回灌（继续轮询），补写合法后照常回灌", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aimi-gate-"));
    dirs.push(dir);
    const gate = spawnGate(dir);
    try {
      gate.stdin(JSON.stringify({
        jsonrpc: "2.0", id: 5, method: "tools/call",
        params: { name: "request_permission", arguments: { tool_name: "Bash", input: { command: "ls" }, tool_use_id: "tu-g3" } },
      }));
      const decisionPath = join(dir, "tu-g3.decision.txt");
      for (let i = 0; !existsSync(join(dir, "tu-g3.request.json")) && i < 100; i++) await sleep(20);
      // 半写窗口：空串与半个 JSON 都不得回灌（回灌即被 CLI 判无效——审批悄悄丢掉）。
      writeFileSync(decisionPath, "", "utf8");
      writeFileSync(decisionPath, `{"behavior":"al`, "utf8");
      await expect(gate.nextLine(300)).rejects.toThrow("闸应答超时"); // 两拍轮询内无应答产出
      // 补写合法决定：下一拍照常回灌——半写防线不吞合法决定。
      const decision = JSON.stringify({ behavior: "allow" });
      writeFileSync(decisionPath, decision, "utf8");
      const response = JSON.parse(await gate.nextLine());
      expect(response.id).toBe(5);
      expect(response.result.content).toEqual([{ type: "text", text: decision }]);
    } finally {
      gate.child.kill();
    }
  });
});
