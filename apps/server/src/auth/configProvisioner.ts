import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { DeviceRepository } from "../persistence/types.js";

/** 单个 LAN 凭证：明文只在此结构里短暂存在，落盘持久化由 `ConfigProvisioner` 负责。 */
export interface LanTokenCredential {
  readonly token: string;
  readonly sha256: string;
  readonly deviceId: string;
}

/** M0 唯一设备的固定名字（一次配对一次登记；M1 由 QR 配对取代时移除）。 */
const LAN_DEVICE_NAME = "lan-default";

/** 明文令牌的 SHA-256 十六进制摘要（与 `DeviceRepository` 存储契约一致）。 */
function sha256hex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * M0 配对替代（设计 §16 的一次性凭证精神 + 已记录的 M0 偏差：
 * 明文落盘本地文件，M1 由 QR 配对取代——故本类的存在期止于 M1）。
 *
 * 幂等：token 文件存在 → 读明文、校验/补建设备行、返回同一凭证；
 * 不存在 → 生成 32B random → base64url(43 字符) → `put` 登记 → 明文写入 tokenFile。
 * 连续两次调用必然返回同一 token 与同一 deviceId。
 */
export class ConfigProvisioner {
  /**
   * @param deviceRepo 设备令牌面；`put` 生成 deviceId，明文不进本层。
   * @param tokenFile 明文令牌文件路径（M0 偏差：本地明文，权限按 Node 默认）。
   */
  constructor(
    private readonly deviceRepo: DeviceRepository,
    private readonly tokenFile: string,
  ) {}

  /** 读取或生成 LAN 凭证；文件在则复用、不在则生成并落盘（幂等）。 */
  async ensureLanToken(): Promise<LanTokenCredential> {
    if (existsSync(this.tokenFile)) {
      const token = readFileSync(this.tokenFile, "utf8").trim();
      const sha256 = sha256hex(token);
      const existing = await this.deviceRepo.findByTokenHash(sha256);
      // 文件在而设备行缺失（例如库被清）→ 用同一明文补建，避免令牌失效。
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
