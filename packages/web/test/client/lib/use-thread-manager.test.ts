// @summary Tests for web thread manager helpers that manage draft composer input entries and subscriptions

import { expect, mock, test } from "bun:test";
import type { AgentContextItem } from "../../../src/client/lib/agent-native-bridge";
import {
  clearDraftThreadInput,
  DRAFT_INPUT_KEY,
  mergeThreadContextItems,
  switchThreadSubscription,
} from "../../../src/client/lib/use-thread-manager";

function instance(name: string, guid = name.toLowerCase()): AgentContextItem {
  return { kind: "instance", source: "studiorpc", Name: name, ClassType: "Part", GUID: guid };
}

test("clearDraftThreadInput removes only the draft composer entry", () => {
  const next = clearDraftThreadInput({
    [DRAFT_INPUT_KEY]: "stale draft",
    "thread-1": "keep this",
  });

  expect(next).toEqual({
    "thread-1": "keep this",
  });
});

test("clearDraftThreadInput returns same object when no draft entry exists", () => {
  const original = { "thread-1": "keep this" };
  const next = clearDraftThreadInput(original);

  expect(next).toBe(original);
});

test("switchThreadSubscription unsubscribes previous thread before subscribing next thread", async () => {
  const rpc = {
    unsubscribe: mock(async (subscriptionId: string) => ({ ok: subscriptionId === "sub-old" })),
    subscribe: mock(async (threadId: string) => ({ subscriptionId: `sub:${threadId}` })),
  } as const;
  const activateThreadPrompts = mock(() => {});

  const next = await switchThreadSubscription({
    rpc: rpc as never,
    activeSubscription: { threadId: "thread-old", subscriptionId: "sub-old" },
    threadId: "thread-new",
    activateThreadPrompts,
  });

  expect(rpc.unsubscribe).toHaveBeenCalledWith("sub-old");
  expect(rpc.subscribe).toHaveBeenCalledWith("thread-new");
  expect(activateThreadPrompts).toHaveBeenCalledWith("thread-new");
  expect(next).toEqual({ threadId: "thread-new", subscriptionId: "sub:thread-new" });
});

test("switchThreadSubscription reuses active subscription when already on target thread", async () => {
  const rpc = {
    unsubscribe: mock(async () => ({ ok: true })),
    subscribe: mock(async () => ({ subscriptionId: "sub:thread-1" })),
  } as const;
  const activateThreadPrompts = mock(() => {});
  const activeSubscription = { threadId: "thread-1", subscriptionId: "sub:thread-1" };

  const next = await switchThreadSubscription({
    rpc: rpc as never,
    activeSubscription,
    threadId: "thread-1",
    activateThreadPrompts,
  });

  expect(rpc.unsubscribe).not.toHaveBeenCalled();
  expect(rpc.subscribe).not.toHaveBeenCalled();
  expect(activateThreadPrompts).toHaveBeenCalledWith("thread-1");
  expect(next).toBe(activeSubscription);
});

test("new draft input key remains stable so draft-specific effort/input can persist across new thread resets", () => {
  expect(DRAFT_INPUT_KEY).toBe("__draft__");
});

test("mergeThreadContextItems attaches a multi-select batch to an empty thread", () => {
  const next = mergeThreadContextItems({}, "t1", [instance("A"), instance("B"), instance("C")]);

  expect(next.t1.map((i) => i.Name)).toEqual(["A", "B", "C"]);
});

test("mergeThreadContextItems accumulates a later single selection instead of resetting", () => {
  const prev = { t1: [instance("A"), instance("B"), instance("C")] };
  const next = mergeThreadContextItems(prev, "t1", [instance("D")]);

  expect(next.t1.map((i) => i.Name)).toEqual(["A", "B", "C", "D"]);
});

test("mergeThreadContextItems dedups a re-selected item by GUID and keeps its position", () => {
  const prev = { t1: [instance("A"), instance("B"), instance("C")] };
  const next = mergeThreadContextItems(prev, "t1", [instance("B")]);

  expect(next.t1.map((i) => i.Name)).toEqual(["A", "B", "C"]);
});

test("mergeThreadContextItems only touches the targeted thread key", () => {
  const prev = { t1: [instance("A")], t2: [instance("Z")] };
  const next = mergeThreadContextItems(prev, "t1", [instance("B")]);

  expect(next.t1.map((i) => i.Name)).toEqual(["A", "B"]);
  expect(next.t2).toBe(prev.t2);
});

test("mergeThreadContextItems treats an empty incoming list as an explicit clear", () => {
  const prev = { t1: [instance("A"), instance("B")], t2: [instance("Z")] };
  const next = mergeThreadContextItems(prev, "t1", []);

  expect(next).not.toHaveProperty("t1");
  expect(next.t2).toBe(prev.t2);
});

test("mergeThreadContextItems returns the same object when clearing an absent thread key", () => {
  const prev = { t1: [instance("A")] };
  const next = mergeThreadContextItems(prev, "t2", []);

  expect(next).toBe(prev);
});
