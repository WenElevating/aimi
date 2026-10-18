import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { LanWsServer } from "./lanServer.js";

describe("LAN WS 传输（Conveyor 契约）", () => {
  it("连接→双向帧→关闭回调", async () => {
    const server = new LanWsServer({ port: 0 });
    const conns: import("../conveyor.js").Conveyor[] = [];
    server.onConnection((c) => conns.push(c));
    const port = await server.listen();

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((res) => client.once("open", res));
    expect(conns).toHaveLength(1);
    expect(conns[0]!.state).toBe("open");

    const frames: unknown[] = [];
    conns[0]!.onFrame((raw) => frames.push(raw));
    const closed = new Promise<string>((res) => conns[0]!.onClose(res));

    // 手机到 server：原始帧透传（本层不做帧解析）
    client.send(JSON.stringify({ v: 1, type: "hello", token: "abcd1234efgh", resume: null }));
    await new Promise((res) => setTimeout(res, 50));
    expect(frames).toEqual([{ v: 1, type: "hello", token: "abcd1234efgh", resume: null }]);

    // server 到手机：send 序列化为单条 JSON 消息
    conns[0]!.send({ v: 1, type: "welcome", serverVersion: "0.1.0", sessions: [] });
    const msg = await new Promise<any>((res) =>
      client.once("message", (d) => res(JSON.parse(String(d)))),
    );
    expect(msg).toEqual({ v: 1, type: "welcome", serverVersion: "0.1.0", sessions: [] });

    // 关闭：onClose 回调带 reason
    client.close(1000, "client bye");
    expect(typeof (await closed)).toBe("string");

    await server.close();
    expect(conns[0]!.state).toBe("closed");
  });

  it("closed 后 send 静默丢弃（不抛）", async () => {
    const server = new LanWsServer({ port: 0 });
    let conn: import("../conveyor.js").Conveyor | undefined;
    server.onConnection((c) => (conn = c));
    const port = await server.listen();
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((res) => client.once("open", res));
    await conn!.close("test");
    expect(() => conn!.send({ v: 1, type: "pong", nonce: 1 })).not.toThrow();
    await server.close();
  });
});
