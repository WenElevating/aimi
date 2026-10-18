import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { DeviceRepository } from "../persistence/types.js";

/** 单个 LAN 凭证：明文只在此结构里短暂存在，落盘持久化由 `ConfigProvisioner` 负责。 */
export interface LanTokenCredential {
  /** 明文令牌（base64url，43 字符），仅用于运维者拷入手机 */
  readonly token: string;
  /** 明文的 SHA-256 十六进制摘要，库中只存它、不存明文 */
  readonly sha256: string;
  /** 登记设备的标识，与令牌一对一 */
  readonly deviceId: string;
}

/** LAN 设备的固定名字：一次配对只登记一台设备。 */
const LAN_DEVICE_NAME = "lan-default";

/** 明文令牌的 SHA-256 十六进制摘要（与 `DeviceRepository` 存储契约一致）。 */
function sha256hex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * LAN 配对凭证的本地供给：为这台机器生成一次性明文令牌并登记对应设备。
 * 明文落盘到本地文件（权限按 Node 默认），供运维者拷入手机。
 *
 * 幂等：令牌文件已存在时读取其明文、校验或补建设备行，返回同一凭证；文件不存在时用密码学随机数
 * 生成 32 字节、编码为 base64url 明文，登记设备行后写入令牌文件。
 * 连续两次调用必然返回同一 token 与同一 deviceId。
 */
export class ConfigProvisioner {
  /**
   * @param deviceRepo - 设备令牌面；登记设备时生成 deviceId，明文不进本层
   * @param tokenFile - 明文令牌文件路径（本地明文，权限按 Node 默认）
   */
  constructor(
    private readonly deviceRepo: DeviceRepository,
    private readonly tokenFile: string,
  ) {}

  /**
   * 读取或生成 LAN 凭证：令牌文件已存在时复用，否则生成并落盘（幂等）。
   *
   * @returns Promise，resolve 为本次生效的凭证（明文令牌、哈希与设备标识）
   * 副作用：首次调用写令牌文件并新增设备行；文件在而设备行缺失时补建设备行
   */
  async ensureLanToken(): Promise<LanTokenCredential> {
    if (existsSync(this.tokenFile)) {
      const token = readFileSync(this.tokenFile, "utf8").trim();
      const sha256 = sha256hex(token);
      const existing = await this.deviceRepo.findByTokenHash(sha256);
      // 文件在而设备行缺失（例如库被清）时用同一明文补建，避免令牌失效。
      const deviceId = existing !== null ? existing.id : await this.deviceRepo.put(LAN_DEVICE_NAME, sha256);
      return { token, sha256, deviceId };
    }
    const token = randomBytes(32).toString("base64url");
    const sha256 = sha256hex(token);
    const deviceId = await this.deviceRepo.put(LAN_DEVICE_NAME, sha256);
    writeFileSync(this.tokenFile, token + "\n", "utf8");
    return { token, sha256, deviceId };
  }
}
