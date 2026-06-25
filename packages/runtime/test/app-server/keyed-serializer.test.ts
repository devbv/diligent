// @summary Tests the per-key async serializer that presents same-thread user-input prompts one at a time.

import { describe, expect, test } from "bun:test";
import { createKeyedSerializer } from "../../src/app-server/keyed-serializer";

describe("createKeyedSerializer", () => {
  test("runs same-key tasks one at a time, in order", async () => {
    const serialize = createKeyedSerializer();
    const order: string[] = [];
    let releaseFirst: (() => void) | null = null;

    const p1 = serialize("t", async () => {
      order.push("start1");
      await new Promise<void>((r) => {
        releaseFirst = r;
      });
      order.push("end1");
      return 1;
    });
    const p2 = serialize("t", async () => {
      order.push("start2");
      return 2;
    });

    // Flush microtasks: the second task must NOT start while the first is pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start1"]);

    releaseFirst!();
    expect(await p1).toBe(1);
    expect(await p2).toBe(2);
    expect(order).toEqual(["start1", "end1", "start2"]);
  });

  test("different keys run concurrently", async () => {
    const serialize = createKeyedSerializer();
    const order: string[] = [];
    let releaseA: (() => void) | null = null;

    const a = serialize("a", async () => {
      order.push("startA");
      await new Promise<void>((r) => {
        releaseA = r;
      });
      return "a";
    });
    const b = serialize("b", async () => {
      order.push("startB");
      return "b";
    });

    await Promise.resolve();
    await Promise.resolve();
    // A different key must not be blocked by a pending task on another key.
    expect(order).toContain("startB");

    releaseA!();
    expect(await a).toBe("a");
    expect(await b).toBe("b");
  });

  test("a rejected task does not block later same-key tasks", async () => {
    const serialize = createKeyedSerializer();

    const p1 = serialize("t", async () => {
      throw new Error("boom");
    });
    await expect(p1).rejects.toThrow("boom");

    const p2 = serialize("t", async () => "ok");
    expect(await p2).toBe("ok");
  });
});
