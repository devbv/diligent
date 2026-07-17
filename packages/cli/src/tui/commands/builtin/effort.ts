// @summary Thinking effort command with model-aware options and validation

import type { ThinkingEffort } from "@diligent/protocol";
import {
  getThinkingEffortOptions,
  getThinkingEffortUsage,
  resolveModel,
  supportsThinkingEffort,
} from "@diligent/runtime";
import type { ListPickerItem } from "../../components/list-picker";
import { t } from "../../theme";
import type { Command } from "../types";

const EFFORT_ALIASES: Record<string, ThinkingEffort> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export const effortCommand: Command = {
  name: "effort",
  description: "Set thinking level",
  supportsArgs: true,
  handler: async (args, ctx) => {
    const model = resolveModel(ctx.config.model);
    const options = getThinkingEffortOptions(model);

    if (args) {
      const normalized = EFFORT_ALIASES[args.trim().toLowerCase()];
      if (!normalized) {
        ctx.displayError(`Unknown effort: ${args}. Usage: /effort <${getThinkingEffortUsage(model)}>`);
        return;
      }
      const unsupportedEffort = model.supportsThinking && !supportsThinkingEffort(model, normalized);
      if (unsupportedEffort) {
        ctx.displayError(`Thinking effort "${normalized}" is not supported for this model.`);
        return;
      }
      await ctx.setEffort(normalized);
      ctx.onEffortChanged(normalized, normalized);
      ctx.displayLines([`  Thinking set to ${t.bold}${normalized}${t.reset}`]);
      return;
    }

    const items: ListPickerItem[] = options.map((option) => ({
      label: option.label,
      description: option.value,
      value: option.value,
    }));
    const selectedIdx = items.findIndex((item) => item.value === ctx.currentEffort);

    const value = await ctx.app.pick({
      title: "Thinking",
      items,
      selectedIndex: Math.max(0, selectedIdx),
    });
    if (!value) {
      return;
    }
    const effort = value as ThinkingEffort;
    await ctx.setEffort(effort);
    ctx.onEffortChanged(effort, effort);
    ctx.displayLines([`  Thinking set to ${t.bold}${effort}${t.reset}`]);
  },
};
