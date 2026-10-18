import { describe, expect, it } from "vitest";
import { reapOrphans } from "./processReaper.js";
import { AuditWriter } from "../audit/auditWriter.js";
import { MemoryAuditRepository } from "../persistence/memory/memoryAuditRepository.js";
import { MemoryProcessLedgerRepository } from "../persistence/memory/memoryProcessLedgerRepository.js";

/**
 * 装配一组最容易读清的孤儿：两行台账（claude 形态 / 无关形态）+ 收杀记录。
 *
 * @returns 内存台账、已收杀 pid 序列、审计仓储（三者互相独立，供单用例按需装配）
 */
function reaper(): { ledger: MemoryProcessLedgerRepository; killed: number[]; auditRepo: MemoryAuditRepository } {
  const ledger = new MemoryProcessLedgerRepository();
  const killed: number[] = [];
  const auditRepo = new MemoryAuditRepository();
  return { ledger, killed, auditRepo };
}

describe("reapOrphans（孤儿清点：先验身份后终止，滞留行一律清）", () => {
  it("命中行被终止并计数，无关行弃杀但台账统一清空；审计恰一条带 pids", async () => {
    const { ledger, killed, auditRepo } = reaper();
    await ledger.init();
    await ledger.register("s-alive", 101);
    await ledger.register("s-foreign", 202);
    const reaped = await reapOrphans({
      ledger,
      queryProcessName: (pid) =>
        Promise.resolve(pid === 101
          ? "cmd.exe|cmd.exe /d /s /c \"claude --print --output-format stream-json\""
          : "explorer.exe|explorer.exe"),
      kill: (pid) => { killed.push(pid); },
      audit: new AuditWriter(auditRepo),
    });
    expect(reaped).toBe(1);                       // 只有 claude 形态那行算命中
    expect(killed).toEqual([101]);                // 无关进程绝不误杀（pid 复用防线）
    expect(await ledger.list()).toEqual([]);      // 滞留行无论命中与否一律清点撤销
    const rows = await auditRepo.recent(10);
    expect(rows.map((r) => r.action)).toEqual(["session.orphan_reaped"]);
    expect(JSON.parse(rows[0]!.detail ?? "{}")).toEqual({ count: 1, pids: [101] });
  });

  it("查无（进程已退 / 五秒超时）→ 弃杀但清行，reaped=0 无审计", async () => {
    const { ledger, killed, auditRepo } = reaper();
    await ledger.init();
    await ledger.register("s-gone", 303);
    const reaped = await reapOrphans({
      ledger,
      queryProcessName: () => Promise.resolve(null),
      kill: (pid) => { killed.push(pid); },
      audit: new AuditWriter(auditRepo),
    });
    expect(reaped).toBe(0);
    expect(killed).toEqual([]);                   // 查无名串即不该杀：宁可放过不误杀
    expect(await ledger.list()).toEqual([]);      // 弃杀的行仍要清点，不掛下轮重访
    expect(await auditRepo.recent(10)).toEqual([]); // 无命中无现场：不写空审计
  });

  it("查询自错与查无同态；空台账直接返回 0 不触碰身份查询", async () => {
    const { ledger, killed, auditRepo } = reaper();
    await ledger.init();
    await ledger.register("s-hang", 404);
    const reaped = await reapOrphans({
      ledger,
      queryProcessName: () => Promise.reject(new Error("powershell hung")),
      kill: (pid) => { killed.push(pid); },
      audit: new AuditWriter(auditRepo),
    });
    expect(reaped).toBe(0);
    expect(killed).toEqual([]);
    expect(await ledger.list()).toEqual([]);
    // 空台账：list 即空 → 逐行身份查询不应被触发（query 抛错与否都到不了）。
    let queried = 0;
    const empty = await reapOrphans({
      ledger,
      queryProcessName: () => { queried += 1; return Promise.resolve(null); },
      kill: (pid) => { killed.push(pid); },
      audit: new AuditWriter(auditRepo),
    });
    expect(empty).toBe(0);
    expect(queried).toBe(0);
    expect(killed).toEqual([]);
  });
});
