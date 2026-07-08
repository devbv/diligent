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
 * Build the self-contained recitation message pushed into the conversation tail.
 * It lists the remaining step texts inline so it still works after the original plan
 * tool_result has been summarized away by compaction.
 */
export function buildPlanReminderMessage(remaining: PlanStepLike[]): string {
  const lines = remaining.map((s) => `- (${s.status}) ${s.text}`).join("\n");
  return [
    "[Reminder: your active plan still has unfinished steps — do not end your turn until each is done or cancelled.",
    "Remaining steps:",
    lines,
    "Continue working, or call the `plan` tool to update/cancel steps if the plan has changed.]",
  ].join("\n");
}
