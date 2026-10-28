#!/usr/bin/env node
/**
 * aimi-server 命令行入口：只负责绑定参数，实际实现落在 `ops/health.ts`、`ops/devices.ts` 与 `app/application.ts`。
 *
 * 配置发现：显式 `--config <path>` 优先；未给出时若 `~/.aimi-server/config.yaml` 存在则用它
 * （自托管工具的约定位置——host/tls/relay 等改动只写这一份，全部子命令自动生效），
 * 不存在则走全默认（loopback 明文）。库与 dataDir 默认位置不受影响。
 *
 * 子命令：
 * - `start [--config <path>]`：装配并常驻 LAN 服务，终端打印 `{ lanUrl }`（**不打印 token**——
 *   明文凭证只经 `lan-token` 打印一次）；收到 `SIGINT`/`SIGTERM` 后 `application.close()` 并退出 0。
 * - `status [--config <path>]`：stdout 单行 JSON `{ port, sessions, devices, agents }`——库面为
 *   只读快照（`healthSnapshot`）；`agents` 自 Task 10 起会拉起 `claude --version` 探测子进程
 *   （2s 超时视为未装），故 status 不再瞬时返回，但依旧不写库。
 * - `lan-token [--config <path>]`：打印当前 LAN 令牌明文，供运维者一次性拷入手机。
 * - `pair [--config <path>]`：签发一次性 8 位配对码，打印码/过期时刻/serverId/LAN 地址与终端 QR
 *   （QR payload = `{v:1,serverId,lanUrl,relayUrl?,code}`，relay 未启用时缺省不含）。
 * - `devices [--config <path>]`：设备清单表格（id/name/lastSeenAt/revokedAt，制表符分隔）。
 * - `revoke <deviceId> [--config <path>]`：吊销设备（lan-token 系设备同步报废令牌文件）；
 *   退出码 0=已吊销、1=设备不存在或参数缺失。
 * - `publish-apk <apk> [--notes <s>] [--version-name <s>] [--version-code <n>] [--force] [--config <path>]`：
 *   发布 APK 到更新通道（复制入 `{dataDir}/updates/` + 原子写清单），并通知运行中服务向
 *   在线手机推送 update.info。版本号默认解析 APK，解析失败用 --version-name/--version-code 兜底；
 *   versionCode 不递增须 --force 才放行。
 * - `feedback list [--config <path>]`：反馈清单表格（id/设备/app/图片数/日志/描述首行）。
 * - `feedback show <id> [--config <path>]`：反馈全文、App 信息与附件绝对路径。
 * - `feedback set-status <id> <new|acked|done> [--config <path>]`：回写处理状态。
 * - `install`：向 Windows 任务计划注册 `aimi-server` 计划任务（当前用户登录自启；进程失败
 *   1 分钟内重试至多 3 次）——非 Windows 平台报错退出；注册后提示重启电脑验证。
 * - `uninstall`：注销同名计划任务（不存在视为成功，幂等）。
 */
import QRCode from "qrcode";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Application } from "../app/application.js";
import { loadConfig } from "../app/config.js";
import { statusSnapshot } from "../app/detectAgents.js";
import { lanUrl, readLanToken } from "../ops/health.js";
import { issuePairing, listDevices, revokeDevice } from "../ops/devices.js";
import { publishApk, type PublishApkOptions } from "../ops/publishApk.js";
import { listFeedback, setFeedbackStatus, showFeedback } from "../ops/feedback.js";
import { DEFAULT_TASK_NAME, defaultEntryJs, installPlan, register, unregister } from "../ops/windows.js";

/**
 * 取 `--config` 后的路径；未提供时返回 `undefined`（走全默认配置）。
 *
 * @param argv - 进程参数去掉可执行文件与脚本名后的部分
 * @returns 配置文件路径；未给出 `--config` 时为 `undefined`
 */
function configPathOf(argv: readonly string[]): string | undefined {
  const at = argv.indexOf("--config");
  return at === -1 ? undefined : argv[at + 1];
}

/**
 * 取 `revoke` 子命令的目标设备 id：`--config` 及其值以外的第一个参数。
 *
 * @param argv - 进程参数（`argv[0]` 为子命令）
 * @returns 设备 id；未给出时为 `undefined`
 */
function deviceIdOf(argv: readonly string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    // .at() 读位（eslint security 规则拒绝泛型下标访问；行为与 argv[i] 等价）。
    if (argv.at(i) === "--config") {
      i++;
      continue;
    }
    return argv.at(i);
  }
  return undefined;
}

/** `start`：装配常驻，打印 lanUrl，注册优雅退出信号。 */
async function cmdStart(configPath: string | undefined): Promise<void> {
  const cfg = loadConfig(configPath);
  const app = new Application(cfg);
  const { port } = await app.start();
  process.stdout.write(JSON.stringify({ lanUrl: lanUrl(port, cfg) }) + "\n");
  const shutdown = (): void => {
    void app.close().finally(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** `status`：单行 JSON 快照（库面 + agent 检测面——会拉起 claude 探测子进程，2s 超时）。 */
async function cmdStatus(configPath: string | undefined): Promise<void> {
  const cfg = loadConfig(configPath);
  process.stdout.write(JSON.stringify(await statusSnapshot(cfg)) + "\n");
}

/** `lan-token`：打印明文令牌（幂等供给）。 */
async function cmdLanToken(configPath: string | undefined): Promise<void> {
  const cfg = loadConfig(configPath);
  process.stdout.write((await readLanToken(cfg)) + "\n");
}

/** `pair`：出码并打印人读信息 + 终端 QR（手机扫码免抄码直连；码经库由运行服务核销）。 */
async function cmdPair(configPath: string | undefined): Promise<void> {
  const cfg = loadConfig(configPath);
  const issued = await issuePairing(cfg);
  // QR payload 按 core-loop §5.3 定型的 JSON 形态；relay 启用时才含 relayUrl（Task 9 起钩子生效），
  // 未启用时缺省不含——S3 手机端按有无该键分流 LAN 直连 / relay 拨入。
  const payload = JSON.stringify({
    v: 1,
    serverId: issued.serverId,
    lanUrl: issued.lanUrl,
    ...(issued.relayUrl === undefined ? {} : { relayUrl: issued.relayUrl }),
    ...(issued.tlsFingerprint === undefined ? {} : { tlsFingerprint: issued.tlsFingerprint }),
    code: issued.code,
  });
  const qr = await QRCode.toString(payload, { type: "terminal" });
  process.stdout.write("配对码: " + issued.code + "\n");
  process.stdout.write("有效期至: " + new Date(issued.expiresAt).toISOString() + "\n");
  process.stdout.write("serverId: " + issued.serverId + "\n");
  process.stdout.write("LAN 地址: " + issued.lanUrl + "\n");
  if (issued.tlsFingerprint !== undefined) {
    process.stdout.write("TLS 指纹: " + issued.tlsFingerprint + "\n");
  }
  process.stdout.write(qr.endsWith("\n") ? qr : qr + "\n");
}

/** `devices`：设备清单表格；未吊销的 revokedAt 列为 "-"。 */
async function cmdDevices(configPath: string | undefined): Promise<void> {
  const cfg = loadConfig(configPath);
  process.stdout.write(["id", "name", "lastSeenAt", "revokedAt"].join("\t") + "\n");
  for (const d of await listDevices(cfg)) {
    process.stdout.write(
      [
        d.id,
        d.name,
        new Date(d.lastSeenAt).toISOString(),
        d.revokedAt === null ? "-" : new Date(d.revokedAt).toISOString(),
      ].join("\t") + "\n",
    );
  }
}

/** `revoke <deviceId>`：吊销设备；退出码 0=已吊销、1=设备不存在或参数缺失。 */
async function cmdRevoke(configPath: string | undefined, deviceId: string | undefined): Promise<void> {
  if (deviceId === undefined || deviceId === "") {
    process.stderr.write("用法: aimi-server revoke <deviceId> [--config <path>]\n");
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig(configPath);
  const result = await revokeDevice(cfg, deviceId);
  if (result === "not_found") {
    process.stderr.write("device not found: " + deviceId + "\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("revoked: " + deviceId + "\n");
}

/**
 * 从计划 XML 中摘出 `<Exec>` 启动项（逐行缩进）作为注册结果的摘要打印。
 *
 * @param xml - 计划定义全文
 * @returns 缩进后的 Exec 子元素文本；无 Exec 时为空串
 */
function execSummaryOf(xml: string): string {
  const block = /<Exec>[\s\S]*?<\/Exec>/.exec(xml)?.[0] ?? "";
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "<Exec>" && line !== "</Exec>")
    .map((line) => "  " + line)
    .join("\n");
}

/** `install`：注册 Windows 计划任务（登录自启）；非 Windows 平台由执行壳抛「仅支持 Windows」。 */
async function cmdInstall(): Promise<void> {
  const plan = installPlan({ nodeExe: process.execPath, entryJs: defaultEntryJs() });
  await register(plan);
  process.stdout.write("已注册计划任务: " + plan.taskName + "\n");
  process.stdout.write("启动项:\n" + execSummaryOf(plan.xml) + "\n");
  process.stdout.write("触发: 用户登录自启；进程失败 1 分钟内自动重启（至多 3 次）\n");
  process.stdout.write("提示: 重启电脑后运行 `aimi-server status` 验证自启；卸载运行 `aimi-server uninstall`。\n");
}

/** `uninstall`：注销同名计划任务（不存在亦视为成功——幂等卸载）。 */
async function cmdUninstall(): Promise<void> {
  await unregister();
  process.stdout.write("已注销计划任务: " + DEFAULT_TASK_NAME + "（任务本就不存在时同样视为已卸载）\n");
}

/**
 * 解析 `publish-apk` 参数：首个非选项参数为 APK 路径，`--notes/--version-name/--version-code`
 * 各取一个值，`--force` 为开关；不认识的参数报错退出。
 *
 * @param argv - 进程参数（`argv[0]` 为子命令）
 * @returns 发布选项；APK 路径缺失时为 null
 */
function parsePublishArgs(argv: readonly string[]): PublishApkOptions | null {
  let apkPath: string | undefined;
  let notes: string | undefined;
  let versionName: string | undefined;
  let versionCode: number | undefined;
  let force = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv.at(i);
    if (arg === "--config") {
      i++;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--notes" || arg === "--version-name" || arg === "--version-code") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`参数 ${arg} 缺少值`);
      }
      if (arg === "--notes") notes = value;
      if (arg === "--version-name") versionName = value;
      if (arg === "--version-code") {
        versionCode = Number(value);
        if (!Number.isInteger(versionCode) || versionCode <= 0) {
          throw new Error(`--version-code 必须为正整数: ${value}`);
        }
      }
      i++;
      continue;
    }
    if (apkPath === undefined) {
      apkPath = arg;
      continue;
    }
    throw new Error(`多余参数: ${arg}`);
  }
  return apkPath === undefined ? null : { apkPath, notes, versionName, versionCode, force };
}

/** `publish-apk`：发布 APK 并打印摘要；服务未运行时提示手机将在下次连接获知。 */
async function cmdPublishApk(configPath: string | undefined, argv: readonly string[]): Promise<void> {
  const opts = parsePublishArgs(argv);
  if (opts === null) {
    process.stderr.write(
      "用法: aimi-server publish-apk <apk> [--notes <s>] [--version-name <s>] [--version-code <n>] [--force] [--config <path>]\n",
    );
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig(configPath);
  const result = await publishApk(cfg, opts);
  process.stdout.write(
    `已发布 ${result.versionName}+${result.versionCode}（${result.size} 字节, sha256 ${result.sha256.slice(0, 8)}…）\n`,
  );
  process.stdout.write(`文件: ${result.updatesDir}\\${result.fileName}\n`);
  process.stdout.write(
    result.notified
      ? "已通知运行中服务：在线手机将立即收到更新推送。\n"
      : "未联系到运行中服务（可能未启动）：手机下次连接时会自动获知本次发布。\n",
  );
}

/** `feedback <list|show>`：分发到子形态。 */
async function cmdFeedback(configPath: string | undefined, argv: readonly string[]): Promise<void> {
  switch (argv[1]) {
    case "list":
      return cmdFeedbackList(configPath);
    case "show":
      return cmdFeedbackShow(configPath, argv[2]);
    case "set-status":
      return cmdFeedbackSetStatus(configPath, argv[2], argv[3]);
    default:
      process.stderr.write(
        "用法: aimi-server feedback <list|show <id>|set-status <id> <new|acked|done>> [--config <path>]\n",
      );
      process.exitCode = 1;
  }
}

/**
 * `feedback set-status <id> <new|acked|done>`：回写反馈处理状态。
 *
 * @param configPath - 配置路径（可缺省走自动发现）
 * @param id - 反馈 id（目录名）
 * @param status - 目标状态；值域外直接报错退出（不静默纠正）
 */
async function cmdFeedbackSetStatus(
  configPath: string | undefined,
  id: string | undefined,
  status: string | undefined,
): Promise<void> {
  if (id === undefined || id === "" || (status !== "new" && status !== "acked" && status !== "done")) {
    process.stderr.write("用法: aimi-server feedback set-status <id> <new|acked|done>\n");
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig(configPath);
  await setFeedbackStatus(cfg, id, status);
  process.stdout.write(`已更新 ${id} → ${status}\n`);
}

async function cmdFeedbackList(configPath: string | undefined): Promise<void> {
  const cfg = loadConfig(configPath);
  const entries = await listFeedback(cfg);
  if (entries.length === 0) {
    process.stdout.write("（暂无反馈）\n");
    return;
  }
  process.stdout.write(["id", "status", "deviceId", "app", "images", "log", "desc"].join("\t") + "\n");
  for (const entry of entries) {
    const firstLine = entry.desc.split("\n")[0] ?? "";
    process.stdout.write(
      [
        entry.id,
        entry.status,
        entry.deviceId.slice(0, 8),
        `${entry.app.version}+${entry.app.build}`,
        String(entry.images.length),
        entry.hasLog ? "Y" : "-",
        firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine,
      ].join("\t") + "\n",
    );
  }
}

/** `feedback show <id>`：反馈全文、App 信息与附件绝对路径。 */
async function cmdFeedbackShow(configPath: string | undefined, id: string | undefined): Promise<void> {
  if (id === undefined || id === "") {
    process.stderr.write("用法: aimi-server feedback show <id>\n");
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig(configPath);
  const entry = await showFeedback(cfg, id);
  process.stdout.write(`id: ${entry.id}\n`);
  process.stdout.write(`状态: ${entry.status}\n`);
  process.stdout.write(`设备: ${entry.deviceId}\n`);
  process.stdout.write(`App: ${entry.app.version}+${entry.app.build} (${entry.app.platform})\n`);
  process.stdout.write(`日志: ${entry.hasLog ? join(entry.dir, "log.zip") : "-"}\n`);
  process.stdout.write("描述:\n");
  process.stdout.write(`${entry.desc}\n`);
  for (const image of entry.images) {
    process.stdout.write(`图片: ${join(entry.dir, image.file.replaceAll("/", "\\"))}（原名 ${image.originalName}）\n`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let configPath = configPathOf(argv);
  // CLI 层默认发现：显式 --config 优先；否则存在约定位置 config.yaml 即采用（见文件头说明）。
  if (configPath === undefined) {
    const defaultPath = join(homedir(), ".aimi-server", "config.yaml");
    if (existsSync(defaultPath)) configPath = defaultPath;
  }
  const configPathForCmd = configPath;
  switch (argv[0]) {
    case "start":
      return cmdStart(configPathForCmd);
    case "status":
      return cmdStatus(configPathForCmd);
    case "lan-token":
      return cmdLanToken(configPathForCmd);
    case "pair":
      return cmdPair(configPathForCmd);
    case "devices":
      return cmdDevices(configPathForCmd);
    case "revoke":
      return cmdRevoke(configPathForCmd, deviceIdOf(argv));
    case "publish-apk":
      return cmdPublishApk(configPathForCmd, argv);
    case "feedback":
      return cmdFeedback(configPathForCmd, argv);
    case "install":
      return cmdInstall();
    case "uninstall":
      return cmdUninstall();
    default:
      process.stderr.write(
        "用法: aimi-server <start|status|lan-token|pair|devices|revoke|publish-apk|feedback|install|uninstall> [--config <path>]\n",
      );
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  process.stderr.write("aimi-server: " + (err instanceof Error ? err.message : String(err)) + "\n");
  process.exit(1);
});
