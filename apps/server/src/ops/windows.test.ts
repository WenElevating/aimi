import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskExec } from "./windows.js";
import { DEFAULT_TASK_NAME, installPlan, register, unregister } from "./windows.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 造一份与真实仓布局同构的临时树（`<root>/apps/server/src/bin/aimi-server.ts` +
 * `<root>/apps/server/package.json`），供包根定位（WorkingDirectory 派生）走真路径。
 *
 * @returns 临时根、入口脚本绝对路径与包根绝对路径；根目录登记进清理表
 */
function fixtureTree(): { entryJs: string; packageRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "aimi-win-"));
  dirs.push(root);
  const packageRoot = join(root, "apps", "server");
  const entryJs = join(packageRoot, "src", "bin", "aimi-server.ts");
  mkdirSync(dirname(entryJs), { recursive: true });
  writeFileSync(entryJs, "// fixture\n", "utf8");
  writeFileSync(join(packageRoot, "package.json"), "{}\n", "utf8");
  return { entryJs, packageRoot };
}

/**
 * 造一个记录调用并可按开关编造失败结果的 fake 任务计划执行器（测试注入用——绝不真调 schtasks）。
 *
 * @param opts.stderr - 失败时挂在 Error 上的 stderr 文本（模 schtasks 的各形态输出）
 * @param opts.failOn - true = 每次调用都失败；或传开关字面量（如 "/Query"）只在该开关的调用上失败
 * @returns 注入用执行器；`calls` 记录每次 (file, args, XML 文件内容)——XML 内容在
 *   执行器被调瞬间读盘捕获（register 的临时文件在执行后才删，捕获窗口存在）
 */
function fakeExec(opts: { stderr?: string; failOn?: boolean | string } = {}): TaskExec & {
  calls: { file: string; args: string[]; xmlFileContent: string | null }[];
} {
  const calls: { file: string; args: string[]; xmlFileContent: string | null }[] = [];
  const run: TaskExec = async (file, args) => {
    const xmlAt = args.indexOf("/XML");
    const xmlFileContent = xmlAt === -1 ? null : readFileSync(args[xmlAt + 1]!, "utf8");
    calls.push({ file, args: [...args], xmlFileContent });
    const failed = opts.failOn === true || opts.failOn === args[0];
    if (failed) {
      // 错误 message 携带 stderr——与 Node execFile 的真实拒绝形态同构（执行壳原样上抛）。
      const err = new Error("Command failed: schtasks\n" + (opts.stderr ?? ""));
      (err as { stdout?: string }).stdout = "";
      (err as { stderr?: string }).stderr = opts.stderr;
      throw err;
    }
    return { stdout: "SUCCESS: The scheduled task \"aimi-server\" has successfully been created.", stderr: opts.stderr ?? "" };
  };
  return Object.assign(run, { calls });
}

/** 临时把 process.platform 换成指定值（平台守卫的跨平台验证），结束原样恢复。 */
async function withPlatform<T>(platform: string, run: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

describe("installPlan（纯构建器，平台无关）", () => {
  it("XML 全文断言：LogonTrigger / RestartOnFailure(PT1M×3) / Hidden / Exec 四要素 + 缺省任务名 aimi-server", () => {
    const { entryJs, packageRoot } = fixtureTree();
    const plan = installPlan({ nodeExe: "C:\\Program Files\\nodejs\\node.exe", entryJs });

    expect(plan.taskName).toBe(DEFAULT_TASK_NAME);
    expect(plan.taskName).toBe("aimi-server");
    expect(plan.xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
        "  <RegistrationInfo>",
        "    <Description>aimi-server 常驻服务（登录自启；进程失败 1 分钟内重试，至多 3 次）</Description>",
        "  </RegistrationInfo>",
        "  <Triggers>",
        "    <LogonTrigger>",
        "      <Enabled>true</Enabled>",
        "    </LogonTrigger>",
        "  </Triggers>",
        "  <Principals>",
        '    <Principal id="Author">',
        "      <LogonType>InteractiveToken</LogonType>",
        "      <RunLevel>LeastPrivilege</RunLevel>",
        "    </Principal>",
        "  </Principals>",
        "  <Settings>",
        "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
        "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
        "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
        "    <AllowHardTerminate>true</AllowHardTerminate>",
        "    <StartWhenAvailable>false</StartWhenAvailable>",
        "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
        "    <IdleSettings>",
        "      <StopOnIdleEnd>false</StopOnIdleEnd>",
        "      <RestartOnIdle>false</RestartOnIdle>",
        "    </IdleSettings>",
        "    <AllowStartOnDemand>true</AllowStartOnDemand>",
        "    <Enabled>true</Enabled>",
        "    <Hidden>true</Hidden>",
        "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
        "    <WakeToRun>false</WakeToRun>",
        "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
        "    <Priority>7</Priority>",
        "    <RestartOnFailure>",
        "      <Interval>PT1M</Interval>",
        "      <Count>3</Count>",
        "    </RestartOnFailure>",
        "  </Settings>",
        '  <Actions Context="Author">',
        "    <Exec>",
        "      <Command>C:\\Program Files\\nodejs\\node.exe</Command>",
        '      <Arguments>--import tsx "' + entryJs + '" start</Arguments>',
        "      <WorkingDirectory>" + packageRoot + "</WorkingDirectory>",
        "    </Exec>",
        "  </Actions>",
        "</Task>",
        "",
      ].join("\n"),
    );
  });

  it("自定义 taskName 透传（install/uninstall 双侧同名才能删对任务）", () => {
    const { entryJs } = fixtureTree();
    const plan = installPlan({ nodeExe: "node", entryJs, taskName: "aimi-server-dev" });
    expect(plan.taskName).toBe("aimi-server-dev");
  });

  it("entryJs 含 XML 特殊字符 → 文本节点转义（& → &amp;）", () => {
    const root = mkdtempSync(join(tmpdir(), "aimi-win-amp-"));
    dirs.push(root);
    const packageRoot = join(root, "a&b", "server");
    const entryJs = join(packageRoot, "src", "bin", "aimi-server.ts");
    mkdirSync(dirname(entryJs), { recursive: true });
    writeFileSync(entryJs, "// fixture\n", "utf8");
    writeFileSync(join(packageRoot, "package.json"), "{}\n", "utf8");

    const plan = installPlan({ nodeExe: "node", entryJs });
    expect(plan.xml).toContain("a&amp;b");
    expect(plan.xml).not.toContain("a&b");
  });
});

/** 平台卫语句：执行壳（register/unregister）带 Windows 守卫，fake 注入用例因此只在 Windows 上跑（CI windows-latest 口径）。 */
describe.skipIf(process.platform !== "win32")("register / unregister（执行壳——fake 执行器注入，不真调 schtasks）", () => {
  it("register：拼装 schtasks /Create /TN <taskName> /F /XML <临时xml>，XML 内容与计划全文一致", async () => {
    const { entryJs } = fixtureTree();
    const plan = installPlan({ nodeExe: "node", entryJs });
    const fake = fakeExec();

    await register(plan, fake);

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.file).toBe("schtasks");
    expect(call.args[0]).toBe("/Create");
    expect(call.args[1]).toBe("/TN");
    expect(call.args[2]).toBe("aimi-server");
    expect(call.args[3]).toBe("/F");
    expect(call.args[4]).toBe("/XML");
    expect(call.args[5]).toMatch(/\.xml$/);
    expect(call.xmlFileContent).toBe(plan.xml);
  });

  it("register：执行失败原样抛出（不吞错误）", async () => {
    const { entryJs } = fixtureTree();
    const plan = installPlan({ nodeExe: "node", entryJs });
    const fake = fakeExec({ failOn: true, stderr: "拒绝访问。" });

    await expect(register(plan, fake)).rejects.toThrow(/拒绝访问/);
  });

  it("unregister：先查后删——缺省任务名先 /Query 再 /Delete", async () => {
    const fake = fakeExec();
    await unregister(undefined, fake);

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.file).toBe("schtasks");
    expect(fake.calls[0]!.args).toEqual(["/Query", "/TN", "aimi-server", "/FO", "LIST"]);
    expect(fake.calls[1]!.args).toEqual(["/Delete", "/TN", "aimi-server", "/F"]);
  });

  it("unregister：自定义任务名透传到查询与删除两步", async () => {
    const fake = fakeExec();
    await unregister("aimi-server-dev", fake);

    expect(fake.calls[0]!.args).toEqual(["/Query", "/TN", "aimi-server-dev", "/FO", "LIST"]);
    expect(fake.calls[1]!.args).toEqual(["/Delete", "/TN", "aimi-server-dev", "/F"]);
  });

  it("unregister：查询失败视为任务不存在——幂等成功且不再尝试删除（locale/编码无关）", async () => {
    const fake = fakeExec({ failOn: "/Query", stderr: 'ERROR: The specified task name "aimi-server" does not exist in the system.' });
    await expect(unregister("aimi-server", fake)).resolves.toBeUndefined();
    expect(fake.calls).toHaveLength(1); // 只有 Query，没有 Delete
  });

  it("unregister：查询命中但删除失败 → 原样抛出（只有「不在」语义被幂等吞掉）", async () => {
    const fake = fakeExec({ failOn: "/Delete", stderr: "拒绝访问。" });
    await expect(unregister("aimi-server", fake)).rejects.toThrow(/拒绝访问/);
  });
});

describe("执行壳的平台守卫（非 Windows 拒绝——fake 执行器注入，跨平台可测）", () => {
  it("非 win32 平台：register/unregister 入口即抛「仅支持 Windows」（不再走到执行器）", async () => {
    const { entryJs } = fixtureTree();
    const plan = installPlan({ nodeExe: "node", entryJs });
    const fake = fakeExec();
    await withPlatform("linux", async () => {
      await expect(register(plan, fake)).rejects.toThrow("仅支持 Windows");
      await expect(unregister("aimi-server", fake)).rejects.toThrow("仅支持 Windows");
      expect(fake.calls).toHaveLength(0); // 守卫在入口，执行器从未被触达
    });
  });
});
