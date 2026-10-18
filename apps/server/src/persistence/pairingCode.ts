import { randomInt } from "node:crypto";

/**
 * 配对码有效期（毫秒）：5 分钟。why：足够人工完成一次"服务端出码 → 手机输入"的往返，
 * 又短到一张被旁观/截屏带走的码不会长期可用——一次性核销 + 短时效双保险。
 */
export const PAIRING_TTL_MS = 5 * 60_000;

/** 配对码位数（10^8 组合）。why：手机侧键入成本最低的纯数字串；5min 窗口内的无凭据猜测在 10^8 空间不可行。 */
export const PAIRING_CODE_DIGITS = 8;

/** 同码 UNIQUE 冲突的重试上限。why：碰撞概率约 10^-8/发，重试只是一致性兜底（含测试 stub 注入撞库），上限防病态循环。 */
export const PAIRING_CODE_MAX_RETRIES = 3;

/**
 * 生成一次 8 位数字配对码（含前导零）。
 * why `randomInt`：取值均匀且非可预测序列——配对码是入口凭据，Math.random 类实现可被复现推算。
 *
 * @returns 8 位数字字符串（形如 "01234567"，可为全零）
 */
export function randomPairingCode(): string {
  return String(randomInt(0, 10 ** PAIRING_CODE_DIGITS)).padStart(PAIRING_CODE_DIGITS, "0");
}
