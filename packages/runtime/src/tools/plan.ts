// @summary Plan tool — create and update a visible task checklist during long-horizon execution

import type { Tool, ToolContext, ToolResult } from "@diligent/core/tool-contract";
import { z } from "zod";
import planDescription from "./default/plan-description.txt" with { type: "text" };
import { createPlanRenderPayload } from "./render-payload";

const PlanStep = z.object({
  text: z.string().describe("Step description"),
  status: z
    .enum(["pending", "in_progress", "done", "cancelled"])
    .default("pending")
    .describe(
      "Step status: 'pending' (not started), 'in_progress' (currently active), 'done' (completed), or 'cancelled' (no longer needed)",
    ),
});

const PlanParams = z.object({
  steps: z.array(PlanStep).min(1).describe("Ordered list of steps in the plan"),
  title: z.string().optional().describe("Optional plan title (default: 'Plan')"),
});

export type PlanStep = z.infer<typeof PlanStep>;

export function createPlanTool(): Tool<typeof PlanParams> {
  return {
    name: "plan",
    supportParallel: true,
    description: planDescription,
    parameters: PlanParams,
    execute: async (args, _ctx: ToolContext): Promise<ToolResult> => {
      if (!Array.isArray(args.steps) || args.steps.length === 0) {
        throw new Error("Plan must include at least one step");
      }

      const steps = args.steps.map((s) => ({ text: s.text, status: s.status ?? "pending" }));
      const pending = steps.filter((s) => s.status === "pending").length;
      const inProgress = steps.filter((s) => s.status === "in_progress").length;
      const done = steps.filter((s) => s.status === "done").length;
      const cancelled = steps.filter((s) => s.status === "cancelled").length;
      const remaining = pending + inProgress;

      let hint: string;
      if (remaining === 0 && done + cancelled === steps.length) {
        hint = "All steps resolved. Summarize results to the user.";
      } else if (remaining > 0) {
        hint = `${done}/${steps.length} done, ${inProgress} in progress, ${pending} pending${cancelled > 0 ? `, ${cancelled} cancelled` : ""}. Continue working.`;
      } else {
        hint = "Update the plan as you progress.";
      }

      return {
        output: JSON.stringify({
          title: args.title ?? "Plan",
          steps,
          hint,
        }),
        render: createPlanRenderPayload({
          title: args.title,
          steps,
          hint,
        }),
      };
    },
  };
}
