// @summary LLM barrel exporting shared model/runtime modules, provider implementations, and compaction

export type {
  CompactionPrompts,
  CompactMessagesResult,
  GenerateSummaryOptions,
  LLMCompactConfig,
  LLMCompactInput,
} from "./compaction";
export { compact, compactMessages, generateSummary, resolveCompaction } from "./compaction";
export type { ModelClass, ModelClassDefinition } from "./model-class-policy";
export {
  getModelClass,
  MODEL_CLASSES,
  resolveModelForClass,
} from "./model-class-policy";
export type { ModelCard, ModelCardProvenance } from "./models";
export {
  AmbiguousModelError,
  findModel,
  formatModelRef,
  getModelInfoList,
  listModels,
  MODEL_CARD_SCHEMA_VERSION,
  MODEL_CATALOG,
  resolveModel,
  resolveModelSelector,
  sameModelRef,
  UnknownModelError,
} from "./models";
export { classifyAnthropicError, createAnthropicNativeCompaction, createAnthropicStream } from "./provider/anthropic";
export { createChatGPTNativeCompaction, createChatGPTStream } from "./provider/chatgpt";
export { classifyGeminiError, createGeminiStream } from "./provider/gemini";
export { createMockStream } from "./provider/mock";
export type {
  NativeCompactFn,
  NativeCompactionInput,
  NativeCompactionLookup,
  NativeCompactionResult,
  NativeCompactionSuccess,
  NativeCompactionUnsupported,
} from "./provider/native-compaction";
export { classifyOpenAIError, createOpenAINativeCompaction, createOpenAIStream } from "./provider/openai";
export { classifyVertexError, createVertexStream } from "./provider/vertex";
export type { ExternalProviderAuth, ProviderName } from "./provider-manager";
export {
  createStreamForProvider,
  DEFAULT_PROVIDER,
  PROVIDER_NAMES,
  ProviderManager,
} from "./provider-manager";
export type { ProviderModelPolicy } from "./provider-model-policy";
export { getDefaultModelRef, PROVIDER_MODEL_POLICIES } from "./provider-model-policy";
export type { RetryConfig } from "./retry";
export { withRetry } from "./retry";
export { resolveStream } from "./stream-resolver";
export { flattenSections } from "./system-sections";
export {
  findModelInfo,
  getThinkingEffortOptions,
  getThinkingEffortUsage,
  getThinkingEffortUsageValues,
  normalizeThinkingEffort,
  supportsThinkingEffort,
} from "./thinking-effort";
export type { StreamTurnResource, StreamTurnScope } from "./turn-scope";
export { createStreamTurnScope } from "./turn-scope";
export type {
  FunctionToolDefinition,
  Model,
  ModelInfo,
  ModelRef,
  ProviderBuiltinToolDefinition,
  ProviderEvent,
  ProviderResult,
  StreamContext,
  StreamFunction,
  StreamOptions,
  SystemSection,
  ToolDefinition,
  WebToolUserLocation,
} from "./types";
export { ProviderError, ProviderErrorReason, ProviderErrorType } from "./types";
