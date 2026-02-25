# Debug Web UI — Research & Architecture

Research for a standalone web-based debug viewer for the diligent agent. Reads `.diligent/` files only — no coupling to the core agent runtime.

**Date**: 2026-02-25
**Status**: Research complete — ready for implementation planning
**Related**: [web-ui-readiness.md](./web-ui-readiness.md) (full web UI assessment), D036-REV, D080, D081

---

## 1. Problem Statement

During agent development, we need to:
- **Inspect conversation history** — what did the agent say, what did the LLM respond?
- **Trace tool execution flow** — which tools were called, in what order, with what args/results?
- **Analyze branching** — session tree structure (parentId relationships) after compaction/forking
- **Debug failures** — where did the agent go wrong? Which tool call failed?
- **Monitor live sessions** — watch a running session's JSONL file in real-time

This is fundamentally different from the "full web UI" described in `web-ui-readiness.md`. That requires a bidirectional protocol layer (JSON-RPC), approval system, config management — a full frontend replacement. This debug viewer is **read-only, side-channel, zero coupling**.

### Scope Boundary

| In Scope | Out of Scope |
|----------|-------------|
| Read `.diligent/sessions/*.jsonl` | Send messages to the agent |
| Read `.diligent/knowledge/knowledge.jsonl` | Modify sessions or knowledge |
| Visualize conversation tree | Approval flows |
| Show tool call sequences | Config management |
| Live-tail active sessions | Multi-user access |
| Token usage / cost display | Authentication |

---

## 2. Data Sources

### 2.1 Session Files — `.diligent/sessions/<session-id>.jsonl`

JSONL format, one entry per line. Each entry has `id` and optional `parentId` for tree structure (D036-REV).

**Entry types** (from D036, D037, D039):

```
SessionHeader    — session metadata (id, timestamp, cwd, version)
UserMessage      — user input (role: "user")
AssistantMessage — LLM response (role: "assistant", content: ContentBlock[])
ToolResultMessage — tool output (role: "tool_result")
CompactionEntry  — summary + file tracking (readFiles, modifiedFiles)
```

**Content blocks in AssistantMessage** (from `core/src/types.ts`):
- `TextBlock` — `{ type: "text", text: string }`
- `ImageBlock` — `{ type: "image", source: { type: "base64", ... } }`
- `ThinkingBlock` — `{ type: "thinking", thinking: string }`
- `ToolCallBlock` — `{ type: "tool_call", id: string, name: string, input: Record<string, unknown> }`

**Tool result** links back via `toolCallId`.

**Key relationships**:
```
AssistantMessage.content[ToolCallBlock].id  ←→  ToolResultMessage.toolCallId
entry.parentId  →  entry.id  (tree structure)
```

### 2.2 Knowledge Store — `.diligent/knowledge/knowledge.jsonl`

```typescript
interface KnowledgeEntry {
  id: string;
  timestamp: number;
  sessionId: string;
  type: "pattern" | "decision" | "discovery" | "preference" | "correction";
  content: string;
  confidence: number;  // 0-1
  supersedes?: string; // references older entry
  tags: string[];
}
```

### 2.3 AgentEvent Stream (Not persisted — future consideration)

The 15 `AgentEvent` types (from `core/src/agent/types.ts`) represent real-time events but are **not currently persisted to disk**. The debug viewer reads JSONL session files which contain the final messages, not the streaming events.

**Implication**: The viewer works with settled state (messages with content blocks), not in-flight streaming events. For live sessions, we tail the JSONL file as new entries are appended.

---

## 3. Existing Tools Landscape

### 3.1 Why Not Use an Existing Platform?

| Tool | Why Not |
|------|---------|
| **LangSmith** | SaaS, LangChain ecosystem, data leaves machine |
| **Langfuse** | Requires PostgreSQL + ClickHouse for self-hosting |
| **Helicone** | Proxy-based — only captures LLM API calls, not tool execution |
| **W&B Weave** | Python-centric, cloud-hosted |
| **Arize Phoenix** | Python ecosystem, needs OpenTelemetry conversion |

### 3.2 Worth Borrowing From

| Source | What to Borrow |
|--------|---------------|
| **Langfuse** | Nested span/tree trace viewer UI pattern |
| **AgentPrism** (Evil Martians, OSS) | React component approach for agent traces; hierarchical timeline |
| **Browser DevTools** | Network waterfall view for tool execution timing |
| **Arize Phoenix** | "Launch with one command, view locally" UX model |

### 3.3 UI Patterns from the Industry

The dominant patterns across all agent observability tools:

1. **Nested span/tree** (left panel) — collapsible hierarchy: turn > message > tool call
2. **Detail panel** (right panel) — full input/output, token counts, metadata on selection
3. **Timeline waterfall** — horizontal bars for duration/concurrency (like DevTools)
4. **Conversation thread** — linear message view with expand/collapse for tool calls

---

## 4. Architecture

### 4.1 Principle: Completely Separate Side Project

The debug viewer has **zero imports from `@diligent/core`**. It reads `.diligent/` files directly. This means:
- No dependency on agent runtime or types at compile time
- Can be developed, versioned, and deployed independently
- Understands the JSONL format by convention, not by import
- If the session format changes, only the viewer's parser needs updating

### 4.2 High-Level Architecture

```
.diligent/sessions/*.jsonl ──► fs.watch ──► Bun.serve backend
.diligent/knowledge/*.jsonl──►              │
                                            ├── REST API (session list, session data)
                                            ├── WebSocket (live-tail updates)
                                            │
                                            └──► Vite React SPA (static assets)
                                                  │
                                                  ├── Session List (sidebar)
                                                  ├── Conversation View (main panel)
                                                  ├── Tool Flow Timeline (bottom panel)
                                                  └── Detail Inspector (right panel)
```

### 4.3 Backend — Bun.serve

Responsibilities:
- **File discovery**: Scan `.diligent/sessions/` for JSONL files
- **JSONL parsing**: Read and parse session files into structured data
- **File watching**: `fs.watch` on `.diligent/` directory for new/changed files
- **WebSocket**: Push new JSONL entries to connected clients in real-time
- **REST API**: Serve session list, session data, knowledge entries
- **Static serving**: Serve the built React frontend

```
GET /api/sessions              — list sessions (metadata only)
GET /api/sessions/:id          — full session data (parsed JSONL)
GET /api/sessions/:id/tree     — tree-structured session data
GET /api/knowledge             — knowledge entries
WS  /ws                        — live updates (new entries, new sessions)
```

### 4.4 Frontend — React SPA

**Layout** (3-panel):

```
┌──────────────┬────────────────────────────┬──────────────────┐
│              │                            │                  │
│  Session     │   Conversation View        │   Detail         │
│  List        │                            │   Inspector      │
│              │   [user] How do I...       │                  │
│  > session-1 │   [assistant] Let me...    │   Tool: read     │
│    session-2 │     ├─ [tool] read foo.ts  │   Input: {...}   │
│    session-3 │     ├─ [tool] edit foo.ts  │   Output: ...    │
│              │     └─ [text] Done.        │   Duration: 2.3s │
│              │   [user] Thanks            │   Tokens: 1,234  │
│              │                            │                  │
│──────────────┤────────────────────────────│──────────────────│
│              │                            │                  │
│  Knowledge   │   Tool Flow Timeline       │   Raw JSONL      │
│  Panel       │   ═══read═══              │   { ... }        │
│  (toggle)    │        ═══edit══════       │                  │
│              │             ═══bash══      │                  │
└──────────────┴────────────────────────────┴──────────────────┘
```

**Views**:

1. **Session List** — sidebar with session metadata, sorted by modification time
2. **Conversation View** — main panel showing the message sequence
   - User messages: simple text
   - Assistant messages: rendered markdown + expandable content blocks
   - Tool calls: inline cards with name, input preview, output preview, status icon
   - Compaction entries: visual separator showing summary
   - Thinking blocks: collapsible, dimmed
3. **Tool Flow Timeline** — waterfall/Gantt view of tool executions
   - Horizontal bars showing tool call duration
   - Color-coded by tool type (read=blue, write=orange, bash=green, etc.)
   - Click to select and view details
4. **Detail Inspector** — right panel showing full data for selected item
   - Tool call: full input JSON, full output, metadata
   - Message: raw content blocks, usage stats, model info
   - Knowledge entry: type, confidence, tags, supersedes chain
5. **Tree View** (optional toggle) — React Flow visualization of session tree
   - Each message as a node, parentId as edges
   - Useful for inspecting branching after forks/compactions
6. **Knowledge Panel** — toggle panel showing knowledge entries
   - Filterable by type, confidence, tags
   - Supersedes chain visualization

---

## 5. Tech Stack Recommendation

### 5.1 Final Choices

| Concern | Choice | Rationale |
|---------|--------|-----------|
| **Runtime** | Bun | Already project runtime; zero new deps |
| **Backend** | `Bun.serve` | Native WebSocket, fast static serving |
| **Frontend framework** | React + Vite | Largest ecosystem for visualization components |
| **Conversation tree** | React Flow + elkjs | Custom nodes for messages, auto-layout for tree structure |
| **Tool timeline** | Custom CSS Grid component | Lightweight waterfall; existing timeline libs are overkill |
| **Sequence diagrams** | Mermaid.js | Text-to-diagram for quick tool flow overview |
| **JSON viewer** | react-json-view-lite | Lightweight, TypeScript, zero deps |
| **Markdown rendering** | marked (already in project) | Reuse existing dependency |
| **Code highlighting** | Shiki (Bun-friendly) or react-syntax-highlighter | For tool outputs containing code |
| **File watching** | `fs.watch` (Node compat) | Zero deps, OS-native events |
| **Live push** | WebSocket via Bun.serve | Bidirectional, first-class Bun support |
| **Deployment** | `bun build --compile` → single binary | One command launch |

### 5.2 Alternatives Considered & Rejected

| Alternative | Why Rejected |
|-------------|-------------|
| HTMX | Poor fit for interactive visualization (trees, graphs, hover) |
| SvelteKit | Smaller visualization component ecosystem |
| Next.js | Requires Node.js, massive overhead for local tool |
| Plain HTML/JS | No component model; hard to maintain complex tree views |
| Langfuse self-hosted | Requires PostgreSQL + ClickHouse; OpenTelemetry conversion |
| D3.js (primary) | Imperative API clashes with React; React Flow better for trees |
| Chokidar | Adds dependency over native `fs.watch` with marginal benefit |
| SSE instead of WS | WebSocket's bidirectional channel useful for client requests |

---

## 6. JSONL Parser Design

The parser is the critical bridge. It must handle the `.diligent/` JSONL format without importing from `@diligent/core`.

### 6.1 Entry Type Detection

```typescript
// Convention-based parsing — no imports from @diligent/core
type SessionEntry =
  | { type: "session_header"; id: string; timestamp: number; cwd: string; version: string }
  | { type: "user_message"; id: string; parentId?: string; role: "user"; content: string | ContentBlock[]; timestamp: number }
  | { type: "assistant_message"; id: string; parentId?: string; role: "assistant"; content: ContentBlock[]; model: string; usage: Usage; stopReason: string; timestamp: number }
  | { type: "tool_result"; id: string; parentId?: string; role: "tool_result"; toolCallId: string; toolName: string; output: string; isError: boolean; timestamp: number }
  | { type: "compaction"; id: string; parentId?: string; summary: string; details: { readFiles: string[]; modifiedFiles: string[] } };
```

Detection strategy: Check `role` field first, then `type` field, then structure.

### 6.2 Tree Reconstruction

```typescript
interface SessionTree {
  entries: Map<string, SessionEntry>;
  children: Map<string, string[]>;  // parentId → child ids
  roots: string[];                   // entries with no parentId
}

function buildTree(entries: SessionEntry[]): SessionTree {
  // Group by parentId, identify roots
  // Result is a forest (multiple roots possible after forks)
}
```

### 6.3 Tool Call Pairing

```typescript
interface ToolCallPair {
  call: ToolCallBlock;           // from AssistantMessage.content
  result: ToolResultMessage;     // matched by toolCallId
  assistantMessageId: string;    // parent message
  startTime: number;             // from assistant message timestamp
  endTime: number;               // from tool result timestamp
}

function pairToolCalls(entries: SessionEntry[]): ToolCallPair[] {
  // Match ToolCallBlock.id with ToolResultMessage.toolCallId
}
```

### 6.4 Incremental Parsing (for live-tail)

```typescript
class IncrementalParser {
  private offset = 0;
  private partialLine = "";

  async readNew(filePath: string): Promise<SessionEntry[]> {
    const file = Bun.file(filePath);
    const content = await file.slice(this.offset).text();
    this.offset = file.size;

    const lines = (this.partialLine + content).split("\n");
    this.partialLine = lines.pop() ?? "";  // last incomplete line

    return lines
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  }
}
```

---

## 7. Project Structure

```
packages/debug-viewer/           # or tools/debug-viewer/ — separate from core
├── package.json                 # standalone deps, no @diligent/core
├── tsconfig.json
├── src/
│   ├── server/
│   │   ├── index.ts             # Bun.serve entry point
│   │   ├── api.ts               # REST endpoints
│   │   ├── watcher.ts           # fs.watch + WebSocket push
│   │   └── parser.ts            # JSONL parser (convention-based)
│   ├── client/
│   │   ├── main.tsx             # React entry
│   │   ├── App.tsx              # Layout shell
│   │   ├── components/
│   │   │   ├── SessionList.tsx      # Sidebar session list
│   │   │   ├── ConversationView.tsx # Main conversation panel
│   │   │   ├── ToolTimeline.tsx     # Waterfall timeline
│   │   │   ├── DetailInspector.tsx  # Right panel detail view
│   │   │   ├── TreeView.tsx         # React Flow tree visualization
│   │   │   ├── KnowledgePanel.tsx   # Knowledge entries viewer
│   │   │   ├── MessageCard.tsx      # Single message render
│   │   │   ├── ToolCallCard.tsx     # Tool call inline card
│   │   │   └── JsonViewer.tsx       # Wrapper around react-json-view-lite
│   │   ├── hooks/
│   │   │   ├── useSession.ts        # Fetch + live-tail session data
│   │   │   ├── useSessions.ts       # Session list
│   │   │   └── useWebSocket.ts      # WebSocket connection
│   │   └── lib/
│   │       ├── types.ts             # Viewer-local types (no core import)
│   │       ├── tree.ts              # Tree reconstruction
│   │       └── toolPairing.ts       # Tool call ↔ result pairing
│   └── shared/
│       └── protocol.ts          # API/WS message types shared between server & client
├── vite.config.ts
└── index.html
```

### 7.1 Dependencies (estimated)

```json
{
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@xyflow/react": "^12.0.0",
    "elkjs": "^0.9.0",
    "react-json-view-lite": "^2.0.0",
    "marked": "^15.0.0",
    "mermaid": "^11.0.0"
  },
  "devDependencies": {
    "vite": "^6.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "typescript": "^5.7.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0"
  }
}
```

---

## 8. Key Features (Prioritized)

### Phase A — MVP (Core Debug Capability)

1. **Session list** — browse sessions, see metadata (timestamp, message count)
2. **Conversation view** — linear message sequence with role indicators
3. **Tool call cards** — inline expandable cards showing tool name, input, output
4. **Detail inspector** — click any item to see full JSON data
5. **Live tail** — auto-update when session file changes
6. **Search** — text search across messages and tool outputs

### Phase B — Enhanced Visualization

7. **Tool flow timeline** — waterfall view of tool executions with duration bars
8. **Token usage chart** — per-turn token usage (input/output/cache)
9. **Thinking block display** — collapsible thinking content
10. **Compaction markers** — visual separator showing compaction summary
11. **Knowledge panel** — browse knowledge entries linked to sessions

### Phase C — Advanced Analysis

12. **Session tree view** — React Flow graph for branching/forking visualization
13. **Mermaid sequence diagrams** — auto-generated tool flow diagrams
14. **Diff view** — for edit tool calls, show before/after
15. **Cost tracking** — cumulative cost per session
16. **Export** — export session analysis as HTML or PDF

---

## 9. Launch UX

Target: `bunx diligent-viewer` or `bun run packages/debug-viewer/src/server/index.ts`

```
$ bunx diligent-viewer
🔍 Scanning .diligent/sessions/...
   Found 3 sessions

🌐 Debug viewer running at http://localhost:7432
   Watching .diligent/ for changes...
```

Auto-detects `.diligent/` in cwd or parent directories (findUp pattern). Port defaults to 7432 (configurable via `--port`).

---

## 10. Design Decisions for Debug Viewer

| # | Decision | Rationale |
|---|----------|-----------|
| DV-01 | No imports from `@diligent/core` | Complete decoupling; viewer understands format by convention |
| DV-02 | Convention-based JSONL parsing | Detect entry types by `role` and structure, not by TypeScript types |
| DV-03 | Bun.serve + React + Vite | Bun native, single-binary possible, best visualization ecosystem |
| DV-04 | WebSocket for live updates | Bidirectional; client can request specific sessions |
| DV-05 | 3-panel layout | Industry standard for trace viewers (list / main / detail) |
| DV-06 | React Flow for tree visualization | Best React library for node-based graphs with custom nodes |
| DV-07 | Incremental JSONL parsing | Read from file offset; don't re-parse entire file on each change |
| DV-08 | Phased feature delivery (A→B→C) | MVP first; avoid over-engineering the debug tool itself |

---

## 11. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Session JSONL format not finalized (Phase 3 not started) | Parser assumptions may be wrong | Design parser to be flexible; validate against actual format when Phase 3 lands |
| `.diligent/` directory doesn't exist yet | No real data to test with | Create sample JSONL files for development; validate when Phase 3 creates real data |
| React Flow bundle size (~200KB) | Heavy for a debug tool | Lazy-load tree view; only load when user opens it |
| `fs.watch` reliability on macOS | Missed file change events | Fallback to polling (200ms interval) if watch misses events |
| Bun `build --compile` maturity | Single-binary may have edge cases | Can always fall back to `bun run` during development |

---

## 12. Relationship to Full Web UI

This debug viewer is **not** the "full web UI" from `web-ui-readiness.md`. The relationship:

```
Debug Viewer (this document)        Full Web UI (web-ui-readiness.md)
─────────────────────────           ──────────────────────────────────
Read-only                           Bidirectional (send messages, approve)
No protocol layer needed            JSON-RPC 2.0 protocol (Gap #1)
Reads .diligent/ files directly     Communicates via packages/server
Can be built NOW                    Requires Phase 4+ prerequisites
Side tool for developers            Primary user interface
Separate package, no core import    Deeply integrated with core
```

However, components built for the debug viewer (conversation rendering, tool call cards, JSON viewer, markdown display) can be **extracted and reused** when the full web UI is built. This is a natural stepping stone.

---

## 13. Next Steps

1. **Create sample JSONL data** — mock session files matching the planned D036-REV format for development
2. **Create `packages/debug-viewer/`** — initialize with Vite + React + Bun
3. **Build JSONL parser** — convention-based, with incremental reading support
4. **Implement Phase A (MVP)** — session list, conversation view, tool cards, live tail
5. **Validate against Phase 3** — once session persistence is implemented, test with real data
