// @summary AgentRegistry — spawn/wait/send_input/close lifecycle for non-blocking multi-agent collab

import type { ModelClass } from "@diligent/core/llm/models";
import { agentTypeToModelClass, resolveModel, resolveModelForClass } from "@diligent/core/llm/models";
import type { SystemSection, ThinkingEffort } from "@diligent/core/llm/types";
import type { Tool } from "@diligent/core/tool/types";
import type { TextBlock } from "@diligent/core/types";
import { PLAN_MODE_DISALLOWED_TOOLS } from "../agent/mode";
import type { ResolvedAgentDefinition } from "../agent/resolved-agent";
import { resolveAgentDefinition } from "../agent/resolved-agent";
import { RuntimeAgent } from "../agent/runtime-agent";
import { SessionManager } from "../session/manager";
import { buildDefaultTools } from "../tools/defaults";
import { COLLAB_TOOL_NAMES } from "../tools/tool-metadata";
import { NicknamePool } from "./nicknames";
import type { AgentEntry, AgentStatus, CollabAgentEvent, CollabToolDeps } from "./types";
import { isFinal } from "./types";

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

/** Parameters accepted by AgentRegistry.spawn(). */
export type SpawnParams = {
  prompt: string;
  description: string;
  agentType: string;
  resumeId?: string;
  allowNestedAgents?: boolean;
  modelClass?: ModelClass;
  allowedTools?: string[];
};

/** Build the system-prompt sections injected into every child agent. */
export function buildChildSystemPrompt(
  params: Pick<SpawnParams, "allowNestedAgents">,
  agentDefinition: ResolvedAgentDefinition,
  cwd: string,
): SystemSection[] {
  const nestedAgentPolicy = params.allowNestedAgents
    ? "Nested sub-agent tools were explicitly enabled for this run. Use them only if the parent instruction clearly requires further delegation; otherwise do the work yourself."
    : "Nested sub-agent delegation is disabled for this run. Do not call spawn_agent, wait, send_input, or close_agent, and do not attempt to coordinate additional sub-agents.";
  return [
    ...(agentDefinition.systemPromptPrefix
      ? [{ label: "agent_role", content: agentDefinition.systemPromptPrefix }]
      : []),
    { label: "runtime_context", content: `Current working directory: ${cwd}` },
    { label: "nested_subagent_policy", content: nestedAgentPolicy },
  ];
}

/** Resolved model and effort for a spawned child agent. */
export type ResolvedSpawnModel = {
  childModel: ReturnType<typeof resolveModelForClass>;
  childEffort: ThinkingEffort;
  targetClass: ModelClass;
};

/** Resolve the effective model and effort for a spawned child agent. */
export function resolveSpawnModel(
  deps: Pick<CollabToolDeps, "modelId" | "effort">,
  params: Pick<SpawnParams, "modelClass" | "agentType">,
  agentDefinition: ResolvedAgentDefinition,
): ResolvedSpawnModel {
  const parentModel = resolveModel(deps.modelId);
  const targetClass: ModelClass =
    params.modelClass ?? agentDefinition.defaultModelClass ?? agentTypeToModelClass(params.agentType, parentModel);
  const childModel = resolveModelForClass(parentModel, targetClass);
  const useClassDefaultEffort = params.modelClass !== undefined || agentDefinition.defaultModelClass !== undefined;
  const childEffort = resolveChildEffort(deps.effort, targetClass, childModel, useClassDefaultEffort);
  return { childModel, childEffort, targetClass };
}

type SpawnedManagerArgs = {
  deps: CollabToolDeps;
  description: string;
  childTools: Tool[];
  nestedCollabEnabled: boolean;
  allowedChildToolNames: Set<string>;
  childModel: ResolvedSpawnModel["childModel"];
  childEffort: ThinkingEffort;
  childSystemPrompt: SystemSection[];
  nickname: string;
  depth: number;
};

/**
 * Create the SessionManager for a spawned child agent.
 * Handles the internal forward-reference between onStop/agent() callbacks and the manager instance.
 */
function createSpawnedSessionManager(args: SpawnedManagerArgs): { childManager: SessionManager; threadId: string } {
  const {
    deps,
    description,
    childTools,
    nestedCollabEnabled,
    allowedChildToolNames,
    childModel,
    childEffort,
    childSystemPrompt,
    nickname,
    depth,
  } = args;
  const factory = deps.sessionManagerFactory ?? ((cfg) => new SessionManager(cfg));
  const onChildStop = deps.onChildStop;
  // `childManager` is set immediately after factory() returns, before any async callbacks fire.
  let childManager: SessionManager;
  const config: Parameters<typeof factory>[0] = {
    cwd: deps.cwd,
    paths: deps.paths,
    onStop: onChildStop
      ? (context, isRerun) =>
          onChildStop({
            sessionId: childManager.sessionId,
            sessionPath: childManager.sessionPath ?? "",
            cwd: deps.cwd,
            model: childModel.id,
            provider: childModel.provider,
            effort: childEffort,
            userId: deps.userId,
            context,
            isRerun,
          })
      : undefined,
    agent: async (): Promise<RuntimeAgent> => {
      const childAsk = deps.ask
        ? (request: import("../tools/user-input-types").UserInputRequest) =>
            deps.ask!({ ...request, source: { threadId: childManager.sessionId, nickname } })
        : undefined;
      const childDeps = { ...deps, parentTools: childTools, ask: childAsk, depth: depth - 1 };
      const result = await buildDefaultTools({
        cwd: deps.cwd,
        paths: deps.paths,
        collabDeps: nestedCollabEnabled ? childDeps : undefined,
        parentToolOverride: childTools,
        enableCollabTools: nestedCollabEnabled,
        host: { approve: deps.approve, ask: childAsk },
      });
      const filteredTools = result.tools.filter((tool) => allowedChildToolNames.has(tool.name));
      return new RuntimeAgent(
        childModel.id,
        childSystemPrompt,
        filteredTools,
        { cwd: deps.cwd, effort: childEffort, llmMsgStreamFn: deps.streamFn },
        result.registry,
      );
    },
    parentSession: deps.getParentSessionId?.(),
    collabMeta: { nickname, description: description || undefined },
  };
  childManager = factory(config);
  return { childManager, threadId: childManager.sessionId };
}

type RunChildBackgroundArgs = {
  entry: AgentEntry;
  childManager: SessionManager;
  resumeId?: string;
  prompt: string;
  abortController: AbortController;
  emitSpawnEnd: (status: CollabStatusString, message?: string) => void;
  emit: (event: CollabAgentEvent) => void;
  threadId: string;
  nickname: string;
};

/** Run the child agent session in the background. Always resolves — never rejects. */
function runChildBackground(args: RunChildBackgroundArgs): Promise<AgentStatus> {
  const { entry, childManager, resumeId, prompt, abortController, emitSpawnEnd, emit, threadId, nickname } = args;
  return (async (): Promise<AgentStatus> => {
    entry.status = { kind: "running" };
    if (resumeId) {
      const resumed = await childManager.resume({ sessionId: resumeId });
      if (!resumed) await childManager.create();
    } else {
      await childManager.create();
    }
    const userMessage = { role: "user" as const, content: prompt, timestamp: Date.now() };
    let output: string | null = null;
    let turnNumber = 0;
    let fatalError: string | null = null;
    const unsub = childManager.subscribe((event) => {
      if (event.type === "turn_start") {
        turnNumber++;
        emit({ type: "turn_start", turnId: event.turnId, childThreadId: threadId, nickname, turnNumber });
      } else if (event.type === "message_start") {
        emit({ ...event, childThreadId: threadId, nickname });
      } else if (event.type === "message_delta") {
        emit({ ...event, childThreadId: threadId, nickname });
      } else if (event.type === "tool_start") {
        emit({ ...event, childThreadId: threadId, nickname });
      } else if (event.type === "tool_update") {
        emit({ ...event, childThreadId: threadId, nickname });
      } else if (event.type === "tool_end") {
        emit({ ...event, childThreadId: threadId, nickname });
      } else if (event.type === "message_end") {
        emit({ ...event, childThreadId: threadId, nickname });
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
    const message = String(err);
    const status: AgentStatus = { kind: "errored", error: message };
    entry.status = status;
    emitSpawnEnd("errored", message);
    return status;
  });
}

/** Build the initial AgentEntry for a freshly spawned agent. */
function buildSpawnEntry(
  threadId: string,
  nickname: string,
  params: SpawnParams,
  childManager: SessionManager,
  abortController: AbortController,
): AgentEntry {
  return {
    threadId,
    nickname,
    agentType: params.agentType,
    description: params.description,
    sessionManager: childManager,
    promise: Promise.resolve({ kind: "pending" as const }),
    status: { kind: "pending" },
    abortController,
    createdAt: Date.now(),
  };
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
      modelId: next.modelId,
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
  spawn(params: SpawnParams): { threadId: string; nickname: string } {
    if (this.depth <= 0) {
      throw new Error("Max agent nesting depth reached. Cannot spawn further child agents.");
    }
    const activeCount = [...this.agents.values()].filter((e) => !isFinal(e.status)).length;
    if (activeCount >= this.maxAgents) {
      throw new Error(`Max active agents reached (${this.maxAgents}). Close some agents first.`);
    }

    const agentDefinition =
      resolveAgentDefinition(this.deps.agentDefinitions, params.agentType) ??
      resolveAgentDefinition(this.deps.agentDefinitions, "general");
    if (!agentDefinition) {
      throw new Error("Missing built-in general agent definition");
    }
    const nickname = this.pool.reserve();
    const abortController = new AbortController();

    const { childTools, nestedCollabEnabled, allowedChildToolNames } = resolveChildToolAccess(
      this.deps.parentTools,
      params,
      agentDefinition,
    );
    if (childTools.length === 0 && !nestedCollabEnabled) {
      console.warn(
        `[collab] Spawning agent '${params.agentType}' with zero tools after filtering. ` +
          buildZeroToolDiagnostics(this.deps.parentTools, params, agentDefinition),
      );
    }

    const childSystemPrompt = buildChildSystemPrompt(params, agentDefinition, this.deps.cwd);
    const { childModel, childEffort } = resolveSpawnModel(this.deps, params, agentDefinition);
    const { childManager, threadId } = createSpawnedSessionManager({
      deps: this.deps,
      description: params.description,
      childTools,
      nestedCollabEnabled,
      allowedChildToolNames,
      childModel,
      childEffort,
      childSystemPrompt,
      nickname,
      depth: this.depth,
    });

    const callId = threadId;
    this.emit({ type: "collab_spawn_begin", callId, prompt: params.prompt, agentType: params.agentType });

    const entry = buildSpawnEntry(threadId, nickname, params, childManager, abortController);

    const emitSpawnEnd = (status: CollabStatusString, message?: string): void => {
      this.emit({
        type: "collab_spawn_end",
        callId,
        childThreadId: threadId,
        nickname,
        agentType: params.agentType,
        description: params.description || undefined,
        prompt: params.prompt,
        status,
        message,
      });
    };

    entry.promise = runChildBackground({
      entry,
      childManager,
      resumeId: params.resumeId,
      prompt: params.prompt,
      abortController,
      emitSpawnEnd,
      emit: this.emit.bind(this),
      threadId,
      nickname,
    });
    this.agents.set(threadId, entry);
    emitSpawnEnd("running");
    return { threadId, nickname };
  }

  /**
   * Wait for one or more agents to reach a final state.
   * Returns once any of the ids are done (or timeout fires).
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

    const result: Record<string, AgentStatus> = {};
    const pending: AgentEntry[] = [];

    for (const id of ids) {
      const entry = this.agents.get(id)!;
      if (isFinal(entry.status)) {
        result[id] = entry.status;
      } else {
        pending.push(entry);
      }
    }

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
    let resolved = false;

    const timeoutPromise = new Promise<void>((resolve) =>
      setTimeout(() => {
        if (!resolved) {
          timedOut = true;
          resolve();
        }
      }, timeoutMs),
    );

    const racers = pending.map((entry) =>
      entry.promise.then((status) => {
        result[entry.threadId] = status;
        onUpdate?.(statusSummary());
      }),
    );

    const abortPromise = signal
      ? new Promise<void>((resolve) => {
          if (signal.aborted) {
            timedOut = true;
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              if (!resolved) {
                timedOut = true;
                resolve();
              }
            },
            { once: true },
          );
        })
      : new Promise<void>(() => {}); // never resolves

    await Promise.race([Promise.all(racers), timeoutPromise, abortPromise]);
    resolved = true;

    // Collect final statuses — agents are retained (not deleted) for later reference
    for (const id of ids) {
      if (!(id in result)) {
        const entry = this.agents.get(id)!;
        result[id] = entry.status;
      }
    }

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
  restoreAgent(threadId: string, nickname: string): void {
    if (this.agents.has(threadId)) return; // already known
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
    if (childModel.supportsThinking && childModel.supportedEfforts?.includes(defaultEffort)) {
      return defaultEffort;
    }
  }
  if (!childModel.supportsThinking) {
    return parentEffort;
  }
  if (childModel.supportedEfforts?.includes(parentEffort)) {
    return parentEffort;
  }
  return childModel.supportedEfforts?.[0] ?? "medium";
}
