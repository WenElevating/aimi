import { describe, expect, it } from "vitest";
import type { AgentModelOption } from "@aimi/protocol";
import { parseModelSelection } from "./zcodeAppServer.js";
import { ZcodeAdapter } from "../zcodeAdapter.js";

/** parseModelSelection：`providerId:modelId` 编码 → zcode ModelSelection。 */
describe("parseModelSelection", () => {
  it("解析为扁平 {providerId, modelId}——嵌套 {provider:{providerId}} 曾致线上 -32602 秒败回合（反馈 20261031-213405）", () => {
    expect(parseModelSelection("daapsaak:glm-5.3-flash")).toEqual({
      providerId: "daapsaak",
      modelId: "glm-5.3-flash",
    });
  });

  it("modelId 段可含冒号（取首个冒号切分）；非法编码返回 undefined", () => {
    expect(parseModelSelection("p:a:b")).toEqual({ providerId: "p", modelId: "a:b" });
    expect(parseModelSelection(":m")).toBeUndefined();
    expect(parseModelSelection("p:")).toBeUndefined();
    expect(parseModelSelection("pm")).toBeUndefined();
  });
});

/** currentModels 清单来源：磁盘现读优先（运行时目录/最近成功读取仅作降级）。 */
describe("ZcodeAdapter.currentModels", () => {
  it("磁盘现读优先：配置变化即时反映，不吃启动期缓存（反馈 20261031-213405：改了 provider 清单手机不更新）", () => {
    let list: readonly AgentModelOption[] = [{ value: "p:m1", name: "m1", detail: "" }];
    const adapter = new ZcodeAdapter({ readModels: () => list });
    expect(adapter.currentModels().map((m) => m.value)).toEqual(["p:m1"]);
    list = [
      { value: "p:m2", name: "m2", detail: "" },
      { value: "p:m3", name: "m3", detail: "" },
    ];
    expect(adapter.currentModels().map((m) => m.value)).toEqual(["p:m2", "p:m3"]);
  });

  it("现读失败降级到最近一次成功读取（refreshModels 或此前现读均可建立兜底值）", async () => {
    const good: readonly AgentModelOption[] = [{ value: "p:m1", name: "m1", detail: "" }];
    let fail = false;
    const adapter = new ZcodeAdapter({ readModels: () => (fail ? [] : good) });
    expect(adapter.currentModels()).toEqual(good); // 首读成功即建立兜底
    fail = true;
    expect(adapter.currentModels()).toEqual(good); // 现读失败 → 最近成功值兜底
  });
});
