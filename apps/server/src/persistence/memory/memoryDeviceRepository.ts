import { randomUUID } from "node:crypto";
import type { DeviceRecord, DeviceRepository } from "../types.js";

/** 内存态设备行；字段与 sqlite `devices` 表一一对应（Task 5 同契约）。 */
interface StoredDevice {
  readonly id: string;
  readonly name: string;
  readonly tokenSha256: string;
  revokedAt: number | null;
  readonly lastSeenAt: number;
}

/**
 * DeviceRepository 的内存实现（测试专用）。
 * 只存令牌的 SHA-256 哈希：明文令牌永不进入本层，故内存转储也不泄露凭据。
 */
export class MemoryDeviceRepository implements DeviceRepository {
  private readonly devices = new Map<string, StoredDevice>();

  /** 内存态无 schema，no-op。 */
  async init(): Promise<void> {
    /* no-op */
  }

  /**
   * id 用 uuid（与 sqlite 一致：落库前生成，不依赖自增）；lastSeenAt 取登记时刻。
   * 同一 `tokenSha256` 二次登记抛错——与 Sqlite 的 UNIQUE 约束同语义（一次配对一次登记）；
   * 先查后插在内存下同步完成，无竞态。
   */
  async put(name: string, tokenSha256: string): Promise<string> {
    for (const device of this.devices.values()) {
      if (device.tokenSha256 === tokenSha256) {
        throw new Error("device token already registered: " + tokenSha256);
      }
    }
    const id = randomUUID();
    this.devices.set(id, { id, name, tokenSha256, revokedAt: null, lastSeenAt: Date.now() });
    return id;
  }

  /** 命中且未吊销才放行；已吊销等同不存在（认证入口只需一个 null 分支）。 */
  async findByTokenHash(tokenSha256: string): Promise<{ id: string; name: string } | null> {
    for (const device of this.devices.values()) {
      if (device.tokenSha256 === tokenSha256 && device.revokedAt === null) {
        return { id: device.id, name: device.name };
      }
    }
    return null;
  }

  /** 未知 id 静默 no-op（M0 无消费方，不制造多一个错误路径）。 */
  async revoke(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (device !== undefined) device.revokedAt = Date.now();
  }

  /** 不区分吊销状态：M0 只冻结取值，由消费方自行过滤。 */
  async list(): Promise<DeviceRecord[]> {
    return [...this.devices.values()].map((d) => ({ id: d.id, name: d.name, lastSeenAt: d.lastSeenAt }));
  }

  /** 内存态无资源可释放；no-op。 */
  async close(): Promise<void> {
    /* no-op */
  }
}
