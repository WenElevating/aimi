import { describe, expect, it } from "vitest";
import { parseClientFrame, parseServerFrame } from "../zodFrames.js";

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
    expect(f).toBeNull(); // 设计 C3：手机不可传未知/越权模式
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
});
