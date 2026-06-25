import type { Tool as CoreTool, ToolContext as CoreToolContext } from "@diligent/core/tool/types";
import type { BundledToolProvider, HookInput, PluginHookFn, RuntimeToolHost } from "@diligent/runtime";
import { call } from "./rpc";
import { methodModules, mutatingMethods, renderBuilders } from "./tool-registry";
import { createCollisionProfileTools } from "./tools/collision-profile-tool";
import { createHubWorldCategoriesListTool } from "./tools/hub-world-categories-list-tool";
import { createHubWorldLookupTool } from "./tools/hub-world-lookup-tool";
import { createInstanceDeleteTool } from "./tools/instance-delete-tool";
import { createInstanceMoveTool } from "./tools/instance-move-tool";
import { createInstanceReadTool } from "./tools/instance-read-tool";
import { createInstanceUpsertTool } from "./tools/instance-upsert-tool";
import { createScriptAddTool } from "./tools/script-add-tool";
import { createScriptDeleteTool } from "./tools/script-delete-tool";
import { createScriptEditTool } from "./tools/script-edit-tool";
import { createScriptGrepTool } from "./tools/script-grep-tool";
import { createScriptReadTool } from "./tools/script-read-tool";
import type { Tool } from "./types";
import { createWriteLock } from "./write-lock";

type StudioRpcToolContext = CoreToolContext & {
  approve: NonNullable<RuntimeToolHost["approve"]>;
};

export interface StudioRpcToolProviderOptions {
  callRpc?: typeof call;
}

export function createStudioRpcToolProvider(options: StudioRpcToolProviderOptions = {}): BundledToolProvider {
  const callRpc = options.callRpc ?? call;
  const saveLevel: PluginHookFn = async (_input: HookInput) => {
    await callRpc("level.save.file", {});
    return { blocked: false };
  };
  saveLevel.mode = "sync";

  return {
    id: "@overdare/studiorpc-tools",
    displayName: "OVERDARE Studio RPC Tools",
    supersedesPluginPackages: ["@overdare/plugin-studiorpc"],
    createTools: async ({ cwd, host }) => createCoreTools(await createStudioRpcTools({ cwd, host, callRpc })),
    onUserPromptSubmit: saveLevel,
    onStop: saveLevel,
  };
}

function toToolName(method: string): string {
  return `studiorpc_${method.replace(/\./g, "_")}`;
}

function withApproval(ctx: CoreToolContext, host?: RuntimeToolHost): StudioRpcToolContext {
  return {
    ...ctx,
    approve: host?.approve ?? (async () => "once" as const),
  };
}

export async function createStudioRpcTools(ctx: {
  cwd: string;
  host?: RuntimeToolHost;
  callRpc?: typeof call;
}): Promise<Tool[]> {
  const writeLock = createWriteLock();
  const callRpc = ctx.callRpc ?? call;
  const applyLevelChanges = () => callRpc("level.apply", {});

  const tools: Tool[] = [
    wrapTool(createInstanceReadTool(ctx.cwd), ctx.host),
    wrapTool(createInstanceUpsertTool(ctx.cwd, writeLock), ctx.host),
    wrapTool(createInstanceDeleteTool(ctx.cwd, writeLock), ctx.host),
    wrapTool(createInstanceMoveTool(ctx.cwd, writeLock), ctx.host),
    wrapTool(createScriptReadTool(ctx.cwd), ctx.host),
    wrapTool(createScriptGrepTool(ctx.cwd), ctx.host),
    wrapTool(createScriptAddTool(ctx.cwd, writeLock), ctx.host),
    wrapTool(createScriptDeleteTool(ctx.cwd, writeLock), ctx.host),
    wrapTool(createScriptEditTool(ctx.cwd, writeLock), ctx.host),
    ...createCollisionProfileTools(ctx.cwd, writeLock, applyLevelChanges).map((tool) => wrapTool(tool, ctx.host)),
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
        const bundledToolCtx = withApproval(toolCtx, ctx.host);
        const rpcMethod = mod.resolveMethod ? mod.resolveMethod(args as Record<string, unknown>) : method;

        const approval = await bundledToolCtx.approve({
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
          let result: unknown = await callRpc(rpcMethod, normalizedArgs);
          if (mod.postProcess) {
            result = mod.postProcess(result, args as Record<string, unknown>);
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

function wrapTool(tool: Tool, host?: RuntimeToolHost): Tool {
  return {
    ...tool,
    execute: (args, toolCtx) => tool.execute(args, withApproval(toolCtx, host)),
  };
}

function createCoreTools(tools: Tool[]): CoreTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: (args, toolCtx) => tool.execute(args as never, withApproval(toolCtx)),
  }));
}
