#!/usr/bin/env node
/**
 * aimi 审批闸：零依赖的 stdio MCP server（纯 .mjs 资产，不进 TS 编译面）。
 *
 * 由 claude CLI 经 per-session `--mcp-config` 拉起（SPIKE FACT4：审批请求不进 stream-json，
 * 由闸进程承接——请求帧 `{tool_name, input, tool_use_id}`；本进程把每个请求落成
 * `<请求目录>/<tool_use_id>.request.json`，由 aimi 侧 `PermissionRelay` 轮询该目录承接，
 * 手机决定后写 `<tool_use_id>.decision.txt`，本进程把它作为 raw JSON 回灌给 CLI。
 *
 * **无内置超时**（SPIKE FACT6 实证：CLI 对闸挂起等待是正确行为——手机迟迟不答则该工具调用
 * 悬挂，而不是自作主张放行/拒绝）。决定文件回灌后延迟 5s 删除两个握手文件
 * （目录整体清理由会话 dispose 兜底——此处只做文件级 hygiene）。
 *
 * argv[2] = 请求目录（claudeSession 写 mcp.json 时给出，确定性路径 `<dataDir>/perms/<sessionId>/`）。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 决定文件轮询周期（毫秒）。 */
const DECISION_POLL_MS = 100;
/** 回灌完成后延迟删除握手文件的时长（毫秒）：给 CLI 读取决定留足余量。 */
const CLEANUP_DELAY_MS = 5000;

/** 唯一暴露的工具：CLI 的 --permission-prompt-tool 指向 `mcp__aimi_gate__request_permission`。 */
const TOOL_DEF = {
  name: "request_permission",
  description: "把一次工具调用提交给手机端审批（aimi 审批闸的唯一入口）",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string", description: "被审批的工具名" },
      input: { type: "object", description: "工具调用的入参" },
    },
    required: ["tool_name", "input"],
  },
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const dir = process.argv[2];
if (dir === undefined) {
  console.error("usage: node gate.mjs <request-dir>");
  process.exit(2);
}

/** 写出一行 JSON-RPC 应答（行分隔 stdio 帧）。 */
function reply(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function replyResult(id, result) {
  reply({ jsonrpc: "2.0", id, result });
}

function replyError(id, message) {
  reply({ jsonrpc: "2.0", id, error: { code: -32601, message } });
}

/** 处理一次 tools/call：落请求文件 → 轮询决定文件 → 回灌 raw JSON → 延迟清理。 */
async function handleCall(id, params) {
  const args = params?.arguments ?? {};
  const toolName = typeof args.tool_name === "string" ? args.tool_name : "";
  const input = args.input ?? {};
  // tool_use_id 是关联键（请求/决定文件名、手机事件 id 同源）；缺失时以时间戳兜底，不让闸崩流。
  const toolUseId = typeof args.tool_use_id === "string" && args.tool_use_id !== "" ? args.tool_use_id : "gate-" + Date.now();
  const requestPath = join(dir, toolUseId + ".request.json");
  const decisionPath = join(dir, toolUseId + ".decision.txt");
  writeFileSync(requestPath, JSON.stringify({ toolName, input, toolUseId }));
  for (;;) {
    if (existsSync(decisionPath)) {
      const raw = readFileSync(decisionPath, "utf8");
      if (raw.trim() !== "") {
        // raw 原文逐字回灌：allow/deny 形态由 aimi 侧写入的 JSON 承载，闸不做二次解释。
        replyResult(id, { content: [{ type: "text", text: raw }] });
        const timer = setTimeout(() => {
          try { rmSync(requestPath, { force: true }); rmSync(decisionPath, { force: true }); } catch { /* 尽力而为 */ }
        }, CLEANUP_DELAY_MS);
        timer.unref?.(); // 不阻塞进程退出（会话收尾时 CLI 死亡先于清理定时器是常态）
        return;
      }
    }
    await sleep(DECISION_POLL_MS);
  }
}

/** 处理一行 JSON-RPC 请求（notification 无 id：无需应答，静默）。 */
function handleLine(line) {
  if (line.trim() === "") return;
  let req;
  try { req = JSON.parse(line); } catch { return; } // 非 JSON 行静默（stdio 容错）
  if (req.id === undefined || req.id === null) return;
  switch (req.method) {
    case "initialize":
      // protocolVersion 按请求原样回显（MCP 握手契约——客户端决定版本）。
      replyResult(req.id, {
        protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "aimi_gate", version: "0.1.0" },
      });
      return;
    case "tools/list":
      replyResult(req.id, { tools: [TOOL_DEF] });
      return;
    case "tools/call":
      if (req.params?.name !== "request_permission") {
        replyError(req.id, "unknown tool: " + String(req.params?.name));
        return;
      }
      void handleCall(req.id, req.params).catch(() => {
        // 闸内环错误不炸流：回一个错误应答让 CLI 侧按无效处理。
        replyError(req.id, "gate internal error");
      });
      return;
    default:
      replyError(req.id, "unknown method: " + String(req.method));
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const parts = buf.split("\n");
  buf = parts.pop() ?? "";
  for (const part of parts) handleLine(part.replace(/\r$/, ""));
});
process.stdin.on("end", () => process.exit(0));
