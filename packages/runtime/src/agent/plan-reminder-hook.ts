// @summary Runtime-owned plan reminder parsing, cadence, and loop hook

import type { AgentLoopHook } from "@diligent/core/agent";
import type { Message } from "@diligent/core/message-contract";
import { createLogger, type Logger } from "@diligent/logging";

export const PLAN_TOOL_NAME = "plan";
const PLAN_REMINDER_PREFIX = "<system-reminder>";

export type PlanStepStatus = "pending" | "in_progress" | "done" | "cancelled";

export interface PlanStepLike {
  text: string;
  status: PlanStepStatus;
}

const PLAN_STATUSES: readonly PlanStepStatus[] = ["pending", "in_progress", "done", "cancelled"];

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
    (step): step is PlanStepLike =>
      typeof step === "object" &&
      step !== null &&
      typeof (step as { text?: unknown }).text === "string" &&
      PLAN_STATUSES.includes((step as { status?: unknown }).status as PlanStepStatus),
  );
  return valid.length > 0 ? valid : undefined;
}

export function findLatestPlanSteps(messages: readonly Message[]): PlanStepLike[] | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "tool_result" || message.toolName !== PLAN_TOOL_NAME || message.isError) continue;
    const steps = parsePlanSteps(message.output);
    if (steps) return steps;
  }
  return undefined;
}

export function remainingPlanSteps(steps: readonly PlanStepLike[]): PlanStepLike[] {
  return steps.filter((step) => step.status === "pending" || step.status === "in_progress");
}

export function latestUserGoal(messages: readonly Message[], maxChars = 200): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user" || typeof message.content !== "string") continue;
    const text = message.content.trim();
    if (!text) continue;
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }
  return undefined;
}

export function buildPlanReminderMessage(remaining: readonly PlanStepLike[], opts?: { goal?: string }): string {
  const lines = [
    PLAN_REMINDER_PREFIX,
    "The plan still has unfinished steps. Keep working through them and update the plan as each is done — do not tell the user the work is complete while steps remain.",
  ];
  if (opts?.goal) lines.push(`Goal: ${opts.goal}`);
  lines.push("Remaining:", ...remaining.map((step) => `- (${step.status}) ${step.text}`), "</system-reminder>");
  return lines.join("\n");
}

export function createPlanReminderHook(options: { intervalTurns: number; logger?: Logger }): AgentLoopHook {
  let plan: PlanStepLike[] | undefined;
  let turnsSinceSurfaced = 0;
  let planUpdatedThisTurn = false;
  let goal: string | undefined;
  const logger = options.logger ?? createLogger({ scope: "runtime.agent.plan-reminder" });

  return {
    id: "plan-reminder",
    restore({ messages }) {
      plan = findLatestPlanSteps(messages);
      turnsSinceSurfaced = 0;
      planUpdatedThisTurn = false;
      goal = undefined;
    },
    onPromptStart({ messages }) {
      goal = latestUserGoal(messages);
    },
    beforeTurn({ compactedThisTurn }) {
      if (options.intervalTurns <= 0 || !plan) return;
      const remaining = remainingPlanSteps(plan);
      if (remaining.length === 0) return;
      if (!compactedThisTurn && turnsSinceSurfaced < options.intervalTurns) return;

      logger.info("plan_reminder_injected", {
        message: `[agent:plan-reminder] injected remaining=${remaining.length} compacted=${compactedThisTurn} turnsSince=${turnsSinceSurfaced}`,
        fields: { remaining: remaining.length, compacted: compactedThisTurn, turnsSince: turnsSinceSurfaced },
      });
      turnsSinceSurfaced = 0;
      return [{ source: "plan-reminder", content: buildPlanReminderMessage(remaining, { goal }) }];
    },
    onToolResult({ result }) {
      if (result.toolName !== PLAN_TOOL_NAME || result.isError) return;
      const steps = parsePlanSteps(result.output);
      if (!steps) return;
      plan = steps;
      planUpdatedThisTurn = true;
    },
    afterTurn() {
      turnsSinceSurfaced = planUpdatedThisTurn ? 0 : turnsSinceSurfaced + 1;
      planUpdatedThisTurn = false;
    },
  };
}
