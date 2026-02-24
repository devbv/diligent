import type { Model } from "@diligent/core";

export interface AppConfig {
  apiKey: string;
  model: Model;
  systemPrompt: string;
}

const DEFAULT_MODEL: Model = {
  id: "claude-sonnet-4-20250514",
  provider: "anthropic",
  contextWindow: 200_000,
  maxOutputTokens: 16_384,
};

export function loadConfig(): AppConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required.\n" +
      "Get your API key at https://console.anthropic.com/settings/keys"
    );
  }

  const modelId = process.env.DILIGENT_MODEL;
  const model: Model = modelId
    ? { ...DEFAULT_MODEL, id: modelId }
    : DEFAULT_MODEL;

  const systemPrompt = buildSystemPrompt();

  return { apiKey, model, systemPrompt };
}

function buildSystemPrompt(): string {
  return [
    "You are a coding assistant. You help developers by running commands and explaining results.",
    "Use the bash tool to execute shell commands when needed.",
    `Current working directory: ${process.cwd()}`,
    `Platform: ${process.platform}`,
    `Date: ${new Date().toISOString().split("T")[0]}`,
  ].join("\n");
}
