#!/usr/bin/env node
/**
 * 覆盖率棘轮 + 增量检查（PR CI 的 coverage job 核心）。
 *
 * 两条硬规则（用户约定）：
 * ① 全局棘轮——各套件 lines% 与 `tools/coverage-baseline.json` 对比，
 *    任何下降直接失败（退出码 1），只升不降；上调必须单独 commit（CR 审核）。
 * ② 增量阈值——PR diff（相对目标分支）新增/修改行的覆盖率：
 *    server/protocol ≥80%，mobile ≥60%（mobile 每季度 +5 棘轮爬升，见 baseline）。
 *    CI 中目标分支 baseline 取 **merge-base（目标分支）的 baseline.json**（用户约定 ③），
 *    防止 PR 内偷改 baseline 放行自己。
 *
 * baseline 的 `effectiveFrom`（mobile 季度爬升到期日）已过期时输出 WARN 提醒
 * 维护者上调（不阻塞）；到期自动开 issue 由夜间 job 的 check-baseline-expiry 负责。
 *
 * 用法：
 *   node tools/check-coverage.mjs --lcov server=apps/server/coverage/lcov.info [...]
 *        [--base-origin main] [--diff-base main]
 *   本地快速模式：不传 --diff-base 时跳过增量检查（无 PR 语境）。
 * 退出码：0=通过；1=任一规则失败
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(ROOT, "coverage-baseline.json");
/** 仓库根目录名（动态取真实值——本地可能是 D:\AiProject 也可能是别的名字）。 */
const REPO_ROOT_NAME = basename(dirname(ROOT));

/**
 * 解析 lcov.info：按 SF 文件聚合 DA 行命中，返回 { totalLines, hitLines, byFile: Map<path, {total, hit}> }。
 *
 * @param {string} text - lcov.info 全文
 * @param {string} [packagePrefix] - 包根前缀（如 `apps/mobile`）。Flutter 工具链的
 *   lcov SF 是**包相对**路径（`lib/app/theme.dart`），不补全则永远对不上 git diff
 *   的仓库相对路径（`apps/mobile/lib/...`），增量覆盖会恒为 0%。绝对路径不受影响。
 */
export function parseLcov(text, packagePrefix = "") {
  const byFile = new Map();
  let current = null;
  let total = 0;
  let hit = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      current = normalizePath(resolveSourcePath(line.slice(3), packagePrefix));
      if (!byFile.has(current)) byFile.set(current, { total: 0, hit: 0, da: new Map() });
    } else if (line.startsWith("DA:")) {
      // DA:<行号>,<命中次数>
      const [lineNo, count] = line.slice(3).split(",");
      const number_ = Number(lineNo);
      total += 1;
      const hits = Number(count) > 0 ? 1 : 0;
      hit += hits;
      if (current !== null) {
        const entry = byFile.get(current) ?? { total: 0, hit: 0, da: new Map() };
        entry.da.set(number_, hits);
        byFile.set(current, entry);
      }
    } else if (line.startsWith("end_of_record")) {
      if (current !== null) {
        const entry = byFile.get(current) ?? { total, hit, da: new Map() };
        entry.total = total;
        entry.hit = hit;
        byFile.set(current, entry);
      }
      current = null;
      total = 0;
      hit = 0;
    }
  }
  return { byFile };
}

/**
 * 把 lcov 的 SF 原始路径解析成可交给 normalizePath 的形态。
 * 绝对路径原样返回（normalizePath 走仓库根锚点）；相对路径（Flutter 的
 * `lib/...`，相对包根而非仓库根）按包根前缀补全，已带前缀的不重复拼接。
 *
 * @param {string} raw - SF: 行的原始路径（可能含 Windows 反斜杠）
 * @param {string} packagePrefix - 包根前缀（如 `apps/mobile`），空串表示不补全
 */
function resolveSourcePath(raw, packagePrefix) {
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("/");
  if (!isAbsolute && packagePrefix !== "") {
    const normalizedRaw = raw.replaceAll("\\", "/");
    const normalizedPrefix = packagePrefix.replaceAll("\\", "/").replace(/\/+$/, "");
    if (!normalizedRaw.startsWith(`${normalizedPrefix}/`)) {
      return join(normalizedPrefix, normalizedRaw);
    }
  }
  return raw;
}

/**
 * 路径规范化：Windows 反斜杠 → 正斜杠，经仓库根锚点剥到仓库相对路径（diff 对账用）。
 * lcov 的 SF 常是绝对路径（`D:/AiProject/aimi/apps/...`），git diff 是仓库相对
 * （`apps/...`）——以 `/<repoRoot>/` 为锚点取其后半段（比剥固定层级健壮：仓库
 * 可以放在任意父目录下）；已是仓库相对的路径无锚点，原样返回。
 */
export function normalizePath(p) {
  const normalized = p.replaceAll("\\", "/").replace(/^[A-Za-z]:\//, "");
  const anchor = `/${REPO_ROOT_NAME}/`;
  const index = normalized.indexOf(anchor);
  if (index >= 0) return normalized.slice(index + anchor.length);
  // 无锚点：可能是仓库相对路径，或「仓库根名开头」（`aimi/apps/...` 形态）。
  if (normalized.startsWith(`${REPO_ROOT_NAME}/`)) return normalized.slice(REPO_ROOT_NAME.length + 1);
  return normalized;
}

/** 数值格式化：四舍五入到 0.1。 */
export function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * 全局棘轮检查：各套件实测 lines% ≥ baseline。
 *
 * @param {Record<string, {lines: number}>} measured - 套件名 → 实测行覆盖
 * @param {object} baseline - baseline.json 解析结果
 * @returns {{ok: boolean, failures: string[], warnings: string[]}}
 */
export function checkRatchet(measured, baseline) {
  const failures = [];
  const warnings = [];
  for (const [suite, data] of Object.entries(measured)) {
    // suite 来自 Object.entries 键（非外部输入），但 security 规则要求显式收口——
    // 只允许 baseline.suites 已登记的键进入索引。
    const base =
      Object.values(baseline.suites).find((entry) => entry !== null && typeof entry === "object") &&
      suite in baseline.suites
        ? Reflect.get(baseline.suites, suite)
        : undefined;
    if (base === undefined) {
      warnings.push(`baseline 中无套件 ${suite} 的条目——跳过棘轮（请把新套件登记进 baseline）`);
      continue;
    }
    if (data.lines < base.lines) {
      failures.push(`${suite}: 全局行覆盖 ${data.lines}% < 基线 ${base.lines}%（棘轮只升不降）`);
    }
    if (base.effectiveFrom !== undefined && base.effectiveFrom !== null) {
      const due = new Date(base.effectiveFrom);
      if (!Number.isNaN(due.getTime()) && due.getTime() < Date.now()) {
        warnings.push(`${suite}: 爬升到期日 ${base.effectiveFrom} 已过——请按 ramp 规则上调 baseline（单独 commit）`);
      }
    }
  }
  return { ok: failures.length === 0, failures, warnings };
}

/**
 * 增量覆盖率检查：PR 变更行（相对 merge-base）中生产源码行的命中比例。
 *
 * @param {string} diffText - `git diff <base>...HEAD --unified=0` 的全文
 * @param {Map<string, {total: number, hit: number}>} byFile - lcov 按文件覆盖
 * @param {string} suite - 套件名（决定阈值与生产文件过滤器）
 * @param {object} baseline - baseline.json 解析结果
 * @returns {{ok: boolean, message: string}|{skipped: true, reason: string}}
 */
export function checkIncremental(diffText, byFile, suite, baseline) {
  const incrementalTable = baseline.incremental ?? {};
  const threshold =
    (suite in incrementalTable ? Reflect.get(incrementalTable, suite) : undefined) ??
    Reflect.get(incrementalTable, "default") ??
    80;
  // 生产源码过滤：后缀按套件 + 排除测试文件（.test.ts / _test.dart——测试行不计入增量分母）。
  const prodFilter = suite === "mobile" ? /lib\/.*\.dart$/ : /src\/.*\.ts$/;
  const isTestFile = suite === "mobile" ? /_test\.dart$/ : /\.test\.ts$/;
  const coverageRoot =
    suite === "server"
      ? "apps/server/src/"
      : suite === "protocol"
        ? "packages/protocol/src/"
        : suite === "mobile"
          ? "apps/mobile/lib/"
          : "";
  const addedByFile = new Map();
  let currentPath = null;
  let currentNewLine = 0;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      currentPath = normalizePath(raw.slice(6));
    } else if (raw.startsWith("@@")) {
      // @@ -l,c +l,c @@：新文件起始行。注意 /\+(\d+)/ 会先命中头部的「-1,3 +1,6」中
      // `+1`——语义正确（新侧起始行就是第一个 +数字）；但 hunk 头里 `@@ -0,0 +1,3` 的
      // 第一个 +数字同样是新侧起点，无歧义。
      const match = /\+(\d+)/.exec(raw.replace(/^-[^+]*/, ""));
      currentNewLine = match === null ? 0 : Number(match[1]);
    } else if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (
        currentPath !== null &&
        prodFilter.test(currentPath) &&
        !isTestFile.test(currentPath) &&
        currentPath.startsWith(coverageRoot)
      ) {
        const entry = addedByFile.get(currentPath) ?? [];
        entry.push(currentNewLine);
        addedByFile.set(currentPath, entry);
      }
      currentNewLine += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      // 删除行不影响新行计数
    } else if (raw.startsWith(" ")) {
      currentNewLine += 1;
    }
  }

  let covered = 0;
  let totalAdded = 0;
  const uncoveredSamples = [];
  for (const [path, lines] of addedByFile) {
    const lcov = byFile.get(path);
    for (const lineNo of lines) {
      // 文件不在 lcov（未被任何测试加载）→ 该行必然未覆盖。
      if (lcov === undefined) {
        totalAdded += 1;
        if (uncoveredSamples.length < 10) uncoveredSamples.push(`${path}:${lineNo}`);
        continue;
      }
      // 文件在 lcov 但该行无 DA 明细 → 不可归属行（声明/const 等编译期求值行），
      // Dart 工具链输出稀疏，不占分母——把「无记录」当「未覆盖」会把增量覆盖率
      // 压到远低于真实值（PR #7 实测：同批代码 0 DA 行占了新增行的近半）。
      const detail = lcov.da?.get(lineNo);
      if (detail === undefined) continue;
      totalAdded += 1;
      if (detail > 0) {
        covered += 1;
      } else if (uncoveredSamples.length < 10) {
        uncoveredSamples.push(`${path}:${lineNo}`);
      }
    }
  }
  if (totalAdded === 0) {
    return { ok: true, message: `${suite}: 无新增生产代码行，增量检查跳过` };
  }
  const percent = round1((covered * 100) / totalAdded);
  const ok = percent >= threshold;
  const message = `${suite}: 增量行覆盖 ${covered}/${totalAdded} = ${percent}%（阈值 ${threshold}%）${ok ? "" : `\n  未覆盖样例: ${uncoveredSamples.join(", ")}`}`;
  return { ok, message };
}

/** 主流程：解析参数 → 读 baseline（可选取目标分支版本）→ 棘轮 → 增量。 */
function main() {
  const args = process.argv.slice(2);
  const lcovArgs = [];
  let baseRef = null;
  let diffBase = null;
  // 参数解析：数组动态索引触发 security 规则——改用迭代器消费。
  const argQueue = [...args];
  for (let arg = argQueue.shift(); arg !== undefined; arg = argQueue.shift()) {
    if (arg === "--lcov") {
      const value = argQueue.shift();
      if (value !== undefined) lcovArgs.push(value);
    } else if (arg === "--base-origin") {
      baseRef = argQueue.shift() ?? baseRef; // 目标分支（PR 场景 = origin/main），baseline 以它为准
    } else if (arg === "--diff-base") {
      diffBase = argQueue.shift() ?? diffBase; // diff 基准（merge-base）
    }
  }

  // baseline：PR 中取目标分支版本（防 PR 偷改放行）；本地取工作区版本。
  let baseline;
  if (baseRef !== null) {
    const text = execFileSync("git", ["show", `${baseRef}:tools/coverage-baseline.json`], { encoding: "utf8" });
    baseline = JSON.parse(text);
  } else {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  }

  const measured = {};
  const KNOWN_SUITES = ["server", "protocol", "mobile"];
  const mergedByFile = new Map();
  for (const spec of lcovArgs) {
    const [suite, path] = spec.split("=", 2);
    if (!existsSync(path)) {
      console.error(`check-coverage: 找不到 ${suite} 的 lcov 输出 ${path}`);
      process.exit(2);
    }
    const parsed = parseLcov(
      readFileSync(path, "utf8"),
      // 包根 = lcov 路径上两级（`apps/mobile/coverage/lcov.info` → `apps/mobile`），
      // 用于补全 Flutter 工具链的包相对 SF 路径。先归一化成仓库相对形态：
      // 传入绝对路径时（`/work/aimi/apps/mobile/...`）才能与 diff 对账口径一致。
      normalizePath(join(dirname(dirname(path)))),
    );
    let total = 0;
    let hit = 0;
    for (const [file, entry] of parsed.byFile) {
      total += entry.total;
      hit += entry.hit;
      mergedByFile.set(file, entry);
    }
    if (total > 0 && KNOWN_SUITES.includes(suite)) Reflect.set(measured, suite, { lines: round1((hit * 100) / total) });
  }

  const ratchet = checkRatchet(measured, baseline);
  for (const warning of ratchet.warnings) console.warn(`WARN: ${warning}`);
  if (!ratchet.ok) {
    console.error("check-coverage: 全局棘轮检查失败");
    for (const failure of ratchet.failures) console.error(`  ${failure}`);
  }

  const incrementalResults = [];
  if (diffBase !== null) {
    for (const suite of Object.keys(measured)) {
      // 键已收敛为 KNOWN_SUITES 子集
      const diffText = execFileSync("git", ["diff", `${diffBase}...HEAD`, "--unified=0"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      const result = checkIncremental(diffText, mergedByFile, suite, baseline);
      if (!result.skipped) {
        incrementalResults.push(result);
        console.log(result.message);
        if (!result.ok) ratchet.ok = false;
      }
    }
  }

  if (!ratchet.ok) process.exit(1);
  console.log(
    `check-coverage: ok（${Object.entries(measured)
      .map(([s, m]) => `${s} ${m.lines}%`)
      .join(", ")}）`,
  );
}

// 直接运行才进主流程；导出函数供单测驱动。
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
  main();
}
