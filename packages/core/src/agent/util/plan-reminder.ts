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
  const turnsAgo = opts?.turnsSinceUpdate ?? 0;
  const staleNote = turnsAgo > 0 ? ` (last plan update: ${turnsAgo} turn${turnsAgo === 1 ? "" : "s"} ago)` : "";

  const lines: string[] = ["[Plan reminder]"];
  if (opts?.goal) lines.push(`You are still working on this task: "${opts.goal}".`);
  lines.push(
    "Your active plan still has unfinished steps — do not tell the user the work is done until each is finished or cancelled.",
    "Remaining steps:",
    ...remaining.map((step) => `- (${step.status}) ${step.text}`),
    `Keep the plan current: mark each step done as you finish it, cancel steps that no longer apply, and revise the plan if the approach changed.${staleNote}`,
    "Continue working now. If a step genuinely needs the user's decision, confirmation, or testing, ask with the request_user_input tool instead of stopping silently.",
  );
  return lines.join("\n");
}

/**
 * Tracks the current run's plan and decides when to re-inject ("recite") the unfinished
 * steps so the model does not drift off and stop early. Purely advisory — it never forces
 * another turn. Mirrors {@link DoomLoopDetector}: the loop feeds it turn events and asks it
 * for a decision, keeping the loop free of scattered counters and inline conditions.
 *
 * A reminder fires only on genuine drift: the plan went `intervalTurns` turns without the
 * model touching it (or compaction just dropped it) while steps remain. Any plan update is
 * itself a recite (it lands at the tail), so it resets the cadence — an actively maintained
 * plan almost never triggers a reminder.
 */
export class PlanReminder {
  private plan: PlanStepLike[] | undefined;
  private turnsSinceSurfaced = 0;
  private planUpdatedThisTurn = false;

  constructor(
    private readonly intervalTurns: number,
    seedPlan?: PlanStepLike[],
  ) {
    this.plan = seedPlan;
  }

  /** The latest plan seen — returned by the loop so it survives compaction and re-prompts. */
  get currentPlan(): PlanStepLike[] | undefined {
    return this.plan;
  }

  /** Feed every tool result of the turn; only the `plan` tool is relevant. */
  recordToolResult(toolName: string, output: string, isError: boolean): void {
    if (toolName !== PLAN_TOOL_NAME || isError) return;
    const steps = parsePlanSteps(output);
    if (!steps) return;
    this.plan = steps;
    this.planUpdatedThisTurn = true;
  }

  /**
   * Called at the top of a turn. Returns the reminder message to inject, or `null` to stay
   * quiet. The injected reminder is itself a recite, so the cadence restarts here (it still
   * advances by one in {@link endTurn} because the model runs a full turn after this point).
   */
  reminderForTurn(opts: { compactedThisTurn: boolean; goal?: string }): string | null {
    if (!this.shouldRemind(opts.compactedThisTurn)) return null;
    const remaining = remainingPlanSteps(this.plan ?? []);
    console.info(
      `[agent:plan-reminder] injected remaining=${remaining.length} compacted=${opts.compactedThisTurn} turnsSince=${this.turnsSinceSurfaced}`,
    );
    const message = buildPlanReminderMessage(remaining, { goal: opts.goal, turnsSinceUpdate: this.turnsSinceSurfaced });
    this.turnsSinceSurfaced = 0;
    return message;
  }

  /** Advance the cadence once per turn. A turn that updated the plan resets it to zero. */
  endTurn(): void {
    this.turnsSinceSurfaced = this.planUpdatedThisTurn ? 0 : this.turnsSinceSurfaced + 1;
    this.planUpdatedThisTurn = false;
  }

  private shouldRemind(compactedThisTurn: boolean): boolean {
    if (this.intervalTurns <= 0) return false; // feature disabled
    if (!this.plan) return false; // no plan set yet
    if (remainingPlanSteps(this.plan).length === 0) return false; // every step done or cancelled
    if (compactedThisTurn) return true; // compaction just dropped the plan — re-inject now
    return this.turnsSinceSurfaced >= this.intervalTurns; // buried out of the tail for N turns
  }
}
