// @summary Public LLM compaction policy and native compaction boundary

export type {
  CompactionPrompts,
  CompactMessagesResult,
  GenerateSummaryOptions,
  LLMCompactConfig,
  LLMCompactInput,
  LLMCompactResult,
} from "../llm/compaction";
export {
  COMPACTION_MIN_INPUT_TOKENS,
  compact,
  compactMessages,
  DEFAULT_COMPACTION_PROMPTS,
  generateSummary,
  NATIVE_COMPACTION_MIN_INPUT_TOKENS,
  resolveCompaction,
} from "../llm/compaction";
