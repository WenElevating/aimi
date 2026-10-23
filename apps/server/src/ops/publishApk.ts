import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ApkReader from "adbkit-apkreader";
import { apkFileNameOf, diskUpdateManifest, type DiskUpdateManifest } from "../app/updateFeed.js";
import type { ServerConfig } from "../app/config.js";

/** 发布结果摘要（CLI 打印与测试断言面）。 */
export interface PublishApkResult {
  readonly versionName: string;
  readonly versionCode: number;
  readonly size: number;
  readonly sha256: string;
  readonly updatesDir: string;
  readonly fileName: string;
  /** 是否成功通知到运行中服务（false = 服务未运行或通知失败，发布仍视为成功）。 */
  readonly notified: boolean;
}

/** 发布选项；显式版本参数存在时覆盖 APK 解析结果（解析库失效时的兜底入口）。 */
export interface PublishApkOptions {
  readonly apkPath: string;
  readonly notes?: string;
  readonly versionName?: string;
  readonly versionCode?: number;
  readonly force?: boolean;
}

/** 更新目录内保留的历史 APK 个数（含当前发布）：当前 + 最近 2 个旧版。 */
const KEEP_APK_FILES = 3;

/**
 * 解析 APK 的 versionName/versionCode：显式参数优先，缺省用 adbkit-apkreader 读
 * AndroidManifest（二进制 XML）。两者都不可得时抛错——版本号是覆盖安装与升级判据，
 * 不允许猜测。
 *
 * @param opts - 发布选项（显式版本参数与 APK 路径）
 * @returns Promise，resolve 为 { versionName, versionCode }
 * @throws APK 不存在、解析失败且未提供完整显式版本时抛错
 */
async function resolveVersion(opts: PublishApkOptions): Promise<{ versionName: string; versionCode: number }> {
  if (opts.versionName !== undefined && opts.versionCode !== undefined) {
    return { versionName: opts.versionName, versionCode: opts.versionCode };
  }
  try {
    const reader = await ApkReader.open(opts.apkPath);
    const manifest = await reader.readManifest();
    if (manifest.versionName === undefined || manifest.versionCode === undefined) {
      throw new Error(`APK manifest 缺少版本字段: versionName=${String(manifest.versionName)} versionCode=${String(manifest.versionCode)}`);
    }
    return { versionName: opts.versionName ?? manifest.versionName, versionCode: opts.versionCode ?? manifest.versionCode };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`解析 APK 版本失败（${reason}）；可用 --version-name/--version-code 显式指定`);
  }
}

/** 读既有磁盘清单；不存在/损坏返回 null（损坏时发布照常进行并覆盖修复）。 */
async function readExistingManifest(manifestPath: string): Promise<DiskUpdateManifest | null> {
  try {
    return diskUpdateManifest.parse(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

/**
 * 发布一个 APK 到更新通道：解析版本 → 防降级校验 → 复制 APK 与原子写 manifest.json →
 * 清理超量历史文件 → 通知运行中服务（loopback refresh）。
 * 发布状态只落 `{dataDir}/updates/`，与运行服务跨进程共享；服务未运行不算失败。
 *
 * @param cfg - 服务端配置（dataDir 定位更新目录；port 用于本机 refresh 通知）
 * @param opts - 发布选项
 * @returns Promise，resolve 为发布摘要
 * @throws APK 不存在/版本无法解析/版本回退未加 --force/写盘失败时抛错
 */
export async function publishApk(cfg: ServerConfig, opts: PublishApkOptions): Promise<PublishApkResult> {
  await stat(opts.apkPath); // 不存在直接抛 ENOENT
  const { versionName, versionCode } = await resolveVersion(opts);
  if (versionCode <= 0) {
    throw new Error(`versionCode 必须为正整数: ${String(versionCode)}`);
  }

  const updatesDir = join(cfg.dataDir, "updates");
  const manifestPath = join(updatesDir, "manifest.json");
  await mkdir(updatesDir, { recursive: true });

  const existing = await readExistingManifest(manifestPath);
  if (existing !== null && versionCode <= existing.versionCode && opts.force !== true) {
    throw new Error(`版本未递增: ${versionName}+${versionCode} <= 已发布 ${existing.versionName}+${existing.versionCode}（确认回退/重发请加 --force）`);
  }

  const sha256 = await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(opts.apkPath)
      .on("data", (chunk) => { hash.update(chunk); })
      .on("error", reject)
      .on("end", () => { resolve(hash.digest("hex")); });
  });
  const { size } = await stat(opts.apkPath);

  const fileName = apkFileNameOf(versionCode);
  await copyFile(opts.apkPath, join(updatesDir, fileName));

  const manifest: DiskUpdateManifest = {
    versionName,
    versionCode,
    size,
    sha256,
    downloadPath: `/updates/${fileName}`,
    ...(opts.notes === undefined ? {} : { notes: opts.notes.slice(0, 1024) }),
    publishedAt: Date.now(),
  };
  // 原子写：先写临时文件再 rename，运行服务读到半截 JSON 的窗口为零。
  const tmpPath = manifestPath + ".tmp";
  await writeFile(tmpPath, JSON.stringify(manifest, null, 2), "utf8");
  await rename(tmpPath, manifestPath);

  await pruneOldApks(updatesDir, versionCode);

  let notified = false;
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/internal/updates/refresh`, { method: "POST" });
    notified = res.ok;
  } catch {
    notified = false; // 服务未运行：发布状态已落盘，手机下次连接自然获知
  }

  return { versionName, versionCode, size, sha256, updatesDir, fileName, notified };
}

/**
 * 清理超量历史 APK：目录内 `app-*.apk` 按版本号降序只保留前 KEEP_APK_FILES 个
 * （当前发布天然排第一）。清理失败不阻断发布（残留文件只占磁盘，不影响正确性）。
 *
 * @param updatesDir - 更新目录
 * @param currentCode - 当前发布的 versionCode（保证不被误删）
 */
async function pruneOldApks(updatesDir: string, currentCode: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(updatesDir);
  } catch {
    return;
  }
  const codes = names
    .map((name) => /^app-(\d+)\.apk$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a);
  for (const code of codes.slice(KEEP_APK_FILES)) {
    if (code === currentCode) continue;
    try {
      await unlink(join(updatesDir, apkFileNameOf(code)));
    } catch {
      // 并发清理竞态或权限问题：跳过，下次发布再清。
    }
  }
}
