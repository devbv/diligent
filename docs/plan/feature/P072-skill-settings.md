---
id: P072
status: implemented
created: 2026-07-12
---

# Configurable Skill Settings

## Goal

Allow users to disable individual discovered skills through `config.jsonc`, with every skill enabled by default. The Web Config modal lists all discovered skills and persists per-skill ON/OFF changes to the global config, while both Web and TUI runtimes honor the resolved state on the next turn.

## Prerequisites

- Skill discovery and progressive disclosure already exist in `packages/runtime/src/skills/` (D052, D053).
- Layered JSONC config loading already exists with global and project sources (D032, D033, D034).
- `config/reload` already reloads runtime config and clears cached thread agents.
- The Web Config modal already manages tool settings through shared protocol requests.

## Artifact

With no per-skill entry, every discovered skill remains enabled:

```jsonc
{
  "skills": {
    "paths": ["/shared/team-skills"]
  }
}
```

In Web, the user opens **Config → Skills**, turns `tech-lead` off, and saves. Diligent preserves the rest of `~/.diligent/config.jsonc` and stores only the explicit opt-out:

```jsonc
{
  "skills": {
    "overrides": {
      "tech-lead": false
    }
  }
}
```

From the next turn, `tech-lead` is absent from the system-prompt skill index, the `skill` tool's available set, and dynamic skill slash commands. Turning it back on removes the redundant global `false` entry; the skill becomes available on the next turn unless the project config or master switch still disables it.

## Scope

### What changes

| Area | What Changes |
|------|-------------|
| Runtime config | Add layered `skills.overrides: Record<string, boolean>` with unspecified skills defaulting to enabled |
| Runtime skill assembly | Preserve the full discovered-skill catalog while projecting only enabled skills into prompts, tools, agents, and slash-command names |
| Runtime config writer | Persist skill overrides with JSONC preservation and false-only normalization |
| App server | Add `skills/list` and `skills/set`; a successful set reloads runtime config and invalidates cached agents |
| Shared protocol | Define skill descriptors and list/set request/response schemas |
| Web Config modal | List discovered skills, edit their ON/OFF draft, save through the shared protocol, and refresh dynamic slash commands |
| TUI behavior | Honor the same config filtering automatically; manual config edits become active through the existing `/reload` flow |
| Documentation | Document discovery, defaults, layered override precedence, global-only Web writes, and reload behavior |

### What does NOT change

- No TUI settings picker or new TUI slash command is added. TUI users edit config and use the existing `/reload`; runtime behavior remains shared.
- No project-scoped per-skill override editing is added to Web. Project `skills.overrides` is supported through manual config and takes precedence over Web-managed global values.
- Existing project/global merging for `skills.enabled` and `skills.paths` does not change.
- `skills.enabled: false` remains the master switch. The Web list reports that skills are disabled by the effective merged master setting but does not replace or remove it.
- Skill installation, deletion, editing, marketplace discovery, dependency validation, and remote skill discovery are out of scope.
- Frontmatter `disable-model-invocation` keeps its existing meaning and is not overridden by the config toggle. Config OFF is an additional availability gate; config ON preserves current frontmatter behavior.
- Runtime changes do not interrupt an in-flight turn. They apply when an agent is built for the next turn.
- No multi-cwd skill runtime cache is introduced. This plan preserves the app-server's existing startup-project skill snapshot; `threadId` selects and validates the current settings context rather than making one server host independent skill catalogs for unrelated projects.
- No protocol version negotiation is introduced (D096).

## Configuration Semantics

The public config shape is:

```typescript
interface SkillsConfig {
  enabled?: boolean;
  paths?: string[];
  overrides?: Record<string, boolean>;
}
```

Resolution rules, in order:

1. Discover the complete skill catalog even when `skills.enabled` is `false`, so disabled skills remain visible in settings.
2. `skills.enabled ?? true` controls the master availability gate.
3. `skills.overrides?.[skill.name] ?? true` controls the individual user preference.
4. A skill is runtime-available only when both gates are true.
5. Only runtime-available skills enter `RuntimeConfig.skills`, the rendered skill section, the `skill` tool, agent tool validation, `skillNames`, and initialize/reload `SkillInfo[]` payloads.
6. The complete discovered catalog is retained separately in `RuntimeConfig.discoveredSkills` for settings.
7. `skills.overrides` follows the existing `global < project` deep-merge hierarchy. A project entry overrides the same global skill key while unrelated global keys remain effective.
8. The Web writer edits only global overrides. It must distinguish the editable global preference from the effective merged state and must not imply that a project-controlled value changed.
9. A skill with an explicit project override is read-only through `skills/set`; Web cannot mutate its global fallback while the project controls its effective value.
10. Writers persist only global `false` entries. Writing global `true` removes the explicit global override so the default-ON rule remains canonical; a project override may still determine the effective state.
11. Overrides are keyed by the resolved skill name. Existing discovery precedence still decides which same-name skill wins before the override is applied.

## File Manifest

### packages/protocol/

| File | Action | Description |
|------|--------|-------------|
| `src/methods.ts` | MODIFY | Add `SKILLS_LIST` and `SKILLS_SET` client request methods |
| `src/client-requests.ts` | MODIFY | Add skill descriptor/reason schemas, thread-aware list/set params and responses, and both discriminated protocol unions |
| `test/protocol-flow.test.ts` | MODIFY | Verify list/set request and response schema round trips |

### packages/runtime/src/config/

| File | Action | Description |
|------|--------|-------------|
| `schema.ts` | MODIFY | Add `skills.overrides` boolean map |
| `loader.ts` | MODIFY | Return validated global/project layer snapshots alongside the merged config so management APIs can report provenance |
| `writer.ts` | MODIFY | Add JSONC-preserving global skill override patching and false-only normalization |
| `runtime.ts` | MODIFY | Retain config layers and discovered skills separately, then project the enabled runtime list |

### packages/runtime/src/skills/

| File | Action | Description |
|------|--------|-------------|
| `settings.ts` | CREATE | Resolve master/individual gates and build deterministic skill settings state |
| `index.ts` | MODIFY | Export skill settings helpers and types |

### packages/runtime/src/app-server/

| File | Action | Description |
|------|--------|-------------|
| `skill-handlers.ts` | CREATE | Implement skill list/set handlers and response mapping |
| `server.ts` | MODIFY | Add the runtime-backed skill config manager to app-server config and dispatch context |
| `request-dispatcher.ts` | MODIFY | Dispatch `skills/list` and `skills/set`; clear cached agents after successful set/reload |
| `factory.ts` | MODIFY | Wire discovered/active skill state, update it during reload, and expose the skill config manager |
| `thread-handlers.ts` | MODIFY | Add thread-aware skill settings context resolution parallel to tool settings |

### packages/runtime/test/

| File | Action | Description |
|------|--------|-------------|
| `config/schema.test.ts` | MODIFY | Verify the override map schema and default-compatible omission |
| `config/loader.test.ts` | MODIFY | Verify layered override merging and returned global/project provenance snapshots |
| `config/writer.test.ts` | MODIFY | Verify false-only normalization, re-enable cleanup, and unrelated JSONC preservation |
| `config/runtime.test.ts` | MODIFY | Verify default ON, explicit OFF, master OFF, and discovered-vs-active projections |
| `skills/settings.test.ts` | CREATE | Unit-test deterministic gate and descriptor resolution |
| `app-server/skill-handlers.test.ts` | CREATE | Verify list/set persistence, reload, descriptor state, and agent cache invalidation |
| `app-server/factory.test.ts` | MODIFY | Verify reload refreshes both discovered and active skills plus slash-command names |

### packages/web/src/client/

| File | Action | Description |
|------|--------|-------------|
| `lib/use-thread-data.ts` | MODIFY | Add typed `listSkills` and `saveSkills` RPC functions |
| `lib/use-app-state.ts` | MODIFY | Expose skill settings RPC functions alongside existing tool settings data functions |
| `components/ToolSettingsModal.tsx` | MODIFY | Add Skills loading, draft toggles, status text, and sequential save behavior |
| `App.tsx` | MODIFY | Pass skill settings callbacks into Config and update active `SkillInfo[]` after save |

### packages/web/test/

| File | Action | Description |
|------|--------|-------------|
| `client/components/components.test.tsx` | MODIFY | Verify enabled/disabled skill rows, master-disabled messaging, and Config copy |
| `client/components/tool-settings-interactions.test.tsx` | CREATE | Verify skill toggle save payloads, project-controlled rows, sequential saves, and partial-failure messaging |

### docs/guide/

| File | Action | Description |
|------|--------|-------------|
| `skill-settings.md` | CREATE | Document config shape, precedence, Web workflow, TUI reload, and frontmatter distinction |

## Implementation Tasks

### Task 1: Define skill override config and persistence

**Files:** `packages/runtime/src/config/schema.ts`, `packages/runtime/src/config/loader.ts`, `packages/runtime/src/config/writer.ts`, `packages/runtime/test/config/schema.test.ts`, `packages/runtime/test/config/loader.test.ts`, `packages/runtime/test/config/writer.test.ts`

**Decisions:** D032, D033, D034

Extend the existing skills subtree without changing its master switch or additional paths:

```typescript
const SkillsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  paths: z.array(z.string()).optional(),
  overrides: z.record(z.string(), z.boolean()).optional(),
});

export interface SkillConfigPatch {
  overrides?: Record<string, boolean>;
}

export interface WriteSkillsConfigResult {
  configPath: string;
  config: DiligentConfig;
  skills: DiligentConfig["skills"];
}

export async function writeGlobalSkillsConfig(patch: SkillConfigPatch): Promise<WriteSkillsConfigResult>;
```

Expose the validated input layers without changing merge semantics:

```typescript
export interface DiligentConfigLayers {
  global?: DiligentConfig;
  project?: DiligentConfig;
}

export async function loadDiligentConfig(cwd: string): Promise<{
  config: DiligentConfig;
  sources: string[];
  layers: DiligentConfigLayers;
}>;
```

Mirror the tool writer's current JSONC-preserving approach:

- Read and validate the global config.
- Merge the incoming boolean patch with current global overrides.
- Normalize the map to sorted `false` entries only.
- Remove an empty `overrides` property rather than serializing `{}`.
- Preserve sibling `skills.enabled`, `skills.paths`, comments, and unrelated config.
- Return the validated post-write config.

Do not add a loader exception for skill overrides. The existing deep merge provides the intended global-default/project-override behavior, including per-name merging within `skills.overrides`.

**Verify:** Schema accepts boolean maps; global `false` + project `true` resolves ON; global absent + project `false` resolves OFF; layer snapshots preserve the original values; setting a global skill to `true` removes its persisted false entry; repeated writes are stable and preserve comments.

### Task 2: Separate discovered skills from runtime-available skills

**Files:** `packages/runtime/src/skills/settings.ts`, `packages/runtime/src/skills/index.ts`, `packages/runtime/src/config/runtime.ts`, `packages/runtime/test/skills/settings.test.ts`, `packages/runtime/test/config/runtime.test.ts`

**Decisions:** D052, D053

Create a pure resolver so prompt/tool code does not independently reinterpret config:

```typescript
export type SkillStateReason = "enabled" | "disabled_by_user" | "skills_disabled";

export interface ResolvedSkillState {
  skill: SkillMetadata;
  globalEnabled: boolean;
  effectiveEnabled: boolean;
  available: boolean;
  controlledBy: "default" | "global" | "project";
  reason: SkillStateReason;
}

export function resolveSkillStates(
  skills: SkillMetadata[],
  resolvedConfig: DiligentConfig["skills"] | undefined,
  layers: DiligentConfigLayers,
): ResolvedSkillState[];

export function filterAvailableSkills(states: ResolvedSkillState[]): SkillMetadata[];
```

Change runtime assembly to always discover skills, then retain both projections:

```typescript
export interface RuntimeConfig {
  // Complete deduplicated discovery result for management surfaces.
  discoveredSkills: SkillMetadata[];
  // Config-enabled projection used by prompts, tools, agents, and slash commands.
  skills: SkillMetadata[];
  configLayers: DiligentConfigLayers;
  // existing fields...
}
```

Build `skillsSection` and downstream agent tool validation from `RuntimeConfig.skills` only. Preserve the current behavior of `disable-model-invocation` inside the render/tool layers; the config resolver must not rewrite frontmatter metadata.

**Verify:** An unspecified skill is enabled; a false override removes it from active runtime skills but not discovery; master OFF leaves discovery populated and active skills empty; deterministic ordering remains discovery order.

### Task 3: Add shared skill settings protocol

**Files:** `packages/protocol/src/methods.ts`, `packages/protocol/src/client-requests.ts`, `packages/protocol/test/protocol-flow.test.ts`

**Decisions:** D096

Add dedicated methods rather than overloading tool settings or `config/reload`:

```typescript
export const DILIGENT_CLIENT_REQUEST_METHODS = {
  // existing methods...
  SKILLS_LIST: "skills/list",
  SKILLS_SET: "skills/set",
} as const;

export const SkillStateReasonSchema = z.enum(["enabled", "disabled_by_user", "skills_disabled"]);

export const SkillDescriptorSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(["global", "project", "config"]),
  globalEnabled: z.boolean(),
  effectiveEnabled: z.boolean(),
  available: z.boolean(),
  controlledBy: z.enum(["default", "global", "project"]),
  reason: SkillStateReasonSchema,
});

export const SkillsListParamsSchema = z.object({
  threadId: z.string().optional(),
});

export const SkillsListResponseSchema = z.object({
  configPath: z.string(),
  appliesOnNextTurn: z.literal(true),
  skillsEnabled: z.boolean(),
  skillsEnabledControlledBy: z.enum(["default", "global", "project"]),
  skills: z.array(SkillDescriptorSchema),
});

export const SkillsSetParamsSchema = z.object({
  threadId: z.string().optional(),
  overrides: z.record(z.string(), z.boolean()),
});

export const SkillsSetResponseSchema = SkillsListResponseSchema;
```

Keep `SkillInfo` unchanged for initialize, reload, and dynamic slash commands. It remains the compact active-skill projection, while `SkillDescriptor` is the management model.

**Verify:** Both request methods and responses pass discriminated-union parsing and JSON-RPC round trips.

### Task 4: Implement app-server list/set behavior and reload semantics

**Files:** `packages/runtime/src/app-server/skill-handlers.ts`, `packages/runtime/src/app-server/server.ts`, `packages/runtime/src/app-server/request-dispatcher.ts`, `packages/runtime/src/app-server/factory.ts`, `packages/runtime/test/app-server/skill-handlers.test.ts`, `packages/runtime/test/app-server/factory.test.ts`

**Decisions:** D052, D053

Follow the existing tool-settings seam: use `threadId` to resolve the active project cwd, then ask a runtime-backed manager for the matching skill settings snapshot. The snapshot must distinguish the editable global preference from the project-controlled effective value:

```typescript
export interface SkillSettingsContext {
  cwd: string;
  config: DiligentConfig["skills"] | undefined;
  layers: DiligentConfigLayers;
  discoveredSkills: SkillMetadata[];
}

export interface SkillConfigManager {
  resolve: (cwd: string) => Promise<SkillSettingsContext>;
}

export async function handleSkillsList(
  ctx: ThreadHandlersContext,
  manager: SkillConfigManager,
  threadId: string | undefined,
): Promise<SkillsListResponse>;

export async function handleSkillsSet(
  ctx: ThreadHandlersContext,
  manager: SkillConfigManager,
  reloadConfig: (() => Promise<ConfigReloadResult>) | undefined,
  params: SkillsSetParams,
): Promise<SkillsSetResponse>;
```

Add `resolveSkillSettingsCwd(threadId?)` to `ThreadHandlersContext`, using the same active-thread/default-cwd fallback policy as `resolveToolsContext`. Because skill metadata and prompt sections are currently assembled for the app-server's startup project, reject a settings request whose resolved thread cwd differs from the configured app-server cwd instead of returning or editing a misleading catalog. A future multi-cwd runtime may replace this guard with per-cwd snapshots.

`handleSkillsSet` must:

1. Resolve the project cwd from `params.threadId`.
2. Reject override keys explicitly present in that project's `skills.overrides`, because Web cannot manipulate project-controlled rows.
3. Persist the remaining global patch with `writeGlobalSkillsConfig`.
4. Invoke the same runtime reload hook used by `config/reload`.
5. Clear every cached `runtime.agent` only after the write and reload succeed.
6. Build the response from the refreshed project-aware snapshot, including merged effective state and global/project provenance.

Factor or reuse the existing `handleConfigReload` cache-clearing path rather than duplicating subtly different reload semantics.

Update `factory.ts` reload application so it copies `fresh.discoveredSkills` in addition to `fresh.skills`, then refreshes `config.skillNames` from active skills. Generic initialize/reload `SkillInfo[]` and the Web server's initialize override continue to expose only active skills.

**Verify:** List follows the selected thread's project; set rejects project-controlled keys and writes only the global file; removing a global false while project false remains still reports effective OFF; all existing thread agent caches are invalidated; current turns are not interrupted; the next agent build, slash-command names, and reload response contain only active skills.

### Task 5: Add Skills to the Web Config modal

**Files:** `packages/web/src/client/lib/use-thread-data.ts`, `packages/web/src/client/lib/use-app-state.ts`, `packages/web/src/client/components/ToolSettingsModal.tsx`, `packages/web/src/client/App.tsx`, `packages/web/test/client/components/components.test.tsx`

Add typed RPC functions:

```typescript
const listSkills = useCallback(async (): Promise<SkillsListResponse> => {
  const rpc = rpcRef.current;
  if (!rpc) throw new Error("WebSocket is not connected");
  return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.SKILLS_LIST, {
    threadId: state.activeThreadId ?? undefined,
  });
}, [rpcRef, state.activeThreadId]);

const saveSkills = useCallback(
  async (params: SkillsSetParams): Promise<SkillsSetResponse> => {
    const rpc = rpcRef.current;
    if (!rpc) throw new Error("WebSocket is not connected");
    return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.SKILLS_SET, {
      ...params,
      threadId: state.activeThreadId ?? undefined,
    });
  },
  [rpcRef, state.activeThreadId],
);
```

Extend the existing Config modal rather than adding another modal:

- Load tool and skill settings together when opened.
- Render a **Skills** section before Built-in tools.
- Show skill name, description, and source.
- Bind an editable checkbox to `globalEnabled` while also showing `effectiveEnabled` and master-gated `available`.
- When a project override controls a skill, disable the Web checkbox, label the row **Controlled by project config**, and show the effective value. Web must not offer a control that cannot change the result.
- When `skillsEnabled` is false, show that the master switch currently makes every skill unavailable; retain individual checkbox preferences in the draft.
- Explain that changes apply on the next turn.
- Submit only when the skill draft changed.
- Save tool and skill mutations sequentially, never concurrently, because both writers edit the same global JSONC file.
- If either save fails, keep the modal open and show which settings were already persisted; do not report an all-or-nothing success.
- After a successful skill save, replace Web app `skills` state with `result.skills.filter((skill) => skill.available)` mapped to `SkillInfo`. This immediately refreshes dynamic slash-command suggestions while server-side agent behavior changes on the next turn.

Update the modal description from tool-only wording to general configuration wording.

**Verify:** Server-rendered component tests show default-ON, explicit-OFF, source labels, master-disabled messaging, project-controlled effective OFF, and next-turn copy. Interaction tests verify thread-aware payloads, project-controlled rows cannot be submitted, tool/skill writes are sequential, and partial failures remain visible. Manual interaction confirms saving OFF removes the dynamic slash command and saving ON restores it when no project/master gate remains.

### Task 6: Document configuration and validate both clients

**Files:** `docs/guide/skill-settings.md`

**Decisions:** D032, D033, D052, D053

Document:

- discovery locations and name collision precedence;
- `skills.enabled`, `skills.paths`, and `skills.overrides`;
- default-ON and false-only persistence;
- layered individual/master/path settings and global-only Web writes;
- Web Config workflow;
- TUI manual edit plus `/reload` workflow;
- next-turn semantics and in-flight turn behavior;
- distinction from `disable-model-invocation` frontmatter.

Run targeted tests first, then package-wide checks:

```bash
bun test packages/protocol/test/protocol-flow.test.ts
bun test packages/runtime/test/config packages/runtime/test/skills packages/runtime/test/app-server
bun test packages/web/test/client/components/components.test.tsx
bun run typecheck
bun test
```

**Verify:** Documentation examples parse under the schema; Web and TUI both resolve the same active skill set after reload; all tests and type checks pass.

## Acceptance Criteria

1. A discovered skill with no override is enabled by default.
2. `skills.overrides.<name> = false` removes that skill from the system prompt, `skill` tool availability, agent validation input, server skill names, initialize/reload active skill payloads, and Web dynamic slash commands.
3. Disabled skills remain present in `skills/list` and the Web Config modal so they can be re-enabled.
4. Re-enabling a skill removes its redundant global false entry and restores it on the next turn when no project override or master switch disables it.
5. `skills.enabled: false` leaves the settings catalog visible while making all skills runtime-unavailable.
6. Project config overrides `skills.enabled`, `skills.paths`, and matching `skills.overrides` entries through normal deep merge.
7. `skills/list` resolves the project from `threadId` and reports global preference, effective value, and controlling layer separately.
8. Web writes individual toggles only to `~/.diligent/config.jsonc`, shows the exact path returned by the server, and renders project-controlled rows as read-only.
9. JSONC comments, `skills.enabled`, `skills.paths`, and unrelated config survive Web writes.
10. A successful `skills/set` invalidates cached agents for all threads without interrupting active turns.
11. Web slash-command suggestions update from the set response without requiring a page refresh.
12. TUI honors the same config through startup and its existing `/reload` flow without a client-specific implementation.
13. Existing `disable-model-invocation` behavior remains unchanged.
14. Protocol, runtime, Web tests, full typecheck, and the full test suite pass.

## Testing Strategy

| Category | What to Test | How |
|----------|-------------|-----|
| Unit | Config schema and false-only normalization | Runtime config schema/writer tests |
| Unit | Global/project override merge and provenance | Loader tests with separate temporary HOME and project configs |
| Unit | Master and individual gate resolution | Pure `skills/settings.test.ts` cases |
| Unit | Discovered versus active runtime projections | Runtime config tests with temporary skill directories |
| Protocol | `skills/list` and `skills/set` contracts | Protocol flow round trips |
| Runtime integration | Persist → reload → cache invalidate → refreshed list | App-server skill handler tests |
| Runtime integration | Reload refreshes active prompt/tool/slash inputs | Factory tests with temporary HOME and project directories |
| Web component | Skill rows, statuses, master-disabled state, and project control | Static and interaction component tests |
| Manual Web | Toggle OFF/ON and inspect config/slash suggestions | Run Web, open Config, save toggles, start a new turn |
| Manual TUI | Shared config behavior | Edit global config, run `/reload`, verify skill command/tool availability |

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|------------|
| Filtering discovery too early | Disabled skills disappear from settings and cannot be restored | Always retain `RuntimeConfig.discoveredSkills`; filter only the active projection |
| Project precedence hides a Web edit | Web appears to save but the effective value does not change | Return `controlledBy` and layer-aware state; make project-controlled rows read-only with an explicit label |
| Cached agents retain old skill tools | UI and slash commands disagree with actual agent capabilities | Reuse config reload and invalidate every cached agent after a successful set |
| Concurrent tool and skill writes race | One config subtree can overwrite another writer's read-modify-write result | Save Config modal mutations sequentially and keep JSONC edits subtree-scoped |
| Sequential multi-section save partially succeeds | User may assume all settings rolled back | Keep the modal open, report partial persistence precisely, and refresh from server state |
| Name-keyed overrides affect a replacement skill | A newly discovered same-name winner inherits the old OFF state | Preserve documented first-loaded-wins behavior and display the resolved source in Web |
| Master OFF is confused with individual OFF | Checked rows may still be unavailable | Return `skillsEnabled`, `globalEnabled`, `effectiveEnabled`, `available`, and `reason` separately and show master-disabled copy |
| Real user global skills leak into tests | Tests become machine-dependent | Override HOME and use temporary project/global skill roots, matching existing factory reload tests |

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| D032 | JSONC config with Zod validation | Schema and writer |
| D033 | Global < project < CLI config hierarchy | Individual overrides follow normal project precedence; Web edits only the global layer |
| D034 | Deep config merge | Preserve layered `skills.enabled`, `skills.paths`, and per-name `skills.overrides` behavior |
| D052 | SKILL.md discovery and progressive disclosure | Discovered catalog and active runtime projection |
| D053 | Implicit invocation with explicit fallback | Config availability remains separate from frontmatter invocation policy |
| D096 | Fixed protocol version 1 | Add methods without version negotiation |

## Plan Decisions

- **Web persistence scope:** Web writes global config only. The user clarified on 2026-07-12 that project config may manually override individual skill settings through normal config precedence, but Web does not edit those project values.
- **Config representation:** Boolean map under `skills.overrides`, selected by the user on 2026-07-12.
- **Default representation:** Missing entry means ON; persisted maps contain explicit `false` entries only.
- **UI placement:** Add a Skills section to the existing Web Config modal rather than creating a separate settings surface.
