import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conveyor } from "../conveyor.js";
import type { DialResult } from "./relayClient.js";
import { RelayClient } from "./relayClient.js";

const advance = async (ms: number): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); };

afterEach(() => {
  vi.useRealTimers();
});

/** 最小 Conveyor 假体：dial 注入用——只记账 close 调用与原因。 */
function fakeConveyor(): { conveyor: Conveyor; closes: (string | undefined)[] } {
  const closes: (string | undefined)[] = [];
  const conveyor: Conveyor = {
    open: async () => {},
    send: () => {},
    onFrame: () => {},
    onClose: () => {},
    close: (reason?: string) => {
      closes.push(reason);
      return Promise.resolve();
    },
    get state() {
      return "open" as const;
    },
  };
  return { conveyor, closes };
}

/** 挂起式连接终结面：测试手动放行（模拟对端断开/连接终结）。 */
function heldClose(): { close: Promise<void>; release: () => void } {
  let release!: () => void;
  const close = new Promise<void>((res) => {
    release = res;
  });
  return { close, release };
}

describe("RelayClient（server→relay 出站拨入）", () => {
  it("退避序列：连续失败按 1s×2^n 重拨、封顶 60s（random=0.5 → 抖动因子恰 1.0，名义值精确命中）", async () => {
    vi.useFakeTimers();
    const dial = vi.fn(async () => {
      throw new Error("relay down");
    });
    const client = new RelayClient({
      url: "ws://relay.invalid/server",
      serverToken: "st-unit-0001",
      dial,
      random: () => 0.5,
    });
    client.start(() => {});
    await advance(0);
    expect(dial).toHaveBeenCalledTimes(1); // start 即首拨（dial 同步发起）
    const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
    for (let i = 0; i < expected.length; i++) {
      await advance(expected[i]! - 1);
      expect(dial).toHaveBeenCalledTimes(i + 1); // 未到点不重拨（封顶后恒 60s）
      await advance(1);
      await advance(0);
      expect(dial).toHaveBeenCalledTimes(i + 2); // 恰在名义延迟处重拨
    }
    await client.close();
  });

  it("抖动区间：±20%——random=0 时恰在 0.8× 名义值重拨，random=1 时恰在 1.2×", async () => {
    vi.useFakeTimers();
    for (const [random, factor] of [[0, 0.8], [1, 1.2]] as const) {
      const dial = vi.fn(async () => {
        throw new Error("down");
      });
      const client = new RelayClient({
        url: "ws://relay.invalid/server",
        serverToken: "st-unit-0001",
        dial,
        random: () => random,
      });
      client.start(() => {});
      await advance(0);
      expect(dial).toHaveBeenCalledTimes(1);
      await advance(Math.round(1_000 * factor) - 1);
      expect(dial).toHaveBeenCalledTimes(1); // 区间边界内不重拨
      await advance(1);
      await advance(0);
      expect(dial).toHaveBeenCalledTimes(2); // 边界处重拨（0.8×/1.2× 名义值）
      await client.close();
    }
  });

  it("成功归零：dial 成功 → onConnection(conveyor,'relay')；连接终结后重拨延迟回到基数 1s", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let held: { release: () => void } | null = null;
    const established: Conveyor[] = [];
    const dial = vi.fn(async (): Promise<DialResult> => {
      calls += 1;
      if (calls <= 2) throw new Error("down");
      const { conveyor } = fakeConveyor();
      established.push(conveyor);
      const pending = heldClose();
      held = pending;
      return { conveyor, close: pending.close };
    });
    const onConnection = vi.fn();
    const client = new RelayClient({
      url: "ws://relay.invalid/server",
      serverToken: "st-unit-0001",
      dial,
      random: () => 0.5,
    });
    client.start(onConnection);
    await advance(0); // dial#1 失败
    await advance(1_000); // dial#2 失败
    await advance(2_000); // dial#3 成功
    expect(dial).toHaveBeenCalledTimes(3);
    expect(onConnection).toHaveBeenCalledTimes(1);
    expect(onConnection.mock.calls[0]![0]).toBe(established[0]);
    expect(onConnection.mock.calls[0]![1]).toBe("relay");

    // 连接终结：归寂面放行 → 重拨延迟必须回到 1s（成功归零——而非沿用 4s 继续翻倍）。
    held!.release();
    await advance(999);
    expect(dial).toHaveBeenCalledTimes(3); // 999ms 未重拨
    await advance(1);
    await advance(0);
    expect(dial).toHaveBeenCalledTimes(4); // 恰 1s 重拨
    await client.close();
  });

  it("close 竞态：在途 dial 于 close 后落定 → 不再 onConnection、拨到的连接就地关闭、重拨取消", async () => {
    vi.useFakeTimers();
    let release!: (result: DialResult) => void;
    const dial = vi.fn(
      () => new Promise<DialResult>((res) => { release = res; }),
    );
    const { conveyor, closes } = fakeConveyor();
    const onConnection = vi.fn();
    const client = new RelayClient({
      url: "ws://relay.invalid/server",
      serverToken: "st-unit-0001",
      dial,
      random: () => 0.5,
    });
    client.start(onConnection);
    await advance(0);
    expect(dial).toHaveBeenCalledTimes(1);
    const closing = client.close(); // close 介入（dial 仍在途）
    release({ conveyor, close: new Promise(() => {}) }); // dial 此后才落定
    await expect(closing).resolves.toBeUndefined();
    expect(onConnection).not.toHaveBeenCalled(); // close 后落定的 dial 不得再进编排
    expect(closes).toEqual(["relay client closed"]); // 拨到的连接就地关闭（不外漏半开 socket）
    const callsAfter = dial.mock.calls.length;
    await advance(120_000);
    expect(dial).toHaveBeenCalledTimes(callsAfter); // 重拨循环已停
    await expect(client.close()).resolves.toBeUndefined(); // 幂等
  });

  it("close 于退避等待期 → 取消计时，此后不再重拨", async () => {
    vi.useFakeTimers();
    const dial = vi.fn(async () => {
      throw new Error("down");
    });
    const client = new RelayClient({
      url: "ws://relay.invalid/server",
      serverToken: "st-unit-0001",
      dial,
      random: () => 0.5,
    });
    client.start(() => {});
    await advance(0); // 首拨失败 → 1s 退避挂起
    await client.close();
    await advance(60_000);
    expect(dial).toHaveBeenCalledTimes(1); // 不再重拨
  });

  it("close 于连接建立期 → 收口既有 relay 连接并退出循环", async () => {
    vi.useFakeTimers();
    const { conveyor, closes } = fakeConveyor();
    const pending = heldClose();
    const dial = vi.fn(async (): Promise<DialResult> => ({ conveyor, close: pending.close }));
    const onConnection = vi.fn();
    const client = new RelayClient({
      url: "ws://relay.invalid/server",
      serverToken: "st-unit-0001",
      dial,
      random: () => 0.5,
    });
    client.start(onConnection);
    await advance(0);
    expect(onConnection).toHaveBeenCalledTimes(1);
    const closing = client.close();
    pending.release(); // close() 收口连接 → 归寂面落定
    await expect(closing).resolves.toBeUndefined();
    expect(closes).toEqual(["relay client closed"]);
  });
});
