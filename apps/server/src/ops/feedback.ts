import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ServerConfig } from "../app/config.js";

/** 一条反馈的只读投影（CLI list/show 的数据面）。 */
export interface FeedbackEntry {
  readonly id: string;
  readonly deviceId: string;
  readonly desc: string;
  readonly app: { version: string; build: string; platform: string };
  readonly images: { originalName: string; file: string }[];
  readonly hasLog: boolean;
  readonly dir: string;
}

/** 反馈根目录（与 FeedbackChannel 同一定位）。 */
function feedbackDir(cfg: ServerConfig): string {
  return join(cfg.dataDir, "feedback");
}

/**
 * 列出全部反馈（按 id 字符串降序 = 时间新→旧；id 含时间戳段，字典序即时间序）。
 * 损坏的 meta.json 跳过不阻断列表（附 stderr 留痕由调用方决定；此处静默跳过）。
 *
 * @param cfg - 服务配置（定位 dataDir）
 * @returns Promise，resolve 为反馈条目列表
 */
export async function listFeedback(cfg: ServerConfig): Promise<FeedbackEntry[]> {
  const root = feedbackDir(cfg);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const entries: FeedbackEntry[] = [];
  for (const name of names.sort().reverse()) {
    try {
      const meta = JSON.parse(await readFile(join(root, name, "meta.json"), "utf8")) as {
        id?: unknown;
        deviceId?: unknown;
        desc?: unknown;
        app?: { version?: unknown; build?: unknown; platform?: unknown };
        images?: { originalName: unknown; file: unknown }[];
        hasLog?: unknown;
      };
      if (typeof meta.id !== "string" || typeof meta.desc !== "string") continue;
      entries.push({
        id: meta.id,
        deviceId: typeof meta.deviceId === "string" ? meta.deviceId : "-",
        desc: meta.desc,
        app: {
          version: typeof meta.app?.version === "string" ? meta.app.version : "-",
          build: typeof meta.app?.build === "string" ? meta.app.build : "-",
          platform: typeof meta.app?.platform === "string" ? meta.app.platform : "-",
        },
        images: Array.isArray(meta.images)
          ? meta.images
              .filter((i) => typeof i?.originalName === "string" && typeof i?.file === "string")
              .map((i) => ({ originalName: i.originalName as string, file: i.file as string }))
          : [],
        hasLog: meta.hasLog === true,
        dir: join(root, name),
      });
    } catch {
      // 损坏条目跳过：列表可用性优先。
    }
  }
  return entries;
}

/**
 * 读取单条反馈；不存在或 meta 损坏抛错（CLI 按退出码 1 呈现）。
 *
 * @param cfg - 服务配置
 * @param id - 反馈 id（目录名）
 * @returns Promise，resolve 为反馈条目
 * @throws 目录/meta 不存在或损坏时抛错
 */
export async function showFeedback(cfg: ServerConfig, id: string): Promise<FeedbackEntry> {
  const dir = join(feedbackDir(cfg), id);
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as {
    id: string;
    deviceId: string;
    desc: string;
    app: { version: string; build: string; platform: string };
    images?: { originalName: string; file: string }[];
    hasLog?: boolean;
  };
  return {
    id: meta.id,
    deviceId: meta.deviceId,
    desc: meta.desc,
    app: meta.app,
    images: meta.images ?? [],
    hasLog: meta.hasLog === true,
    dir,
  };
}
