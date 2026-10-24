import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";

/** 反馈描述字符上限（与移动端表单同口径）。 */
const DESC_MAX = 4000;

/** 图片张数上限（对齐业界 4 附件惯例）。 */
const IMAGE_MAX_COUNT = 4;

/** 单个 base64 字段（图片/日志 zip）的字符上限（≈1.5MB 二进制）。 */
const FIELD_B64_MAX = 2_000_000;

/** 请求体总大小上限（字节）：4 图 + zip 的 base64 量级宽裕兜底。 */
const BODY_MAX_BYTES = 24 * 1024 * 1024;

/** 每设备限流：1 小时窗口内最多条数（自用宽松量级，防误触连发）。 */
const RATE_LIMIT_COUNT = 6;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * 反馈提交体契约；图片为 base64，日志 zip 同形态（移动端 LogExporter 产物）。
 * 上限与移动端表单/上传器同口径，任何越界 400。
 */
export const feedbackSubmission = z.object({
  desc: z.string().min(1).max(DESC_MAX),
  app: z.object({
    version: z.string().min(1).max(64),
    build: z.string().min(1).max(32),
    platform: z.string().min(1).max(128),
  }),
  logZipB64: z.string().max(FIELD_B64_MAX).optional(),
  images: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        b64: z.string().max(FIELD_B64_MAX),
      }),
    )
    .max(IMAGE_MAX_COUNT)
    .optional(),
});

export type FeedbackSubmission = z.infer<typeof feedbackSubmission>;

/** 反馈落盘结果摘要（HTTP 应答与测试断言面）。 */
export interface FeedbackAccepted {
  readonly id: string;
}

/** 图片 magic bytes 白名单：JPEG `ff d8 ff` / PNG `89 50 4e 47`（防扩展名伪装）。 */
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** 校验 base64 解码后的图片头；返回归一化扩展名（jpg/png），不匹配返回 null。 */
export function imageExtensionOf(bytes: Uint8Array): "jpg" | "png" | null {
  const has = (magic: number[]): boolean => magic.every((b, i) => bytes[i] === b);
  if (has(JPEG_MAGIC)) return "jpg";
  if (has(PNG_MAGIC)) return "png";
  return null;
}

/** 解码 base64；失败返回 null（调用方按 400 处理）。 */
function decodeB64(b64: string): Buffer | null {
  try {
    return Buffer.from(b64, "base64");
  } catch {
    return null;
  }
}

/**
 * 问题反馈接收通道（app 层编排组件，照 UpdateFeed 模板）：
 * `POST /feedback`——header `x-aimi-token` 鉴权（与 WS hello 同一 verifyToken）→
 * 按设备限流 → 收包上限 → 契约校验 → 图片 magic bytes 白名单 →
 * `{dataDir}/feedback/{id}/` 落盘（meta.json 原子写 + log.zip + images）→ 审计 → 201。
 *
 * 存储沿 updates 先例走纯文件目录不经 SQLite（跨进程共享，CLI 直接读）；损坏容忍：
 * 目录写失败收敛为 500 日志留痕，不影响服务其他功能。
 */
/** 鉴权通过后的最小身份投影（只要 deviceId；与 AuditIdentity 同构思路）。 */
export type TokenIdentity = { readonly deviceId: string };

export class FeedbackChannel {
  readonly #dataDir: string;
  readonly #verifyToken: (token: string, remote: string) => Promise<TokenIdentity | null>;
  readonly #onAccepted: (deviceId: string, id: string, submission: FeedbackSubmission) => Promise<void>;
  readonly #log: (level: "warn" | "info", msg: string, extra?: Record<string, unknown>) => void;

  /** 每设备提交时间戳（限流窗口记账；进程内存态即可，重启清零无害）。 */
  readonly #rateByDevice = new Map<string, number[]>();

  /**
   * @param opts.dataDir - 服务数据目录；反馈落 `{dataDir}/feedback/`
   * @param opts.verifyToken - 与 WS hello 同源的 token 校验（返回 DeviceIdentity 或 null）
   * @param opts.onAccepted - 反馈落盘成功后的回调（Application 注入审计写入）
   * @param opts.log - 结构化日志出口
   */
  constructor(opts: {
    dataDir: string;
    verifyToken: (token: string, remote: string) => Promise<TokenIdentity | null>;
    onAccepted: (deviceId: string, id: string, submission: FeedbackSubmission) => Promise<void>;
    log?: (level: "warn" | "info", msg: string, extra?: Record<string, unknown>) => void;
  }) {
    this.#dataDir = join(opts.dataDir, "feedback");
    this.#verifyToken = opts.verifyToken;
    this.#onAccepted = opts.onAccepted;
    this.#log = opts.log ?? ((): void => {});
  }

  /** 反馈根目录（CLI list/show 据此读取）。 */
  get feedbackDir(): string {
    return this.#dataDir;
  }

  /**
   * LanWsServer.onRequest 注入的组合分发中的一路：仅处理 `/feedback` 前缀，
   * 其余交回调用方（UpdateFeed 分发）。未预期异常收敛 500。
   *
   * @returns 是否已处理该请求（false = 路径不归本通道，调用方继续分发）
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url ?? "/", "http://aimi.internal").pathname;
    if (pathname !== "/feedback") return false;
    try {
      await this.#serve(req, res);
    } catch (err) {
      this.#log("warn", "feedback handler failed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      res.destroy();
    }
    return true;
  }

  /** 主流程：鉴权 → 限流 → 收包 → 校验 → 落盘 → 审计应答。 */
  async #serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remote = `${req.socket.remoteAddress ?? "unknown"}:${req.socket.remotePort ?? 0}`;
    if (req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const token = req.headers["x-aimi-token"];
    if (typeof token !== "string" || token.length < 8) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    const identity = await this.#verifyToken(token, remote);
    if (identity === null) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    if (this.#rateLimited(identity.deviceId)) {
      res.writeHead(429, { "Content-Type": "text/plain" });
      res.end("too many submissions");
      return;
    }

    const body = await this.#readBody(req, res);
    if (body === null) return; // 超限已在 #readBody 内应答 413

    let submission: FeedbackSubmission;
    try {
      const parsed = feedbackSubmission.safeParse(JSON.parse(body.toString("utf8")));
      if (!parsed.success) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`invalid payload: ${parsed.error.issues[0]?.path.join(".") ?? "unknown"}`);
        return;
      }
      submission = parsed.data;
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("invalid json");
      return;
    }

    // 图片 magic bytes 白名单：解码失败/伪装文件一律 400。
    const decodedImages: { ext: "jpg" | "png"; bytes: Buffer }[] = [];
    for (const image of submission.images ?? []) {
      const bytes = decodeB64(image.b64);
      const ext = bytes === null ? null : imageExtensionOf(bytes);
      if (bytes === null || ext === null) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`invalid image: ${image.name}`);
        return;
      }
      decodedImages.push({ ext, bytes });
    }
    let logZip: Buffer | null = null;
    if (submission.logZipB64 !== undefined) {
      logZip = decodeB64(submission.logZipB64);
      if (logZip === null) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("invalid log zip");
        return;
      }
    }

    const id = `${_stamp()}-${randomBytes(3).toString("hex")}`;
    const dir = join(this.#dataDir, id);
    try {
      await mkdir(join(dir, "images"), { recursive: true });
      // meta.json 原子写（tmp+rename，沿 publishApk 模式）：读到半截 JSON 的窗口为零。
      const meta = {
        id,
        deviceId: identity.deviceId,
        desc: submission.desc,
        app: submission.app,
        images: (submission.images ?? []).map((image, i) => ({
          originalName: image.name,
          file: `images/${String(i).padStart(2, "0")}.${decodedImages[i]!.ext}`,
        })),
        hasLog: logZip !== null,
      };
      const tmp = join(dir, "meta.json.tmp");
      await writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
      await rename(tmp, join(dir, "meta.json"));
      if (logZip !== null) {
        await writeFile(join(dir, "log.zip"), logZip);
      }
      for (const [i, image] of decodedImages.entries()) {
        await writeFile(join(dir, "images", `${String(i).padStart(2, "0")}.${image.ext}`), image.bytes);
      }
    } catch (err) {
      this.#log("warn", "feedback persist failed", { error: err instanceof Error ? err.message : String(err) });
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("persist failed");
      return;
    }

    await this.#onAccepted(identity.deviceId, id, submission);
    this.#log("info", "feedback accepted", { id, device: identity.deviceId, images: decodedImages.length, hasLog: logZip !== null });
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id }));
  }

  /** 按设备限流（滑动窗口记账；只保留窗口内时间戳）。 */
  #rateLimited(deviceId: string): boolean {
    const now = Date.now();
    const stamps = (this.#rateByDevice.get(deviceId) ?? []).filter(
      (ts) => now - ts < RATE_LIMIT_WINDOW_MS,
    );
    if (stamps.length >= RATE_LIMIT_COUNT) {
      this.#rateByDevice.set(deviceId, stamps);
      return true;
    }
    stamps.push(now);
    this.#rateByDevice.set(deviceId, stamps);
    return false;
  }

  /** 读请求体：content-length 先拒 + chunk 累计同上限（防无界缓冲）；超限应答 413。 */
  #readBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const declared = Number(req.headers["content-length"] ?? "0");
      if (Number.isFinite(declared) && declared > BODY_MAX_BYTES) {
        res.writeHead(413, { "Content-Type": "text/plain" });
        res.end("payload too large");
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let over = false;
      req.on("data", (chunk: Buffer) => {
        if (over) return;
        size += chunk.length;
        if (size > BODY_MAX_BYTES) {
          over = true;
          req.destroy();
          res.writeHead(413, { "Content-Type": "text/plain" });
          res.end("payload too large");
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!over) resolve(Buffer.concat(chunks));
      });
      req.on("error", () => {
        if (!over) {
          over = true;
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("read failed");
          resolve(null);
        }
      });
    });
  }
}

/** 反馈 id 的时间段：`20261024-123456`。 */
function _stamp(): string {
  const t = new Date();
  const two = (v: number): string => v.toString().padStart(2, "0");
  return (
    `${t.getFullYear()}${two(t.getMonth() + 1)}${two(t.getDate())}` +
    `-${two(t.getHours())}${two(t.getMinutes())}${two(t.getSeconds())}`
  );
}
