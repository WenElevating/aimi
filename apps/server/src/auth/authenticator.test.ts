import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { DefaultAuthenticator } from "./authenticator.js";
import { ConfigProvisioner } from "./configProvisioner.js";
import { AuditWriter } from "../audit/auditWriter.js";
import { MemoryDeviceRepository } from "../persistence/memory/memoryDeviceRepository.js";
import { MemoryAuditRepository } from "../persistence/memory/memoryAuditRepository.js";

// 43 字符真实形态（base64url 32B），遵守计划 T6 修订
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghijklmnopqr";

let dir: string, deviceRepo: MemoryDeviceRepository, auditRepo: MemoryAuditRepository, audit: AuditWriter;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aimi-auth-"));
  deviceRepo = new MemoryDeviceRepository();
  auditRepo = new MemoryAuditRepository();
  await deviceRepo.init(); await auditRepo.init();
  audit = new AuditWriter(auditRepo);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("设备令牌鉴权", () => {
  it("正确 token → DeviceIdentity", async () => {
    const hex = createHash("sha256").update(TOKEN).digest("hex");
    const deviceId = await deviceRepo.put("test-phone", hex);
    const auth = new DefaultAuthenticator(deviceRepo, audit);
    expect(await auth.verifyToken(TOKEN, "192.168.1.7")).toEqual({ deviceId, name: "test-phone" });
  });

  it("假 token → null 且记 auth_fail 审计", async () => {
    const auth = new DefaultAuthenticator(deviceRepo, audit);
    expect(await auth.verifyToken("not-a-real-token-0123456789abcdefghij", "10.0.0.2")).toBeNull();
    const recent = await auditRepo.recent(10);
    expect(recent.some((e) => e.action === "auth.auth_fail" && e.detail.includes("10.0.0.2"))).toBe(true);
  });

  it("吊销后 → null", async () => {
    const hex = createHash("sha256").update(TOKEN).digest("hex");
    const deviceId = await deviceRepo.put("test-phone", hex);
    const auth = new DefaultAuthenticator(deviceRepo, audit);
    await deviceRepo.revoke(deviceId);
    expect(await auth.verifyToken(TOKEN, "lan")).toBeNull();
  });
});

describe("M0 令牌供给（幂等）", () => {
  it("两次 ensureLanToken 返回同一凭证", async () => {
    const tokenFile = join(dir, "lan-token.txt");
    const p = new ConfigProvisioner(deviceRepo, tokenFile);
    const c1 = await p.ensureLanToken();
    const c2 = await p.ensureLanToken();
    expect(c2.token).toBe(c1.token);
    expect(c2.deviceId).toBe(c1.deviceId);
    expect(c1.token.length).toBe(43); // base64url(32B)
  });
});

describe("审计门面", () => {
  it("command 审计：action=command.interrupt，带设备/会话", async () => {
    const w = new AuditWriter(auditRepo);
    await w.command({ cmd: "interrupt" }, { deviceId: "d1", name: "phone" }, "s1");
    const [e] = await auditRepo.recent(1);
    expect(e).toMatchObject({ deviceId: "d1", sessionId: "s1", action: "command.interrupt" });
  });
});
