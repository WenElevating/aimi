import { describe, expect, it } from "vitest";
import { PAYLOAD_CAP, parseClientFrame, parseServerFrame } from "../zodFrames.js";

describe("M0 协议契约（冻结线）", () => {
  it("hello 帧必须带 token", () => {
    expect(parseClientFrame({ v: 1, type: "hello", token: "abcd1234efgh", resume: null })).toMatchObject({ type: "hello" });
    expect(parseClientFrame({ v: 1, type: "hello" })).toBeNull();
  });

  it("session.create 必须拒绝手机升权 permissionMode", () => {
    const f = parseClientFrame({
      v: 1, type: "session.create",
      spec: { agentId: "claude", cwd: "D:/work", permissionMode: "danger-off" },
    });
    expect(f).toBeNull(); // permissionMode 越权取值必须被拒：手机不能申请更高权限
  });

  it("session.event 服务帧往返", () => {
    const raw = {
      v: 1, type: "session.event", sessionId: "s1", seq: 3, ts: 1729142400000,
      agentEvent: { type: "text_delta", text: "hello" },
    };
    expect(parseServerFrame(raw)).toEqual(raw);
  });

  it("未知帧类型一律 null（防协议漂移）", () => {
    expect(parseClientFrame({ v: 1, type: "hocus.pocus" })).toBeNull();
  });

  it("合法 session.create（permissionMode=default）必须通过", () => {
    const f = parseClientFrame({
      v: 1, type: "session.create",
      spec: { agentId: "claude", cwd: "D:/work", permissionMode: "default" },
    });
    expect(f).not.toBeNull();
    if (f !== null && f.type === "session.create") expect(f.spec.permissionMode).toBe("default");
  });

  it("error 帧 code 必须在冻结枚举内", () => {
    expect(parseServerFrame({ v: 1, type: "error", code: "nonsense.code", message: "x" })).toBeNull();
    expect(parseServerFrame({ v: 1, type: "error", code: "session.not_found", message: "x" })).not.toBeNull();
  });

  it("server 侧未知帧类型一律 null（防协议漂移）", () => {
    expect(parseServerFrame({ v: 1, type: "hocus.pocus" })).toBeNull();
  });

  it("text_delta 8192+标记 载荷可解析（契约与 eventFlood 截断同源）", () => {
    // 截断产物 = 前 8192 字符 + "…(truncated)"，总宽恰为 PAYLOAD_CAP，必须被解析放行。
    const text = "x".repeat(8192) + "…(truncated)";
    const raw = {
      v: 1, type: "session.event", sessionId: "s1", seq: 0, ts: 1,
      agentEvent: { type: "text_delta", text },
    };
    expect(text.length).toBe(PAYLOAD_CAP);
    expect(parseServerFrame(raw)).not.toBeNull();
    // 略超上限则仍 null（契约上限 = 8192 + 标记宽，严出不变）。
    expect(parseServerFrame({ ...raw, agentEvent: { type: "text_delta", text: text + "x" } })).toBeNull();
  });
});
