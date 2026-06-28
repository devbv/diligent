// @summary Tool settings and state management request handlers

import type { DiligentConfig } from "../config/schema";
import { getGlobalConfigPath, writeGlobalToolsConfig } from "../config/writer";
import {
  type PluginDescriptor,
  type ToolConflictPolicy,
  type ToolDescriptor,
} from "../protocol/index";
import { buildDefaultTools } from "../tools/defaults";
import type { ThreadHandlersContext } from "./thread-handlers";

export async function handleToolsList(
  ctx: ThreadHandlersContext,
  threadId: string | undefined,
): Promise<{
  configPath: string;
  appliesOnNextTurn: true;
  trustMode: "full_trust";
  conflictPolicy: ToolConflictPolicy;
  tools: ToolDescriptor[];
  plugins: PluginDescriptor[];
}> {
  const { cwd, tools } = await ctx.resolveToolsContext(threadId);
  const paths = await ctx.resolvePaths(cwd);
  const result = await buildDefaultTools({
    cwd,
    paths,
    toolsConfig: tools,
    bundledToolProviders: ctx.getBundledToolProviders(),
  });

  return {
    configPath: getGlobalConfigPath(),
    appliesOnNextTurn: true,
    trustMode: "full_trust",
    conflictPolicy: (tools?.conflictPolicy ?? "error") as ToolConflictPolicy,
    tools: result.toolState,
    plugins: result.pluginState.map((plugin) => ({ ...plugin, loadError: plugin.loadError })),
  };
}

export async function handleToolsSet(
  ctx: ThreadHandlersContext,
  toolConfig: {
    getTools: () => DiligentConfig["tools"] | undefined;
    setTools: (tools: DiligentConfig["tools"] | undefined) => void;
  },
  threadId: string | undefined,
  params: {
    web_action?: boolean;
    builtin?: Record<string, boolean>;
    plugins?: Array<{ package: string; enabled?: boolean; tools?: Record<string, boolean>; remove?: boolean }>;
    conflictPolicy?: ToolConflictPolicy;
  },
): Promise<{
  configPath: string;
  appliesOnNextTurn: true;
  trustMode: "full_trust";
  conflictPolicy: ToolConflictPolicy;
  tools: ToolDescriptor[];
  plugins: PluginDescriptor[];
}> {
  const { cwd } = await ctx.resolveToolsContext(threadId);
  const writeResult = await writeGlobalToolsConfig({
    web_action: params.web_action,
    builtin: params.builtin,
    plugins: params.plugins,
    conflictPolicy: params.conflictPolicy,
  });

  toolConfig.setTools(writeResult.config.tools);

  const paths = await ctx.resolvePaths(cwd);
  const result = await buildDefaultTools({
    cwd,
    paths,
    toolsConfig: writeResult.config.tools,
    bundledToolProviders: ctx.getBundledToolProviders(),
  });

  return {
    configPath: writeResult.configPath,
    appliesOnNextTurn: true,
    trustMode: "full_trust",
    conflictPolicy: (writeResult.config.tools?.conflictPolicy ?? "error") as ToolConflictPolicy,
    tools: result.toolState,
    plugins: result.pluginState.map((plugin) => ({ ...plugin, loadError: plugin.loadError })),
  };
}
