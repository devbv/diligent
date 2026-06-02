// @summary OVERDARE-owned hello-world bundled tool provider for runtime smoke testing.

import type { Tool } from "@diligent/core/tool/types";
import type { BundledToolProvider } from "@diligent/runtime";
import { z } from "zod";

export interface StudioToolProviderOptions {
  cwd: string;
  studioRpcPort?: number;
  hubDomain?: string;
  projectId?: string;
}

export function createHelloWorldToolProvider(options: StudioToolProviderOptions): BundledToolProvider {
  return {
    id: "@overdare/hello-world-tools",
    displayName: "OVERDARE Hello World Tools",
    createTools: () => [createHelloWorldTool(options)],
  };
}

function createHelloWorldTool(options: StudioToolProviderOptions): Tool {
  return {
    name: "hello_world",
    description: "Say hello from an OVERDARE bundled product tool.",
    parameters: z.object({
      name: z.string().optional().describe("Optional name to greet."),
    }),
    execute: async (args) => ({
      output: `Hello, ${args.name ?? "world"}! cwd=${options.cwd}`,
    }),
  };
}
