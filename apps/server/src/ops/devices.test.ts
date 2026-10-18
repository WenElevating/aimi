import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../app/config.js";
import { ConfigProvisioner } from "../auth/configProvisioner.js";
import { openMigrated } from "../persistence/sqlite/migrate.js";
import { SqliteAuditRepository, SqliteDeviceRepository } from "../persistence/sqlite/sqliteRepositories.js";
import { PAIRING_TTL_MS } from "../persistence/pairingCode.js";
import { issuePairing, listDevices, revokeDevice } from "./devices.js";
import { lanUrl } from "./health.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 造一份指向临时目录的配置（dataDir/logDir 均落临时目录，互不干扰）。
 *
 * @returns 配置；其临时根目录登记进清理表，由 afterEach 删除
 */
function tmpCfg(): { cfg: ServerConfig; root: string } {
  const root = mkdtempSync(join(tmpdir(), "aimi-devices-"));
  dirs.push(root);
  const cfg: ServerConfig = {
    port: 8787,
    dataDir: join(root, "data"),
    logDir: join(root, "logs"),
    logLevel: "INFO",
    watchdogMs: 600_000, serverVersion: "0.1.0",
  };
  mkdirSync(cfg.dataDir, { recursive: true }); // 测试直开库前先备好目录（与 health.test.ts 同手法）
  return { root, cfg };
}

describe("ops/devices（CLI 直开库形态，沿 health.ts）", () => {
  it("listDevices：投影全量设备行（含已吊销）", async () => {
    const { cfg } = tmpCfg();
    const db = openMigrated(join(cfg.dataDir, "aimi.db"));
    try {
      const devices = new SqliteDeviceRepository(db);
      const lan = await devices.put("lan-default", "a".repeat(64));
      const phone = await devices.put("phone-x", "b".repeat(64));
      await devices.revoke(phone);
      const rows = await listDevices(cfg);
      expect(rows.map((r) => r.id).sort()).toEqual([lan, phone].sort());
      expect(rows.find((r) => r.id === phone)?.revokedAt).not.toBeNull();
      expect(rows.find((r) => r.id === lan)?.revokedAt).toBeNull();
      expect(rows.every((r) => typeof r.lastSeenAt === "number")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("revokeDevice：命中 → ok + revokedAt 落行 + auth.revoke 审计（detail 含 deviceId）", async () => {
    const { cfg } = tmpCfg();
    const db = openMigrated(join(cfg.dataDir, "aimi.db"));
    try {
      const devices = new SqliteDeviceRepository(db);
      const phone = await devices.put("phone-x", "b".repeat(64));

      expect(await revokeDevice(cfg, phone)).toBe("ok");
      expect((await devices.findById(phone))?.revokedAt).not.toBeNull();

      const audits = await new SqliteAuditRepository(db).recent(10);
      const revokeRow = audits.find((a) => a.action === "auth.revoke");
      expect(revokeRow).toBeDefined();
      expect(revokeRow?.detail).toContain(phone);
      expect(revokeRow?.detail).toContain("phone-x");
    } finally {
      db.close();
    }
  });

  it("revokeDevice：未知 id → not_found（无审计行）", async () => {
    const { cfg } = tmpCfg();
    expect(await revokeDevice(cfg, "no-such-device")).toBe("not_found");
    const db = openMigrated(join(cfg.dataDir, "aimi.db"));
    try {
      expect((await new SqliteAuditRepository(db).recent(10)).some((a) => a.action === "auth.revoke")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("revokeDevice：lan-token 系设备 → 同步报废 lan-token.txt（防重启复活）且 detail 注明", async () => {
    const { cfg } = tmpCfg();
    const tokenFile = join(cfg.dataDir, "lan-token.txt");
    const db = openMigrated(join(cfg.dataDir, "aimi.db"));
    try {
      // 经正式供给面建 lan 设备行 + 令牌文件（与运行服务同形态）。
      const lan = await new ConfigProvisioner(new SqliteDeviceRepository(db), tokenFile).ensureLanToken();
      expect(existsSync(tokenFile)).toBe(true);

      expect(await revokeDevice(cfg, lan.deviceId)).toBe("ok");
      expect(existsSync(tokenFile)).toBe(false); // 文件已报废：重启不会复活该设备
      const audits = await new SqliteAuditRepository(db).recent(10);
      const revokeRow = audits.find((a) => a.action === "auth.revoke");
      expect(revokeRow?.detail).toContain("lan-token.txt destroyed");
    } finally {
      db.close();
    }
  });

  it("revokeDevice：非 lan-token 设备 → 令牌文件保留", async () => {
    const { cfg } = tmpCfg();
    const tokenFile = join(cfg.dataDir, "lan-token.txt");
    const db = openMigrated(join(cfg.dataDir, "aimi.db"));
    try {
      await new ConfigProvisioner(new SqliteDeviceRepository(db), tokenFile).ensureLanToken();
      const phone = await new SqliteDeviceRepository(db).put("phone-x", createHash("sha256").update("other").digest("hex"));

      expect(await revokeDevice(cfg, phone)).toBe("ok");
      expect(existsSync(tokenFile)).toBe(true); // 只吊销目标设备，不误伤 LAN 凭证
    } finally {
      db.close();
    }
  });

  it("issuePairing：8 位码 / 5min 有效期 / serverId 稳定复用 / lanUrl 含配置端口", async () => {
    const { cfg } = tmpCfg();
    const first = await issuePairing(cfg);
    expect(first.code).toMatch(/^\d{8}$/);
    const gap = first.expiresAt - Date.now();
    expect(gap).toBeGreaterThan(PAIRING_TTL_MS - 30_000);
    expect(gap).toBeLessThanOrEqual(PAIRING_TTL_MS);
    expect(first.lanUrl).toBe(lanUrl(cfg.port)); // 真实端口以 config 值为准（此处 8787）
    expect(first.lanUrl).toMatch(/:8787$/);

    const second = await issuePairing(cfg);
    expect(second.code).toMatch(/^\d{8}$/);
    expect(second.code).not.toBe(first.code); // 每次独立签发新码
    expect(second.serverId).toBe(first.serverId); // serverId 跨调用（跨进程出码）稳定
    expect(second.serverId).toMatch(/^[0-9a-f-]{36}$/);

    // 码已落库可核销：跨进程共库语义的最低验证。
    const db = openMigrated(join(cfg.dataDir, "aimi.db"));
    try {
      expect(await new SqliteDeviceRepository(db).consumePairingCode(first.code)).toBe("ok");
    } finally {
      db.close();
    }
  });

  it("issuePairing：码与其过期时刻写入 pairing_codes 表（可被服务进程核销）", async () => {
    const { cfg } = tmpCfg();
    const issued = await issuePairing(cfg);
    const db = openMigrated(join(cfg.dataDir, "aimi.db"));
    try {
      const row = db.prepare("SELECT expires_at, used_at FROM pairing_codes WHERE code = ?").get(issued.code) as
        | { expires_at: number; used_at: number | null }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.expires_at).toBe(issued.expiresAt);
      expect(row?.used_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it("lan-token.txt 的哈希与库内 lan 设备行一致（报废判据的契约锚点）", async () => {
    const { cfg } = tmpCfg();
    const db = openMigrated(join(cfg.dataDir, "aimi.db"));
    try {
      const lan = await new ConfigProvisioner(new SqliteDeviceRepository(db), join(cfg.dataDir, "lan-token.txt")).ensureLanToken();
      const onDisk = readFileSync(join(cfg.dataDir, "lan-token.txt"), "utf8").trim();
      expect(onDisk).toBe(lan.token);
      expect(lan.sha256).toBe(createHash("sha256").update(onDisk).digest("hex"));
    } finally {
      db.close();
    }
  });
});
