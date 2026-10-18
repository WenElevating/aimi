import { randomUUID } from "node:crypto";
import type { MetaRepository } from "../persistence/types.js";

/** meta_kv 中 server_id 的键名：本机 aimi 服务的稳定标识（QR payload 字段，手机据此区分多台服务）。 */
export const SERVER_ID_KEY = "server_id";

/**
 * 读取（首见则生成）本服务的稳定标识：meta_kv 键 `server_id`，randomUUID 生成后永久复用。
 * why 落库不放内存：CLI `aimi-server pair` 与运行服务是**不同进程**，每次出码必须报告同一个
 * serverId，手机端才能把扫码结果关联到同一台服务（review §3.3 跨进程共库语义）。
 *
 * @param meta - meta_kv 键值仓储（sqlite 生产实现 / memory 测试实现）
 * @returns Promise，resolve 为本服务的稳定标识（UUID 文本）
 * 副作用：首见时写一行 meta_kv（UPSERT，值此后不变）
 */
export async function ensureServerId(meta: MetaRepository): Promise<string> {
  const existing = await meta.get(SERVER_ID_KEY);
  if (existing !== null) return existing;
  const id = randomUUID();
  await meta.set(SERVER_ID_KEY, id);
  return id;
}
