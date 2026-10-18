import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeviceRepository } from "../types.js";
import { PAIRING_TTL_MS } from "../pairingCode.js";
import { MemoryDeviceRepository } from "../memory/memoryDeviceRepository.js";
import { openMigrated } from "./migrate.js";
import { SqliteDeviceRepository } from "./sqliteRepositories.js";

/** 真实形态令牌哈希：SHA-256 十六进制 64 字符。 */
const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aimi-device-"));
  db = openMigrated(join(dir, "devices.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 测试注入口：`now`=可控时钟（markSeen/配对期限断言）；`code`=stub 码源（UNIQUE 碰撞重试路径）。 */
interface DeviceRepoOpts {
  readonly now?: () => number;
  readonly code?: () => string;
}

/** 两实现必须服务同一契约：tokenSha256 全库唯一 + M1 设备投影/配对码（跨生产与内存形态）。 */
const impls: readonly [string, (opts?: DeviceRepoOpts) => DeviceRepository][] = [
  ["MemoryDeviceRepository", (opts) => new MemoryDeviceRepository(opts)],
  ["SqliteDeviceRepository", (opts) => new SqliteDeviceRepository(db, opts)],
];

for (const [label, make] of impls) {
  describe(`DeviceRepository 契约（${label}）`, () => {
    it("同一 tokenSha256 重复 put 抛错（唯一性由实现保证，而非调用方自律）", async () => {
      const repo = make();
      await repo.init();
      await repo.put("phone", TOKEN_A);
      await expect(repo.put("phone-clone", TOKEN_A)).rejects.toThrow(/device token already registered/);
      await repo.close();
    });

    it("不同 tokenSha256 各自独立 id，findByTokenHash 均命中", async () => {
      const repo = make();
      await repo.init();
      const idA = await repo.put("phone-a", TOKEN_A);
      const idB = await repo.put("phone-b", TOKEN_B);
      expect(idA).not.toBe(idB);
      expect(await repo.findByTokenHash(TOKEN_A)).toEqual({ id: idA, name: "phone-a" });
      expect(await repo.findByTokenHash(TOKEN_B)).toEqual({ id: idB, name: "phone-b" });
      await repo.close();
    });

    it("markSeen 前进 lastSeenAt（注入时钟），未知 id 静默 no-op", async () => {
      let t = 1_000;
      const repo = make({ now: () => t });
      await repo.init();
      const id = await repo.put("phone", TOKEN_A);
      t = 2_000;
      await repo.markSeen(id);
      expect((await repo.list())[0]!.lastSeenAt).toBe(2_000);
      await repo.markSeen("no-such-device");
      expect(await repo.list()).toHaveLength(1);
      await repo.close();
    });

    it("findById 观测投影：活设备 revokedAt=null、吊销后非 null（不隐藏吊销——吊销巡检要读）", async () => {
      const repo = make();
      await repo.init();
      const id = await repo.put("phone", TOKEN_A);
      expect(await repo.findById(id)).toEqual({ id, name: "phone", revokedAt: null });
      await repo.revoke(id);
      const seen = await repo.findById(id);
      expect(seen).not.toBeNull();
      expect(seen!.name).toBe("phone");
      expect(seen!.revokedAt).not.toBeNull();
      expect(await repo.findById("missing")).toBeNull();
      await repo.close();
    });

    it("list() 每行补 revokedAt（吊销前 null、吊销后非 null）", async () => {
      const repo = make();
      await repo.init();
      const id = await repo.put("phone", TOKEN_A);
      expect(await repo.list()).toEqual([{ id, name: "phone", lastSeenAt: expect.any(Number), revokedAt: null }]);
      await repo.revoke(id);
      expect((await repo.list())[0]!.revokedAt).not.toBeNull();
      await repo.close();
    });

    it("issuePairingCode：8 位数字、expiresAt=now+PAIRING_TTL_MS", async () => {
      let t = 7_000_000;
      const repo = make({ now: () => t });
      await repo.init();
      const { code, expiresAt } = await repo.issuePairingCode();
      expect(code).toMatch(/^\d{8}$/);
      expect(expiresAt).toBe(t + PAIRING_TTL_MS);
      await repo.close();
    });

    it("连发多码共存：各自独立、逐个核销均 ok（不互相顶掉）", async () => {
      let t = 1_000;
      const repo = make({ now: () => t });
      await repo.init();
      const issued = [await repo.issuePairingCode(), await repo.issuePairingCode(), await repo.issuePairingCode()];
      expect(new Set(issued.map((c) => c.code)).size).toBe(3);
      for (const { code } of issued) {
        expect(await repo.consumePairingCode(code, { now: () => t })).toBe("ok");
      }
      await repo.close();
    });

    it("UNIQUE 碰撞重试：stub 同码两发，重试收敛出可用新码", async () => {
      const seq = ["12345678", "12345678", "87654321"];
      let t = 1_000;
      const repo = make({ now: () => t, code: () => seq.shift()! });
      await repo.init();
      expect((await repo.issuePairingCode()).code).toBe("12345678");
      // 第二发前两个 attempt 与已登记码相撞，第三次尝试（2 次重试内）写入新码
      expect((await repo.issuePairingCode()).code).toBe("87654321");
      expect(await repo.consumePairingCode("12345678", { now: () => t })).toBe("ok");
      expect(await repo.consumePairingCode("87654321", { now: () => t })).toBe("ok");
      await repo.close();
    });

    it("碰撞重试耗尽即抛（约束兜底，不做无限循环）", async () => {
      let t = 1_000;
      const repo = make({ now: () => t, code: () => "11111111" });
      await repo.init();
      await repo.issuePairingCode();
      await expect(repo.issuePairingCode()).rejects.toThrow(/pairing code collision/);
      await repo.close();
    });

    it("consume 之 unknown：库里无此码", async () => {
      const repo = make();
      await repo.init();
      expect(await repo.consumePairingCode("00000000")).toBe("unknown");
      await repo.close();
    });

    it("consume ok→used：双核销第二次返回 used（固定 now 注入的并发判据）", async () => {
      let t = 1_000;
      const repo = make({ now: () => t });
      await repo.init();
      const { code } = await repo.issuePairingCode();
      t = 2_000;
      expect(await repo.consumePairingCode(code, { now: () => t })).toBe("ok");
      expect(await repo.consumePairingCode(code, { now: () => t })).toBe("used");
      await repo.close();
    });

    it("consume expired：expires_at 当刻严格失效、前一毫秒仍 ok", async () => {
      let t = 1_000;
      const repo = make({ now: () => t });
      await repo.init();
      const { code } = await repo.issuePairingCode();
      expect(await repo.consumePairingCode(code, { now: () => t + PAIRING_TTL_MS })).toBe("expired");
      expect(await repo.consumePairingCode(code, { now: () => t + PAIRING_TTL_MS - 1 })).toBe("ok");
      await repo.close();
    });

    it("consume 已 used 的码过期后仍报 used（状态预判序：used 先于 expired）", async () => {
      let t = 1_000;
      const repo = make({ now: () => t });
      await repo.init();
      const { code } = await repo.issuePairingCode();
      await repo.consumePairingCode(code, { now: () => t });
      t += PAIRING_TTL_MS;
      expect(await repo.consumePairingCode(code, { now: () => t })).toBe("used");
      await repo.close();
    });
  });
}
