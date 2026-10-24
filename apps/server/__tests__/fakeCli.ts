import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * e2e 共享假 CLI（SDK 时代）：经 `AIMI_FAKE_CLI_PATH` 注入——ClaudeSession 把 SDK 的
 * `pathToClaudeCodeExecutable` 指到该脚本并以 `node` 拉起（替代旧 PATH + `claude.cmd` 垫片）。
 *
 * 职责（环境开关全部可选）：
 * - **SDK 控制协议**：`initialize` 与其他控制请求一律回 `success`（request_id 回显）；
 *   `interrupt` 控制请求回 success 后静默退出（服务端事实的 stopped 已先行，进程退出即流终止）；
 * - **回放**：缺省**每个 user 帧**全文重放一轮 `AIMI_FAKE_TURN` 样本（多回合 FACT1：每条 user
 *   帧触发一轮新回合，init 重发）；`AIMI_FAKE_REPLAY_ON_START` 存在时改为 spawn 后立刻回放一轮
 *   （不等输入——旧 M0 基线行为）；回放完布 500ms 静默退出 timer（新 user 帧先清旧 timer），
 *   stdin EOF 亦退出——测试不留孤儿；
 * - **行距**：`AIMI_FAKE_INTERVAL_MS` 显式指定时按标称行距**计划补发**（Windows 定时器粒度 ~15.6ms，
 *   裸 setInterval 失真——性能预算断言依赖标称跨度；paced 模式不处理标线）；
 * - **审批标线**：样本中的 `{"__aimi_perm__":{id,toolName,input}}` 行不进 stdout——转为
 *   `can_use_tool` 控制请求发往 SDK（触发 canUseTool 审批桥），等 control_response 到达再续放；
 *   决定全文落 `cwd/decisions.log`（手机决定 → SDK 回灌的断言面）；
 * - **续接校验**：`AIMI_FAKE_EXPECT_RESUME` 存在时校验 argv 含 `--resume <期望值>`，否则 exit(3)；
 *   `AIMI_ARGS_LOG` 存在时把 argv 拼成恰好一行追加（进程数即冷启动数）；
 * - **观测面**：`cwd/pid.txt`（启动写自身 pid——waiting 中杀假 CLI 用例的数据源）、
 *   `cwd/stdin.log`（每行 stdin）、`cwd/stdout.log`（回放行镜像）。
 */
export const E2E_FAKE_CLI = [
  'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
  'import { dirname, join } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  "",
  'const here = dirname(fileURLToPath(import.meta.url));',
  'const turn = process.env.AIMI_FAKE_TURN || "normal-turn.jsonl";',
  'const lines = readFileSync(join(here, turn), "utf8").split(/\\r?\\n/).filter((l) => l !== "");',
  'const paced = process.env.AIMI_FAKE_INTERVAL_MS !== undefined;',
  'const intervalMs = Number(process.env.AIMI_FAKE_INTERVAL_MS || "30");',
  'const replayOnStart = process.env.AIMI_FAKE_REPLAY_ON_START !== undefined;',
  "",
  'writeFileSync(join(process.cwd(), "pid.txt"), String(process.pid));',
  'if (process.env.AIMI_ARGS_LOG !== undefined) appendFileSync(process.env.AIMI_ARGS_LOG, process.argv.slice(2).join(" ") + "\\n");',
  'const expected = process.env.AIMI_FAKE_EXPECT_RESUME;',
  "if (expected !== undefined) {",
  '  const arg = process.argv.find((a) => a === "--resume" || a.startsWith("--resume="));',
  '  const value = arg === undefined ? null : (arg === "--resume" ? process.argv[process.argv.indexOf(arg) + 1] : arg.slice("--resume=".length));',
  "  if (value !== expected) process.exit(3);",
  "}",
  "",
  'const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");',
  "let exitTimer = null;",
  "let queue = Promise.resolve();",
  "const armExit = () => {",
  "  if (exitTimer !== null) clearTimeout(exitTimer);",
  "  exitTimer = setTimeout(() => process.exit(0), 500);",
  "};",
  "",
  "// 审批挂起：按样本标线发 can_use_tool，等 SDK 的 control_response（无超时——挂起语义与真闸一致）。",
  "const pendingGates = new Map();",
  "const gateWait = (marker) => new Promise((resolve) => {",
  "  pendingGates.set(String(marker.id), resolve);",
  '  send({ type: "control_request", request_id: "gate-" + marker.id, request: { subtype: "can_use_tool", tool_name: marker.toolName, input: marker.input, tool_use_id: marker.id } });',
  "});",
  "",
  "function replayOnce() {",
  "  queue = queue.then(async () => {",
  "    if (!paced) {",
  "      for (const row of lines) {",
  "        let marker = null;",
  '        try { const obj = JSON.parse(row); if (obj && obj.__aimi_perm__) marker = obj.__aimi_perm__; } catch {}',
  "        if (marker !== null) { await gateWait(marker); continue; }",
  '        process.stdout.write(row + "\\n");',
  '        appendFileSync(join(process.cwd(), "stdout.log"), row + "\\n");',
  "      }",
  "      armExit();",
  "      return;",
  "    }",
  "    await new Promise((done) => {",
  "      let i = 0;",
  "      const startedAt = Date.now();",
  "      const pollMs = Math.max(1, Math.min(intervalMs, 15));",
  "      const timer = setInterval(() => {",
  "        const due = Math.min(lines.length, Math.floor((Date.now() - startedAt) / intervalMs) + 1);",
  '        while (i < due) { process.stdout.write(lines[i] + "\\n"); i += 1; }',
  "        if (i >= lines.length) { clearInterval(timer); done(); }",
  "      }, pollMs);",
  "    });",
  "    armExit();",
  "  });",
  "}",
  "",
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
  "    let frame;",
  "    try { frame = JSON.parse(line); } catch { continue; }",
  '    if (frame.type === "control_request") {',
  "      const req = frame.request ?? {};",
  '      send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } });',
  '      if (req.subtype === "interrupt") armExit();',
  "      continue;",
  "    }",
  '    if (frame.type === "control_response") {',
  '      appendFileSync(join(process.cwd(), "decisions.log"), JSON.stringify(frame.response) + "\\n");',
  '      const rid = String(frame.response?.request_id ?? "");',
  '      const waiter = pendingGates.get(rid.replace(/^gate-/, ""));',
  "      if (waiter !== undefined) { pendingGates.delete(rid.replace(/^gate-/, \"\")); waiter(); }",
  "      continue;",
  "    }",
  '    if (frame.type === "user" && frame.parent_tool_use_id == null) {',
  "      if (exitTimer !== null) { clearTimeout(exitTimer); exitTimer = null; }",
  "      replayOnce();",
  "    }",
  "  }",
  "});",
  'process.stdin.on("end", () => process.exit(0));',
  "if (replayOnStart) replayOnce();",
].join("\n");

/**
 * 把共享假 CLI 与回放样本写进目标目录（各 e2e 的 fakeClaudeDir 收口点）。
 *
 * @param dir - 临时目录（调用方负责登记清理）
 * @param fixtures - 回放样本名 → 内容（至少一项；`AIMI_FAKE_TURN` 从中选场）
 */
export function writeFakeCli(dir: string, fixtures: Record<string, string>): void {
  for (const [name, content] of Object.entries(fixtures)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  writeFileSync(join(dir, "fake-cli.mjs"), E2E_FAKE_CLI, "utf8");
}

/** 基线样本（`src/agents/claude/__fixtures__/normal-turn.jsonl`）的便捷读取。 */
export function readFixture(path: string): string {
  return readFileSync(path, "utf8");
}
