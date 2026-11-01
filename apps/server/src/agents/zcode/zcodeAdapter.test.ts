import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZcodeAdapter } from "./zcodeAdapter.js";

/**
 * 探测用假 CLI（deps.executable 注入，不经真实 zcode）：行为由 ZFAKE_MODE 决定——
 * ok=输出版本即退；fail=非零退出；delay=延迟后输出版本。每次运行把 argv 追加到
 * ZFAKE_ARGS_LOG（并发去重断言的计数依据）。
 */
const FAKE_CLI = `
const fs = require("node:fs");
const argsLog = process.env.ZFAKE_ARGS_LOG;
if (argsLog) fs.appendFileSync(argsLog, JSON.stringify(process.argv.slice(2)) + "\\n");
const delay = Number(process.env.ZFAKE_DELAY_MS ?? "0");
const done = () => {
  if (process.env.ZFAKE_MODE === "fail") process.exit(1);
  process.stdout.write("9.9.9-fake\\n");
};
if (delay > 0) setTimeout(done, delay); else done();
`;

/** 建一个注入假 CLI 的适配器；返回 argv 日志路径供 spawn 计数。 */
function adapterWithFakeCli(mode: string, delayMs = 0): { adapter: ZcodeAdapter; argsLog: string } {
  const dir = mkdtempSync(join(tmpdir(), "zcode-adapter-"));
  const cliPath = join(dir, "fake-zcode.cjs");
  writeFileSync(cliPath, FAKE_CLI);
  const argsLog = join(dir, "args.log");
  process.env.ZFAKE_MODE = mode;
  process.env.ZFAKE_DELAY_MS = String(delayMs);
  process.env.ZFAKE_ARGS_LOG = argsLog;
  const adapter = new ZcodeAdapter({ executable: cliPath });
  return { adapter, argsLog };
}

/** 安装态同步读（installState）：三态流转 + 并发去重。 */
describe("ZcodeAdapter.installState/isInstalled", () => {
  it("三态：未探测 unknown → 成功 installed → 失败 missing", async () => {
    const { adapter } = adapterWithFakeCli("ok");
    expect(adapter.installState()).toBe("unknown");
    await adapter.isInstalled();
    expect(adapter.installState()).toBe("installed");

    const { adapter: failing } = adapterWithFakeCli("fail");
    await failing.isInstalled();
    expect(failing.installState()).toBe("missing");
  });

  it("并发去重：两个并发 isInstalled 只 spawn 一次（共享在途航程）", async () => {
    const { adapter, argsLog } = adapterWithFakeCli("ok", 400);
    const [a, b] = await Promise.all([adapter.isInstalled(), adapter.isInstalled()]);
    expect(a).toEqual({ ok: true, version: "9.9.9-fake" });
    expect(b).toEqual(a);
    const spawns = readFileSync(argsLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.includes("--version"));
    expect(spawns).toHaveLength(1);
  });

  it("TTL 内缓存命中：第二次 isInstalled 不再 spawn", async () => {
    const { adapter, argsLog } = adapterWithFakeCli("ok");
    await adapter.isInstalled();
    await adapter.isInstalled();
    const spawns = readFileSync(argsLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.includes("--version"));
    expect(spawns).toHaveLength(1);
  });
});
