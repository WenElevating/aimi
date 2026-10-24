import { describe, expect, it } from "vitest";
import { matchLine, SECRET_PATTERNS } from "./check-secrets.mjs";

/**
 * 密钥扫描的固定样本回归（门禁脚本自身的正确性测试——脚本漏报/误报都算门禁失效）。
 * 样本三源：①各模式的真实形态必命中 ②历史误报形态（阶段0粗扫踩过的）必放行
 * ③豁免通道（路径豁免/行内标记）按显式可审计口径放行。
 */
describe("check-secrets matchLine 固定样本", () => {
  it("八类模式各命中真实形态", () => {
    expect(matchLine('aws = "AKIAIOSFODNN7EXAMPLE"')).toBe("aws-access-key");
    expect(matchLine("-----BEGIN RSA PRIVATE KEY-----")).toBe("private-key-block");
    expect(matchLine('const cfg = { apiKey: "AbCdEf123456GhIjKlMnOpQrStUvWxYz" };')).toBe("generic-api-key-assign");
    expect(matchLine("password=hunter2hunter2hunter2hunter2")).toBe("generic-api-key-assign");
    expect(matchLine("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBe("bearer-token");
    expect(matchLine('key = "sk-proj4abcdefghij0123456789"')).toBe("openai-style-key");
    expect(matchLine("token: ghp_0123456789abcdefghijklmnopqrstuvwxyzABCD")).toBe("github-pat");
    expect(matchLine("slack = xoxb-1234567890-abcdef")).toBe("slack-token");
    expect(matchLine('google_api_key = "AIzaSyA0123456789abcdefghijklmnopqrstu1"')).toBe("google-api-key");
  });

  it("历史误报形态必须放行（阶段0粗扫的真实命中）", () => {
    // 正则字面量里的模式词（agentErrorText.ts 的错误分类器）。
    expect(matchLine("pattern: /API Error: 401|authentication_error|invalid x-api-key|Unauthorized/i")).toBeNull();
    // CSS 注释与普通中文说明。
    expect(matchLine("// CSS mask-image——高光字形只在光带内透出")).toBeNull();
    // 临时目录名与普通标识符。
    expect(matchLine('const dir = mkdtempSync(join(tmpdir(), "aimi-task-"));')).toBeNull();
    // 短值/纯单词不构成赋值语境。
    expect(matchLine("const token = undefined;")).toBeNull();
    expect(matchLine("password prompt shown to user")).toBeNull();
  });

  it("豁免通道：__tests__ 路径放行测试素材；aimi-allow-secret 行内标记放行；两者都必须显式", () => {
    expect(matchLine('apiKey: "AbCdEf123456GhIjKlMnOpQrStUvWxYz"', "src/__tests__/sample.test.ts")).toBeNull();
    expect(matchLine('apiKey: "AbCdEf123456GhIjKlMnOpQrStUvWxYz"', "test/data/fixture_sample.dart")).toBeNull();
    expect(matchLine('apiKey: "AbCdEf123456GhIjKlMnOpQrStUvWxYz" // aimi-allow-secret: 假样本')).toBeNull();
    // 豁免不扩大：生产路径同款行必须仍命中。
    expect(matchLine('apiKey: "AbCdEf123456GhIjKlMnOpQrStUvWxYz"', "src/app/application.ts")).toBe(
      "generic-api-key-assign",
    );
  });

  it("模式表非空且全部带 name（防手滑清空表导致静默不扫）", () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(8);
    for (const { name, pattern } of SECRET_PATTERNS) {
      expect(name.length).toBeGreaterThan(0);
      expect(pattern.test("")).toBe(false); // 空行不命中任何模式（防全捕获正则）
    }
  });
});
