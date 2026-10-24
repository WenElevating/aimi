#!/usr/bin/env node
/**
 * 密钥泄漏扫描（pre-commit 与 push CI 共用的第一道密钥防线）。
 *
 * 口径：只报「高置信度形态」——每条模式都要求赋值/头部的结构语境，
 * 避免把正则字面量、文档示例、CSS 注释误报成密钥（阶段0粗扫的历史误报
 * 形态已固化为测试样本，见 `__tests__/check-secrets.test.ts`）。
 * 扫描范围：`git diff --cached`（pre-commit）或指定文件（CI 传参）的
 * **新增行**——已提交的历史不重扫（那是 gitleaks 全量历史的职责）。
 *
 * 已知取舍：
 * - 高熵随机串不扫（误报率高），只扫结构化形态；熵扫描交给 gitleaks。
 * - 测试文件里的假密钥（明显标注 fake/test/example）放行——通过
 *   `allowlist` 行内标记或文件路径规则（__tests__、fixtures、samples）豁免，
 *   豁免必须显式可审计（看到 ALLOW 才放行），不做静默跳过。
 *
 * 用法：
 *   node tools/check-secrets.mjs            # 扫 git diff --cached 新增行
 *   node tools/check-secrets.mjs <file>...  # 扫指定文件全文（CI 模式）
 * 退出码：0=干净；1=发现疑似密钥（输出命中文件/行号/模式名）；2=用法/环境错误
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * 密钥形态表。`name` 用于输出定位；正则一律不带 g 标志（逐行 test，无 lastIndex 陷阱）。
 * 每条都锚定结构语境（赋值/引号/头部），纯单词出现不命中。
 */
export const SECRET_PATTERNS = [
  { name: "aws-access-key", pattern: /(?:^|[^\w])(AKIA[0-9A-Z]{16})(?:[^\w]|$)/ },
  { name: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // 平台专属模式先于泛化赋值模式判定（先具体后泛化：ghp_/sk-/xoxb 的值同样满足泛化形态）。
  { name: "openai-style-key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "github-pat", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    name: "generic-api-key-assign",
    pattern:
      /(?:api[_-]?key|secret|token|passwd|password|authorization)\S{0,4}\s*[:=]\s*["'']?[A-Za-z0-9+/_-]{24,}["'']?/i,
  },
  { name: "bearer-token", pattern: /Bearer\s+[A-Za-z0-9+/_=.-]{24,}/ },
];

/** 路径豁免：测试样本/夹具目录里的假密钥是测试素材本身，显式放行。 */
const ALLOW_PATH = /(?:^|\/)(?:__tests__|test|fixtures|samples)\/|\.test\.ts$|_test\.dart$|\.test\.mjs$/;

/** 行内显式豁免标记：`aimi-allow-secret`（审计可见，禁止滥用——CR 会查）。 */
const ALLOW_MARKER = "aimi-allow-secret";

/**
 * 判定单行是否命中密钥形态且未被豁免。
 * 拆出来供单测直接驱动（不经过 git/文件系统）——固定样本回归的锚点。
 *
 * @param line - 单行文本（不含行尾换行）
 * @param path - 该行所属文件路径（路径豁免与输出定位用）
 * @returns 命中的模式名；未命中或已豁免为 null
 */
export function matchLine(line, path = "inline") {
  if (line.includes(ALLOW_MARKER)) return null;
  if (ALLOW_PATH.test(path.replaceAll("\\", "/"))) return null;
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(line)) return name;
  }
  return null;
}

/**
 * 从 `git diff --cached` 提取新增行（pre-commit 模式）。
 * 只取 `+` 开头且非 `+++` 头的行，附带文件归属。
 *
 * @returns {Array<{path: string, line: string}>} 新增行清单；无暂存差异为空数组
 */
function stagedAddedLines() {
  const diff = execFileSync("git", ["diff", "--cached", "--unified=0"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const result = [];
  let currentPath = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentPath = line.slice(6);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      result.push({ path: currentPath ?? "?", line: line.slice(1) });
    }
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  let candidates;
  if (args.length === 0) {
    candidates = stagedAddedLines();
  } else {
    // CI 模式：指定文件扫全文（调用方负责圈定范围，如 PR 变更文件集）。
    candidates = [];
    for (const path of args) {
      let content;
      try {
        content = readFileSync(path, "utf8");
      } catch {
        continue; // 文件被删/不可读：跳过（删除不产生新增密钥）
      }
      for (const line of content.split("\n")) candidates.push({ path, line });
    }
  }

  const hits = [];
  for (const { path, line } of candidates) {
    const name = matchLine(line, path);
    if (name !== null) hits.push({ path, name, line: line.trim().slice(0, 120) });
  }

  if (hits.length === 0) {
    console.log("check-secrets: clean");
    return;
  }
  console.error(`check-secrets: 发现 ${hits.length} 处疑似密钥`);
  for (const hit of hits) {
    console.error(`  [${hit.name}] ${hit.path}: ${hit.line}`);
  }
  console.error("如为误报，可在该行添加 aimi-allow-secret 标记（需 CR 审核）。");
  process.exit(1);
}

// 单测（node --test 或 vitest 导入）只消费导出函数；直接运行才进入扫描主流程。
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
  main();
}
