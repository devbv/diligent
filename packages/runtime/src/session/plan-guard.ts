// @summary Guards against ending a run while the current run's plan still has unfinished steps

import type { AssistantMessage } from "@diligent/core/types";

const PLAN_TOOL_NAME = "plan";
const DEFAULT_MAX_NUDGES = 2;

type TrackedStepStatus = "pending" | "in_progress" | "done" | "cancelled";

interface TrackedPlanStep {
  text: string;
  status: TrackedStepStatus;
}

/**
 * Watches a single run's agent events and decides whether the model should be
 * nudged to keep working instead of yielding the turn.
 *
 * Nudges when the model ends its turn (no tool calls) while the plan it wrote
 * during THIS run still has pending/in_progress steps. Bounded by a per-run cap
 * and a no-consecutive-nudges rule: if the model yields again immediately after
 * a nudge (e.g. the remaining step genuinely needs the user), the yield is
 * respected.
 */
export class PlanCompletionGuard {
  /** Latest plan steps observed this run — null until the plan tool is called. */
  private latestSteps: TrackedPlanStep[] | null = null;
  private nudgeCount = 0;
  /** True when the assistant message being evaluated is a response to our nudge. */
  private lastYieldWasNudged = false;
  private truncationNudged = false;

  constructor(private readonly maxNudges = DEFAULT_MAX_NUDGES) {}

  /** Feed every parent-thread tool_end event (caller filters out childThreadId events). */
  observeToolEnd(toolName: string, output: string, isError: boolean): void {
    if (toolName !== PLAN_TOOL_NAME || isError) return;
    try {
      const parsed = JSON.parse(output) as { steps?: unknown };
      if (Array.isArray(parsed.steps)) {
        this.latestSteps = parsed.steps.filter(
          (step): step is TrackedPlanStep =>
            typeof step === "object" && step !== null && typeof (step as TrackedPlanStep).text === "string",
        );
      }
    } catch {
      // Malformed plan output — leave previous state untouched.
    }
  }

  /** Called on turn_end. Returns a steering message to inject, or null to allow the yield. */
  maybeNudge(message: AssistantMessage): string | null {
    const hasToolCalls = message.content.some((block) => block.type === "tool_call");
    if (hasToolCalls) {
      // The model made progress since the last nudge — re-arm the guard.
      this.lastYieldWasNudged = false;
      return null;
    }
    if (message.stopReason === "aborted" || message.stopReason === "error") return null;
    if (message.stopReason === "max_tokens") return this.maybeTruncationNudge();
    // The model yielded again right after a nudge — treat it as deliberate
    // (e.g. the remaining step needs the user) and respect it.
    if (this.lastYieldWasNudged) return null;

    const remaining = (this.latestSteps ?? []).filter(
      (step) => step.status === "pending" || step.status === "in_progress",
    );
    if (remaining.length === 0) return null;
    if (this.nudgeCount >= this.maxNudges) return null;

    this.nudgeCount++;
    this.lastYieldWasNudged = true;
    const list = remaining.map((step) => `- [${step.status}] ${step.text}`).join("\n");
    return [
      "[Plan reminder] The plan for this task still has unfinished steps:",
      list,
      "Do not stop yet. Continue working through these steps now, updating the plan as each one completes.",
      "If a step no longer applies, mark it cancelled with the plan tool.",
      "If a step needs the user's decision, confirmation, or testing, ask them with the request_user_input tool (or end your turn clearly stating what you need from them) instead of continuing blindly.",
      "Only end your turn when every step is done or cancelled, or you are blocked on the user.",
    ].join("\n");
  }

  private maybeTruncationNudge(): string | null {
    if (this.truncationNudged) return null;
    this.truncationNudged = true;
    return "[Continue] Your previous message was cut off by the output token limit. Continue exactly where you left off.";
  }
}
