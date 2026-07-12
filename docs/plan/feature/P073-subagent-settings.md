---
id: P073
status: active
created: 2026-07-12
---

# Configurable Subagent Settings

## Goal

Allow users to enable or disable individual subagent types through `config.jsonc`, including built-in `explore` and all discovered custom agents. The essential built-in `general` subagent remains permanently enabled so delegation always has an execution-capable fallback.

The Web Config modal lists the complete subagent catalog and writes global preferences only. TUI users receive the same resolved runtime behavior after editing config and using the existing `/reload` flow.

## Prerequisites

- Built-in agent definitions and resolved custom agent definitions already feed the collaboration registry and `spawn_agent` tool.
- Filesystem agent discovery already supports project, configured-path, and global sources.
- P072 established layered false-only settings, runtime catalog projection, global-only Web editing, and reload-based cache invalidation.
- `config/reload` rebuilds runtime configuration and clears cached per-thread agents.

## Artifact

With no individual preference, all optional subagents are available and `general` is always present:

```jsonc
{
  "agents": {
    "paths": ["/shared/team-agents"]
  }
}
```

In **Config → Subagents**, the user turns off the built-in `explore` role and a discovered `code-reviewer` agent. Diligent preserves sibling config and writes only explicit global opt-outs:

```jsonc
{
  "agents": {
    "overrides": {
      "code-reviewer": false,
      "explore": false
    }
  }
}
```

On the next turn, `spawn_agent` no longer offers either type. `general` stays available regardless of `agents.overrides.general`; the Web UI renders it as a required built-in rather than a toggle. Re-enabling an optional agent removes its global `false` entry unless a project override still controls its effective state.

## Scope

### What changes

| Area | What Changes |
|------|--------------|
| Runtime config | Add layered `agents.overrides: Record<string, boolean>` for optional built-in and discovered agents |
| Agent assembly | Retain a full subagent catalog while projecting an active resolved-definition list for collaboration |
| Runtime config writer | Persist global false-only agent overrides while preserving JSONC comments and sibling agent settings |
| App server | Add `subagents/list` and `subagents/set`; set reloads config and invalidates cached agents |
| Shared protocol | Define subagent descriptors and thread-aware list/set request and response schemas |
| Web Config modal | Add a Subagents section with optional-role toggles, source/provenance, required-built-in state, and sequential saving |
| TUI behavior | Honor the shared runtime projection through startup and existing manual-config + `/reload` flow |
| Documentation | Document built-in policy, discovery precedence, layering, global-only Web writes, and next-turn semantics |

### What does NOT change

- `general` cannot be disabled in Web, global config, or project config. It is an immutable execution-capable fallback for delegation.
- `agents.enabled` retains its current meaning: it gates discovery of custom filesystem agents; it does not disable built-in roles.
- No Web editing of project config is added. Manual project `agents.overrides` values take precedence and render as read-only.
- No change to agent prompt bodies, `model_class`, declared tool permissions, nested-delegation policy, or per-spawn `allowed_tools` behavior.
- No agent installation, deletion, editing, marketplace, remote discovery, or renaming support.
- No new TUI picker or slash command is added.
- No multi-cwd agent catalog cache is introduced. Settings requests continue to reject a thread cwd that differs from the app-server startup cwd.
- Runtime changes never interrupt an in-flight turn; they apply when a root or child agent is created for the next turn.
- No protocol version negotiation is introduced.

## Configuration Semantics

The public configuration extends the existing `agents` subtree:

```typescript
interface AgentsConfig {
  enabled?: boolean;
  paths?: string[];
  overrides?: Record<string, boolean>;
}
```

Resolution rules:

1. The full catalog contains the required built-in `general`, optional built-in `explore`, and every discovered custom agent that current discovery permits.
2. `agents.enabled ?? true` preserves current behavior by controlling only whether custom agents are discovered. Built-ins remain catalogued.
3. `agents.overrides?.[name] ?? true` controls every optional agent's individual preference.
4. `general` is forcibly effective and available even if a manually edited override says `false`; the management API reports it as `required_builtin` and non-configurable.
5. An optional agent is active when it is in the catalog and its individual resolved override is true.
6. `agents.overrides` uses the normal `global < project` deep merge. A project entry for an optional agent wins over the global fallback, while unrelated global entries remain effective.
7. `RuntimeConfig.discoveredAgents` retains all custom discovery results. `RuntimeConfig.agentDefinitions` becomes the active resolved set consumed by collaboration and `spawn_agent`.
8. The Web writer edits only global optional-agent overrides. It rejects a `subagents/set` payload containing `general` or a key explicitly controlled by the project layer.
9. Writers retain only sorted `false` global entries. Writing `true` removes the global entry.
10. A successful write uses the common reload path, refreshes the active registry definitions, and clears cached root agents. Existing child turns remain untouched.

## File Manifest

### packages/protocol/

| File | Action | Description |
|------|--------|-------------|
| `src/methods.ts` | MODIFY | Add `SUBAGENTS_LIST` and `SUBAGENTS_SET` request methods |
| `src/client-requests.ts` | MODIFY | Add subagent descriptors, states, list/set params, responses, and protocol unions |
| `test/protocol-flow.test.ts` | MODIFY | Round-trip the new list/set request and response schemas |

### packages/runtime/src/config/

| File | Action | Description |
|------|--------|-------------|
| `schema.ts` | MODIFY | Add `agents.overrides` boolean map |
| `writer.ts` | MODIFY | Add JSONC-preserving global agent-override writer with false-only normalization |
| `index.ts` | MODIFY | Export agent config patch and writer APIs |
| `runtime.ts` | MODIFY | Build full and active agent projections while preserving current `agents.enabled` behavior |

### packages/runtime/src/agent/ and agents/

| File | Action | Description |
|------|--------|-------------|
| `agent/agent-types.ts` | MODIFY | Export built-in definition metadata needed to form a deterministic settings catalog |
| `agent/resolved-agent.ts` | MODIFY | Project catalog states into active resolved definitions without duplicating built-in policy |
| `agents/settings.ts` | CREATE | Pure catalog/state resolver for required built-ins, optional built-ins, discovery, and layered overrides |
| `agents/index.ts` | MODIFY | Export settings types and resolver helpers |

### packages/runtime/src/app-server/

| File | Action | Description |
|------|--------|-------------|
| `subagent-handlers.ts` | CREATE | Implement list/set handling and response mapping |
| `server.ts` | MODIFY | Add the runtime-backed subagent settings manager and startup-cwd validation seam |
| `request-dispatcher.ts` | MODIFY | Dispatch `subagents/list` and `subagents/set` |
| `thread-handlers.ts` | MODIFY | Expose thread-aware subagent settings cwd resolution |
| `factory.ts` | MODIFY | Supply catalog manager; on reload refresh catalog, active definitions, registry dependencies, and cached agent inputs |

### packages/runtime/test/

| File | Action | Description |
|------|--------|-------------|
| `config/schema.test.ts` | MODIFY | Validate optional override map and omission compatibility |
| `config/loader.test.ts` | MODIFY | Validate global/project deep merge and provenance for agent overrides |
| `config/writer.test.ts` | MODIFY | Test false-only writes, re-enable cleanup, immutable-general rejection, comments, and invalid-config safety |
| `config/runtime.test.ts` | MODIFY | Test full catalog vs active projection with built-ins, custom agents, and `agents.enabled` |
| `agents/settings.test.ts` | CREATE | Unit-test deterministic resolution, required `general`, precedence, and discovery ordering |
| `app-server/subagent-handlers.test.ts` | CREATE | Test list/set, project-controlled rejection, required built-in rejection, reload, and cache invalidation |
| `app-server/factory.test.ts` | MODIFY | Verify reload updates active definitions and collaboration registry inputs |

### packages/web/src/client/

| File | Action | Description |
|------|--------|-------------|
| `lib/use-thread-data.ts` | MODIFY | Add typed `listSubagents` and `saveSubagents` RPC functions |
| `lib/use-app-state.ts` | MODIFY | Expose subagent settings RPC functions to the app |
| `lib/subagent-settings.ts` | CREATE | Create drafts and global-only set payloads that omit read-only/required entries |
| `components/ToolSettingsModal.tsx` | MODIFY | Add Subagents section and deterministic tools → skills → subagents save flow |
| `App.tsx` | MODIFY | Pass subagent settings callbacks into Config |

### packages/web/test/

| File | Action | Description |
|------|--------|-------------|
| `client/components/components.test.tsx` | MODIFY | Render required built-in, optional built-in, custom, disabled, and project-controlled rows |
| `client/components/tool-settings-interactions.test.tsx` | MODIFY | Test payload omission/rejection safety, sequential three-section saves, and partial failure messaging |

### docs/guide/

| File | Action | Description |
|------|--------|-------------|
| `subagent-settings.md` | CREATE | Document configuration, built-in policy, discovery, precedence, Web, TUI, and reload behavior |

## Implementation Tasks

### Task 1: Add layered optional-subagent overrides and safe persistence

**Files:** `packages/runtime/src/config/schema.ts`, `packages/runtime/src/config/writer.ts`, `packages/runtime/src/config/index.ts`, `packages/runtime/test/config/schema.test.ts`, `packages/runtime/test/config/loader.test.ts`, `packages/runtime/test/config/writer.test.ts`

**Decisions:** D032, D033, D034

Extend the current agents config without changing `enabled` or `paths` semantics:

```typescript
const AgentsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  paths: z.array(z.string()).optional(),
  overrides: z.record(z.string(), z.boolean()).optional(),
});

export interface AgentConfigPatch {
  overrides?: Record<string, boolean>;
}

export async function writeGlobalAgentsConfig(patch: AgentConfigPatch): Promise<WriteAgentsConfigResult>;
```

Mirror P072's writer guarantees: validate existing global JSONC before mutation, patch only `agents.overrides` keys, retain sibling and retained-key comments, normalize deterministic false-only entries, remove empty `overrides`, and preserve `agents.enabled`, `agents.paths`, and unrelated config. The writer is generic, but the app-server handler—not the writer—enforces `general` immutability because manual config must still load predictably.

**Verify:** Global false + project true resolves ON for optional agents; project false wins; global true removes stored false; comments survive; invalid config is byte-for-byte unchanged after a rejected write.

### Task 2: Resolve full and active subagent catalogs

**Files:** `packages/runtime/src/agent/agent-types.ts`, `packages/runtime/src/agent/resolved-agent.ts`, `packages/runtime/src/agents/settings.ts`, `packages/runtime/src/agents/index.ts`, `packages/runtime/src/config/runtime.ts`, `packages/runtime/test/agents/settings.test.ts`, `packages/runtime/test/config/runtime.test.ts`

**Decisions:** D062

Introduce one pure resolver for all settings and runtime code:

```typescript
export type SubagentController = "required" | "default" | "global" | "project";
export type SubagentStateReason = "enabled" | "disabled_by_user" | "required_builtin";

export interface SubagentCatalogEntry {
  definition: ResolvedAgentDefinition;
  source: "builtin" | "global" | "project" | "config";
  required: boolean;
}

export interface ResolvedSubagentState extends SubagentCatalogEntry {
  globalEnabled: boolean;
  effectiveEnabled: boolean;
  available: boolean;
  controlledBy: SubagentController;
  reason: SubagentStateReason;
}

export function resolveSubagentStates(
  catalog: SubagentCatalogEntry[],
  config: DiligentConfig["agents"] | undefined,
  layers: DiligentConfigLayers,
): ResolvedSubagentState[];

export function filterAvailableAgentDefinitions(states: ResolvedSubagentState[]): ResolvedAgentDefinition[];
```

Construct built-ins independently of `agents.enabled`. Continue skipping custom discovery when that legacy master gate is false. Retain the full custom discovery output in `RuntimeConfig.discoveredAgents`; assemble the full catalog from it plus built-ins; feed only `filterAvailableAgentDefinitions()` into `RuntimeConfig.agentDefinitions`. Do not add a second policy check in `spawn_agent`, registry, or rendering layers.

**Verify:** `general` remains active with global/project false; `explore` and custom agents default ON and honor overrides; master false removes custom agents but retains built-ins; stable catalog order is general, explore, then existing discovery precedence.

### Task 3: Define the shared subagent settings protocol

**Files:** `packages/protocol/src/methods.ts`, `packages/protocol/src/client-requests.ts`, `packages/protocol/test/protocol-flow.test.ts`

**Decisions:** D096

Use an explicit `subagents/*` namespace to avoid conflating settings with agent lifecycle events:

```typescript
export const SubagentDescriptorSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(["builtin", "global", "project", "config"]),
  required: z.boolean(),
  globalEnabled: z.boolean(),
  effectiveEnabled: z.boolean(),
  available: z.boolean(),
  controlledBy: z.enum(["required", "default", "global", "project"]),
  reason: z.enum(["enabled", "disabled_by_user", "required_builtin"]),
});

export const SubagentsListParamsSchema = z.object({ threadId: z.string().optional() });
export const SubagentsSetParamsSchema = z.object({
  threadId: z.string().optional(),
  overrides: z.record(z.string(), z.boolean()),
});
```

Return the global config path and `appliesOnNextTurn: true` in both responses, matching P072. Do not add a new protocol version.

**Verify:** Request and response discriminated unions accept valid payloads and reject invalid descriptor states.

### Task 4: Wire settings into app-server reload and collaboration

**Files:** `packages/runtime/src/app-server/subagent-handlers.ts`, `packages/runtime/src/app-server/server.ts`, `packages/runtime/src/app-server/request-dispatcher.ts`, `packages/runtime/src/app-server/thread-handlers.ts`, `packages/runtime/src/app-server/factory.ts`, `packages/runtime/src/collab/registry.ts` (only if its existing mutable dependency API needs a narrowly scoped extension), `packages/runtime/test/app-server/subagent-handlers.test.ts`, `packages/runtime/test/app-server/factory.test.ts`

**Decisions:** D062

Follow P072's startup-cwd guard and manager pattern:

```typescript
export interface SubagentSettingsContext {
  cwd: string;
  config: DiligentConfig["agents"] | undefined;
  layers: DiligentConfigLayers;
  catalog: SubagentCatalogEntry[];
}

export interface SubagentConfigManager {
  resolve: (cwd: string) => Promise<SubagentSettingsContext>;
}
```

`handleSubagentsSet` must resolve the selected thread context; reject unknown catalog names, `general`, and keys explicitly owned by the project layer; write the global patch; invoke the common reload handler; then return refreshed descriptors. Reload must replace the shared runtime's custom discovery snapshot, active agent definitions, and frozen app-server agent-definition/registry inputs before cached root agents are cleared. This ensures root agents rebuilt on their next turn expose the same filtered list as the management response; active child turns are not stopped.

**Verify:** List distinguishes required/global/project/default state; set cannot disable general or mutate project-controlled keys; successful set updates `spawn_agent` definitions after the next build and clears every cached root agent; a startup-cwd mismatch is rejected.

### Task 5: Add Subagents to the Web Config modal

**Files:** `packages/web/src/client/lib/use-thread-data.ts`, `packages/web/src/client/lib/use-app-state.ts`, `packages/web/src/client/lib/subagent-settings.ts`, `packages/web/src/client/components/ToolSettingsModal.tsx`, `packages/web/src/client/App.tsx`, `packages/web/test/client/components/components.test.tsx`, `packages/web/test/client/components/tool-settings-interactions.test.tsx`

Load tools, skills, and subagents together when Config opens. Render **Subagents** after Skills and before Built-in tools. Each row displays source, description, global preference, effective state, and one of:

- **Required built-in** — `general`, checked and disabled;
- **Controlled by project config** — checked/unchecked but disabled;
- editable optional row — `explore` or a discovered custom agent.

Use a dedicated draft helper so only editable changed optional keys are sent. Save mutations strictly in order: tools, skills, then subagents. Keep the modal open after any failure, report which earlier sections persisted, and do not claim an atomic transaction. Since subagent definitions are not slash commands, no additional client catalog state needs replacement after success.

**Verify:** Rows render all controller states; general cannot generate a payload; project-controlled rows cannot generate a payload; explicit modal thread ID is preserved; all three writes are sequential; partial failure messaging is accurate.

### Task 6: Document and validate shared behavior

**Files:** `docs/guide/subagent-settings.md`

**Decisions:** D032, D033, D034, D062, D096

Document the `agents.overrides` shape; default ON/falsy-only persistence; required-general policy; distinction between `agents.enabled` and individual overrides; built-in/custom discovery order; global/project precedence; Web global-only editing; manual TUI edits plus `/reload`; next-turn behavior; and how disabled types are excluded from `spawn_agent`.

Run focused tests, then package-wide checks:

```bash
bun test packages/protocol/test/protocol-flow.test.ts
bun test packages/runtime/test/config packages/runtime/test/agents packages/runtime/test/app-server
bun test packages/web/test/client/components/components.test.tsx packages/web/test/client/components/tool-settings-interactions.test.tsx
bun run lint
bun run typecheck
bun test
```

**Verify:** Web and TUI resolve the same active optional subagent set after reload; every stated command passes.

## Acceptance Criteria

1. `general` is always an available built-in subagent and cannot be disabled by Web, global config, or project config.
2. `explore` and each discovered custom agent default to enabled when no override exists.
3. A false optional-agent override removes that agent from the next root agent build's `spawn_agent` definitions and registry resolution.
4. Disabled optional agents remain visible in `subagents/list` and Web Config so users can re-enable them.
5. Re-enabling an optional agent removes its redundant global false entry and restores it on the next turn unless a project value controls it.
6. Manual project overrides take precedence and are visibly read-only in Web.
7. `agents.enabled: false` retains current behavior: custom agents are excluded while built-in `general` and `explore` are still governed by their own overrides.
8. Successful `subagents/set` reloads configuration and clears all cached root agents without interrupting active turns.
9. Web writes only `~/.diligent/config.jsonc`, preserves JSONC comments and sibling settings, and handles sequential partial failure clearly.
10. TUI applies the same resolution after manual config editing and `/reload` without a new TUI settings surface.
11. Protocol, focused runtime/Web tests, lint, typecheck, and the full test suite pass.

## Testing Strategy

| Category | What to Test | How |
|----------|--------------|-----|
| Unit | Required built-in and layered optional override resolution | `agents/settings.test.ts` |
| Unit | JSONC false-only persistence and comment preservation | Config writer tests |
| Unit | Custom discovery master gate and catalog/active projection | Runtime config tests |
| Protocol | `subagents/list` and `subagents/set` contracts | Protocol flow round trips |
| Runtime integration | Set → reload → registry refresh → cache invalidation | Subagent handler and factory tests |
| Web component | Required, optional, disabled, and project-controlled rows | Static modal tests |
| Web interaction | Stable thread context, payload filtering, save order, partial failures | Modal interaction tests |
| Manual TUI | Shared manual config behavior | Edit config, `/reload`, and verify spawn-agent choices |

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|------------|
| Disabling all execution-capable agents | Delegation becomes unusable | Make `general` a required, non-configurable built-in in the pure resolver |
| Filtering definitions only in Web | Server still accepts disabled agent types | Feed one active projection into registry and spawn schemas after reload |
| `agents.enabled` semantic drift | Existing custom-agent behavior regresses | Preserve its custom-discovery-only role and test it explicitly |
| Project override hides a global Web edit | UI appears to save without changing result | Return provenance and reject project-controlled set keys |
| Reload updates runtime but not registry dependencies | Next spawn sees stale options | Refresh both runtime definitions and registry mutable dependencies before cache invalidation |
| Concurrent tools/skills/subagents config writes | JSONC read-modify-write races | Keep modal saves deterministic and sequential |
| Manual `general: false` config is surprising | User assumes delegation is disabled | Document required policy and return explicit `required_builtin` descriptor state |

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| D032 | JSONC config with Zod validation | Layered settings persistence |
| D033 | Global < project < CLI config hierarchy | Optional agent override precedence |
| D034 | Deep config merge | Per-agent map merging |
| D062 | Multi-agent task/subagent model | Registry and spawn-agent active projection |
| D096 | Fixed protocol version 1 | New methods without negotiation |

## Plan Decisions

- **Built-in policy:** `general` is required and always enabled. `explore` is an optional built-in and can be disabled.
- **Custom-agent policy:** Every discovered custom agent is optional and defaults to enabled.
- **Web persistence scope:** Web edits global config only. Project overrides remain manual and take precedence.
- **Config representation:** Boolean map under `agents.overrides`; missing means enabled and stored maps contain only explicit `false` entries.
- **UI placement:** Add a Subagents section to the existing Web Config modal.
