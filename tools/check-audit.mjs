#!/usr/bin/env node
/**
 * 依赖漏洞审计（pnpm audit 的门禁包装）：
 * 仅 high/critical 阻塞（用户约定）；moderate/low 只提示。
 * 豁免清单 `tools/audit-exemptions.json`：每条 `{ id, package, reason, expires }`——
 * **过期条目自动视为未豁免**（输出 ERROR 并按未豁免参与判定），到期即自动恢复阻塞。
 *
 * 用法：node tools/check-audit.mjs [--all]（--all 含 devDependencies，夜间全量用）
 * 退出码：0=无未豁免的 high/critical；1=有；2=环境错误
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const EXEMPTIONS_PATH = join(ROOT, "audit-exemptions.json");

/**
 * 判定一条漏洞是否被有效豁免（导出供单测）。
 * 无效豁免（过期/包名不匹配/理由缺失）返回 false——宁可误报不可漏放。
 *
 * @param {{id: string, moduleName: string}} vuln - pnpm audit JSON 的一条 advisory
 * @param {Array<{id: number|string, package: string, reason: string, expires: string}>} exemptions - 豁免清单
 * @param {Date} now - 当前时刻（测试注入）
 * @returns {{exempt: boolean, reason: string}} reason 说明豁免/拒绝原因（输出可审计）
 */
export function isExempt(vuln, exemptions, now = new Date()) {
  const entry = exemptions.find((item) => String(item.id) === String(vuln.id) && item.package === vuln.moduleName);
  if (entry === undefined) return { exempt: false, reason: "不在豁免清单" };
  if (!entry.reason || entry.reason.trim() === "") return { exempt: false, reason: "豁免缺 reason" };
  const expires = new Date(entry.expires);
  if (Number.isNaN(expires.getTime())) return { exempt: false, reason: "豁免 expires 非法日期" };
  if (expires.getTime() < now.getTime()) return { exempt: false, reason: `豁免已过期（${entry.expires}）` };
  return { exempt: true, reason: `豁免至 ${entry.expires}：${entry.reason}` };
}

/** 从 pnpm audit JSON 提取 high/critical 条目。 */
function criticalOf(auditJson) {
  const advisories = auditJson.advisories ?? {};
  return Object.values(advisories).filter((item) => item.severity === "high" || item.severity === "critical");
}

function main() {
  const includeAll = process.argv.includes("--all");
  let raw;
  try {
    const args = ["audit", "--json"];
    if (includeAll) args.push("--dev"); // pnpm audit 默认只报 prod；--dev 补齐 dev（--all 语义）
    raw = execFileSync("pnpm", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === "win32",
    });
  } catch (err) {
    // pnpm audit 发现漏洞时以非零退出——输出仍是 JSON，照常解析。
    raw = err.stdout ?? "";
    if (raw.trim() === "") {
      console.error("check-audit: pnpm audit 执行失败", err.stderr ?? err.message);
      process.exit(2);
    }
  }
  let audit;
  try {
    audit = JSON.parse(raw);
  } catch {
    console.error("check-audit: audit 输出不是合法 JSON（pnpm 版本变更？）");
    process.exit(2);
  }

  const exemptions = existsSync(EXEMPTIONS_PATH) ? JSON.parse(readFileSync(EXEMPTIONS_PATH, "utf8")) : [];
  const critical = criticalOf(audit);
  if (critical.length === 0) {
    console.log("check-audit: ok（无 high/critical 漏洞）");
    return;
  }

  let blocking = 0;
  for (const vuln of critical) {
    const verdict = isExempt(vuln, exemptions);
    if (verdict.exempt) {
      console.log(`  [EXEMPT] ${vuln.moduleName} ${vuln.id}（${verdict.reason}）`);
    } else {
      blocking += 1;
      console.error(
        `  [BLOCK] ${vuln.severity} ${vuln.moduleName} ${vuln.id}: ${vuln.title ?? ""}（${verdict.reason}）`,
      );
    }
  }
  if (blocking > 0) {
    console.error(
      `check-audit: ${blocking} 条未豁免的 high/critical 漏洞——升级依赖或在 audit-exemptions.json 登记（带到期日与理由，CR 审核）。`,
    );
    process.exit(1);
  }
  console.log("check-audit: ok（high/critical 均已豁免，豁免过期会自动恢复阻塞）");
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
  main();
}
