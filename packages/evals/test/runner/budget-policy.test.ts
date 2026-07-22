// @summary Tests shared eval target-budget grace and hard-stop calculation

import { describe, expect, test } from "bun:test";
import { createBudgetGraceDiagnostics, EVAL_BUDGET_GRACE, resolveEvalHardLimits } from "../../src/runner/budget-policy";

describe("eval budget policy", () => {
  test("keeps task budgets as targets and adds fixed global execution grace", () => {
    expect(EVAL_BUDGET_GRACE).toEqual({ turns: 2, toolCalls: 1 });
    expect(resolveEvalHardLimits({ maxTurns: 5, maxToolCalls: 4 })).toEqual({
      maxTurns: 7,
      maxToolCalls: 5,
    });
  });

  test("reports target overruns as non-gating efficiency diagnostics", () => {
    expect(
      createBudgetGraceDiagnostics({ maxTurns: 5, maxToolCalls: 4 }, { turns: 6, toolCalls: 5 }).map(
        (diagnostic) => diagnostic.code,
      ),
    ).toEqual(["budget_grace.turns", "budget_grace.tool_calls"]);
    expect(createBudgetGraceDiagnostics({ maxTurns: 5, maxToolCalls: 4 }, { turns: 5, toolCalls: 4 })).toEqual([]);
  });
});
