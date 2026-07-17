// @summary OVERDARE RAG bundled tool provider for product-owned search tools.

import type { Tool } from "@diligent/core/tool-contract";
import type { BundledToolProvider, RuntimeToolHost } from "@diligent/runtime";
import type { z } from "zod";
import * as overdaresearch from "./overdaresearch";
import * as overdaresearchDeep from "./overdaresearch-deep";

export function createRagToolProvider(): BundledToolProvider {
  return {
    id: "@overdare/rag-tools",
    displayName: "OVERDARE RAG Tools",
    supersedesPluginPackages: ["@overdare/plugin-rag"],
    createTools: ({ host }) => createRagTools(host),
  };
}

function createRagTools(host?: RuntimeToolHost): Tool[] {
  return [
    {
      name: overdaresearch.name,
      description: overdaresearch.description,
      parameters: overdaresearch.parameters,
      supportParallel: true,
      execute: (args, ctx) => overdaresearch.execute(args as z.infer<typeof overdaresearch.parameters>, ctx, host),
    },
    {
      name: overdaresearchDeep.name,
      description: overdaresearchDeep.description,
      parameters: overdaresearchDeep.parameters,
      supportParallel: true,
      execute: (args, ctx) =>
        overdaresearchDeep.execute(args as z.infer<typeof overdaresearchDeep.parameters>, ctx, host),
    },
  ];
}
