import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { DirectoryListResultFrame, ServerFrame } from "@aimi/protocol";
import { Application } from "../src/app/application.js";
import { E2E_FAKE_CLI } from "./fakeCli.js";

const temporaryDirectories: string[] = [];

/** SDK 句柄退出后清理隔离目录，不读取或改写真实用户服务。 */
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

/** 累积完整连接的帧，验证目录响应与握手/会话事件互不混用。 */
class DirectoryInbox {
  readonly frames: ServerFrame[] = [];

  /** 在 open 前订阅以捕获紧接握手发出的能力声明。 */
  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      this.frames.push(JSON.parse(String(data)) as ServerFrame);
    });
  }

  /** 有界等待指定应答；不消费其他帧，便于检查事件隔离。 */
  async until(predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = this.frames.find(predicate);
      if (found !== undefined) return found;
      await new Promise<void>((done) => {
        setTimeout(done, 10);
      });
    }
    throw new Error("目录协议应答超时");
  }
}

describe("真实鉴权 WebSocket 目录浏览", () => {
  /** 正常目录、根目录和失败结果均按 requestId 关联，不产生会话记录。 */
  it("协商能力并列目录、盘符及父目录；失败返回准确错误", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-directory-e2e-"));
    temporaryDirectories.push(root);
    writeFileSync(join(root, "fake-cli.mjs"), E2E_FAKE_CLI);
    writeFileSync(join(root, "normal-turn.jsonl"), "");
    vi.stubEnv("AIMI_FAKE_CLI_PATH", join(root, "fake-cli.mjs"));
    const browse = join(root, "browse");
    mkdirSync(join(browse, "beta"), { recursive: true });
    mkdirSync(join(browse, "alpha"));
    writeFileSync(join(browse, "file.txt"), "not a directory");
    const app = new Application({
      port: 0,
      dataDir: join(root, "data"),
      logDir: join(root, "logs"),
      logLevel: "ERROR",
      watchdogMs: 600000,
      serverVersion: "directory-test",
    });
    let socket: WebSocket | undefined;
    try {
      const { port } = await app.start();
      socket = new WebSocket(`ws://127.0.0.1:${port}`);
      const inbox = new DirectoryInbox(socket);
      await new Promise<void>((done, reject) => {
        socket!.once("open", done);
        socket!.once("error", reject);
      });
      const token = readFileSync(join(root, "data", "lan-token.txt"), "utf8").trim();
      socket.send(
        JSON.stringify({ v: 1, type: "hello", token, resume: null, capabilities: { dynamicPermissions: true } }),
      );
      const welcome = await inbox.until((frame) => frame.type === "welcome");
      expect(welcome).toMatchObject({ features: { directoryBrowsing: true } });
      let request = 0;
      /** 用同一连接发多个独立请求，覆盖错误后继续浏览。 */
      async function list(path: string): Promise<DirectoryListResultFrame> {
        const requestId = `directory-${++request}`;
        socket!.send(JSON.stringify({ v: 1, type: "directory.list", requestId, path }));
        return (await inbox.until(
          (frame) => frame.type === "directory.result" && frame.requestId === requestId,
        )) as DirectoryListResultFrame;
      }
      expect(await list(browse)).toMatchObject({
        path: resolve(browse),
        parent: dirname(resolve(browse)),
        entries: [
          { name: "alpha", path: join(browse, "alpha") },
          { name: "beta", path: join(browse, "beta") },
        ],
      });
      expect(await list(join(browse, "missing"))).toMatchObject({ error: "not_found" });
      expect(await list(join(browse, "file.txt"))).toMatchObject({ error: "not_directory" });
      expect(await list("bad\u0000path")).toMatchObject({ error: "invalid_path" });
      const roots = await list("");
      expect(roots.error).toBeUndefined();
      expect(roots.entries).toBeDefined();
      if (process.platform === "win32") {
        expect(roots.path).toBe("");
        const drive = roots.entries!.find((entry) => resolve(browse).startsWith(entry.path));
        expect(drive).toBeDefined();
        expect((await list(drive!.path)).parent).toBe("");
      }
      expect(inbox.frames.filter((frame) => frame.type === "session.event")).toEqual([]);
      expect(await list(join(browse, "alpha"))).toMatchObject({ entries: [], parent: resolve(browse) });
    } finally {
      socket?.terminate();
      await app.close();
    }
  }, 20000);
});
