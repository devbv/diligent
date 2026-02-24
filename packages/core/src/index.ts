// Types
export type {
  ContentBlock,
  TextBlock,
  ImageBlock,
  ThinkingBlock,
  ToolCallBlock,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Message,
  StopReason,
  Usage,
} from "./types";

// EventStream
export { EventStream } from "./event-stream";

// Provider
export type {
  Model,
  StreamFunction,
  StreamContext,
  StreamOptions,
  ToolDefinition,
  ProviderEvent,
  ProviderResult,
} from "./provider/index";
export { createAnthropicStream } from "./provider/index";

// Agent
export type { AgentEvent, AgentLoopConfig, MessageDelta } from "./agent/index";
export { agentLoop } from "./agent/index";

// Tool
export type {
  Tool,
  ToolContext,
  ApprovalRequest,
  ToolResult,
  ToolRegistry,
} from "./tool/index";
export { ToolRegistryBuilder, executeTool } from "./tool/index";

// Built-in tools
export { bashTool } from "./tools/bash";
