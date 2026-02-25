import type { AgentEvent, AgentLoopConfig, DiligentConfig, EventStream, Message, Model } from "@diligent/core";
import { buildSystemPrompt, discoverInstructions, loadDiligentConfig } from "@diligent/core";

export type AgentLoopFn = (messages: Message[], config: AgentLoopConfig) => EventStream<AgentEvent, Message[]>;

export interface AppConfig {
  apiKey: string;
  model: Model;
  systemPrompt: string;
  diligent: DiligentConfig;
  sources: string[];
  agentLoopFn?: AgentLoopFn;
}

const DEFAULT_MODEL: Model = {
  id: "claude-sonnet-4-20250514",
  provider: "anthropic",
  contextWindow: 200_000,
  maxOutputTokens: 16_384,
};

const BASE_SYSTEM_PROMPT = [
  "You are a coding assistant. You help developers by running commands and explaining results.",
  "Use the bash tool to execute shell commands when needed.",
].join("\n");

export async function loadConfig(cwd: string = process.cwd()): Promise<AppConfig> {
  const { config, sources } = await loadDiligentConfig(cwd);
  const instructions = await discoverInstructions(cwd);

  // Resolve API key
  const apiKey = config.provider?.anthropic?.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required.\n" +
        "Get your API key at https://console.anthropic.com/settings/keys",
    );
  }

  // Resolve model
  const model: Model = config.model ? { ...DEFAULT_MODEL, id: config.model } : DEFAULT_MODEL;

  // Build system prompt with CLAUDE.md + config instructions
  const basePrompt = config.systemPrompt ?? BASE_SYSTEM_PROMPT;
  const contextLines = [
    `Current working directory: ${cwd}`,
    `Platform: ${process.platform}`,
    `Date: ${new Date().toISOString().split("T")[0]}`,
  ];
  const systemPrompt = buildSystemPrompt([basePrompt, ...contextLines].join("\n"), instructions, config.instructions);

  return { apiKey, model, systemPrompt, diligent: config, sources };
}
