// @summary Built-in provider-native web tool placeholder for catalog/config exposure
import type { Tool } from "@diligent/core/tool-contract";
import { z } from "zod";

const WebParams = z.object({
  query: z.string().min(1).optional(),
  url: z.string().url().optional(),
  prompt: z.string().optional(),
});

export function createWebTool(): Tool<typeof WebParams> {
  return {
    name: "web_action",
    description: "Use the active provider's native web capability for search and page fetching.",
    parameters: WebParams,
    modelExposure: {
      kind: "provider_builtin",
      capability: "web",
      options: { citationsEnabled: true },
    },
    execute: async () => ({
      output: "web_action is handled by the active provider and should not execute locally.",
    }),
  };
}
