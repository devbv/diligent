// @summary Shared runtime config loader — single init path for both CLI and Web

import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { findModel, getDefaultModelRef, resolveModel } from "@diligent/core/model-registry";
import type {
  Model,
  ModelRef,
  ProviderName,
  StreamFunction,
  SystemSection,
  ThinkingEffort,
} from "@diligent/core/provider-contract";
import { DEFAULT_PROVIDER, ProviderManager } from "@diligent/core/provider-contract";
import { createLogger } from "@diligent/logging";
import { getBuiltinAgentDefinitions } from "../agent/agent-types";
import type { Mode } from "../agent/mode";
import { type ResolvedAgentDefinition, resolveCustomAgentDefinitions } from "../agent/resolved-agent";
import type { AgentMetadata } from "../agents/index";
import { discoverAgents, renderAgentsSection, resolveSubagentStates, type SubagentCatalogEntry } from "../agents/index";
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
import { ProviderAuthPresenter } from "../auth/provider-auth-presenter";
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
import { DEFAULT_PLAN_REMINDER_INTERVAL_TURNS, type DiligentConfig } from "./schema";
import { resolveConfiguredUserId } from "./user-id";

const logger = createLogger({ scope: "runtime.config" });

/** Resolve startup selection from persisted state, then provider-level defaults. */
export function resolveRuntimeModel(
  lastSelectedModelRef: ModelRef | undefined,
  configuredProviders: ProviderName[],
): Model {
  const lastSelectedModel = lastSelectedModelRef ? findModel(lastSelectedModelRef) : undefined;
  if (
    lastSelectedModel &&
    (configuredProviders.length === 0 || configuredProviders.includes(lastSelectedModel.provider as ProviderName))
  ) {
    return lastSelectedModel;
  }

  const provider = configuredProviders[0] ?? DEFAULT_PROVIDER;
  return resolveModel(getDefaultModelRef(provider));
}

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
  providerAuthPresenter?: ProviderAuthPresenter;
  authStore: AuthStoreOptions;
  experimentDefinitions: ExperimentDefinition[];
  experiments: ResolvedExperiment[];
  disabledToolNames: Set<string>;
  disabledSkillNames: Set<string>;
  disabledAgentNames: Set<string>;
}

export async function loadRuntimeConfig(
  cwd: string,
  paths: DiligentPaths,
  options?: { bundledToolProviders?: BundledToolProvider[]; experimentDefinitions?: ExperimentDefinition[] },
): Promise<RuntimeConfig> {
  const { config, sources, layers } = await loadDiligentConfig(cwd);
  const experimentDefinitions = options?.experimentDefinitions ?? [];
  const experiments = resolveExperimentStates(experimentDefinitions, config.experiments?.overrides);
  const { disabledToolNames, disabledSkillNames, disabledAgentNames } = resolveExperimentGates(experiments);
  const resolvedUserId = await resolveConfiguredUserId(config.userId);
  const instructions = await discoverInstructions(cwd);
  const authStore: AuthStoreOptions = {
    mode: (config.provider?.auth?.credentialsStore ?? "auto") as AuthCredentialsStoreMode,
  };

  // Create ProviderManager — no throw on missing keys, deferred to call time
  const providerManager = new ProviderManager({
    ...config,
  });
  const providerAuthPresenter = new ProviderAuthPresenter(providerManager);

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
      streamOptions: {
        useWebSocketForGpt56: process.env.DILIGENT_CHATGPT_WEBSOCKET === "1",
      },
    });
    try {
      await chatgptAuth.auth.ensureFresh?.();
      providerManager.setExternalAuth("chatgpt", chatgptAuth.auth);
      providerAuthPresenter.setExternalAuth("chatgpt", chatgptAuth.presentation);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("oauth_refresh_failed", {
        message: `[auth] ChatGPT OAuth refresh failed during startup; sign in again to use ChatGPT: ${message}`,
        error,
        fields: { provider: "chatgpt" },
      });
      await removeOAuthTokens(authStore).catch(() => {});
    }
  }

  if (config.provider?.vertex) {
    const vertexAuth = createVertexAccessTokenBinding(config.provider.vertex);
    providerManager.setExternalAuth("vertex", vertexAuth.auth);
    providerAuthPresenter.setExternalAuth("vertex", vertexAuth.presentation);
  }

  const streamFunction = providerManager.createProxyStream();

  // Preserve the last selection when usable; otherwise use the configured provider's policy default.
  const configured = providerManager.getConfiguredProviders();
  const model = resolveRuntimeModel(config.model, configured);

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
  const requiredAgentNames = new Set(
    agentCatalog.filter((entry) => entry.required).map((entry) => entry.definition.name),
  );
  const experimentManagedAgentNames = new Set(
    experimentDefinitions.flatMap((definition) => [...(definition.agentNames ?? [])]),
  );
  const agentDefinitions = resolveSubagentStates(agentCatalog, config.agents, layers)
    .filter((state) => {
      const name = state.definition.name;
      if (requiredAgentNames.has(name)) return true;
      if (disabledAgentNames.has(name)) return false;
      return experimentManagedAgentNames.has(name) || state.available;
    })
    .map((state) => state.definition);
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
      logger.warn("system_prompt_file_not_found", {
        message: `[config] systemPromptFile "${config.systemPromptFile}" not found, using default`,
        fields: { systemPromptFile: config.systemPromptFile },
      });
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
    planReminderIntervalTurns: config.planReminderIntervalTurns ?? DEFAULT_PLAN_REMINDER_INTERVAL_TURNS,
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
    providerAuthPresenter,
    authStore,
    experimentDefinitions,
    experiments,
    disabledToolNames,
    disabledSkillNames,
    disabledAgentNames,
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
