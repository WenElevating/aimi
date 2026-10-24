import { describe, expect, it } from "vitest";
import { friendlyAgentError, isKnownAgentError } from "./agentErrorText.js";

/** 已知错误分类映射（真实反馈/联调踩过的形态逐条回归；未匹配原样返回不吞未知错误）。 */
describe("agentErrorText 已知错误友好化", () => {
  it.each([
    // Windows 提交内存耗尽（2026-10-24 真实反馈原文）。
    [
      "Claude Code process exited with code 1. stderr: error: Failed to start HTTP Client thread: 页面文件太小，无法完成操作。 (os error 1455)",
      "电脑内存不足",
    ],
    [
      "The paging file is too small for this operation to be completed (os error 1455)",
      "电脑内存不足",
    ],
    // 崩溃码（Windows 栈溢出，另一真实形态）。
    ["Claude Code process exited with code 3221226505", "电脑内存不足"],
    // 令牌分组限制（403 合成回复）。
    [
      "Failed to authenticate. API Error: 403 当前令牌无权访问所选分组，请在控制台重新选择分组或联系客服 (request id: x)",
      "无访问权限",
    ],
    // 认证失败。
    ["API Error: 401 invalid x-api-key", "令牌无效"],
    // 限流。
    ["API Error: 429 rate_limit_error", "频繁"],
    // 网络。
    ["fetch failed: ECONNREFUSED 127.0.0.1:443", "网络连接失败"],
    // 组件缺失。
    ["Error: ENOENT: no such file or directory, open 'cli.js'", "组件不可用"],
  ])("已知错误 → 友好文案：%s", (raw, keyword) => {
    expect(isKnownAgentError(raw)).toBe(true);
    expect(friendlyAgentError(raw)).toContain(keyword);
  });

  it("未匹配的错误原样返回（不吞未知错误）；空串同样透传", () => {
    const raw = "some brand new failure mode xyz";
    expect(friendlyAgentError(raw)).toBe(raw);
    expect(isKnownAgentError(raw)).toBe(false);
    expect(friendlyAgentError("")).toBe("");
  });
});
