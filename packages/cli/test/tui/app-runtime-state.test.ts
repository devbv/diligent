// @summary Tests for extracted app runtime state timing and steering helpers
import { describe, expect, test } from "bun:test";
import { AppRuntimeState } from "../../src/tui/app-runtime-state";

describe("AppRuntimeState", () => {
  test("queues and consumes pending steers", () => {
    const state = new AppRuntimeState("default", "medium");
    state.queuePendingSteer({ id: "s1", content: "first" });
    state.queuePendingSteer({ id: "s2", content: "second" });

    expect(state.consumePendingSteersByText(["second"])).toEqual(["second"]);
    expect(state.pendingSteerContents()).toEqual(["first"]);
    expect(state.consumePendingSteersFallback(1)).toEqual(["first"]);
  });

  test("consumes matching steering texts without fallback", () => {
    const state = new AppRuntimeState("default", "medium");
    state.queuePendingSteer({ id: "s1", content: "change approach" });

    expect(state.consumePendingSteersByText(["change approach"])).toEqual(["change approach"]);
    expect(state.pendingSteers).toEqual([]);
    expect(state.consumePendingSteersFallback(0)).toEqual([]);
  });

  test("consumes matching steering ids", () => {
    const state = new AppRuntimeState("default", "medium");
    state.queuePendingSteer({ id: "s1", content: "first" });
    state.queuePendingSteer({ id: "s2", content: "second" });

    expect(state.consumePendingSteersByIds(["s2"])).toEqual(["second"]);
    expect(state.pendingSteerContents()).toEqual(["first"]);
  });

  test("drains pending steers", () => {
    const state = new AppRuntimeState("default", "medium");
    state.queuePendingSteer({ id: "s1", content: "first" });
    state.queuePendingSteer({ id: "s2", content: "second" });

    expect(state.drainPendingSteers()).toEqual(["first", "second"]);
    expect(state.pendingSteers).toHaveLength(0);
  });

  test("tracks reasoning timing lifecycle", () => {
    const state = new AppRuntimeState("default", "medium");
    state.beginTurnTiming();
    state.noteThinkingDelta();
    expect(state.turnStartedAtMs).not.toBeNull();
    expect(state.reasoningStartedAtMs).not.toBeNull();

    state.noteTextDelta();
    expect(state.reasoningStartedAtMs).toBeNull();
    expect(state.reasoningAccumulatedMs).toBeGreaterThanOrEqual(0);
  });
});
