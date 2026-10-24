import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeedbackChannel } from "./feedbackChannel.js";

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 造数据目录与 FeedbackChannel（verifyToken 可控、onAccepted 记账、真端口 HTTP 面）。 */
function make(opts?: { tokenOk?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "aimi-feedback-"));
  dirs.push(root);
  const dataDir = join(root, "data");
  const accepted: { deviceId: string; id: string }[] = [];
  const channel = new FeedbackChannel({
    dataDir,
    verifyToken: async () => (opts?.tokenOk === false ? null : { deviceId: "dev-1", name: "手机" }),
    onAccepted: async (deviceId, id) => {
      accepted.push({ deviceId, id });
    },
  });
  const server = createServer((req, res) => {
    void channel.handleRequest(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("fallback");
      }
    });
  });
  servers.push(server);
  const portP = new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(addr === null || typeof addr === "string" ? 0 : addr.port);
    });
  });
  return { channel, dataDir, accepted, portP };
}

/** 组一份合法提交体（图片可选）。 */
function payload(images: { name: string; b64: string }[] = [], logZipB64?: string): string {
  return JSON.stringify({
    desc: "界面卡死",
    app: { version: "1.0.8", build: "9", platform: "Android 16" },
    ...(logZipB64 === undefined ? {} : { logZipB64 }),
    ...(images.length === 0 ? {} : { images }),
  });
}

const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");
const ZIP_B64 = Buffer.from([0x50, 0x4b, 3, 4, 1, 2]).toString("base64");

describe("FeedbackChannel（POST /feedback）", () => {
  it("合法提交：201 回 id，落盘 meta.json/log.zip/images，onAccepted 触发", async () => {
    const { dataDir, accepted, portP } = make();
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/feedback`, {
      method: "POST",
      headers: { "x-aimi-token": "token-12345678" },
      body: payload(
        [
          { name: "截图一.jpg", b64: JPEG_B64 },
          { name: "shot.png", b64: PNG_B64 },
        ],
        ZIP_B64,
      ),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);

    const dir = join(dataDir, "feedback", id);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as {
      id: string;
      deviceId: string;
      desc: string;
      images: { originalName: string; file: string }[];
      hasLog: boolean;
    };
    expect(meta.id).toBe(id);
    expect(meta.deviceId).toBe("dev-1");
    expect(meta.desc).toBe("界面卡死");
    expect(meta.hasLog).toBe(true);
    expect(meta.images).toHaveLength(2);
    // 文件名随机编号、扩展名按 magic bytes 归一（不保留原始名）。
    expect(meta.images[0]?.file).toBe("images/00.jpg");
    expect(meta.images[1]?.file).toBe("images/01.png");
    expect(existsSync(join(dir, "log.zip"))).toBe(true);
    expect(existsSync(join(dir, "images", "00.jpg"))).toBe(true);
    expect(existsSync(join(dir, "images", "01.png"))).toBe(true);
    expect(accepted).toEqual([{ deviceId: "dev-1", id }]);
  });

  it("鉴权：错 token 401；无 header 401", async () => {
    const { portP } = make({ tokenOk: false });
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/feedback`, {
      method: "POST",
      headers: { "x-aimi-token": "wrong-token-0" },
      body: payload(),
    });
    expect(res.status).toBe(401);
    const res2 = await fetch(`http://127.0.0.1:${port}/feedback`, { method: "POST", body: payload() });
    expect(res2.status).toBe(401);
  });

  it("契约：超长 desc/空 desc/坏 JSON/坏图片 magic bytes 一律 400", async () => {
    const { portP } = make();
    const port = await portP;
    const headers = { "x-aimi-token": "token-12345678" };
    const post = (body: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/feedback`, { method: "POST", headers, body });

    expect((await post(JSON.stringify({ desc: "", app: { version: "1", build: "1", platform: "p" } }))).status).toBe(400);
    expect((await post(JSON.stringify({ desc: "长".repeat(4001), app: { version: "1", build: "1", platform: "p" } }))).status).toBe(400);
    expect((await post("not-json")).status).toBe(400);
    // 图片扩展名伪装：内容不是合法图片头。
    const fake = Buffer.from("not-an-image").toString("base64");
    expect((await post(payload([{ name: "x.jpg", b64: fake }]))).status).toBe(400);
  });

  it("非 POST 一律 404（GET 不开放查询面）", async () => {
    const { portP } = make();
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/feedback`, { headers: { "x-aimi-token": "token-12345678" } });
    expect(res.status).toBe(404);
  });

  it("路径不归本通道时返回 false（组合分发的契约）", async () => {
    const { channel } = make();
    const handled = await channel.handleRequest(
      { url: "/updates/app-2.apk", method: "GET", headers: {}, socket: { remoteAddress: "127.0.0.1" } } as never,
      { writeHead: (): void => {}, end: (): void => {}, destroy: (): void => {} } as never,
    );
    expect(handled).toBe(false);
  });

  it("限流：同设备 1 小时窗口内第 7 条 429（用 7 个独立实例共享记账面不可行——直接验证计数行为）", async () => {
    // 限流记账在 channel 实例内存中：一个实例连发 7 条验证。
    const { channel, portP, accepted } = make();
    const port = await portP;
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/feedback`, {
        method: "POST",
        headers: { "x-aimi-token": "token-12345678" },
        body: payload([], ZIP_B64),
      });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 201)).toHaveLength(6);
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
    expect(accepted).toHaveLength(6);
    expect(channel.feedbackDir).toContain("feedback");
  });
});
