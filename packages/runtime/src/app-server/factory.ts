// @summary Factory that builds a DiligentAppServerConfig from a RuntimeConfig, eliminating Web/CLI duplication
import { dirname, join } from "node:path";
import { getModelInfoList, resolveModel } from "@diligent/core/llm/models";
import type { ProviderName } from "@diligent/core/llm/types";
import { MODE_SYSTEM_PROMPT_SUFFIXES, type Mode, PLAN_MODE_ALLOWED_TOOLS } from "../agent/mode";
import { RuntimeAgent } from "../agent/runtime-agent";
import { openBrowser as defaultOpenBrowser } from "../auth";
import { applyConsentPatch, refreshPrivacyPolicyUrl, resolveConsentState } from "../config/consent";
import type { RuntimeConfig } from "../config/runtime";
import { getGlobalConfigPath, saveGlobalConsent, saveGlobalModel } from "../config/writer";
import { type DiligentPaths, ensureDiligentDir } from "../infrastructure";
import type { BundledToolProvider } from "../tools/bundled-provider";
import { buildDefaultTools } from "../tools/defaults";
import { getMcpManager } from "../tools/mcp";
import type { ConsentConfigManager } from "./config-handlers";
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

function filterToolsByMode(mode: Mode, tools: Awaited<ReturnType<typeof buildDefaultTools>>["tools"]) {
  return mode === "plan" ? tools.filter((tool) => PLAN_MODE_ALLOWED_TOOLS.has(tool.name)) : tools;
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
    provider: model.provider as ProviderName,
    mcpServers: runtimeConfig.diligent.mcpServers,
  });

  const activeMode = (mode ?? "default") as Mode;
  const llmCompactionFn = runtimeConfig.providerManager.createNativeCompactionForProvider(
    model.provider as ProviderName,
  );
  return new RuntimeAgent(
    model,
    applyModeToPrompt(activeMode, guardedSystemPrompt),
    filterToolsByMode(activeMode, toolsResult.tools),
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

  // Wire interactive OAuth for remote MCP servers: token state lives under the global
  // diligent dir, and browser login uses the client-provided opener (falls back to default).
  if (runtimeConfig.diligent.mcpServers) {
    getMcpManager().setOAuthDeps({
      storeDir: join(dirname(getGlobalConfigPath()), "mcp-oauth"),
      openBrowser: overrides?.openBrowser ?? defaultOpenBrowser,
    });
  }

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
        availableModels: modelInfoList,
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
    modelConfig: {
      currentModelId: runtimeConfig.model?.id,
      getAvailableModels: () => {
        const configured = runtimeConfig.providerManager.getConfiguredProviders() as string[];
        return modelInfoList.filter((m) => configured.includes(m.provider));
      },
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

  return config;
}
