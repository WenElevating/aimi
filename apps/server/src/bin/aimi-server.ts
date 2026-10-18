#!/usr/bin/env node
/**
 * aimi-server 命令行入口：只负责绑定参数，实际实现落在 `ops/health.ts`、`ops/devices.ts` 与 `app/application.ts`。
 *
 * 子命令：
 * - `start [--config <path>]`：装配并常驻 LAN 服务，终端打印 `{ lanUrl }`（**不打印 token**——
 *   明文凭证只经 `lan-token` 打印一次）；收到 `SIGINT`/`SIGTERM` 后 `application.close()` 并退出 0。
 * - `status [--config <path>]`：stdout 单行 JSON `{ port, sessions, devices }`。
 * - `lan-token [--config <path>]`：打印当前 LAN 令牌明文，供运维者一次性拷入手机。
 * - `pair [--config <path>]`：签发一次性 8 位配对码，打印码/过期时刻/serverId/LAN 地址与终端 QR
 *   （QR payload = `{v:1,serverId,lanUrl,relayUrl?,code}`，relay 未启用时缺省不含）。
 * - `devices [--config <path>]`：设备清单表格（id/name/lastSeenAt/revokedAt，制表符分隔）。
 * - `revoke <deviceId> [--config <path>]`：吊销设备（lan-token 系设备同步报废令牌文件）；
 *   退出码 0=已吊销、1=设备不存在或参数缺失。
 */
import QRCode from "qrcode";
import { Application } from "../app/application.js";
import { loadConfig } from "../app/config.js";
import { healthSnapshot, lanUrl, readLanToken } from "../ops/health.js";
import { issuePairing, listDevices, revokeDevice } from "../ops/devices.js";

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
    if (argv[i] === "--config") { i++; continue; }
    return argv[i];
  }
  return undefined;
}

/** `start`：装配常驻，打印 lanUrl，注册优雅退出信号。 */
async function cmdStart(configPath: string | undefined): Promise<void> {
  const cfg = loadConfig(configPath);
  const app = new Application(cfg);
  const { port } = await app.start();
  process.stdout.write(JSON.stringify({ lanUrl: lanUrl(port) }) + "\n");
  const shutdown = (): void => {
    void app.close().finally(() => { process.exit(0); });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** `status`：单行 JSON 快照。 */
async function cmdStatus(configPath: string | undefined): Promise<void> {
  const cfg = loadConfig(configPath);
  process.stdout.write(JSON.stringify(await healthSnapshot(cfg)) + "\n");
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
  // QR payload 按 core-loop §5.3 定型的 JSON 形态；relay 拨入未启用（S2），缺省不含 relayUrl。
  const payload = JSON.stringify({ v: 1, serverId: issued.serverId, lanUrl: issued.lanUrl, code: issued.code });
  const qr = await QRCode.toString(payload, { type: "terminal" });
  process.stdout.write("配对码: " + issued.code + "\n");
  process.stdout.write("有效期至: " + new Date(issued.expiresAt).toISOString() + "\n");
  process.stdout.write("serverId: " + issued.serverId + "\n");
  process.stdout.write("LAN 地址: " + issued.lanUrl + "\n");
  process.stdout.write(qr.endsWith("\n") ? qr : qr + "\n");
}

/** `devices`：设备清单表格；未吊销的 revokedAt 列为 "-"。 */
async function cmdDevices(configPath: string | undefined): Promise<void> {
  const cfg = loadConfig(configPath);
  process.stdout.write(["id", "name", "lastSeenAt", "revokedAt"].join("\t") + "\n");
  for (const d of await listDevices(cfg)) {
    process.stdout.write([
      d.id,
      d.name,
      new Date(d.lastSeenAt).toISOString(),
      d.revokedAt === null ? "-" : new Date(d.revokedAt).toISOString(),
    ].join("\t") + "\n");
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const configPath = configPathOf(argv);
  switch (argv[0]) {
    case "start":
      return cmdStart(configPath);
    case "status":
      return cmdStatus(configPath);
    case "lan-token":
      return cmdLanToken(configPath);
    case "pair":
      return cmdPair(configPath);
    case "devices":
      return cmdDevices(configPath);
    case "revoke":
      return cmdRevoke(configPath, deviceIdOf(argv));
    default:
      process.stderr.write("用法: aimi-server <start|status|lan-token|pair|devices|revoke> [--config <path>]\n");
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  process.stderr.write("aimi-server: " + (err instanceof Error ? err.message : String(err)) + "\n");
  process.exit(1);
});
