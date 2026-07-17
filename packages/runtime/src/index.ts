// @summary Runtime package barrel for coding-agent integrations and built-in implementations
export type {
  AgentOptions,
  CoreAgentEvent,
} from "@diligent/core/agent";
export { Agent } from "@diligent/core/agent";
export type { OpenAIOAuthTokens } from "@diligent/core/auth";
export { EventStream } from "@diligent/core/event-stream";
export type { Message } from "@diligent/core/message-contract";
export {
  formatModelRef,
  getModelInfoList,
  getThinkingEffortOptions,
  getThinkingEffortUsage,
  getThinkingEffortUsageValues,
  listModels,
  MODEL_CATALOG,
  normalizeThinkingEffort,
  resolveModel,
  resolveModelSelector,
  supportsThinkingEffort,
} from "@diligent/core/model-registry";
export { flattenSections } from "@diligent/core/prompt-contract";
export type { Model, ModelRef, ProviderName, StreamFunction, SystemSection } from "@diligent/core/provider-contract";
export {
  DEFAULT_PROVIDER,
  getDefaultModelRef,
  PROVIDER_MODEL_POLICIES,
  PROVIDER_NAMES,
  ProviderManager,
} from "@diligent/core/provider-contract";
export { createAnthropicStream } from "@diligent/core/providers/anthropic";
export { createGeminiStream } from "@diligent/core/providers/gemini";
export { createOpenAIStream } from "@diligent/core/providers/openai";
export type { Tool, ToolContext, ToolRegistry, ToolResult } from "@diligent/core/tool-contract";
export { getBuiltinAgentDefinitions } from "./agent/agent-types";
export type { ContextPresentation } from "./agent/context-presentation";
export { createPresentableContextInjection, readContextPresentation } from "./agent/context-presentation";
export type { Mode } from "./agent/mode";
export type { ResolvedAgentDefinition } from "./agent/resolved-agent";
export { resolveAgentDefinition, resolveAvailableAgentDefinitions } from "./agent/resolved-agent";
export { RuntimeAgent } from "./agent/runtime-agent";
export type { AgentEvent, ChildAgentEvent, RuntimeAgentEvent } from "./agent-event";
export type { AgentDiscoveryOptions, AgentFrontmatter, AgentLoadError, AgentLoadResult, AgentMetadata } from "./agents";
export { discoverAgents, parseAgentFrontmatter, renderAgentsSection, validateAgentName } from "./agents";
export type {
  ConsentConfigManager,
  CreateAgentArgs,
  CreateAppServerConfigOptions,
  DiligentAppServerConfig,
  ExperimentConfigManager,
} from "./app-server";
export { bindAppServer, createAppServerConfig, DiligentAppServer } from "./app-server";
export type { ApprovalRequest, ApprovalResponse, PermissionAction, PermissionEngine, PermissionRule } from "./approval";
export { createPermissionEngine, createYoloPermissionEngine } from "./approval";
export type {
  AuthKeys,
  ChatGPTOAuthBinding,
  ExternalProviderAuthPresentation,
  OAuthFlowOptions,
  ProviderAuthPresentationStatus,
  VertexAccessTokenBinding,
  VertexProviderConfig,
} from "./auth";
export {
  createChatGPTOAuthBinding,
  createVertexAccessTokenBinding,
  getAuthFilePath,
  loadAuthStore,
  loadOAuthTokens,
  openBrowser,
  ProviderAuthPresenter,
  removeAuthKey,
  removeOAuthTokens,
  runChatGPTOAuth,
  saveAuthKey,
  saveOAuthTokens,
  waitForCallback,
} from "./auth";
export type { AgentEntry, AgentStatus, CollabToolDeps } from "./collab";
export { AgentRegistry, COLLAB_TOOL_NAMES, createCollabTools } from "./collab";
export type {
  DiligentConfig,
  DiscoveredInstruction,
  RuntimeConfig,
  StoredToolsConfig,
  ToolConfigPatch,
  ToolPluginPatch,
  WriteToolsConfigResult,
} from "./config";
export {
  applyConsentPatch,
  applyToolConfigPatch,
  buildSystemPrompt,
  buildSystemPromptWithKnowledge,
  currentPrivacyPolicyUrl,
  DEFAULT_CONFIG,
  DiligentConfigSchema,
  discoverInstructions,
  getGlobalConfigPath,
  getGlobalUserIdPath,
  getProjectConfigPath,
  loadDiligentConfig,
  loadRuntimeConfig,
  mergeConfig,
  normalizeStoredToolsConfig,
  refreshPrivacyPolicyUrl,
  resolveConfiguredUserId,
  resolveConsentState,
  saveGlobalExperimentOverrides,
  saveGlobalModel,
  writeGlobalToolsConfig,
  writeProjectToolsConfig,
} from "./config";
export type { ExperimentDefinition, ResolvedExperiment } from "./experiments";
export { resolveExperimentGates, resolveExperimentStates } from "./experiments";
export type { HookInput, HookResult, PluginHookFn } from "./hooks/runner";
export type { DiligentPaths } from "./infrastructure";
export { ensureDiligentDir, resolvePaths } from "./infrastructure";
export type { KnowledgeConfig, KnowledgeEntry, KnowledgeType } from "./knowledge";
export { appendKnowledge, buildKnowledgeSection, rankKnowledge, readKnowledge, writeKnowledge } from "./knowledge";
export { ProtocolNotificationAdapter } from "./notification-adapter";
export type { SystemPromptVars } from "./prompt";
export { buildBaseSystemPrompt } from "./prompt";
export type { ConsentSetParams, ConsentState } from "./protocol";
export { PROVIDER_DESCRIPTORS } from "./provider";
export type { NdjsonParser, RpcMessageSink, RpcMessageSource, RpcPeer, WebSocketSender } from "./rpc";
export {
  createNdjsonParser,
  createWsPeer,
  formatNdjsonMessage,
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  RpcClientSession,
} from "./rpc";
export type {
  AppendedEntryInfo,
  CompactionEntry,
  ModeChangeEntry,
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
} from "./session";
export {
  appendEntry,
  buildSessionContext,
  buildSessionTranscript,
  createSessionFile,
  generateEntryId,
  generateSessionId,
  listSessions,
  readSessionFile,
  SESSION_VERSION,
  SessionManager,
  SessionWriter,
} from "./session";
export type { DiscoveryOptions, SkillFrontmatter, SkillLoadError, SkillLoadResult, SkillMetadata } from "./skills";
export { discoverSkills, extractBody, renderSkillsSection } from "./skills";
export type {
  AgentLoopHookFactory,
  AgentLoopHookFactoryContext,
  BuildDefaultToolsResult,
  BuildToolCatalogOptions,
  BundledToolProvider,
  BundledToolProviderContext,
  CollectedBundledHooks,
  PluginLoadError,
  PluginLoadResult,
  PluginManifest,
  PluginStateEntry,
  RuntimeToolHost,
  ToolCatalogResult,
  ToolStateEntry,
  ToolStateReason,
  UserInputQuestion,
  UserInputRequest,
  UserInputResponse,
  UserInputSource,
} from "./tools";
export {
  buildDefaultTools,
  buildToolCatalog,
  collectBundledHooks,
  createApplyPatchTool,
  createBashTool,
  createBundledAgentLoopHooks,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createLsTool,
  createMultiEditTool,
  createPlanTool,
  createReadImageTool,
  createReadTool,
  createRequestUserInputTool,
  createSearchKnowledgeTool,
  createSkillTool,
  createUpdateKnowledgeTool,
  createWriteAbsoluteTool,
  createWriteTool,
  getGlobalPluginPath,
  getGlobalPluginRoot,
  IMMUTABLE_TOOLS,
  isImmutableTool,
  loadPlugin,
  registerSkillTool,
  requestToolApproval,
  requestToolUserInput,
} from "./tools";
