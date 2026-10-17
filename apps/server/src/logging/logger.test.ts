import { mkdtempSync, readFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "aimi-log-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("JSON 行日志", () => {
  it("每行一个对象：ts/level/component/msg/fields", () => {
    const log = createLogger("sessionManager", dir);
    log.info("session started", { sessionId: "s1" });
    log.error("boom", { sessionId: "s1", err: "EPIPE" });
    const line = readFileSync(join(dir, "server.log"), "utf8").trim().split("\n");
    expect(line).toHaveLength(2);
    expect(JSON.parse(line[0]!)).toMatchObject({ level: "INFO", component: "sessionManager", sessionId: "s1" });
    expect(JSON.parse(line[1]!).level).toBe("ERROR");
  });
});
