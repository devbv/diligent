// Types

// Agent
export type { AgentEvent, AgentLoopConfig, MessageDelta, SerializableError } from "./agent/index";
export { agentLoop } from "./agent/index";
// Config
export type { DiligentConfig, DiscoveredInstruction } from "./config/index";
export {
  buildSystemPrompt,
  buildSystemPromptWithKnowledge,
  DEFAULT_CONFIG,
  DiligentConfigSchema,
  discoverInstructions,
  loadDiligentConfig,
  mergeConfig,
} from "./config/index";
// EventStream
export { EventStream } from "./event-stream";
// Infrastructure
export type { DiligentPaths } from "./infrastructure/index";
export { ensureDiligentDir, resolvePaths } from "./infrastructure/index";
// Knowledge
export type { KnowledgeConfig, KnowledgeEntry, KnowledgeType } from "./knowledge/index";
export {
  appendKnowledge,
  buildKnowledgeSection,
  rankKnowledge,
  readKnowledge,
} from "./knowledge/index";
// Provider
export type {
  Model,
  ModelDefinition,
  ProviderErrorType,
  ProviderEvent,
  ProviderResult,
  RetryConfig,
  StreamContext,
  StreamFunction,
  StreamOptions,
  ToolDefinition,
} from "./provider/index";
export {
  createAnthropicStream,
  createOpenAIStream,
  KNOWN_MODELS,
  ProviderError,
  resolveModel,
  withRetry,
} from "./provider/index";
// Session
export type {
  CompactionDetails,
  CompactionEntry,
  CutPointResult,
  ModelChangeEntry,
  ResumeSessionOptions,
  SessionContext,
  SessionEntry,
  SessionFileLine,
  SessionHeader,
  SessionInfo,
  SessionInfoEntry,
  SessionManagerConfig,
  SessionMessageEntry,
} from "./session/index";
export {
  appendEntry,
  buildSessionContext,
  createSessionFile,
  DeferredWriter,
  estimateTokens,
  extractFileOperations,
  findCutPoint,
  formatFileOperations,
  generateEntryId,
  generateSessionId,
  generateSummary,
  listSessions,
  readSessionFile,
  SESSION_VERSION,
  SessionManager,
  shouldCompact,
} from "./session/index";
// Skills
export type {
  DiscoveryOptions,
  SkillFrontmatter,
  SkillLoadError,
  SkillLoadResult,
  SkillMetadata,
} from "./skills/index";
export { discoverSkills, extractBody, renderSkillsSection } from "./skills/index";
// Tool
export type {
  ApprovalRequest,
  ApprovalResponse,
  Tool,
  ToolContext,
  ToolRegistry,
  ToolResult,
} from "./tool/index";
export { executeTool, ToolRegistryBuilder } from "./tool/index";
// Built-in tools
export {
  bashTool,
  createAddKnowledgeTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "./tools/index";
export type {
  AssistantMessage,
  ContentBlock,
  ImageBlock,
  Message,
  StopReason,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "./types";
