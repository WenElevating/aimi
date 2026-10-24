import { spawn } from "node:child_process";

/**
 * 终止一个进程**树**（Windows 下经 shell 拉起时，直接子进程可能是 `cmd.exe`、
 * 目标本体是孙进程——只杀 shell 会遗弃孙进程）。
 *
 * **永不抛**：pid 缺失/已退出（ESRCH）/权限不足（EPERM）时静默降级——终止是尽力而为，
 * 不该把收尾路径的失败升级成会话流程的异常。Windows 无优雅信号可用，一律 `taskkill /T /F`。
 *
 * @param pid - 目标进程 pid；`undefined` 时什么都不做
 * @param signal - 非 Windows 下先发的信号（缺省 `SIGTERM`；强杀时传 `SIGKILL`）
 */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      .on("error", () => { /* taskkill 不可用（罕见）：终止失败不阻塞收尾 */ });
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* 已退出/无权限：尽力而为 */
  }
}
