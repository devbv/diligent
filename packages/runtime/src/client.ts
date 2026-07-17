// @summary Browser-safe subset of @diligent/core for web client imports (no Node.js APIs)

export type { MessageDelta, SerializableError } from "@diligent/core/agent";
export type {
  AssistantMessage,
  ContentBlock,
  ImageBlock,
  LocalImageBlock,
  Message,
  StopReason,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@diligent/core/message-contract";
export {
  findModelInfo,
  getThinkingEffortLabel,
  getThinkingEffortOptions,
  getThinkingEffortUsage,
  getThinkingEffortUsageValues,
  supportsThinkingNone,
} from "@diligent/core/model-registry";
export type { Mode } from "./agent/mode";
export type { AgentEvent, ChildAgentEvent, RuntimeAgentEvent } from "./agent-event";
export { ProtocolNotificationAdapter } from "./notification-adapter";
