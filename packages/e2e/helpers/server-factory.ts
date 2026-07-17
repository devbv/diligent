// @summary Test server factory creating DiligentAppServer with fake stream and optional tools

import type { RuntimeConfig, StreamFunction, Tool } from "@diligent/runtime";
import {
  createAppServerConfig,
  createYoloPermissionEngine,
  DiligentAppServer,
  ensureDiligentDir,
  getBuiltinAgentDefinitions,
  ProviderManager,
  RuntimeAgent,
  resolveAvailableAgentDefinitions,
} from "@diligent/runtime";
import { createSimpleStream } from "./fake-stream";

export function createTestServer(opts: {
  cwd: string;
  streamFunction?: StreamFunction;
  tools?: Tool[];
  runtimeToolsConfig?: RuntimeConfig["diligent"]["tools"];
  runtimeConfigOverrides?: Partial<RuntimeConfig>;
}): DiligentAppServer {
  const streamFn = opts.streamFunction ?? createSimpleStream("ok");

  if (!opts.runtimeToolsConfig) {
    return new DiligentAppServer({
      cwd: opts.cwd,
      resolvePaths: async (cwd) => ensureDiligentDir(cwd),
      createAgent: () =>
        new RuntimeAgent(
          {
            modelId: "claude-sonnet-4-6",
            provider: "anthropic",
            contextWindow: 8192,
            maxOutputTokens: 4096,
            supportsThinking: false,
          },
          [],
          opts.tools ?? [],
          { effort: "medium", llmMsgStreamFn: streamFn },
        ),
    });
  }

  const providerManager = new ProviderManager({});
  const agentDefinitions = resolveAvailableAgentDefinitions(
    getBuiltinAgentDefinitions(),
    opts.runtimeConfigOverrides?.agents ?? [],
  );
  const runtimeConfig: RuntimeConfig = {
    model: {
      modelId: "claude-sonnet-4-6",
      provider: "anthropic",
      contextWindow: 8192,
      maxOutputTokens: 4096,
      supportsThinking: false,
    },
    effort: "medium",
    mode: "default",
    planReminderIntervalTurns: 0,
    systemPrompt: [],
    streamFunction: streamFn,
    diligent: { tools: opts.runtimeToolsConfig },
    sources: [],
    skills: [],
    agents: opts.runtimeConfigOverrides?.agents ?? [],
    agentDefinitions,
    compaction: {
      enabled: true,
      reservePercent: 16,
      keepRecentTokens: 20_000,
      timeoutMs: 180_000,
    },
    permissionEngine: createYoloPermissionEngine(),
    providerManager,
    authStore: { mode: "auto" },
    ...opts.runtimeConfigOverrides,
  };

  const base = createAppServerConfig({ cwd: opts.cwd, runtimeConfig });

  return new DiligentAppServer({
    ...base,
    resolvePaths: async (cwd) => ensureDiligentDir(cwd),
  });
}
