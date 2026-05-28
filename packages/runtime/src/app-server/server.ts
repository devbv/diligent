// @summary JSON-RPC app server mapping SessionManager/AgentEvent to shared protocol requests and notifications

import { userInfo } from "node:os";
import { KNOWN_MODELS } from "@diligent/core/llm/models";
import type { NativeCompactFn } from "@diligent/core/llm/provider/native-compaction";
import type { ProviderManager } from "@diligent/core/llm/provider-manager";
import type { ProviderName, StreamFunction } from "@diligent/core/llm/types";
import type { RuntimeAgent } from "../agent/runtime-agent";
import type { AgentEvent } from "../agent-event";
import type { ApprovalRequest, ApprovalResponse, PermissionEngine } from "../approval/types";
import { type AuthStoreOptions, loadOAuthTokens } from "../auth/auth-store";
import type { ChildStopInfo } from "../collab/types";
import type { DiligentConfig } from "../config/schema";
import { getLastAssistantMessage, getTurnUsage, runCombinedHooks } from "../hooks/runner";
import type { DiligentPaths } from "../infrastructure";
import {
  AgentEventSchema,
  DILIGENT_CLIENT_NOTIFICATION_METHODS,
  DILIGENT_SERVER_NOTIFICATION_METHODS,
  DILIGENT_VERSION,
  DiligentClientRequestSchema,
  type DiligentServerNotification,
  type JSONRPCErrorResponse,
  JSONRPCErrorResponseSchema,
  JSONRPCRequestSchema,
  type JSONRPCResponse,
  JSONRPCResponseSchema,
  type Mode,
  type ThinkingEffort,
} from "../protocol/index";
import { isRpcNotification, isRpcRequest, isRpcResponse, type RpcPeer } from "../rpc/channel";
import { SessionManager, type SessionManagerConfig } from "../session/manager";
import { type BundledToolProvider, collectBundledHooks } from "../tools/bundled-provider";
import { collectPluginHooks } from "../tools/plugin-loader";
import type { UserInputRequest, UserInputResponse } from "../tools/user-input-types";
import {
  applySessionDefaults,
  type ClientRequestDispatchContext,
  type ConnectedPeer,
  dispatchClientRequest,
  type ModelConfig,
  type ToolConfigManager,
} from "./request-dispatcher";
import {
  handleServerResponseMessage,
  type PendingServerRequest,
  requestApprovalFromConnections,
  requestUserInputFromConnections,
} from "./server-requests";
import {
  getLatestEffortFromSessions,
  getLatestModelFromSessions,
  resetTurnRuntimeState,
  type ThreadRuntime,
} from "./thread-handlers";

export type { ConnectedPeer, ModelConfig, ToolConfigManager } from "./request-dispatcher";

export interface CreateAgentArgs {
  cwd: string;
  mode: Mode;
  effort: ThinkingEffort;
  modelId: string;
  approve: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  ask: (request: UserInputRequest) => Promise<UserInputResponse>;
  /** Lazily returns the current session ID for collab parent-session linking. */
  getSessionId?: () => string | undefined;
  /** The thread's current agent, if one already exists. Passed so createAgent can reuse the registry. */
  existingAgent?: RuntimeAgent;
  /** Called when a child agent's turn completes normally. Propagated to the collab registry. */
  onChildStop?: (info: ChildStopInfo) => Promise<{ continueWith?: import("@diligent/core/types").Message } | undefined>;
  /** User ID propagated to child agent stop hooks. */
  userId?: string;
}

export interface DiligentAppServerConfig {
  serverName?: string;
  serverVersion?: string;
  cwd?: string;
  getInitializeResult?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  resolvePaths: (cwd: string) => Promise<DiligentPaths>;
  createAgent: (args: CreateAgentArgs) => RuntimeAgent | Promise<RuntimeAgent>;
  streamFunction?: StreamFunction;
  createNativeCompaction?: (provider: ProviderName) => NativeCompactFn | undefined;
  compaction?: SessionManagerConfig["compaction"];
  /** Config/model management — required for CONFIG_SET and AUTH_LIST */
  modelConfig?: ModelConfig;
  /** Tool config management — required for TOOLS_LIST and TOOLS_SET */
  toolConfig?: ToolConfigManager;
  /** Provider manager — required for AUTH_* methods */
  providerManager?: ProviderManager;
  /** Open a URL in the browser — defaults to the built-in openBrowser from @diligent/core */
  openBrowser?: (url: string) => void;
  /** Convert an absolute image path to a URL for web clients (omit if not needed) */
  toImageUrl?: (absPath: string) => string | undefined;
  /** Loaded skill names for slash-command disambiguation in turn/start. */
  skillNames?: string[];
  /** Default effort from config (defaults to "medium") */
  defaultEffort?: ThinkingEffort;
  /** Permission policy engine loaded from runtime config (yolo/rules). */
  permissionEngine?: PermissionEngine;
  /** Lifecycle hooks config (UserPromptSubmit, Stop). */
  hooks?: DiligentConfig["hooks"];
  /** Product-owned in-process bundled tool providers. */
  bundledToolProviders?: BundledToolProvider[];
  /** User identifier included in hook inputs. Falls back to OS username if unset. */
  userId?: string;
  /** Called when a connection switches to a current thread. */
  onCurrentThreadChange?: (threadId: string) => void;
  /** Auth credential storage backend configuration. */
  authStore?: AuthStoreOptions;
}

async function resolveProviderPlanType(
  provider: string | undefined,
  authStore: AuthStoreOptions | undefined,
): Promise<string | undefined> {
  if (provider !== "chatgpt" || !authStore) return undefined;
  const tokens = await loadOAuthTokens(authStore).catch(() => undefined);
  return tokens?.account_info?.chatgpt_plan_type;
}

export class DiligentAppServer {
  private readonly serverName: string;
  private readonly serverVersion: string;
  private readonly threads = new Map<string, ThreadRuntime>();
  private readonly knownCwds = new Set<string>();
  private activeThreadId: string | null = null;

  // New multi-connection infrastructure
  private readonly connections = new Map<string, ConnectedPeer>();
  private readonly subscriptionMap = new Map<string, { connectionId: string; threadId: string }>();
  private readonly turnInitiators = new Map<string, string>(); // threadId → connectionId
  private readonly pendingServerRequests = new Map<number, PendingServerRequest>();
  private serverRequestSeq = 0;

  // Config/auth state
  private currentModelId: string | undefined;
  private oauthPending: Promise<void> | null = null;
  private oauthAbortController: AbortController | null = null;

  // Per-cwd cache to avoid scanning session files on every new thread creation
  private readonly lastUsedModelByCwd = new Map<string, string>();
  private readonly lastUsedEffortByCwd = new Map<string, ThinkingEffort>();

  constructor(private readonly config: DiligentAppServerConfig) {
    this.serverName = config.serverName ?? "diligent-app-server";
    this.serverVersion = config.serverVersion ?? DILIGENT_VERSION;
    this.knownCwds.add(config.cwd ?? process.cwd());
    this.currentModelId = config.modelConfig?.currentModelId;
  }

  // ─── New multi-connection API ───────────────────────────────────────────────

  connect(connectionId: string, peer: RpcPeer, options?: { cwd?: string; mode?: Mode; userId?: string }): () => void {
    const conn: ConnectedPeer = {
      id: connectionId,
      peer,
      subscriptions: new Set(),
      currentThreadId: null,
      cwd: options?.cwd ?? this.config.cwd ?? process.cwd(),
      mode: options?.mode ?? "default",
      effort: this.config.defaultEffort ?? "medium",
      userId: options?.userId,
    };
    this.connections.set(connectionId, conn);

    peer.onMessage(async (message) => {
      if (!this.connections.has(connectionId)) return;

      if (isRpcRequest(message)) {
        const response = await this.handleRequest(connectionId, message);
        await peer.send(response);
        return;
      }

      if (isRpcNotification(message)) {
        await this.handleNotification(message);
        return;
      }

      if (isRpcResponse(message)) {
        await handleServerResponseMessage({
          connectionId,
          message,
          pendingServerRequests: this.pendingServerRequests,
          getConnectionById: (id) => this.connections.get(id),
        });
      }
    });

    peer.onClose?.(() => {
      this.disconnect(connectionId);
    });

    return () => this.disconnect(connectionId);
  }

  disconnect(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    // Clean up subscriptions for this connection
    for (const [subId, sub] of this.subscriptionMap) {
      if (sub.connectionId === connectionId) {
        this.subscriptionMap.delete(subId);
      }
    }

    // Resolve pending server requests where this was the only remaining responder
    for (const [reqId, pending] of this.pendingServerRequests) {
      if (pending.sentTo.has(connectionId)) {
        pending.sentTo.delete(connectionId);
        if (pending.sentTo.size === 0) {
          clearTimeout(pending.timeoutId);
          this.pendingServerRequests.delete(reqId);
          pending.resolve(null);
        }
      }
    }

    this.connections.delete(connectionId);
  }

  subscribeToThread(connectionId: string, threadId: string): string {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error(`Unknown connection: ${connectionId}`);
    const subscriptionId = `sub-${crypto.randomUUID().slice(0, 8)}`;
    conn.subscriptions.add(threadId);
    this.subscriptionMap.set(subscriptionId, { connectionId, threadId });
    return subscriptionId;
  }

  unsubscribeFromThread(subscriptionId: string): boolean {
    const sub = this.subscriptionMap.get(subscriptionId);
    if (!sub) return false;
    this.subscriptionMap.delete(subscriptionId);
    const conn = this.connections.get(sub.connectionId);
    if (conn) conn.subscriptions.delete(sub.threadId);
    return true;
  }

  // ─── Request handling ───────────────────────────────────────────────────────

  async handleRequest(connectionId: string, raw: unknown): Promise<JSONRPCResponse> {
    const request = JSONRPCRequestSchema.safeParse(raw);
    if (!request.success) {
      return this.errorResponse("unknown", -32600, "Invalid Request", request.error.message);
    }

    const rawParams = (request.data.params ?? {}) as Record<string, unknown>;
    const params = applySessionDefaults(connectionId, request.data.method, rawParams, (id) => this.connections.get(id));

    const parsed = DiligentClientRequestSchema.safeParse({
      method: request.data.method,
      params,
    });

    if (!parsed.success) {
      return this.errorResponse(request.data.id, -32602, "Invalid params", parsed.error.message);
    }

    try {
      const result = await dispatchClientRequest(this.buildRequestDispatchContext(), connectionId, parsed.data);
      return JSONRPCResponseSchema.parse({ id: request.data.id, result });
    } catch (error) {
      const code =
        error instanceof Error && typeof (error as unknown as { code?: unknown }).code === "number"
          ? (error as unknown as { code: number }).code
          : -32000;
      const message = error instanceof Error ? error.message : String(error);
      return this.errorResponse(request.data.id, code, message);
    }
  }

  async handleNotification(raw: unknown): Promise<void> {
    const notification = JSONRPCRequestSchema.omit({ id: true }).safeParse(raw);
    if (!notification.success) {
      return;
    }

    if (notification.data.method === DILIGENT_CLIENT_NOTIFICATION_METHODS.INITIALIZED) {
      return;
    }
  }

  // ─── Turn consumption ────────────────────────────────────────────────────────

  private async consumeTurn(runtime: ThreadRuntime, runPromise: Promise<void>, turnId: string): Promise<void> {
    // Wire collab events from the registry into the notification stream.
    const wiredRegistries = new Set<import("../collab/registry").AgentRegistry>();
    const collabEventHandler = (event: AgentEvent) => {
      void this.emitFromAgentEvent(runtime.id, turnId, event);
    };
    const wireCollabHandler = () => {
      const currentRegistry = runtime.agent?.registry;
      if (!currentRegistry || wiredRegistries.has(currentRegistry)) return;
      currentRegistry.setCollabEventHandler(collabEventHandler);
      wiredRegistries.add(currentRegistry);
    };

    // Subscribe to manager events BEFORE awaiting so we don't miss early events.
    // Wire collab handler on each event — the agent (and its registry) is created
    // lazily inside manager.run(), so we wire as soon as it becomes available.
    const unsub = runtime.manager.subscribe((event) => {
      wireCollabHandler();
      void this.emitFromAgentEvent(runtime.id, turnId, event);
    });

    try {
      await runPromise;
      wireCollabHandler(); // wire any registry created during the run

      // Stop hooks (shell + plugin) are fired via SessionManager.onStop,
      // which covers both this parent turn and all child agent turns uniformly.

      // Ensure all session entries are durably persisted before signaling completion.
      await runtime.manager.waitForWrites();
      await this.emit({
        method: DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED,
        params: { threadId: runtime.id, turnId },
      });
    } catch (error) {
      const isAbort =
        (error instanceof Error && (error.name === "AbortError" || error.message === "Aborted")) ||
        runtime.abortController?.signal.aborted === true;

      if (isAbort) {
        await this.emit({
          method: DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_INTERRUPTED,
          params: { threadId: runtime.id, turnId },
        });
      } else {
        await this.emit({
          method: DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR,
          params: {
            threadId: runtime.id,
            error: {
              message: error instanceof Error ? error.message : String(error),
              name: error instanceof Error ? error.name : "Error",
            },
            fatal: false,
          },
        });
      }
    } finally {
      unsub();
      // Disconnect collab event handlers from every registry instance wired during this turn.
      for (const registry of wiredRegistries) {
        registry.setCollabEventHandler(undefined);
      }

      resetTurnRuntimeState(runtime);
      await this.emit({
        method: DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED,
        params: { threadId: runtime.id, status: "idle" },
      });

      // On turn end (including interruption), pending steering remains queued
      // until an explicit subsequent turn is started by the client.
    }
  }

  private async emitFromAgentEvent(threadId: string, turnId: string, event: AgentEvent): Promise<void> {
    const runtime = this.threads.get(threadId);
    const parsedAgentEvent = AgentEventSchema.safeParse(event);
    if (parsedAgentEvent.success) {
      await this.emit({
        method: DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT,
        params: {
          threadId,
          turnId,
          event: parsedAgentEvent.data,
          ...(runtime?.isRunning === true ? { threadStatus: "busy" as const } : {}),
        },
      });
    }
  }

  // ─── Notification routing ───────────────────────────────────────────────────

  private async emit(notification: DiligentServerNotification): Promise<void> {
    // Collab debugging: always-on server-side log for collab/* notifications.
    // Intentionally redact large prompt fields to avoid noisy logs.
    if (notification.method.startsWith("collab/")) {
      const params = notification.params as Record<string, unknown>;
      const safeParams: Record<string, unknown> = { ...params };
      if (typeof safeParams.prompt === "string") {
        const prompt = safeParams.prompt as string;
        safeParams.prompt = `${prompt.slice(0, 120)}${prompt.length > 120 ? "…" : ""}`;
        safeParams.promptLength = prompt.length;
      }
    }

    // Clear turn initiator when turn ends
    if (
      notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED ||
      notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_INTERRUPTED
    ) {
      const params = notification.params as { threadId?: string };
      if (params.threadId) {
        this.turnInitiators.delete(params.threadId);
      }
    }

    // New: multi-connection routing
    if (this.connections.size === 0) return;

    const threadId = (notification.params as { threadId?: string } | undefined)?.threadId;

    if (!threadId) {
      // No threadId → broadcast to all connections
      for (const conn of this.connections.values()) {
        await conn.peer.send(notification);
      }
      return;
    }

    // Thread-scoped: route to subscribed connections; fallback to all if none subscribed
    const subscribers = [...this.connections.values()].filter((c) => c.subscriptions.has(threadId));
    const targets = subscribers.length > 0 ? subscribers : [...this.connections.values()];

    for (const conn of targets) {
      // Skip turn initiator for echo of their own user message events
      if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT) {
        const params = notification.params as { event?: { type?: string }; threadId?: string };
        if (
          params.event?.type === "user_message" &&
          params.threadId &&
          this.turnInitiators.get(params.threadId) === conn.id
        ) {
          continue;
        }
      }
      await conn.peer.send(notification);
    }
  }

  // ─── Server request broadcasting ────────────────────────────────────────────

  private allocateServerRequestId(): number {
    this.serverRequestSeq += 1;
    return this.serverRequestSeq;
  }

  private async requestApproval(threadId: string, request: ApprovalRequest): Promise<ApprovalResponse> {
    const policyAction = this.config.permissionEngine?.evaluate(request);
    if (policyAction === "allow") {
      return "once";
    }
    if (policyAction === "deny") {
      return "reject";
    }

    const decision = await requestApprovalFromConnections({
      threadId,
      request,
      connections: this.connections,
      pendingServerRequests: this.pendingServerRequests,
      allocateServerRequestId: () => this.allocateServerRequestId(),
    });

    if (decision === "always") {
      this.config.permissionEngine?.remember(request, "allow");
    }

    return decision;
  }

  private async requestUserInput(threadId: string, request: UserInputRequest): Promise<UserInputResponse> {
    return requestUserInputFromConnections({
      threadId,
      request,
      connections: this.connections,
      pendingServerRequests: this.pendingServerRequests,
      allocateServerRequestId: () => this.allocateServerRequestId(),
    });
  }

  // ─── Thread runtime utilities ────────────────────────────────────────────────

  private async createThreadRuntime(
    threadId: string,
    cwd: string,
    mode: Mode,
    createNew: boolean,
    effort: ThinkingEffort = this.config.defaultEffort ?? "medium",
    modelId?: string,
  ): Promise<ThreadRuntime> {
    const runtime: ThreadRuntime = {
      id: threadId,
      cwd,
      mode,
      effort,
      modelId: modelId ?? this.currentModelId ?? KNOWN_MODELS[0].id,
      runningEffortSnapshot: undefined,
      runningModelIdSnapshot: undefined,
      manager: null as unknown as SessionManager,
      abortController: null,
      currentTurnId: null,
      isRunning: false,
    };

    const paths = await this.config.resolvePaths(cwd);
    runtime.manager = new SessionManager({
      cwd,
      paths,
      agent: async () => {
        if (!runtime.agent) {
          const newAgent = await this.config.createAgent({
            cwd,
            mode: runtime.mode,
            effort: runtime.runningEffortSnapshot ?? runtime.effort,
            modelId: runtime.runningModelIdSnapshot ?? runtime.modelId,
            approve: (request) => this.requestApproval(runtime.id, request),
            ask: (request) => this.requestUserInput(runtime.id, request),
            getSessionId: () => runtime.manager.sessionId,
            existingAgent: runtime.agent,
            onChildStop: (info) => this.runStopHooksFor(info),
            userId: runtime.currentTurnUserId,
          });
          runtime.agent = newAgent;
          for (const histAgent of runtime.manager.getHistoricalCollabAgents()) {
            newAgent.registry?.restoreAgent(histAgent.threadId, histAgent.nickname);
          }
        }
        return runtime.agent;
      },
      compaction: this.config.compaction,
      knowledgePath: paths.knowledge,
      onStop: (context, isRerun) =>
        this.runStopHooksFor({
          sessionId: runtime.manager.sessionId,
          sessionPath: runtime.manager.sessionPath ?? "",
          cwd: runtime.cwd,
          model: runtime.runningModelIdSnapshot ?? runtime.modelId,
          provider: runtime.agent?.model?.provider,
          effort: runtime.runningEffortSnapshot ?? runtime.effort,
          permissionMode: runtime.mode,
          userId: runtime.currentTurnUserId,
          context,
          isRerun,
        }),
    });

    if (createNew) {
      await runtime.manager.create();
    }

    return runtime;
  }

  private async resolveThreadRuntime(threadId?: string): Promise<ThreadRuntime> {
    const id = threadId ?? this.activeThreadId;
    if (!id) throw new Error("No active thread");

    const existing = this.threads.get(id);
    if (existing) {
      return existing;
    }

    for (const cwd of this.knownCwds) {
      const runtime = await this.createThreadRuntime(id, cwd, "default", false, await this.getLatestEffortForCwd(cwd));
      const resumed = await runtime.manager.resume({ sessionId: id });
      if (!resumed) continue;

      runtime.effort = runtime.manager.getCurrentEffort() ?? runtime.effort;
      runtime.modelId = runtime.manager.getCurrentModel()?.modelId ?? runtime.modelId;
      this.threads.set(id, runtime);
      this.activeThreadId = id;

      return runtime;
    }

    throw new Error(`Thread not found: ${id}`);
  }

  private async getLatestEffortForCwd(cwd: string): Promise<ThinkingEffort> {
    const fallback = this.config.defaultEffort ?? "medium";
    for (const runtime of this.threads.values()) {
      if (runtime.cwd === cwd) {
        const effort = runtime.manager.getCurrentEffort() ?? runtime.effort;
        if (effort) {
          this.lastUsedEffortByCwd.set(cwd, effort);
          return effort;
        }
      }
    }
    const cached = this.lastUsedEffortByCwd.get(cwd);
    if (cached !== undefined) return cached;
    const result = await getLatestEffortFromSessions(this.config.resolvePaths, this.threads, cwd, fallback);
    this.lastUsedEffortByCwd.set(cwd, result);
    return result;
  }

  private async getLatestModelForCwd(cwd: string): Promise<string | undefined> {
    for (const runtime of this.threads.values()) {
      if (runtime.cwd === cwd) {
        const modelId = runtime.manager.getCurrentModel()?.modelId ?? runtime.modelId;
        if (modelId) {
          this.lastUsedModelByCwd.set(cwd, modelId);
          return modelId;
        }
      }
    }
    const cached = this.lastUsedModelByCwd.get(cwd);
    if (cached !== undefined) return cached;
    const result = await getLatestModelFromSessions(this.config.resolvePaths, this.threads, cwd, this.currentModelId);
    if (result !== undefined) this.lastUsedModelByCwd.set(cwd, result);
    return result;
  }

  private async resolveToolsContext(
    threadId?: string,
  ): Promise<{ cwd: string; tools: DiligentConfig["tools"] | undefined }> {
    const manager = this.config.toolConfig;
    if (!manager) throw Object.assign(new Error("Tool config not available"), { code: -32601 });

    if (threadId || this.activeThreadId) {
      const runtime = await this.resolveThreadRuntime(threadId);
      return { cwd: runtime.cwd, tools: manager.getTools() };
    }

    const cwd = this.config.cwd ?? process.cwd();
    this.knownCwds.add(cwd);
    return { cwd, tools: manager.getTools() };
  }

  /**
   * Unified Stop hook runner — called by SessionManager.onStop for both parent and child agents.
   * Returns `{ continueWith }` when a hook blocks to re-run the agent with the reason.
   */
  private async runStopHooksFor(
    info: ChildStopInfo & { permissionMode?: string; userId?: string },
  ): Promise<{ continueWith?: import("@diligent/core/types").Message } | undefined> {
    const stopShellHandlers = this.config.hooks?.Stop ?? [];
    const { onStop: stopPluginHandlers } = await collectPluginHooks(this.config.toolConfig?.getTools(), info.cwd);
    const { onStop: stopBundledHandlers } = collectBundledHooks(this.config.bundledToolProviders);
    const stopHandlers = [...stopPluginHandlers, ...stopBundledHandlers];

    if (stopShellHandlers.length === 0 && stopHandlers.length === 0) return;

    const providerPlanType = await resolveProviderPlanType(info.provider, this.config.authStore);

    const stopInput = {
      session_id: info.sessionId,
      transcript_path: info.sessionPath,
      cwd: info.cwd,
      hook_event_name: "Stop",
      permission_mode: info.permissionMode,
      stop_hook_active: info.isRerun,
      last_assistant_message: getLastAssistantMessage(info.context),
      usage: getTurnUsage(info.context),
      model: info.model,
      provider: info.provider,
      ...(providerPlanType ? { provider_plan_type: providerPlanType } : {}),
      effort: info.effort,
      user_id: info.userId,
    };

    const stopResult = await runCombinedHooks(stopShellHandlers, stopHandlers, stopInput, info.cwd);

    if (stopResult.blocked && stopResult.reason) {
      return {
        continueWith: { role: "user" as const, content: stopResult.reason, timestamp: Date.now() },
      };
    }
  }

  private buildRequestDispatchContext(): ClientRequestDispatchContext {
    return {
      serverName: this.serverName,
      serverVersion: this.serverVersion,
      getInitializeResult: this.config.getInitializeResult,
      getConnection: (id) => this.connections.get(id),
      setConnectionCurrentThreadId: (connectionId, threadId) => {
        const conn = this.connections.get(connectionId);
        if (conn) conn.currentThreadId = threadId;
        this.config.onCurrentThreadChange?.(threadId);
      },
      threadHandlersCtx: this.buildThreadHandlersContext(),
      turnInitiators: this.turnInitiators,
      toolConfig: this.config.toolConfig,
      subscribeToThread: (connectionId, threadId) => this.subscribeToThread(connectionId, threadId),
      unsubscribeFromThread: (subscriptionId) => this.unsubscribeFromThread(subscriptionId),
      resolveThreadRuntime: (threadId) => this.resolveThreadRuntime(threadId),
      modelConfig: this.config.modelConfig,
      currentModelId: this.currentModelId,
      setCurrentModelId: (id) => {
        this.currentModelId = id;
      },
      streamFunction: this.config.streamFunction,
      createNativeCompaction: this.config.createNativeCompaction,
      lastUsedModelByCwd: this.lastUsedModelByCwd,
      lastUsedEffortByCwd: this.lastUsedEffortByCwd,
      providerManager: this.config.providerManager,
      authStore: this.config.authStore,
      oauthPending: this.oauthPending,
      setOAuthPending: (value) => {
        this.oauthPending = value;
      },
      oauthAbortController: this.oauthAbortController,
      setOAuthAbortController: (controller) => {
        this.oauthAbortController = controller;
      },
      openBrowser: this.config.openBrowser,
      emit: (notification) => this.emit(notification),
      toImageUrl: this.config.toImageUrl,
      cwd: this.config.cwd,
    };
  }

  private buildThreadHandlersContext() {
    return {
      activeThreadId: this.activeThreadId,
      threads: this.threads,
      knownCwds: this.knownCwds,
      hooks: this.config.hooks,
      getUserId: (connectionId: string | undefined): string => {
        if (connectionId) {
          const conn = this.connections.get(connectionId);
          if (conn?.userId) return conn.userId;
        }
        return this.config.userId ?? userInfo().username;
      },
      getPluginHooks: async (cwd: string) => {
        const pluginHooks = await collectPluginHooks(this.config.toolConfig?.getTools(), cwd);
        const bundledHooks = collectBundledHooks(this.config.bundledToolProviders);
        return {
          onUserPromptSubmit: [...pluginHooks.onUserPromptSubmit, ...bundledHooks.onUserPromptSubmit],
          onStop: [...pluginHooks.onStop, ...bundledHooks.onStop],
        };
      },
      resolvePaths: this.config.resolvePaths,
      createThreadRuntime: (
        threadId: string,
        cwd: string,
        mode: Mode,
        createNew: boolean,
        effort?: ThinkingEffort,
        modelId?: string,
      ) => this.createThreadRuntime(threadId, cwd, mode, createNew, effort, modelId),
      resolveThreadRuntime: (threadId?: string) => this.resolveThreadRuntime(threadId),
      getLatestEffortForCwd: (cwd: string) => this.getLatestEffortForCwd(cwd),
      getLatestModelForCwd: (cwd: string) => this.getLatestModelForCwd(cwd),
      emit: (notification: DiligentServerNotification) => this.emit(notification),
      consumeTurn: (runtime: ThreadRuntime, runPromise: Promise<void>, turnId: string) =>
        this.consumeTurn(runtime, runPromise, turnId),
      resolveToolsContext: (threadId?: string) => this.resolveToolsContext(threadId),
      getBundledToolProviders: () => this.config.bundledToolProviders ?? [],
      getSkillNames: () => this.getSkillNames(),
      setActiveThreadId: (threadId: string | null) => {
        this.activeThreadId = threadId;
      },
    };
  }

  private getSkillNames(): string[] {
    return this.config.skillNames ?? [];
  }

  private errorResponse(
    id: string | number | "unknown",
    code: number,
    message: string,
    data?: unknown,
  ): JSONRPCErrorResponse {
    return JSONRPCErrorResponseSchema.parse({
      id: id === "unknown" ? "unknown" : id,
      error: { code, message, data },
    });
  }
}
