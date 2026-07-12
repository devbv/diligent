// @summary Client request dispatch context, session defaults injection, and request router for DiligentAppServer

import { resolveModel } from "@diligent/core/llm/models";
import type { NativeCompactFn } from "@diligent/core/llm/provider/native-compaction";
import type { ProviderManager } from "@diligent/core/llm/provider-manager";
import { normalizeThinkingEffort } from "@diligent/core/llm/thinking-effort";
import type { ProviderName, StreamFunction } from "@diligent/core/llm/types";
import type { AuthStoreOptions } from "../auth/auth-store";
import type { DiligentConfig } from "../config/schema";
import type { ModelInfo } from "../protocol/index";
import {
  DILIGENT_CLIENT_REQUEST_METHODS,
  type DiligentClientRequest,
  type DiligentServerNotification,
  type Mode,
  type ThinkingEffort,
} from "../protocol/index";
import type { RpcPeer } from "../rpc/channel";
import {
  buildProviderList,
  type ConfigReloadResult,
  type ConsentConfigManager,
  handleAuthOAuthCancel,
  handleAuthOAuthStart,
  handleAuthRemove,
  handleAuthSet,
  handleConfigReload,
  handleConfigSet,
  handleConsentSet,
  handleImageUpload,
} from "./config-handlers";
import { type ExperimentConfigManager, handleExperimentsList, handleExperimentsSet } from "./experiment-handlers";
import { handleKnowledgeList, handleKnowledgeUpdate } from "./knowledge-handlers";
import { handleMcpList, handleMcpLoginStart, handleMcpLogout } from "./mcp-handlers";
import { handleThreadDelete, handleThreadList, handleThreadResume } from "./session-handlers";
import { handleSkillsList, handleSkillsSet, type SkillConfigManager } from "./skill-handlers";
import { handleSubagentsList, handleSubagentsSet, type SubagentConfigManager } from "./subagent-handlers";
import {
  handleEffortSet,
  handleModeSet,
  handleThreadCompactStart,
  handleThreadRead,
  handleThreadStart,
  type ThreadHandlersContext,
  type ThreadRuntime,
} from "./thread-handlers";
import { handleToolsList, handleToolsSet } from "./tool-handlers";
import {
  handleTurnInterrupt,
  handleTurnStart,
  handleTurnSteer,
  handleTurnSteerCancel,
  handleTurnSteerUpdate,
} from "./turn-handlers";

// ─── Connected peer ──────────────────────────────────────────────────────────

/** Represents a connected client with its per-connection state. */
export interface ConnectedPeer {
  id: string;
  peer: RpcPeer;
  subscriptions: Set<string>;
  currentThreadId: string | null;
  cwd: string;
  mode: Mode;
  effort: ThinkingEffort;
  userId?: string;
}

// ─── Dispatch context ────────────────────────────────────────────────────────

export interface ModelConfig {
  currentModelId: string | undefined;
  getAvailableModels: () => ModelInfo[];
  onModelChange: (modelId: string, threadId?: string) => void;
}

export interface ToolConfigManager {
  getTools: () => DiligentConfig["tools"] | undefined;
  setTools: (tools: DiligentConfig["tools"] | undefined) => void;
}

/**
 * All dependencies that dispatchClientRequest() needs to route a request.
 * Built by DiligentAppServer.buildRequestDispatchContext() and passed to the
 * free function so the routing logic can live in a separate module.
 */
export interface ClientRequestDispatchContext {
  // Server identity
  serverName: string;
  serverVersion: string;
  getInitializeResult: (() => Record<string, unknown> | Promise<Record<string, unknown> | undefined>) | undefined;

  // Connection access
  getConnection(id: string): ConnectedPeer | undefined;
  setConnectionCurrentThreadId(connectionId: string, threadId: string | null): void;

  // Thread operations
  threadHandlersCtx: ThreadHandlersContext;
  turnInitiators: Map<string, string>;
  toolConfig: ToolConfigManager | undefined;
  skillConfig: SkillConfigManager | undefined;
  experimentConfig: ExperimentConfigManager | undefined;
  subagentConfig: SubagentConfigManager | undefined;
  consentConfig: ConsentConfigManager | undefined;
  reloadConfig: (() => Promise<ConfigReloadResult>) | undefined;

  // Subscription management
  subscribeToThread(connectionId: string, threadId: string): string;
  unsubscribeFromThread(subscriptionId: string): boolean;

  // Runtime resolver
  resolveThreadRuntime(threadId: string): Promise<ThreadRuntime>;

  // Model/config state
  modelConfig: ModelConfig | undefined;
  currentModelId: string | undefined;
  setCurrentModelId(id: string | undefined): void;
  streamFunction: StreamFunction | undefined;
  createNativeCompaction: ((provider: ProviderName) => NativeCompactFn | undefined) | undefined;
  lastUsedModelByCwd: Map<string, string>;
  lastUsedEffortByCwd: Map<string, ThinkingEffort>;

  // Auth state
  providerManager: ProviderManager | undefined;
  authStore: AuthStoreOptions | undefined;
  oauthPending: Promise<void> | null;
  setOAuthPending(value: Promise<void> | null): void;
  oauthAbortController: AbortController | null;
  setOAuthAbortController(controller: AbortController | null): void;
  openBrowser: ((url: string) => void) | undefined;

  // Notification emitter and other config
  emit(notification: DiligentServerNotification): Promise<void>;
  toImageUrl: ((path: string) => string | undefined) | undefined;
  cwd: string | undefined;
}

// ─── Session defaults injection ──────────────────────────────────────────────

/**
 * Inject connection-scoped defaults (cwd, mode, effort, threadId) into raw
 * request params before they are validated against the schema.
 */
export function applySessionDefaults(
  connectionId: string,
  method: string,
  params: Record<string, unknown>,
  getConnection: (id: string) => ConnectedPeer | undefined,
): Record<string, unknown> {
  const conn = getConnection(connectionId);
  if (!conn) return params;

  if (method === DILIGENT_CLIENT_REQUEST_METHODS.THREAD_START) {
    return {
      ...params,
      cwd: (params.cwd as string | undefined)?.length ? params.cwd : conn.cwd,
      mode: (params.mode as string | undefined) ?? conn.mode,
      effort: (params.effort as ThinkingEffort | undefined) ?? conn.effort,
    };
  }

  const threadScoped: string[] = [
    DILIGENT_CLIENT_REQUEST_METHODS.TURN_START,
    DILIGENT_CLIENT_REQUEST_METHODS.TURN_INTERRUPT,
    DILIGENT_CLIENT_REQUEST_METHODS.TURN_STEER,
    DILIGENT_CLIENT_REQUEST_METHODS.TURN_STEER_CANCEL,
    DILIGENT_CLIENT_REQUEST_METHODS.TURN_STEER_UPDATE,
    DILIGENT_CLIENT_REQUEST_METHODS.THREAD_COMPACT_START,
    DILIGENT_CLIENT_REQUEST_METHODS.MODE_SET,
    DILIGENT_CLIENT_REQUEST_METHODS.EFFORT_SET,
    DILIGENT_CLIENT_REQUEST_METHODS.THREAD_READ,
    DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_LIST,
    DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_UPDATE,
    DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_LIST,
    DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_SET,
    DILIGENT_CLIENT_REQUEST_METHODS.SKILLS_LIST,
    DILIGENT_CLIENT_REQUEST_METHODS.SKILLS_SET,
    DILIGENT_CLIENT_REQUEST_METHODS.EXPERIMENTS_LIST,
    DILIGENT_CLIENT_REQUEST_METHODS.EXPERIMENTS_SET,
    DILIGENT_CLIENT_REQUEST_METHODS.SUBAGENTS_LIST,
    DILIGENT_CLIENT_REQUEST_METHODS.SUBAGENTS_SET,
  ];

  if (threadScoped.includes(method)) {
    const threadId = params.threadId as string | undefined;
    return {
      ...params,
      threadId: threadId?.length ? threadId : (conn.currentThreadId ?? undefined),
    };
  }

  return params;
}

// ─── Request dispatcher ──────────────────────────────────────────────────────

/**
 * Routes a validated DiligentClientRequest to the appropriate handler.
 * Extracted from DiligentAppServer to keep server.ts focused on lifecycle,
 * state management, and connection tracking.
 */
export async function dispatchClientRequest(
  ctx: ClientRequestDispatchContext,
  connectionId: string,
  request: DiligentClientRequest,
): Promise<unknown> {
  switch (request.method) {
    case DILIGENT_CLIENT_REQUEST_METHODS.INITIALIZE: {
      if (request.params.protocolVersion !== 1) {
        throw Object.assign(
          new Error(`Unsupported protocolVersion: ${request.params.protocolVersion}. Only version 1 is supported.`),
          { code: -32602 },
        );
      }
      const extra = (await ctx.getInitializeResult?.()) ?? {};
      return {
        serverName: ctx.serverName,
        serverVersion: ctx.serverVersion,
        protocolVersion: 1,
        capabilities: {
          supportsFollowUp: true,
          supportsApprovals: true,
          supportsUserInput: true,
        },
        ...extra,
      };
    }

    case DILIGENT_CLIENT_REQUEST_METHODS.THREAD_START: {
      const result = await handleThreadStart(ctx.threadHandlersCtx, request.params);
      ctx.setConnectionCurrentThreadId(connectionId, result.threadId);
      return result;
    }

    case DILIGENT_CLIENT_REQUEST_METHODS.THREAD_RESUME: {
      const result = await handleThreadResume(ctx.threadHandlersCtx, request.params);
      if (result.found && result.threadId) ctx.setConnectionCurrentThreadId(connectionId, result.threadId);
      return result;
    }

    case DILIGENT_CLIENT_REQUEST_METHODS.THREAD_LIST:
      return handleThreadList(ctx.threadHandlersCtx, request.params.limit, request.params.includeChildren);

    case DILIGENT_CLIENT_REQUEST_METHODS.THREAD_READ:
      return handleThreadRead(ctx.threadHandlersCtx, request.params.threadId);

    case DILIGENT_CLIENT_REQUEST_METHODS.THREAD_COMPACT_START:
      return handleThreadCompactStart(ctx.threadHandlersCtx, request.params.threadId);

    case DILIGENT_CLIENT_REQUEST_METHODS.TURN_START:
      return handleTurnStart(ctx.threadHandlersCtx, request.params, connectionId, ctx.turnInitiators);

    case DILIGENT_CLIENT_REQUEST_METHODS.TURN_INTERRUPT:
      return handleTurnInterrupt(ctx.threadHandlersCtx, request.params.threadId);

    case DILIGENT_CLIENT_REQUEST_METHODS.TURN_STEER:
      return handleTurnSteer(
        ctx.threadHandlersCtx,
        request.params.threadId,
        request.params.content,
        request.params.attachments,
        request.params.steerId,
      );

    case DILIGENT_CLIENT_REQUEST_METHODS.TURN_STEER_CANCEL:
      return handleTurnSteerCancel(ctx.threadHandlersCtx, request.params.threadId, request.params.steerId);

    case DILIGENT_CLIENT_REQUEST_METHODS.TURN_STEER_UPDATE:
      return handleTurnSteerUpdate(
        ctx.threadHandlersCtx,
        request.params.threadId,
        request.params.steerId,
        request.params.content,
      );

    case DILIGENT_CLIENT_REQUEST_METHODS.MODE_SET:
      return handleModeSet(ctx.threadHandlersCtx, request.params.threadId, request.params.mode);

    case DILIGENT_CLIENT_REQUEST_METHODS.EFFORT_SET:
      return handleEffortSet(ctx.threadHandlersCtx, request.params.threadId, request.params.effort);

    case DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_LIST:
      return handleKnowledgeList(ctx.threadHandlersCtx, request.params.threadId, request.params.limit);

    case DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_UPDATE:
      return handleKnowledgeUpdate(ctx.threadHandlersCtx, request.params.threadId, request.params);

    case DILIGENT_CLIENT_REQUEST_METHODS.THREAD_DELETE: {
      const result = await handleThreadDelete(ctx.threadHandlersCtx, request.params.threadId);
      // Drop the connection's current-thread pointer if it referenced the deleted
      // thread. Otherwise later thread-scoped requests (e.g. TOOLS_LIST) would
      // inherit a dead thread id via applySessionDefaults and fail to resolve it.
      const conn = ctx.getConnection(connectionId);
      if (conn?.currentThreadId === request.params.threadId) {
        ctx.setConnectionCurrentThreadId(connectionId, null);
      }
      return result;
    }

    case DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_LIST:
      return handleToolsList(ctx.threadHandlersCtx, request.params.threadId);

    case DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_SET: {
      const manager = ctx.toolConfig;
      if (!manager) throw Object.assign(new Error("Tool config not available"), { code: -32601 });
      return handleToolsSet(ctx.threadHandlersCtx, manager, request.params.threadId, request.params);
    }

    case DILIGENT_CLIENT_REQUEST_METHODS.SKILLS_LIST: {
      const manager = ctx.skillConfig;
      if (!manager) throw Object.assign(new Error("Skill config not available"), { code: -32601 });
      return handleSkillsList(ctx.threadHandlersCtx, manager, request.params.threadId);
    }

    case DILIGENT_CLIENT_REQUEST_METHODS.SKILLS_SET: {
      const manager = ctx.skillConfig;
      if (!manager) throw Object.assign(new Error("Skill config not available"), { code: -32601 });
      return handleSkillsSet(ctx.threadHandlersCtx, manager, ctx.reloadConfig, request.params);
    }

    case DILIGENT_CLIENT_REQUEST_METHODS.EXPERIMENTS_LIST: {
      const manager = ctx.experimentConfig;
      if (!manager) throw Object.assign(new Error("Experiment config not available"), { code: -32601 });
      return handleExperimentsList(manager);
    }

    case DILIGENT_CLIENT_REQUEST_METHODS.EXPERIMENTS_SET: {
      const manager = ctx.experimentConfig;
      if (!manager) throw Object.assign(new Error("Experiment config not available"), { code: -32601 });
      return handleExperimentsSet(manager, ctx.reloadConfig, ctx.threadHandlersCtx.threads, request.params);
    }

    case DILIGENT_CLIENT_REQUEST_METHODS.SUBAGENTS_LIST: {
      const manager = ctx.subagentConfig;
      if (!manager) throw Object.assign(new Error("Subagent config not available"), { code: -32601 });
      return handleSubagentsList(ctx.threadHandlersCtx, manager, request.params.threadId);
    }

    case DILIGENT_CLIENT_REQUEST_METHODS.SUBAGENTS_SET: {
      const manager = ctx.subagentConfig;
      if (!manager) throw Object.assign(new Error("Subagent config not available"), { code: -32601 });
      return handleSubagentsSet(ctx.threadHandlersCtx, manager, ctx.reloadConfig, request.params);
    }

    case DILIGENT_CLIENT_REQUEST_METHODS.THREAD_SUBSCRIBE: {
      const subscriptionId = ctx.subscribeToThread(connectionId, request.params.threadId);
      return { subscriptionId };
    }

    case DILIGENT_CLIENT_REQUEST_METHODS.THREAD_UNSUBSCRIBE: {
      const ok = ctx.unsubscribeFromThread(request.params.subscriptionId);
      return { ok };
    }

    case DILIGENT_CLIENT_REQUEST_METHODS.CONFIG_SET: {
      const connectionThreadId = ctx.getConnection(connectionId)?.currentThreadId ?? undefined;
      const targetThreadId = request.params.threadId ?? connectionThreadId;
      const result = await handleConfigSet(ctx.modelConfig, ctx.currentModelId, request.params.model, targetThreadId);
      if (targetThreadId && result.model) {
        const runtime = await ctx.resolveThreadRuntime(targetThreadId);
        if (runtime.modelId !== result.model) {
          runtime.modelId = result.model;
          const model = resolveModel(result.model);
          const llmCompactionFn = ctx.createNativeCompaction?.(model.provider as ProviderName);
          const llmMsgStreamFn = ctx.streamFunction;
          runtime.agent?.setModel(result.model, llmMsgStreamFn, llmCompactionFn);
          const normalizedEffort = normalizeThinkingEffort(model, runtime.effort);
          if (normalizedEffort !== runtime.effort) {
            runtime.effort = normalizedEffort;
            runtime.agent?.setEffort(normalizedEffort);
            runtime.manager.appendEffortChange(normalizedEffort, "config");
            ctx.lastUsedEffortByCwd.set(runtime.cwd, normalizedEffort);
          }
          runtime.manager.appendModelChange(model.provider, model.id);
          ctx.lastUsedModelByCwd.set(runtime.cwd, result.model);
        }
      } else {
        ctx.setCurrentModelId(result.model);
      }
      return result;
    }

    case DILIGENT_CLIENT_REQUEST_METHODS.CONFIG_RELOAD:
      return handleConfigReload(ctx.reloadConfig, ctx.threadHandlersCtx.threads);

    case DILIGENT_CLIENT_REQUEST_METHODS.CONSENT_SET:
      return await handleConsentSet(ctx.consentConfig, request.params);

    case DILIGENT_CLIENT_REQUEST_METHODS.AUTH_LIST: {
      const pm = ctx.providerManager;
      const mc = ctx.modelConfig;
      if (!pm || !mc) throw Object.assign(new Error("Auth not available"), { code: -32601 });
      const providers = await buildProviderList(pm);
      return { providers, availableModels: mc.getAvailableModels() };
    }

    case DILIGENT_CLIENT_REQUEST_METHODS.AUTH_SET:
      return handleAuthSet(
        ctx.providerManager,
        request.params,
        (notification) => ctx.emit(notification),
        ctx.authStore,
      );

    case DILIGENT_CLIENT_REQUEST_METHODS.AUTH_REMOVE:
      return handleAuthRemove(
        ctx.providerManager,
        request.params,
        (notification) => ctx.emit(notification),
        ctx.authStore,
      );

    case DILIGENT_CLIENT_REQUEST_METHODS.AUTH_OAUTH_START:
      return handleAuthOAuthStart({
        params: request.params,
        providerManager: ctx.providerManager,
        oauthPending: ctx.oauthPending,
        setOAuthPending: (value) => ctx.setOAuthPending(value),
        setOAuthAbortController: (controller) => ctx.setOAuthAbortController(controller),
        openBrowser: ctx.openBrowser,
        emit: (notification) => ctx.emit(notification),
        authStore: ctx.authStore,
      });

    case DILIGENT_CLIENT_REQUEST_METHODS.AUTH_OAUTH_CANCEL:
      return handleAuthOAuthCancel({
        params: request.params,
        oauthAbortController: ctx.oauthAbortController,
      });

    case DILIGENT_CLIENT_REQUEST_METHODS.MCP_LIST:
      return handleMcpList(ctx.threadHandlersCtx.getMcpServers);

    case DILIGENT_CLIENT_REQUEST_METHODS.MCP_LOGIN_START:
      return handleMcpLoginStart({
        server: request.params.server,
        getMcpServers: ctx.threadHandlersCtx.getMcpServers,
        emit: (notification) => ctx.emit(notification),
      });

    case DILIGENT_CLIENT_REQUEST_METHODS.MCP_LOGOUT:
      return handleMcpLogout({
        server: request.params.server,
        getMcpServers: ctx.threadHandlersCtx.getMcpServers,
      });

    case DILIGENT_CLIENT_REQUEST_METHODS.IMAGE_UPLOAD: {
      const conn = ctx.getConnection(connectionId);
      const effectiveThreadId = request.params.threadId ?? conn?.currentThreadId ?? undefined;
      const attachment = await handleImageUpload({
        params: request.params,
        threadId: effectiveThreadId,
        cwd: conn?.cwd ?? ctx.cwd ?? process.cwd(),
        toImageUrl: ctx.toImageUrl,
      });
      return { attachment };
    }
  }
}
