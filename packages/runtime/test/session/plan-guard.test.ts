// @summary Unit tests for PlanCompletionGuard — nudges the model when it yields with unfinished plan steps
import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@diligent/core/types";
import { PlanCompletionGuard } from "@diligent/runtime/session";

type StopReason = AssistantMessage["stopReason"];

function textMessage(text = "all done", stopReason: StopReason = "end_turn"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "test-model",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason,
    timestamp: 0,
  };
}

function toolCallMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id: "tc_1", name: "plan", input: {} }],
    model: "test-model",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "tool_use",
    timestamp: 0,
  };
}

function planOutput(steps: Array<{ text: string; status: string }>): string {
  return JSON.stringify({ title: "Plan", steps, hint: "" });
}

describe("PlanCompletionGuard", () => {
  test("no nudge when the plan tool was never observed", () => {
    const guard = new PlanCompletionGuard();
    expect(guard.maybeNudge(textMessage())).toBeNull();
  });

  test("nudges with the remaining steps when the plan has pending work", () => {
    const guard = new PlanCompletionGuard();
    guard.observeToolEnd(
      "plan",
      planOutput([
        { text: "step one", status: "done" },
        { text: "step two", status: "pending" },
        { text: "step three", status: "in_progress" },
      ]),
      false,
    );

    const nudge = guard.maybeNudge(textMessage());
    expect(nudge).not.toBeNull();
    expect(nudge).toContain("[Plan reminder]");
    expect(nudge).toContain("step two");
    expect(nudge).toContain("step three");
    // A completed step must not be listed
    expect(nudge).not.toContain("step one");
  });

  test("no nudge when every step is done or cancelled", () => {
    const guard = new PlanCompletionGuard();
    guard.observeToolEnd(
      "plan",
      planOutput([
        { text: "a", status: "done" },
        { text: "b", status: "cancelled" },
      ]),
      false,
    );
    expect(guard.maybeNudge(textMessage())).toBeNull();
  });

  test("no nudge when the assistant message still contains tool calls", () => {
    const guard = new PlanCompletionGuard();
    guard.observeToolEnd("plan", planOutput([{ text: "a", status: "pending" }]), false);
    expect(guard.maybeNudge(toolCallMessage())).toBeNull();
  });

  test("ignores plan tool errors", () => {
    const guard = new PlanCompletionGuard();
    guard.observeToolEnd("plan", planOutput([{ text: "a", status: "pending" }]), true);
    expect(guard.maybeNudge(textMessage())).toBeNull();
  });

  test("ignores non-plan tools", () => {
    const guard = new PlanCompletionGuard();
    guard.observeToolEnd("bash", planOutput([{ text: "a", status: "pending" }]), false);
    expect(guard.maybeNudge(textMessage())).toBeNull();
  });

  test("ignores malformed plan output and keeps prior state", () => {
    const guard = new PlanCompletionGuard();
    guard.observeToolEnd("plan", planOutput([{ text: "keep me", status: "pending" }]), false);
    guard.observeToolEnd("plan", "not json", false);
    // Progress the model so the guard re-arms, then the earlier state still nudges
    guard.maybeNudge(toolCallMessage());
    const nudge = guard.maybeNudge(textMessage());
    expect(nudge).toContain("keep me");
  });

  test("stops after the max nudge count", () => {
    const guard = new PlanCompletionGuard(2);
    guard.observeToolEnd("plan", planOutput([{ text: "a", status: "pending" }]), false);

    // 1st nudge
    expect(guard.maybeNudge(textMessage())).not.toBeNull();
    // Model made progress (tool call) → re-arm
    guard.maybeNudge(toolCallMessage());
    // 2nd nudge
    expect(guard.maybeNudge(textMessage())).not.toBeNull();
    guard.maybeNudge(toolCallMessage());
    // 3rd attempt exceeds cap → null
    expect(guard.maybeNudge(textMessage())).toBeNull();
  });

  test("does not nudge twice in a row without intervening progress", () => {
    const guard = new PlanCompletionGuard();
    guard.observeToolEnd("plan", planOutput([{ text: "a", status: "pending" }]), false);

    // First yield → nudge
    expect(guard.maybeNudge(textMessage())).not.toBeNull();
    // Model yields again immediately (no tool call) → respect it, no nudge
    expect(guard.maybeNudge(textMessage())).toBeNull();
  });

  test("re-arms after the model makes progress with a tool call", () => {
    const guard = new PlanCompletionGuard();
    guard.observeToolEnd("plan", planOutput([{ text: "a", status: "pending" }]), false);

    expect(guard.maybeNudge(textMessage())).not.toBeNull();
    // Progress
    guard.maybeNudge(toolCallMessage());
    // Yields again with work still pending → nudge again
    expect(guard.maybeNudge(textMessage())).not.toBeNull();
  });

  test("no plan nudge on aborted stop reason", () => {
    const guard = new PlanCompletionGuard();
    guard.observeToolEnd("plan", planOutput([{ text: "a", status: "pending" }]), false);
    expect(guard.maybeNudge(textMessage("x", "aborted"))).toBeNull();
  });

  test("no plan nudge on error stop reason", () => {
    const guard = new PlanCompletionGuard();
    guard.observeToolEnd("plan", planOutput([{ text: "a", status: "pending" }]), false);
    expect(guard.maybeNudge(textMessage("x", "error"))).toBeNull();
  });

  test("max_tokens yields a truncation nudge exactly once", () => {
    const guard = new PlanCompletionGuard();
    const first = guard.maybeNudge(textMessage("cut off", "max_tokens"));
    expect(first).toContain("[Continue]");
    expect(guard.maybeNudge(textMessage("cut off", "max_tokens"))).toBeNull();
  });

  test("truncation nudge fires even without a plan", () => {
    const guard = new PlanCompletionGuard();
    expect(guard.maybeNudge(textMessage("cut off", "max_tokens"))).toContain("[Continue]");
  });
});
