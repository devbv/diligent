// @summary Shared default tool assembly used by both CLI and Web server

import type { Tool } from "@diligent/core/tool/types";
import type { AgentRegistry, CollabToolDeps } from "../collab";
import { createCollabTools } from "../collab";
import type { DiligentConfig } from "../config/schema";
import type { DiligentPaths } from "../infrastructure";
import type { SkillMetadata } from "../skills";
import { createApplyPatchTool } from "./apply-patch";
import { createBashTool } from "./bash";
import type { BundledToolProvider } from "./bundled-provider";
import type { RuntimeToolHost } from "./capabilities";
import type { PluginLoadError, PluginStateEntry, ToolStateEntry } from "./catalog";
import { buildToolCatalog } from "./catalog";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { createLsTool } from "./ls";
import { createPlanTool } from "./plan";
import { createReadTool } from "./read";
import { createReadImageTool } from "./read-image";
import { createRequestUserInputTool } from "./request-user-input";
import { createSearchKnowledgeTool } from "./search-knowledge";
import { createSkillTool } from "./skill";
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
  } = options;
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
          createApplyPatchTool(cwd, host),
          createLsTool(),
          createGlobTool(cwd),
          createGrepTool(cwd),
          createPlanTool(),
          createRequestUserInputTool(host),
        ];

        if (webEnabled) {
          builtinTools.push(createWebTool());
        }

        if (paths) {
          builtinTools.push(createSearchKnowledgeTool(paths.knowledge));
          builtinTools.push(createUpdateKnowledgeTool(paths.knowledge));
        }

        return buildToolCatalog(builtinTools, toolsConfig, cwd, host, { bundledProviders: bundledToolProviders });
      })();

  // 2. Add collab tools (always enabled, not user-configurable)
  if (enableCollabTools && paths && collabDeps) {
    const { tools: collabTools, registry } = createCollabTools(
      {
        ...collabDeps,
        cwd,
        paths,
        parentTools: catalog.tools,
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
