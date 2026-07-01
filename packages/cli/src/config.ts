// @summary Loads and validates the CLI configuration from disk
import type { Mode } from "@diligent/protocol";
import type {
  DiligentConfig,
  DiligentPaths,
  Model,
  SkillMetadata,
  StreamFunction,
  SystemSection,
} from "@diligent/runtime";
import { DEFAULT_ANTHROPIC_MODEL_ID, ensureDiligentDir, loadRuntimeConfig, resolveModel } from "@diligent/runtime";
import { DEFAULT_PROVIDER, type ProviderManager, type ProviderName } from "./provider-manager";

export interface AppConfig {
  apiKey: string;
  model: Model;
  systemPrompt: SystemSection[];
  streamFunction: StreamFunction;
  diligent: DiligentConfig;
  sources: string[];
  skills: SkillMetadata[];
  mode: Mode; // D087: always set, defaults to "default"
  compaction: {
    enabled: boolean;
    reservePercent: number;
    keepRecentTokens: number;
    timeoutMs: number;
  };
  providerManager: ProviderManager;
}

export async function loadConfig(cwd: string = process.cwd(), paths?: DiligentPaths): Promise<AppConfig> {
  const resolvedPaths = paths ?? (await ensureDiligentDir(cwd));
  const runtime = await loadRuntimeConfig(cwd, resolvedPaths);
  // CLI default: Anthropic Sonnet when no provider is configured
  const model = runtime.model ?? resolveModel(DEFAULT_ANTHROPIC_MODEL_ID);
  const provider = (model.provider ?? DEFAULT_PROVIDER) as ProviderName;
  const apiKey = runtime.providerManager.getApiKey(provider) ?? "";

  return {
    apiKey,
    model,
    systemPrompt: runtime.systemPrompt,
    streamFunction: runtime.streamFunction,
    diligent: runtime.diligent,
    sources: runtime.sources,
    skills: runtime.skills,
    mode: runtime.mode,
    compaction: {
      enabled: runtime.compaction.enabled,
      reservePercent: runtime.compaction.reservePercent,
      keepRecentTokens: runtime.compaction.keepRecentTokens,
      timeoutMs: runtime.compaction.timeoutMs,
    },
    providerManager: runtime.providerManager,
  };
}
