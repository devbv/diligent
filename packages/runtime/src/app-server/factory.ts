// @summary Factory that builds a DiligentAppServerConfig from a RuntimeConfig, eliminating Web/CLI duplication
import { getModelInfoList, resolveModel } from "@diligent/core/llm/models";
import type { ProviderName } from "@diligent/core/llm/types";
import { MODE_SYSTEM_PROMPT_SUFFIXES, type Mode, PLAN_MODE_ALLOWED_TOOLS } from "../agent/mode";
import { RuntimeAgent } from "../agent/runtime-agent";
import type { RuntimeConfig } from "../config/runtime";
import { saveGlobalModel } from "../config/writer";
import { type DiligentPaths, ensureDiligentDir } from "../infrastructure";
import { buildDefaultTools } from "../tools/defaults";
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
}): Promise<RuntimeAgent> {
  const { request, runtimeConfig, getPaths } = args;
  const { cwd, mode, effort, modelId, approve, ask, getSessionId, existingAgent, onChildStop, userId } = request;
  const guardedSystemPrompt = withSkillGuardrail(runtimeConfig);
  const paths = await getPaths();
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
  });

  const activeMode = (mode ?? "default") as Mode;
  const model = resolveModel(modelId);
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
  overrides?: Partial<
    Pick<
      DiligentAppServerConfig,
      "serverName" | "serverVersion" | "getInitializeResult" | "openBrowser" | "toImageUrl" | "onCurrentThreadChange"
    >
  >;
}

export function createAppServerConfig(opts: CreateAppServerConfigOptions): DiligentAppServerConfig {
  const { cwd, runtimeConfig, overrides } = opts;
  const modelInfoList = getModelInfoList();
  const initialEffort = runtimeConfig.effort;

  // Lazily resolve paths from the startup cwd — idempotent, cached after first call
  let pathsPromise: ReturnType<typeof ensureDiligentDir> | undefined;
  const getPaths = () => {
    pathsPromise ??= ensureDiligentDir(cwd);
    return pathsPromise;
  };

  const config: DiligentAppServerConfig = {
    cwd,
    defaultEffort: initialEffort,
    getInitializeResult: async () => ({
      cwd,
      mode: runtimeConfig.mode,
      effort: initialEffort,
      currentModel: runtimeConfig.model?.id,
      availableModels: modelInfoList,
    }),
    resolvePaths: (requestCwd) => ensureDiligentDir(requestCwd),
    createAgent: (args: CreateAgentArgs): Promise<RuntimeAgent> =>
      createRuntimeAgent({ request: args, runtimeConfig, getPaths }),
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
    providerManager: runtimeConfig.providerManager,
    authStore: runtimeConfig.authStore,
    permissionEngine: runtimeConfig.permissionEngine,
    skillNames: runtimeConfig.skills.map((skill) => skill.name),
    hooks: runtimeConfig.diligent.hooks,
    userId: runtimeConfig.diligent.userId,
    ...overrides,
  };

  return config;
}
