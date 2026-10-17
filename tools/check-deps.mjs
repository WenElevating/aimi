#!/usr/bin/env node
/**
 * 依赖方向静态检查：模块之间的依赖必须单向，违规组合在提交前即失败（exit 1）。
 *
 * 本仓库的业务分层，与各层不得触碰的模块（箭头左侧 → 右侧禁止）：
 *   transport/**   → session | agents | events | app                    接入层只搬运数据，不参与业务编排
 *   agents/**      → transport | session                                适配器被编排层调用，反向依赖会成环
 *   events/**      → agents                                             事件总线只认识通用事件，不认识具体 agent
 *   cli/**         → transport | agents | events                        命令行只经应用装配与运维快照
 *   persistence/** → transport | session | agents | events              存储层不反向依赖任何业务模块
 *   audit/**       → transport | session | agents | events | app | auth 审计是横切基础层，只被 import 不 import 人；
 *                                                                       调用方身份以「设备号+名称」结构承接，不依赖鉴权模块
 *   packages/protocol/src/** → 任何 apps/** 相对路径                    协议包必须独立可用，只许依赖 zod
 *
 * 判定范围与规则：
 *   - 扫描 apps/server/src 与 packages/protocol/src 下全部 .ts（跳过 *.test.ts——测试文件不受此约束）；
 *   - 只判定相对导入（import from / 副作用 import / 动态 import）；包名导入（zod、@aimi/protocol 等）不判定；
 *   - 注释里出现的 import 语句会造成误报，扫描前先剥除注释（逐字符状态机可正确跳过字符串与模板字符串）。
 *
 * 用法：node tools/check-deps.mjs   → 全绿 exit 0；存在违规则逐条打印 VIOLATION 并 exit 1。
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（本文件位于 <root>/tools/）。 */
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** 校验目标（源根 → 该源的禁止边表）。 */
const SERVER_SRC = join(REPO_ROOT, "apps", "server", "src");
const PROTOCOL_SRC = join(REPO_ROOT, "packages", "protocol", "src");

/**
 * 审计层的禁止边表（与文件头契约一致，机器可读形态：模块桶 → 禁止到达的模块桶集合）。
 */
const FORBIDDEN_SERVER_EDGES = {
  transport: new Set(["session", "agents", "events", "app"]),
  agents: new Set(["transport", "session"]),
  events: new Set(["agents"]),
  cli: new Set(["transport", "agents", "events"]),
  persistence: new Set(["transport", "session", "agents", "events"]),
  audit: new Set(["transport", "session", "agents", "events", "app", "auth"]),
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
 * 剥除注释，避免注释里出现的 `from "..."` 造成误报。
 * 用逐字符状态机而非正则，以便正确跳过字符串/模板字符串内的注释样文本；
 * 已知局限：正则字面量里的注释样文本会被当作代码处理（本仓库正则字面量不含此类内容）。
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
