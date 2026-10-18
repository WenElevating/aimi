import { spawn } from "node:child_process";
import type { Logger } from "../logging/logger.js";
import type { AuditWriter } from "../audit/auditWriter.js";
import type { ProcessLedgerRepository } from "../persistence/types.js";
import { killTree } from "../agents/claude/claudeSession.js";

/**
 * 单进程身份查询上限 5 秒：超时按【查无】处理（弃行不杀）——清点是启动期动作，
 * 宁可放过一个孤儿也不能让启动被一台挂死的 PowerShell 卡住。
 */
const IDENTITY_TIMEOUT_MS = 5000;

/**
 * agent 身份判据：`queryProcessName` 返回的 Name|CommandLine 组合串必须含 "claude"（不区分大小写）。
 * why 查 cmdline 而非镜像名：`shell:true` 拉起时台账登记的是 `cmd.exe` 垫片 pid，镜像名查不到 claude——
 * 只有 cmdline（`cmd.exe /d /s /c "claude ..."` 或 `claude.cmd` 路径）携带着 agent 身份。
 */
const AGENT_IDENTITY = /claude/i;

/**
 * Windows 生产默认的单进程身份查询：PowerShell `Get-CimInstance` 取 `Name` 与 `CommandLine`
 * 并拼成 `Name|CommandLine` 组合串；非 Windows 平台恒返回 null（server 仅承诺 Windows 运行面，
 * 其他平台按"查无"弃行，绝不盲杀）。
 *
 * @param pid - 待查进程号
 * @returns Promise，resolve 为组合串；查无/超时/查询自错均返回 `null`（不抛）
 */
async function queryWindowsAgentProcess(pid: number): Promise<string | null> {
  if (process.platform !== "win32") return null;
  return new Promise<string | null>((resolve) => {
    let out = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => { finish(null); }, IDENTITY_TIMEOUT_MS);
    let child;
    try {
      child = spawn("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        `Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}' |` +
          ` ForEach-Object { '{0}|{1}' -f $_.Name, $_.CommandLine }`,
      ], { windowsHide: true });
    } catch {
      finish(null);
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", () => { /* 排空防背压；身份查询不消费 stderr */ });
    child.on("error", () => { finish(null); });
    child.stdout.on("data", (chunk: string) => { out += chunk; });
    child.on("close", (code) => {
      const line = out.trim().split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
      finish(code === 0 && line !== "" ? line : null);
    });
  });
}

/**
 * server 启动期孤儿清点（core-loop §5.1 F5 防线收口）：台账 pid 无主则终止。
 *
 * 流程：全量台账行 → 逐行**先验身份**（Name|CommandLine 含 "claude"）→ 命中才 kill（防 pid 复用误杀）
 * → **无论命中与否都清台账行**（落库滞留的行本就无人持有，清点是"复认"而非"挂账"）。
 * 命中计数只统计真正终止的行；审计仅在 `reaped>0` 时写一条 `session.orphan_reaped`（无命中无现场，不写空记录）。
 *
 * why 允许 `queryProcessName/kill` 注入：Windows pid 会复用，身份判定与终止都必须可在测试面替换。
 *
 * @param deps.ledger - 进程台账（会话登记/撤销与其同源）
 * @param deps.queryProcessName - 单进程身份查询；缺省为 Windows PowerShell 实现（查无名串含 claude 才杀）
 * @param deps.kill - 终止动作；缺省 `killTree(pid)`（`shell:true` 拉起下必须树杀，Windows 忽略信号参数）
 * @param deps.log - 可选日志门面：命中记 info、弃行记 warn；缺省静默
 * @param deps.audit - 可选审计门面：`reaped>0` 时写 `session.orphan_reaped`；缺省不落审计
 * @returns Promise，resolve 为本次真正终止的条数
 * @throws `ledger.list()` 抛出的原始错误（台账不可读属数据面故障，调用方自行决定是否拦截启动）
 * 副作用：可能终止 agent 子进程树、按行清台账、可选写审计
 */
export async function reapOrphans(deps: {
  ledger: ProcessLedgerRepository;
  queryProcessName?: (pid: number) => Promise<string | null>;
  kill?: (pid: number) => void;
  log?: Logger;
  audit?: AuditWriter;
}): Promise<number> {
  const rows = await deps.ledger.list();
  const query = deps.queryProcessName ?? queryWindowsAgentProcess;
  const kill = deps.kill ?? ((pid: number) => { killTree(pid); });
  const reapedPids: number[] = [];
  for (const row of rows) {
    const identity = await query(row.pid).catch(() => null); // 查询自错与查无同态：弃行不杀
    if (identity !== null && AGENT_IDENTITY.test(identity)) {
      try {
        kill(row.pid);
      } catch (err) {
        deps.log?.warn("orphan kill failed", { sessionId: row.sessionId, pid: row.pid, error: String(err) });
      }
      reapedPids.push(row.pid);
      deps.log?.info("orphan reaped", { sessionId: row.sessionId, pid: row.pid, identity });
    } else {
      deps.log?.warn("orphan ledger row skipped（pid 身份不匹配或已退出，宁可放过不误杀）", {
        sessionId: row.sessionId,
        pid: row.pid,
      });
    }
    await deps.ledger.clear(row.sessionId); // 滞留行清点后一律撤销：下轮启动不再重访
  }
  if (reapedPids.length > 0) {
    await deps.audit?.orphanReaped(JSON.stringify({ count: reapedPids.length, pids: reapedPids }));
  }
  return reapedPids.length;
}
