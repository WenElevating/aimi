import { randomUUID } from "node:crypto";
import type { DeviceRecord, DeviceRepository } from "../types.js";
import { PAIRING_CODE_MAX_RETRIES, PAIRING_TTL_MS, randomPairingCode } from "../pairingCode.js";

/** 内存态设备行；字段与 sqlite `devices` 表一一对应。 */
interface StoredDevice {
  readonly id: string;
  readonly name: string;
  readonly tokenSha256: string;
  revokedAt: number | null;
  lastSeenAt: number;
}

/** 内存态配对码行；字段与 sqlite `pairing_codes` 表一一对应。 */
interface StoredPairingCode {
  readonly createdAt: number;
  readonly expiresAt: number;
  usedAt: number | null;
}

/**
 * DeviceRepository 的内存实现（测试专用）。
 * 只存令牌的 SHA-256 哈希：明文令牌永不进入本层，故内存转储也不泄露凭据。
 * 配对码与 Sqlite 实现同一套 TTL/重试/预判-原子裁定语义（契约一致性由公共常量与测试循环保证）。
 */
export class MemoryDeviceRepository implements DeviceRepository {
  private readonly devices = new Map<string, StoredDevice>();
  private readonly pairingCodes = new Map<string, StoredPairingCode>();
  private readonly now: () => number;
  private readonly code: () => string;

  /**
   * @param opts - 测试注入口：`now` 可控时钟（markSeen/配对期限断言用）、`code` stub 码源
   *   （唯一冲突重试路径用）；缺省取系统时钟与 crypto 随机，与生产形态零分叉
   */
  constructor(opts?: { now?: () => number; code?: () => string }) {
    this.now = opts?.now ?? Date.now;
    this.code = opts?.code ?? randomPairingCode;
  }

  /** 内存态无 schema，no-op。 */
  async init(): Promise<void> {
    /* no-op */
  }

  /**
   * id 用 uuid（与 sqlite 一致：落库前生成，不依赖自增）；lastSeenAt 取登记时刻。
   * 同一 `tokenSha256` 二次登记抛错——唯一性由实现保证（一次配对一次登记）；
   * 先查后插在内存下同步完成，无竞态。
   *
   * @param name - 设备展示名
   * @param tokenSha256 - 令牌的 SHA-256 十六进制哈希
   * @returns Promise，resolve 为新设备的 deviceId
   * @throws 该哈希已登记过时抛出 `device token already registered`
   */
  async put(name: string, tokenSha256: string): Promise<string> {
    for (const device of this.devices.values()) {
      if (device.tokenSha256 === tokenSha256) {
        throw new Error("device token already registered: " + tokenSha256);
      }
    }
    const id = randomUUID();
    this.devices.set(id, { id, name, tokenSha256, revokedAt: null, lastSeenAt: this.now() });
    return id;
  }

  /**
   * 命中且未吊销才放行；已吊销等同不存在（认证入口只需一个 null 分支）。
   *
   * @param tokenSha256 - 令牌的 SHA-256 十六进制哈希
   * @returns Promise，resolve 为命中的设备（id/name）；未命中或已吊销时为 null
   */
  async findByTokenHash(tokenSha256: string): Promise<{ id: string; name: string } | null> {
    for (const device of this.devices.values()) {
      if (device.tokenSha256 === tokenSha256 && device.revokedAt === null) {
        return { id: device.id, name: device.name };
      }
    }
    return null;
  }

  /**
   * 未知 id 静默 no-op（不制造多一个错误路径）。
   *
   * @param deviceId - 目标设备
   * @returns Promise，resolve 表示已处理（未知 id 亦 resolve）
   */
  async revoke(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (device !== undefined) device.revokedAt = this.now();
  }

  /**
   * 不区分吊销状态：由消费方自行过滤；投影带 `revokedAt`（与 Sqlite 同一读面）。
   *
   * @returns Promise，resolve 为设备记录数组
   */
  async list(): Promise<DeviceRecord[]> {
    return [...this.devices.values()].map((d) => ({
      id: d.id,
      name: d.name,
      lastSeenAt: d.lastSeenAt,
      revokedAt: d.revokedAt,
    }));
  }

  /**
   * 更新最近活跃时刻；未知 id 静默 no-op，与 Sqlite 同口径。
   *
   * @param deviceId - 目标设备
   * @returns Promise，resolve 表示更新已执行（未知 id 亦 resolve）
   */
  async markSeen(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (device !== undefined) device.lastSeenAt = this.now();
  }

  /**
   * 身份到投影的解析（**不隐藏吊销行**——吊销巡检与设备列表都要读 `revokedAt`）。
   *
   * @param deviceId - 目标设备
   * @returns Promise，resolve 为设备投影；未登记时为 null
   */
  async findById(deviceId: string): Promise<{ id: string; name: string; revokedAt: number | null } | null> {
    const device = this.devices.get(deviceId);
    return device === undefined ? null : { id: device.id, name: device.name, revokedAt: device.revokedAt };
  }

  /**
   * 签发配对码：随机 8 位数字 + `PAIRING_TTL_MS` 有效期，登记进码表。
   * 同码冲突换码重试至上限（与 Sqlite 的 UNIQUE 兜底同语义——生成与重试上限共享同一常量源）。
   *
   * @param opts - `now` 注入时钟（测试）；缺省取系统时钟
   * @returns Promise，resolve 为新码与绝对过期时刻（毫秒）
   * @throws 冲突重试耗尽时抛出（码空间被 stub 病态占满的情形）
   */
  async issuePairingCode(opts?: { now?: () => number }): Promise<{ code: string; expiresAt: number }> {
    const at = (opts?.now ?? this.now)();
    const expiresAt = at + PAIRING_TTL_MS;
    for (let attempt = 0; attempt <= PAIRING_CODE_MAX_RETRIES; attempt++) {
      const code = this.code();
      if (this.pairingCodes.has(code)) continue;
      this.pairingCodes.set(code, { createdAt: at, expiresAt, usedAt: null });
      return { code, expiresAt };
    }
    throw new Error("pairing code collision persisted");
  }

  /**
   * 核销配对码：先查码行预判四态（unknown/expired/used），再同步原子翻转 `usedAt`——
   * 内存下单线程"SELECT+翻转"天然不可分割，语义与 Sqlite 的原子 UPDATE 裁定等价
   * （并发双消费时后到者见 used_at 已置 → "used"）。
   *
   * @param code - 待核销的配对码
   * @param opts - `now` 注入时钟（测试）；缺省取系统时钟
   * @returns Promise，resolve 为 "ok" | "unknown" | "expired" | "used"
   */
  async consumePairingCode(code: string, opts?: { now?: () => number }): Promise<"ok" | "unknown" | "expired" | "used"> {
    const at = (opts?.now ?? this.now)();
    const row = this.pairingCodes.get(code);
    if (row === undefined) return "unknown";
    if (row.usedAt !== null) return "used"; // 预判只定文案，裁定权在翻转瞬间
    if (row.expiresAt <= at) return "expired";
    row.usedAt = at;
    return "ok";
  }

  /** 内存态无资源可释放；no-op。 */
  async close(): Promise<void> {
    /* no-op */
  }
}
