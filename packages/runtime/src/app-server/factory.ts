// @summary Factory that builds a DiligentAppServerConfig from a RuntimeConfig, eliminating Web/CLI duplication
import { dirname, join } from "node:path";
import { getModelInfoList, resolveModel } from "@diligent/core/llm/models";
import type { ProviderName } from "@diligent/core/llm/types";
import {
  EXECUTE_MODE_DISALLOWED_TOOLS,
  MODE_SYSTEM_PROMPT_SUFFIXES,
  type Mode,
  PLAN_MODE_DISALLOWED_TOOLS,
} from "../agent/mode";
import { RuntimeAgent } from "../agent/runtime-agent";
import { openBrowser as defaultOpenBrowser } from "../auth";
import { applyConsentPatch, refreshPrivacyPolicyUrl, resolveConsentState } from "../config/consent";
import { loadDiligentConfig } from "../config/loader";
import { loadRuntimeConfig, type RuntimeConfig } from "../config/runtime";
import { getGlobalConfigPath, saveGlobalConsent, saveGlobalModel } from "../config/writer";
import { type DiligentPaths, ensureDiligentDir } from "../infrastructure";
import { discoverSkills } from "../skills";
import type { BundledToolProvider } from "../tools/bundled-provider";
import { buildDefaultTools } from "../tools/defaults";
import { buildMcpNeedsAuthNote, getMcpManager } from "../tools/mcp";
import type { ConfigReloadResult, ConsentConfigManager } from "./config-handlers";
import type { CreateAgentArgs, DiligentAppServerConfig } from "./server";

function withSkillGuardrail(runtimeConfig: RuntimeConfig) {
  const hasSkillSection = runtimeConfig.systemPrompt.some((section) => section.label === "skills");
  if (hasSkillSection || runtimeConfig.skills.length === 0) {
    return runtimeConfig.systemPrompt;
  }

  return [
    ...runtimeConfig.systemPrompt,
    {
      label: "skill_usage_guardrail",
      content: [
        "Skills must be loaded through the skill tool.",
        "Do not use read to open SKILL.md directly.",
        "When the user mentions a skill by name or requests a skill-like workflow, call skill first.",
      ].join("\n"),
    },
  ];
}

function applyModeToPrompt(mode: Mode, systemPrompt: RuntimeConfig["systemPrompt"]) {
  if (mode === "default") {
    return systemPrompt;
  }
  return [...systemPrompt, { tag: "collaboration_mode", label: "mode", content: MODE_SYSTEM_PROMPT_SUFFIXES[mode] }];
}

export function filterToolsByMode(mode: Mode, tools: Awaited<ReturnType<typeof buildDefaultTools>>["tools"]) {
  if (mode === "plan") {
    return tools.filter((tool) => !PLAN_MODE_DISALLOWED_TOOLS.has(tool.name));
  }
  if (mode === "execute") {
    return tools.filter((tool) => !EXECUTE_MODE_DISALLOWED_TOOLS.has(tool.name));
  }
  return tools;
}

/**
 * Append a system-prompt section listing MCP servers that need interactive login, so the agent can
 * tell the user to run `/mcp login <name>` rather than trying (and failing) to use absent tools.
 * Returns the prompt unchanged when no MCP servers are configured or none need auth.
 */
async function appendMcpNeedsAuthNote(
  systemPrompt: RuntimeConfig["systemPrompt"],
  mcpServers: RuntimeConfig["diligent"]["mcpServers"],
): Promise<RuntimeConfig["systemPrompt"]> {
  if (!mcpServers || Object.keys(mcpServers).length === 0) return systemPrompt;
  const statuses = await getMcpManager().listStatus(mcpServers);
  const note = buildMcpNeedsAuthNote(statuses);
  if (!note) return systemPrompt;
  return [...systemPrompt, { tag: "mcp_status", label: "mcp_needs_auth", content: note, cacheControl: "ephemeral" }];
}

async function createRuntimeAgent(args: {
  request: CreateAgentArgs;
  runtimeConfig: RuntimeConfig;
  getPaths: () => Promise<DiligentPaths>;
  bundledToolProviders?: BundledToolProvider[];
}): Promise<RuntimeAgent> {
  const { request, runtimeConfig, getPaths, bundledToolProviders } = args;
  const { cwd, mode, effort, modelId, approve, ask, getSessionId, existingAgent, onChildStop, userId } = request;
  const guardedSystemPrompt = withSkillGuardrail(runtimeConfig);
  const paths = await getPaths();
  const model = resolveModel(modelId);
  const toolsResult = await buildDefaultTools({
    cwd,
    paths,
    collabDeps: {
      modelId: modelId,
      effort,
      agentDefinitions: runtimeConfig.agentDefinitions,
      getParentSessionId: getSessionId,
      approve,
      ask,
      streamFn: runtimeConfig.streamFunction,
      onChildStop,
      userId,
    },
    toolsConfig: runtimeConfig.diligent.tools,
    skills: runtimeConfig.skills,
    enableCollabTools: true,
    existingRegistry: existingAgent?.registry,
    host: { approve, ask },
    bundledToolProviders,
    disabledToolNames: runtimeConfig.disabledToolNames,
    provider: model.provider as ProviderName,
    mcpServers: runtimeConfig.diligent.mcpServers,
    mcpToolLoading: runtimeConfig.diligent.mcp?.toolLoading ?? "auto",
    mcpLazyThreshold: runtimeConfig.diligent.mcp?.lazyThreshold,
    mcpMaxOutputTokens: runtimeConfig.diligent.mcp?.maxOutputTokens,
    mcpWarnOutputTokens: runtimeConfig.diligent.mcp?.warnOutputTokens,
    mcpResources: runtimeConfig.diligent.mcp?.resources,
    mcpPrompts: runtimeConfig.diligent.mcp?.prompts,
  });

  // Surface unauthenticated MCP servers to the agent. `buildDefaultTools` above already ran the MCP
  // sync (with OAuth deps set), so `listStatus` reads the same authoritative needs_auth result from
  // cache without reconnecting — keeping the note consistent with the tools actually exposed.
  const promptSections = await appendMcpNeedsAuthNote(guardedSystemPrompt, runtimeConfig.diligent.mcpServers);

  const activeMode = (mode ?? "default") as Mode;
  const llmCompactionFn = runtimeConfig.providerManager.createNativeCompactionForProvider(
    model.provider as ProviderName,
  );
  const filteredTools = filterToolsByMode(activeMode, toolsResult.tools);
  if (toolsResult.registry) {
    toolsResult.registry.updateDeps({
      modelId,
      effort,
      agentDefinitions: runtimeConfig.agentDefinitions,
      parentTools: filteredTools,
      getParentSessionId: getSessionId,
      approve,
      ask,
      streamFn: runtimeConfig.streamFunction,
      onChildStop,
      userId,
    });
  }
  return new RuntimeAgent(
    model,
    applyModeToPrompt(activeMode, promptSections),
    filteredTools,
    {
      cwd,
      effort,
      llmMsgStreamFn: runtimeConfig.streamFunction,
      llmCompactionFn,
      compaction: {
        reservePercent: runtimeConfig.compaction.reservePercent,
        keepRecentTokens: runtimeConfig.compaction.keepRecentTokens,
        timeoutMs: runtimeConfig.compaction.timeoutMs,
      },
      planReminderIntervalTurns: runtimeConfig.planReminderIntervalTurns,
    },
    toolsResult.registry,
  );
}

export interface CreateAppServerConfigOptions {
  cwd: string;
  runtimeConfig: RuntimeConfig;
  bundledToolProviders?: BundledToolProvider[];
  /**
   * Optional remote-backed consent manager (e.g. the OVERDARE gateway's `/v1/consent`). When
   * provided, it owns consent state instead of local `config.jsonc`; `refresh()` is awaited from
   * `getInitializeResult` so the initialize payload carries the server's latest state.
   */
  consentBackend?: ConsentConfigManager;
  overrides?: Partial<
    Pick<
      DiligentAppServerConfig,
      "serverName" | "serverVersion" | "getInitializeResult" | "openBrowser" | "toImageUrl" | "onCurrentThreadChange"
    >
  >;
}

export function createAppServerConfig(opts: CreateAppServerConfigOptions): DiligentAppServerConfig {
  const { cwd, runtimeConfig, bundledToolProviders = [], consentBackend, overrides } = opts;
  const modelInfoList = getModelInfoList();
  const initialEffort = runtimeConfig.effort;
  const experimentDefinitions = runtimeConfig.experimentDefinitions ?? [];
  const experimentManagedSkillNames = new Set(
    experimentDefinitions.flatMap((definition) => [...(definition.skillNames ?? [])]),
  );
  const experimentManagedAgentNames = new Set(
    experimentDefinitions.flatMap((definition) => [...(definition.agentNames ?? [])]),
  );
  for (const entry of runtimeConfig.agentCatalog ?? []) {
    if (entry.required) experimentManagedAgentNames.delete(entry.definition.name);
  }

  // Wire interactive OAuth for remote MCP servers: token state lives under the global
  // diligent dir, and browser login uses the client-provided opener (falls back to default).
  if (runtimeConfig.diligent.mcpServers) {
    getMcpManager().setOAuthDeps({
      storeDir: join(dirname(getGlobalConfigPath()), "mcp-oauth"),
      openBrowser: overrides?.openBrowser ?? defaultOpenBrowser,
    });
  }

  // Only surface models for providers the user has actually connected, so the picker reflects
  // configured providers (and grows as more are connected) rather than the full hardcoded list.
  const modelsForConfiguredProviders = (): typeof modelInfoList => {
    const configured = runtimeConfig.providerManager.getConfiguredProviders() as string[];
    return modelInfoList.filter((m) => configured.includes(m.provider));
  };

  // Consent is owned by `consentBackend` (remote source of truth) when injected; otherwise it
  // falls back to the local `config.jsonc`-backed manager below.
  const consentConfig: ConsentConfigManager = consentBackend ?? {
    get: () => resolveConsentState(runtimeConfig.diligent.consent),
    set: (params) => {
      const next = applyConsentPatch(runtimeConfig.diligent.consent, params, new Date().toISOString());
      runtimeConfig.diligent = { ...runtimeConfig.diligent, consent: next };
      saveGlobalConsent(next).catch((err) => {
        console.warn("[config] Failed to persist consent selection:", err);
      });
      return resolveConsentState(next);
    },
  };

  // Lazily resolve paths from the startup cwd — idempotent, cached after first call
  let pathsPromise: ReturnType<typeof ensureDiligentDir> | undefined;
  const getPaths = () => {
    pathsPromise ??= ensureDiligentDir(cwd);
    return pathsPromise;
  };

  const config: DiligentAppServerConfig = {
    cwd,
    defaultEffort: initialEffort,
    getInitializeResult: async () => {
      await refreshPrivacyPolicyUrl(); // resolve the versioned privacy-policy URL (3s-bounded, cached)
      await consentConfig.refresh?.(); // re-sync remote-backed consent (no-op for the local manager)
      return {
        cwd,
        mode: runtimeConfig.mode,
        effort: initialEffort,
        currentModel: runtimeConfig.model?.id,
        availableModels: modelsForConfiguredProviders(),
        consent: consentConfig.get(),
      };
    },
    resolvePaths: (requestCwd) => ensureDiligentDir(requestCwd),
    createAgent: (args: CreateAgentArgs): Promise<RuntimeAgent> =>
      createRuntimeAgent({ request: args, runtimeConfig, getPaths, bundledToolProviders }),
    streamFunction: runtimeConfig.streamFunction,
    createNativeCompaction: (provider: ProviderName) =>
      runtimeConfig.providerManager.createNativeCompactionForProvider(provider),
    compaction: runtimeConfig.compaction,
    toolConfig: {
      getTools: () => runtimeConfig.diligent.tools,
      setTools: (tools) => {
        runtimeConfig.diligent = {
          ...runtimeConfig.diligent,
          ...(tools ? { tools } : {}),
        };
        if (!tools) {
          delete runtimeConfig.diligent.tools;
        }
      },
    },
    skillConfig: {
      resolve: async (requestCwd) => {
        if (requestCwd === cwd) {
          return {
            cwd,
            config: runtimeConfig.diligent.skills,
            layers: runtimeConfig.configLayers ?? {},
            discoveredSkills: (runtimeConfig.discoveredSkills ?? []).filter(
              (skill) => !experimentManagedSkillNames.has(skill.name),
            ),
          };
        }

        const loaded = await loadDiligentConfig(requestCwd);
        const discovered = await discoverSkills({ cwd: requestCwd, additionalPaths: loaded.config.skills?.paths });
        return {
          cwd: requestCwd,
          config: loaded.config.skills,
          layers: loaded.layers,
          discoveredSkills: discovered.skills.filter((skill) => !experimentManagedSkillNames.has(skill.name)),
        };
      },
    },
    experimentConfig: {
      getDefinitions: () => experimentDefinitions,
      getExperiments: () => runtimeConfig.experiments ?? [],
    },
    subagentConfig: {
      resolve: async (requestCwd) => {
        if (requestCwd !== cwd) {
          throw new Error(`Subagent settings are only available for the app-server startup cwd: ${cwd}`);
        }
        return {
          cwd,
          config: runtimeConfig.diligent.agents,
          layers: runtimeConfig.configLayers ?? {},
          catalog: runtimeConfig.agentCatalog,
          experimentManagedAgentNames,
        };
      },
    },
    modelConfig: {
      currentModelId: runtimeConfig.model?.id,
      getAvailableModels: () => modelsForConfiguredProviders(),
      onModelChange: (modelId, threadId) => {
        if (!threadId) {
          runtimeConfig.model = resolveModel(modelId);
          saveGlobalModel(modelId).catch((err) => {
            console.warn("[config] Failed to persist model selection:", err);
          });
        }
      },
    },
    consentConfig,
    providerManager: runtimeConfig.providerManager,
    authStore: runtimeConfig.authStore,
    permissionEngine: runtimeConfig.permissionEngine,
    skillNames: runtimeConfig.skills.map((skill) => skill.name),
    hooks: runtimeConfig.diligent.hooks,
    bundledToolProviders,
    mcpServers: runtimeConfig.diligent.mcpServers,
    userId: runtimeConfig.diligent.userId,
    ...overrides,
  };

  // Assigned after `config` exists so it can refresh the frozen snapshots (`mcpServers`,
  // `skillNames`, `hooks`) alongside the mutable `runtimeConfig` fields that `createAgent`
  // reads live on every call.
  config.reloadConfig = async (): Promise<ConfigReloadResult> => {
    const paths = await getPaths();
    const fresh = await loadRuntimeConfig(cwd, paths, {
      bundledToolProviders,
      experimentDefinitions,
    });
    runtimeConfig.discoveredSkills = fresh.discoveredSkills;
    runtimeConfig.skills = fresh.skills;
    runtimeConfig.agents = fresh.agents;
    runtimeConfig.discoveredAgents = fresh.discoveredAgents;
    runtimeConfig.agentCatalog = fresh.agentCatalog;
    runtimeConfig.agentDefinitions = fresh.agentDefinitions;
    runtimeConfig.systemPrompt = fresh.systemPrompt;
    runtimeConfig.diligent = fresh.diligent;
    runtimeConfig.sources = fresh.sources;
    runtimeConfig.configLayers = fresh.configLayers;
    runtimeConfig.experiments = fresh.experiments;
    runtimeConfig.disabledToolNames = fresh.disabledToolNames;
    runtimeConfig.disabledSkillNames = fresh.disabledSkillNames;
    runtimeConfig.disabledAgentNames = fresh.disabledAgentNames;
    config.mcpServers = fresh.diligent.mcpServers;
    config.skillNames = fresh.skills.map((skill) => skill.name);
    config.hooks = fresh.diligent.hooks;
    return { skills: fresh.skills.map((skill) => ({ name: skill.name, description: skill.description })) };
  };

  return config;
}
