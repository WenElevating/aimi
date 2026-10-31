import type { PermissionModeDescriptor } from "@aimi/protocol";

/**
 * zcode 权限档位目录（zcode CLI `--mode` 的五个原生档位，官方文档化语义）。
 *
 * headless（`--prompt` 批处理）没有审批客户端：需要 ask 的工具调用会直接失败
 * （zcode 报 `No permission client configured`，工具失败后模型继续跑）——因此
 * `build`/`guarded` 这两个含 ask 语义的档位在 Aimi 里是「受限可用」而非不可用：
 * 手机侧表现为工具卡失败，会话不中断。
 */
export const ZCODE_PERMISSION_MODES: readonly PermissionModeDescriptor[] = [
  {
    id: "plan",
    name: "计划模式",
    description: "只读分析，限制写入与命令执行",
    availability: "available",
  },
  {
    id: "build",
    name: "构建模式",
    description: "常规写入与有副作用的工具需审批（headless 下审批不可用，将工具失败）",
    availability: "available",
  },
  {
    id: "edit",
    name: "编辑模式",
    description: "工作区文件编辑免审批，其余沿用构建判定",
    availability: "available",
  },
  {
    id: "guarded",
    name: "谨慎模式",
    description: "宽松执行但危险命令需逐次批准（headless 下将工具失败）",
    availability: "available",
  },
  {
    id: "yolo",
    name: "完全放行",
    description: "跳过权限提示，适合无人值守任务",
    availability: "available",
  },
];

/** zcode 会话的缺省档位：手机新建会话未显式指定时使用（用户裁决 edit，非 yolo）。 */
export const ZCODE_DEFAULT_PERMISSION_MODE = "edit";

/** 白名单校验：未知档位拒绝（SessionManager 会对该 agent 的模式目录校验，此函数供会话侧兜底）。 */
export function isZcodePermissionMode(mode: string): boolean {
  return ZCODE_PERMISSION_MODES.some((descriptor) => descriptor.id === mode);
}
