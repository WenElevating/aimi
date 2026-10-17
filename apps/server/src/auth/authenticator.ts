import { createHash } from "node:crypto";
import type { AuditWriter } from "../audit/auditWriter.js";
import type { DeviceRepository } from "../persistence/types.js";

/** 设备身份投影：认证通过后交给上层的最小信息（不含令牌/哈希）。 */
export interface DeviceIdentity {
  readonly deviceId: string;
  readonly name: string;
}

/**
 * 鉴权中枢：通道无关的决策。
 * 连接握手时与逐帧处理时都会用到——
 * 故本接口只描述「明文 token → 身份」这一件事，不绑定任何传输通道。
 */
export interface Authenticator {
  /**
   * 校验明文 token：SHA-256 后查表，已吊销/不存在 → 返回 null 并记 `auth_fail` 审计；
   * 命中返回设备身份（刷新设备最近活动时间不在本层职责内）。
   * 不抛：任何查表失败都收敛为 null（调用方只需一个拒绝分支）。
   */
  verifyToken(token: string, remote: string): Promise<DeviceIdentity | null>;
}

/** 明文令牌的 SHA-256 十六进制摘要（存储侧只认哈希，与 `DeviceRepository` 契约一致）。 */
function sha256hex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * `Authenticator` 默认实现：哈希后委托给 `DeviceRepository.findByTokenHash`。
 * 失败路径落审计（`auth.auth_fail`，detail 记远端地址以便排障），成功路径不落审计。
 */
export class DefaultAuthenticator implements Authenticator {
  /**
   * @param deviceRepo 设备令牌面（只存哈希）；读写均在此层完成。
   * @param audit 审计出口；鉴权失败经它落 `auth.auth_fail`。
   */
  constructor(
    private readonly deviceRepo: DeviceRepository,
    private readonly audit: AuditWriter,
  ) {}

  /** 明文 → SHA-256 → 查活设备；未命中先记审计再返回 null（顺序固定：审计与拒绝同因）。 */
  async verifyToken(token: string, remote: string): Promise<DeviceIdentity | null> {
    const found = await this.deviceRepo.findByTokenHash(sha256hex(token));
    if (found === null) {
      await this.audit.auth("auth_fail", "remote=" + remote);
      return null;
    }
    return { deviceId: found.id, name: found.name };
  }
}
