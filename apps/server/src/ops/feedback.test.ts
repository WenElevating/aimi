import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../app/config.js";
import { listFeedback, setFeedbackStatus, showFeedback } from "./feedback.js";

const cleanups: string[] = [];

afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** 造一个带 meta.json 的临时反馈根目录；status 缺省不写（模拟旧数据）。 */
async function fakeFeedbackRoot(meta: Record<string, unknown>): Promise<ServerConfig> {
  const root = join(tmpdir(), `aimi-feedback-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(root, "feedback", meta.id as string), { recursive: true });
  await writeFile(join(root, "feedback", meta.id as string, "meta.json"), JSON.stringify(meta, null, 2));
  cleanups.push(root);
  return { dataDir: root } as unknown as ServerConfig;
}

describe("反馈处理状态（status）", () => {
  it("旧 meta.json 无 status 字段：按 new 呈现（向后兼容）", async () => {
    const cfg = await fakeFeedbackRoot({
      id: "fb-1",
      deviceId: "dev-1",
      desc: "问题",
      app: { version: "1.3.5", build: "25", platform: "android" },
      images: [],
      hasLog: false,
    });
    const entries = await listFeedback(cfg);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("new");
    const shown = await showFeedback(cfg, "fb-1");
    expect(shown.status).toBe("new");
  });

  it("status 值域外按 new 兜底，不抛错不阻断列表", async () => {
    const cfg = await fakeFeedbackRoot({
      id: "fb-2",
      deviceId: "dev-1",
      desc: "问题",
      status: "invented",
      app: { version: "1", build: "1", platform: "android" },
      images: [],
      hasLog: false,
    });
    const entries = await listFeedback(cfg);
    expect(entries[0]?.status).toBe("new");
  });

  it("setFeedbackStatus 回写 meta.json 保留其余字段；show 读回新状态", async () => {
    const cfg = await fakeFeedbackRoot({
      id: "fb-3",
      deviceId: "dev-1",
      desc: "问题",
      app: { version: "1.3.5", build: "25", platform: "android" },
      images: [],
      hasLog: true,
    });
    await setFeedbackStatus(cfg, "fb-3", "done");
    const shown = await showFeedback(cfg, "fb-3");
    expect(shown.status).toBe("done");
    expect(shown.hasLog).toBe(true);
    expect(shown.app.version).toBe("1.3.5");
    expect(shown.desc).toBe("问题");
  });

  it("setFeedbackStatus 对不存在的反馈抛错", async () => {
    const cfg = await fakeFeedbackRoot({ id: "fb-4", desc: "x", app: {}, images: [], hasLog: false });
    await expect(setFeedbackStatus(cfg, "missing", "done")).rejects.toThrow();
  });
});
