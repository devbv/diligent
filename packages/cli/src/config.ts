import type {
  AgentEvent,
  AgentLoopConfig,
  DiligentConfig,
  DiligentPaths,
  EventStream,
  Message,
  Model,
  ModeKind,
  SkillMetadata,
  StreamFunction,
} from "@diligent/core";
import {
  buildKnowledgeSection,
  buildSystemPromptWithKnowledge,
  createAnthropicStream,
  createOpenAIStream,
  discoverInstructions,
  discoverSkills,
  loadDiligentConfig,
  readKnowledge,
  renderSkillsSection,
  resolveModel,
} from "@diligent/core";

export type AgentLoopFn = (messages: Message[], config: AgentLoopConfig) => EventStream<AgentEvent, Message[]>;

export interface AppConfig {
  apiKey: string;
  model: Model;
  systemPrompt: string;
  streamFunction: StreamFunction;
  diligent: DiligentConfig;
  sources: string[];
  agentLoopFn?: AgentLoopFn;
  skills: SkillMetadata[];
  mode: ModeKind; // D087: always set, defaults to "default"
}

const BASE_SYSTEM_PROMPT = [
  "You are a coding assistant. You help developers by running commands and explaining results.",
  "Use the bash tool to execute shell commands when needed.",
].join("\n");

export async function loadConfig(cwd: string = process.cwd(), paths?: DiligentPaths): Promise<AppConfig> {
  const { config, sources } = await loadDiligentConfig(cwd);
  const instructions = await discoverInstructions(cwd);

  // Resolve model from config or default
  const modelId = config.model ?? "claude-sonnet-4-20250514";
  const model = resolveModel(modelId);

  // Resolve API key and stream function based on provider
  let apiKey: string;
  let streamFunction: StreamFunction;

  if (model.provider === "openai") {
    apiKey = config.provider?.openai?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY environment variable is required for OpenAI models.\n" +
          "Get your API key at https://platform.openai.com/api-keys",
      );
    }
    streamFunction = createOpenAIStream(apiKey, config.provider?.openai?.baseUrl);
  } else {
    apiKey = config.provider?.anthropic?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is required.\n" +
          "Get your API key at https://console.anthropic.com/settings/keys",
      );
    }
    streamFunction = createAnthropicStream(apiKey);
  }

  // Load knowledge for system prompt injection
  let knowledgeSection = "";
  if (paths) {
    const knowledgeEnabled = config.knowledge?.enabled ?? true;
    if (knowledgeEnabled) {
      const knowledgeEntries = await readKnowledge(paths.knowledge);
      const injectionBudget = config.knowledge?.injectionBudget ?? 8192;
      knowledgeSection = buildKnowledgeSection(knowledgeEntries, injectionBudget);
    }
  }

  // Load skills
  let skills: SkillMetadata[] = [];
  let skillsSection = "";
  const skillsEnabled = config.skills?.enabled ?? true;
  if (skillsEnabled) {
    const result = await discoverSkills({
      cwd,
      additionalPaths: config.skills?.paths,
    });
    skills = result.skills;
    skillsSection = renderSkillsSection(skills);
  }

  // Build system prompt with knowledge AND skills
  const basePrompt = config.systemPrompt ?? BASE_SYSTEM_PROMPT;
  const contextLines = [
    `Current working directory: ${cwd}`,
    `Platform: ${process.platform}`,
    `Date: ${new Date().toISOString().split("T")[0]}`,
  ];
  const systemPrompt = buildSystemPromptWithKnowledge(
    [basePrompt, ...contextLines].join("\n"),
    instructions,
    knowledgeSection,
    config.instructions,
    skillsSection,
  );

  return { apiKey, model, systemPrompt, streamFunction, diligent: config, sources, skills, mode: (config.mode ?? "default") as ModeKind };
}
