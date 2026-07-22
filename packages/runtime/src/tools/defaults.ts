// @summary Shared default tool assembly used by both CLI and Web server

import { dirname, join } from "node:path";
import type { ProviderName } from "@diligent/core/provider-contract";
import type { Tool } from "@diligent/core/tool-contract";
import { openBrowser } from "../auth";
import type { AgentRegistry, CollabToolDeps } from "../collab";
import { createCollabTools } from "../collab";
import { getGlobalConfigPath } from "../config";
import type { DiligentConfig } from "../config/schema";
import type { DiligentPaths } from "../infrastructure";
import type { SkillMetadata } from "../skills";
import { createApplyPatchTool } from "./apply-patch";
import { createBashTool } from "./bash";
import type { BundledToolProvider } from "./bundled-provider";
import type { RuntimeToolHost } from "./capabilities";
import type { PluginLoadError, PluginStateEntry, ToolStateEntry } from "./catalog";
import { buildToolCatalog } from "./catalog";
import { createEditTool, createMultiEditTool } from "./edit";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { createLsTool } from "./ls";
import { createMcpToolProvider, getMcpManager } from "./mcp";
import { createPlanTool } from "./plan";
import type { PluginDiscoveryMode } from "./plugin-loader";
import { createReadTool } from "./read";
import { createReadImageTool } from "./read-image";
import { createRequestUserInputTool } from "./request-user-input";
import { createSearchKnowledgeTool } from "./search-knowledge";
import { createSkillTool } from "./skill";
import { createSleepTool } from "./sleep";
import { createUpdateKnowledgeTool } from "./update-knowledge";
import { createWebTool } from "./web";

export interface BuildDefaultToolsResult {
  tools: Tool[];
  registry?: AgentRegistry;
  toolState: ToolStateEntry[];
  pluginState: PluginStateEntry[];
  pluginErrors: PluginLoadError[];
}

export interface BuildDefaultToolsOptions {
  cwd: string;
  paths?: DiligentPaths;
  collabDeps?: Omit<CollabToolDeps, "cwd" | "paths" | "parentTools">;
  toolsConfig?: DiligentConfig["tools"];
  skills?: SkillMetadata[];
  parentToolOverride?: Tool[];
  enableCollabTools?: boolean;
  /**
   * Existing registry to reuse across turns.
   * When provided, the registry's mutable deps are updated but live child-agent
   * entries are preserved so cross-turn spawn→wait works correctly.
   */
  existingRegistry?: AgentRegistry;
  host?: RuntimeToolHost;
  bundledToolProviders?: BundledToolProvider[];
  disabledToolNames?: ReadonlySet<string>;
  provider?: ProviderName;
  /** Whether plugin assembly includes globally discovered packages (default `global`). */
  pluginDiscovery?: PluginDiscoveryMode;
  /** External MCP servers whose tools are exposed to the agent (P069). */
  mcpServers?: DiligentConfig["mcpServers"];
  /**
   * How MCP tools are surfaced to the model. `eager` (default) exposes every tool; `lazy` exposes
   * a single `mcp` search/run proxy; `auto` switches to lazy once the exposed tool count exceeds
   * the threshold. Only the runtime-agent build passes this; the tool-settings surface stays eager.
   */
  mcpToolLoading?: NonNullable<DiligentConfig["mcp"]>["toolLoading"];
  /** Threshold for `auto` mode (see `mcpToolLoading`). */
  mcpLazyThreshold?: number;
  /** Default per-MCP-tool output cap in approx tokens. */
  mcpMaxOutputTokens?: number;
  /** Console-warn threshold for a single MCP tool's output, in approx tokens. */
  mcpWarnOutputTokens?: number;
  /** Expose MCP resource proxy tools when supported (default true). */
  mcpResources?: boolean;
  /** Expose MCP prompt proxy tools when supported (default true). */
  mcpPrompts?: boolean;
}

function createProviderEditTools(
  provider: ProviderName | undefined,
  cwd: string,
  host: RuntimeToolHost | undefined,
): Tool[] {
  if (provider === "openai" || provider === "chatgpt") {
    return [createApplyPatchTool(cwd, host)];
  }
  if (provider === undefined) {
    return [createApplyPatchTool(cwd, host), createEditTool(host), createMultiEditTool(host)];
  }
  return [createEditTool(host), createMultiEditTool(host)];
}

export async function buildDefaultTools(options: BuildDefaultToolsOptions): Promise<BuildDefaultToolsResult> {
  const {
    cwd,
    paths,
    collabDeps,
    toolsConfig,
    skills = [],
    parentToolOverride,
    enableCollabTools = true,
    existingRegistry,
    host,
    bundledToolProviders,
    disabledToolNames,
    provider,
    pluginDiscovery = "global",
    mcpServers,
    mcpToolLoading = "eager",
    mcpLazyThreshold,
    mcpMaxOutputTokens,
    mcpWarnOutputTokens,
    mcpResources,
    mcpPrompts,
  } = options;
  const providers = [...(bundledToolProviders ?? [])];
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    // Guarantee OAuth deps are wired on the very manager the provider will sync, before any
    // connect. The app-server may set these later (with a custom browser opener), but tool builds
    // can run before that wiring — without deps, HTTP OAuth servers connect tokenless and fail
    // with `invalid_token`. Only set when unset so a richer app-server opener is never clobbered.
    const manager = getMcpManager();
    if (!manager.hasOAuthDeps()) {
      manager.setOAuthDeps({ storeDir: join(dirname(getGlobalConfigPath()), "mcp-oauth"), openBrowser });
    }
    providers.push(
      createMcpToolProvider(mcpServers, {
        toolLoading: mcpToolLoading,
        lazyThreshold: mcpLazyThreshold,
        maxOutputTokens: mcpMaxOutputTokens,
        warnOutputTokens: mcpWarnOutputTokens,
        exposeResources: mcpResources,
        exposePrompts: mcpPrompts,
      }),
    );
  }
  const catalog = parentToolOverride
    ? {
        tools: [...parentToolOverride],
        state: [],
        plugins: [],
        pluginErrors: [],
      }
    : await (async () => {
        const webEnabled = toolsConfig?.web_action !== false;

        const builtinTools: Tool[] = [
          createBashTool(cwd, host),
          createSkillTool(skills),
          createReadTool(),
          createReadImageTool(),
          ...createProviderEditTools(provider, cwd, host),
          createLsTool(),
          createGlobTool(cwd),
          createGrepTool(cwd),
          createPlanTool(),
          createRequestUserInputTool(host),
          createSleepTool(),
        ];

        if (webEnabled) {
          builtinTools.push(createWebTool());
        }

        if (paths) {
          builtinTools.push(createSearchKnowledgeTool(paths.knowledge));
          builtinTools.push(createUpdateKnowledgeTool(paths.knowledge));
        }

        return buildToolCatalog(builtinTools, toolsConfig, cwd, host, {
          bundledProviders: providers,
          disabledToolNames,
          pluginDiscovery,
        });
      })();

  // 2. Add collab tools (always enabled, not user-configurable)
  if (enableCollabTools && paths && collabDeps) {
    const parentTools = [...catalog.tools];
    const { tools: collabTools, registry } = createCollabTools(
      {
        ...collabDeps,
        cwd,
        paths,
        parentTools,
      },
      existingRegistry,
    );
    catalog.tools.push(...collabTools);
    return {
      tools: catalog.tools,
      registry,
      toolState: catalog.state,
      pluginState: catalog.plugins,
      pluginErrors: catalog.pluginErrors,
    };
  }

  return {
    tools: catalog.tools,
    toolState: catalog.state,
    pluginState: catalog.plugins,
    pluginErrors: catalog.pluginErrors,
  };
}
