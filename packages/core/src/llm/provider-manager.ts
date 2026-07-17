// @summary Unified provider manager — provider stream dispatch with injected auth bindings

import { DEFAULT_ANTHROPIC_MODEL_ID } from "./models";
import { createAnthropicNativeCompaction, createAnthropicStream } from "./provider/anthropic";
import { createGeminiStream } from "./provider/gemini";
import type { NativeCompactionLookup } from "./provider/native-compaction";
import { createOpenAINativeCompaction, createOpenAIStream } from "./provider/openai";
import type { OpenAIImageDetail } from "./provider/openai-responses";
import { validateProviderApiKey } from "./provider/validate-key";
import { createVertexStream } from "./provider/vertex";
import { createZaiCodingPlanStream } from "./provider/zai-coding-plan";
import { ProviderError, ProviderErrorReason, ProviderErrorType, type ProviderName, type StreamFunction } from "./types";

export interface ExternalProviderAuth {
  isConfigured: () => boolean;
  getMaskedKey?: () => string | undefined;
  getStream: () => StreamFunction;
  getNativeCompaction?: () => import("./provider/native-compaction").NativeCompactFn | undefined;
  ensureFresh?: () => Promise<void>;
}

export interface ProviderManagerConfig {
  provider?: {
    anthropic?: { baseUrl?: string };
    openai?: { baseUrl?: string; imageDetail?: OpenAIImageDetail };
    chatgpt?: { baseUrl?: string };
    gemini?: { baseUrl?: string };
    vertex?: { baseUrl?: string };
    "zai-coding-plan"?: { baseUrl?: string };
  };
  auth?: Partial<Record<ProviderName, ExternalProviderAuth>>;
}

export type { ProviderName };

export const DEFAULT_PROVIDER: ProviderName = "anthropic";

export const PROVIDER_NAMES: ProviderName[] = ["anthropic", "openai", "chatgpt", "gemini", "vertex", "zai-coding-plan"];

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: DEFAULT_ANTHROPIC_MODEL_ID,
  openai: "gpt-5.5",
  chatgpt: "chatgpt-5.5",
  gemini: "gemini-3.5-flash",
  vertex: "vertex-gemma-4-26b-it",
  "zai-coding-plan": "glm-5.2",
};

// imageDetail is OpenAI-only; other factories have fewer params and remain assignable (a function
// taking fewer args satisfies a type expecting more), so they simply ignore the extra argument.
const PROVIDER_FACTORIES: Record<
  ProviderName,
  (key: string, baseUrl?: string, imageDetail?: OpenAIImageDetail) => StreamFunction
> = {
  anthropic: createAnthropicStream,
  openai: createOpenAIStream,
  chatgpt: () => {
    throw new Error("ChatGPT stream requires external auth binding");
  },
  gemini: createGeminiStream,
  vertex: (token: string, baseUrl?: string) => createVertexStream(() => token, { baseUrl }),
  "zai-coding-plan": createZaiCodingPlanStream,
};

class StreamFactoryCache {
  private cache = new Map<string, StreamFunction>();

  getOrCreate(
    provider: ProviderName,
    apiKey: string,
    baseUrl?: string,
    imageDetail?: OpenAIImageDetail,
  ): StreamFunction {
    const cacheKey = `${provider}:${apiKey}:${imageDetail ?? ""}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const factory = PROVIDER_FACTORIES[provider];
    if (!factory) throw new Error(`Unknown provider: ${provider}`);
    const stream = factory(apiKey, baseUrl, imageDetail);
    this.cache.set(cacheKey, stream);
    return stream;
  }

  invalidateProvider(provider: ProviderName): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${provider}:`)) this.cache.delete(key);
    }
  }
}

class AuthStateManager {
  private keys: Partial<Record<ProviderName, string>> = {};
  private externalAuth: Partial<Record<ProviderName, ExternalProviderAuth>> = {};

  constructor(initialAuth?: Partial<Record<ProviderName, ExternalProviderAuth>>) {
    this.externalAuth = { ...(initialAuth ?? {}) };
  }

  setExternalAuth(provider: ProviderName, auth: ExternalProviderAuth): void {
    this.externalAuth[provider] = auth;
  }

  removeExternalAuth(provider: ProviderName): void {
    delete this.externalAuth[provider];
  }

  getExternalAuth(provider: ProviderName): ExternalProviderAuth | undefined {
    const binding = this.externalAuth[provider];
    if (!binding) return undefined;
    return binding.isConfigured() ? binding : undefined;
  }

  setApiKey(provider: ProviderName, apiKey: string): void {
    this.keys[provider] = apiKey;
  }

  removeApiKey(provider: ProviderName): void {
    delete this.keys[provider];
  }

  hasKeyFor(provider: ProviderName): boolean {
    const external = this.getExternalAuth(provider);
    if (external) return true;
    const key = this.keys[provider];
    return key !== undefined && key !== "";
  }

  getApiKey(provider: ProviderName): string | undefined {
    return this.keys[provider];
  }

  getConfiguredProviders(): ProviderName[] {
    return PROVIDER_NAMES.filter((p) => this.hasKeyFor(p));
  }

  getMaskedKey(provider: ProviderName): string | undefined {
    const external = this.getExternalAuth(provider);
    if (external) return external.getMaskedKey?.() ?? `${provider} external auth`;
    const key = this.keys[provider];
    if (!key) return undefined;
    return key.length > 7 ? `${key.slice(0, 7)}...` : key;
  }
}

function createCompactionRegistry(
  authState: AuthStateManager,
  baseUrls: Partial<Record<ProviderName, string>>,
  openaiImageDetail?: OpenAIImageDetail,
): NativeCompactionLookup {
  return (provider) => {
    const external = authState.getExternalAuth(provider as ProviderName);
    if (external) {
      return external.getNativeCompaction?.();
    }

    const key = authState.getApiKey(provider as ProviderName);
    if (!key) return undefined;
    if (provider === "anthropic") return createAnthropicNativeCompaction(key, baseUrls.anthropic);
    if (provider === "openai") return createOpenAINativeCompaction(key, baseUrls.openai, openaiImageDetail);
    return undefined;
  };
}

export function createStreamForProvider(provider: string, apiKey: string): StreamFunction {
  const factory = PROVIDER_FACTORIES[provider as ProviderName];
  if (!factory) throw new Error(`Unknown provider: ${provider}`);
  return factory(apiKey);
}

export class ProviderManager {
  private baseUrls: Partial<Record<ProviderName, string>> = {};
  private openaiImageDetail: OpenAIImageDetail | undefined;
  private streamCache = new StreamFactoryCache();
  private authState: AuthStateManager;

  constructor(config: ProviderManagerConfig) {
    this.baseUrls.anthropic = config.provider?.anthropic?.baseUrl;
    this.baseUrls.openai = config.provider?.openai?.baseUrl;
    this.openaiImageDetail = config.provider?.openai?.imageDetail;
    this.baseUrls.chatgpt = config.provider?.chatgpt?.baseUrl;
    this.baseUrls.gemini = config.provider?.gemini?.baseUrl;
    this.baseUrls.vertex = config.provider?.vertex?.baseUrl;
    this.baseUrls["zai-coding-plan"] = config.provider?.["zai-coding-plan"]?.baseUrl;
    this.authState = new AuthStateManager(config.auth);
  }

  setExternalAuth(provider: ProviderName, auth: ExternalProviderAuth): void {
    this.streamCache.invalidateProvider(provider);
    this.authState.setExternalAuth(provider, auth);
  }

  removeExternalAuth(provider: ProviderName): void {
    this.streamCache.invalidateProvider(provider);
    this.authState.removeExternalAuth(provider);
  }

  hasOAuthFor(provider: "chatgpt"): boolean {
    return this.authState.getExternalAuth(provider) !== undefined;
  }

  // Verify an API key before persisting it. Throws with a user-facing message if the key is invalid.
  async validateApiKey(provider: ProviderName, apiKey: string): Promise<void> {
    await validateProviderApiKey(provider, apiKey, this.baseUrls[provider], DEFAULT_MODELS[provider]);
  }

  createProxyStream(): StreamFunction {
    return (model, context, options) => {
      const provider = (model.provider ?? DEFAULT_PROVIDER) as ProviderName;

      const external = this.authState.getExternalAuth(provider);
      if (external) {
        external.ensureFresh?.().catch(() => {});
        return external.getStream()(model, context, options);
      }

      const apiKey = this.authState.getApiKey(provider);
      if (!apiKey) {
        throw new ProviderError(`No authentication is configured for ${provider}.`, {
          errorType: ProviderErrorType.Auth,
          isRetryable: false,
          reason: ProviderErrorReason.CredentialsMissing,
        });
      }

      const imageDetail = provider === "openai" ? this.openaiImageDetail : undefined;
      const stream = this.streamCache.getOrCreate(provider, apiKey, this.baseUrls[provider], imageDetail);
      return stream(model, context, options);
    };
  }

  createNativeCompactionRegistry(): NativeCompactionLookup {
    return createCompactionRegistry(this.authState, this.baseUrls, this.openaiImageDetail);
  }

  createNativeCompactionForProvider(
    provider: ProviderName,
  ): import("./provider/native-compaction").NativeCompactFn | undefined {
    return this.createNativeCompactionRegistry()(provider);
  }

  hasKeyFor(provider: ProviderName): boolean {
    return this.authState.hasKeyFor(provider);
  }

  getApiKey(provider: ProviderName): string | undefined {
    return this.authState.getApiKey(provider);
  }

  setApiKey(provider: ProviderName, apiKey: string): void {
    this.streamCache.invalidateProvider(provider);
    this.authState.setApiKey(provider, apiKey);
  }

  removeApiKey(provider: ProviderName): void {
    this.streamCache.invalidateProvider(provider);
    this.authState.removeApiKey(provider);
  }

  getConfiguredProviders(): ProviderName[] {
    return this.authState.getConfiguredProviders();
  }

  getMaskedKey(provider: ProviderName): string | undefined {
    return this.authState.getMaskedKey(provider);
  }
}
