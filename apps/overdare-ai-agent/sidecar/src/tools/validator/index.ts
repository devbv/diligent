// @summary OVERDARE validator bundled tool provider for Luau validation.

import type { Tool } from "@diligent/core/tool-contract";
import type { BundledToolProvider, RuntimeToolHost } from "@diligent/runtime";
import type { z } from "zod";
import * as validatelua from "./validatelua";

export function createValidatorToolProvider(): BundledToolProvider {
  return {
    id: "@overdare/validator-tools",
    displayName: "OVERDARE Validator Tools",
    supersedesPluginPackages: ["@overdare/plugin-validator"],
    createTools: ({ cwd, host }) => createValidatorTools(cwd, host),
  };
}

function createValidatorTools(cwd: string, host?: RuntimeToolHost): Tool[] {
  return [
    {
      name: validatelua.name,
      description: validatelua.description,
      parameters: validatelua.parameters,
      supportParallel: false,
      execute: (args, ctx) => {
        const toolContext = {
          toolCallId: ctx.toolCallId,
          signal: ctx.signal,
          approve: host?.approve ?? (async () => "once" as const),
        };
        return validatelua.execute(args as z.infer<typeof validatelua.parameters>, toolContext, cwd);
      },
    },
  ];
}
