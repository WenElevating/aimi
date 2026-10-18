import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { LanWsServer } from "./lanServer.js";
import { createClientSideConveyor } from "./messagePipe.js";

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

describe("客户端侧 Conveyor（createClientSideConveyor——与 server 侧共用同一收发核）", () => {
  it("socket 已 open 前提下创建：state=open，JSON 交付为对象、非 JSON 文本帧原样交付，close 语义对齐", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    const port = (wss.address() as { port: number }).port;

    let conveyor: import("../conveyor.js").Conveyor | undefined;
    // 拨入回调时序的等价形态：connection 事件里 socket 必已 open，此刻按客户端口径包装。
    wss.on("connection", (socket) => {
      conveyor = createClientSideConveyor(socket, "relay");
    });
    const peer = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((res) => peer.once("open", res));
    expect(conveyor).toBeDefined();
    expect(conveyor!.state).toBe("open"); // open 前提：初值即 open（dial 落定后才创建）
    await expect(conveyor!.open()).resolves.toBeUndefined(); // 幂等 no-op

    // conveyor→peer：send 序列化为单条 JSON 文本帧。
    const messages: any[] = [];
    peer.on("message", (d) => messages.push(JSON.parse(String(d))));
    conveyor!.send({ v: 1, type: "pong", nonce: 7 });
    await new Promise((res) => setTimeout(res, 50));
    expect(messages).toEqual([{ v: 1, type: "pong", nonce: 7 }]);

    // peer→conveyor：JSON 交付为对象；非 JSON 文本帧原样以字符串交付（本层不做帧校验）。
    const frames: unknown[] = [];
    conveyor!.onFrame((raw) => frames.push(raw));
    peer.send(JSON.stringify({ a: 1 }));
    await new Promise((res) => setTimeout(res, 30));
    expect(frames).toEqual([{ a: 1 }]);
    peer.send("not-json");
    await new Promise((res) => setTimeout(res, 30));
    expect(frames).toEqual([{ a: 1 }, "not-json"]);

    // close 语义：对端 close 帧的 reason 回填 onClose；state 落终态；closed 后 send 静默丢弃。
    const closed = new Promise<string>((res) => conveyor!.onClose(res));
    peer.close(1000, "relay bye");
    expect(await closed).toBe("relay bye");
    expect(conveyor!.state).toBe("closed");
    expect(() => conveyor!.send({ v: 1, type: "pong", nonce: 1 })).not.toThrow();

    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
});
