// @summary Public provider engine contracts, manager, retry, and turn-resource boundary

export type {
  NativeCompactFn,
  NativeCompactionInput,
  NativeCompactionLookup,
  NativeCompactionResult,
  NativeCompactionSuccess,
  NativeCompactionUnsupported,
} from "../llm/provider/native-compaction";
export type { ExternalProviderAuth, ProviderManagerConfig } from "../llm/provider-manager";
export {
  createStreamForProvider,
  DEFAULT_PROVIDER,
  PROVIDER_NAMES,
  ProviderManager,
} from "../llm/provider-manager";
export { getDefaultModelRef, PROVIDER_MODEL_POLICIES } from "../llm/provider-model-policy";
export type { RetryConfig } from "../llm/retry";
export { withRetry } from "../llm/retry";
export type { StreamTurnResource, StreamTurnScope } from "../llm/turn-scope";
export { createStreamTurnScope } from "../llm/turn-scope";
export type {
  FunctionToolDefinition,
  Model,
  ModelInfo,
  ModelRef,
  ProviderBuiltinToolDefinition,
  ProviderErrorOptions,
  ProviderEvent,
  ProviderName,
  ProviderResult,
  StreamContext,
  StreamFunction,
  StreamOptions,
  SystemSection,
  ThinkingEffort,
  ToolDefinition,
  WebToolUserLocation,
} from "../llm/types";
export {
  CONTEXT_OVERFLOW_ERROR_MESSAGE,
  ProviderError,
  ProviderErrorReason,
  ProviderErrorType,
  resolveMaxTokens,
} from "../llm/types";
