import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeviceRepository } from "../types.js";
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

/** 两实现必须服务同一契约：tokenSha256 全库唯一。 */
const impls: readonly [string, () => DeviceRepository][] = [
  ["MemoryDeviceRepository", () => new MemoryDeviceRepository()],
  ["SqliteDeviceRepository", () => new SqliteDeviceRepository(db)],
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
  });
}
