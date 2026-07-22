// @summary Resolves default or filtered provider profiles and credentials

import {
  getDefaultModelRef,
  resolveModel,
  resolveModelSelector,
  supportsThinkingEffort,
} from "@diligent/core/model-registry";
import type { Model, ProviderManager, StreamFunction } from "@diligent/core/provider-contract";
import { createAnthropicStream } from "@diligent/core/providers/anthropic";
import { createGeminiStream } from "@diligent/core/providers/gemini";
import { createOpenAIStream } from "@diligent/core/providers/openai";
import type { EvalCliOptions } from "./cli-options";
import type { ChatGPTEvalAuth } from "./providers/chatgpt-oauth";
import type { EvalProfile, EvalProvider } from "./task";

const EVAL_EFFORT = "medium" as const;

export const DEFAULT_PROFILES: readonly EvalProfile[] = [
  { provider: "openai", model: "gpt-5.6-terra", effort: EVAL_EFFORT },
  { provider: "anthropic", model: "claude-sonnet-5", effort: EVAL_EFFORT },
];

export function resolveSelectedProfiles(options: EvalCliOptions): EvalProfile[] {
  if (options.model) {
    const model = options.provider
      ? resolveModel({ provider: options.provider, modelId: options.model })
      : resolveModelSelector(options.model);
    if (!isEvalProvider(model.provider)) {
      throw new Error(
        `Eval suites support only OpenAI, Anthropic, Gemini, and ChatGPT models, received ${model.provider}.`,
      );
    }
    if (options.provider && options.provider !== model.provider) {
      throw new Error(`Model ${options.model} belongs to ${model.provider}, not ${options.provider}.`);
    }
    validateMediumEffort(model);
    return [{ provider: model.provider, model: model.modelId, effort: EVAL_EFFORT }];
  }

  const selected = options.provider ? [resolveDefaultProfile(options.provider)] : DEFAULT_PROFILES;
  return selected.map((profile) => {
    const model = resolveModel({ provider: profile.provider, modelId: profile.model });
    validateMediumEffort(model);
    return { ...profile };
  });
}

export function validateCredentials(profiles: readonly EvalProfile[], env: EvalCredentialEnv = process.env): void {
  const required = new Set(profiles.map((profile) => profile.provider));
  if (required.has("openai") && !env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required for the selected eval profiles.");
  }
  if (required.has("anthropic") && !env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error("ANTHROPIC_API_KEY is required for the selected eval profiles.");
  }
  if (required.has("gemini") && !env.GEMINI_API_KEY?.trim()) {
    throw new Error("GEMINI_API_KEY is required for the selected eval profiles.");
  }
}

export function createProfileStream(
  profile: EvalProfile,
  env: EvalCredentialEnv = process.env,
  chatgptAuth?: ChatGPTEvalAuth,
): StreamFunction {
  if (profile.provider === "openai") return createOpenAIStream(env.OPENAI_API_KEY);
  if (profile.provider === "anthropic") return createAnthropicStream(env.ANTHROPIC_API_KEY);
  if (profile.provider === "gemini") return createGeminiStream(env.GEMINI_API_KEY);
  if (!chatgptAuth) throw new Error("ChatGPT eval profiles require initialized local OAuth.");
  return chatgptAuth.streamFunction;
}

export function configureProfileProviderManager(
  profile: EvalProfile,
  manager: ProviderManager,
  chatgptAuth?: ChatGPTEvalAuth,
): void {
  if (profile.provider !== "chatgpt") return;
  if (!chatgptAuth) throw new Error("ChatGPT eval profiles require initialized local OAuth.");
  chatgptAuth.bindProviderManager(manager);
}

export function resolveProfileModel(profile: EvalProfile): Model {
  const model = resolveModel({ provider: profile.provider, modelId: profile.model });
  if (model.provider !== profile.provider) {
    throw new Error(`Profile provider ${profile.provider} does not match model provider ${model.provider}.`);
  }
  validateMediumEffort(model);
  return model;
}

export function isEvalProvider(value: string): value is EvalProvider {
  return value === "openai" || value === "anthropic" || value === "gemini" || value === "chatgpt";
}

function resolveDefaultProfile(provider: EvalProvider): EvalProfile {
  const configured = DEFAULT_PROFILES.find((profile) => profile.provider === provider);
  if (configured) return { ...configured };
  return { provider, model: getDefaultModelRef(provider).modelId, effort: EVAL_EFFORT };
}

function validateMediumEffort(model: Model): void {
  if (!supportsThinkingEffort(model, EVAL_EFFORT)) {
    throw new Error(`Model ${model.provider}/${model.modelId} does not support effort ${EVAL_EFFORT}.`);
  }
}

interface EvalCredentialEnv {
  [key: string]: string | undefined;
}
