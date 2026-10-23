import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateFeed, apkFileNameOf, diskUpdateManifest } from "./updateFeed.js";

let dir: string;
let http: Server | null = null;
const servers: Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
});

afterAll(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

/** 造一个临时数据目录与 UpdateFeed（verifyToken 可控、onChanged 记账）。 */
function makeFeed(opts?: { tokenOk?: boolean }) {
  dir = join(tmpdir(), `aimi-update-feed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const changed: (number | null)[] = [];
  const feed = new UpdateFeed({
    dataDir: dir,
    verifyToken: async () => (opts?.tokenOk === false ? null : { deviceId: "dev-1", name: "手机" }),
    onChanged: (latest) => { changed.push(latest?.versionCode ?? null); },
  });
  return { feed, changed };
}

/** 把 feed 的 HTTP 面挂到真实端口上（127.0.0.1 随机端口）。 */
async function serve(feed: UpdateFeed): Promise<number> {
  const server = createServer((req, res) => { void feed.handleRequest(req, res); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("未取得测试端口");
  return addr.port;
}

/** 写一份合法磁盘清单与对应假 APK。 */
async function publishFixture(feed: UpdateFeed, versionCode: number, body: string): Promise<void> {
  const updates = join(feed.updatesDir);
  await mkdir(updates, { recursive: true });
  await writeFile(join(updates, apkFileNameOf(versionCode)), body, "utf8");
  await writeFile(join(updates, "manifest.json"), JSON.stringify(diskUpdateManifest.parse({
    versionName: `1.0.${versionCode}`,
    versionCode,
    size: Buffer.byteLength(body),
    sha256: "a".repeat(64),
    downloadPath: `/updates/${apkFileNameOf(versionCode)}`,
    publishedAt: 1,
  })), "utf8");
}

describe("UpdateFeed（发布清单缓存）", () => {
  it("refresh 读到清单：缓存生效、投影剔除 publishedAt、onChanged 触发一次", async () => {
    const { feed, changed } = makeFeed();
    await publishFixture(feed, 2, "apk-bytes");
    const latest = await feed.refresh();
    expect(latest?.versionCode).toBe(2);
    expect(latest).not.toHaveProperty("publishedAt");
    expect(feed.current()?.versionCode).toBe(2);
    await feed.refresh(); // 版本未变：不重复触发
    expect(changed).toEqual([2]);
  });

  it("清单缺失/损坏一律降级 null 不抛出", async () => {
    const { feed } = makeFeed();
    expect(await feed.refresh()).toBeNull();
    await mkdir(feed.updatesDir, { recursive: true });
    await writeFile(join(feed.updatesDir, "manifest.json"), "{not-json", "utf8");
    expect(await feed.refresh()).toBeNull();
  });

  it("清单从有到无（versionCode 消失）也触发 onChanged", async () => {
    const { feed, changed } = makeFeed();
    await publishFixture(feed, 3, "x");
    await feed.refresh();
    const { rm } = await import("node:fs/promises");
    await rm(join(feed.updatesDir, "manifest.json"));
    await feed.refresh();
    expect(changed).toEqual([3, null]);
  });
});

describe("UpdateFeed HTTP 面", () => {
  it("GET /updates/{file}?token=ok：200 回 APK 字节与 Content-Length", async () => {
    const { feed } = makeFeed();
    await publishFixture(feed, 2, "apk-body-2");
    await feed.refresh();
    const port = await serve(feed);
    const res = await fetch(`http://127.0.0.1:${port}/updates/app-2.apk?token=valid-token`, {});
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.android.package-archive");
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength("apk-body-2")));
    expect(await res.text()).toBe("apk-body-2");
  });

  it("token 校验失败 401；文件不在当前清单 404；路径穿越 404；未知路径 404", async () => {
    const { feed } = makeFeed({ tokenOk: false });
    await publishFixture(feed, 2, "apk-body-2");
    await feed.refresh();
    const port = await serve(feed);
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/updates/app-2.apk?token=bad`)).status).toBe(401);
    expect((await fetch(`${base}/updates/app-9.apk?token=valid`)).status).toBe(404);
    expect((await fetch(`${base}/updates/..%2Fmanifest.json?token=valid`)).status).toBe(404);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  it("POST /internal/updates/refresh：本机来源 200、触发重读并回 versionCode", async () => {
    const { feed, changed } = makeFeed();
    const port = await serve(feed);
    // 初始无清单：refresh 为 null 且不触发 onChanged（无→无不算变化）。
    await feed.refresh();
    expect(changed).toEqual([]);
    await publishFixture(feed, 5, "apk-body-5");
    const res = await fetch(`http://127.0.0.1:${port}/internal/updates/refresh`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ versionCode: 5 });
    expect(feed.current()?.versionCode).toBe(5);
    expect(changed).toEqual([5]);
  });

  it("GET 不触发 refresh 端点（只认 POST）", async () => {
    const { feed, changed } = makeFeed();
    const port = await serve(feed);
    expect((await fetch(`http://127.0.0.1:${port}/internal/updates/refresh`)).status).toBe(404);
    expect(changed).toEqual([]);
  });
});
