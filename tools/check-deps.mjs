#!/usr/bin/env node
/**
 * 依赖方向静态检查（设计 §5.2 依赖铁律，Task 17 CI 门）。
 *
 * 契约（禁止 import 边；与 Task 17 简报的禁止边表逐条对应，不多不少）：
 *   transport/**   → session/** | agents/** | events/** | app/**   （接入层不认识核心层）
 *   agents/**      → transport/** | session/**                     （适配器不依赖编排/传输）
 *   events/**      → agents/**                                     （事件总线不懂适配器）
 *   cli/**         → transport/** | agents/** | events/**          （cli 只经 ops/app）
 *   persistence/** → transport/** | session/** | agents/** | events/**（横切层不被核心反向依赖）
 *   packages/protocol/src/** → 任何 apps/** 相对路径               （协议包零内部依赖，只许 zod）
 *
 * 实现：遍历 apps/server/src 与 packages/protocol/src 下的 .ts（跳过 *.test.ts），
 * 抽取相对导入说明符（`import ... from`、`export ... from`、副作用 `import "..."`），
 * 解析到目标文件后映射为首段目录（模块桶），命中禁止边即打印 `VIOLATION:` 并以 1 退出。
 * 非相对导入（node 内建、zod、@aimi/protocol 等包名）与解析到目标根之外者不参与判定。
 *
 * 用法：node tools/check-deps.mjs   → 违规 exit 1，全绿 exit 0。
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（本文件位于 <root>/tools/）。 */
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** 校验目标（源根 → 该源的禁止边表）。 */
const SERVER_SRC = join(REPO_ROOT, "apps", "server", "src");
const PROTOCOL_SRC = join(REPO_ROOT, "packages", "protocol", "src");

/** 禁止的 server 模块桶边（源桶 → 禁止的目标桶集合）。 */
const FORBIDDEN_SERVER_EDGES = {
  transport: new Set(["session", "agents", "events", "app"]),
  agents: new Set(["transport", "session"]),
  events: new Set(["agents"]),
  cli: new Set(["transport", "agents", "events"]),
  persistence: new Set(["transport", "session", "agents", "events"]),
};

/** 递归收集目录下的 .ts 文件（跳过 *.test.ts，测试文件不受依赖方向约束）。 */
function collectTsFiles(dir) {
  const out = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 去除注释，避免注释里出现的 `from "..."` 造成误报。
 * 手写扫描器（非正则）以正确跳过字符串/模板字符串字面量；本仓库正则字面量不含 `//`/`/*`。
 */
function stripComments(source) {
  let out = "";
  let mode = "code"; // code | line | block | string
  let quote = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (mode === "code") {
      if (ch === "/" && next === "/") {
        mode = "line";
        i++;
      } else if (ch === "/" && next === "*") {
        mode = "block";
        i++;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        mode = "string";
        quote = ch;
        out += ch;
      } else {
        out += ch;
      }
    } else if (mode === "line") {
      if (ch === "\n") {
        mode = "code";
        out += ch;
      }
    } else if (mode === "block") {
      if (ch === "*" && next === "/") {
        mode = "code";
        i++;
      } else if (ch === "\n") {
        out += ch; // 保留换行以维持行号可读性
      }
    } else if (mode === "string") {
      out += ch;
      if (ch === "\\") {
        out += source[i + 1] ?? "";
        i++;
      } else if (ch === quote) {
        mode = "code";
      }
    }
  }
  return out;
}

/** 抽取一条语句里的相对导入说明符（from "…"、副作用 import "…"、动态 import("…")）。 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** 从文件内容抽取全部导入说明符。 */
function importSpecifiers(source) {
  const cleaned = stripComments(source);
  const specs = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(cleaned)) !== null) specs.push(match[1]);
  }
  return specs;
}

/** 路径首段（模块桶），如 `transport/ws/lanServer.ts` → `transport`。 */
function firstSegment(relPath) {
  return relPath.split(/[\\/]/)[0] ?? "";
}

/** 相对说明符 → 目标文件绝对路径（`.js` 说明符按 TS NodeNext 习惯映射到同目录 .ts）。 */
function resolveSpecifier(fromFile, specifier) {
  return resolve(dirname(fromFile), specifier);
}

const violations = [];
let scanned = 0;

// ── apps/server/src：模块桶之间的禁止边 ────────────────────────────────────────
for (const file of collectTsFiles(SERVER_SRC)) {
  scanned++;
  const fromBucket = firstSegment(relative(SERVER_SRC, file));
  const forbidden = FORBIDDEN_SERVER_EDGES[fromBucket];
  if (forbidden === undefined) continue;
  for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
    if (!specifier.startsWith(".")) continue;
    const target = resolveSpecifier(file, specifier);
    const rel = relative(SERVER_SRC, target);
    if (rel.startsWith("..")) continue; // 目标在 src 之外（如 @aimi/protocol 源码），不判定
    const toBucket = firstSegment(rel);
    if (forbidden.has(toBucket)) {
      violations.push(
        `VIOLATION: ${relative(REPO_ROOT, file)} imports ${toBucket} (${specifier})`,
      );
    }
  }
}

// ── packages/protocol/src：零 apps/** 相对依赖 ────────────────────────────────
for (const file of collectTsFiles(PROTOCOL_SRC)) {
  scanned++;
  for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
    if (!specifier.startsWith(".")) continue;
    const target = resolveSpecifier(file, specifier);
    const rel = relative(REPO_ROOT, target);
    if (firstSegment(rel) === "apps") {
      violations.push(
        `VIOLATION: ${relative(REPO_ROOT, file)} imports apps/** (${specifier})——协议包只许依赖 zod`,
      );
    }
  }
}

if (violations.length > 0) {
  for (const line of violations) console.error(line);
  console.error(`check-deps: ${violations.length} violation(s) in ${scanned} file(s)`);
  process.exit(1);
}
console.log(`check-deps: ${scanned} file(s) scanned, 0 violations`);
