import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { ServerFrame } from "@aimi/protocol";
import { Application } from "../src/app/application.js";
import { E2E_FAKE_CLI } from "./fakeCli.js";

const temporaryDirectories: string[] = [];

/** 清理假 CLI 工作目录；Windows 子进程句柄释放可能晚于应用关闭。 */
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(directory, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 19) {
          throw error;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
      }
    }
  }
});

/** 保存真实 WebSocket 帧，防止 SDK 控制应答和会话事件交错时漏读回执。 */
class FrameInbox {
  readonly #frames: ServerFrame[] = [];

  /** 从连接建立前开始收帧，所有断言使用真实协议解析后的 JSON。 */
  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      this.#frames.push(JSON.parse(String(data)) as ServerFrame);
    });
  }

  /** 等待匹配帧并消费此前消息；有上限的状态轮询不依赖固定 SDK 启动速度。 */
  async until(predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const frame = this.#frames.shift();
      if (frame !== undefined) {
        if (predicate(frame)) {
          return frame;
        }
        continue;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    throw new Error("等待模型配置协议帧超时");
  }
}

/** 读取服务端持久化的模型，独立于回执及移动端投影验证 SQLite 真值。 */
function storedModel(dataDirectory: string, sessionId: string): string {
  const database = new Database(join(dataDirectory, "aimi.db"), { readonly: true });
  try {
    return (database.prepare("SELECT model FROM sessions WHERE id = ?").get(sessionId) as { model: string }).model;
  } finally {
    database.close();
  }
}

/** 本用例复用共享假 CLI，仅让指定自定义模型的控制请求失败，不替换生产适配器。 */
describe.skipIf(process.platform !== "win32")("模型配置 WebSocket 与 SDK 集成", () => {
  /** 验证实际终态回执、数据库及重新握手投影共同遵循 SDK 确认结果。 */
  it("自定义模型成功持久化；SDK 拒绝后回执 rejected，重连 welcome 保留旧选择", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aimi-model-configure-"));
    temporaryDirectories.push(directory);
    const dataDirectory = join(directory, "data");
    const rejectedModel = "vendor/rejected-model";
    const currentModel = "vendor/custom-model-v2";
    const successResponse =
      'send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } });';
    const rejectionResponse = [
      'if (req.subtype === "set_model" && req.model === "vendor/rejected-model") {',
      '  send({ type: "control_response", response: { subtype: "error", request_id: frame.request_id, error: "model denied by fake CLI" } });',
      "} else {",
      `  ${successResponse}`,
      "}",
    ].join("\n");
    expect(E2E_FAKE_CLI).toContain(successResponse);
    writeFileSync(join(directory, "fake-cli.mjs"), E2E_FAKE_CLI.replace(successResponse, rejectionResponse));
    writeFileSync(join(directory, "normal-turn.jsonl"), "");
    vi.stubEnv("AIMI_FAKE_CLI_PATH", join(directory, "fake-cli.mjs"));
    vi.stubEnv("AIMI_ARGS_LOG", join(directory, "args.log"));

    const application = new Application({
      port: 0,
      dataDir: dataDirectory,
      logDir: join(directory, "logs"),
      logLevel: "ERROR",
      watchdogMs: 600_000,
      serverVersion: "0.1.0",
    });
    const sockets: WebSocket[] = [];
    try {
      const { port } = await application.start();
      const token = readFileSync(join(dataDirectory, "lan-token.txt"), "utf8").trim();

      /** 每次握手声明命令回执能力；欢迎帧验证服务端配置而非历史实测模型。 */
      async function connect() {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        sockets.push(socket);
        const inbox = new FrameInbox(socket);
        await new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        });
        socket.send(JSON.stringify({ v: 1, type: "hello", token, resume: null, commandAck: true }));
        const welcome = await inbox.until((frame) => frame.type === "welcome");
        if (welcome.type !== "welcome") {
          throw new Error("未收到 welcome");
        }
        return { socket, inbox, welcome };
      }

      const phone = await connect();
      phone.socket.send(
        JSON.stringify({
          v: 1,
          type: "session.create",
          spec: { agentId: "claude", cwd: directory, permissionMode: "default", model: "vendor/initial-model" },
        }),
      );
      const created = await phone.inbox.until((frame) => frame.type === "ack");
      if (created.type !== "ack") {
        throw new Error("未收到会话创建 ack");
      }
      const sessionId = created.sessionId;
      phone.socket.send(
        JSON.stringify({
          v: 1,
          type: "session.command",
          sessionId,
          clientId: "configure-model-success",
          cmd: { cmd: "configure", model: currentModel },
        }),
      );
      expect(await phone.inbox.until((frame) => frame.type === "command.ack")).toMatchObject({
        type: "command.ack",
        clientId: "configure-model-success",
        sessionId,
        status: "delivered",
      });
      expect(storedModel(dataDirectory, sessionId)).toBe(currentModel);

      phone.socket.send(
        JSON.stringify({
          v: 1,
          type: "session.command",
          sessionId,
          clientId: "configure-model-rejected",
          cmd: { cmd: "configure", model: rejectedModel },
        }),
      );
      expect(await phone.inbox.until((frame) => frame.type === "command.ack")).toMatchObject({
        type: "command.ack",
        clientId: "configure-model-rejected",
        sessionId,
        status: "rejected",
        code: "server.busy",
      });
      expect(storedModel(dataDirectory, sessionId)).toBe(currentModel);
      const requests = readFileSync(join(directory, "stdin.log"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((frame) => frame.type === "control_request" && frame.request?.subtype === "set_model")
        .map((frame) => frame.request.model);
      expect(requests).toEqual([currentModel, rejectedModel]);

      phone.socket.terminate();
      const reconnected = await connect();
      expect(reconnected.welcome.sessions).toContainEqual(
        expect.objectContaining({ id: sessionId, model: currentModel }),
      );
    } finally {
      for (const socket of sockets) {
        socket.terminate();
      }
      await application.close();
    }
  }, 30_000);
});
