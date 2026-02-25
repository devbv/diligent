// Types

// Agent
export type { AgentEvent, AgentLoopConfig, MessageDelta, SerializableError } from "./agent/index";
export { agentLoop } from "./agent/index";
// Config
export type { DiligentConfig, DiscoveredInstruction } from "./config/index";
export {
  buildSystemPrompt,
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
// Provider
export type {
  Model,
  ProviderErrorType,
  ProviderEvent,
  ProviderResult,
  RetryConfig,
  StreamContext,
  StreamFunction,
  StreamOptions,
  ToolDefinition,
} from "./provider/index";
export { createAnthropicStream, ProviderError, withRetry } from "./provider/index";
// Session
export type {
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
  generateEntryId,
  generateSessionId,
  listSessions,
  readSessionFile,
  SESSION_VERSION,
  SessionManager,
} from "./session/index";
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
