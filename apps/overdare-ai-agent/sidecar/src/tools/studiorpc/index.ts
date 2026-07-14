import type { Tool as CoreTool, ToolContext as CoreToolContext } from "@diligent/core/tool/types";
import type { BundledToolProvider, HookInput, PluginHookFn, RuntimeToolHost } from "@diligent/runtime";
import { call } from "./rpc";
import { methodModules, mutatingMethods, renderBuilders, savingMethods } from "./tool-registry";
import { createCollisionProfileTools } from "./tools/collision-profile-tool";
import { createHubWorldCategoriesListTool } from "./tools/hub-world-categories-list-tool";
import { createHubWorldLookupTool } from "./tools/hub-world-lookup-tool";
import { computeHumanEdits, createHumanEditsTool } from "./tools/human-edits-tool";
import { createInstanceDeleteTool } from "./tools/instance-delete-tool";
import { createInstanceMoveTool } from "./tools/instance-move-tool";
import { createInstanceReadTool } from "./tools/instance-read-tool";
import { createInstanceUpsertTool } from "./tools/instance-upsert-tool";
import { createProceduralRunTool } from "./tools/procedural-run-tool";
import { createRollbackTool } from "./tools/rollback-tool";
import { createScriptAddTool } from "./tools/script-add-tool";
import { createScriptDeleteTool } from "./tools/script-delete-tool";
import { createScriptEditTool } from "./tools/script-edit-tool";
import { createScriptGrepTool } from "./tools/script-grep-tool";
import { createScriptReadTool } from "./tools/script-read-tool";
import { captureBaseline, captureSnapshot, nextRequestIndex, pruneSnapshots, snapshotsDir } from "./tools/snapshot";
import type { Tool, ToolResult } from "./types";
import { createWriteLock } from "./write-lock";

type StudioRpcToolContext = CoreToolContext & {
  approve: NonNullable<RuntimeToolHost["approve"]>;
};

export interface StudioRpcToolProviderOptions {
  callRpc?: typeof call;
}

/** Per-turn rollback-snapshot state shared between the provider hooks and tools. */
interface TurnSnapshotState {
  sessionId: string | undefined;
  taken: boolean;
  /**
   * Human-edit diff frozen at turn start, before any agent edits. The
   * human-edits tool returns this cache so a late call cannot misattribute
   * the agent's own edits to the human.
   */
  humanEdits?: ToolResult;
  /** Truncated user prompt; becomes the snapshot's label (its rollback-point summary). */
  promptLabel?: string;
  /** First capture failure this turn; set so the warning is reported only once. */
  captureError?: string;
}

export function createStudioRpcToolProvider(options: StudioRpcToolProviderOptions = {}): BundledToolProvider {
  const callRpc = options.callRpc ?? call;

  // Shared across the provider's hooks and its tools. The rollback baseline is
  // captured just before the turn's *first map edit* (not at prompt time), so
  // turns that don't edit the map — rollback requests, questions — leave no
  // snapshot and never shadow the real baseline. `taken` enforces once-per-turn.
  const turnState: TurnSnapshotState = { sessionId: undefined, taken: false };

  // Save the editor state to file at turn boundaries, then capture the
  // agent-done baseline so the next turn can diff out human edits.
  const saveLevel: PluginHookFn = async (input: HookInput) => {
    await callRpc("level.save.file", {});
    try {
      captureBaseline(input.cwd);
    } catch {
      // not a Studio project / save not flushed — human-edits tool reports "no baseline"
      // ponytail: stale-baseline window if save RPC fails at Stop; fix when Studio emits real edit events
    }
    return { blocked: false };
  };
  saveLevel.mode = "sync";

  // Start of each user request: save the level and arm a fresh snapshot for the
  // upcoming turn. The actual capture happens lazily on the first edit tool.
  // The save flushes the human's Studio edits to file, so this is the one
  // moment the file holds human edits but no agent edits — freeze the
  // human-edit diff here.
  const beginTurn: PluginHookFn = async (input: HookInput) => {
    await callRpc("level.save.file", {});
    turnState.sessionId = input.session_id;
    turnState.taken = false;
    // Store generously (2000 chars); display sites truncate to 120. Keeping the
    // full text local means no transcript lookups are ever needed.
    turnState.promptLabel = typeof input.prompt === "string" ? input.prompt.slice(0, 2000) : undefined;
    turnState.captureError = undefined;
    turnState.humanEdits = computeHumanEdits(input.cwd);
    // Surface detected human edits without requiring a tool call: the summary
    // is prepended to the user message (LLM context) and the web client splits
    // the <HumanEdits> block out into a visible context card.
    if (turnState.humanEdits.metadata?.humanEditsDetected === true) {
      return {
        blocked: false,
        additionalContext: `<HumanEdits>\n${turnState.humanEdits.output}\n</HumanEdits>`,
      };
    }
    return { blocked: false };
  };
  beginTurn.mode = "sync";

  return {
    id: "@overdare/studiorpc-tools",
    displayName: "OVERDARE Studio RPC Tools",
    supersedesPluginPackages: ["@overdare/plugin-studiorpc"],
    createTools: async ({ cwd, host }) =>
      createCoreTools(await createStudioRpcTools({ cwd, host, callRpc, turnState })),
    onUserPromptSubmit: beginTurn,
    onStop: saveLevel,
  };
}

function toToolName(method: string): string {
  return `studiorpc_${method.replace(/\./g, "_")}`;
}

function withApproval(ctx: CoreToolContext, host?: RuntimeToolHost): StudioRpcToolContext {
  return {
    ...ctx,
    approve: host?.approve ?? (async () => "once" as const),
  };
}

export async function createStudioRpcTools(ctx: {
  cwd: string;
  host?: RuntimeToolHost;
  callRpc?: typeof call;
  turnState?: TurnSnapshotState;
}): Promise<Tool[]> {
  const writeLock = createWriteLock();
  const callRpc = ctx.callRpc ?? call;
  const applyLevelChanges = () => callRpc("level.apply", {});

  // Capture the pre-edit rollback baseline once per turn, lazily on the first
  // map-editing tool. On failure, returns a one-time warning for the wrapping
  // tool to surface — a silently missing baseline would make a later rollback
  // restore an older snapshot than the user expects.
  const ensureSnapshot = (): string | undefined => {
    const ts = ctx.turnState;
    if (!ts || ts.taken || !ts.sessionId) return undefined;
    try {
      const index = nextRequestIndex(snapshotsDir(ctx.cwd), ts.sessionId);
      captureSnapshot(ctx.cwd, ts.sessionId, index, { label: ts.promptLabel, kind: "turn" });
      pruneSnapshots(ctx.cwd, ts.sessionId);
      ts.taken = true;
      return undefined;
    } catch (error) {
      if (ts.captureError) return undefined; // already reported this turn
      ts.captureError = (error as Error).message;
      return (
        `[warning] Rollback baseline could not be captured (${ts.captureError}). ` +
        `studiorpc_rollback would restore an older snapshot; check studiorpc_snapshot_list before rolling back.`
      );
    }
  };
  // Wrap a map-editing tool so it snapshots the baseline before it runs and
  // surfaces a capture failure in its output.
  const withSnapshot = (tool: Tool): Tool => ({
    ...tool,
    execute: async (args, toolCtx) => {
      const warning = ensureSnapshot();
      const result = await tool.execute(args, toolCtx);
      return warning ? { ...result, output: `${warning}\n${result.output}` } : result;
    },
  });
  const isCollisionEdit = (name: string) => name === "create_collision_profile" || name === "edit_collision_profile";

  const tools: Tool[] = [
    wrapTool(createInstanceReadTool(ctx.cwd), ctx.host),
    wrapTool(withSnapshot(createInstanceUpsertTool(ctx.cwd, writeLock)), ctx.host),
    wrapTool(withSnapshot(createProceduralRunTool(ctx.cwd, writeLock)), ctx.host),
    wrapTool(withSnapshot(createInstanceDeleteTool(ctx.cwd, writeLock)), ctx.host),
    wrapTool(withSnapshot(createInstanceMoveTool(ctx.cwd, writeLock)), ctx.host),
    wrapTool(createScriptReadTool(ctx.cwd), ctx.host),
    wrapTool(createScriptGrepTool(ctx.cwd), ctx.host),
    wrapTool(withSnapshot(createScriptAddTool(ctx.cwd, writeLock)), ctx.host),
    wrapTool(withSnapshot(createScriptDeleteTool(ctx.cwd, writeLock)), ctx.host),
    wrapTool(withSnapshot(createScriptEditTool(ctx.cwd, writeLock)), ctx.host),
    ...createCollisionProfileTools(ctx.cwd, writeLock, applyLevelChanges).map((tool) =>
      wrapTool(isCollisionEdit(tool.name) ? withSnapshot(tool) : tool, ctx.host),
    ),
    wrapTool(createRollbackTool(ctx.cwd, callRpc), ctx.host),
    wrapTool(
      createHumanEditsTool(ctx.cwd, () => ctx.turnState?.humanEdits),
      ctx.host,
    ),
    createHubWorldLookupTool(),
    createHubWorldCategoriesListTool(),
  ];

  for (const mod of methodModules) {
    const { method, description, params } = mod;
    const toolName = toToolName(method);
    const capturesBeforeRun = mutatingMethods.has(method);

    tools.push({
      name: toolName,
      description,
      parameters: params,
      async execute(args, toolCtx) {
        const warning = capturesBeforeRun ? ensureSnapshot() : undefined;
        const bundledToolCtx = withApproval(toolCtx, ctx.host);
        const rpcMethod = mod.resolveMethod ? mod.resolveMethod(args as Record<string, unknown>) : method;

        const approval = await bundledToolCtx.approve({
          permission: "execute",
          toolName,
          description: `Studio RPC: ${rpcMethod}`,
          details: { method: rpcMethod, params: args },
        });

        if (approval === "reject") {
          return {
            output: "[Rejected by user]",
            metadata: { error: true, method: rpcMethod },
          };
        }

        const isMutating = mutatingMethods.has(method);
        const release = isMutating ? await writeLock.acquire() : undefined;
        try {
          const normalizedArgs = mod.normalizeArgs
            ? mod.normalizeArgs(args as Record<string, unknown>)
            : (args as Record<string, unknown>);
          let result: unknown = await callRpc(rpcMethod, normalizedArgs, { timeoutMs: mod.timeoutMs });
          if (mod.postProcess) {
            result = mod.postProcess(result, args as Record<string, unknown>);
          }
          // Persist editor-state changes to file immediately on success.
          if (savingMethods.has(method)) {
            await callRpc("level.save.file", {});
          }
          const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          const renderBuilder = renderBuilders[toolName];
          const render = renderBuilder?.({ args: args as Record<string, unknown>, normalizedArgs, output, result });

          return {
            output: warning ? `${warning}\n${output}` : output,
            render,
            metadata: { method: rpcMethod, result },
          };
        } finally {
          release?.();
        }
      },
    });
  }

  return tools;
}

function wrapTool(tool: Tool, host?: RuntimeToolHost): Tool {
  return {
    ...tool,
    execute: (args, toolCtx) => tool.execute(args, withApproval(toolCtx, host)),
  };
}

function createCoreTools(tools: Tool[]): CoreTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: (args, toolCtx) => tool.execute(args as never, withApproval(toolCtx)),
  }));
}
