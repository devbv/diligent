// @summary AgentRegistry — spawn/wait/send_input/close lifecycle for non-blocking multi-agent collab

import type { TextBlock } from "@diligent/core/message-contract";
import {
  getModelClass,
  type ModelClass,
  resolveModel,
  resolveModelForClass,
  supportsThinkingEffort,
} from "@diligent/core/model-registry";
import type { ThinkingEffort } from "@diligent/core/provider-contract";
import type { Tool } from "@diligent/core/tool-contract";
import { createLogger } from "@diligent/logging";
import { PLAN_MODE_DISALLOWED_TOOLS } from "../agent/mode";
import type { ResolvedAgentDefinition } from "../agent/resolved-agent";
import { resolveAgentDefinition } from "../agent/resolved-agent";
import { RuntimeAgent } from "../agent/runtime-agent";
import { createLocalImageLoader, toolOutputStore } from "../infrastructure";
import { SessionManager } from "../session/manager";
import { isSafeSessionId } from "../session/types";
import { buildDefaultTools } from "../tools/defaults";
import { COLLAB_TOOL_NAMES } from "../tools/tool-metadata";
import { NicknamePool } from "./nicknames";
import type { AgentEntry, AgentStatus, CollabAgentEvent, CollabResumePolicy, CollabToolDeps } from "./types";
import { isFinal } from "./types";

const logger = createLogger({ scope: "runtime.collab" });

type CollabStatusString = "pending" | "running" | "completed" | "errored" | "shutdown";

function toCollabStatus(s: AgentStatus): CollabStatusString {
  return s.kind;
}

function statusMessage(s: AgentStatus): string | undefined {
  if (s.kind === "completed") return s.output ?? undefined;
  if (s.kind === "errored") return s.error;
  return undefined;
}

/** Tool names that belong to the collab layer — excluded from child agents. */
export { COLLAB_TOOL_NAMES };

/**
 * Resolves which tools a child agent is allowed to use, given the parent tool set,
 * spawn parameters, and agent definition policy.
 *
 * Three concerns handled separately:
 * 1. Which non-collab tools survive (intersection of parent tools, agent definition, and per-spawn allowlists).
 * 2. Whether collab tools should be re-created for the child (signalled by nestedCollabEnabled).
 *    Collab tools are unconditionally excluded from childTools even when nestedCollabEnabled=true because
 *    child agents need *fresh* collab tools bound to their own registry — inheriting parent collab tools
 *    would give them stale references pointing to the parent's registry. buildDefaultTools re-creates them.
 * 3. The allowedChildToolNames set is also used as a post-buildDefaultTools filter (caller's responsibility)
 *    so that freshly-created collab tools survive only when nestedCollabEnabled=true.
 */
export function resolveChildToolAccess(
  parentTools: Tool[],
  params: { allowNestedAgents?: boolean; allowedTools?: string[] },
  agentDefinition: ResolvedAgentDefinition,
): { childTools: Tool[]; nestedCollabEnabled: boolean; allowedChildToolNames: Set<string> } {
  let allowedChildToolNames = new Set(parentTools.map((tool) => tool.name));
  const agentAllowedTools = agentDefinition.allowedTools?.length ? agentDefinition.allowedTools : undefined;
  const spawnAllowedTools = params.allowedTools?.length ? params.allowedTools : undefined;

  if (!params.allowNestedAgents) {
    allowedChildToolNames = new Set([...allowedChildToolNames].filter((toolName) => !COLLAB_TOOL_NAMES.has(toolName)));
  }
  if (agentDefinition.readonly) {
    allowedChildToolNames = new Set(
      [...allowedChildToolNames].filter((toolName) => !PLAN_MODE_DISALLOWED_TOOLS.has(toolName)),
    );
  }
  if (agentAllowedTools) {
    const allowedSet = new Set(agentAllowedTools);
    allowedChildToolNames = new Set([...allowedChildToolNames].filter((toolName) => allowedSet.has(toolName)));
  }
  if (spawnAllowedTools) {
    const allowedSet = new Set(spawnAllowedTools);
    allowedChildToolNames = new Set([...allowedChildToolNames].filter((toolName) => allowedSet.has(toolName)));
  }

  // Collab tools are always excluded here — child agents receive fresh collab tools from buildDefaultTools
  // when nestedCollabEnabled=true (bound to the child's own registry, not the parent's).
  const childTools = parentTools.filter(
    (tool) => !COLLAB_TOOL_NAMES.has(tool.name) && allowedChildToolNames.has(tool.name),
  );
  const nestedCollabEnabled = [...allowedChildToolNames].some((toolName) => COLLAB_TOOL_NAMES.has(toolName));

  return { childTools, nestedCollabEnabled, allowedChildToolNames };
}

function formatToolList(toolNames: Iterable<string>): string {
  const names = [...toolNames];
  return names.length > 0 ? names.join(", ") : "(none)";
}

function formatMaybeAllowList(toolNames: string[] | undefined): string {
  if (!toolNames || toolNames.length === 0) return "(inherit all)";
  return toolNames.join(", ");
}

function buildZeroToolDiagnostics(
  parentTools: Tool[],
  params: { allowNestedAgents?: boolean; allowedTools?: string[] },
  agentDefinition: ResolvedAgentDefinition,
): string {
  const lines = [
    `Parent tools: [${formatToolList(parentTools.map((tool) => tool.name))}].`,
    `Agent definition: name=${agentDefinition.name}, readonly=${agentDefinition.readonly}, allowedTools=[${formatMaybeAllowList(agentDefinition.allowedTools)}].`,
    `Spawn params: allowNestedAgents=${params.allowNestedAgents === true}, allowedTools=[${formatMaybeAllowList(params.allowedTools)}].`,
  ];
  const agentAllowedTools = agentDefinition.allowedTools?.length ? agentDefinition.allowedTools : undefined;
  const spawnAllowedTools = params.allowedTools?.length ? params.allowedTools : undefined;

  let current = new Set(parentTools.map((tool) => tool.name));
  const recordStep = (label: string, next: Set<string>) => {
    const removed = [...current].filter((toolName) => !next.has(toolName));
    lines.push(`${label}: kept [${formatToolList(next)}], removed [${formatToolList(removed)}].`);
    current = next;
  };

  if (!params.allowNestedAgents) {
    recordStep(
      "after nested-collab exclusion",
      new Set([...current].filter((toolName) => !COLLAB_TOOL_NAMES.has(toolName))),
    );
  }
  if (agentDefinition.readonly) {
    recordStep(
      "after readonly/plan disallowed exclusion",
      new Set([...current].filter((toolName) => !PLAN_MODE_DISALLOWED_TOOLS.has(toolName))),
    );
  }
  if (agentAllowedTools) {
    const allowedSet = new Set(agentAllowedTools);
    recordStep(
      "after agent allowedTools allow-list",
      new Set([...current].filter((toolName) => allowedSet.has(toolName))),
    );
  }
  if (spawnAllowedTools) {
    const allowedSet = new Set(spawnAllowedTools);
    recordStep(
      "after spawn allowedTools allow-list",
      new Set([...current].filter((toolName) => allowedSet.has(toolName))),
    );
  }

  const finalChildTools = parentTools
    .map((tool) => tool.name)
    .filter((toolName) => !COLLAB_TOOL_NAMES.has(toolName) && current.has(toolName));
  lines.push(`final childTools after collab inheritance exclusion: [${formatToolList(finalChildTools)}].`);
  return lines.join(" ");
}

/** Subset of CollabToolDeps that can safely be mutated between turns (excludes structural fields). */
export type MutableCollabDeps = Omit<CollabToolDeps, "cwd" | "paths" | "maxAgents" | "depth" | "sessionManagerFactory">;

export class AgentRegistry {
  private agents = new Map<string, AgentEntry>();
  private pool = new NicknamePool();
  private maxAgents: number;
  private depth: number;
  private collabEventHandler?: (event: CollabAgentEvent) => void;

  constructor(private deps: CollabToolDeps) {
    this.maxAgents = deps.maxAgents ?? 8;
    this.depth = deps.depth ?? 3;
    this.collabEventHandler = deps.onCollabEvent;
  }

  /**
   * Update the mutable fields of CollabToolDeps in-place.
   * Called at the start of each turn when the registry is reused across turns.
   * Does NOT touch structural fields (cwd, paths, maxAgents, sessionManagerFactory).
   */
  updateDeps(next: MutableCollabDeps): void {
    this.deps = {
      ...this.deps,
      model: next.model,
      effort: next.effort,
      agentDefinitions: next.agentDefinitions,
      parentTools: next.parentTools,
      getParentSessionId: next.getParentSessionId,
      approve: next.approve,
      ask: next.ask,
      streamFn: next.streamFn,
      onCollabEvent: next.onCollabEvent,
      onChildStop: next.onChildStop,
      userId: next.userId,
      agentLoopHookFactories: next.agentLoopHookFactories,
    };
    // Sync the collab event handler if it was updated
    if (next.onCollabEvent !== undefined) {
      this.collabEventHandler = next.onCollabEvent;
    }
  }

  /** Set or replace the collab event handler. Used by SessionManager to wire events into the active stream. */
  setCollabEventHandler(handler: ((event: CollabAgentEvent) => void) | undefined): void {
    this.collabEventHandler = handler;
  }

  private emit(event: CollabAgentEvent): void {
    this.collabEventHandler?.(event);
  }

  /**
   * Spawn a new sub-agent in the background.
   * Synchronous — returns immediately with {threadId, nickname}.
   */
  spawn(params: {
    prompt: string;
    description: string;
    agentType?: string;
    resumeId?: string;
    allowNestedAgents?: boolean;
    modelClass?: ModelClass;
    allowedTools?: string[];
  }): {
    threadId: string;
    nickname: string;
  } {
    if (this.depth <= 0) {
      throw new Error("Max agent nesting depth reached. Cannot spawn further child agents.");
    }

    const activeCount = [...this.agents.values()].filter((e) => !isFinal(e.status)).length;
    if (activeCount >= this.maxAgents) {
      throw new Error(`Max active agents reached (${this.maxAgents}). Close some agents first.`);
    }

    if (params.resumeId && !isSafeSessionId(params.resumeId)) {
      throw new Error(`Invalid resume target: ${params.resumeId}`);
    }
    const restoredEntry = params.resumeId ? this.agents.get(params.resumeId) : undefined;
    if (params.resumeId && !restoredEntry) {
      throw new Error(`Unknown resume target: ${params.resumeId}`);
    }
    if (restoredEntry && !isFinal(restoredEntry.status)) {
      throw new Error(`Cannot resume active agent: ${params.resumeId}`);
    }
    const restoredPolicy = restoredEntry?.resumePolicy;
    if (restoredPolicy) assertCompatibleResumePolicy(params, restoredPolicy);
    const agentType = restoredPolicy?.agentType ?? params.agentType ?? "general";
    const agentDefinition = resolveAgentDefinition(this.deps.agentDefinitions, agentType);
    if (!agentDefinition) {
      throw new Error(`Unknown or unavailable agent type: ${agentType}`);
    }
    const nickname = restoredEntry?.nickname ?? this.pool.reserve();
    const abortController = new AbortController();

    const parentModel = resolveModel(this.deps.model);
    const targetClass: ModelClass =
      restoredPolicy?.modelClass ??
      params.modelClass ??
      agentDefinition.defaultModelClass ??
      getModelClass(parentModel);
    const effectiveAllowedTools = normalizeToolAllowlist(restoredPolicy?.allowedTools ?? params.allowedTools);
    const effectivePolicy: CollabResumePolicy = {
      agentType,
      modelClass: targetClass,
      ...(effectiveAllowedTools ? { allowedTools: effectiveAllowedTools } : {}),
      allowNestedAgents: restoredPolicy?.allowNestedAgents ?? params.allowNestedAgents === true,
    };
    const accessParams = {
      allowNestedAgents: effectivePolicy.allowNestedAgents,
      allowedTools: effectivePolicy.allowedTools,
    };

    // Build child tool list
    const { childTools, nestedCollabEnabled, allowedChildToolNames } = resolveChildToolAccess(
      this.deps.parentTools,
      accessParams,
      agentDefinition,
    );

    if (childTools.length === 0 && !nestedCollabEnabled) {
      logger.warn("agent_spawned_without_tools", {
        message:
          `[collab] Spawning agent '${agentType}' with zero tools after filtering. ` +
          buildZeroToolDiagnostics(this.deps.parentTools, accessParams, agentDefinition),
        sessionId: this.deps.getParentSessionId?.(),
        fields: { agentType },
      });
    }

    const nestedAgentPolicy = effectivePolicy.allowNestedAgents
      ? "Nested sub-agent tools were explicitly enabled for this run. Use them only if the parent instruction clearly requires further delegation; otherwise do the work yourself."
      : "Nested sub-agent delegation is disabled for this run. Do not call spawn_agent, wait, send_input, or close_agent, and do not attempt to coordinate additional sub-agents.";
    const childSystemPrompt = [
      ...(agentDefinition.systemPromptPrefix
        ? [{ label: "agent_role", content: agentDefinition.systemPromptPrefix }]
        : []),
      {
        label: "runtime_context",
        content: `Current working directory: ${this.deps.cwd}`,
      },
      {
        label: "nested_subagent_policy",
        content: nestedAgentPolicy,
      },
    ];

    // Resume uses the original model class; a new child uses the requested or role-default class.
    const childModel = resolveModelForClass(parentModel, targetClass);
    const useClassDefaultEffort =
      restoredPolicy !== undefined ||
      params.modelClass !== undefined ||
      agentDefinition.defaultModelClass !== undefined;
    const childEffort = resolveChildEffort(this.deps.effort, targetClass, childModel, useClassDefaultEffort);

    const factory = this.deps.sessionManagerFactory ?? ((cfg) => new SessionManager(cfg));

    // Wire onChildStop as onStop for the child manager.
    // The `let childManager` binding is valid because onStop is only called
    // after the manager has been fully constructed and run() completes.
    const onChildStop = this.deps.onChildStop;
    let childManager: SessionManager;

    const childManagerConfig: Parameters<typeof factory>[0] = {
      cwd: this.deps.cwd,
      paths: this.deps.paths,
      onStop: onChildStop
        ? (context) =>
            onChildStop({
              sessionId: childManager.sessionId,
              sessionPath: childManager.sessionPath ?? "",
              cwd: this.deps.cwd,
              model: childModel,
              provider: childModel.provider,
              effort: childEffort,
              userId: this.deps.userId,
              context,
            })
        : undefined,
      agent: async (): Promise<RuntimeAgent> => {
        const childAsk = this.deps.ask
          ? (request: import("../tools/user-input-types").UserInputRequest) =>
              this.deps.ask!({
                ...request,
                source: { threadId: childManager.sessionId, nickname },
              })
          : undefined;

        const childDeps = { ...this.deps, parentTools: childTools, ask: childAsk, depth: this.depth - 1 };
        const result = await buildDefaultTools({
          cwd: this.deps.cwd,
          paths: this.deps.paths,
          collabDeps: nestedCollabEnabled ? childDeps : undefined,
          parentToolOverride: childTools,
          enableCollabTools: nestedCollabEnabled,
          host: {
            approve: this.deps.approve,
            ask: childAsk,
          },
        });

        const filteredTools = result.tools.filter((tool) => allowedChildToolNames.has(tool.name));
        const loopHooks =
          this.deps.agentLoopHookFactories?.flatMap((createHooks) =>
            createHooks({
              cwd: this.deps.cwd,
              agentKind: "child",
              model: childModel,
              tools: filteredTools,
              parentSessionId: this.deps.getParentSessionId?.(),
              logger: logger.child({ scope: "runtime.collab.agent-loop-hooks" }),
            }),
          ) ?? [];

        return new RuntimeAgent(
          childModel,
          childSystemPrompt,
          filteredTools,
          {
            effort: childEffort,
            llmMsgStreamFn: this.deps.streamFn,
            localImageLoader: createLocalImageLoader(this.deps.cwd),
            toolOutputStore: this.deps.toolOutputStore ?? toolOutputStore,
            loopHooks,
          },
          result.registry,
        );
      },
      parentSession: this.deps.getParentSessionId?.(),
      collabMeta: {
        nickname,
        description: params.description || undefined,
      },
      sessionId: params.resumeId,
    };

    childManager = factory(childManagerConfig);

    // Use child sessionId as the canonical threadId
    const threadId = params.resumeId ?? childManager.sessionId;
    const callId = threadId;

    this.emit({
      type: "collab_spawn_begin",
      callId,
      prompt: params.prompt,
      agentType,
    });

    const entry: AgentEntry = {
      threadId,
      nickname,
      agentType,
      description: params.description,
      sessionManager: childManager,
      promise: Promise.resolve({ kind: "pending" as const }), // replaced below
      status: { kind: "pending" },
      abortController,
      createdAt: Date.now(),
      resumePolicy: effectivePolicy,
    };

    // Background promise — always resolves, never rejects
    const emitSpawnEnd = (status: CollabStatusString, message?: string): void => {
      this.emit({
        type: "collab_spawn_end",
        callId,
        childThreadId: threadId,
        nickname,
        agentType,
        description: params.description || undefined,
        prompt: params.prompt,
        status,
        message,
      });
    };

    const promise = (async (): Promise<AgentStatus> => {
      entry.status = { kind: "running" };

      // Create or resume session
      if (params.resumeId) {
        const resumed = await childManager.resume({ sessionId: params.resumeId });
        if (!resumed) {
          throw new Error(`Unable to resume agent session: ${params.resumeId}`);
        }
      } else {
        await childManager.create();
      }

      const userMessage = {
        role: "user" as const,
        content: params.prompt,
        timestamp: Date.now(),
      };

      let output: string | null = null;
      let turnNumber = 0;
      let fatalError: string | null = null;

      const unsub = childManager.subscribe((event) => {
        if (event.type === "turn_start") {
          turnNumber++;
          this.emit({
            type: "turn_start",
            turnId: event.turnId,
            childThreadId: threadId,
            nickname,
            turnNumber,
          });
        } else if (event.type === "message_start") {
          this.emit({ ...event, childThreadId: threadId, nickname });
        } else if (event.type === "message_discarded") {
          this.emit({ ...event, childThreadId: threadId, nickname });
        } else if (event.type === "message_delta") {
          this.emit({ ...event, childThreadId: threadId, nickname });
        } else if (event.type === "tool_start") {
          this.emit({ ...event, childThreadId: threadId, nickname });
        } else if (event.type === "tool_update") {
          this.emit({ ...event, childThreadId: threadId, nickname });
        } else if (event.type === "tool_end") {
          this.emit({ ...event, childThreadId: threadId, nickname });
        } else if (event.type === "message_end") {
          this.emit({ ...event, childThreadId: threadId, nickname });
          const textBlocks = event.message.content.filter((b): b is TextBlock => b.type === "text");
          output = textBlocks.map((b) => b.text).join("\n") || null;
        } else if (event.type === "error" && event.fatal) {
          fatalError = event.error.message;
        }
      });

      try {
        await childManager.run(userMessage, { signal: abortController.signal });
      } catch (err) {
        fatalError = err instanceof Error ? err.message : String(err);
      } finally {
        unsub();
      }

      if (fatalError !== null) {
        await childManager.waitForWrites();
        const status: AgentStatus = { kind: "errored", error: fatalError };
        entry.status = status;
        emitSpawnEnd("errored", fatalError);
        return status;
      }

      await childManager.waitForWrites();
      const status: AgentStatus = { kind: "completed", output };
      entry.status = status;
      emitSpawnEnd("completed", statusMessage(status));
      return status;
    })().catch((err: unknown): AgentStatus => {
      const message = err instanceof Error ? err.message : String(err);
      const status: AgentStatus = { kind: "errored", error: message };
      entry.status = status;
      emitSpawnEnd("errored", message);
      return status;
    });

    entry.promise = promise;
    this.agents.set(threadId, entry);

    emitSpawnEnd("running");

    return { threadId, nickname };
  }

  /**
   * Wait for one or more agents to reach a final state.
   * Returns once all requested ids are final (or timeout/abort fires).
   * onUpdate is called with a status summary string on each change.
   */
  async wait(
    ids: string[],
    timeoutMs: number,
    onUpdate?: (s: string) => void,
    signal?: AbortSignal,
  ): Promise<{ status: Record<string, AgentStatus>; timedOut: boolean }> {
    const unknownIds = ids.filter((id) => !this.agents.has(id));
    if (unknownIds.length > 0) {
      throw new Error(`Unknown agent IDs: ${unknownIds.join(", ")}`);
    }

    const waitCallId = `wait-${Date.now()}`;
    this.emit({
      type: "collab_wait_begin",
      callId: waitCallId,
      agents: ids.map((id) => {
        const entry = this.agents.get(id)!;
        return { threadId: id, nickname: entry.nickname, description: entry.description || undefined };
      }),
    });

    const pending: AgentEntry[] = [];

    for (const id of ids) {
      const entry = this.agents.get(id)!;
      if (!isFinal(entry.status)) pending.push(entry);
    }

    const snapshotStatuses = (): Record<string, AgentStatus> =>
      Object.fromEntries(ids.map((id) => [id, this.agents.get(id)!.status]));

    const emitWaitEnd = (statuses: Record<string, AgentStatus>, timedOut: boolean): void => {
      this.emit({
        type: "collab_wait_end",
        callId: waitCallId,
        agentStatuses: ids.map((id) => {
          const entry = this.agents.get(id)!;
          const status = statuses[id] ?? entry.status;
          return {
            threadId: id,
            nickname: entry.nickname,
            status: toCollabStatus(status),
            message: statusMessage(status),
          };
        }),
        timedOut,
      });
    };

    if (pending.length === 0) {
      const result = snapshotStatuses();
      emitWaitEnd(result, false);
      return { status: result, timedOut: false };
    }

    // Wait for the first batch of pending to finish or timeout
    const statusSummary = () => {
      const parts = ids.map((id) => {
        const e = this.agents.get(id)!;
        const done = isFinal(e.status);
        return `${e.nickname} ${done ? "✓" : e.status.kind}`;
      });
      return parts.join(" | ");
    };

    let timedOut = false;
    let terminal = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;

    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (!terminal) {
          timedOut = true;
          resolve();
        }
      }, timeoutMs);
    });

    const racers = pending.map((entry) =>
      entry.promise.then(() => {
        if (!terminal) onUpdate?.(statusSummary());
      }),
    );

    const abortPromise = signal
      ? new Promise<void>((resolve) => {
          if (signal.aborted) {
            timedOut = true;
            resolve();
            return;
          }
          abortHandler = () => {
            if (!terminal) {
              timedOut = true;
              resolve();
            }
          };
          signal.addEventListener("abort", abortHandler, { once: true });
        })
      : new Promise<void>(() => {}); // never resolves

    try {
      await Promise.race([Promise.all(racers), timeoutPromise, abortPromise]);
    } finally {
      terminal = true;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
    }

    // Snapshot once in requested-id order. The returned object is never mutated by late child completion.
    const result = snapshotStatuses();

    emitWaitEnd(result, timedOut);

    return { status: result, timedOut };
  }

  /** Send a steering message to a running agent. */
  async sendInput(threadId: string, message: string): Promise<void> {
    const entry = this.agents.get(threadId);
    if (!entry) throw new Error(`Unknown agent: ${threadId}`);
    if (isFinal(entry.status)) throw new Error(`Agent ${entry.nickname} is not running (${entry.status.kind})`);

    const callId = `interaction-${threadId}-${Date.now()}`;
    this.emit({
      type: "collab_interaction_begin",
      callId,
      receiverThreadId: threadId,
      receiverNickname: entry.nickname,
      prompt: message,
    });

    entry.sessionManager.steer(message);

    this.emit({
      type: "collab_interaction_end",
      callId,
      receiverThreadId: threadId,
      receiverNickname: entry.nickname,
      prompt: message,
      status: toCollabStatus(entry.status),
    });
  }

  /** Abort an agent and wait for it to settle. Returns final status. */
  async close(threadId: string): Promise<AgentStatus> {
    const entry = this.agents.get(threadId);
    if (!entry) throw new Error(`Unknown agent: ${threadId}`);

    const closeCallId = `close-${threadId}`;
    this.emit({
      type: "collab_close_begin",
      callId: closeCallId,
      childThreadId: threadId,
      nickname: entry.nickname,
    });

    if (!isFinal(entry.status)) {
      entry.abortController.abort();
    }

    const finalStatus = await entry.promise;
    entry.status = { kind: "shutdown" };

    this.emit({
      type: "collab_close_end",
      callId: closeCallId,
      childThreadId: threadId,
      nickname: entry.nickname,
      status: toCollabStatus(finalStatus),
      message: statusMessage(finalStatus),
    });

    return finalStatus;
  }

  getStatus(threadId: string): AgentStatus {
    const entry = this.agents.get(threadId);
    if (!entry) throw new Error(`Unknown agent: ${threadId}`);
    return entry.status;
  }

  getNickname(threadId: string): string | undefined {
    return this.agents.get(threadId)?.nickname;
  }

  getKnownAgents(): Array<{ threadId: string; nickname: string; description: string; status: AgentStatus }> {
    return [...this.agents.values()].map((entry) => ({
      threadId: entry.threadId,
      nickname: entry.nickname,
      description: entry.description,
      status: entry.status,
    }));
  }

  /**
   * Restore a previously-known agent as shutdown.
   * Used on session resume to re-populate the in-memory registry
   * so that thread IDs from a prior server lifetime remain valid.
   */
  restoreAgent(
    threadId: string,
    nickname: string,
    policy?: Omit<CollabResumePolicy, "modelClass"> & { modelClass?: ModelClass },
  ): void {
    if (this.agents.has(threadId)) return; // already known
    const agentDefinition = policy ? resolveAgentDefinition(this.deps.agentDefinitions, policy.agentType) : undefined;
    const parentModel = resolveModel(this.deps.model);
    const normalizedPolicyAllowedTools = normalizeToolAllowlist(policy?.allowedTools);
    const resumePolicy = policy
      ? {
          ...policy,
          modelClass: policy.modelClass ?? agentDefinition?.defaultModelClass ?? getModelClass(parentModel),
          ...(normalizedPolicyAllowedTools ? { allowedTools: normalizedPolicyAllowedTools } : {}),
        }
      : undefined;
    this.agents.set(threadId, {
      threadId,
      nickname,
      agentType: "unknown",
      description: "",
      sessionManager: null as unknown as import("../session/manager").SessionManager,
      promise: Promise.resolve({ kind: "shutdown" as const }),
      status: { kind: "shutdown" },
      abortController: new AbortController(),
      createdAt: 0,
      ...(resumePolicy && { resumePolicy }),
    });
  }

  /** Abort all agents and wait for them all to settle. */
  async shutdownAll(): Promise<void> {
    const entries = [...this.agents.values()];
    for (const entry of entries) {
      if (!isFinal(entry.status)) {
        entry.abortController.abort();
      }
    }
    await Promise.allSettled(entries.map((e) => e.promise));
    this.agents.clear();
  }
}

function assertCompatibleResumePolicy(
  params: {
    agentType?: string;
    allowNestedAgents?: boolean;
    modelClass?: ModelClass;
    allowedTools?: string[];
  },
  policy: CollabResumePolicy,
): void {
  const requestedAllowedTools = normalizeToolAllowlist(params.allowedTools);
  const persistedAllowedTools = normalizeToolAllowlist(policy.allowedTools);
  const sameAllowedTools =
    params.allowedTools === undefined ||
    JSON.stringify(requestedAllowedTools ?? []) === JSON.stringify(persistedAllowedTools ?? []);
  if (
    (params.agentType !== undefined && params.agentType !== policy.agentType) ||
    (params.modelClass !== undefined && params.modelClass !== policy.modelClass) ||
    (params.allowNestedAgents !== undefined && params.allowNestedAgents !== policy.allowNestedAgents) ||
    !sameAllowedTools
  ) {
    throw new Error("Cannot resume child with policy different from its immutable policy.");
  }
}

function normalizeToolAllowlist(tools: string[] | undefined): string[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const normalized = [...new Set(tools)].sort();
  return normalized.length > 0 ? normalized : undefined;
}

function defaultEffortForModelClass(modelClass: ModelClass): ThinkingEffort {
  if (modelClass === "lite") return "low";
  if (modelClass === "pro") return "high";
  return "medium";
}

function resolveChildEffort(
  parentEffort: ThinkingEffort,
  modelClass: ModelClass,
  childModel: ReturnType<typeof resolveModelForClass>,
  useClassDefaultEffort: boolean,
): ThinkingEffort {
  if (useClassDefaultEffort) {
    const defaultEffort = defaultEffortForModelClass(modelClass);
    if (supportsThinkingEffort(childModel, defaultEffort)) {
      return defaultEffort;
    }
  }
  if (!childModel.supportsThinking) {
    return parentEffort;
  }
  if (supportsThinkingEffort(childModel, parentEffort)) {
    return parentEffort;
  }
  return childModel.supportedEfforts?.[0] ?? "medium";
}
