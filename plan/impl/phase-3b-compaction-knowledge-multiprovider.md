# Phase 3b: Compaction, Knowledge & Multi-Provider

## Goal

Long sessions auto-compact when approaching the context limit, preserving a structured summary. Knowledge accumulates across sessions via an `add_knowledge` tool and is injected into new sessions. The agent can use OpenAI models via the Responses API as an alternative to Anthropic.

## Prerequisites

- Phase 3a artifact: SessionManager, JSONL persistence, DeferredWriter, context builder, JSONC config, CLAUDE.md discovery, `--continue`/`--list` CLI flags.
- All Phase 3a tests passing (`bun test` — 254 tests).
- `.diligent/knowledge/` directory already created by `ensureDiligentDir()`.
- Config stubs for `compaction` and `knowledge` already in `DiligentConfigSchema`.

## Artifact

Full Phase 3 vision — configurable, persistent agent with compaction, knowledge, and multi-provider support.

**Demo 1 — Compaction:**
```
$ bunx diligent
diligent> [... long conversation, many tool calls ...]

⟳ Compacting context (142k → 28k tokens)...

diligent> what were we working on?

Based on our session: we've been refactoring the config
module. We read 12 files, modified 4 (schema.ts, loader.ts,
instructions.ts, index.ts). Key decisions: moved to Zod
validation, added env overrides...
```

**Demo 2 — Knowledge:**
```
$ bunx diligent
diligent> this project always uses Bun.spawn instead of child_process

[tool: add_knowledge] Saved: "This project uses Bun.spawn
for process execution instead of Node.js child_process"

diligent> (Ctrl+D)

$ bunx diligent  # new session
diligent> run the tests

[tool: bash] bun test  # uses Bun, as learned from previous session
```

**Demo 3 — OpenAI provider:**
```
$ cat diligent.jsonc
{ "model": "gpt-4o" }
$ OPENAI_API_KEY=sk-... bunx diligent

diligent> hello
Hello! How can I help you today?  (via gpt-4o)
```

## Layer Touchpoints

| Layer | Depth | What Changes |
|-------|-------|-------------|
| L0 (Provider) | +multi | Add OpenAI Responses API provider (`createOpenAIStream`). Extend `Model` type with model registry. |
| L1 (Agent Loop) | +compact | Context overflow error routed to compaction instead of fatal error. New `compaction_start`/`compaction_end` events. |
| L3 (Core Tools) | +add_knowl | New `add_knowledge` tool (D082). |
| L6 (Session) | +compact+knowl | `CompactionEntry` type, token estimation, cut point detection, LLM summarization, file operation tracking. Knowledge store, ranker, injector. `SessionManager` orchestrates compaction and knowledge injection. |

**Not touched:** L2 (tool framework unchanged), L4 (still auto-approve), L5 (config schema stubs already prepared — just wired), L7 (TUI handles new events via existing switch pattern), L8/L9/L10 (future phases).

## File Manifest

### packages/core/src/session/

| File | Action | Description |
|------|--------|------------|
| `types.ts` | MODIFY | Add `CompactionEntry` to `SessionEntry` union. Bump `SESSION_VERSION` to 2. |
| `compaction.ts` | CREATE | Token estimation, `shouldCompact()`, `findCutPoint()`, `generateSummary()`, `extractFileOperations()`, summarization prompts. |
| `context-builder.ts` | MODIFY | Handle `CompactionEntry` — summary replaces older messages. |
| `manager.ts` | MODIFY | Pre-turn token check, compaction trigger, knowledge injection into system prompt, context overflow retry. |
| `persistence.ts` | MODIFY | `appendEntry` handles new `CompactionEntry` type (no structural change — already generic). |

### packages/core/src/knowledge/

| File | Action | Description |
|------|--------|------------|
| `types.ts` | CREATE | `KnowledgeEntry`, `KnowledgeType`, `KnowledgeConfig` types. |
| `store.ts` | CREATE | JSONL append-only store — `append()`, `readAll()`, `readRecent()`. |
| `ranker.ts` | CREATE | Rank by recency × confidence with type weighting. Token budget enforcement. |
| `injector.ts` | CREATE | Build "Project Knowledge" system prompt section from ranked entries. |
| `index.ts` | CREATE | Re-exports. |

### packages/core/src/tools/

| File | Action | Description |
|------|--------|------------|
| `add-knowledge.ts` | CREATE | `add_knowledge` tool implementation (D082). |
| `index.ts` | MODIFY | Export `addKnowledgeTool`. |

### packages/core/src/provider/

| File | Action | Description |
|------|--------|------------|
| `openai.ts` | CREATE | OpenAI Responses API streaming provider. |
| `models.ts` | CREATE | Model registry with known model definitions (Anthropic + OpenAI). |
| `types.ts` | MODIFY | No structural change — existing `Model`/`StreamFunction` types suffice. |
| `index.ts` | MODIFY | Export OpenAI provider and model registry. |

### packages/core/src/agent/

| File | Action | Description |
|------|--------|------------|
| `types.ts` | MODIFY | Add `compaction_start`, `compaction_end`, `knowledge_saved` AgentEvent types. |

### packages/core/src/config/

| File | Action | Description |
|------|--------|------------|
| `instructions.ts` | MODIFY | Add `buildSystemPromptWithKnowledge()` that includes the knowledge section and the autonomous knowledge recording instruction. |
| `schema.ts` | MODIFY | Minor: add defaults to compaction/knowledge schema. No structural change. |

### packages/cli/src/

| File | Action | Description |
|------|--------|------------|
| `config.ts` | MODIFY | Provider selection based on model ID prefix. OpenAI API key resolution. Model registry lookup. |
| `tui/app.ts` | MODIFY | Handle `compaction_start`/`compaction_end`/`knowledge_saved` events in event switch. |

### packages/core/src/

| File | Action | Description |
|------|--------|------------|
| `index.ts` | MODIFY | Export knowledge module. |

### Root

| File | Action | Description |
|------|--------|------------|
| `package.json` (core) | MODIFY | Add `openai` dependency. |

---

## Implementation Tasks

### Task 1: Compaction Types and Token Estimation

**Files:** `session/types.ts`, `session/compaction.ts` (new)
**Decisions:** D037, D038, D039

Add the `CompactionEntry` type and implement token estimation and compaction trigger logic.

```typescript
// session/types.ts — add to SessionEntry union

export interface CompactionEntry {
  type: "compaction";
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: string;
  firstKeptEntryId: string; // first entry after the cut point (kept in context)
  tokensBefore: number;     // estimated tokens before compaction
  tokensAfter: number;      // estimated tokens after (summary + kept messages)
  details?: CompactionDetails;
}

export interface CompactionDetails {
  readFiles: string[];     // D039: cumulative file ops
  modifiedFiles: string[];
}

export type SessionEntry =
  | SessionMessageEntry
  | ModelChangeEntry
  | SessionInfoEntry
  | CompactionEntry;

export const SESSION_VERSION = 2;
```

```typescript
// session/compaction.ts — token estimation and trigger

/**
 * Estimate token count from message content.
 * Uses chars/4 heuristic (D038 — matches pi-agent).
 */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (msg.role === "user") {
      chars += typeof msg.content === "string"
        ? msg.content.length
        : JSON.stringify(msg.content).length;
    } else if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else if (block.type === "tool_call") chars += JSON.stringify(block.input).length + block.name.length;
      }
    } else if (msg.role === "tool_result") {
      chars += msg.output.length;
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Check if compaction should trigger.
 * D038: contextTokens > contextWindow - reserveTokens
 */
export function shouldCompact(
  estimatedTokens: number,
  contextWindow: number,
  reserveTokens: number,
): boolean {
  return estimatedTokens > contextWindow - reserveTokens;
}

export interface CutPointResult {
  /** Index into path entries — first entry to keep in context */
  firstKeptIndex: number;
  /** Entries to summarize (0..firstKeptIndex-1) */
  entriesToSummarize: SessionEntry[];
  /** Entries to keep (firstKeptIndex..end) */
  entriesToKeep: SessionEntry[];
}

/**
 * Find where to cut the conversation for compaction.
 * Simple cut points: always cut at user message boundaries (turn boundaries).
 * Walk backwards from the end, accumulating estimated tokens,
 * until we've reached keepRecentTokens worth of messages.
 */
export function findCutPoint(
  pathEntries: SessionEntry[],
  keepRecentTokens: number,
): CutPointResult { ... }
```

`findCutPoint` algorithm:
1. Walk backwards from the last entry, accumulating token estimates for message entries.
2. When accumulated tokens exceed `keepRecentTokens`, stop.
3. Find the nearest user message boundary at or after the accumulation point (never cut mid-turn — a turn is a user message followed by assistant + tool_result messages).
4. If a `CompactionEntry` exists in the path, only summarize messages AFTER that entry (don't re-summarize already-compacted content).
5. Return the split: entries to summarize vs. entries to keep.

**Verify:** Unit tests for `estimateTokens()` (known strings → expected token count), `shouldCompact()` (threshold math), `findCutPoint()` (various conversation shapes — empty, single turn, multi-turn, already-compacted).

---

### Task 2: Compaction Summarization

**Files:** `session/compaction.ts`
**Decisions:** D037, D039, D041

Implement the LLM-based summarization and file operation extraction.

```typescript
// session/compaction.ts — summarization

const SUMMARIZATION_PROMPT = `Summarize the following coding session conversation.
Use this exact structure:

## Goal
What the user is trying to accomplish.

## Progress
### Done
- Completed tasks with specific details (file paths, function names).
### In Progress
- Tasks started but not finished.
### Blocked
- Issues preventing progress.

## Key Decisions
- Technical decisions made with brief rationale.

## Next Steps
- What should happen next.

## Critical Context
- Important details that must not be lost (variable names, API endpoints, error messages, etc.).

Be concise but preserve all actionable information. File paths and code identifiers are critical.`;

const UPDATE_SUMMARIZATION_PROMPT = `Update the existing session summary with new information.
Rules:
- PRESERVE all information from the previous summary
- ADD new progress, decisions, and context
- MOVE "In Progress" items to "Done" when completed
- UPDATE "Next Steps" based on new accomplishments
- Keep the same structure

Previous summary:
{previousSummary}

New conversation to integrate:`;

/**
 * Generate a compaction summary using an LLM call.
 * D037: LLM-based with iterative summary updating.
 */
export async function generateSummary(
  messages: Message[],
  streamFunction: StreamFunction,
  model: Model,
  options: {
    previousSummary?: string;
    signal?: AbortSignal;
  },
): Promise<string> {
  const prompt = options.previousSummary
    ? UPDATE_SUMMARIZATION_PROMPT.replace("{previousSummary}", options.previousSummary)
    : SUMMARIZATION_PROMPT;

  const context: StreamContext = {
    systemPrompt: prompt,
    messages,
    tools: [], // no tools for summarization
  };

  const providerStream = streamFunction(model, context, {
    signal: options.signal,
    maxTokens: 4096,
  });

  const result = await providerStream.result();
  const textBlocks = result.message.content.filter(
    (b): b is { type: "text"; text: string } => b.type === "text",
  );
  return textBlocks.map((b) => b.text).join("\n");
}

/**
 * D039: Extract file operations from messages being compacted.
 * Cumulative: merges with previous compaction's file ops.
 */
export function extractFileOperations(
  messages: Message[],
  previousDetails?: CompactionDetails,
): CompactionDetails {
  const readFiles = new Set(previousDetails?.readFiles ?? []);
  const modifiedFiles = new Set(previousDetails?.modifiedFiles ?? []);

  for (const msg of messages) {
    if (msg.role !== "tool_result") continue;
    // Detect file operations from tool results
    if (msg.toolName === "read" || msg.toolName === "glob" || msg.toolName === "grep") {
      // Extract file paths from tool input (stored in preceding assistant message)
      // Simplified: track tool name as indicator
    }
    if (msg.toolName === "write" || msg.toolName === "edit") {
      // These modify files — extract path from the tool call input
    }
  }

  return {
    readFiles: [...readFiles],
    modifiedFiles: [...modifiedFiles],
  };
}

/**
 * D039: Append file operation summary to compaction summary.
 */
export function formatFileOperations(details: CompactionDetails): string {
  const lines: string[] = [];
  if (details.readFiles.length > 0) {
    lines.push(`\n## Files Read\n${details.readFiles.map(f => `- ${f}`).join("\n")}`);
  }
  if (details.modifiedFiles.length > 0) {
    lines.push(`\n## Files Modified\n${details.modifiedFiles.map(f => `- ${f}`).join("\n")}`);
  }
  return lines.join("\n");
}
```

Implementation note: For `extractFileOperations`, we need to pair `tool_result` messages with their preceding `tool_call` blocks (in the assistant message) to extract the file path from the tool call `input`. The tool call input contains the `file_path` or `path` parameter.

> The summarization uses a direct provider call via `streamFunction` — the same `StreamFunction` used for the agent loop, but with a system prompt and no tools (D037).

**Verify:** Unit test with mock `StreamFunction` that returns a canned summary. Test `extractFileOperations` with known tool call / tool result message pairs. Test `formatFileOperations` output.

---

### Task 3: Context Builder Compaction Support

**Files:** `session/context-builder.ts`
**Decisions:** D041

Update `buildSessionContext()` to handle `CompactionEntry` — the summary replaces all messages before the cut point.

```typescript
// session/context-builder.ts — updated buildSessionContext

export function buildSessionContext(entries: SessionEntry[], leafId?: string | null): SessionContext {
  // ... existing tree walk to build path[] ...

  // Find the latest CompactionEntry on the path
  let lastCompaction: CompactionEntry | undefined;
  let compactionIndex = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].type === "compaction") {
      lastCompaction = path[i] as CompactionEntry;
      compactionIndex = i;
      break;
    }
  }

  const messages: Message[] = [];
  let currentModel: { provider: string; modelId: string } | undefined;

  if (lastCompaction) {
    // Inject summary as first user message
    const summaryWithFiles = lastCompaction.details
      ? lastCompaction.summary + formatFileOperations(lastCompaction.details)
      : lastCompaction.summary;

    messages.push({
      role: "user",
      content: `[Session Summary]\n${summaryWithFiles}`,
      timestamp: Date.parse(lastCompaction.timestamp),
    });

    // Only process entries AFTER the compaction entry
    for (let i = compactionIndex + 1; i < path.length; i++) {
      const entry = path[i];
      switch (entry.type) {
        case "message":
          messages.push(entry.message);
          break;
        case "model_change":
          currentModel = { provider: entry.provider, modelId: entry.modelId };
          break;
      }
    }
  } else {
    // No compaction — existing behavior
    for (const entry of path) {
      switch (entry.type) {
        case "message":
          messages.push(entry.message);
          break;
        case "model_change":
          currentModel = { provider: entry.provider, modelId: entry.modelId };
          break;
      }
    }
  }

  return { messages, currentModel };
}
```

D041 context re-injection: The system prompt (CLAUDE.md, environment info) is already rebuilt by `SessionManager` on every `run()` call — it is NOT part of the message array. So context re-injection is naturally handled. The summary only replaces conversation messages; the system prompt is always fresh.

**Verify:** Unit tests:
1. Context with no compaction → existing behavior unchanged.
2. Context with single CompactionEntry → summary + kept messages.
3. Context with multiple CompactionEntries → only latest one used.
4. Verify summary includes file operations when details present.

---

### Task 4: Knowledge Store

**Files:** `knowledge/types.ts`, `knowledge/store.ts`, `knowledge/ranker.ts`, `knowledge/injector.ts`, `knowledge/index.ts` (all CREATE)
**Decisions:** D081, D083

```typescript
// knowledge/types.ts

/** D081: Five knowledge types */
export type KnowledgeType = "pattern" | "decision" | "discovery" | "preference" | "correction";

export interface KnowledgeEntry {
  id: string;              // unique ID (8-char hex, same as session entries)
  timestamp: string;       // ISO 8601
  sessionId?: string;      // which session created this
  type: KnowledgeType;
  content: string;         // the knowledge itself
  confidence: number;      // 0.0–1.0
  supersedes?: string;     // ID of entry this replaces (append-only update)
  tags?: string[];
}

export interface KnowledgeConfig {
  enabled: boolean;        // default: true
  injectionBudget: number; // default: 8192 (tokens for system prompt section)
}
```

```typescript
// knowledge/store.ts

const KNOWLEDGE_FILENAME = "knowledge.jsonl";

/** Append a knowledge entry to the store. */
export async function appendKnowledge(
  knowledgePath: string,
  entry: KnowledgeEntry,
): Promise<void> {
  const filePath = join(knowledgePath, KNOWLEDGE_FILENAME);
  const line = JSON.stringify(entry) + "\n";
  await Bun.write(filePath, line, { append: true });
}

/** Read all knowledge entries from the store. */
export async function readKnowledge(knowledgePath: string): Promise<KnowledgeEntry[]> {
  const filePath = join(knowledgePath, KNOWLEDGE_FILENAME);
  const file = Bun.file(filePath);
  if (!(await file.exists())) return [];

  const text = await file.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as KnowledgeEntry);
}
```

```typescript
// knowledge/ranker.ts

/** D083: Type weights for ranking */
const TYPE_WEIGHTS: Record<KnowledgeType, number> = {
  correction: 1.5,   // highest — fixes wrong behavior
  preference: 1.3,   // user preferences
  pattern: 1.0,      // standard weight
  decision: 1.0,
  discovery: 0.8,    // lowest — informational
};

/** D083: 30-day half-life for time decay */
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Rank knowledge entries by recency × confidence × type weight.
 * D083: Filter out superseded entries, apply time decay.
 */
export function rankKnowledge(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  // Remove superseded entries
  const supersededIds = new Set(entries.filter(e => e.supersedes).map(e => e.supersedes!));
  const active = entries.filter(e => !supersededIds.has(e.id));

  const now = Date.now();
  return active
    .map((entry) => {
      const age = now - Date.parse(entry.timestamp);
      const decay = Math.pow(0.5, age / HALF_LIFE_MS);
      const score = entry.confidence * decay * (TYPE_WEIGHTS[entry.type] ?? 1.0);
      return { entry, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => entry);
}
```

```typescript
// knowledge/injector.ts

/**
 * D083: Build "Project Knowledge" system prompt section.
 * Fits within token budget (estimateTokens used for enforcement).
 */
export function buildKnowledgeSection(
  entries: KnowledgeEntry[],
  budgetTokens: number,
): string {
  if (entries.length === 0) return "";

  const ranked = rankKnowledge(entries);
  const header = "## Project Knowledge\nThe following knowledge was accumulated from previous sessions:\n\n";
  let section = header;
  let estimatedTokens = Math.ceil(header.length / 4);

  for (const entry of ranked) {
    const line = `- [${entry.type}] ${entry.content}\n`;
    const lineTokens = Math.ceil(line.length / 4);
    if (estimatedTokens + lineTokens > budgetTokens) break;
    section += line;
    estimatedTokens += lineTokens;
  }

  return section;
}
```

**Verify:** Unit tests:
1. Store: append → readAll roundtrip.
2. Ranker: superseded entries filtered, time decay applied, type weights respected.
3. Injector: stays within token budget, empty entries → empty string.

---

### Task 5: `add_knowledge` Tool and System Prompt

**Files:** `tools/add-knowledge.ts` (CREATE), `tools/index.ts`, `agent/types.ts`, `config/instructions.ts`
**Decisions:** D082, D083

```typescript
// tools/add-knowledge.ts

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../tool/types";
import { appendKnowledge, type KnowledgeEntry, type KnowledgeType } from "../knowledge";
import { generateEntryId } from "../session/types";

const addKnowledgeSchema = z.object({
  type: z.enum(["pattern", "decision", "discovery", "preference", "correction"]),
  content: z.string().describe("The knowledge to save. Be specific and actionable."),
  confidence: z.number().min(0).max(1).optional().default(0.8),
  tags: z.array(z.string()).optional(),
});

export function createAddKnowledgeTool(
  knowledgePath: string,
  sessionId?: string,
): Tool<typeof addKnowledgeSchema> {
  return {
    name: "add_knowledge",
    description:
      "Save a piece of knowledge that should persist across sessions. " +
      "Use this for project patterns, user preferences, important decisions, " +
      "or corrections to previous behavior. Knowledge is injected into " +
      "future sessions automatically.",
    parameters: addKnowledgeSchema,
    execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const entry: KnowledgeEntry = {
        id: generateEntryId(),
        timestamp: new Date().toISOString(),
        sessionId,
        type: args.type as KnowledgeType,
        content: args.content,
        confidence: args.confidence,
        tags: args.tags,
      };

      await appendKnowledge(knowledgePath, entry);

      return {
        output: `Knowledge saved: [${entry.type}] ${entry.content}`,
        metadata: { knowledgeId: entry.id },
      };
    },
  };
}
```

Add `knowledge_saved` AgentEvent type:

```typescript
// agent/types.ts — add to AgentEvent union

  | { type: "compaction_start"; estimatedTokens: number }
  | { type: "compaction_end"; tokensBefore: number; tokensAfter: number; summary: string }
  | { type: "knowledge_saved"; knowledgeId: string; content: string }
```

System prompt instruction for autonomous knowledge recording (added to `instructions.ts`):

```typescript
// config/instructions.ts — add to buildSystemPrompt

const KNOWLEDGE_INSTRUCTION = `
You have access to an add_knowledge tool. Use it to save important information that should persist across sessions:
- Project patterns (naming conventions, preferred libraries, architectural patterns)
- User preferences (workflow, style, communication)
- Key decisions made during this session
- Corrections to previous behavior

Use your judgment — save knowledge when you discover something that would be useful in future sessions.`;
```

Knowledge injection into the system prompt at session start:

```typescript
// config/instructions.ts

export function buildSystemPromptWithKnowledge(
  basePrompt: string,
  instructions: DiscoveredInstruction[],
  knowledgeSection: string,
  additionalInstructions?: string[],
): string {
  const parts = [basePrompt];

  // Inject knowledge section before instructions
  if (knowledgeSection) {
    parts.push(knowledgeSection);
  }

  for (const inst of instructions) {
    parts.push(`\nInstructions from: ${inst.path}\n${inst.content}`);
  }

  if (additionalInstructions?.length) {
    for (const inst of additionalInstructions) {
      parts.push(`\n${inst}`);
    }
  }

  // Add knowledge recording instruction
  parts.push(KNOWLEDGE_INSTRUCTION);

  return parts.join("\n");
}
```

**Verify:** Unit test: tool execution appends to JSONL file. Unit test: system prompt includes knowledge section and instruction. Integration test: tool call → knowledge persisted → next session has it in system prompt.

---

### Task 6: Compaction Orchestration in SessionManager

**Files:** `session/manager.ts`, `session/compaction.ts`
**Decisions:** D038, D041, D084

Wire compaction into `SessionManager.run()`. This is the critical integration task that ties together compaction (Tasks 1-3) and knowledge (Tasks 4-5).

```typescript
// session/manager.ts — updated SessionManager

export interface SessionManagerConfig {
  cwd: string;
  paths: DiligentPaths;
  agentConfig: AgentLoopConfig;
  compaction?: {
    enabled: boolean;       // default: true
    reserveTokens: number;  // default: 16384 (D038)
    keepRecentTokens: number; // default: 20000
  };
  knowledgePath?: string;
  sessionId?: string;
}

export class SessionManager {
  // ... existing fields ...

  run(userMessage: Message): EventStream<AgentEvent, Message[]> {
    // 1. Add user message to entries
    this.appendEntry({ type: "message", message: userMessage });

    // 2. Build context from tree
    const context = buildSessionContext(this.entries, this.leafId);

    // 3. Check if compaction is needed (D038)
    const compactionConfig = this.config.compaction ?? {
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    };

    const stream = new EventStream<AgentEvent, Message[]>(
      (event) => event.type === "agent_end",
      (event) => (event as { type: "agent_end"; messages: Message[] }).messages,
    );

    this.runWithCompaction(context.messages, compactionConfig, stream);

    return stream;
  }

  private async runWithCompaction(
    messages: Message[],
    compactionConfig: { enabled: boolean; reserveTokens: number; keepRecentTokens: number },
    outerStream: EventStream<AgentEvent, Message[]>,
  ): Promise<void> {
    let currentMessages = messages;

    // Proactive compaction check
    if (compactionConfig.enabled) {
      const tokens = estimateTokens(currentMessages);
      if (shouldCompact(tokens, this.config.agentConfig.model.contextWindow, compactionConfig.reserveTokens)) {
        currentMessages = await this.performCompaction(tokens, compactionConfig, outerStream);
      }
    }

    // Run agent loop
    const agentStream = agentLoop(currentMessages, this.config.agentConfig);

    // Proxy events to outer stream + handle persistence
    for await (const event of agentStream) {
      this.handleEvent(event);
      outerStream.push(event);
    }

    const result = await agentStream.result();
    outerStream.end(result);
  }

  private async performCompaction(
    tokensBefore: number,
    compactionConfig: { reserveTokens: number; keepRecentTokens: number },
    stream: EventStream<AgentEvent, Message[]>,
  ): Promise<Message[]> {
    stream.push({ type: "compaction_start", estimatedTokens: tokensBefore });

    // Find cut point
    const cutResult = findCutPoint(
      this.getPathEntries(),
      compactionConfig.keepRecentTokens,
    );

    // Find previous compaction for iterative updating
    const previousCompaction = this.findPreviousCompaction();

    // Extract file operations (D039)
    const messagesToSummarize = cutResult.entriesToSummarize
      .filter((e): e is SessionMessageEntry => e.type === "message")
      .map((e) => e.message);

    const details = extractFileOperations(
      messagesToSummarize,
      previousCompaction?.details,
    );

    // Generate summary (D037)
    const summary = await generateSummary(
      messagesToSummarize,
      this.config.agentConfig.streamFunction,
      this.config.agentConfig.model,
      { previousSummary: previousCompaction?.summary, signal: this.config.agentConfig.signal },
    );

    const summaryWithFiles = summary + formatFileOperations(details);

    // Save CompactionEntry
    const firstKept = cutResult.entriesToKeep[0];
    const compactionEntry: CompactionEntry = {
      type: "compaction",
      id: generateEntryId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      summary: summaryWithFiles,
      firstKeptEntryId: firstKept.id,
      tokensBefore,
      tokensAfter: estimateTokens(/* rebuilt messages */),
      details,
    };

    this.entries.push(compactionEntry);
    this.byId.set(compactionEntry.id, compactionEntry);
    this.leafId = compactionEntry.id;
    this.writeQueue = this.writeQueue.then(() => this.writer.write(compactionEntry)).catch(() => {});

    // Rebuild context with compaction
    const newContext = buildSessionContext(this.entries, this.leafId);

    const tokensAfter = estimateTokens(newContext.messages);
    stream.push({
      type: "compaction_end",
      tokensBefore,
      tokensAfter,
      summary: summary.slice(0, 200) + "...", // truncated for event
    });

    return newContext.messages;
  }
}
```

Context overflow reactive path: In `runWithCompaction`, if the `agentLoop` throws a `ProviderError` with `errorType === "context_overflow"`, catch it, trigger compaction, and retry once.

```typescript
// In runWithCompaction, wrap the agent loop call:
try {
  const agentStream = agentLoop(currentMessages, this.config.agentConfig);
  // ... proxy events ...
} catch (err) {
  if (
    err instanceof ProviderError &&
    err.errorType === "context_overflow" &&
    compactionConfig.enabled
  ) {
    // Reactive compaction — compact and retry
    const tokens = estimateTokens(currentMessages);
    currentMessages = await this.performCompaction(tokens, compactionConfig, outerStream);
    // Retry once
    const retryStream = agentLoop(currentMessages, this.config.agentConfig);
    for await (const event of retryStream) {
      this.handleEvent(event);
      outerStream.push(event);
    }
    const result = await retryStream.result();
    outerStream.end(result);
    return;
  }
  throw err;
}
```

> Note: The reactive path catches `ProviderError` that propagates from `agentLoop`'s error handling. Currently `loop.ts` catches errors and emits a fatal `error` event. For context_overflow to be catchable, `loop.ts` needs a small change: let `context_overflow` errors propagate (re-throw) instead of being caught and converted to events. Alternatively, `SessionManager` observes the `error` event and cancels the stream.

D084 simplified: The pre-compaction knowledge flush relies on the system prompt instruction (Task 5) for autonomous knowledge saving throughout the session. A dedicated flush turn before compaction can be added as a refinement if testing shows knowledge loss after compaction.

**Verify:** Integration test:
1. Mock provider with configurable contextWindow (e.g., 1000 tokens).
2. Feed enough messages to trigger proactive compaction.
3. Verify CompactionEntry is appended to session.
4. Verify rebuilt context starts with summary + kept messages.
5. Verify token count drops below threshold.

---

### Task 7: OpenAI Responses API Provider

**Files:** `provider/openai.ts` (CREATE), `provider/models.ts` (CREATE), `provider/index.ts`
**Decisions:** D003, D009

Implement the OpenAI provider using the Responses API via the `openai` npm package.

```typescript
// provider/openai.ts

import OpenAI from "openai";
import { EventStream } from "../event-stream";
import type { AssistantMessage, ContentBlock, Message, StopReason, Usage } from "../types";
import type {
  Model,
  ProviderEvent,
  ProviderResult,
  StreamContext,
  StreamFunction,
  StreamOptions,
  ToolDefinition,
} from "./types";
import { ProviderError } from "./types";

export function createOpenAIStream(apiKey: string, baseUrl?: string): StreamFunction {
  const client = new OpenAI({ apiKey, baseURL: baseUrl });

  return (model: Model, context: StreamContext, options: StreamOptions): EventStream<ProviderEvent, ProviderResult> => {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );

    (async () => {
      try {
        const response = await client.responses.create({
          model: model.id,
          instructions: context.systemPrompt,
          input: convertToOpenAIInput(context.messages),
          ...(context.tools.length > 0 && {
            tools: convertToOpenAITools(context.tools),
          }),
          stream: true,
        });

        stream.push({ type: "start" });

        // Track state for building the final message
        const contentBlocks: ContentBlock[] = [];
        let currentTextContent = "";
        let currentToolId = "";
        let currentToolName = "";
        let currentToolInput = "";

        for await (const event of response) {
          if (options.signal?.aborted) break;

          // Map Responses API events to ProviderEvent
          switch (event.type) {
            case "response.output_text.delta":
              stream.push({ type: "text_delta", delta: event.delta });
              currentTextContent += event.delta;
              break;

            case "response.output_text.done":
              stream.push({ type: "text_end", text: event.text });
              contentBlocks.push({ type: "text", text: event.text });
              currentTextContent = "";
              break;

            case "response.function_call_arguments.delta":
              stream.push({ type: "tool_call_delta", id: currentToolId, delta: event.delta });
              currentToolInput += event.delta;
              break;

            case "response.function_call_arguments.done":
              try {
                const input = JSON.parse(event.arguments) as Record<string, unknown>;
                stream.push({
                  type: "tool_call_end",
                  id: currentToolId,
                  name: currentToolName,
                  input,
                });
                contentBlocks.push({
                  type: "tool_call",
                  id: currentToolId,
                  name: currentToolName,
                  input,
                });
              } catch {
                stream.push({
                  type: "tool_call_end",
                  id: currentToolId,
                  name: currentToolName,
                  input: {},
                });
              }
              currentToolInput = "";
              break;

            case "response.output_item.added":
              if (event.item.type === "function_call") {
                currentToolId = event.item.call_id;
                currentToolName = event.item.name;
                stream.push({ type: "tool_call_start", id: currentToolId, name: currentToolName });
              }
              break;

            case "response.completed": {
              const usage = mapOpenAIUsage(event.response.usage);
              const stopReason = mapOpenAIStopReason(event.response.status);

              stream.push({ type: "usage", usage });

              const assistantMessage: AssistantMessage = {
                role: "assistant",
                content: contentBlocks,
                model: model.id,
                usage,
                stopReason,
                timestamp: Date.now(),
              };

              stream.push({ type: "done", stopReason, message: assistantMessage });
              break;
            }
          }
        }
      } catch (err) {
        stream.push({ type: "error", error: classifyOpenAIError(err) });
      }
    })();

    return stream;
  };
}
```

Message conversion for the Responses API input format:

```typescript
function convertToOpenAIInput(messages: Message[]): OpenAI.Responses.ResponseInputItem[] {
  const result: OpenAI.Responses.ResponseInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      result.push({
        role: "user",
        content: typeof msg.content === "string"
          ? msg.content
          : msg.content.filter(b => b.type === "text").map(b => b.text).join("\n"),
      });
    } else if (msg.role === "assistant") {
      // Assistant messages: text content + function calls
      for (const block of msg.content) {
        if (block.type === "text") {
          result.push({ role: "assistant", content: block.text });
        } else if (block.type === "tool_call") {
          result.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
        }
      }
    } else if (msg.role === "tool_result") {
      result.push({
        type: "function_call_output",
        call_id: msg.toolCallId,
        output: msg.output,
      });
    }
  }

  return result;
}
```

Error classification:

```typescript
export function classifyOpenAIError(err: unknown): ProviderError {
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    if (status === 429) {
      const retryAfter = parseRetryAfter(err.headers as Record<string, string> | undefined);
      return new ProviderError(err.message, "rate_limit", true, retryAfter, status, err);
    }
    if (status === 529) {
      return new ProviderError(err.message, "overloaded", true, undefined, status, err);
    }
    if (status === 400 && isContextOverflow(err.message)) {
      return new ProviderError(err.message, "context_overflow", false, undefined, status, err);
    }
    if (status === 401 || status === 403) {
      return new ProviderError(err.message, "auth", false, undefined, status, err);
    }
    return new ProviderError(err.message, "unknown", false, undefined, status, err);
  }
  // ... network error check (same as Anthropic) ...
}

function isContextOverflow(message: string): boolean {
  const patterns = [
    /maximum context length/i,
    /context_length_exceeded/i,
    /too many tokens/i,
    /exceeds the model/i,
  ];
  return patterns.some(p => p.test(message));
}
```

> Implementation note: The exact SSE event type names and Responses API types should be verified against the current OpenAI SDK at implementation time. The `openai` npm package TypeScript types will guide the exact event shapes. The structure above follows the documented Responses API event model.

**Verify:** Unit test with mock OpenAI API server. Manual test with real OpenAI API key and `gpt-4o`.

---

### Task 8: Provider Selection and CLI Wiring

**Files:** `provider/models.ts` (CREATE), `cli/config.ts`, `tui/app.ts`
**Decisions:** D003

Create a model registry and wire provider selection into the CLI.

```typescript
// provider/models.ts — known model definitions

export interface ModelDefinition extends Model {
  aliases?: string[];
}

export const KNOWN_MODELS: ModelDefinition[] = [
  // Anthropic
  {
    id: "claude-sonnet-4-20250514",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
    aliases: ["claude-sonnet", "sonnet"],
  },
  {
    id: "claude-haiku-3-5-20241022",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    inputCostPer1M: 0.8,
    outputCostPer1M: 4.0,
    aliases: ["claude-haiku", "haiku"],
  },
  // OpenAI
  {
    id: "gpt-4o",
    provider: "openai",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputCostPer1M: 2.5,
    outputCostPer1M: 10.0,
    aliases: ["4o"],
  },
  {
    id: "gpt-4o-mini",
    provider: "openai",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.6,
    aliases: ["4o-mini"],
  },
  {
    id: "o3",
    provider: "openai",
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    inputCostPer1M: 10.0,
    outputCostPer1M: 40.0,
  },
];

/**
 * Resolve a model ID or alias to a full ModelDefinition.
 * For unknown models, infer provider from ID prefix.
 */
export function resolveModel(modelId: string): Model {
  // Exact match
  const exact = KNOWN_MODELS.find(m => m.id === modelId);
  if (exact) return exact;

  // Alias match
  const aliased = KNOWN_MODELS.find(m => m.aliases?.includes(modelId));
  if (aliased) return aliased;

  // Infer provider from prefix
  if (modelId.startsWith("claude-")) {
    return { id: modelId, provider: "anthropic", contextWindow: 200_000, maxOutputTokens: 16_384 };
  }
  if (modelId.startsWith("gpt-") || modelId.startsWith("o1") || modelId.startsWith("o3")) {
    return { id: modelId, provider: "openai", contextWindow: 128_000, maxOutputTokens: 16_384 };
  }

  // Default to anthropic
  return { id: modelId, provider: "anthropic", contextWindow: 200_000, maxOutputTokens: 16_384 };
}
```

CLI config updates:

```typescript
// cli/config.ts — updated loadConfig

export async function loadConfig(cwd: string = process.cwd()): Promise<AppConfig> {
  const { config, sources } = await loadDiligentConfig(cwd);
  const instructions = await discoverInstructions(cwd);

  // Resolve model from config or default
  const modelId = config.model ?? "claude-sonnet-4-20250514";
  const model = resolveModel(modelId);

  // Resolve API key based on provider
  let apiKey: string;
  let streamFunction: StreamFunction;

  if (model.provider === "openai") {
    apiKey = config.provider?.openai?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY environment variable is required for OpenAI models.\n" +
        "Get your API key at https://platform.openai.com/api-keys",
      );
    }
    streamFunction = createOpenAIStream(apiKey, config.provider?.openai?.baseUrl);
  } else {
    apiKey = config.provider?.anthropic?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is required.\n" +
        "Get your API key at https://console.anthropic.com/settings/keys",
      );
    }
    streamFunction = createAnthropicStream(apiKey);
  }

  // Load knowledge for system prompt injection
  const knowledgePath = paths.knowledge;
  const knowledgeEntries = await readKnowledge(knowledgePath);
  const knowledgeConfig: KnowledgeConfig = {
    enabled: config.knowledge?.enabled ?? true,
    injectionBudget: config.knowledge?.injectionBudget ?? 8192,
  };
  const knowledgeSection = knowledgeConfig.enabled
    ? buildKnowledgeSection(knowledgeEntries, knowledgeConfig.injectionBudget)
    : "";

  // Build system prompt with knowledge
  const basePrompt = config.systemPrompt ?? BASE_SYSTEM_PROMPT;
  const contextLines = [
    `Current working directory: ${cwd}`,
    `Platform: ${process.platform}`,
    `Date: ${new Date().toISOString().split("T")[0]}`,
  ];
  const systemPrompt = buildSystemPromptWithKnowledge(
    [basePrompt, ...contextLines].join("\n"),
    instructions,
    knowledgeSection,
    config.instructions,
  );

  return { apiKey, model, systemPrompt, streamFunction, diligent: config, sources };
}
```

TUI event handling:

```typescript
// tui/app.ts — add to event switch in handleAgentEvent

case "compaction_start":
  this.spinner.start(`Compacting context (${Math.round(event.estimatedTokens / 1000)}k tokens)...`);
  break;

case "compaction_end":
  this.spinner.stop();
  this.terminal.writeln(
    `Context compacted: ${Math.round(event.tokensBefore / 1000)}k → ${Math.round(event.tokensAfter / 1000)}k tokens`
  );
  break;

case "knowledge_saved":
  this.terminal.writeln(`💡 Knowledge saved: ${event.content}`);
  break;
```

**Verify:**
1. `model: "gpt-4o"` in config → OpenAI provider selected, correct API key resolved.
2. `model: "claude-sonnet-4-20250514"` → Anthropic provider (existing behavior unchanged).
3. Unknown model with `claude-` prefix → defaults to Anthropic.
4. Unknown model with `gpt-` prefix → defaults to OpenAI.
5. End-to-end: switch providers via config, verify both work.

---

## Migration Notes

Stubs and placeholders from previous phases that are replaced:

- `config.compaction` — was inert stub in `DiligentConfigSchema`, now wired into `SessionManager` for token threshold checking.
- `config.knowledge` — was inert stub, now wired into system prompt building and knowledge store.
- `.diligent/knowledge/` — directory existed (created by `ensureDiligentDir`), now populated with `knowledge.jsonl`.
- Context overflow error — was caught as fatal error event in `loop.ts`, now intercepted by `SessionManager` for reactive compaction.
- Single Anthropic provider — was the only option, now selected by model prefix with OpenAI as alternative.
- `SessionEntry` union — had 3 types (message, model_change, session_info), now has 4 (+ compaction).
- `SESSION_VERSION` — bumps from 1 to 2.
- `AgentEvent` — had 15 types, now has 18 (+ compaction_start, compaction_end, knowledge_saved).
- `buildSystemPrompt` — replaced by `buildSystemPromptWithKnowledge` that includes knowledge section and autonomous recording instruction.

## Acceptance Criteria

1. `bun install` — resolves all dependencies including `openai`.
2. `bun test` — all existing tests pass, all new tests pass.
3. **Compaction trigger**: Long session exceeding token threshold auto-compacts with visible spinner.
4. **Compaction summary**: Summary follows structured template (Goal/Progress/Decisions/Next Steps).
5. **Compaction file tracking**: `CompactionEntry.details` contains read and modified file lists.
6. **Compaction context rebuild**: After compaction, context starts with summary + kept messages.
7. **Compaction resume**: `--continue` on compacted session → context includes summary correctly.
8. **Knowledge save**: `add_knowledge` tool creates entry in `.diligent/knowledge/knowledge.jsonl`.
9. **Knowledge injection**: New session's system prompt includes "Project Knowledge" section from prior knowledge.
10. **Knowledge ranking**: Higher-confidence, more-recent entries appear first; superseded entries filtered.
11. **OpenAI provider**: `model: "gpt-4o"` + `OPENAI_API_KEY` → agent uses OpenAI, can converse and execute tools.
12. **Provider selection**: Model prefix determines provider; `claude-*` → Anthropic, `gpt-*`/`o*` → OpenAI.
13. **Backward compatibility**: Sessions from Phase 3a (VERSION 1) still load correctly.
14. No `any` type escape hatches in new code.

## Testing Strategy

| Category | What to Test | How |
|----------|-------------|-----|
| Unit | Token estimation accuracy | Known strings → expected token counts (chars/4) |
| Unit | `shouldCompact` threshold | Edge cases: exactly at threshold, above, below |
| Unit | `findCutPoint` | Multi-turn conversations, already-compacted sessions, edge cases (single turn, all tool results) |
| Unit | Knowledge store CRUD | Append → read roundtrip, empty store, malformed lines |
| Unit | Knowledge ranker | Superseded entries filtered, time decay, type weights |
| Unit | Knowledge injector | Token budget enforcement, empty entries |
| Unit | Model resolution | Known models, aliases, prefix inference, unknown models |
| Unit | `buildSessionContext` with compaction | Summary replaces old messages, file ops appended |
| Integration | Compaction end-to-end | Mock provider (small contextWindow), feed messages past threshold, verify compaction fires and context shrinks |
| Integration | Knowledge end-to-end | Save knowledge → new session → verify in system prompt |
| Integration | OpenAI provider | Mock OpenAI server returning Responses API events → verify ProviderEvent mapping |
| Integration | Context overflow → compaction | Mock provider throws context_overflow → verify reactive compaction → verify retry succeeds |
| Manual | Long real session | Run agent, generate enough context for compaction, verify summary quality |
| Manual | OpenAI real API | Set `OPENAI_API_KEY`, configure `gpt-4o`, verify conversation + tool use |

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Compaction summary loses critical file paths or decisions | Agent loses context, makes wrong edits after compaction | Structured summary template forces file path preservation. File operation tracking (D039) adds explicit file lists. Test with real coding sessions. |
| Token estimation (chars/4) significantly inaccurate | Compaction triggers too early/late, context overflow still possible | Add hybrid estimation: use actual `usage.inputTokens` from last assistant message when available (pi-agent pattern). Fall back to chars/4 for new messages only. |
| OpenAI Responses API event format differs from expectations | Provider crashes or produces wrong events | Write integration test with recorded API responses. Use OpenAI SDK TypeScript types to validate at compile time. |
| Knowledge store grows unbounded | System prompt injection slows down, token budget consumed | Token budget (8192 default) caps injection size. 30-day half-life decay naturally deprioritizes old entries. Add `diligent knowledge prune` command later if needed. |
| Compaction LLM call uses significant tokens | Increased cost, potential rate limiting | Cap summarization output at 4096 tokens. Use same model as main agent (no extra model needed). Monitor cost in tests. |
| SESSION_VERSION bump breaks old sessions | Users can't resume Phase 3a sessions | Phase 3b sessions are backward-compatible: VERSION 2 files just add `CompactionEntry` as a possible type. VERSION 1 files have no compaction entries, so they load unchanged. No migration function needed. |

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| D003 | Custom provider abstraction, StreamFunction contract | Task 7, Task 8 — OpenAI provider implements same interface |
| D009 | AbortController-based cancellation | Task 7 — OpenAI provider respects AbortSignal |
| D010 | Context overflow triggers compaction, not retry | Task 6 — reactive compaction path |
| D037 | LLM-based summarization, iterative summary updating | Task 2 — generateSummary with previous summary |
| D038 | Token-based trigger: `contextTokens > contextWindow - 16384` | Task 1 — shouldCompact(), Task 6 — SessionManager check |
| D039 | File operation tracking across compactions | Task 2 — extractFileOperations, cumulative carry-forward |
| D041 | Context re-injection after compaction | Task 3 — system prompt is always fresh (not in messages) |
| D043 | Session version header | Task 1 — SESSION_VERSION bumped to 2 |
| D080 | `.diligent/` project data directory | Task 4 — knowledge stored in `.diligent/knowledge/` |
| D081 | JSONL knowledge store, 5 typed entries, supersedes pattern | Task 4 — KnowledgeEntry schema |
| D082 | `add_knowledge` tool for extraction | Task 5 — tool implementation |
| D083 | System prompt injection with token budget | Task 4 — ranker + injector, 8192 default budget |
| D084 | Pre-compaction knowledge flush | Task 6 — simplified to system prompt instruction (autonomous) |
| D086 | itemId on events, SerializableError | Existing — new events follow same pattern |

## What Phase 3b Does NOT Include

- **No Chat Completions API support** — Only OpenAI Responses API. Chat Completions (for Ollama, vLLM, etc.) deferred.
- **No cost tracking aggregation** — Per-turn cost is calculated and emitted, but no cumulative session/project cost tracking.
- **No knowledge export/import** (D085) — `diligent export/import` CLI commands deferred until needed.
- **No split-turn compaction** — Cut points are always at user message boundaries (turn boundaries). No mid-turn summarization.
- **No prune-before-summarize** (D044 deferred item) — Full messages are sent to summarization LLM, not pruned first.
- **No compaction plugin hooks** (D044 deferred item) — Compaction is internal, no extension points for plugins.
- **No dedicated pre-compaction knowledge flush turn** (D084 full form) — Relies on system prompt instruction for autonomous knowledge saving. Dedicated flush turn can be added if testing shows knowledge loss.
- **No version migration function** — SESSION_VERSION 1→2 is backward-compatible (CompactionEntry is additive). Migration function will be added when a breaking format change is needed.
- **No model switching mid-session** — Provider is determined at session start. Dynamic switching (e.g., `/model` command) deferred to Phase 4.
