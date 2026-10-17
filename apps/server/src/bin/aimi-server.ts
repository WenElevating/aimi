#!/usr/bin/env node
/**
 * aimi-server 命令行入口：只负责绑定参数，实际实现落在 `ops/health.ts` 与 `app/application.ts`。
 *
 * 子命令：
 * - `start [--config <path>]`：装配并常驻 LAN 服务，终端打印 `{ lanUrl }`（**不打印 token**——
 *   明文凭证只经 `lan-token` 打印一次）；`SIGINT`/`SIGTERM` → `application.close()` 后退出 0。
 * - `status [--config <path>]`：stdout 单行 JSON `{ port, sessions, devices }`。
 * - `lan-token [--config <path>]`：打印当前 LAN 令牌明文，供运维者一次性拷入手机。
 */
import { Application } from "../app/application.js";
import { loadConfig } from "../app/config.js";
import { healthSnapshot, lanUrl, readLanToken } from "../ops/health.js";

/** 取 `--config` 后的路径；未提供返回 `undefined`（走全默认配置）。 */
function configPathOf(argv: readonly string[]): string | undefined {
  const at = argv.indexOf("--config");
  return at === -1 ? undefined : argv[at + 1];
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
    default:
      process.stderr.write("用法: aimi-server <start|status|lan-token> [--config <path>]\n");
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  process.stderr.write("aimi-server: " + (err instanceof Error ? err.message : String(err)) + "\n");
  process.exit(1);
});
