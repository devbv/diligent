# Debug Web UI — Implementation Plan (Phase A MVP)

## Context

During agent development, there's no way to inspect session data, trace tool execution, or debug failures outside the TUI. The debug-web-ui is a **standalone, read-only** web viewer that reads `.diligent/` files directly — zero coupling to agent runtime (DV-01).

**Critical constraint**: Phase 3 (session persistence) is not yet implemented, so no real `.diligent/` files exist. Development uses sample JSONL data that matches the D036-REV format.

**Research document**: `research/temp/debug-web-ui.md`
**Related decisions**: D036-REV, D037, D039, D080, D081, DV-01–DV-08

---

## Architecture

```
packages/debug-viewer/           # New workspace package, no @diligent/core dep
  src/server/   → Bun.serve     # REST API + WebSocket + static serving
  src/client/   → Vite + React  # 3-panel debug UI
  src/shared/   → Both          # Types & protocol shared between server/client
```

**Dev mode**: Vite dev server (port 5173) proxies `/api/*` and `/ws` to Bun backend (port 7432).
**Production**: Vite builds to `dist/client/`, Bun.serve serves static files + API from single port.

---

## Scope: Phase A (MVP) Only

| In Scope | Out of Scope (Phase B/C) |
|----------|--------------------------|
| Session list with metadata | Tool flow timeline waterfall |
| Conversation view (messages, tool cards) | Token usage charts |
| Detail inspector (full JSON) | Session tree view (React Flow) |
| Live-tail via WebSocket | Mermaid sequence diagrams |
| Text search across session | Diff view for edit tools |
| Compaction/thinking display | Cost tracking, export |

---

## Tasks

### Task 1: Package Scaffolding + Sample Data

Create workspace package and mock JSONL files for development.

**Create**:
- `packages/debug-viewer/package.json` — `@diligent/debug-viewer`, deps: react 19, react-dom, react-json-view-lite, marked; devDeps: vite, @vitejs/plugin-react, typescript, @types/react, @types/bun. **No `@diligent/core` dependency.**
- `packages/debug-viewer/tsconfig.json` — extends root, adds `jsx: "react-jsx"`, `lib: ["ESNext", "DOM", "DOM.Iterable"]`
- `packages/debug-viewer/vite.config.ts` — React plugin, build to `dist/client/`, proxy `/api` and `/ws` to localhost:7432
- `packages/debug-viewer/index.html` — Vite entry HTML
- `packages/debug-viewer/src/server/sample-data/generate.ts` — generates sample JSONL:
  - `sessions/sample-001.jsonl` — 2 turns, 1 tool call each (simple)
  - `sessions/sample-002.jsonl` — 5 turns, multiple tools, one error (complex)
  - `sessions/sample-003.jsonl` — 3 turns + compaction entry + forked branch
  - `knowledge/knowledge.jsonl` — 5 entries (one per knowledge type)

Sample data uses exact D036-REV format matching `packages/core/src/types.ts`:
- SessionHeader: `{ type: "session_header", id, timestamp, cwd, version }`
- Messages: `{ id, parentId?, role, content, timestamp, ... }`
- ContentBlocks: TextBlock, ToolCallBlock, ThinkingBlock
- CompactionEntry: `{ id, parentId?, type: "compaction", summary, details }`

**Verify**: `bun install` succeeds, `generate.ts` produces valid JSONL files.

---

### Task 2: Shared Types + JSONL Parser

Convention-based types (duplicated from core by convention, NOT imported) and the critical JSONL parser.

**Create**:
- `src/shared/types.ts` — All viewer-local types:
  - ContentBlock union (TextBlock | ImageBlock | ThinkingBlock | ToolCallBlock)
  - Usage interface
  - SessionEntry union (SessionHeader | UserMessageEntry | AssistantMessageEntry | ToolResultEntry | CompactionEntry)
  - KnowledgeEntry (D081 schema)
  - Derived: SessionTree, ToolCallPair, SessionMeta
- `src/shared/protocol.ts` — REST response shapes, WebSocket message types
- `src/server/parser.ts`:
  - `parseSessionFile(filePath): Promise<SessionEntry[]>`
  - `detectEntryType(raw): SessionEntry` — check `role` first (user/assistant/tool_result), then `type` (session_header/compaction), unknown → skip with warning
  - `buildTree(entries): SessionTree` — group by parentId, identify roots
  - `pairToolCalls(entries): ToolCallPair[]` — match ToolCallBlock.id ↔ ToolResultEntry.toolCallId
  - `extractSessionMeta(filePath, entries): SessionMeta`
  - `IncrementalParser` class — tracks file offset + partial line for live-tail
- `test/parser.test.ts` — test against all 3 sample files, unknown entries, partial/malformed lines

**Depends on**: Task 1
**Verify**: `bun test packages/debug-viewer/test/parser.test.ts`

---

### Task 3: Backend Server (REST API)

Bun.serve with REST endpoints and static file serving.

**Create**:
- `src/server/find-diligent-dir.ts` — findUp for `.diligent/`, `--sample` flag uses sample data dir
- `src/server/api.ts` — route handler:
  ```
  GET /api/sessions              → SessionMeta[] (sorted by mtime desc)
  GET /api/sessions/:id          → SessionEntry[]
  GET /api/sessions/:id/tree     → SessionTree
  GET /api/knowledge             → KnowledgeEntry[]
  GET /api/search?q=term&session=id → search results
  ```
- `src/server/index.ts` — CLI args (--port, --sample, --dev), start Bun.serve, startup banner
- `test/api.test.ts` — start server on random port, test all endpoints with sample data

**Depends on**: Task 2
**Verify**: `bun test packages/debug-viewer/test/api.test.ts`, `curl http://localhost:7432/api/sessions`

---

### Task 4: React Layout Shell + Session List

3-panel CSS Grid layout with functional session sidebar.

**Create**:
- `src/client/main.tsx` — React entry, mount App
- `src/client/App.tsx` — CSS Grid: sidebar (280px) | main (1fr) | detail (350px, collapsible)
- `src/client/App.css` — Dark theme (bg: #1a1a2e, accent: #53c0f0)
- `src/client/components/SessionList.tsx` — sorted by timestamp, shows id/time/count, click to select
- `src/client/hooks/useSessions.ts` — fetch `GET /api/sessions` on mount
- `src/client/lib/types.ts` — re-export from shared/types

**Depends on**: Task 3
**Verify**: Start backend with `--sample`, open localhost:5173, see 3 sessions in sidebar

---

### Task 5: Conversation View + Tool Call Cards

Core of the MVP — rendering the conversation thread.

**Create**:
- `src/client/hooks/useSession.ts` — fetch `GET /api/sessions/:id`, return typed entries + tree
- `src/client/lib/tree.ts` — client-side `buildSessionTree()`, `getLinearPath()` (main branch walk), `hasForking()`
- `src/client/lib/toolPairing.ts` — client-side `pairToolCalls()` keyed by toolCallId
- `src/client/components/ConversationView.tsx` — vertical list from linear path, auto-scroll
- `src/client/components/MessageCard.tsx`:
  - UserMessage: green-left-border, plain text or markdown
  - AssistantMessage: blue-left-border, markdown via `marked`, usage/model badges, inline ToolCallCards
  - CompactionEntry: yellow divider, summary text, file lists
- `src/client/components/ToolCallCard.tsx` — compact card (icon + name + input preview), expandable, red if error
- `src/client/components/JsonViewer.tsx` — react-json-view-lite wrapper, dark theme
- `test/tree.test.ts`, `test/toolPairing.test.ts`

**Depends on**: Task 4
**Verify**: Select sessions → conversation renders with tool cards, markdown, compaction markers

---

### Task 6: Detail Inspector + Search

Right panel for full raw data + text search across session.

**Create**:
- `src/client/components/DetailInspector.tsx` — slides in on selection, shows type badge, ID, timestamp, full JSON, "Copy JSON" button
- `src/client/components/SearchBar.tsx` — debounced input (300ms), match count, Enter navigates
- `src/client/hooks/useSearch.ts` — case-insensitive substring search across all entry text fields

**Depends on**: Task 5
**Verify**: Click message → inspector shows raw data. Search "package.json" → finds matches.

---

### Task 7: WebSocket Live-Tail + Polish

Real-time updates when session files change.

**Create/Modify**:
- `src/server/watcher.ts` — `fs.watch` on sessions dir, IncrementalParser for delta reads, 100ms debounce, 2s polling fallback
- `src/server/websocket.ts` — connection tracking (Map<WS, Set<sessionId>>), push `session_updated`/`session_created`
- `src/client/hooks/useWebSocket.ts` — connect, reconnect with backoff, subscribe/unsubscribe
- Update `src/server/index.ts` — wire WebSocket upgrade
- Update `src/client/hooks/useSession.ts` — subscribe on select, append new entries on ws message
- Update `src/client/components/SessionList.tsx` — "live" indicator, add new sessions from ws
- `test/watcher.test.ts` — append to file → watcher emits new entry

**Depends on**: Task 6
**Verify**: Append line to sample JSONL → browser updates without refresh. Connection indicator shows green/red.

---

## Dependency Graph

```
Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7
  pkg      types    server    layout    convo    detail    live
  setup    parser   REST API  sidebar   view     search    tail
```

---

## Key Reference Files

| File | Purpose |
|------|---------|
| `packages/core/src/types.ts` | Source of truth for ContentBlock, Message, Usage — viewer duplicates by convention |
| `packages/core/package.json` | Pattern for package.json structure |
| `packages/core/tsconfig.json` | Pattern for tsconfig extending root |
| `research/temp/debug-web-ui.md` | Full research: UI mockups, parser design, tech stack rationale |
| `plan/decisions.md` | D036-REV (JSONL format), D080 (.diligent/ layout), D081 (knowledge schema) |

---

## File Structure (Final)

```
packages/debug-viewer/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── src/
│   ├── shared/
│   │   ├── types.ts
│   │   └── protocol.ts
│   ├── server/
│   │   ├── index.ts
│   │   ├── api.ts
│   │   ├── parser.ts
│   │   ├── watcher.ts
│   │   ├── websocket.ts
│   │   ├── find-diligent-dir.ts
│   │   └── sample-data/
│   │       ├── generate.ts
│   │       ├── sessions/
│   │       │   ├── sample-001.jsonl
│   │       │   ├── sample-002.jsonl
│   │       │   └── sample-003.jsonl
│   │       └── knowledge/
│   │           └── knowledge.jsonl
│   └── client/
│       ├── main.tsx
│       ├── App.tsx
│       ├── App.css
│       ├── components/
│       │   ├── SessionList.tsx
│       │   ├── ConversationView.tsx
│       │   ├── MessageCard.tsx
│       │   ├── ToolCallCard.tsx
│       │   ├── DetailInspector.tsx
│       │   ├── SearchBar.tsx
│       │   └── JsonViewer.tsx
│       ├── hooks/
│       │   ├── useSessions.ts
│       │   ├── useSession.ts
│       │   ├── useWebSocket.ts
│       │   └── useSearch.ts
│       └── lib/
│           ├── types.ts
│           ├── tree.ts
│           └── toolPairing.ts
└── test/
    ├── parser.test.ts
    ├── api.test.ts
    ├── watcher.test.ts
    ├── tree.test.ts
    └── toolPairing.test.ts
```

---

## Verification (End-to-End)

After all 7 tasks:
1. `bun install` — workspace resolves
2. `bun test packages/debug-viewer/` — all tests pass
3. `bun run packages/debug-viewer/src/server/index.ts --sample` — server starts
4. Open `http://localhost:7432` — see 3 sample sessions
5. Click session → conversation renders with tool cards and markdown
6. Click any item → detail inspector shows full JSON
7. Search finds content across messages and tool output
8. Append line to sample JSONL → live-tail updates browser
9. `bun run lint` — no lint errors

---

## Post-MVP: Phase 3 Validation

When Phase 3 lands (real session persistence):
1. Run the agent, have a conversation with tool calls
2. Start debug viewer without `--sample` flag
3. Verify real sessions render correctly
4. Update `src/shared/types.ts` if format diverges from planned D036-REV
