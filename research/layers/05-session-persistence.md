# Layer 5: Session & Persistence

## Key Questions

1. How is conversation history stored? (In-memory, file, database?)
2. What is the session data model? (What fields, what relationships?)
3. How is context compaction/summarization implemented?
4. When is compaction triggered? (Manual, automatic, token-based?)
5. How does the compaction algorithm work? (What is summarized, what is kept?)
6. How is branching/forking handled?
7. How are sessions listed, loaded, and resumed?
8. What is the session lifecycle? (Create → active → compact → archive?)
9. How do sessions interact with the agent loop?
10. What are the key abstractions and their relationships?

## codex-rs Analysis

### Storage Model

**In-memory `ContextManager`** for active conversation. No persistent database. Rollout history persisted to JSONL files for crash recovery.

**`ContextManager`** — manages the conversation history as a vector of `ResponseItem`:
- `raw_items()` — access the full history
- `record_items()` — append new items with truncation policy
- `replace()` — replace entire history (used after compaction)
- `clone()` — deep copy for compaction without affecting active history

### Session Structure

**`Session`** — central session object (in `codex.rs`):
- Holds `ContextManager` behind `RwLock`
- `TurnContext` per-turn: model, tools, policies
- Event emission via channels
- History cloning for compaction

**Rollout persistence** (JSONL-based):
- `RolloutItem` enum: `UserInput`, `ModelOutput`, `Compacted { replacement_history }`
- Appended to `history.jsonl` per-session
- Used for session recovery, not for normal operation

### Context Compaction

**`run_compact_task_inner()`** — core compaction flow:

1. Clone current history
2. Strip model-switch developer messages (keep compaction in-distribution)
3. Append compaction prompt as user input
4. Stream LLM response (summary generation)
5. Build compacted history via `build_compacted_history()`
6. Replace session history with compacted version

**`build_compacted_history()`**:
- Collects user messages from history via `collect_user_messages()`
- Filters out AGENTS.md/environment context entries (these get re-injected)
- Keeps recent user messages within `COMPACT_USER_MESSAGE_MAX_TOKENS` (20,000 tokens)
- Builds new history: summary message + kept recent messages

**Compaction prompt**: loaded from `templates/compact/prompt.md` (compiled into binary via `include_str!`).

### Compaction Triggers

Two modes:
- **`InitialContextInjection::BeforeLastUserMessage`** — mid-turn auto-compaction (triggered by context overflow during streaming)
- **`InitialContextInjection::DoNotInject`** — pre-turn/manual compaction (Op::Compact from user)

Auto-compaction triggered by `model_auto_compact_token_limit` in config.

### Initial Context Re-injection

After compaction, initial context (system prompt, AGENTS.md, environment info) needs re-injection. The `insert_initial_context_before_last_real_user_or_summary()` function handles this:
- `BeforeLastUserMessage`: inject into replacement history before last real user message
- `DoNotInject`: clear `reference_context_item` so next regular turn reinjects normally

### Error Handling

- Retry with backoff on compaction errors
- On `ContextWindowExceeded`: remove oldest items and retry
- Truncation policy applied during recording (`TruncationPolicy`)

### Ghost Snapshots

`GhostSnapshotConfig` — git-based state snapshots for undo/recovery. Not directly session persistence, but related to state management.

### No Session Listing/Resume

codex-rs does not support listing past sessions or resuming them. Each invocation starts fresh. The rollout JSONL is for crash recovery, not for session management UI.

---

## pi-agent Analysis

### Storage Model

**JSONL append-only files** with tree structure. Each session is a single `.txt` file in `~/.pi/agent/sessions/<session-id>/session.txt` (per-project directories also supported).

### Session Data Model

**`SessionHeader`** (first line of JSONL):
```typescript
SessionHeader {
    type: "session",
    version: 3,  // current version
    id: string,
    timestamp: string,
    cwd: string,
    parentSession?: string,  // for forked sessions
}
```

**Entry types** (all have `id`, `parentId`, `timestamp`):
```typescript
type SessionEntry =
    | SessionMessageEntry     // { type: "message", message: AgentMessage }
    | ThinkingLevelChangeEntry // { type: "thinking_level_change", thinkingLevel }
    | ModelChangeEntry         // { type: "model_change", provider, modelId }
    | CompactionEntry          // { type: "compaction", summary, firstKeptEntryId, tokensBefore, details? }
    | BranchSummaryEntry       // { type: "branch_summary", fromId, summary, details? }
    | CustomEntry              // { type: "custom", customType, data? } (extension state, not in LLM context)
    | CustomMessageEntry       // { type: "custom_message", customType, content, details?, display } (in LLM context)
    | LabelEntry               // { type: "label", targetId, label }
    | SessionInfoEntry         // { type: "session_info", name? }
```

### Tree Structure

Every entry has `id` (unique 8-char hex) and `parentId` (null for first entry). This creates a tree:
- Linear sequences: each entry's parentId points to the previous entry
- Branches: multiple entries can share the same parentId
- `leafId` pointer: tracks the current active branch tip

Tree structure enables:
- **Branching**: change leafId to create new branch from any point
- **Path reconstruction**: walk from leaf to root to get current conversation path
- **Branch awareness**: know which entries are on the current path vs abandoned branches

### Session Manager

**`SessionManager`** class:
```typescript
class SessionManager {
    private header: SessionHeader;
    private fileEntries: FileEntry[];       // all entries in file order
    private byId: Map<string, SessionEntry>; // O(1) lookup
    private labelsById: Map<string, string>; // entry labels
    private leafId: string;                  // current branch tip
}
```

**Key operations:**
- `addMessage(msg)` — append message entry, update leafId
- `branch(branchFromId)` — move leafId to create new branch
- `branchWithSummary(fromId)` — branch + generate LLM summary of abandoned context
- `createBranchedSession()` — extract single path as new session file
- `buildSessionContext()` — walk leaf→root, build LLM context
- `getTree()` — return full tree structure for UI

### Context Building

`buildSessionContext()`:
1. Walk from leafId to root, collecting entries on path
2. Reverse to chronological order
3. Handle compaction entries: emit summary + kept messages + after-compaction messages
4. Handle branch summaries: include as user messages
5. Handle custom messages: include if they participate in context
6. Skip non-context entries (custom, label, session_info)
7. Return `SessionContext { messages, thinkingLevel, model }`

### Compaction

**`CompactionSettings`**:
```typescript
CompactionSettings {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
}
```

**`shouldCompact()`**: triggers when `contextTokens > contextWindow - reserveTokens`.

**Token estimation**: `estimateTokens()` — chars/4 heuristic per message type. No tiktoken dependency.

**`findCutPoint()`**: walks backwards accumulating tokens, finds valid cut points:
- Must be user or assistant message (never tool result)
- Can split mid-turn (`isSplitTurn`)
- Returns `CutPointResult { firstKeptEntryIndex, turnStartIndex, isSplitTurn }`

**`compact()`** — full compaction flow:
1. `prepareCompaction()` — identify messages to summarize, extract file operations
2. `generateSummary()` — LLM-based summarization with structured template
3. If split turn: also generate `turnPrefixSummary` for the partial turn
4. Append file operation lists to summary
5. Return `CompactionResult { summary, firstKeptEntryId, tokensBefore, details }`

**Summary template** (structured):
```
## Goal
## Constraints
## Progress
## Key Decisions
## Next Steps
## Critical Context
```

**Iterative summary updating**: if `previousSummary` exists, uses `UPDATE_SUMMARIZATION_PROMPT` to merge new information into existing summary rather than starting fresh.

### File Operation Tracking

Compaction tracks which files were read/modified:
- `extractFileOpsFromMessage()` — scan tool calls for file operations
- `CompactionDetails { readFiles, modifiedFiles }` — stored in compaction entry
- Carried forward across compactions (cumulative)
- Appended to summary text so LLM knows what files exist

### Persistence

**Deferred persistence**: doesn't write to disk until first assistant message arrives:
```typescript
_persist(): void {
    if (firstFlush) {
        // Write all entries at once
    } else {
        // Append only new entries
    }
}
```

**Append-only**: new entries appended to existing file. No rewrites except for version migration.

### Version Migration

- v1 → v2: add `id`/`parentId` to all entries (migrated on load)
- v2 → v3: rename `hookMessage` to `custom` type

### Session Listing

`SessionManager.list()` / `listAll()`:
- Scan `~/.pi/agent/sessions/` directories
- Read header + first few entries for preview
- Return `SessionInfo { path, id, cwd, name, created, modified, messageCount, firstMessage }`
- `continueRecent()` — resume most recent session in current directory

### Forking

`forkFrom(sourceManager, options)`:
- Create new session file
- Copy entries from source up to a point
- Set `parentSession` in new header
- Enables "fork from this point" workflows

---

## opencode Analysis

### Storage Model

**SQLite** via Drizzle ORM. Three primary tables: `SessionTable`, `MessageTable`, `PartTable`.

### Session Data Model

**`Session.Info`** (Zod-validated):
```typescript
Session.Info {
    id: string,
    slug: string,
    projectID: string,
    directory: string,
    parentID?: string,     // for forked sessions
    title: string,
    version: string,
    summary?: { additions, deletions, files, diffs? },
    share?: { url },
    permission?: PermissionNext.Ruleset,  // per-session permissions
    time: { created, updated, compacting?, archived? },
    revert?: { messageID, partID?, snapshot?, diff? },
}
```

**`MessageV2`** — message types:
- `MessageV2.User` — user messages with model info, variant, path
- `MessageV2.Assistant` — assistant messages with tokens, cost, mode, summary flag

**`PartTable`** — tool execution parts stored separately from messages:
- `ToolPart` with state machine: `pending → running → completed → error`
- Includes `time.compacted` field for pruning

### Session Events

```typescript
Session.Event = {
    Created, Updated, Deleted, Diff, Error
}
```

Published via `Bus` for UI reactivity.

### Compaction System

**Two-phase approach**: prune + summarize.

**Phase 1: Prune** (`SessionCompaction.prune()`):
- Walk backwards through tool output parts
- Skip first 2 turns (recent)
- Skip parts within `PRUNE_PROTECT` (40,000) tokens of tool calls
- Mark old tool outputs as compacted if total exceeds `PRUNE_MINIMUM` (20,000 tokens)
- Sets `part.state.time.compacted = Date.now()` — output excluded from context but metadata kept
- Protected tools: `"skill"` (never pruned)

**Phase 2: Summarize** (`SessionCompaction.process()`):
- Creates a "compaction" agent (may use a different/cheaper model)
- Sends full message history + compaction prompt to LLM
- Creates assistant message with `summary: true` flag and `mode: "compaction"`
- Result stored as a regular assistant message in the session

**Compaction prompt template** (structured):
```
## Goal
[What goal(s) is the user trying to accomplish?]

## Instructions
[What important instructions did the user give you that are relevant]

## Discoveries
[What notable things were learned]

## Accomplished
[What work has been completed, what's in progress, what's left?]

## Relevant files / directories
[Structured list of relevant files]
```

**Plugin hook**: `experimental.session.compacting` — plugins can inject context or replace the compaction prompt entirely.

### Compaction Trigger

`SessionCompaction.isOverflow()`:
- Checks if tokens exceed `usable = input_limit - reserved`
- `reserved = config.compaction?.reserved ?? min(COMPACTION_BUFFER, maxOutputTokens)`
- `COMPACTION_BUFFER = 20_000` tokens
- Can be disabled via `config.compaction?.auto === false`

### Session Operations

**Create**: `Session.create()` — generates ID, slug, inserts into SessionTable.

**Fork**: `getForkedTitle(title)` — appends "(fork #N)" to title. Copies messages and creates new session.

**Messages**: `Session.messages({ sessionID })` — returns messages with their parts.

**Update**: `Session.updateMessage()` — upsert message, publish events.

**Part management**: `Session.updatePart()` — update individual tool execution parts.

### Session Listing

SQL queries against `SessionTable`:
- Filter by project, date, archived status
- Ordered by `time_updated DESC`
- Includes summary stats (additions, deletions, files)

### Per-Session Permissions

Sessions store their own `PermissionNext.Ruleset`:
- Accumulated "always" approvals are stored per-session
- Loaded from `PermissionTable` (SQLite)
- Enables different permission profiles per session

### Snapshot/Revert

`Session.Info.revert` field — stores revert metadata:
- `messageID`, `partID`, `snapshot`, `diff`
- Enables undoing changes made during a session
- Integrates with `Snapshot` system for git-based state tracking

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|---|---|---|---|
| **Storage** | In-memory (ContextManager) + JSONL rollout | JSONL append-only files | SQLite (Drizzle ORM) |
| **Data Model** | ResponseItem vector | Tree-structured entries (id/parentId) | Normalized tables (Session/Message/Part) |
| **Compaction Trigger** | Auto (token limit) or manual (Op::Compact) | Auto (contextTokens > window - reserve) | Auto (tokens > usable) or manual |
| **Compaction Method** | LLM summary + keep recent user messages | LLM summary + keep recent turns + file ops | Prune old tool output + LLM summary |
| **Two-Phase Compaction** | No (single pass) | No (single pass) | Yes (prune then summarize) |
| **Token Estimation** | `approx_token_count()` | chars/4 heuristic | `Token.estimate()` |
| **Summary Template** | Template from file (compiled in) | Goal/Constraints/Progress/Decisions/Next Steps/Critical Context | Goal/Instructions/Discoveries/Accomplished/Relevant files |
| **Iterative Summary** | No (fresh each time) | Yes (UPDATE_SUMMARIZATION_PROMPT merges with previous) | No (fresh each time) |
| **Branching** | Not supported | Full tree branching (leafId pointer) | Session forking (new session from existing) |
| **Session Resume** | Not supported (crash recovery only) | `continueRecent()`, `open()`, `list()` | SQL queries, full session listing |
| **File Operation Tracking** | Not tracked | `CompactionDetails { readFiles, modifiedFiles }` | Not explicit (via tool parts metadata) |
| **Version Migration** | Not applicable (in-memory) | v1→v2→v3 (migrate on load) | DB migrations via Drizzle |
| **Per-Session Permissions** | Not stored in session | Not stored in session | `permission: PermissionNext.Ruleset` in session |
| **Plugin Hooks** | Not observed | Extension hooks for compaction | `experimental.session.compacting` plugin hook |
| **Deferred Persistence** | Rollout append per event | Deferred until first assistant message | Immediate (SQL inserts) |
| **Concurrent Access** | RwLock on ContextManager | Not addressed (single writer assumed) | SQLite handles concurrency |
| **Context Re-injection** | Explicit initial context injection after compaction | Not explicit (summary carries enough context) | Not explicit (summary carries enough context) |
| **Complexity** | Medium (in-memory focus, simple rollout) | High (tree structure, branching, version migration, file tracking) | High (SQL schema, prune+summarize, snapshots, permissions) |

## Open Questions

1. **Storage format**: D006 decided on JSONL append-only (like pi-agent). This decision holds — JSONL is simpler than SQLite and sufficient for session persistence.

2. **Tree structure vs linear**: pi-agent's tree structure (id/parentId) enables branching. opencode uses separate sessions for forks. Tree structure is more powerful but adds complexity. Given D006, tree structure is the natural fit for JSONL.

3. **Compaction strategy**: All three use LLM-based summarization but differ in approach. pi-agent's iterative summary updating (merge new info into existing summary) is more token-efficient for repeated compactions. Worth adopting.

4. **Two-phase compaction**: opencode's prune-then-summarize approach is interesting. Pruning old tool output before summarization reduces the summarization burden. Could be a good optimization.

5. **Token estimation**: pi-agent uses chars/4 heuristic (simple, no dependencies). Is this accurate enough, or do we need a tiktoken-based approach?

6. **File operation tracking**: pi-agent tracks which files were read/modified across compactions. This helps the LLM maintain file awareness after summarization. Valuable feature.

7. **Context re-injection**: codex-rs explicitly re-injects initial context (system prompt, AGENTS.md) after compaction. This is important because the summary may not capture these. Should be part of the design.

8. **Session listing and resume**: pi-agent and opencode both support session listing and resuming. Essential for usability. Should be part of L5.

9. **Compaction prompt template**: All three use structured templates. pi-agent's is most detailed (Goal/Constraints/Progress/Decisions/Next Steps/Critical Context). opencode's plugin hook for custom compaction is flexible.

10. **Deferred persistence**: pi-agent defers writing until first assistant message. This avoids empty session files. Good optimization.

11. **Per-session permissions**: opencode stores permission rulesets per-session. This is a cross-concern with L3. Should permissions be part of session state?

12. **Version migration**: pi-agent handles v1→v2→v3 migration on load. Important for long-lived projects. JSONL format makes migration straightforward (parse line by line, transform, rewrite if needed).
