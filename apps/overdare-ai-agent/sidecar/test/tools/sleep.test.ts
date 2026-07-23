// @summary Tests for sleep tool — duration, default, clamping, abort, and progress updates (virtual timer)
import { describe, expect, it } from "bun:test";
import type { ToolContext } from "@diligent/core/tool-contract";
import { createSleepTool, createSleepToolProvider, type SleepScheduler } from "../../src/tools/sleep";

/** Yield to the microtask/macrotask queue so the tool loop can register its next sleep. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Virtual clock. Never sleeps for real — `tick()` completes the sleep the tool is currently
 * awaiting and advances virtual time by exactly that amount.
 */
class FakeScheduler implements SleepScheduler {
  /** Virtual "now" in ms. */
  time = 0;
  /** Every duration the tool asked to sleep for, in call order. */
  requests: number[] = [];
  private pending: { ms: number; fire: () => void } | undefined;

  now(): number {
    return this.time;
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    this.requests.push(ms);
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const finish = (): void => {
        signal.removeEventListener("abort", finish);
        this.pending = undefined;
        resolve();
      };
      signal.addEventListener("abort", finish, { once: true });
      this.pending = { ms, fire: finish };
    });
  }

  /** Complete the currently awaited sleep. Returns false when nothing is pending. */
  async tick(): Promise<boolean> {
    const pending = this.pending;
    if (!pending) return false;
    this.time += pending.ms;
    pending.fire();
    await flush();
    return true;
  }

  /** Complete every sleep until the tool stops asking for more. */
  async runToCompletion(maxTicks = 200): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      if (!(await this.tick())) return;
    }
    throw new Error("sleep tool did not finish within the tick budget");
  }

  /** Total virtual time actually spent sleeping. */
  get totalRequestedMs(): number {
    return this.requests.reduce((sum, ms) => sum + ms, 0);
  }
}

function makeCtx(controller = new AbortController()): ToolContext & { updates: string[]; controller: AbortController } {
  const updates: string[] = [];
  return {
    toolCallId: "tc-sleep",
    signal: controller.signal,
    abort: () => controller.abort(),
    onUpdate: (partial: string) => {
      updates.push(partial);
    },
    updates,
    controller,
  };
}

describe("sleep bundled tool provider", () => {
  it("exposes the sleep tool", async () => {
    const provider = createSleepToolProvider();
    expect(provider.id).toBe("@overdare/sleep-tools");

    const tools = await provider.createTools({ cwd: "/tmp/project" });
    expect(tools.map((tool) => tool.name)).toEqual(["sleep"]);
  });
});

describe("sleep tool", () => {
  it("is named sleep", () => {
    expect(createSleepTool().name).toBe("sleep");
  });

  it("describes the default, user-specified times, and that it does not advance the game", () => {
    const description = createSleepTool().description;
    expect(description).toContain("Waits 5 seconds when `seconds` is omitted");
    expect(description).toContain('If the user states a wait time ("wait 10 seconds"), pass exactly that number.');
    expect(description).toContain("does not run or advance the game");
  });

  it("waits 5 seconds by default when called with no parameters", async () => {
    const scheduler = new FakeScheduler();
    const tool = createSleepTool(scheduler);
    const ctx = makeCtx();

    const running = tool.execute({}, ctx);
    await flush();
    await scheduler.runToCompletion();
    const result = await running;

    expect(scheduler.totalRequestedMs).toBe(5000);
    expect(scheduler.time).toBe(5000);
    expect(result.output).toBe("Waited 5s.");
    expect(result.metadata).toMatchObject({ requested_seconds: null, slept_seconds: 5, interrupted: false });
  });

  it("waits exactly the requested duration", async () => {
    const scheduler = new FakeScheduler();
    const tool = createSleepTool(scheduler);
    const ctx = makeCtx();

    const running = tool.execute({ seconds: 12 }, ctx);
    await flush();
    await scheduler.runToCompletion();
    const result = await running;

    expect(scheduler.totalRequestedMs).toBe(12_000);
    expect(result.output).toBe("Waited 12s.");
    expect(result.metadata).toMatchObject({ requested_seconds: 12, slept_seconds: 12, clamped: false });
  });

  it("clamps values above the maximum", async () => {
    const scheduler = new FakeScheduler();
    const tool = createSleepTool(scheduler);

    const running = tool.execute({ seconds: 600 }, makeCtx());
    await flush();
    await scheduler.runToCompletion();
    const result = await running;

    expect(scheduler.totalRequestedMs).toBe(60_000);
    expect(result.output).toContain("clamped");
    expect(result.metadata).toMatchObject({ requested_seconds: 600, slept_seconds: 60, clamped: true });
  });

  it("clamps values below the minimum", async () => {
    const scheduler = new FakeScheduler();
    const tool = createSleepTool(scheduler);

    const running = tool.execute({ seconds: 0 }, makeCtx());
    await flush();
    await scheduler.runToCompletion();
    const result = await running;

    expect(scheduler.totalRequestedMs).toBe(1000);
    expect(result.metadata).toMatchObject({ requested_seconds: 0, slept_seconds: 1, clamped: true });
  });

  it("returns immediately when the signal is already aborted", async () => {
    const scheduler = new FakeScheduler();
    const tool = createSleepTool(scheduler);
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute({ seconds: 30 }, makeCtx(controller));

    expect(scheduler.requests).toEqual([]);
    expect(scheduler.time).toBe(0);
    expect(result.output).toBe("Waited 0s of 30s — interrupted.");
    expect(result.metadata).toMatchObject({ slept_seconds: 0, interrupted: true });
  });

  it("stops early when the signal aborts mid-wait", async () => {
    const scheduler = new FakeScheduler();
    const tool = createSleepTool(scheduler);
    const ctx = makeCtx();

    const running = tool.execute({ seconds: 30 }, ctx);
    await flush();
    await scheduler.tick();
    await scheduler.tick();

    ctx.controller.abort();
    const result = await running;

    expect(scheduler.time).toBe(2000);
    expect(scheduler.totalRequestedMs).toBeLessThan(30_000);
    expect(result.output).toBe("Waited 2s of 30s — interrupted.");
    expect(result.metadata).toMatchObject({ requested_seconds: 30, slept_seconds: 2, interrupted: true });
  });

  it("reports remaining time through ctx.onUpdate while waiting", async () => {
    const scheduler = new FakeScheduler();
    const tool = createSleepTool(scheduler);
    const ctx = makeCtx();

    const running = tool.execute({ seconds: 3 }, ctx);
    await flush();
    await scheduler.runToCompletion();
    await running;

    expect(ctx.updates[0]).toBe("Waiting 3s…");
    expect(ctx.updates).toContain("Waiting 3s… 2s remaining");
    expect(ctx.updates).toContain("Waiting 3s… 1s remaining");
    // No "0s remaining" update — the final tick ends the wait.
    expect(ctx.updates.some((u) => u.includes("0s remaining"))).toBe(false);
  });

  it("does not emit further updates after an abort", async () => {
    const scheduler = new FakeScheduler();
    const tool = createSleepTool(scheduler);
    const ctx = makeCtx();

    const running = tool.execute({ seconds: 10 }, ctx);
    await flush();
    await scheduler.tick();
    const updatesBeforeAbort = ctx.updates.length;

    ctx.controller.abort();
    await running;

    expect(ctx.updates.length).toBe(updatesBeforeAbort);
  });

  it("works without ctx.onUpdate", async () => {
    const scheduler = new FakeScheduler();
    const tool = createSleepTool(scheduler);
    const controller = new AbortController();
    const ctx: ToolContext = { toolCallId: "tc", signal: controller.signal, abort: () => controller.abort() };

    const running = tool.execute({ seconds: 2 }, ctx);
    await flush();
    await scheduler.runToCompletion();

    expect((await running).output).toBe("Waited 2s.");
  });

  it("falls back to the default when seconds is not a finite number", async () => {
    const scheduler = new FakeScheduler();
    const tool = createSleepTool(scheduler);

    const running = tool.execute({ seconds: Number.NaN }, makeCtx());
    await flush();
    await scheduler.runToCompletion();
    const result = await running;

    expect(scheduler.totalRequestedMs).toBe(5000);
    expect(result.output).toBe("Waited 5s.");
  });
});
