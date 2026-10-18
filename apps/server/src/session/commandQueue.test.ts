import { describe, expect, it } from "vitest";
import { KeyedSerialQueue } from "./commandQueue.js";

describe("KeyedSerialQueue", () => {
  it("串行执行同一 key 的任务并保留提交顺序", async () => {
    const queue = new KeyedSerialQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = queue.run("session-1", async () => {
      order.push("first:start");
      await firstReleased;
      order.push("first:end");
      return "first";
    });
    const second = queue.run("session-1", async () => {
      order.push("second");
      return "second";
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("不同 key 可以并发执行", async () => {
    const queue = new KeyedSerialQueue();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.run("session-1", () => blocked.then(() => "one"));
    const second = queue.run("session-2", async () => "two");

    await expect(second).resolves.toBe("two");
    release();
    await expect(first).resolves.toBe("one");
  });

  it("前一个任务失败后不会阻塞后续任务", async () => {
    const queue = new KeyedSerialQueue();
    const first = queue.run("session-1", async () => { throw new Error("failed"); });
    const second = queue.run("session-1", async () => "recovered");

    await expect(first).rejects.toThrow("failed");
    await expect(second).resolves.toBe("recovered");
  });
});
