import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { appUpdateManifest, type AppUpdateManifest } from "@aimi/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * 磁盘发布清单（`{dataDir}/updates/manifest.json`）的结构契约：
 * 在协议 `AppUpdateManifest` 之上追加 `publishedAt`（发布时刻，人读/运维面），
 * 下发给手机的 update.info 帧会剔除该字段——协议形状由 zod schema 单一源保证。
 */
export const diskUpdateManifest = appUpdateManifest.extend({ publishedAt: z.number() });

/** 磁盘发布清单类型；导出给发布 CLI 与测试复用同一契约。 */
export type DiskUpdateManifest = z.infer<typeof diskUpdateManifest>;

/** APK 的 HTTP Content-Type（Android 包管理器依赖它识别安装源）。 */
const APK_CONTENT_TYPE = "application/vnd.android.package-archive";

/** 更新目录内的 APK 文件名（与 downloadPath 的 basename 一致）：`app-{versionCode}.apk`。 */
export function apkFileNameOf(versionCode: number): string {
  return `app-${versionCode}.apk`;
}

/** 从磁盘清单投影出协议帧的 latest 字段（剔除 publishedAt）。 */
export function toFrameManifest(disk: DiskUpdateManifest): AppUpdateManifest {
  const { publishedAt: _publishedAt, ...rest } = disk;
  return rest;
}

/** 组装 update.info 帧（唯一形态，避免各处手写字段漂移）。 */
export function updateInfoFrame(latest: AppUpdateManifest | null): { v: 1; type: "update.info"; latest: AppUpdateManifest | null } {
  return { v: 1, type: "update.info", latest };
}

/** 判定远端地址是否 loopback（内部 refresh 端点只接受本机来源）。 */
function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * 更新发布通道（app 层编排组件）：维护最新发布清单的内存缓存，并在 LanWsServer 的
 * HTTP 面上提供两个端点——
 * - `GET /updates/{file}?token=...`：APK 下载（token 复用 WS 握手同一 `verifyToken` 路径）；
 * - `POST /internal/updates/refresh`：发布 CLI 的本机通知（仅 loopback），触发清单重读与
 *   `onChanged` 广播回调。
 *
 * 发布状态只存于 `{dataDir}/updates/`（manifest.json + APK 文件），CLI 与运行服务跨进程
 * 共享该目录即可，不经过 SQLite。清单缺失/损坏一律降级为「无发布」（latest null），
 * 绝不阻断服务启动。
 */
export class UpdateFeed {
  readonly #dir: string;
  readonly #manifestPath: string;
  readonly #verifyToken: (token: string, remote: string) => Promise<unknown | null>;
  readonly #onChanged: (latest: AppUpdateManifest | null) => void;
  readonly #log: (level: "warn" | "info", msg: string, extra?: Record<string, unknown>) => void;
  #current: AppUpdateManifest | null = null;

  /**
   * @param opts.dataDir - 服务数据目录；更新文件位于 `{dataDir}/updates/`
   * @param opts.verifyToken - 与 WS hello 同源的 token 校验（下载端点鉴权复用）
   * @param opts.onChanged - 清单版本变化时的回调（Application 注入向在线连接广播）
   * @param opts.log - 结构化日志出口（仅 warn/info 两级，读失败留痕不抛出）
   */
  constructor(opts: {
    dataDir: string;
    verifyToken: (token: string, remote: string) => Promise<unknown | null>;
    onChanged: (latest: AppUpdateManifest | null) => void;
    log?: (level: "warn" | "info", msg: string, extra?: Record<string, unknown>) => void;
  }) {
    this.#dir = join(opts.dataDir, "updates");
    this.#manifestPath = join(this.#dir, "manifest.json");
    this.#verifyToken = opts.verifyToken;
    this.#onChanged = opts.onChanged;
    this.#log = opts.log ?? ((): void => {});
  }

  /** 当前缓存的最新发布清单；null = 从未发布或清单不可用。 */
  current(): AppUpdateManifest | null {
    return this.#current;
  }

  /** 更新文件目录（发布 CLI 与测试据此落盘同一路径）。 */
  get updatesDir(): string {
    return this.#dir;
  }

  /**
   * 重读磁盘清单并刷新缓存；versionCode 变化（含出现/消失）时触发 `onChanged`。
   * 任何读失败（文件不存在、JSON 损坏、契约不符）都收敛为 null + warn 日志，绝不抛出。
   *
   * @returns Promise，resolve 为重读后的最新清单（null = 无有效发布）
   */
  async refresh(): Promise<AppUpdateManifest | null> {
    let next: AppUpdateManifest | null = null;
    try {
      const raw = JSON.parse(await readFile(this.#manifestPath, "utf8")) as unknown;
      next = toFrameManifest(diskUpdateManifest.parse(raw));
    } catch (err) {
      // 文件不存在是常态（从未发布）；损坏/越界才值得留痕。ENOENT 不刷屏。
      if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) {
        this.#log("warn", "update manifest unusable", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (next?.versionCode !== this.#current?.versionCode) {
      this.#current = next;
      this.#onChanged(next);
    }
    return next;
  }

  /**
   * LanWsServer.onRequest 注入的 HTTP 处理器：路由 APK 下载与本机 refresh 通知，
   * 其余路径 404。任何未预期异常收敛为 500（响应已开始写则只断开）。
   *
   * @param req - 底层请求
   * @param res - 底层响应（处理器保证每个请求都被结束）
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://aimi.internal");
      if (req.method === "GET" && url.pathname.startsWith("/updates/")) {
        await this.#serveApk(url, req, res);
        return;
      }
      if (req.method === "POST" && url.pathname === "/internal/updates/refresh") {
        await this.#serveRefresh(req, res);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    } catch (err) {
      this.#log("warn", "update http handler failed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      res.destroy();
    }
  }

  /**
   * APK 下载端点：token 鉴权（与 WS hello 同一校验路径）→ 文件名必须与当前清单匹配
   * （防路径穿越与盗链任意文件）→ 以实际 stat 尺寸流式回包。
   */
  async #serveApk(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remote = `${req.socket.remoteAddress ?? "unknown"}:${req.socket.remotePort ?? 0}`;
    const file = decodeURIComponent(url.pathname.slice("/updates/".length));
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file) || file.includes("..")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const manifest = this.#current;
    if (manifest === null || file !== manifest.downloadPath.split("/").pop()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const token = url.searchParams.get("token");
    if (token === null || (await this.#verifyToken(token, remote)) === null) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    let st;
    try {
      st = await stat(join(this.#dir, file));
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": APK_CONTENT_TYPE, "Content-Length": st.size });
    createReadStream(join(this.#dir, file)).pipe(res);
  }

  /**
   * 本机 refresh 端点：仅接受 loopback 来源（发布 CLI 就在本机执行），重读清单并把
   * 结果（含 versionCode）回给 CLI 作确认。非 loopback 一律 403。
   */
  async #serveRefresh(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("forbidden");
      return;
    }
    const latest = await this.refresh();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ versionCode: latest?.versionCode ?? null }));
  }
}
