# Layer 6: Session

## Problem Definition

The Session layer provides **conversation persistence and context management** for the coding agent. It sits above the Agent Loop (L1) and Config (L5), providing the stateful memory that turns a single-turn LLM interaction into a multi-turn collaborative session. The session layer must:

1. Persist conversation history across process restarts (crash recovery, resume)
2. Structure conversation data for efficient retrieval and context building
3. Implement context compaction when the conversation exceeds the LLM's context window
4. Support branching and forking (explore alternatives without losing history)
5. Provide session listing, resume, and management operations
6. Track file operations across compactions so the LLM maintains file awareness
7. Handle session versioning and forward migration
8. Integrate with the agent loop for context building (what messages go to the LLM)

### Key Questions

1. What is the session storage format and data model?
2. How is conversation history structured (linear, tree, relational)?
3. How is context built from stored entries for the LLM?
4. When and how is compaction triggered?
5. What is the compaction algorithm (summarization, pruning, cut points)?
6. How does iterative summary updating work across multiple compactions?
7. How are file operations tracked and preserved across compactions?
8. How does initial context re-injection work after compaction?
9. How are sessions listed, resumed, and forked?
10. How does session version migration work?
11. When is the session file first written to disk (deferred persistence)?
12. How does the session interact with multi-agent (sub-agent sessions)?

### Layer Scope

- Session storage format (JSONL, SQLite, in-memory)
- Session data model (entry types, header, metadata)
- Tree structure for branching (id/parentId, leafId pointer)
- Context building from stored entries (path traversal, message extraction)
- Compaction trigger logic (token-based, configurable thresholds)
- Compaction algorithm (LLM summarization, cut point detection, pruning)
- Iterative summary updating (merge new information into existing summary)
- File operation tracking (read/modified files across compactions)
- Initial context re-injection after compaction
- Session lifecycle operations (create, list, resume, fork, archive)
- Session version migration (forward-compatible schema evolution)
- Deferred persistence (write-on-first-assistant-message)

### Layer Boundaries

- **Depends on L0 (Provider)**: Compaction uses an LLM call for summarization
- **Depends on L1 (Agent Loop)**: Session provides history/context to the agent loop
- **Depends on L5 (Config)**: Compaction settings, session directory paths from config
- **Consumed by L7 (TUI & Commands)**: Session listing, resume, branch UI
- **Consumed by L10 (Multi-Agent)**: Sub-agent sessions use the same persistence

---

## codex-rs Analysis

### Source Files

- `core/src/context_manager/history.rs` -- ContextManager (in-memory history)
- `core/src/compact.rs` -- compaction logic (run_compact_task_inner, build_compacted_history)
- `core/src/compact_remote.rs` -- remote compaction (OpenAI-specific)
- `core/src/rollout/recorder.rs` -- RolloutRecorder (JSONL persistence)
- `core/src/rollout/mod.rs` -- rollout module (session discovery)
- `core/src/rollout/list.rs` -- session listing and discovery
- `protocol/src/protocol.rs` -- RolloutItem, SessionMeta, CompactedItem types

### Storage Model

**In-memory `ContextManager`** as primary store, with JSONL rollout files for crash recovery and session replay.

```rust
pub(crate) struct ContextManager {
    items: Vec<ResponseItem>,
    token_info: Option<TokenUsageInfo>,
    reference_context_item: Option<TurnContextItem>,
}
```

The `ContextManager` holds the active conversation as a vector of `ResponseItem` values. Key operations:

- `record_items()` -- append new items with truncation policy applied
- `replace()` -- replace entire history (used after compaction)
- `clone()` -- deep copy for compaction without affecting active conversation
- `raw_items()` -- access full history as a slice
- `remove_first_item()` -- trim oldest item when context overflows during compaction
- `for_prompt()` -- filter items for the specific model's input modalities

The `reference_context_item` field tracks the baseline context state for diffing. When set to `None` (e.g., after pre-turn compaction), the next regular turn triggers a full re-injection of context state.

### Rollout Persistence (JSONL)

Rollout files are JSONL files stored at `~/.codex/sessions/rollout-<timestamp>-<uuid>.jsonl`. Each line is a timestamped `RolloutLine`:

```rust
pub struct RolloutLine {
    pub timestamp: String,
    pub item: RolloutItem,
}

pub enum RolloutItem {
    SessionMeta(SessionMetaLine),
    ResponseItem(ResponseItem),
    Compacted(CompactedItem),
    TurnContext(TurnContextItem),
    EventMsg(EventMsg),
}
```

The `SessionMeta` header includes:

```rust
pub struct SessionMeta {
    pub id: ThreadId,
    pub forked_from_id: Option<ThreadId>,
    pub timestamp: String,
    pub cwd: PathBuf,
    pub originator: String,
    pub cli_version: String,
    pub source: SessionSource,  // Cli, VSCode, etc.
    pub agent_nickname: Option<String>,
    pub agent_role: Option<String>,
    pub model_provider: Option<String>,
    pub base_instructions: Option<BaseInstructions>,
    pub dynamic_tools: Option<Vec<DynamicToolSpec>>,
}
```

The `RolloutRecorder` manages writing:

```rust
pub struct RolloutRecorder {
    tx: Sender<RolloutCmd>,
    pub(crate) rollout_path: PathBuf,
    state_db: Option<StateDbHandle>,
    event_persistence_mode: EventPersistenceMode,
}
```

It uses an async channel (`mpsc::Sender<RolloutCmd>`) with commands `AddItems`, `Persist`, and `Flush`. Items are appended to the JSONL file after each turn. A `StateDbHandle` optionally persists metadata to a SQLite database for fast listing.

### Compaction Algorithm

**`run_compact_task_inner()`** orchestrates the compaction:

1. **Clone history**: Deep-copy the current `ContextManager` to avoid mutating the active session
2. **Strip model-switch messages**: Remove `<model_switch>` developer messages that would confuse the compaction model
3. **Append compaction prompt**: Add the user-facing compaction instruction as a `ResponseInputItem`
4. **Stream LLM response**: Send the entire history + prompt to the LLM, streaming back a summary
5. **Build compacted history**: Call `build_compacted_history()` with the LLM's summary output
6. **Re-inject initial context**: If mid-turn compaction, inject system prompt/AGENTS.md before the last user message
7. **Reattach model-switch item**: Restore the stripped model-switch message for the next real turn
8. **Preserve ghost snapshots**: Copy git snapshot items from old history to new
9. **Replace session history**: Swap the old `ContextManager` contents with the compacted history
10. **Persist rollout**: Write a `Compacted` rollout item with the summary and replacement history

**`build_compacted_history()`** constructs the post-compaction conversation:

```rust
fn build_compacted_history_with_limit(
    mut history: Vec<ResponseItem>,
    user_messages: &[String],
    summary_text: &str,
    max_tokens: usize,
) -> Vec<ResponseItem>
```

Algorithm:
- Collect user messages from history via `collect_user_messages()` (filters out AGENTS.md, environment context, summary messages)
- Walk backwards through user messages, keeping recent ones within `COMPACT_USER_MESSAGE_MAX_TOKENS` (20,000 tokens)
- Truncate an overlong user message if it exceeds the remaining budget
- Build new history: kept user messages + summary message

The summary is prefixed with a `SUMMARY_PREFIX` (loaded from `templates/compact/summary_prefix.md`).

### Compaction Trigger

Two trigger modes via `InitialContextInjection` enum:

```rust
pub(crate) enum InitialContextInjection {
    BeforeLastUserMessage,  // mid-turn auto-compaction
    DoNotInject,            // pre-turn/manual compaction
}
```

- **Auto-compaction**: Triggered during streaming when the model's context window is exceeded. Uses `BeforeLastUserMessage` mode to inject initial context into the replacement history.
- **Manual compaction**: User triggers via `Op::Compact`. Uses `DoNotInject` mode -- clears `reference_context_item` so the next regular turn reinjects context naturally.

The auto-compaction threshold is configured via `model_auto_compact_token_limit` in the config.

### Initial Context Re-injection

After compaction, system-level context (system prompt, AGENTS.md, environment info) must be re-injected because the summary may not capture these. The function `insert_initial_context_before_last_real_user_or_summary()` handles placement:

- **Preferred**: Insert before the last real user message
- **Fallback 1**: Insert before the last summary message (user-role message starting with SUMMARY_PREFIX)
- **Fallback 2**: Insert before the last `Compaction` item
- **Final fallback**: Append at the end

This ensures the model always sees current system instructions, even after heavy compaction.

### Error Handling During Compaction

- **Retry with backoff**: On transient errors, retry up to `max_retries` with exponential backoff
- **ContextWindowExceeded**: Remove the oldest history item and retry (tracks `truncated_count`)
- **Interrupted**: Propagate cancellation immediately
- **Post-compaction warning**: Emits a warning that long threads with multiple compactions reduce accuracy

### Session Listing and Resume

codex-rs supports session listing and resume via the rollout system:

- **`get_threads()`**: Scan session directories, parse JSONL headers, return `ThreadItem` list sorted by date
- **`find_thread_path_by_id_str()`**: Find a specific session by ID
- **`ThreadItem`**: Contains `id`, `timestamp`, `model_provider`, `title`, `source`, etc.
- **Resume**: Load rollout file, replay `RolloutItem` entries to reconstruct `ContextManager` state
- **Fork**: Create new session with `forked_from_id` pointing to parent, copy history up to fork point

Session directories are organized by date: `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`.

### No Tree Structure

codex-rs uses a **linear** history model. There is no tree structure (id/parentId) on individual items. Branching is handled by creating entirely new rollout files with `forked_from_id`.

---

## pi-agent Analysis

### Source Files

- `packages/coding-agent/src/core/session-manager.ts` -- SessionManager class, entry types, tree structure
- `packages/coding-agent/src/core/compaction/compaction.ts` -- compaction logic, cut points, summarization
- `packages/coding-agent/src/core/compaction/utils.ts` -- file operation extraction, serialization
- `packages/coding-agent/src/core/compaction/branch-summarization.ts` -- branch summary generation
- `packages/coding-agent/src/core/compaction/index.ts` -- compaction entry point

### Storage Model

**JSONL append-only files** with tree structure. Each session is a single `.jsonl` file at `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<uuid>.jsonl`.

The file format is one JSON object per line. The first line is always a `SessionHeader`:

```typescript
interface SessionHeader {
    type: "session";
    version?: number;  // v1 sessions don't have this
    id: string;
    timestamp: string;
    cwd: string;
    parentSession?: string;  // for forked sessions
}
```

### Session Entry Types

Every entry (except the header) has `id` (unique 8-char hex), `parentId` (null for first entry), and `timestamp`:

```typescript
type SessionEntry =
    | SessionMessageEntry       // { type: "message", message: AgentMessage }
    | ThinkingLevelChangeEntry  // { type: "thinking_level_change", thinkingLevel }
    | ModelChangeEntry          // { type: "model_change", provider, modelId }
    | CompactionEntry           // { type: "compaction", summary, firstKeptEntryId, tokensBefore, details? }
    | BranchSummaryEntry        // { type: "branch_summary", fromId, summary, details? }
    | CustomEntry               // { type: "custom", customType, data? } -- NOT in LLM context
    | CustomMessageEntry        // { type: "custom_message", customType, content, details?, display } -- IN LLM context
    | LabelEntry                // { type: "label", targetId, label }
    | SessionInfoEntry          // { type: "session_info", name? }
```

Notable design:
- `CustomEntry` is for extension state persistence (not sent to LLM)
- `CustomMessageEntry` is for extension-injected LLM context (sent to LLM as user messages)
- `LabelEntry` provides user-defined bookmarks on entries
- `SessionInfoEntry` stores user-assigned display names
- `CompactionEntry.fromHook` distinguishes pi-generated from extension-generated compactions

### Tree Structure

The tree structure is the defining feature of pi-agent's session model. Every entry has `id` and `parentId`, forming a tree:

```
[header]
  [entry-1] (parentId: null)
    [entry-2] (parentId: entry-1)
      [entry-3] (parentId: entry-2)  <- branch A
      [entry-4] (parentId: entry-2)  <- branch B (leafId points here)
```

A `leafId` pointer tracks the current active branch tip. The `SessionManager` class manages this:

```typescript
class SessionManager {
    private sessionId: string;
    private sessionFile: string | undefined;
    private sessionDir: string;
    private cwd: string;
    private persist: boolean;
    private flushed: boolean;
    private fileEntries: FileEntry[];
    private byId: Map<string, SessionEntry>;
    private labelsById: Map<string, string>;
    private leafId: string | null;
}
```

Key tree operations:
- **Append**: New entries get `parentId = leafId`, then `leafId` updates to the new entry's `id`
- **Branch**: Move `leafId` to an earlier entry -- new appends create a fork
- **Path traversal**: Walk from `leafId` to root (via `parentId` chain) to get current conversation path

### Context Building

`buildSessionContext()` resolves the tree into a linear message list for the LLM:

```typescript
function buildSessionContext(
    entries: SessionEntry[],
    leafId?: string | null,
    byId?: Map<string, SessionEntry>,
): SessionContext
```

Algorithm:
1. Build a `byId` map if not provided (O(1) lookup)
2. Find the leaf entry (by `leafId`, or fall back to last entry)
3. Walk from leaf to root via `parentId` chain, collecting path entries
4. Reverse to chronological order
5. Extract settings: track latest `thinkingLevel` and `model` from the path
6. Find the latest `compaction` entry on the path
7. Build messages:
   - **No compaction**: Emit all message/custom_message/branch_summary entries as LLM messages
   - **With compaction**: Emit summary first, then kept messages (from `firstKeptEntryId` to compaction), then post-compaction messages
8. Return `SessionContext { messages, thinkingLevel, model }`

### Compaction Algorithm

Pi-agent's compaction is the most sophisticated of the three projects.

**Trigger**: `shouldCompact(contextTokens, contextWindow, settings)` returns true when `contextTokens > contextWindow - reserveTokens`.

**Token estimation**: `estimateTokens(message)` uses chars/4 heuristic per message type (user, assistant, toolResult, bashExecution, etc.). Images are estimated at 4800 chars (1200 tokens).

**Context token calculation**: `estimateContextTokens(messages)` uses the last assistant's `usage` field when available, then estimates tokens for messages after that point. This hybrid approach is more accurate than pure estimation.

**Cut point detection**: `findCutPoint(entries, startIndex, endIndex, keepRecentTokens)`:

1. Find valid cut points (user, assistant, custom, bashExecution messages -- never tool results)
2. Walk backwards accumulating estimated message sizes
3. Stop when accumulated tokens exceed `keepRecentTokens`
4. Find the closest valid cut point at or after the accumulation boundary
5. Determine if this splits a turn (cut point is not a user message)
6. Return `CutPointResult { firstKeptEntryIndex, turnStartIndex, isSplitTurn }`

**Preparation**: `prepareCompaction(pathEntries, settings)`:

1. Find the previous compaction entry (boundary for what to summarize)
2. Estimate total context tokens since last compaction
3. Find the cut point using `findCutPoint()`
4. Split messages into: messages to summarize vs. turn prefix messages (if split turn)
5. Extract previous summary for iterative updating
6. Extract file operations from messages and previous compaction details

**Summarization**: `generateSummary(messages, model, reserveTokens, apiKey, signal, customInstructions, previousSummary)`:

Two prompt modes:
- **Initial summarization** (no previous summary): Uses `SUMMARIZATION_PROMPT` with structured template
- **Iterative update** (has previous summary): Uses `UPDATE_SUMMARIZATION_PROMPT` that merges new information into the existing summary

The structured template:
```
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context
```

The iterative update prompt explicitly instructs:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context
- UPDATE the Progress section (move "In Progress" to "Done" when completed)
- UPDATE "Next Steps" based on accomplishments

**Split turn handling**: When compaction cuts in the middle of a turn, a separate `TURN_PREFIX_SUMMARIZATION_PROMPT` generates a summary of the turn prefix (what the user asked, early progress, context for the kept suffix). Both summaries run in parallel and are merged.

**File operation tracking**: `extractFileOperations()` collects from:
- Previous compaction's `CompactionDetails` (cumulative carry-forward)
- Tool calls in messages being summarized (via `extractFileOpsFromMessage()`)
- File operations appended to the summary text via `formatFileOperations()`

The `CompactionDetails` stored in each `CompactionEntry`:
```typescript
interface CompactionDetails {
    readFiles: string[];
    modifiedFiles: string[];
}
```

### Compaction Settings

```typescript
interface CompactionSettings {
    enabled: boolean;
    reserveTokens: number;   // default: 16384
    keepRecentTokens: number; // default: 20000
}
```

### Deferred Persistence

Pi-agent defers writing to disk until the first assistant message arrives:

```typescript
_persist(entry: SessionEntry): void {
    const hasAssistant = this.fileEntries.some(
        e => e.type === "message" && e.message.role === "assistant"
    );
    if (!hasAssistant) {
        this.flushed = false;
        return;
    }
    // Write entries...
}
```

On first flush, all accumulated entries are written at once. Subsequent entries are appended individually. This prevents empty/abandoned session files.

### Version Migration

Three versions with forward migration on load:

- **v1 -> v2**: Add `id`/`parentId` tree structure to all entries. Convert `firstKeptEntryIndex` (numeric) to `firstKeptEntryId` (string) in compaction entries.
- **v2 -> v3**: Rename `hookMessage` role to `custom` type.

Migration is detected via `header.version` (v1 sessions don't have this field, so absence means v1). When migration is applied, the entire file is rewritten.

```typescript
function migrateToCurrentVersion(entries: FileEntry[]): boolean {
    const header = entries.find(e => e.type === "session") as SessionHeader;
    const version = header?.version ?? 1;
    if (version >= CURRENT_SESSION_VERSION) return false;
    if (version < 2) migrateV1ToV2(entries);
    if (version < 3) migrateV2ToV3(entries);
    return true;
}
```

### Session Listing and Resume

**`listSessionsFromDir(dir)`**: Scan `.jsonl` files in session directory, parse each file to build `SessionInfo`:

```typescript
interface SessionInfo {
    path: string;
    id: string;
    cwd: string;
    name?: string;
    parentSessionPath?: string;
    created: Date;
    modified: Date;
    messageCount: number;
    firstMessage: string;
    allMessagesText: string;
}
```

Modified time is computed from the last activity timestamp in entries, falling back to header timestamp, then file mtime.

**`findMostRecentSession(sessionDir)`**: Find the most recently modified `.jsonl` file for continue-recent functionality.

**`setSessionFile(path)`**: Load an existing session file, validate header, migrate if needed, build index. Used for resume.

**`newSession(options?)`**: Create new session with header, optional `parentSession` for forking.

### Forking

Session forking creates a new session file that starts as a copy:
- `createBranchedSession()` -- extract a single path from the tree as a new session
- `forkFrom(sourceManager, options)` -- create new session, copy entries up to a point, set `parentSession`

The tree structure also supports in-place branching (moving `leafId`) which doesn't create a new file.

---

## opencode Analysis

### Source Files

- `packages/opencode/src/session/index.ts` -- Session namespace (CRUD, fork, events, Zod schemas)
- `packages/opencode/src/session/session.sql.ts` -- Drizzle ORM schema (SessionTable, MessageTable, PartTable)
- `packages/opencode/src/session/compaction.ts` -- SessionCompaction (prune + summarize)
- `packages/opencode/src/session/message-v2.ts` -- MessageV2 namespace (message types, parts, errors)
- `packages/opencode/src/session/processor.ts` -- SessionProcessor (doom loop detection, LLM interaction)
- `packages/opencode/src/session/prompt.ts` -- SessionPrompt (system prompt building)

### Storage Model

**SQLite** via Drizzle ORM. Three primary tables with normalized structure:

```typescript
// SessionTable
const SessionTable = sqliteTable("session", {
    id: text().primaryKey(),
    project_id: text().notNull().references(() => ProjectTable.id),
    parent_id: text(),            // for forked sessions
    slug: text().notNull(),
    directory: text().notNull(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }),
    revert: text({ mode: "json" }),
    permission: text({ mode: "json" }),  // per-session PermissionNext.Ruleset
    time_created: integer(),
    time_updated: integer(),
    time_compacting: integer(),
    time_archived: integer(),
});

// MessageTable
const MessageTable = sqliteTable("message", {
    id: text().primaryKey(),
    session_id: text().notNull().references(() => SessionTable.id),
    data: text({ mode: "json" }).notNull(),  // InfoData (role, model, tokens, etc.)
    time_created: integer(),
    time_updated: integer(),
});

// PartTable
const PartTable = sqliteTable("part", {
    id: text().primaryKey(),
    message_id: text().notNull().references(() => MessageTable.id),
    session_id: text().notNull(),
    data: text({ mode: "json" }).notNull(),  // PartData (tool, text, reasoning, etc.)
    time_created: integer(),
    time_updated: integer(),
});
```

Additional tables:
- `TodoTable` -- per-session task list items (position-ordered)
- `PermissionTable` -- per-project permission rulesets

### Session Data Model

The `Session.Info` Zod schema:

```typescript
const Info = z.object({
    id: Identifier.schema("session"),
    slug: z.string(),
    projectID: z.string(),
    directory: z.string(),
    parentID: Identifier.schema("session").optional(),  // for forked sessions
    title: z.string(),
    version: z.string(),
    summary: z.object({
        additions: z.number(),
        deletions: z.number(),
        files: z.number(),
        diffs: Snapshot.FileDiff.array().optional(),
    }).optional(),
    share: z.object({ url: z.string() }).optional(),
    revert: z.object({
        messageID: z.string(),
        partID: z.string().optional(),
        snapshot: z.string().optional(),
        diff: z.string().optional(),
    }).optional(),
    permission: PermissionNext.Ruleset.optional(),
    time: z.object({
        created: z.number(),
        updated: z.number(),
        compacting: z.number().optional(),
        archived: z.number().optional(),
    }),
});
```

Notable features:
- `permission` -- per-session permission ruleset (accumulated "always" approvals)
- `revert` -- undo metadata (messageID, partID, git snapshot, diff)
- `summary` -- git diff stats (additions, deletions, files changed)
- `share` -- session sharing URL
- `time.compacting` -- timestamp while compaction is in progress
- `time.archived` -- soft delete timestamp

### Message Model

Messages use a two-level structure: `MessageV2.Info` (message metadata) and `MessageV2.Part` (content parts):

```typescript
// Message types (discriminated on role)
type Info = User | Assistant;

// User message
interface User {
    role: "user";
    model: { providerID, modelID };
    agent?: string;
    variant?: string;
    // ...
}

// Assistant message
interface Assistant {
    role: "assistant";
    parentID: string;  // links to the user message that prompted this
    summary?: boolean; // true for compaction summaries
    mode?: string;     // "compaction" for compaction messages
    tokens: { input, output, reasoning, cache: { read, write }, total? };
    cost: number;
    modelID: string;
    providerID: string;
    error?: Error;
    // ...
}
```

Part types: `TextPart`, `ReasoningPart`, `ToolPart`, `SnapshotPart`, `PatchPart`, `CompactionPart`, `FilePart`, `StepPart`.

The `ToolPart` has a state machine:
```
pending -> running -> completed -> error
```

Each `ToolPart` has a `time.compacted` field that, when set, marks the tool output as pruned (excluded from LLM context but metadata preserved).

### Session Events

Events published via a `Bus` system for UI reactivity:

```typescript
const Event = {
    Created: BusEvent.define("session.created", z.object({ info: Info })),
    Updated: BusEvent.define("session.updated", z.object({ info: Info })),
    Deleted: BusEvent.define("session.deleted", z.object({ info: Info })),
    Diff: BusEvent.define("session.diff", z.object({ sessionID, diff })),
    Error: BusEvent.define("session.error", z.object({ sessionID, error })),
};
```

### Compaction: Two-Phase Approach

opencode uses a unique **prune-then-summarize** strategy.

**Phase 1: Prune** (`SessionCompaction.prune()`):

Walks backwards through completed tool output parts, marking old ones as compacted:

```typescript
const PRUNE_MINIMUM = 20_000;   // minimum tokens to prune
const PRUNE_PROTECT = 40_000;   // recent tokens protected from pruning
const PRUNE_PROTECTED_TOOLS = ["skill"];  // never prune skill outputs
```

Algorithm:
1. Walk backwards through messages, skipping first 2 turns (recent) and summary messages
2. For each completed tool part (not protected), estimate its token count
3. Accumulate total tokens; once past `PRUNE_PROTECT`, start marking for pruning
4. If total prunable tokens exceed `PRUNE_MINIMUM`, set `part.state.time.compacted = Date.now()` on each
5. Compacted parts remain in the database but their output is excluded from LLM context

This is a non-destructive operation -- metadata and tool call details are preserved, only the output text is hidden from the LLM.

**Phase 2: Summarize** (`SessionCompaction.process()`):

1. Get or create a "compaction" agent (may use a different/cheaper model)
2. Create an assistant message with `summary: true` and `mode: "compaction"`
3. Allow plugins to inject context or replace the compaction prompt via `Plugin.trigger("experimental.session.compacting")`
4. Send full message history + compaction prompt to the LLM
5. Store the result as a regular assistant message

The default compaction prompt:
```
Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation...

## Goal
[What goal(s) is the user trying to accomplish?]

## Instructions
[What important instructions did the user give you that are relevant]

## Discoveries
[What notable things were learned during this conversation]

## Accomplished
[What work has been completed, what's still in progress, what's left?]

## Relevant files / directories
[Structured list of relevant files]
```

**Post-compaction**: If the result is "continue" and compaction was auto-triggered, a synthetic user message is injected: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."

### Compaction Trigger

```typescript
async function isOverflow(input: { tokens, model }): boolean {
    const config = await Config.get();
    if (config.compaction?.auto === false) return false;
    const reserved = config.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, maxOutputTokens);
    const usable = model.limit.input
        ? model.limit.input - reserved
        : context - maxOutputTokens;
    return count >= usable;
}
```

`COMPACTION_BUFFER = 20_000` tokens. The trigger uses actual token counts from the API response, not estimates.

### Session Operations

**Create**: `Session.create()` generates an ID (using `Identifier.descending()` for reverse-chronological ordering), slug, inserts into `SessionTable`, publishes `Created` event. Optionally auto-shares.

**Fork**: `Session.fork({ sessionID, messageID? })`:
1. Load original session
2. Generate forked title (appends "(fork #N)")
3. Create new session
4. Copy all messages up to `messageID` (or all), remapping IDs
5. Copy all parts for each copied message

**List**: SQL queries against `SessionTable` filtered by project, date range, archived status. Ordered by `time_updated DESC`.

**Archive**: Sets `time_archived` timestamp (soft delete). Can be unarchived later.

**Permissions**: `Session.setPermission()` stores a `PermissionNext.Ruleset` per session, enabling per-session "always" approval accumulation.

**Revert**: `Session.setRevert()` stores undo metadata linking to a git snapshot.

### No Tree Structure

opencode uses a **linear** message model. Messages are stored in a flat table with ordering by ID. There is no tree structure (no parentId on messages). Branching is handled by creating entirely new sessions via `fork()`.

The `parentID` field on assistant messages links to the user message that prompted the response, but this is for associating request/response pairs, not for tree navigation.

### No Deferred Persistence

opencode writes session records to SQLite immediately upon creation. There is no deferred-write optimization. This is acceptable because SQLite handles the I/O efficiently.

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|---|---|---|---|
| **Storage** | In-memory (ContextManager) + JSONL rollout | JSONL append-only files | SQLite (Drizzle ORM) |
| **Data Model** | Linear ResponseItem vector | Tree-structured entries (id/parentId) | Normalized tables (Session/Message/Part) |
| **Tree Structure** | No (linear history) | Yes (id/parentId, leafId pointer) | No (linear, fork = new session) |
| **Entry Types** | ~5 (SessionMeta, ResponseItem, Compacted, TurnContext, EventMsg) | 9 (message, thinking_level_change, model_change, compaction, branch_summary, custom, custom_message, label, session_info) | 2 tables (Message + Part with typed parts) |
| **Compaction Trigger** | Auto (token limit) or manual (Op::Compact) | Auto (contextTokens > window - reserve) | Auto (tokens > usable) with config disable |
| **Compaction Method** | LLM summary + keep recent user messages | LLM summary + keep recent turns + file ops | Prune old tool output + LLM summary |
| **Two-Phase Compaction** | No (single pass) | No (single pass, but sophisticated cut point) | Yes (prune then summarize) |
| **Iterative Summary** | No (fresh each time) | Yes (UPDATE_SUMMARIZATION_PROMPT merges) | No (fresh each time) |
| **Summary Template** | Template from file (compiled into binary) | Goal/Constraints/Progress/Decisions/Next Steps/Critical Context | Goal/Instructions/Discoveries/Accomplished/Relevant files |
| **Token Estimation** | `approx_token_count()` (internal function) | chars/4 heuristic + actual usage hybrid | `Token.estimate()` + actual API counts |
| **File Op Tracking** | Not tracked | `CompactionDetails { readFiles, modifiedFiles }` (cumulative) | Not explicit (via tool parts metadata) |
| **Context Re-injection** | Explicit (insert_initial_context_before_last_real_user_or_summary) | Not explicit (summary carries context) | Not explicit (summary carries context) |
| **Split Turn Handling** | Not implemented | Yes (TURN_PREFIX_SUMMARIZATION_PROMPT) | Not implemented |
| **Pruning Before Summary** | Not implemented | Not implemented | Yes (PRUNE_PROTECT=40K, PRUNE_MINIMUM=20K) |
| **Protected Tools** | None | None | "skill" (never pruned) |
| **Plugin Hook** | None | Extension hooks for compaction | `experimental.session.compacting` |
| **Session Resume** | Yes (rollout replay) | Yes (load JSONL, continueRecent) | Yes (SQL queries) |
| **Session Listing** | Yes (directory scan + StateDb) | Yes (directory scan, buildSessionInfo) | Yes (SQL queries) |
| **Forking** | New rollout file with forked_from_id | In-place branching (leafId) + new session file | New session via fork() (copy messages) |
| **Per-Session Permissions** | Not stored in session | Not stored in session | `permission: PermissionNext.Ruleset` |
| **Deferred Persistence** | No (immediate rollout write) | Yes (defer until first assistant message) | No (immediate SQL insert) |
| **Version Migration** | Not applicable (rollout format stable) | v1->v2->v3 (migrate on load, rewrite file) | DB migrations via Drizzle |
| **Soft Delete** | Archive to separate directory | Not implemented | `time_archived` field |
| **Session Sharing** | Not implemented | Not implemented | Auto/manual share URL generation |
| **Git Integration** | Ghost snapshots in history | Not in session (external) | Snapshot/Revert in session metadata |
| **Complexity** | Medium (in-memory primary, rollout secondary) | High (tree structure, version migration, file tracking, split turns) | High (SQL schema, prune+summarize, snapshots, permissions, sharing) |

---

## Synthesis

### Decision Validation

The following Cycle 1 decisions are validated by Cycle 2 deep-dive research:

**D006/D036 (JSONL with tree structure)** -- VALIDATED. Pi-agent's JSONL+tree approach is the most thoroughly proven model for the features diligent needs. The tree structure (id/parentId) enables in-place branching without creating new files, and the `leafId` pointer makes branch switching cheap. codex-rs's linear model requires creating new rollout files for branching. opencode's SQLite approach is powerful but adds significant infrastructure (Drizzle ORM, migration tooling, SQL queries). JSONL is simple, append-only, and human-inspectable.

**D037 (LLM-based compaction with iterative summary updating)** -- VALIDATED AND ENRICHED. Pi-agent's iterative summary approach is confirmed as the most token-efficient strategy for repeated compactions. The `UPDATE_SUMMARIZATION_PROMPT` explicitly instructs the LLM to preserve existing information while adding new -- this avoids the quality degradation of re-summarizing already-summarized content. The structured template (Goal/Constraints/Progress/Decisions/Next Steps/Critical Context) ensures consistent, useful summaries. codex-rs's fresh-each-time approach loses information across compactions. opencode's approach is also fresh-each-time but mitigated by the prune phase reducing what needs summarizing.

**D038 (Token-based automatic trigger)** -- VALIDATED. All three projects use token-based triggers. Pi-agent's hybrid approach (actual API usage counts + chars/4 estimation for trailing messages) is the most accurate without adding dependencies. The `contextTokens > contextWindow - reserveTokens` formula is universal. Default `reserveTokens = 16384` is confirmed as a reasonable value.

**D039 (File operation tracking)** -- VALIDATED. Pi-agent's `CompactionDetails` pattern is the only implementation that explicitly tracks files across compactions. The cumulative carry-forward design (previous compaction's file lists + new messages' file operations) ensures the LLM always knows which files exist and were modified, even after multiple compactions. opencode tracks file operations implicitly through tool parts (which survive pruning) but doesn't format them explicitly for the LLM.

**D040 (Session listing, resume, forking)** -- VALIDATED. All three projects implement session management. Pi-agent's approach (scan JSONL files, parse headers + first entries for preview) is the natural fit for JSONL storage. The `SessionInfo` data model (path, id, cwd, name, created, modified, messageCount, firstMessage) provides sufficient metadata for a session picker UI. Forking should support both in-place branching (tree leafId) and new-file forking (copy entries).

**D041 (Context re-injection after compaction)** -- VALIDATED AND CRITICAL. codex-rs's implementation confirms this is essential. The `insert_initial_context_before_last_real_user_or_summary()` function with its fallback chain (last real user message > last summary > last compaction item > append) is well-tested. Pi-agent's assumption that "the summary carries enough context" is a known weakness -- the summary may not capture system instructions, AGENTS.md content, or environment context that were injected as non-user messages. Diligent should follow codex-rs's explicit re-injection pattern.

**D042 (Deferred persistence)** -- VALIDATED. Pi-agent's implementation confirms the benefit: only write to disk when the session actually has content (first assistant message). The implementation is simple (track `flushed` flag, accumulate entries in memory, write all at once on first assistant message, then append). Prevents empty session files from aborted sessions.

**D043 (Session version migration)** -- VALIDATED. Pi-agent's v1->v2->v3 migration chain demonstrates the pattern works. Key design points: version number in header, detect on load, mutate in place, rewrite file only if migration was applied. The `migrateToCurrentVersion()` function with chained version checks is clean and extensible.

### Key Insights from Cycle 2

1. **Cut point detection matters**: Pi-agent's `findCutPoint()` algorithm with valid cut point identification (never at tool results, can split mid-turn) is significantly more sophisticated than codex-rs's simple "keep recent user messages" approach. The split-turn handling (separate TURN_PREFIX_SUMMARIZATION_PROMPT) ensures context is not lost when compaction happens mid-conversation. Diligent should adopt this.

2. **Pruning before summarization is a valuable optimization**: opencode's two-phase approach (prune old tool outputs, then summarize) reduces the summarization burden. Old tool call outputs (file contents, bash results) are the largest contributors to context size but often become irrelevant. Marking them as compacted (rather than deleting) preserves tool metadata for the session record while freeing context space. This should be adopted as a future optimization per D044.

3. **Per-session permissions are useful but not essential for MVP**: opencode stores `PermissionNext.Ruleset` per session, enabling accumulated "always" approvals. This is elegant but can be implemented independently of the session model (the permission ruleset is just a JSON blob stored on the session record). Per D044, this is deferred.

4. **Session events drive UI reactivity**: opencode's Bus-based event system (Created, Updated, Deleted, Diff, Error) provides clean decoupling between session operations and UI updates. Diligent's D004 (Op/Event pattern) naturally accommodates session events.

5. **The compaction agent can use a different model**: opencode's pattern of having a "compaction" agent that may use a different/cheaper model for summarization is a good cost optimization. The compaction prompt is relatively simple and doesn't need the most capable model.

6. **Ghost snapshots and revert metadata enrich the session**: codex-rs preserves git snapshot items across compaction, and opencode stores revert metadata (messageID, partID, snapshot, diff) on the session. These provide undo/recovery capabilities that integrate naturally with the session model.

### Architecture Recommendations

For diligent's L6 implementation, the recommended approach combines the best patterns:

1. **Storage**: JSONL append-only with pi-agent's tree structure (D006/D036)
2. **Entry types**: Start with 5 core types (message, compaction, model_change, custom, session_info), expand as needed
3. **Context building**: Pi-agent's `buildSessionContext()` tree traversal algorithm
4. **Compaction trigger**: Pi-agent's hybrid token estimation (actual usage + chars/4 for trailing)
5. **Compaction algorithm**: Pi-agent's full pipeline (prepareCompaction -> findCutPoint -> generateSummary) with iterative updating
6. **File tracking**: Pi-agent's `CompactionDetails` with cumulative carry-forward
7. **Context re-injection**: codex-rs's explicit injection after compaction
8. **Session management**: Pi-agent's file-based listing with `SessionInfo` metadata
9. **Deferred persistence**: Pi-agent's write-on-first-assistant pattern
10. **Version migration**: Pi-agent's header-based version detection with chained migration

---

## Open Questions

1. **Should pruning be part of MVP compaction?** opencode's prune-before-summarize reduces token costs but adds complexity. D044 deferred this. The question is whether the simpler pi-agent approach (summarize everything) is sufficient for initial implementation, or whether context savings from pruning are significant enough to include from the start.

2. **How should the compaction model be selected?** opencode allows a separate "compaction" agent with potentially a cheaper model. Should diligent support this from the start, or always use the session's current model? Using a cheaper model saves cost but adds configuration complexity.

3. **Should branch summaries be generated automatically?** Pi-agent's `branchWithSummary()` generates an LLM summary when switching branches. This provides context about what happened on the abandoned branch. The cost is an LLM call per branch switch. Is this worth implementing, or can users simply read the branch history?

4. **How should session naming work?** Pi-agent has `SessionInfoEntry` for user-defined names. opencode generates titles from content. Should diligent auto-generate session names (from the first user message or LLM-generated title), or require explicit naming?

5. **Should sessions support archiving/soft-delete?** opencode has `time_archived` for soft delete. codex-rs moves files to an `archived_sessions/` directory. Both preserve history while decluttering the active session list. This is a small feature with good UX benefit.

6. **What is the right `keepRecentTokens` default?** Both pi-agent and codex-rs use 20,000 tokens. This determines how much recent context survives compaction. Too low and the LLM loses important recent context; too high and compaction doesn't free enough space. 20,000 tokens (approximately 5 recent turns) seems reasonable based on both implementations.

7. **How should the session interact with sub-agents?** Per D062 (TaskTool pattern), sub-agents create child sessions. The session model needs to support parent-child relationships (pi-agent's `parentSession`, opencode's `parentID`). Should child sessions be full sessions (same format, listed separately) or lightweight (in-memory only)?

8. **Should custom entries be part of MVP?** Pi-agent's `CustomEntry` (not in LLM context) and `CustomMessageEntry` (in LLM context) enable extension state persistence and context injection. These are powerful for extensibility but add entry type complexity. Could be deferred until L8 (Skills) or L9 (MCP) need them.
