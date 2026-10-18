import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/**
 * 缺省计划任务名：install/uninstall 双侧共用（两侧同名才能删对任务），CLI 打印也用它。
 * why 固定名而非派生自路径：任务名是运维者的寻址面（`schtasks /Query /TN`），稳定短名最好用。
 */
export const DEFAULT_TASK_NAME = "aimi-server";

/**
 * 任务计划命令执行器（注入点）：拼装并执行一条外部命令，返回 stdout/stderr 供错误判读。
 * why 注入：CI/本机测试环境没有「可随意写任务计划」的保障——单测注入 fake 断言命令拼装，
 * 生产路径缺省走 `schtasks`（见 `defaultTaskExec`）。
 */
export type TaskExec = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

/**
 * Windows 任务计划注册计划（`installPlan` 的产物）：任务名 + 可直接交给
 * `schtasks /Create /XML` 的任务定义全文。**纯数据**——测试可断言 XML 全文。
 */
export interface InstallPlan {
  /** 计划任务名（Task Scheduler 根目录下） */
  readonly taskName: string;
  /** 任务定义 XML 全文（UTF-8 声明；`/Create /XML` 按声明解析，中文路径/描述安全） */
  readonly xml: string;
}

/** XML 文本节点的最小转义（& < >）；引号在文本节点合法，无需转义。 */
function xmlEscape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * 从入口脚本向上找最近的包根（含 package.json 的目录），作为任务的 WorkingDirectory。
 * why 必须注入工作目录：任务缺省工作目录是 System32，`--import tsx` 的模块解析从 CWD 起查
 * node_modules——System32 下必然解析失败；指向包根后 tsx 从包根 node_modules 命中。
 *
 * @param entryJs - 入口脚本绝对路径
 * @returns 包根绝对路径（如 `<仓库>/apps/server`）
 * @throws 一路走到文件系统根仍无 package.json（无法确定解析根，拒绝生成必败的计划）
 */
function packageRootOf(entryJs: string): string {
  let dir = dirname(entryJs);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("entryJs 上方未找到 package.json，无法确定任务工作目录: " + entryJs);
    dir = parent;
  }
}

/**
 * 组装 Windows 任务计划注册计划（**纯构建器**：平台无关、无进程调用，仅读盘定位包根——
 * 非 Windows 也可调用，测试据此断言 XML 全文）。
 *
 * XML 契约（why 逐条）：
 * - `<LogonTrigger/>`（不带 UserId）：任意登录会话触发、任务以注册者身份
 *   （`InteractiveToken`）运行——单机个人部署即「当前用户登录」；显式写 UserId 会把机器名/
 *   用户名烤进 XML，换机或改名即失效。
 * - `<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count>`：进程崩溃后 1 分钟内由任务
 *   计划拉回、至多 3 次——比进程内守护更底层（进程死了也能拉）；间隔 1 分钟防崩溃风暴。
 * - `<Hidden>true</Hidden>`：任务在计划程序默认视图隐藏，防误手工禁用。
 * - `<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`：重复登录触发时已在跑则不
 *   叠加第二个 server 实例。
 * - `<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`：常驻服务**无运行时限**（任务计划缺省
 *   PT72H 会在 72 小时后杀掉进程——对常驻服务是事故）。
 * - `<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>` 与
 *   `<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`：笔记本电池供电也照常常驻。
 * - `<Arguments>` 形态固定为 `--import tsx "<entryJs>" start`：`start` 子命令 = 常驻服务，
 *   **禁止 --watch/dev 形态**；仓内当前无构建步，入口直指 TS 源、经 tsx 加载器运行
 *   （`defaultEntryJs`）；不使用 pnpm——PATH 在任务计划环境无保障，命令必须真实可跑。
 *
 * @param deps.nodeExe - node 可执行文件绝对路径（生产传 `process.execPath`）
 * @param deps.entryJs - 服务入口脚本绝对路径（生产传 `defaultEntryJs()`）
 * @param deps.taskName - 计划任务名；缺省 `DEFAULT_TASK_NAME`
 * @returns 注册计划（任务名 + XML 全文）
 * @throws entryJs 上方无 package.json（无法确定 `--import tsx` 的解析根）
 */
export function installPlan(deps: { nodeExe: string; entryJs: string; taskName?: string }): InstallPlan {
  const taskName = deps.taskName ?? DEFAULT_TASK_NAME;
  const args = "--import tsx \"" + deps.entryJs + "\" start";
  const xml =
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
      "      <Command>" + xmlEscape(deps.nodeExe) + "</Command>",
      "      <Arguments>" + xmlEscape(args) + "</Arguments>",
      "      <WorkingDirectory>" + xmlEscape(packageRootOf(deps.entryJs)) + "</WorkingDirectory>",
      "    </Exec>",
      "  </Actions>",
      "</Task>",
      "",
    ].join("\n");
  return { taskName, xml };
}

/**
 * 服务的缺省入口脚本绝对路径：按本模块位置派生 `src/bin/aimi-server.ts`。
 * why 仓内当前无构建步（无 dist 产物），任务计划直接跑 TS 源、经 `--import tsx` 加载；
 * 将来若引入构建步，应改指 dist 入口并去掉 `--import tsx`（ts 依赖属 devDependencies）。
 *
 * @returns 入口脚本绝对路径
 */
export function defaultEntryJs(): string {
  return fileURLToPath(new URL("../bin/aimi-server.ts", import.meta.url));
}

/** 缺省执行器（生产壳）：真调 `schtasks`（System32 常驻、不依赖 PATH）。 */
async function defaultTaskExec(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return execFile(file, [...args], { windowsHide: true });
}

/** 执行壳的平台守卫：任务计划是 Windows 专属基础设施，非 Windows 直接拒绝（测试经 fake 执行器 + 平台改写覆盖）。 */
function requireWindows(): void {
  if (process.platform !== "win32") throw new Error("仅支持 Windows");
}

/**
 * 向任务计划注册一个计划（`install` 子命令的实现）：
 * XML 写入临时目录（`os.tmpdir()`）后 `schtasks /Create /TN <taskName> /F /XML <临时xml>`，
 * 无论成败临时目录随即删除。`/F` = 同名任务已存在时覆盖——重复 install 幂等。
 *
 * @param plan - `installPlan` 产出的注册计划
 * @param exec - 任务计划执行器；缺省真调 `schtasks`（测试注入 fake）
 * @returns Promise，resolve 表示注册成功
 * @throws 非 Windows（`仅支持 Windows`）；schtasks 非零退出（携带其 stderr 文案）
 * 副作用：系统任务计划新增/覆盖同名任务；临时目录创建并删除
 */
export async function register(plan: InstallPlan, exec: TaskExec = defaultTaskExec): Promise<void> {
  requireWindows();
  const dir = mkdtempSync(join(tmpdir(), "aimi-task-"));
  try {
    const xmlFile = join(dir, "task.xml");
    writeFileSync(xmlFile, plan.xml, "utf8");
    await exec("schtasks", ["/Create", "/TN", plan.taskName, "/F", "/XML", xmlFile]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 从任务计划注销一个计划（`uninstall` 子命令的实现）：**先查后删**——
 * `schtasks /Query` 失败即按「任务不存在」处理（幂等成功、不再尝试删除）；
 * 查得到才 `schtasks /Delete /TN <taskName> /F`，其失败原样抛出。
 *
 * why 不按 stderr 字样判「不存在」（计划原案）：schtasks 控制台输出跟随 OEM 代码页——
 * zh-CN 机器上是 GBK 字节，Node 按 UTF-8 解码成乱码，任何字样匹配都失效（2026-10-18 实测：
 * 真机文案为「系统找不到指定的文件。」而非「不存在」）；且文案随本地化漂移。查询与删除
 * 同权限上下文——查不到的任务本就删不掉，故「查询失败 ⇒ 幂等达成」不额外吞真错误。
 *
 * @param taskName - 计划任务名；缺省 `DEFAULT_TASK_NAME`
 * @param exec - 任务计划执行器；缺省真调 `schtasks`（测试注入 fake）
 * @returns Promise，resolve 表示已卸载或本就不存在
 * @throws 非 Windows（`仅支持 Windows`）；查询命中但删除失败（如权限拒绝）
 * 副作用：系统任务计划删除同名任务（存在时）
 */
export async function unregister(taskName: string = DEFAULT_TASK_NAME, exec: TaskExec = defaultTaskExec): Promise<void> {
  requireWindows();
  const present = await exec("schtasks", ["/Query", "/TN", taskName, "/FO", "LIST"]).then(
    () => true,
    () => false,
  );
  if (!present) return;
  await exec("schtasks", ["/Delete", "/TN", taskName, "/F"]);
}
