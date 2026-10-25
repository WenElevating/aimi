import type { PermissionModeDescriptor } from "@aimi/protocol";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

/** SDK 未提供模式枚举查询 API；此目录对应当前公开 PermissionMode 类型，不能代表运行时授权。 */
export const CLAUDE_PERMISSION_MODES: readonly PermissionModeDescriptor[] = [
  {
    id: "default",
    name: "默认审批",
    description: "使用 Claude 默认审批规则，需要确认时交由手机处理",
    availability: "available",
  },
  { id: "plan", name: "计划模式", description: "分析与规划，不直接执行修改", availability: "available" },
  {
    id: "acceptEdits",
    name: "自动接受编辑",
    description: "自动接受文件编辑，其他操作遵循审批规则",
    availability: "available",
  },
  {
    id: "bypassPermissions",
    name: "完全放行",
    description: "跳过工具审批，需要电脑端明确允许",
    availability: "available",
  },
  { id: "dontAsk", name: "禁止询问", description: "未获现有规则授权的工具请求直接拒绝", availability: "available" },
  {
    id: "auto",
    name: "自动判断",
    description: "由 Claude 判断工具授权，可用性受模型、提供商和策略限制",
    availability: "unknown",
    reason: "需当前模型和提供商确认",
  },
];

/** 用公开 SDK 类型逐项校验，禁止把未经识别的 agent 标识强转给 SDK。 */
export function claudePermissionMode(mode: string): PermissionMode {
  switch (mode) {
    case "default":
    case "plan":
    case "acceptEdits":
    case "bypassPermissions":
    case "dontAsk":
    case "auto":
      return mode;
    default:
      throw new Error("unsupported Claude permission mode: " + mode);
  }
}
