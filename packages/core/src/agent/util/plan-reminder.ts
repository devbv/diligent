// @summary Plan-reminder helpers — parse plan tool output and build a recitation message

import type { Message } from "../../types";

/**
 * The runtime `plan` tool's registered name. This is the single coupling point where
 * core reads a runtime-owned tool's JSON output shape (mirrors how doom-loop behavior
 * is hardcoded in core). `parsePlanSteps` is defensive: any unknown/aborted/malformed
 * output yields `undefined`, so the loop simply skips reminding rather than misfiring.
 */
export const PLAN_TOOL_NAME = "plan";

export type PlanStepStatus = "pending" | "in_progress" | "done" | "cancelled";

export interface PlanStepLike {
  text: string;
  status: PlanStepStatus;
}

const PLAN_STATUSES: readonly PlanStepStatus[] = ["pending", "in_progress", "done", "cancelled"];

/**
 * Parse a plan tool_result `output` JSON string into steps. Returns `undefined` for
 * non-plan output, aborted results (`"[Aborted by user]"`), malformed JSON, or a shape
 * without a valid `steps` array — callers then skip the reminder.
 */
export function parsePlanSteps(output: string): PlanStepLike[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const steps = (parsed as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return undefined;
  const valid = steps.filter(
    (s): s is PlanStepLike =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as { text?: unknown }).text === "string" &&
      PLAN_STATUSES.includes((s as { status?: unknown }).status as PlanStepStatus),
  );
  return valid.length > 0 ? valid : undefined;
}

/**
 * Scan a conversation backwards for the most recent parseable `plan` tool_result.
 * Used to seed session plan state on resume without a dedicated plan store.
 */
export function findLatestPlanSteps(messages: Message[]): PlanStepLike[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "tool_result" || msg.toolName !== PLAN_TOOL_NAME) continue;
    const steps = parsePlanSteps(msg.output);
    if (steps) return steps;
  }
  return undefined;
}

/** Steps still requiring work (pending or in_progress). */
export function remainingPlanSteps(steps: PlanStepLike[]): PlanStepLike[] {
  return steps.filter((s) => s.status === "pending" || s.status === "in_progress");
}

/**
 * The most recent user request in the conversation, truncated — used to re-anchor the
 * original goal in the reminder (Manus-style objective recitation) so the model does not
 * drift off the task over a long run.
 */
export function latestUserGoal(messages: Message[], maxChars = 200): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user" || typeof msg.content !== "string") continue;
    const text = msg.content.trim();
    if (!text) continue;
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }
  return undefined;
}

/**
 * Build the self-contained recitation message pushed into the conversation tail. Lists the
 * remaining step texts inline (survives compaction), re-anchors the original goal, and nudges
 * the model to keep the plan itself current — all soft, no forced continuation.
 */
export function buildPlanReminderMessage(
  remaining: PlanStepLike[],
  opts?: { goal?: string; turnsSinceUpdate?: number },
): string {
  const lines = remaining.map((s) => `- (${s.status}) ${s.text}`).join("\n");
  const turns = opts?.turnsSinceUpdate ?? 0;
  const stale = turns > 0 ? ` (last plan update: ${turns} turn${turns === 1 ? "" : "s"} ago)` : "";
  const parts = [
    "[Plan reminder]",
    opts?.goal ? `You are still working on this task: "${opts.goal}".` : undefined,
    "Your active plan still has unfinished steps — do not tell the user the work is done until each is finished or cancelled.",
    "Remaining steps:",
    lines,
    `Keep the plan current: mark each step done as you finish it, cancel steps that no longer apply, and revise the plan if the approach changed.${stale}`,
    "Continue working now. If a step genuinely needs the user's decision, confirmation, or testing, ask with the request_user_input tool instead of stopping silently.",
  ];
  return parts.filter((p): p is string => p !== undefined).join("\n");
}
