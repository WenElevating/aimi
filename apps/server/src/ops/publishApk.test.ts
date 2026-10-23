import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { publishApk } from "./publishApk.js";
import type { ServerConfig } from "../app/config.js";

const cleanups: string[] = [];

afterAll(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 造配置 + 假 APK 源文件（内容任意——显式版本参数时不解析 APK）。 */
function fixture(apkBody: string): { cfg: ServerConfig; apkPath: string } {
  const root = mkdtempSync(join(tmpdir(), "aimi-publish-"));
  cleanups.push(root);
  const apkPath = join(root, "app-fake.apk");
  writeFileSync(apkPath, apkBody, "utf8");
  const cfg: ServerConfig = {
    port: 1, // 无服务在跑：refresh 通知必失败（notified=false 路径）
    dataDir: join(root, "data"),
    logDir: join(root, "logs"),
    logLevel: "ERROR",
    watchdogMs: 600_000, serverVersion: "0.1.0",
  };
  return { cfg, apkPath };
}

describe("publishApk（发布 CLI 核心逻辑）", () => {
  it("显式版本发布：复制文件、原子写清单、notified=false 不抛", async () => {
    const { cfg, apkPath } = fixture("apk-bytes-v2");
    const result = await publishApk(cfg, { apkPath, versionName: "1.0.2", versionCode: 2, notes: "说明" });
    expect(result).toMatchObject({ versionName: "1.0.2", versionCode: 2, size: 12, notified: false });
    expect(result.sha256).toBe(createHash("sha256").update("apk-bytes-v2").digest("hex"));
    // APK 已复制入更新目录
    expect(readFileSync(join(result.updatesDir, "app-2.apk"), "utf8")).toBe("apk-bytes-v2");
    // 清单可读回且形状正确（downloadPath 与文件名一致）
    const manifest = JSON.parse(readFileSync(join(result.updatesDir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ versionName: "1.0.2", versionCode: 2, downloadPath: "/updates/app-2.apk", notes: "说明" });
    expect(manifest.publishedAt).toEqual(expect.any(Number));
  });

  it("版本未递增被拦截；--force 放行并覆盖清单", async () => {
    const { cfg, apkPath } = fixture("apk-bytes");
    await publishApk(cfg, { apkPath, versionName: "1.0.2", versionCode: 2 });
    await expect(publishApk(cfg, { apkPath, versionName: "1.0.1", versionCode: 1 })).rejects.toThrow(/未递增/);
    await expect(publishApk(cfg, { apkPath, versionName: "1.0.2", versionCode: 2 })).rejects.toThrow(/--force/);
    const forced = await publishApk(cfg, { apkPath, versionName: "1.0.3", versionCode: 2, force: true });
    expect(forced.versionCode).toBe(2); // force 允许同号重发
  });

  it("notes 超长截断到 1024；缺省不写 notes 键", async () => {
    const { cfg, apkPath } = fixture("x");
    const a = await publishApk(cfg, { apkPath, versionName: "1.0.0", versionCode: 1, notes: "长".repeat(2000) });
    const manifestA = JSON.parse(readFileSync(join(a.updatesDir, "manifest.json"), "utf8"));
    expect(manifestA.notes.length).toBe(1024);
    const b = await publishApk(cfg, { apkPath, versionName: "1.0.1", versionCode: 2 });
    const manifestB = JSON.parse(readFileSync(join(b.updatesDir, "manifest.json"), "utf8"));
    expect(manifestB).not.toHaveProperty("notes");
  });

  it("历史 APK 清理：只保留最近 3 个（当前 + 2 个旧版）", async () => {
    const { cfg, apkPath } = fixture("x");
    for (const code of [1, 2, 3, 4, 5]) {
      await publishApk(cfg, { apkPath, versionName: `1.0.${code}`, versionCode: code });
    }
    const { readdirSync } = await import("node:fs");
    const apks = readdirSync(join(cfg.dataDir, "updates")).filter((n) => n.startsWith("app-"));
    expect(apks.sort()).toEqual(["app-3.apk", "app-4.apk", "app-5.apk"]);
  });

  it("源 APK 不存在直接抛 ENOENT", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-publish-"));
    cleanups.push(root);
    const cfg: ServerConfig = {
      port: 1, dataDir: join(root, "data"), logDir: join(root, "logs"),
      logLevel: "ERROR", watchdogMs: 600_000, serverVersion: "0.1.0",
    };
    await expect(publishApk(cfg, { apkPath: join(root, "nope.apk"), versionName: "1", versionCode: 1 }))
      .rejects.toThrow();
    expect(existsSync(join(root, "data", "updates"))).toBe(false); // 失败不残留半截目录内容
    mkdirSync(join(root, "data"), { recursive: true }); // 占位避免 afterAll 删除报错
  });
});
