#!/usr/bin/env node
/**
 * pre-push 门禁（预算 ≤60s）：typecheck + 依赖方向 + 受影响测试。
 *
 * 受影响测试口径（用户约定）：基于 `git diff @{u}...HEAD` 的**推送范围**，不是暂存区——
 * 推送是把本地若干提交一起交出去，检查面必须与推送内容一致。取推送范围内变更的
 * `.ts` 生产/测试文件，用 `vitest related` 按依赖图跑关联用例。
 *
 * 超时熔断（用户约定文案）：任一步超过 60s 视为「检查未完成，降级为仅 CI 验证」，
 * 退出码 0 放行推送——但必须显式输出降级提示（不静默放行）；CI 是完整兜底。
 * 任何一步**非超时失败**（类型错误/lint/测试红）即刻退出码 1 阻断推送。
 */
import { execFileSync, spawnSync } from "node:child_process";

const BUDGET_MS = 60_000;

/** 带预算的同步执行：超时 kill 并返回 `{ timedOut: true }`；正常结束返回退出码。 */
function runWithBudget(cmd, args) {
  const started = Date.now();
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: BUDGET_MS - (Date.now() - started),
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error && result.error.code === "ETIMEDOUT") {
    return { timedOut: true, code: null, output: "" };
  }
  return {
    timedOut: false,
    code: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    elapsed: Date.now() - started,
  };
}

/**
 * 推送范围（@{u}...HEAD）内变更的文件清单。
 * 无 upstream（首次推送/独立分支）时退化为 `HEAD~1...HEAD`（至少覆盖本次推送的最后一个提交）；
 * git 命令失败一律抛错由 main 统一按降级处理——**绝不因脚本自身异常阻断推送**（CI 兜底）。
 */
function pushedChangedFiles() {
  let range;
  try {
    range = execFileSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .concat("...HEAD");
  } catch {
    range = "HEAD~1...HEAD";
  }
  const out = execFileSync("git", ["diff", "--name-only", range], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.split("\n").filter((line) => line.trim() !== "");
}

function main() {
  // 第 1 步：typecheck（全仓约 20s，最大头）。
  const typecheck = runWithBudget("pnpm", ["typecheck"]);
  if (typecheck.timedOut) {
    console.log("pre-push: typecheck 超时——检查未完成，降级为仅 CI 验证。");
    return;
  }
  if (typecheck.code !== 0) {
    console.error(typecheck.output);
    console.error("pre-push: typecheck 失败，推送已阻断。");
    process.exit(1);
  }

  // 第 2 步：依赖方向静态检查（秒级）。
  const deps = runWithBudget("node", ["tools/check-deps.mjs"]);
  if (deps.timedOut) {
    console.log("pre-push: check-deps 超时——检查未完成，降级为仅 CI 验证。");
    return;
  }
  if (deps.code !== 0) {
    console.error(deps.output);
    console.error("pre-push: 依赖方向检查失败，推送已阻断。");
    process.exit(1);
  }

  // 第 3 步：受影响测试（推送范围的 .ts 变更 → vitest related）。
  const changed = pushedChangedFiles().filter((f) => /\.ts$/.test(f));
  if (changed.length === 0) {
    console.log(`pre-push: clean（typecheck ${typecheck.elapsed}ms + deps ${deps.elapsed}ms，无相关测试）`);
    return;
  }
  const related = runWithBudget("pnpm", ["exec", "vitest", "related", "--no-file-parallelism", "run", ...changed]);
  if (related.timedOut) {
    console.log("pre-push: 受影响测试超时——检查未完成，降级为仅 CI 验证。");
    return;
  }
  if (related.code !== 0) {
    console.error(related.output);
    console.error("pre-push: 受影响测试失败，推送已阻断。");
    process.exit(1);
  }
  console.log(
    `pre-push: ok（typecheck ${typecheck.elapsed}ms + deps ${deps.elapsed}ms + related ${related.elapsed}ms）`,
  );
}

main();
