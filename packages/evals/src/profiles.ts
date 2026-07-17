// @summary Resolves canonical and investigation provider profiles and credentials

import { resolveModel, supportsThinkingEffort } from "@diligent/core/model-registry";
import type { Model, StreamFunction, ThinkingEffort } from "@diligent/core/provider-contract";
import { createAnthropicStream } from "@diligent/core/providers/anthropic";
import { createOpenAIStream } from "@diligent/core/providers/openai";
import type { EvalCliOptions } from "./cli-options";
import type { EvalProfile, EvalProvider } from "./task";

export const CANONICAL_PROFILES: readonly EvalProfile[] = [
  { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
  { provider: "anthropic", model: "claude-sonnet-4-6", effort: "medium" },
];

export function resolveSelectedProfiles(options: EvalCliOptions): EvalProfile[] {
  if (options.canonical) return CANONICAL_PROFILES.map((profile) => ({ ...profile }));

  if (options.model) {
    const model = resolveModel(options.model);
    if (model.provider !== "openai" && model.provider !== "anthropic") {
      throw new Error(`Eval core supports only OpenAI and Anthropic API models, received ${model.provider}.`);
    }
    if (options.provider && options.provider !== model.provider) {
      throw new Error(`Model ${options.model} belongs to ${model.provider}, not ${options.provider}.`);
    }
    const effort = options.effort ?? "medium";
    validateEffort(model, effort);
    return [{ provider: model.provider, model: model.id, effort }];
  }

  const canonical = options.provider
    ? CANONICAL_PROFILES.filter((profile) => profile.provider === options.provider)
    : CANONICAL_PROFILES;
  return canonical.map((profile) => {
    const model = resolveModel(profile.model);
    const effort = options.effort ?? profile.effort;
    validateEffort(model, effort);
    return { ...profile, effort };
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
}

export function createProfileStream(profile: EvalProfile, env: EvalCredentialEnv = process.env): StreamFunction {
  if (profile.provider === "openai") return createOpenAIStream(env.OPENAI_API_KEY);
  return createAnthropicStream(env.ANTHROPIC_API_KEY);
}

export function resolveProfileModel(profile: EvalProfile): Model {
  const model = resolveModel(profile.model);
  if (model.provider !== profile.provider) {
    throw new Error(`Profile provider ${profile.provider} does not match model provider ${model.provider}.`);
  }
  validateEffort(model, profile.effort);
  return model;
}

export function canonicalReason(options: EvalCliOptions): string {
  if (options.canonical) return "exact canonical profiles and complete core task set";
  const overrides = [
    options.provider && `provider=${options.provider}`,
    options.task && `task=${options.task}`,
    options.model && `model=${options.model}`,
    options.effort && `effort=${options.effort}`,
  ].filter((value): value is string => Boolean(value));
  return overrides.length > 0
    ? `non-canonical investigation override: ${overrides.join(", ")}`
    : "complete default selection without --canonical";
}

export function isEvalProvider(value: string): value is EvalProvider {
  return value === "openai" || value === "anthropic";
}

function validateEffort(model: Model, effort: ThinkingEffort): void {
  if (!supportsThinkingEffort(model, effort)) {
    throw new Error(`Model ${model.id} does not support effort ${effort}.`);
  }
}

interface EvalCredentialEnv {
  [key: string]: string | undefined;
}
