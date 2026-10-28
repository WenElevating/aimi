import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerConfig } from "../app/config.js";

/** 反馈处理状态：new（未看）/ acked（已认领）/ done（已闭环）；缺省 new。 */
export type FeedbackStatus = "new" | "acked" | "done";

/** status 合法值集合（meta.status 值域外的取值按 new 兜底）。 */
const FEEDBACK_STATUSES: readonly FeedbackStatus[] = ["new", "acked", "done"];

/** 从 meta 的未知形态归一化 status；缺省/非法一律 new（旧数据与容错口径）。 */
function parseStatus(value: unknown): FeedbackStatus {
  return FEEDBACK_STATUSES.find((s) => s === value) ?? "new";
}

/** 一条反馈的只读投影（CLI list/show 的数据面）。 */
export interface FeedbackEntry {
  readonly id: string;
  readonly deviceId: string;
  readonly desc: string;
  readonly app: { version: string; build: string; platform: string };
  readonly images: { originalName: string; file: string }[];
  readonly hasLog: boolean;
  /** 处理状态（见 [FeedbackStatus]）；旧 meta.json 缺字段时为 new。 */
  readonly status: FeedbackStatus;
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
        status?: unknown;
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
        status: parseStatus(meta.status),
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
    status?: unknown;
  };
  return {
    id: meta.id,
    deviceId: meta.deviceId,
    desc: meta.desc,
    app: meta.app,
    images: meta.images ?? [],
    hasLog: meta.hasLog === true,
    status: parseStatus(meta.status),
    dir,
  };
}

/**
 * 回写反馈处理状态：读改写 meta.json（tmp+rename 原子替换，与 FeedbackChannel
 * 同模式），除 status 外的字段原样保留。旧 meta 无 status 字段时补写该键。
 *
 * @param cfg - 服务配置
 * @param id - 反馈 id（目录名）
 * @param status - 目标状态（调用方保证取值；非法值在此按类型约束拒绝）
 * @throws 目录或 meta.json 不存在/损坏时抛错（CLI 按退出码 1 呈现）
 */
export async function setFeedbackStatus(cfg: ServerConfig, id: string, status: FeedbackStatus): Promise<void> {
  const dir = join(feedbackDir(cfg), id);
  const metaPath = join(dir, "meta.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
  meta.status = status;
  const tmp = `${metaPath}.tmp`;
  await writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
  await rename(tmp, metaPath);
}
