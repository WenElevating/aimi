import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { LanWsServer } from "./lanServer.js";

let server: LanWsServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("LanWsServer（WS 监听 + HTTP 请求回调）", () => {
  it("WS 升级握手仍工作：onConnection 收到 conveyor，request 回调不被触发", async () => {
    server = new LanWsServer({ port: 0 });
    const port = await server.listen();
    let connections = 0;
    server.onConnection(() => { connections += 1; });
    let httpHits = 0;
    server.onRequest(() => { httpHits += 1; });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    expect(connections).toBe(1);
    expect(httpHits).toBe(0); // 升级请求不进 request 回调
    ws.close();
  });

  it("普通 HTTP GET 进入 onRequest 回调；回调可写响应体", async () => {
    server = new LanWsServer({ port: 0 });
    const port = await server.listen();
    server.onRequest((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("aimi-update");
    });

    const res = await fetch(`http://127.0.0.1:${port}/updates/app-2.apk`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("aimi-update");
  });

  it("未注册 onRequest 时普通请求一律 404", async () => {
    server = new LanWsServer({ port: 0 });
    const port = await server.listen();

    const res = await fetch(`http://127.0.0.1:${port}/anything`);
    expect(res.status).toBe(404);
  });

  it("onRequest 单槽覆盖：重复注册只保留最后注册者", async () => {
    server = new LanWsServer({ port: 0 });
    const port = await server.listen();
    server.onRequest((_req, res) => { res.writeHead(500); res.end(); });
    server.onRequest((_req, res) => { res.writeHead(200); res.end("second"); });

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("second");
  });

  it("close() 后端口拒绝新连接（HTTP 与 WS 都不可达）", async () => {
    const s = new LanWsServer({ port: 0 });
    const port = await s.listen();
    s.onRequest((_req, res) => { res.writeHead(200); res.end(); });
    await fetch(`http://127.0.0.1:${port}/`); // 先确认可达
    await s.close();

    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });
});
