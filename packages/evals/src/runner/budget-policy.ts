// @summary Defines global eval-runner grace above task-declared target budgets

import type { EvalDiagnostic, EvalLimits } from "../task";

export const EVAL_BUDGET_GRACE = {
  turns: 2,
  toolCalls: 1,
} as const;

export function resolveEvalHardLimits(
  targets: Pick<EvalLimits, "maxTurns" | "maxToolCalls">,
): Pick<EvalLimits, "maxTurns" | "maxToolCalls"> {
  return {
    maxTurns: targets.maxTurns + EVAL_BUDGET_GRACE.turns,
    maxToolCalls: targets.maxToolCalls + EVAL_BUDGET_GRACE.toolCalls,
  };
}

export function createBudgetGraceDiagnostics(
  targets: Pick<EvalLimits, "maxTurns" | "maxToolCalls">,
  actual: { turns: number; toolCalls: number },
): EvalDiagnostic[] {
  const diagnostics: EvalDiagnostic[] = [];
  if (actual.turns > targets.maxTurns) {
    diagnostics.push({
      dimension: "efficiency",
      code: "budget_grace.turns",
      message: `Used ${actual.turns} provider turns against target ${targets.maxTurns}.`,
    });
  }
  if (actual.toolCalls > targets.maxToolCalls) {
    diagnostics.push({
      dimension: "efficiency",
      code: "budget_grace.tool_calls",
      message: `Used ${actual.toolCalls} tool calls against target ${targets.maxToolCalls}.`,
    });
  }
  return diagnostics;
}
