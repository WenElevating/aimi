import type { PermissionModeDescriptor } from "@aimi/protocol";

/** 旧上限仅用于兼容迁移，新 agent 使用显式授权集合。 */
const LEGACY_MODES: Readonly<Record<string, readonly string[]>> = {
  default: ["default"],
  plan: ["default", "plan"],
  acceptEdits: ["default", "plan", "acceptEdits"],
  bypassPermissions: ["default", "plan", "acceptEdits", "bypassPermissions"],
};

/** 将旧配置转为集合；未知上限保持拒绝，不借排序推断权限。 */
export function allowedModes(ceiling: string, explicit: readonly string[] | undefined): ReadonlySet<string> {
  return new Set(explicit ?? Object.entries(LEGACY_MODES).find(([id]) => id === ceiling)?.[1] ?? []);
}

/** 缺少新能力接口的既有适配器仅支持旧协议已定义的四种模式。 */
export function legacyPermissionModes(): readonly PermissionModeDescriptor[] {
  return ["default", "plan", "acceptEdits", "bypassPermissions"].map((id) => ({
    id,
    name: id,
    description: "既有适配器权限模式",
    availability: "available" as const,
  }));
}

/** 策略是最终授权，不能被 agent 的 available 描述覆盖。 */
export function applyPermissionPolicy(
  modes: readonly PermissionModeDescriptor[],
  allowed: ReadonlySet<string>,
): readonly PermissionModeDescriptor[] {
  return modes.map((mode) =>
    allowed.has(mode.id)
      ? mode
      : {
          ...mode,
          availability: "unavailable",
          reason: "电脑端策略未允许此权限模式",
        },
  );
}
