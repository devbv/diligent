# Phase 3a: Configuration & Session Persistence

## Goal

The agent can be configured per-project via `diligent.jsonc` and `CLAUDE.md`. Sessions persist to disk in `.diligent/sessions/` and survive process restarts. The `SessionManager` mediator class (D086) owns session lifecycle, preparing the architecture for a future web UI protocol layer.

## Prerequisites

- Phase 2 artifact: Coding agent with 7 tools, retry, markdown rendering.
- All Phase 2 tests passing (`bun test`).
- `jsonc-parser` npm dependency (new).

## Artifact

Configurable, persistent agent. Sessions survive restarts. Config hierarchy (global → project → env) is respected. CLAUDE.md project instructions are injected into the system prompt.

**Demo 1 — Config + CLAUDE.md:**
```
$ cat diligent.jsonc
{
  // Project-level config
  "model": "claude-sonnet-4-20250514"
}

$ cat CLAUDE.md
# Project Instructions
This project uses Bun runtime. Always prefer Bun APIs over Node.js equivalents.
All code must be TypeScript strict mode.

$ bunx diligent

diligent> what runtime should I use?

This project uses Bun runtime. I'll always prefer Bun APIs...
```

**Demo 2 — Session resume:**
```
$ bunx diligent

diligent> find all TODO comments

⠹ Searching...
[tool: grep] pattern: "TODO" → 8 matches
Found 8 TODO comments: ...

diligent> (Ctrl+D to exit)

$ bunx diligent --continue

Resuming session 2026-02-25T10:30:00...

diligent> which TODOs did you find earlier?

In our previous conversation, I found 8 TODO comments: ...
```

**Demo 3 — Session listing:**
```
$ bunx diligent --list

Sessions:
  1. [2026-02-25 10:30] find all TODO comments... (8 messages)
  2. [2026-02-25 09:15] refactor config module... (12 messages)

$ bunx diligent --continue 1
```

## Layer Touchpoints

| Layer | Depth | What Changes |
|-------|-------|-------------|
| L1 (Agent Loop) | +itemId | `itemId` field on grouped AgentEvent subtypes (D086) |
| L2 (Tool System) | +ApprovalResponse | `ApprovalRequest` gains `toolName`/`details`, `approve()` returns `ApprovalResponse` instead of `boolean`. Phase 3a still auto-returns `"once"` |
| L5 (Config) | FULL | JSONC parsing + Zod validation + 3-layer hierarchy + CLAUDE.md discovery + template substitution (D032-D035) |
| L6 (Session) | SessionManager | `SessionManager` mediator class (D086): wraps `agentLoop()`, owns session lifecycle. JSONL persistence with tree structure. Deferred write. Session listing/resume/fork (D036-REV, D040-D043) |
| L7 (TUI) | →SessionManager | TUI switches from direct `agentLoop()` to `SessionManager`. CLI flags: `--continue`, `--list` |
| Infrastructure | .diligent/ | `.diligent/` project data directory, auto-generated `.gitignore`, JSON serialization roundtrip test convention (D086) |

**Not touched:**
- L0 (Provider) — still Anthropic only. Multi-provider deferred to Phase 3b
- L3 (Core Tools) — no new tools. `add_knowledge` deferred to Phase 3b
- L4 (Approval) — still auto-approve behavior, but types expanded (D086)
- L8 (Skills), L9 (MCP), L10 (Multi-Agent) — Phase 5

---

## File Manifest

### packages/core/src/config/

| File | Action | Description |
|------|--------|-------------|
| `schema.ts` | CREATE | Config Zod schema, `DiligentConfig` type, default values |
| `loader.ts` | CREATE | `loadConfig()`: JSONC parsing, 3-layer merge, env override, template substitution |
| `instructions.ts` | CREATE | `discoverInstructions()`: CLAUDE.md findUp, content loading |
| `index.ts` | CREATE | Barrel export |

### packages/core/src/session/

| File | Action | Description |
|------|--------|-------------|
| `types.ts` | CREATE | `SessionHeader`, `SessionEntry` union, `SessionInfo`, tree node types |
| `persistence.ts` | CREATE | JSONL reader/writer, deferred write, append, session file discovery |
| `context-builder.ts` | CREATE | `buildSessionContext()`: tree traversal → linear message list |
| `manager.ts` | CREATE | `SessionManager` class: create/resume/fork, wraps agentLoop() |
| `index.ts` | CREATE | Barrel export |

### packages/core/src/infrastructure/

| File | Action | Description |
|------|--------|-------------|
| `diligent-dir.ts` | CREATE | `.diligent/` directory management: ensure, gitignore, paths |

### packages/core/src/agent/

| File | Action | Description |
|------|--------|-------------|
| `types.ts` | MODIFY | Add `itemId` to grouped AgentEvent subtypes (D086) |
| `loop.ts` | MODIFY | Generate and emit `itemId` on message/tool event groups |

### packages/core/src/tool/

| File | Action | Description |
|------|--------|-------------|
| `types.ts` | MODIFY | `ApprovalRequest` gains `toolName`/`details`. `ApprovalResponse` type. `approve()` returns `ApprovalResponse` |

### packages/core/src/

| File | Action | Description |
|------|--------|-------------|
| `index.ts` | MODIFY | Export new config, session, infrastructure modules |

### packages/cli/src/

| File | Action | Description |
|------|--------|-------------|
| `config.ts` | REWRITE | Replace env-based config with full JSONC config system |
| `index.ts` | MODIFY | Parse CLI flags (`--continue`, `--list`), wire SessionManager |

### packages/cli/src/tui/

| File | Action | Description |
|------|--------|-------------|
| `app.ts` | MODIFY | Receive `SessionManager` instead of calling `agentLoop()` directly |

### packages/core/test/

| File | Action | Description |
|------|--------|-------------|
| `config-schema.test.ts` | CREATE | Schema validation: valid/invalid configs, defaults, merge |
| `config-loader.test.ts` | CREATE | Hierarchy merge, JSONC parsing, env override, template substitution |
| `config-instructions.test.ts` | CREATE | CLAUDE.md discovery: findUp traversal, content loading, missing file |
| `session-types.test.ts` | CREATE | Entry serialization roundtrip (D086), tree ID generation |
| `session-persistence.test.ts` | CREATE | JSONL read/write, deferred persistence, append, version header |
| `session-context-builder.test.ts` | CREATE | Tree traversal: linear path, branching, settings extraction |
| `session-manager.test.ts` | CREATE | Create/resume/fork sessions, wraps agentLoop(), persistence triggers |
| `diligent-dir.test.ts` | CREATE | Directory creation, gitignore generation, path helpers |
| `d086-serialization.test.ts` | CREATE | JSON roundtrip for all AgentEvent variants, Message types, session entries |
| `d086-approval-types.test.ts` | CREATE | ApprovalResponse type behavior (auto-returns "once") |

### packages/cli/test/

| File | Action | Description |
|------|--------|-------------|
| `config.test.ts` | REWRITE | Test new JSONC config loading, hierarchy, CLAUDE.md injection |

---

## Implementation Tasks

### Task 1: D086 Protocol Readiness — Type Changes

**Files:** `core/src/agent/types.ts`, `core/src/agent/loop.ts`, `core/src/tool/types.ts`, `core/test/d086-serialization.test.ts`, `core/test/d086-approval-types.test.ts`
**Decisions:** D086, D028, D029

Independent of other tasks. Expand types for protocol readiness.

#### 1a: itemId on AgentEvent

```typescript
// agent/types.ts — add itemId to grouped event subtypes

export type AgentEvent =
  // Lifecycle (2) — no itemId needed
  | { type: "agent_start" }
  | { type: "agent_end"; messages: Message[] }
  // Turn (2) — no itemId needed
  | { type: "turn_start"; turnId: string }
  | { type: "turn_end"; turnId: string; message: AssistantMessage; toolResults: ToolResultMessage[] }
  // Message streaming (3) — ADD itemId
  | { type: "message_start"; itemId: string; message: AssistantMessage }
  | { type: "message_delta"; itemId: string; message: AssistantMessage; delta: MessageDelta }
  | { type: "message_end"; itemId: string; message: AssistantMessage }
  // Tool execution (3) — ADD itemId
  | { type: "tool_start"; itemId: string; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_update"; itemId: string; toolCallId: string; toolName: string; partialResult: string }
  | { type: "tool_end"; itemId: string; toolCallId: string; toolName: string; output: string; isError: boolean }
  // Status (1)
  | { type: "status_change"; status: "idle" | "busy" | "retry"; retry?: { attempt: number; delayMs: number } }
  // Usage (1)
  | { type: "usage"; usage: Usage; cost: number }
  // Error (1)
  | { type: "error"; error: Error; fatal: boolean };
```

Events sharing the same `itemId` form a logical item — equivalent to codex-rs's `item/started → item/delta(N) → item/completed` pattern.

In `loop.ts`: generate `itemId` using a simple counter or `crypto.randomUUID()` substring. Each message group and each tool execution group gets a unique `itemId`.

#### 1b: Expanded ApprovalRequest/Response

```typescript
// tool/types.ts — expanded types

export interface ApprovalRequest {
  permission: "read" | "write" | "execute";
  toolName: string;                           // NEW (D086)
  description: string;
  details?: Record<string, unknown>;          // NEW (D086) — for pattern matching
}

export type ApprovalResponse = "once" | "always" | "reject"; // NEW (D086, D029)

export interface ToolContext {
  toolCallId: string;
  signal: AbortSignal;
  approve: (request: ApprovalRequest) => Promise<ApprovalResponse>; // CHANGED: was boolean
  onUpdate?: (partialResult: string) => void;
}
```

Phase 3a behavior: `approve()` still auto-returns `"once"`. The type change is forward-preparation for Phase 4's full approval system.

Update all existing `approve()` callers (in tools) to handle `ApprovalResponse` instead of `boolean`:
- `"once"` / `"always"` → proceed
- `"reject"` → return error result

#### 1c: Serialization contract

Establish a test convention: all types that cross the core↔consumer boundary must pass JSON roundtrip.

```typescript
// test/d086-serialization.test.ts
import { describe, expect, it } from "bun:test";

function assertJsonRoundtrip<T>(value: T): void {
  const serialized = JSON.stringify(value);
  const deserialized = JSON.parse(serialized);
  expect(deserialized).toEqual(value);
}

describe("D086: JSON serialization contract", () => {
  it("AgentEvent variants roundtrip", () => {
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "message_start", itemId: "msg-1", message: makeAssistant() },
      { type: "tool_start", itemId: "tool-1", toolCallId: "tc-1", toolName: "bash", input: { command: "ls" } },
      // ... all 15 variants
    ];
    for (const event of events) {
      assertJsonRoundtrip(event);
    }
  });

  it("Message types roundtrip", () => { /* ... */ });
});
```

> **Note on Error serialization**: `AgentEvent.error` contains an `Error` object which does not serialize cleanly. The error event should carry `{ message: string; name: string; stack?: string }` instead of a raw `Error` instance. This is a breaking change — update the error event type to use a serializable error representation.

```typescript
// agent/types.ts — serializable error in events
export interface SerializableError {
  message: string;
  name: string;
  stack?: string;
}

// In the error event:
| { type: "error"; error: SerializableError; fatal: boolean }
```

**Verify:** `bun test d086-serialization d086-approval-types` — all event variants roundtrip, approval auto-returns "once", tools handle ApprovalResponse correctly.

---

### Task 2: `.diligent/` Directory Convention

**Files:** `core/src/infrastructure/diligent-dir.ts`, `core/test/diligent-dir.test.ts`
**Decisions:** D080

Foundation for all persistent data. Establishes the `.diligent/` directory layout.

```typescript
// infrastructure/diligent-dir.ts
import { join } from "node:path";

const DILIGENT_DIR = ".diligent";

export interface DiligentPaths {
  root: string;         // <cwd>/.diligent/
  sessions: string;     // <cwd>/.diligent/sessions/
  knowledge: string;    // <cwd>/.diligent/knowledge/
  skills: string;       // <cwd>/.diligent/skills/
}

/** Resolve .diligent/ paths for a given project root */
export function resolvePaths(projectRoot: string): DiligentPaths {
  const root = join(projectRoot, DILIGENT_DIR);
  return {
    root,
    sessions: join(root, "sessions"),
    knowledge: join(root, "knowledge"),
    skills: join(root, "skills"),
  };
}

const GITIGNORE_CONTENT = `# Auto-generated by diligent
# Sessions and knowledge are machine-local, not version-controlled
sessions/
knowledge/
`;

/** Ensure .diligent/ directory structure exists. Creates dirs and .gitignore if missing. */
export async function ensureDiligentDir(projectRoot: string): Promise<DiligentPaths> {
  const paths = resolvePaths(projectRoot);
  await mkdir(paths.sessions, { recursive: true });
  await mkdir(paths.knowledge, { recursive: true });
  // skills/ is git-tracked (D052), only create if missing
  await mkdir(paths.skills, { recursive: true });

  const gitignorePath = join(paths.root, ".gitignore");
  if (!await exists(gitignorePath)) {
    await Bun.write(gitignorePath, GITIGNORE_CONTENT);
  }

  return paths;
}
```

**Verify:** `bun test diligent-dir` — directories created, .gitignore content correct, idempotent (safe to call multiple times).

---

### Task 3: Config Schema + JSONC Loading

**Files:** `core/src/config/schema.ts`, `core/src/config/loader.ts`, `core/src/config/index.ts`, `core/test/config-schema.test.ts`, `core/test/config-loader.test.ts`
**Decisions:** D032, D033, D034

Full JSONC config system with Zod validation and 3-layer hierarchy.

#### 3a: Config Schema

```typescript
// config/schema.ts
import { z } from "zod";

export const ModelId = z.string().describe("Model identifier, e.g. 'claude-sonnet-4-20250514'");

export const DiligentConfigSchema = z.object({
  $schema: z.string().optional(),

  // Core settings
  model: ModelId.optional(),
  provider: z.object({
    anthropic: z.object({
      apiKey: z.string().optional(),
      baseUrl: z.string().url().optional(),
    }).optional(),
    openai: z.object({
      apiKey: z.string().optional(),
      baseUrl: z.string().url().optional(),
    }).optional(),
  }).optional(),

  // Agent behavior
  maxTurns: z.number().int().positive().optional(),
  maxRetries: z.number().int().positive().optional(),
  systemPrompt: z.string().optional(),

  // Instructions (D034: concatenated across layers)
  instructions: z.array(z.string()).optional(),

  // Session settings
  session: z.object({
    autoResume: z.boolean().optional(),
  }).optional(),

  // Knowledge settings (prepared for Phase 3b)
  knowledge: z.object({
    enabled: z.boolean().optional(),
    nudgeInterval: z.number().int().positive().optional(),
    injectionBudget: z.number().int().positive().optional(),
  }).optional(),

  // Compaction settings (prepared for Phase 3b)
  compaction: z.object({
    enabled: z.boolean().optional(),
    reserveTokens: z.number().int().positive().optional(),
    keepRecentTokens: z.number().int().positive().optional(),
  }).optional(),
}).strict();

export type DiligentConfig = z.infer<typeof DiligentConfigSchema>;

export const DEFAULT_CONFIG: DiligentConfig = {
  model: "claude-sonnet-4-20250514",
};
```

Use `.strict()` to reject unknown keys — catches typos in config files.

#### 3b: Config Loader

```typescript
// config/loader.ts
import { parse as parseJsonc } from "jsonc-parser";
import { DiligentConfigSchema, DEFAULT_CONFIG, type DiligentConfig } from "./schema";
import { join } from "node:path";
import { homedir } from "node:os";

/** 3-layer config hierarchy (D033) */
export interface ConfigSources {
  global?: string;   // ~/.config/diligent/diligent.jsonc
  project?: string;  // <cwd>/diligent.jsonc
  env?: Record<string, string | undefined>; // process.env overrides
}

/** Load and merge config from all sources */
export async function loadDiligentConfig(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ config: DiligentConfig; sources: string[] }> {
  const sources: string[] = [];

  // Layer 1: Global config
  const globalPath = join(homedir(), ".config", "diligent", "diligent.jsonc");
  const globalConfig = await loadConfigFile(globalPath);
  if (globalConfig) sources.push(globalPath);

  // Layer 2: Project config
  const projectPath = join(cwd, "diligent.jsonc");
  const projectConfig = await loadConfigFile(projectPath);
  if (projectConfig) sources.push(projectPath);

  // Merge: global < project < env
  let merged = DEFAULT_CONFIG;
  if (globalConfig) merged = mergeConfig(merged, globalConfig);
  if (projectConfig) merged = mergeConfig(merged, projectConfig);

  // Layer 3: Environment variable overrides
  merged = applyEnvOverrides(merged, env);

  return { config: merged, sources };
}

/** Parse JSONC file, validate with Zod */
async function loadConfigFile(path: string): Promise<DiligentConfig | null> {
  try {
    const text = await Bun.file(path).text();
    const parsed = parseJsonc(text);
    // Apply template substitution before validation
    const substituted = substituteTemplates(parsed);
    const result = DiligentConfigSchema.safeParse(substituted);
    if (!result.success) {
      console.warn(`Config warning: ${path}\n${result.error.message}`);
      return null;
    }
    return result.data;
  } catch {
    return null; // File not found or parse error
  }
}

/** Deep merge with array concatenation for 'instructions' (D034) */
export function mergeConfig(base: DiligentConfig, override: DiligentConfig): DiligentConfig {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (key === "instructions" && Array.isArray(value)) {
      // D034: concatenate instructions, deduplicate
      const baseInstructions = (base as any).instructions ?? [];
      (merged as any).instructions = [...new Set([...baseInstructions, ...value])];
    } else if (typeof value === "object" && !Array.isArray(value) && value !== null) {
      // Deep merge objects
      (merged as any)[key] = { ...((base as any)[key] ?? {}), ...value };
    } else {
      (merged as any)[key] = value;
    }
  }
  return merged;
}

/** Environment variable overrides (D033 Layer 3) */
function applyEnvOverrides(config: DiligentConfig, env: Record<string, string | undefined>): DiligentConfig {
  const result = { ...config };
  if (env.ANTHROPIC_API_KEY) {
    result.provider = {
      ...result.provider,
      anthropic: { ...result.provider?.anthropic, apiKey: env.ANTHROPIC_API_KEY },
    };
  }
  if (env.DILIGENT_MODEL) {
    result.model = env.DILIGENT_MODEL;
  }
  return result;
}

/** Template substitution: {env:VAR_NAME} → process.env.VAR_NAME */
function substituteTemplates(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\{env:([^}]+)\}/g, (_, varName) => process.env[varName] ?? "");
  }
  if (Array.isArray(obj)) return obj.map(substituteTemplates);
  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = substituteTemplates(v);
    }
    return result;
  }
  return obj;
}
```

**New dependency:** Add `jsonc-parser` to `packages/core/package.json`.

**Verify:** `bun test config-schema config-loader` — valid config passes, invalid rejects, merge concatenates instructions, env overrides applied, template substitution works, missing files handled gracefully.

---

### Task 4: CLAUDE.md Discovery + System Prompt

**Files:** `core/src/config/instructions.ts`, `core/test/config-instructions.test.ts`
**Decisions:** D035

Discover CLAUDE.md files via upward directory traversal and inject into system prompt.

```typescript
// config/instructions.ts
import { join, dirname } from "node:path";

const INSTRUCTION_FILES = ["CLAUDE.md"];
const MAX_INSTRUCTION_BYTES = 32_768; // 32 KiB (same as codex-rs)

export interface DiscoveredInstruction {
  path: string;
  content: string;
}

/**
 * Walk from cwd upward to filesystem root, collecting CLAUDE.md files.
 * Returns instructions ordered from most specific (cwd) to most general (root).
 * Stops at filesystem root or when a .git directory is found (project boundary).
 */
export async function discoverInstructions(cwd: string): Promise<DiscoveredInstruction[]> {
  const instructions: DiscoveredInstruction[] = [];
  let dir = cwd;

  while (true) {
    for (const filename of INSTRUCTION_FILES) {
      const filePath = join(dir, filename);
      const content = await readInstructionFile(filePath);
      if (content !== null) {
        instructions.push({ path: filePath, content });
      }
    }

    // Stop at filesystem root
    const parent = dirname(dir);
    if (parent === dir) break;

    // Stop at project boundary (.git)
    // But only AFTER checking the current directory (project root has CLAUDE.md)
    if (dir !== cwd) {
      const hasGit = await exists(join(dir, ".git"));
      if (hasGit) break;
    }
    dir = parent;
  }

  return instructions;
}

async function readInstructionFile(path: string): Promise<string | null> {
  try {
    const file = Bun.file(path);
    const size = file.size;
    if (size > MAX_INSTRUCTION_BYTES) {
      const content = await file.text();
      return content.slice(0, MAX_INSTRUCTION_BYTES) + "\n...(truncated)";
    }
    return await file.text();
  } catch {
    return null;
  }
}

/**
 * Build the full system prompt including discovered instructions.
 * Called by SessionManager when creating a new session.
 */
export function buildSystemPrompt(
  basePrompt: string,
  instructions: DiscoveredInstruction[],
  additionalInstructions?: string[],
): string {
  const parts = [basePrompt];

  // Discovered CLAUDE.md files
  for (const inst of instructions) {
    parts.push(`\nInstructions from: ${inst.path}\n${inst.content}`);
  }

  // Config-specified instructions (D034)
  if (additionalInstructions?.length) {
    for (const inst of additionalInstructions) {
      parts.push(`\n${inst}`);
    }
  }

  return parts.join("\n");
}
```

> **Design note**: The system prompt is built by the SessionManager (Task 7), not the TUI. This ensures the same prompt construction logic applies regardless of whether the consumer is a TUI or a future protocol layer.

**Verify:** `bun test config-instructions` — finds CLAUDE.md at cwd, traverses up to .git boundary, truncates large files, handles missing files, builds combined system prompt.

---

### Task 5: Session Entry Types + JSONL Persistence

**Files:** `core/src/session/types.ts`, `core/src/session/persistence.ts`, `core/test/session-types.test.ts`, `core/test/session-persistence.test.ts`
**Decisions:** D036-REV, D042, D043

Session data model and JSONL read/write.

#### 5a: Session Entry Types

```typescript
// session/types.ts
import type { Message } from "../types";

/** Session file format version. Increment when entry schema changes. */
export const SESSION_VERSION = 1;

/** Unique entry ID — 8-char hex */
export function generateEntryId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/** Unique session ID — timestamp + random suffix for sorting */
export function generateSessionId(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHmmss
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 6);
  return `${ts}-${rand}`;
}

// --- Session Header (first line of JSONL) ---

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;    // ISO 8601
  cwd: string;
  parentSession?: string; // for forked sessions
}

// --- Session Entries (subsequent lines) ---

export interface SessionMessageEntry {
  type: "message";
  id: string;
  parentId: string | null; // null for first entry
  timestamp: string;
  message: Message;
}

export interface ModelChangeEntry {
  type: "model_change";
  id: string;
  parentId: string | null;
  timestamp: string;
  provider: string;
  modelId: string;
}

export interface SessionInfoEntry {
  type: "session_info";
  id: string;
  parentId: string | null;
  timestamp: string;
  name?: string;
}

export type SessionEntry =
  | SessionMessageEntry
  | ModelChangeEntry
  | SessionInfoEntry;

/** Any line in a session file */
export type SessionFileLine = SessionHeader | SessionEntry;

// --- Session Metadata (for listing) ---

export interface SessionInfo {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstUserMessage?: string;
}
```

> **Note**: `CompactionEntry` is deferred to Phase 3b. Phase 3a sessions that exceed context length will hit the existing `context_overflow` ProviderError — the retry logic already handles this (non-retryable, immediate failure with clear error message).

#### 5b: JSONL Persistence

```typescript
// session/persistence.ts
import type { SessionHeader, SessionEntry, SessionFileLine, SessionInfo } from "./types";
import { SESSION_VERSION, generateSessionId } from "./types";
import { join } from "node:path";

/**
 * Write a session header to a new JSONL file.
 * Returns the file path.
 */
export async function createSessionFile(
  sessionsDir: string,
  cwd: string,
  parentSession?: string,
): Promise<{ path: string; header: SessionHeader }> {
  const id = generateSessionId();
  const header: SessionHeader = {
    type: "session",
    version: SESSION_VERSION,
    id,
    timestamp: new Date().toISOString(),
    cwd,
    parentSession,
  };
  const path = join(sessionsDir, `${id}.jsonl`);
  await Bun.write(path, JSON.stringify(header) + "\n");
  return { path, header };
}

/**
 * Append a single entry to a session file.
 * Append-only: never modifies existing lines.
 */
export async function appendEntry(
  sessionPath: string,
  entry: SessionEntry,
): Promise<void> {
  const file = Bun.file(sessionPath);
  const existing = await file.text();
  await Bun.write(sessionPath, existing + JSON.stringify(entry) + "\n");
}

/**
 * Read all lines from a session file.
 * Validates header version.
 */
export async function readSessionFile(
  path: string,
): Promise<{ header: SessionHeader; entries: SessionEntry[] }> {
  const text = await Bun.file(path).text();
  const lines = text.trim().split("\n").filter(Boolean);

  if (lines.length === 0) {
    throw new Error(`Empty session file: ${path}`);
  }

  const header = JSON.parse(lines[0]) as SessionHeader;
  if (header.type !== "session") {
    throw new Error(`Invalid session header in: ${path}`);
  }
  if (header.version > SESSION_VERSION) {
    throw new Error(
      `Session file version ${header.version} is newer than supported version ${SESSION_VERSION}. ` +
      `Please update diligent.`
    );
  }

  const entries = lines.slice(1).map((line) => JSON.parse(line) as SessionEntry);
  return { header, entries };
}

/**
 * List all sessions in a directory.
 * Returns SessionInfo sorted by modified date (most recent first).
 */
export async function listSessions(sessionsDir: string): Promise<SessionInfo[]> {
  const glob = new Bun.Glob("*.jsonl");
  const sessions: SessionInfo[] = [];

  for await (const file of glob.scan(sessionsDir)) {
    try {
      const path = join(sessionsDir, file);
      const { header, entries } = await readSessionFile(path);

      const messageEntries = entries.filter((e) => e.type === "message");
      const firstUser = messageEntries.find(
        (e) => e.type === "message" && e.message.role === "user",
      );
      const lastEntry = entries[entries.length - 1];
      const nameEntry = entries.findLast((e) => e.type === "session_info" && e.name);

      sessions.push({
        id: header.id,
        path,
        cwd: header.cwd,
        name: nameEntry?.type === "session_info" ? nameEntry.name : undefined,
        created: new Date(header.timestamp),
        modified: lastEntry ? new Date(lastEntry.timestamp) : new Date(header.timestamp),
        messageCount: messageEntries.length,
        firstUserMessage: firstUser?.type === "message" && typeof firstUser.message.content === "string"
          ? firstUser.message.content.slice(0, 100)
          : undefined,
      });
    } catch {
      // Skip corrupted session files
    }
  }

  return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/**
 * Deferred persistence manager (D042).
 * Accumulates entries in memory until the first assistant message arrives,
 * then flushes all at once.
 */
export class DeferredWriter {
  private pendingEntries: SessionEntry[] = [];
  private flushed = false;
  private sessionPath: string | null = null;

  constructor(
    private sessionsDir: string,
    private cwd: string,
  ) {}

  /** Queue an entry. Triggers flush if first assistant message. */
  async write(entry: SessionEntry): Promise<void> {
    this.pendingEntries.push(entry);

    if (!this.flushed && entry.type === "message" && entry.message.role === "assistant") {
      await this.flush();
    } else if (this.flushed && this.sessionPath) {
      await appendEntry(this.sessionPath, entry);
    }
  }

  /** Force flush all pending entries to disk. */
  async flush(): Promise<string> {
    if (this.flushed && this.sessionPath) return this.sessionPath;

    const { path } = await createSessionFile(this.sessionsDir, this.cwd);
    this.sessionPath = path;

    for (const entry of this.pendingEntries) {
      await appendEntry(path, entry);
    }

    this.flushed = true;
    this.pendingEntries = [];
    return path;
  }

  get path(): string | null {
    return this.sessionPath;
  }

  get isFlushed(): boolean {
    return this.flushed;
  }
}
```

> **Performance note**: `appendEntry` reads the entire file and rewrites it. For Phase 3a this is acceptable (session files are small). Phase 3b can optimize with `Bun.file().writer()` for true append if needed.

**Verify:** `bun test session-types session-persistence` — session file created with header, entries appended, read-back matches, deferred writer only writes on first assistant message, listing sorts by modified date, version validation rejects future versions.

---

### Task 6: Context Builder — Tree Traversal

**Files:** `core/src/session/context-builder.ts`, `core/test/session-context-builder.test.ts`
**Decisions:** D040

Build a linear message list from tree-structured session entries.

```typescript
// session/context-builder.ts
import type { SessionEntry, SessionMessageEntry, ModelChangeEntry } from "./types";
import type { Message } from "../types";

export interface SessionContext {
  messages: Message[];
  currentModel?: { provider: string; modelId: string };
}

/**
 * Build linear context from tree-structured entries.
 *
 * Algorithm:
 * 1. Build byId index
 * 2. Walk from leafId to root via parentId chain
 * 3. Reverse to chronological order
 * 4. Extract messages + track latest model setting
 */
export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
): SessionContext {
  if (entries.length === 0) {
    return { messages: [] };
  }

  // Build index
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }

  // Find leaf: specified leafId, or last entry
  const leaf = leafId
    ? byId.get(leafId)
    : entries[entries.length - 1];

  if (!leaf) {
    return { messages: [] };
  }

  // Walk from leaf to root
  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse(); // Chronological order

  // Extract messages and settings
  const messages: Message[] = [];
  let currentModel: { provider: string; modelId: string } | undefined;

  for (const entry of path) {
    switch (entry.type) {
      case "message":
        messages.push(entry.message);
        break;
      case "model_change":
        currentModel = { provider: entry.provider, modelId: entry.modelId };
        break;
      // session_info: no effect on context
    }
  }

  return { messages, currentModel };
}
```

**Verify:** `bun test session-context-builder` — linear path extraction, branched tree picks correct branch, model tracking extracts latest model, empty entries returns empty context.

---

### Task 7: SessionManager

**Files:** `core/src/session/manager.ts`, `core/test/session-manager.test.ts`
**Decisions:** D086, D040

The central mediator class. Wraps `agentLoop()`, owns session lifecycle, handles persistence.

```typescript
// session/manager.ts
import type { AgentEvent, AgentLoopConfig } from "../agent/types";
import type { EventStream } from "../event-stream";
import type { Message } from "../types";
import type { DiligentConfig } from "../config/schema";
import type { DiligentPaths } from "../infrastructure/diligent-dir";
import type { SessionHeader, SessionEntry, SessionInfo } from "./types";
import { agentLoop } from "../agent/loop";
import { generateEntryId } from "./types";
import { DeferredWriter, readSessionFile, listSessions } from "./persistence";
import { buildSessionContext } from "./context-builder";

export interface SessionManagerConfig {
  cwd: string;
  paths: DiligentPaths;
  agentConfig: AgentLoopConfig;
}

export interface CreateSessionOptions {
  parentSession?: string;
}

export interface ResumeSessionOptions {
  sessionId?: string;    // specific session ID
  mostRecent?: boolean;  // resume most recent session
}

export class SessionManager {
  private entries: SessionEntry[] = [];
  private leafId: string | null = null;
  private header: SessionHeader | null = null;
  private writer: DeferredWriter;
  private byId = new Map<string, SessionEntry>();

  constructor(private config: SessionManagerConfig) {
    this.writer = new DeferredWriter(config.paths.sessions, config.cwd);
  }

  /** Create a new session */
  async create(options?: CreateSessionOptions): Promise<void> {
    this.entries = [];
    this.leafId = null;
    this.byId.clear();
    this.writer = new DeferredWriter(this.config.paths.sessions, this.config.cwd);
  }

  /** Resume an existing session */
  async resume(options: ResumeSessionOptions): Promise<boolean> {
    let sessionPath: string | undefined;

    if (options.sessionId) {
      const sessions = await listSessions(this.config.paths.sessions);
      const session = sessions.find((s) => s.id === options.sessionId);
      sessionPath = session?.path;
    } else if (options.mostRecent) {
      const sessions = await listSessions(this.config.paths.sessions);
      sessionPath = sessions[0]?.path;
    }

    if (!sessionPath) return false;

    const { header, entries } = await readSessionFile(sessionPath);
    this.header = header;
    this.entries = entries;
    this.byId.clear();
    for (const entry of entries) {
      this.byId.set(entry.id, entry);
    }
    this.leafId = entries.length > 0 ? entries[entries.length - 1].id : null;

    // Resume writer with existing file
    this.writer = new DeferredWriter(this.config.paths.sessions, this.config.cwd);
    // Force writer to use existing file (write pending entries to existing path)
    // This requires extending DeferredWriter to accept an existing session path

    return true;
  }

  /** List available sessions */
  async list(): Promise<SessionInfo[]> {
    return listSessions(this.config.paths.sessions);
  }

  /**
   * Run the agent loop with the current session context.
   * Persists user message and agent response to session.
   */
  run(userMessage: Message): EventStream<AgentEvent, Message[]> {
    // 1. Add user message to entries
    const userEntry = this.appendEntry({
      type: "message",
      message: userMessage,
    });

    // 2. Build context from tree
    const context = buildSessionContext(this.entries, this.leafId);

    // 3. Run agent loop
    const stream = agentLoop(context.messages, this.config.agentConfig);

    // 4. Subscribe to events to persist responses
    this.observeStream(stream);

    return stream;
  }

  /** Fork the current session at a specific entry */
  async fork(atEntryId?: string): Promise<SessionManager> {
    const forkedManager = new SessionManager(this.config);
    await forkedManager.create({ parentSession: this.header?.id });

    // Copy entries up to the fork point
    const path = this.getPathTo(atEntryId ?? this.leafId);
    for (const entry of path) {
      forkedManager.appendEntry({
        type: entry.type,
        ...(entry as any), // Copy entry data
      });
    }

    return forkedManager;
  }

  // --- Internal ---

  private appendEntry(data: Omit<SessionEntry, "id" | "parentId" | "timestamp">): SessionEntry {
    const entry: SessionEntry = {
      ...data,
      id: generateEntryId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
    } as SessionEntry;

    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;

    // Persist (deferred until first assistant message)
    this.writer.write(entry);

    return entry;
  }

  private observeStream(stream: EventStream<AgentEvent, Message[]>): void {
    // Spawn async observer that persists responses
    (async () => {
      for await (const event of stream) {
        if (event.type === "message_end") {
          this.appendEntry({
            type: "message",
            message: event.message,
          });
        } else if (event.type === "tool_end") {
          // Tool results are part of the message flow —
          // they're captured as ToolResultMessages in the agent loop's
          // message array, which gets persisted via turn_end events
        } else if (event.type === "turn_end") {
          // Persist all tool results from this turn
          for (const toolResult of event.toolResults) {
            this.appendEntry({
              type: "message",
              message: toolResult,
            });
          }
        }
      }
    })();
  }

  private getPathTo(targetId: string | null): SessionEntry[] {
    if (!targetId) return [];
    const path: SessionEntry[] = [];
    let current = this.byId.get(targetId);
    while (current) {
      path.push(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }
    return path.reverse();
  }
}
```

> **Design decision**: The `SessionManager` creates the `EventStream` by calling `agentLoop()` and then observes it to persist entries. The TUI also observes the same stream for rendering. This means `agentLoop()` remains a pure stateless function — all state management lives in SessionManager.

> **Known simplification**: The `observeStream` approach requires the stream to support multiple consumers. Our `EventStream` implementation uses a single async iterator — we may need to add a `tee()` or `observe()` method, or use a different approach (callback-based observation before events reach the iterator). This will be refined during implementation.

**Verify:** `bun test session-manager` — create session, run agent loop (mock), entries persisted, resume loads history, context builder receives correct messages, fork copies entries.

---

### Task 8: TUI Integration + Config Wiring

**Files:** `cli/src/config.ts`, `cli/src/index.ts`, `cli/src/tui/app.ts`, `cli/test/config.test.ts`
**Decisions:** D032-D035, D086

Wire everything together. TUI uses SessionManager, config comes from JSONC.

#### 8a: CLI Config Rewrite

```typescript
// cli/src/config.ts — REWRITE
import {
  loadDiligentConfig,
  discoverInstructions,
  buildSystemPrompt,
  type DiligentConfig,
  type DiscoveredInstruction,
} from "@diligent/core";

export interface ResolvedConfig {
  diligent: DiligentConfig;
  instructions: DiscoveredInstruction[];
  systemPrompt: string;
  sources: string[];  // config files that were loaded
}

const BASE_SYSTEM_PROMPT = [
  "You are a coding assistant. You help developers by reading, editing, and searching code.",
  "Use tools to interact with the filesystem and execute commands.",
].join("\n");

export async function resolveConfig(cwd: string): Promise<ResolvedConfig> {
  const { config, sources } = await loadDiligentConfig(cwd);
  const instructions = await discoverInstructions(cwd);

  const systemPrompt = buildSystemPrompt(
    config.systemPrompt ?? BASE_SYSTEM_PROMPT,
    instructions,
    config.instructions,
  );

  return { diligent: config, instructions, systemPrompt, sources };
}
```

#### 8b: CLI Entry Point

```typescript
// cli/src/index.ts — MODIFY
import { parseArgs } from "node:util";
import { resolveConfig } from "./config";
import { App } from "./tui/app";
import { ensureDiligentDir, resolvePaths } from "@diligent/core";

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      continue: { type: "boolean", short: "c" },
      list: { type: "boolean", short: "l" },
    },
  });

  const cwd = process.cwd();

  // Ensure .diligent/ directory
  const paths = await ensureDiligentDir(cwd);

  // Load config
  const config = await resolveConfig(cwd);

  if (values.list) {
    // List sessions and exit
    const { listSessions } = await import("@diligent/core");
    const sessions = await listSessions(paths.sessions);
    if (sessions.length === 0) {
      console.log("No sessions found.");
    } else {
      for (const [i, s] of sessions.entries()) {
        const date = s.modified.toISOString().slice(0, 16).replace("T", " ");
        const preview = s.firstUserMessage ?? "(no messages)";
        console.log(`  ${i + 1}. [${date}] ${preview} (${s.messageCount} messages)`);
      }
    }
    return;
  }

  const app = new App(config, paths, { resume: values.continue });
  await app.start();
}

main().catch((err) => {
  console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
```

#### 8c: App Changes

The `App` class receives `SessionManager` configuration instead of a raw `AgentLoopConfig`. Key changes:

1. `App` constructor accepts `ResolvedConfig`, `DiligentPaths`, and resume options
2. On start, `App` creates a `SessionManager` with the config
3. If `--continue`, `App` calls `sessionManager.resume({ mostRecent: true })`
4. On user message, `App` calls `sessionManager.run(userMessage)` instead of `agentLoop()`
5. Session history is loaded from SessionManager, not maintained in App's `messages[]` array

```typescript
// tui/app.ts — key changes (sketch, not full file)

class App {
  private sessionManager: SessionManager;

  constructor(
    private resolvedConfig: ResolvedConfig,
    private paths: DiligentPaths,
    private options: { resume?: boolean },
  ) {
    // SessionManager setup happens in start()
  }

  async start(): Promise<void> {
    // Build tools (same as before)
    const tools = [bashTool, createReadTool(), ...];

    // Build AgentLoopConfig
    const agentConfig: AgentLoopConfig = {
      model: resolveModel(this.resolvedConfig.diligent),
      systemPrompt: this.resolvedConfig.systemPrompt,
      tools,
      streamFunction: createAnthropicStream(apiKey),
    };

    // Create SessionManager
    this.sessionManager = new SessionManager({
      cwd: process.cwd(),
      paths: this.paths,
      agentConfig,
    });

    // Resume or create session
    if (this.options.resume) {
      const resumed = await this.sessionManager.resume({ mostRecent: true });
      if (resumed) {
        this.terminal.writeLine("Resuming previous session...\n");
      }
    } else {
      await this.sessionManager.create();
    }

    // ... rest of input loop (same structure, but use sessionManager.run() instead of agentLoop())
  }

  private async handleUserInput(text: string): Promise<void> {
    const userMessage: UserMessage = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    };

    // Use SessionManager instead of agentLoop directly
    const stream = this.sessionManager.run(userMessage);

    for await (const event of stream) {
      this.handleAgentEvent(event);
    }
  }
}
```

**Verify:** `bun test config` (cli) — JSONC config loaded, CLAUDE.md discovered, system prompt includes instructions.

Manual verification: `bunx diligent` with a `diligent.jsonc` + `CLAUDE.md` in project root.

---

## Migration Notes

Phase 2 stubs and placeholders replaced in Phase 3a:

- **Config system** — was `process.env.ANTHROPIC_API_KEY` + `process.env.DILIGENT_MODEL`, now full JSONC config with 3-layer hierarchy (D032-D033).
- **System prompt** — was hardcoded 5-line prompt, now built from config + CLAUDE.md discovery (D035).
- **Session persistence** — was in-memory `messages[]` array in App, now JSONL files in `.diligent/sessions/` with tree structure (D036-REV).
- **Agent loop invocation** — was direct `agentLoop()` call from TUI, now through `SessionManager.run()` mediator (D086).
- **ApprovalRequest** — was `{ permission, description }`, now adds `toolName` and `details` fields (D086).
- **approve() return** — was `Promise<boolean>`, now `Promise<ApprovalResponse>` (`"once" | "always" | "reject"`). Still auto-returns `"once"` (D086).
- **AgentEvent** — message/tool event groups now carry `itemId` for protocol readiness (D086).
- **Error in events** — was raw `Error` instance (non-serializable), now `SerializableError` (D086).

---

## Acceptance Criteria

1. `bun install` — resolves all dependencies including `jsonc-parser`
2. `bun test` — all unit tests pass (Phase 1 + Phase 2 + Phase 3a)
3. **Config loading** — `diligent.jsonc` parsed with Zod validation, unknown keys rejected
4. **Config hierarchy** — global < project < env. `ANTHROPIC_API_KEY` env var still works
5. **CLAUDE.md** — discovered via findUp, injected into system prompt
6. **Template substitution** — `{env:VAR}` in config values replaced
7. **`.diligent/`** — directory auto-created on first run with `.gitignore`
8. **Session create** — new session creates JSONL file after first assistant response (deferred write)
9. **Session persist** — messages written as JSONL entries with tree structure (id/parentId)
10. **Session resume** — `--continue` flag loads most recent session, conversation history intact
11. **Session list** — `--list` flag shows sessions sorted by modified date
12. **Context builder** — tree traversal produces correct linear message list
13. **SessionManager** — wraps agentLoop(), handles create/resume/fork
14. **itemId** — grouped events carry stable itemId per message/tool group
15. **ApprovalResponse** — type expanded, auto-returns "once", tools handle correctly
16. **Serialization** — all AgentEvent variants, Messages, and session entries pass JSON roundtrip
17. **Backward compat** — Phase 2 E2E test still passes (no regressions)

---

## Testing Strategy

| Category | What to Test | How |
|----------|-------------|-----|
| Unit | Config Zod schema | `bun test` — valid configs pass, invalid rejected, defaults applied |
| Unit | Config merge | `bun test` — deep merge, instruction concatenation, env overrides |
| Unit | JSONC parsing | `bun test` — comments stripped, trailing commas handled |
| Unit | Template substitution | `bun test` — `{env:VAR}` replaced, missing var → empty string |
| Unit | CLAUDE.md discovery | `bun test` — findUp traversal, .git boundary, truncation, missing file |
| Unit | Session entry types | `bun test` — ID generation uniqueness, serialization roundtrip |
| Unit | JSONL read/write | `bun test` — create file, append entry, read back, line format |
| Unit | Deferred writer | `bun test` — delays write until assistant message, flushes all pending |
| Unit | Session listing | `bun test` — sorts by modified date, handles corrupted files, preview |
| Unit | Tree traversal | `bun test` — linear path, branched tree, model tracking |
| Unit | SessionManager create | `bun test` — creates empty session, entries array empty |
| Unit | SessionManager resume | `bun test` — loads JSONL, rebuilds index, leafId correct |
| Unit | SessionManager run | `bun test` — calls agentLoop with context, persists response |
| Unit | D086 serialization | `bun test` — all event variants roundtrip, Error serialized |
| Unit | D086 approval types | `bun test` — ApprovalResponse type, auto-returns "once" |
| Integration | Config + instructions | `bun test` — full system prompt with config + CLAUDE.md |
| Integration | Session lifecycle | `bun test` — create → run → persist → resume → verify history |
| Manual | Config respected | Run CLI with `diligent.jsonc` → verify model/instructions honored |
| Manual | CLAUDE.md injection | Create CLAUDE.md → run CLI → verify prompt includes instructions |
| Manual | Session resume | Start session → exit → `--continue` → verify conversation continues |
| Manual | Session listing | Run several sessions → `--list` → verify sorted listing |
| E2E | Full workflow | `bun run test:e2e` — create session, chat, exit, resume, verify |

---

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|-----------|
| EventStream single-consumer limitation | SessionManager and TUI both need to read the stream | Implement observer pattern or tee() on EventStream. Alternative: SessionManager observes via callback, not iterator |
| Deferred writer loses data on crash | Session file not written yet when process crashes | Acceptable for Phase 3a — deferred write prevents abandoned empty files (D042). Force-flush on SIGINT/SIGTERM |
| JSONL append performance | Re-reading entire file on each append | Acceptable for Phase 3a (small files). Optimize with streaming append in Phase 3b |
| Config Zod strict mode too strict | Users get confusing errors from unknown keys | Clear error messages pointing to the invalid key. Consider `.passthrough()` with warnings instead |
| CLAUDE.md findUp traverses too far | In deeply nested monorepos, may find wrong CLAUDE.md | Stop at .git boundary. Document behavior clearly |
| Session files accumulate | No cleanup mechanism for old sessions | Acceptable for Phase 3a. Add archiving/cleanup in Phase 4 |
| Tree structure complexity | Branching adds complexity vs linear model | Phase 3a uses linear-only (no explicit branching UI). Tree structure prepared for Phase 3b fork support |
| Breaking change: approve() return type | Existing tools compare result to boolean | Update all tools to check for ApprovalResponse string. "once"/"always" → proceed, "reject" → error |

---

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| D032 | JSONC with Zod validation | Config schema + loading |
| D033 | 3-layer hierarchy (global, project, CLI/env) | Config loader |
| D034 | Deep merge with array concatenation for instructions | Config merge logic |
| D035 | CLAUDE.md discovery via findUp | Instructions module |
| D036-REV | JSONL sessions in `.diligent/sessions/` | Session persistence |
| D040 | Session listing, resume, fork | SessionManager + persistence |
| D042 | Deferred persistence (write on first assistant) | DeferredWriter |
| D043 | Session version header | SessionHeader.version |
| D080 | `.diligent/` project data directory | Infrastructure module |
| D086 | SessionManager + itemId + ApprovalResponse + serialization | Multiple: agent types, tool types, session manager |
| D028 | `ctx.ask()` pattern for approval | ApprovalRequest expanded |
| D029 | `ApprovalResponse` = once/always/reject | ToolContext.approve() return type |

---

## What Phase 3a Does NOT Include

- **No compaction** — Sessions that exceed context length will error. Compaction (D037) is Phase 3b
- **No knowledge system** — No `add_knowledge` tool, no knowledge store, no knowledge injection. Full knowledge system (D081-D084) is Phase 3b
- **No multi-provider** — Still Anthropic only. OpenAI provider is Phase 3b
- **No session branching UI** — Tree structure is in the data model but there's no UI for switching branches. Interactive branching deferred
- **No config editing** — Config is read-only in Phase 3a. `/settings` command deferred to Phase 4
- **No JSONC comment preservation** — Config edits (when added) may strip comments (D074)
- **No session archiving/cleanup** — Old sessions accumulate. Cleanup mechanism deferred
- **No enterprise/managed config** — 3 layers only (global, project, env). Enterprise layer deferred
- **No hot reload** — Config loaded once at startup. Runtime config changes require restart
- **No file locking** — Config reads are not locked (D073). Atomic write for safety
- **No session naming** — Sessions are identified by ID + first message preview
- **No `--continue <N>` with index** — Only `--continue` (most recent) in Phase 3a. Index-based resume can be added when session listing UI is built

---

## Phase 3b Forward Reference

Phase 3b will build on Phase 3a's SessionManager and persistence to add:

1. **LLM Compaction** (D037) — Summarization, cut points, iterative updating, context re-injection (D041), pre-compaction knowledge flush (D084)
2. **Knowledge System** (D081-D084) — Knowledge store, `add_knowledge` tool, knowledge injection in system prompt, turn_end nudge
3. **OpenAI Provider** — Second provider validates multi-provider abstraction, provider registry pattern
4. **Compaction Entry Type** — New `SessionEntry` variant for compaction markers
5. **Token-based Compaction Trigger** (D038) — Hybrid estimation (actual usage + chars/4)
6. **File Operation Tracking** (D039) — `CompactionDetails` with cumulative carry-forward

Phase 3b plan will be written after Phase 3a is complete and tested.
