// @summary Shared runtime config loader — single init path for both CLI and Web

import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { KNOWN_MODELS, resolveModel } from "@diligent/core/llm/models";
import { ProviderManager } from "@diligent/core/llm/provider-manager";
import type { Model, ProviderName, StreamFunction, SystemSection, ThinkingEffort } from "@diligent/core/llm/types";
import { getBuiltinAgentDefinitions } from "../agent/agent-types";
import type { Mode } from "../agent/mode";
import { type ResolvedAgentDefinition, resolveCustomAgentDefinitions } from "../agent/resolved-agent";
import type { AgentMetadata } from "../agents/index";
import {
  discoverAgents,
  filterAvailableAgentDefinitions,
  renderAgentsSection,
  resolveSubagentStates,
  type SubagentCatalogEntry,
} from "../agents/index";
import type { PermissionEngine } from "../approval/index";
import { createPermissionEngine, createYoloPermissionEngine } from "../approval/index";
import {
  type AuthCredentialsStoreMode,
  type AuthStoreOptions,
  loadAuthStore,
  loadOAuthTokens,
  removeOAuthTokens,
  saveOAuthTokens,
} from "../auth/index";
import { createChatGPTOAuthBinding, createVertexAccessTokenBinding } from "../auth/provider-auth";
import type { ExperimentDefinition, ResolvedExperiment } from "../experiments";
import { resolveExperimentGates, resolveExperimentStates } from "../experiments";
import type { DiligentPaths } from "../infrastructure/index";
import { buildKnowledgeSection, readKnowledge } from "../knowledge/index";
import { buildBaseSystemPrompt } from "../prompt/index";
import type { SkillMetadata } from "../skills/index";
import { discoverSkills, filterAvailableSkills, renderSkillsSection, resolveSkillStates } from "../skills/index";
import type { BundledToolProvider } from "../tools/bundled-provider";
import { buildDefaultTools } from "../tools/defaults";
import { buildSystemPromptWithKnowledge, discoverInstructions } from "./instructions";
import type { DiligentConfigLayers } from "./loader";
import { loadDiligentConfig } from "./loader";
import type { DiligentConfig } from "./schema";
import { resolveConfiguredUserId } from "./user-id";

export interface RuntimeConfig {
  model: Model | undefined;
  effort: ThinkingEffort;
  mode: Mode;
  /** Soft plan reminder cadence in agent turns; 0 disables. See DiligentConfig. */
  planReminderIntervalTurns: number;
  systemPrompt: SystemSection[];
  streamFunction: StreamFunction;
  diligent: DiligentConfig;
  sources: string[];
  configLayers: DiligentConfigLayers;
  discoveredSkills: SkillMetadata[];
  skills: SkillMetadata[];
  discoveredAgents: AgentMetadata[];
  agents: AgentMetadata[];
  agentCatalog: SubagentCatalogEntry[];
  agentDefinitions: ResolvedAgentDefinition[];
  compaction: {
    enabled: boolean;
    reservePercent: number;
    keepRecentTokens: number;
    timeoutMs: number;
  };
  permissionEngine: PermissionEngine;
  providerManager: ProviderManager;
  authStore: AuthStoreOptions;
  experimentDefinitions: ExperimentDefinition[];
  experiments: ResolvedExperiment[];
  disabledToolNames: Set<string>;
  disabledSkillNames: Set<string>;
}

export async function loadRuntimeConfig(
  cwd: string,
  paths: DiligentPaths,
  options?: { bundledToolProviders?: BundledToolProvider[]; experimentDefinitions?: ExperimentDefinition[] },
): Promise<RuntimeConfig> {
  const { config, sources, layers } = await loadDiligentConfig(cwd);
  const experimentDefinitions = options?.experimentDefinitions ?? [];
  const experiments = resolveExperimentStates(experimentDefinitions, config.experiments?.overrides);
  const { disabledToolNames, disabledSkillNames } = resolveExperimentGates(experiments);
  const resolvedUserId = await resolveConfiguredUserId(config.userId);
  const instructions = await discoverInstructions(cwd);
  const authStore: AuthStoreOptions = {
    mode: (config.provider?.auth?.credentialsStore ?? "auto") as AuthCredentialsStoreMode,
  };

  // Create ProviderManager — no throw on missing keys, deferred to call time
  const providerManager = new ProviderManager({
    ...config,
  });

  // Overlay auth.json keys
  const authKeys = await loadAuthStore(authStore);
  for (const [provider, key] of Object.entries(authKeys)) {
    if (typeof key === "string" && key) {
      providerManager.setApiKey(provider as ProviderName, key);
    }
  }

  // Load ChatGPT OAuth tokens and bind them as external provider auth.
  const oauthTokens = await loadOAuthTokens(authStore);
  if (oauthTokens) {
    const chatgptAuth = createChatGPTOAuthBinding({
      initialTokens: oauthTokens,
      onTokensRefreshed: (tokens) => saveOAuthTokens(tokens, authStore),
    });
    try {
      await chatgptAuth.auth.ensureFresh?.();
      providerManager.setExternalAuth("chatgpt", chatgptAuth.auth);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[auth] ChatGPT OAuth refresh failed during startup; sign in again to use ChatGPT: ${message}`);
      await removeOAuthTokens(authStore).catch(() => {});
    }
  }

  if (config.provider?.vertex) {
    const vertexAuth = createVertexAccessTokenBinding(config.provider.vertex);
    providerManager.setExternalAuth("vertex", vertexAuth.auth);
  }

  const streamFunction = providerManager.createProxyStream();

  // Resolve model: use config.model if set, otherwise pick first available from configured providers
  const configured = providerManager.getConfiguredProviders();
  const firstAvailable = KNOWN_MODELS.find((m) => configured.includes(m.provider as ProviderName));
  const configuredModel = config.model ? resolveModel(config.model) : undefined;
  const modelId =
    configuredModel && configured.includes(configuredModel.provider as ProviderName)
      ? configuredModel.id
      : (firstAvailable?.id ?? config.model);
  const model = modelId ? resolveModel(modelId) : undefined;

  // Load knowledge for system prompt injection
  let knowledgeSection = "";
  const knowledgeEnabled = config.knowledge?.enabled ?? true;
  if (knowledgeEnabled) {
    const knowledgeEntries = await readKnowledge(paths.knowledge);
    const injectionBudget = config.knowledge?.injectionBudget ?? 8192;
    const maxItems = config.knowledge?.maxItems;
    knowledgeSection = buildKnowledgeSection(knowledgeEntries, injectionBudget, maxItems);
  }

  // Load skills
  let discoveredSkills: SkillMetadata[] = [];
  let skills: SkillMetadata[] = [];
  let skillsSection = "";
  const skillDiscoveryResult = await discoverSkills({
    cwd,
    additionalPaths: config.skills?.paths,
  });
  discoveredSkills = skillDiscoveryResult.skills;
  skills = filterAvailableSkills(resolveSkillStates(discoveredSkills, config.skills, layers));
  skills = skills.filter((skill) => !disabledSkillNames.has(skill.name));
  skillsSection = renderSkillsSection(skills);

  let agents: AgentMetadata[] = [];
  let agentsSection = "";
  const agentsEnabled = config.agents?.enabled ?? true;
  if (agentsEnabled) {
    const toolsResult = await buildDefaultTools({
      cwd,
      paths,
      toolsConfig: config.tools,
      skills,
      enableCollabTools: false,
      mcpServers: config.mcpServers,
      // Include product-owned bundled tools (e.g. OVERDARE studio RPC tools) so agent frontmatter
      // referencing them validates against the real runtime tool set instead of only the generic
      // built-ins — otherwise shipped agents like studio-explorer emit false "unknown tool" warnings.
      bundledToolProviders: options?.bundledToolProviders,
      disabledToolNames,
    });
    const result = await discoverAgents({
      cwd,
      additionalPaths: config.agents?.paths,
      knownToolNames: toolsResult.toolState.map((tool) => tool.name),
    });
    agents = result.agents;
  }
  const agentCatalog: SubagentCatalogEntry[] = [
    ...getBuiltinAgentDefinitions().map((definition) => ({
      definition,
      source: "builtin" as const,
      required: definition.name === "general",
    })),
    ...resolveCustomAgentDefinitions(agents).map((definition, index) => ({
      definition,
      source: agents[index]!.source,
      required: false,
    })),
  ];
  const agentDefinitions = filterAvailableAgentDefinitions(resolveSubagentStates(agentCatalog, config.agents, layers));
  const availableCustomAgentNames = new Set(
    agentDefinitions.filter((definition) => definition.source === "user").map((definition) => definition.name),
  );
  agentsSection = renderAgentsSection(agents.filter((agent) => availableCustomAgentNames.has(agent.name)));

  // Build system prompt with knowledge AND skills
  let basePrompt: string;
  if (config.systemPrompt) {
    basePrompt = config.systemPrompt;
  } else if (config.systemPromptFile) {
    const filePath = await resolveSystemPromptFile(config.systemPromptFile, sources);
    if (filePath) {
      basePrompt = (await readFile(filePath, "utf-8"))
        .replace(/\{\{currentDate\}\}/g, new Date().toISOString().split("T")[0])
        .replace(/\{\{cwd\}\}/g, cwd)
        .replace(/\{\{platform\}\}/g, process.platform);
    } else {
      console.warn(`[config] systemPromptFile "${config.systemPromptFile}" not found, using default`);
      basePrompt = buildBaseSystemPrompt({
        currentDate: new Date().toISOString().split("T")[0],
        cwd,
        platform: process.platform,
      });
    }
  } else {
    basePrompt = buildBaseSystemPrompt({
      currentDate: new Date().toISOString().split("T")[0],
      cwd,
      platform: process.platform,
    });
  }
  const systemPrompt = buildSystemPromptWithKnowledge(
    basePrompt,
    instructions,
    knowledgeSection,
    config.instructions,
    skillsSection,
    agentsSection,
  );

  return {
    model,
    mode: (config.mode ?? "default") as Mode,
    effort: (config.effort ?? "medium") as ThinkingEffort,
    planReminderIntervalTurns: config.planReminderIntervalTurns ?? 0,
    systemPrompt,
    streamFunction,
    diligent: {
      ...config,
      userId: resolvedUserId,
    },
    sources,
    configLayers: layers,
    discoveredSkills,
    skills,
    discoveredAgents: agents,
    agents,
    agentCatalog,
    agentDefinitions,
    compaction: {
      enabled: config.compaction?.enabled ?? true,
      reservePercent: config.compaction?.reservePercent ?? 14,
      keepRecentTokens: config.compaction?.keepRecentTokens ?? 20000,
      timeoutMs: config.compaction?.timeoutMs ?? 180_000,
    },
    permissionEngine: config.yolo ? createYoloPermissionEngine() : createPermissionEngine(config.permissions ?? []),
    providerManager,
    authStore,
    experimentDefinitions,
    experiments,
    disabledToolNames,
    disabledSkillNames,
  };
}

/**
 * Resolve systemPromptFile path: absolute paths used as-is, relative paths
 * checked against each config file's directory first, then cwd as fallback.
 */
async function resolveSystemPromptFile(file: string, configSources: string[]): Promise<string | null> {
  if (isAbsolute(file)) {
    try {
      await access(file);
      return file;
    } catch {
      return null;
    }
  }

  for (const source of configSources) {
    const candidate = resolve(dirname(source), file);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not found in this config dir, try next
    }
  }

  return null;
}
