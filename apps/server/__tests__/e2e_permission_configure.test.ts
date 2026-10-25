import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { ServerFrame } from "@aimi/protocol";
import { Application } from "../src/app/application.js";
import { E2E_FAKE_CLI } from "./fakeCli.js";

const directories: string[] = [];

/** 等待 SDK 释放 Windows 工作目录，临时资源不进入仓库。 */
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

/** 保留完整协议序列，避免匹配回执时吞掉独立的权限快照。 */
class PermissionInbox {
  readonly frames: ServerFrame[] = [];

  /** 在握手前订阅，覆盖 welcome 与运行时能力的交错发送。 */
  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      this.frames.push(JSON.parse(String(data)) as ServerFrame);
    });
  }

  /** 帧匹配有界等待，失败时明确指出缺失的真实协议结果。 */
  async until(predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame> {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const found = this.frames.find(predicate);
      if (found !== undefined) return found;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    throw new Error("权限协议应答超时");
  }
}

/** SDK 控制应答、SQLite 真值和新旧手机投影一起验证，避免仅靠假句柄证明成功。 */
describe.skipIf(process.platform !== "win32")("权限配置 WebSocket 与 SDK 集成", () => {
  it("动态模式按能力展示；拒绝及组合部分失败保持真值；旧手机不接收新增帧", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aimi-permission-e2e-"));
    directories.push(directory);
    const success =
      'send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } });';
    expect(E2E_FAKE_CLI).toContain(success);
    writeFileSync(
      join(directory, "fake-cli.mjs"),
      E2E_FAKE_CLI.replace(
        success,
        [
          'if (req.subtype === "set_permission_mode" && req.mode === "bypassPermissions") {',
          'send({ type: "control_response", response: { subtype: "error", request_id: frame.request_id, error: "permission denied by fake CLI" } });',
          "} else {",
          success,
          "}",
        ].join("\n"),
      ),
    );
    writeFileSync(join(directory, "normal-turn.jsonl"), "");
    vi.stubEnv("AIMI_FAKE_CLI_PATH", join(directory, "fake-cli.mjs"));
    const app = new Application({
      port: 0,
      dataDir: join(directory, "data"),
      logDir: join(directory, "logs"),
      logLevel: "ERROR",
      watchdogMs: 600000,
      serverVersion: "permission-test",
      agents: {
        permissionCeiling: "bypassPermissions",
        allowedPermissionModes: { claude: ["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk", "auto"] },
      },
    });
    const sockets: WebSocket[] = [];
    try {
      const { port } = await app.start();
      const token = readFileSync(join(directory, "data", "lan-token.txt"), "utf8").trim();
      /** 相同设备重连，分别声明动态和旧客户端模式支持。 */
      async function connect(dynamic: boolean) {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        sockets.push(socket);
        const inbox = new PermissionInbox(socket);
        await new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        });
        socket.send(
          JSON.stringify({
            v: 1,
            type: "hello",
            token,
            resume: null,
            commandAck: true,
            capabilities: dynamic ? { dynamicPermissions: true } : { permissionModes: ["default", "plan"] },
          }),
        );
        const welcome = await inbox.until((frame) => frame.type === "welcome");
        return { socket, inbox, welcome };
      }
      const phone = await connect(true);
      expect(phone.welcome).toMatchObject({
        agents: [
          expect.objectContaining({
            permissionModes: expect.arrayContaining([
              expect.objectContaining({ id: "auto" }),
              expect.objectContaining({ id: "dontAsk" }),
            ]),
          }),
        ],
      });
      phone.socket.send(
        JSON.stringify({
          v: 1,
          type: "session.create",
          spec: { agentId: "claude", cwd: directory, permissionMode: "default" },
        }),
      );
      const created = await phone.inbox.until((frame) => frame.type === "ack");
      if (created.type !== "ack") throw new Error("缺少创建回执");
      const sessionId = created.sessionId;
      /** 独立读取 SQLite，验证 UI 快照不是伪造成功的唯一证据。 */
      function stored() {
        const db = new Database(join(directory, "data", "aimi.db"), { readonly: true });
        try {
          return db.prepare("SELECT model, permission_mode FROM sessions WHERE id = ?").get(sessionId);
        } finally {
          db.close();
        }
      }
      /** 每次命令使用唯一 clientId，按实际终态回执判定成功与失败。 */
      async function configure(clientId: string, patch: { model?: string; permissionMode?: string }) {
        phone.socket.send(
          JSON.stringify({ v: 1, type: "session.command", sessionId, clientId, cmd: { cmd: "configure", ...patch } }),
        );
        return phone.inbox.until((frame) => frame.type === "command.ack" && frame.clientId === clientId);
      }
      expect(await configure("permissions-plan", { permissionMode: "plan" })).toMatchObject({ status: "delivered" });
      expect(stored()).toMatchObject({ permission_mode: "plan" });
      expect(
        await phone.inbox.until((frame) => frame.type === "session.permissions" && frame.currentMode === "plan"),
      ).toMatchObject({ sessionId, currentMode: "plan" });
      expect(
        await configure("permissions-partial", { model: "new-model", permissionMode: "bypassPermissions" }),
      ).toMatchObject({ status: "rejected" });
      expect(stored()).toMatchObject({ model: "new-model", permission_mode: "plan" });
      expect(
        phone.inbox.frames
          .filter((frame) => frame.type === "session.permissions")
          .some((frame) => frame.type === "session.permissions" && frame.currentMode === "bypassPermissions"),
      ).toBe(false);
      expect(await configure("permissions-unknown", { permissionMode: "invented" })).toMatchObject({
        status: "rejected",
      });
      expect(await configure("permissions-dont-ask", { permissionMode: "dontAsk" })).toMatchObject({
        status: "delivered",
      });
      phone.socket.terminate();
      const legacy = await connect(false);
      expect(legacy.welcome).toMatchObject({ sessions: [expect.objectContaining({ permissionMode: "default" })] });
      expect(legacy.inbox.frames.some((frame) => frame.type === "session.permissions")).toBe(false);
      expect(stored()).toMatchObject({ permission_mode: "dontAsk" });
      legacy.socket.terminate();
      const restored = await connect(true);
      expect(restored.welcome).toMatchObject({
        sessions: [expect.objectContaining({ permissionMode: "dontAsk", permissionModes: expect.any(Array) })],
      });
    } finally {
      for (const socket of sockets) socket.terminate();
      await app.close();
    }
  }, 30000);
});
