#!/usr/bin/env node
/**
 * 仓库洁净检查（PR CI 的 hygiene job 核心）：
 * ① 工作区洁净——测试跑完后 `git status --porcelain` 必须为空（测试不得遗留产物）；
 * ② 变更文件黑名单——PR 变更（相对 merge-base）中不得出现禁止入库的路径/类型
 *    （临时截图、密钥文件、会话工具产物、覆盖率产物等）。
 *
 * 用法：
 *   node tools/check-hygiene.mjs                    # ①+②（②用工作区 HEAD vs @{u} 或 --base）
 *   node tools/check-hygiene.mjs --base origin/main # PR 模式：变更=merge-base...HEAD
 *   node tools/check-hygiene.mjs --skip-status      # 只查②（CI 里 status 检查单独一步跑）
 * 退出码：0=洁净；1=违规（列出明细）
 */
import { execFileSync } from "node:child_process";

/** 禁止入库的模式（路径前缀或文件后缀）；与 .gitignore 互补——防「git add -f 绕过 ignore」。 */
const FORBIDDEN = [
  { pattern: /^\.omx\//, label: "会话工具产物（.omx/）" },
  { pattern: /^\.zcode\//, label: "会话工具产物（.zcode/）" },
  { pattern: /^\.superpowers\//, label: "子代理执行台账（.superpowers/）" },
  { pattern: /^[^/]+\.png$/, label: "根目录平铺截图（正式素材只放 resources/ 或 docs/assets/）" },
  { pattern: /^\.env/, label: "环境变量/密钥文件（.env*）" },
  { pattern: /(^|\/)coverage\//, label: "覆盖率产物（coverage/）" },
  { pattern: /^plugins\/token-speed\//, label: "无关本地插件残留" },
  { pattern: /(^|\/)hs_err_pid.*\.log$/, label: "JVM 崩溃转储" },
];

/** git 输出转文件清单（去空行）。 */
function gitLines(args) {
  const out = execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * 对文件路径清单逐条过黑名单（导出供单测）。
 *
 * @param {string[]} files - 变更文件路径（仓库相对）
 * @returns {{ok: boolean, violations: Array<{path: string, label: string}>}}
 */
export function checkPaths(files) {
  const violations = [];
  for (const path of files) {
    for (const { pattern, label } of FORBIDDEN) {
      if (pattern.test(path)) {
        violations.push({ path, label });
        break; // 一文件一违规即够（首条命中）
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

function main() {
  const args = process.argv.slice(2);
  const skipStatus = args.includes("--skip-status");
  const baseIndex = args.indexOf("--base");
  const base = baseIndex >= 0 ? args[baseIndex + 1] : null;

  let failed = false;

  // ① 工作区洁净（测试/构建不得遗留未跟踪或被修改的文件）。
  if (!skipStatus) {
    const status = gitLines(["status", "--porcelain"]);
    if (status.length > 0) {
      failed = true;
      console.error(`hygiene: 工作区不洁净——测试/构建遗留了 ${status.length} 个未收口文件：`);
      for (const line of status.slice(0, 20)) console.error(`  ${line}`);
      console.error("（应清理产物或把合法产物目录加入 .gitignore）");
    } else {
      console.log("hygiene: 工作区洁净");
    }
  }

  // ② 变更文件黑名单。优先 merge-base...HEAD（PR）；无 base 时退化为暂存区（pre-commit 语义）。
  let files;
  if (base !== null) {
    const mergeBase = execFileSync("git", ["merge-base", base, "HEAD"], { encoding: "utf8" }).trim();
    files = gitLines(["diff", "--name-only", `${mergeBase}...HEAD`]);
  } else {
    files = gitLines(["diff", "--cached", "--name-only"]);
  }
  const { ok, violations } = checkPaths(files);
  if (!ok) {
    failed = true;
    console.error("hygiene: 变更文件命中禁止清单：");
    for (const { path, label } of violations) console.error(`  ${path} ← ${label}`);
  } else {
    console.log(`hygiene: 变更文件 ${files.length} 个，无禁止路径`);
  }

  if (failed) process.exit(1);
}

// 直接运行才进主流程；导出函数供单测驱动。
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
  main();
}
