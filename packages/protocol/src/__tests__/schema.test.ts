import { describe, expect, it } from "vitest";
import { BYE_REVOKED, BYE_TAKEN_OVER } from "../frames.js";
import { PAYLOAD_CAP, parseClientFrame, parseServerFrame } from "../zodFrames.js";

describe("M0 协议契约（冻结线）", () => {
  it("接受 command.ack 回执帧", () => {
    const raw = {
      v: 1, type: "command.ack", sessionId: "s1", clientId: "client-123", status: "delivered",
    };
    expect(parseServerFrame(raw)).toEqual(raw);
  });

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

describe("M1 协议扩展：hello 重放光标", () => {
  const TOKEN = "abcd1234efgh";

  it("旧形态 hello（resume:null）仍通过（M0 客户端兼容硬约束）", () => {
    const raw = { v: 1, type: "hello", token: TOKEN, resume: null };
    expect(parseClientFrame(raw)).toEqual(raw);
  });

  it("resume 光标 map 通过（会话 id → 已见最大 seq）", () => {
    const raw = { v: 1, type: "hello", token: TOKEN, resume: { "sess-1": 42, "sess-2": 0 } };
    expect(parseClientFrame(raw)).toEqual(raw);
  });

  it("resume 空 map 放行（= 无任何会话光标，全量拉基线——Task 5 重放语义的显式契约）", () => {
    // why：防止未来给 zod record 加 .min(1) 类收紧时把全新安装的"全量拉"静默打断——此处留钉报警。
    const raw = { v: 1, type: "hello", token: TOKEN, resume: {} };
    expect(parseClientFrame(raw)).toEqual(raw);
  });

  it("resume 非法值拒（负数/非整数/嵌套非数字）", () => {
    // 负 seq 无意义：seq 从 0 起非负
    expect(parseClientFrame({ v: 1, type: "hello", token: TOKEN, resume: { "s": -1 } })).toBeNull();
    // seq 必须整数：1.5 无法对位事件序号
    expect(parseClientFrame({ v: 1, type: "hello", token: TOKEN, resume: { "s": 1.5 } })).toBeNull();
    // 嵌套对象不是数字 seq
    expect(parseClientFrame({ v: 1, type: "hello", token: TOKEN, resume: { "s": { "x": 1 } } })).toBeNull();
  });

  it("hello 两种变体都接受权限能力声明", () => {
    const capabilities = { permissionModes: ["default", "plan", "acceptEdits", "bypassPermissions"] };
    expect(parseClientFrame({ v: 1, type: "hello", token: TOKEN, resume: null, capabilities })).toMatchObject({ capabilities });
    expect(parseClientFrame({ v: 1, type: "hello", pairingCode: "12345678", deviceName: "手机", capabilities })).toMatchObject({ capabilities });
    expect(parseClientFrame({ v: 1, type: "hello", token: TOKEN, resume: null, capabilities: { permissionModes: ["danger"] } })).toBeNull();
  });
});

describe("M1 协议扩展：hello 配对变体", () => {
  it("配对变体通过（同 type 字面量、按字段区分）", () => {
    const raw = { v: 1, type: "hello", pairingCode: "12345678", deviceName: "我的手机" };
    expect(parseClientFrame(raw)).toEqual(raw);
  });

  it("配对变体失败形拒", () => {
    // 7 位数字：位数不足
    expect(parseClientFrame({ v: 1, type: "hello", pairingCode: "1234567", deviceName: "手机" })).toBeNull();
    // 含非数字字符
    expect(parseClientFrame({ v: 1, type: "hello", pairingCode: "1234a678", deviceName: "手机" })).toBeNull();
    // 缺 deviceName
    expect(parseClientFrame({ v: 1, type: "hello", pairingCode: "12345678" })).toBeNull();
    // deviceName 超长（>64）
    expect(parseClientFrame({ v: 1, type: "hello", pairingCode: "12345678", deviceName: "d".repeat(65) })).toBeNull();
    // deviceName 空（1..64 小端被拒）
    expect(parseClientFrame({ v: 1, type: "hello", pairingCode: "12345678", deviceName: "" })).toBeNull();
  });
});

describe("M1 协议扩展：paired 帧 / sessionMeta.resumable / 新错误码", () => {
  it("paired 帧通过契约（明文 token 一次性下发）", () => {
    const raw = { v: 1, type: "paired", token: "tok-0123456789abcdef", deviceId: "dev-1" };
    expect(parseServerFrame(raw)).toEqual(raw);
  });

  it("welcome 的 sessions 项缺 resumable 必须拒（M1 必填字段，不做 optional）", () => {
    const base = {
      id: "s1", agentId: "claude", cwd: "C:/w", permissionMode: "default",
      state: "running", lastSeq: 3, createdAt: 1, updatedAt: 2,
    };
    expect(parseServerFrame({ v: 1, type: "welcome", serverVersion: "x", sessions: [base] })).toBeNull();
    expect(parseServerFrame({ v: 1, type: "welcome", serverVersion: "x", sessions: [{ ...base, resumable: false }] })).not.toBeNull();
  });

  it("error 帧白名单含 auth.pairing_failed", () => {
    expect(parseServerFrame({ v: 1, type: "error", code: "auth.pairing_failed", message: "配对失败" })).not.toBeNull();
  });

  it("session meta 接受可选 model 与四档权限", () => {
    const base = {
      id: "s1", agentId: "claude", cwd: "C:/w", permissionMode: "bypassPermissions",
      model: "opus", state: "running", lastSeq: 3, createdAt: 1, updatedAt: 2, resumable: false,
    };
    expect(parseServerFrame({ v: 1, type: "welcome", serverVersion: "x", sessions: [base] })).not.toBeNull();
  });
});

describe("M1 协议扩展：configure", () => {
  it("接受模型与权限 configure 命令", () => {
    expect(parseClientFrame({
      v: 1, type: "session.command", sessionId: "s1", clientId: "client-123",
      cmd: { cmd: "configure", model: "opus", permissionMode: "acceptEdits" },
    })).not.toBeNull();
  });
});

describe("M1 协议扩展：bye 理由常量", () => {
  it("canonical 取值以常量单一源导出", () => {
    expect(BYE_TAKEN_OVER).toBe("taken_over");
    expect(BYE_REVOKED).toBe("revoked");
  });
});

describe("M2 协议扩展：update.check / update.info 帧", () => {
  it("update.check 无载荷直接通过", () => {
    const raw = { v: 1, type: "update.check" };
    expect(parseClientFrame(raw)).toEqual(raw);
  });

  it("update.info 带 latest 完整往返", () => {
    const raw = {
      v: 1, type: "update.info",
      latest: {
        versionName: "1.0.1", versionCode: 2, size: 52428800,
        sha256: "a".repeat(64), downloadPath: "/updates/app-2.apk", notes: "修复若干问题",
      },
    };
    expect(parseServerFrame(raw)).toEqual(raw);
  });

  it("update.info latest 为 null 通过（服务端从未发布过）", () => {
    const raw = { v: 1, type: "update.info", latest: null };
    expect(parseServerFrame(raw)).toEqual(raw);
  });

  it("update.info latest 非法形拒（sha256/downloadPath/versionCode 约束）", () => {
    const base = {
      versionName: "1.0.1", versionCode: 2, size: 1,
      sha256: "a".repeat(64), downloadPath: "/updates/app-2.apk",
    };
    // sha256 非 64 位小写 hex
    expect(parseServerFrame({ v: 1, type: "update.info", latest: { ...base, sha256: "XYZ" } })).toBeNull();
    // downloadPath 必须以 "/" 开头（相对路径契约，手机按 WS host 自行拼 URL）
    expect(parseServerFrame({ v: 1, type: "update.info", latest: { ...base, downloadPath: "updates/app-2.apk" } })).toBeNull();
    // versionCode 必须正整数（0 与 1.5 都无意义）
    expect(parseServerFrame({ v: 1, type: "update.info", latest: { ...base, versionCode: 0 } })).toBeNull();
    expect(parseServerFrame({ v: 1, type: "update.info", latest: { ...base, versionCode: 1.5 } })).toBeNull();
  });

  it("update.info 缺 latest 字段拒（必须显式 null 表达「无发布」）", () => {
    expect(parseServerFrame({ v: 1, type: "update.info" })).toBeNull();
  });
});
