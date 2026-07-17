// @summary Runtime-owned provider onboarding metadata shared with protocol clients

import type { ProviderDescriptor, ProviderName } from "@diligent/protocol";

export const PROVIDER_DESCRIPTORS: Record<ProviderName, ProviderDescriptor> = {
  anthropic: {
    provider: "anthropic",
    displayName: "Anthropic",
    authMethod: "api_key",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    apiKeyPlaceholder: "sk-ant-...",
  },
  openai: {
    provider: "openai",
    displayName: "OpenAI",
    authMethod: "api_key",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    apiKeyPlaceholder: "sk-...",
  },
  chatgpt: {
    provider: "chatgpt",
    displayName: "ChatGPT",
    authMethod: "oauth",
    apiKeyUrl: "https://chatgpt.com",
    apiKeyPlaceholder: "OAuth login required",
  },
  gemini: {
    provider: "gemini",
    displayName: "Gemini",
    authMethod: "api_key",
    apiKeyUrl: "https://aistudio.google.com/apikey",
    apiKeyPlaceholder: "AIza...",
  },
  vertex: {
    provider: "vertex",
    displayName: "Vertex AI",
    authMethod: "access_token",
    apiKeyUrl: "https://cloud.google.com/vertex-ai/generative-ai/docs/migrate/openai/overview",
    apiKeyPlaceholder: "Google Cloud access token",
  },
  "zai-coding-plan": {
    provider: "zai-coding-plan",
    displayName: "z.ai Coding Plan",
    authMethod: "api_key",
    apiKeyUrl: "https://platform.z.ai/console/api-keys",
    apiKeyPlaceholder: "API key",
  },
};
