// 一次性探针脚本（不入运行时）：实跑 `zcode app-server --stdio`，把收发帧全量落盘。
// 用法：node probe-appserver.mjs <输出目录>
// 产出：<输出目录>/probe-recv.jsonl（对端帧）与 probe-sent.jsonl（我方帧，含反向应答）。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2] ?? process.env.TEMP ?? ".";
mkdirSync(outDir, { recursive: true });
const recvFile = join(outDir, "probe-recv.jsonl");
const sentFile = join(outDir, "probe-sent.jsonl");
writeFileSync(recvFile, "");
writeFileSync(sentFile, "");

const cli = join("D:", "ZCode", "resources", "glm", "zcode.cjs");
const child = spawn(process.execPath, [cli, "app-server", "--stdio"], {
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
const workDir = join(outDir, "workspace");
mkdirSync(workDir, { recursive: true });

let nextId = 1;
const write = (frame) => {
  appendFileSync(sentFile, JSON.stringify(frame) + "\n");
  child.stdin.write(JSON.stringify(frame) + "\n");
};
const send = (method, params) => {
  const frame = { id: nextId++, method, params };
  write(frame);
  return frame.id;
};

// 手写 LF 分帧（不用 readline：U+2028/2029 会被当换行切半帧——官方宿主同款警告）。
let buffer = "";
const frames = [];
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf("\n");
  while (idx >= 0) {
    const line = buffer.slice(0, idx).replace(/\r$/, "");
    buffer = buffer.slice(idx + 1);
    if (line !== "") {
      try {
        const frame = JSON.parse(line);
        frames.push(frame);
        appendFileSync(recvFile, JSON.stringify({ at: Date.now(), frame }) + "\n");
        // 反向请求（id 形如 "server-N"）：回一个空 result 让流程继续；形状由本探针实证。
        if (typeof frame.id === "string" && frame.id.startsWith("server-") && frame.method !== undefined) {
          if (frame.method === "session/requestRuntimePreferences") {
            write({ id: frame.id, result: { nativeSearchEnhancementsEnabled: false } });
          } else {
            write({ id: frame.id, result: {} });
          }
        }
        if (frame.method === "session/lifecycle/changed" && frame.params?.sessionId) {
          sessionId ??= frame.params.sessionId;
        }
      } catch {
        appendFileSync(recvFile, JSON.stringify({ at: Date.now(), raw: line }) + "\n");
      }
    }
    idx = buffer.indexOf("\n");
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  appendFileSync(recvFile, JSON.stringify({ at: Date.now(), stderr: chunk.slice(0, 300) }) + "\n");
});
child.on("exit", (code) => {
  appendFileSync(recvFile, JSON.stringify({ at: Date.now(), exit: code }) + "\n");
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let sessionId;

await wait(2000);
send("runtime/capabilities", { hostCapabilities: {} });
await wait(600);

send("session/create", { workspace: { workspacePath: workDir, workspaceKey: workDir }, mode: "plan" });
// 等会话就绪（lifecycle state=ready / create result）。
for (let i = 0; i < 20 && sessionId === undefined; i++) await wait(300);
console.log("sessionId:", sessionId ?? "(none)");
if (sessionId !== undefined) {
  for (let i = 0; i < 20; i++) {
    const lifecycle = frames.find(
      (f) =>
        f.method === "session/lifecycle/changed" && f.params?.sessionId === sessionId && f.params?.state === "ready",
    );
    if (lifecycle !== undefined) break;
    await wait(300);
  }
  send("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" });
  await wait(600);
  send("session/send", { sessionId, content: "只回复两个字母: ok。不要调用任何工具。" });
  await wait(25000);
  send("session/stop", { sessionId });
  await wait(1500);
} else {
  await wait(3000);
}

console.log("frames:", frames.length);
child.kill("SIGKILL");
process.exit(0);
