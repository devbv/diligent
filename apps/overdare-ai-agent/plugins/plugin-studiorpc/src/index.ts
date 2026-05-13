import type { Tool } from "@diligent/plugin-sdk";
import { call } from "./rpc.ts";
import { methodModules, mutatingMethods, renderBuilders } from "./tool-registry.ts";
import { createHubWorldCategoriesListTool } from "./tools/hub-world-categories-list-tool.ts";
import { createHubWorldLookupTool } from "./tools/hub-world-lookup-tool.ts";
import { createInstanceDeleteTool } from "./tools/instance-delete-tool.ts";
import { createInstanceMoveTool } from "./tools/instance-move-tool.ts";
import { createInstanceReadTool } from "./tools/instance-read-tool.ts";
import { createInstanceUpsertTool } from "./tools/instance-upsert-tool.ts";
import { createScriptAddTool } from "./tools/script-add-tool.ts";
import { createScriptDeleteTool } from "./tools/script-delete-tool.ts";
import { createScriptEditTool } from "./tools/script-edit-tool.ts";
import { createScriptGrepTool } from "./tools/script-grep-tool.ts";
import { createScriptReadTool } from "./tools/script-read-tool.ts";
import { createWriteLock } from "./write-lock.ts";

export const manifest = {
  name: "@overdare/plugin-studiorpc",
  apiVersion: "1.0",
  version: "0.1.0",
};

function toToolName(method: string): string {
  return `studiorpc_${method.replace(/\./g, "_")}`;
}

export async function createTools(ctx: { cwd: string }): Promise<Tool[]> {
  const writeLock = createWriteLock();

  const tools: Tool[] = [
    createInstanceReadTool(ctx.cwd),
    createInstanceUpsertTool(ctx.cwd, writeLock),
    createInstanceDeleteTool(ctx.cwd, writeLock),
    createInstanceMoveTool(ctx.cwd, writeLock),
    createScriptReadTool(ctx.cwd),
    createScriptGrepTool(ctx.cwd),
    createScriptAddTool(ctx.cwd, writeLock),
    createScriptDeleteTool(ctx.cwd, writeLock),
    createScriptEditTool(ctx.cwd, writeLock),
    createHubWorldLookupTool(),
    createHubWorldCategoriesListTool(),
  ];

  for (const mod of methodModules) {
    const { method, description, params } = mod;
    const toolName = toToolName(method);

    tools.push({
      name: toolName,
      description,
      parameters: params,
      async execute(args, toolCtx) {
        const rpcMethod = mod.resolveMethod ? mod.resolveMethod(args as Record<string, unknown>) : method;

        const approval = await toolCtx.approve({
          permission: "execute",
          toolName,
          description: `Studio RPC: ${rpcMethod}`,
          details: { method: rpcMethod, params: args },
        });

        if (approval === "reject") {
          return {
            output: "[Rejected by user]",
            metadata: { error: true, method: rpcMethod },
          };
        }

        const isMutating = mutatingMethods.has(method);
        const release = isMutating ? await writeLock.acquire() : undefined;
        try {
          const normalizedArgs = mod.normalizeArgs
            ? mod.normalizeArgs(args as Record<string, unknown>)
            : (args as Record<string, unknown>);
          let result: unknown = await call(rpcMethod, normalizedArgs);
          if (mod.postProcess) {
            result = mod.postProcess(result, args as Record<string, unknown>);
          }
          if (isMutating) {
            await call("level.save.file", {});
          }
          const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          const renderBuilder = renderBuilders[toolName];
          const render = renderBuilder?.({ args: args as Record<string, unknown>, normalizedArgs, output, result });

          return {
            output,
            render,
            metadata: { method: rpcMethod, result },
          };
        } finally {
          release?.();
        }
      },
    });
  }

  return tools;
}
