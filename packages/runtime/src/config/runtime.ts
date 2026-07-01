// @summary Shared runtime config loader — single init path for both CLI and Web

import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { KNOWN_MODELS, resolveModel } from "@diligent/core/llm/models";
import { ProviderManager } from "@diligent/core/llm/provider-manager";
import type { Model, ProviderName, StreamFunction, SystemSection, ThinkingEffort } from "@diligent/core/llm/types";
import { getBuiltinAgentDefinitions } from "../agent/agent-types";
import type { Mode } from "../agent/mode";
import { type ResolvedAgentDefinition, resolveAvailableAgentDefinitions } from "../agent/resolved-agent";
import type { AgentMetadata } from "../agents/index";
import { discoverAgents, renderAgentsSection } from "../agents/index";
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
import type { DiligentPaths } from "../infrastructure/index";
import { buildKnowledgeSection, readKnowledge } from "../knowledge/index";
import { buildBaseSystemPrompt } from "../prompt/index";
import type { SkillMetadata } from "../skills/index";
import { discoverSkills, renderSkillsSection } from "../skills/index";
import { buildDefaultTools } from "../tools/defaults";
import { buildSystemPromptWithKnowledge, discoverInstructions } from "./instructions";
import { loadDiligentConfig } from "./loader";
import type { DiligentConfig } from "./schema";
import { resolveConfiguredUserId } from "./user-id";

export interface RuntimeConfig {
  model: Model | undefined;
  effort: ThinkingEffort;
  mode: Mode;
  systemPrompt: SystemSection[];
  streamFunction: StreamFunction;
  diligent: DiligentConfig;
  sources: string[];
  skills: SkillMetadata[];
  agents: AgentMetadata[];
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
}

export async function loadRuntimeConfig(cwd: string, paths: DiligentPaths): Promise<RuntimeConfig> {
  const { config, sources } = await loadDiligentConfig(cwd);
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
  let skills: SkillMetadata[] = [];
  let skillsSection = "";
  const skillsEnabled = config.skills?.enabled ?? true;
  if (skillsEnabled) {
    const result = await discoverSkills({
      cwd,
      additionalPaths: config.skills?.paths,
    });
    skills = result.skills;
    skillsSection = renderSkillsSection(skills);
  }

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
    });
    const result = await discoverAgents({
      cwd,
      additionalPaths: config.agents?.paths,
      knownToolNames: toolsResult.toolState.map((tool) => tool.name),
    });
    agents = result.agents;
    agentsSection = renderAgentsSection(agents);
  }
  const agentDefinitions = resolveAvailableAgentDefinitions(getBuiltinAgentDefinitions(), agents);

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
    systemPrompt,
    streamFunction,
    diligent: {
      ...config,
      userId: resolvedUserId,
    },
    sources,
    skills,
    agents,
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
