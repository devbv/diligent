# Layer 0: REPL Loop

## Key Questions

1. How does each project structure the basic conversation loop (user input → LLM → response)?
2. What are the core message/event types?
3. How is the LLM provider abstracted?
4. What is the boundary between CLI entry and agent core?

## codex-rs Analysis

**Architecture:** Rust monorepo with clear crate separation (cli → tui → core → protocol → backend-client).

**Entry Flow:**
- CLI (`cli/src/main.rs`) uses clap, dispatches to TUI
- TUI (`tui/src/lib.rs`) spawns `ThreadManager` → creates `Codex` sessions
- `App::run()` drives the main event loop

**Core Types (protocol/src/protocol.rs):**
- `Op` (user→agent): UserInput, UserTurn, Interrupt, ExecApproval, PatchApproval, Shutdown, ~20 more
- `EventMsg` (agent→user): TurnStarted, TurnComplete, AgentMessage, AgentMessageDelta, ExecCommandBegin, TokenCount, ~50+ variants
- Wrapped in `Submission { id, op }` and `Event { id, msg }` for correlation

**Agent Loop (core/src/codex.rs):**
- `submission_loop()` receives `Submission` from channel, dispatches by `Op` type
- Async channels: `tx_sub: Sender<Submission>`, `rx_event: Receiver<Event>` (capacity 512)
- Pattern: tokio mpsc channels for bidirectional async communication

**Provider Abstraction:**
- `ModelClient` (session-scoped) → `ModelClientSession` (turn-scoped)
- Supports WebSocket v1/v2, HTTP/SSE fallback
- `AuthManager` handles token refresh
- Backends: Codex API (OpenAI), ChatGPT, OSS models (lmstudio, ollama)

**CLI/Core Boundary:**
```
CLI (arg parsing) → TUI (rendering, event loop) → Core (Codex session, agent loop) → Protocol (pure types)
```

## pi-agent Analysis

**Architecture:** TypeScript monorepo with packages: coding-agent (CLI), agent (core loop), ai (providers).

**Entry Flow:**
- `cli.ts` → `main.ts` → parses args → creates `AgentSession`
- Routes to: InteractiveMode (TUI), PrintMode (one-shot), RPCMode (JSON-RPC)
- InteractiveMode calls `session.prompt()` to kick off first turn

**Core Types:**
- Messages: `UserMessage`, `AssistantMessage`, `ToolResultMessage` (discriminated by `role`)
- `AgentEvent`: agent_start/end, turn_start/end, message_start/update/end, tool_execution_start/update/end
- `AssistantMessageEvent`: text_delta, thinking_delta, toolcall_delta, done, error (fine-grained streaming)

**Agent Loop (agent/src/agent-loop.ts):**
- `agentLoop()` / `agentLoopContinue()` entry points
- `runLoop()`: outer while(true) with inner tool-call processing loop
- Streaming via `streamAssistantResponse()`: calls `config.convertToLlm()` → `streamSimple()`
- Sequential tool execution with steering message interruption support

**Provider Abstraction:**
- Plugin-based registry: `registerApiProvider({ api, stream, streamSimple })`
- Supports: anthropic-messages, openai-completions, openai-responses, google, bedrock, azure, vertex
- Unified `AssistantMessageEvent` streaming format across all providers
- Runtime registration (extensible)

**CLI/Core Boundary:**
```
coding-agent (CLI/TUI/RPC) → AgentSession → agent (loop, tools, events) → ai (providers, streaming)
```

## opencode Analysis

**Architecture:** TypeScript/Bun monorepo. Heavy use of ai-sdk. Server-based architecture with SDK client.

**Entry Flow:**
- Binary launcher → `src/index.ts` → yargs commands
- TuiThreadCommand: Worker thread for backend, RPC/HTTP to communicate, Solid.js TUI
- RunCommand: Direct bootstrap → SDK client → `sdk.session.prompt()`

**Core Types (session/message-v2.ts):**
- `MessageV2.User`, `MessageV2.Assistant` with rich part types
- Parts: TextPart, FilePart, ToolPart, ReasoningPart, AgentPart, StepStartPart, StepFinishPart, PatchPart, CompactionPart, SubtaskPart
- Tool state machine: Pending → Running → Completed/Error
- Session events: Created, Updated, Deleted, Diff, Error, Status

**Agent Loop (session/prompt.ts):**
- `loop()` function with while(true)
- Handles subtasks, compaction, and normal processing
- Normal flow: Agent config → resolve tools → build messages → create processor → LLM.stream()
- `SessionProcessor.process()`: streams via ai-sdk, processes events, handles tool execution, manages retries

**Provider Abstraction:**
- Built on ai-sdk with custom provider wrappers
- Bundled providers: anthropic, openai, google, vertex, openrouter, and more
- `Provider.getLanguage()` resolves SDK provider instances
- `ProviderTransform` handles token limits, schema transforms, temperature defaults
- Custom loaders for special cases (anthropic beta headers, OpenAI responses API)

**CLI/Core Boundary:**
```
TUI (Solid.js worker) / CLI → SDK Client (HTTP/RPC) → Hono Server → Session/Prompt → LLM/Provider
```
- Database (SQLite/Drizzle ORM) as source of truth
- Event bus for reactive updates
- Complete separation: agent core has zero TUI/CLI dependencies

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|---|---|---|---|
| **Language** | Rust | TypeScript | TypeScript (Bun) |
| **Loop Pattern** | Channel-based (mpsc) | Async generator / while loop | While loop with processor |
| **Message Format** | Tagged union (Op/Event) | Discriminated union (role) | Part-based messages |
| **Streaming** | WebSocket + HTTP/SSE | AsyncIterable events | ai-sdk streamText |
| **Provider Abstraction** | ModelClient (session/turn) | Registry + plugin pattern | ai-sdk + custom wrappers |
| **CLI/Core Boundary** | Crate separation | Package separation | Server/client (HTTP/RPC) |
| **State Storage** | In-memory | JSONL files | SQLite database |
| **Event Granularity** | Very fine (50+ event types) | Medium (15+ event types) | Medium (part-based updates) |
| **Multi-mode** | TUI only | Interactive + Print + RPC | TUI + CLI Run |

## Open Questions

1. **Event granularity**: codex-rs has 50+ event types which is very detailed but complex. pi-agent has ~15, which seems like a good middle ground. What's the right level for diligent?
2. **Streaming transport**: codex-rs uses WebSocket, pi-agent uses AsyncIterable, opencode uses ai-sdk. Direct fetch+SSE (planned for diligent) is simpler but less tested at scale.
3. **State persistence**: All three have different approaches (in-memory, JSONL, SQLite). This affects session resume capabilities significantly.
4. **Server architecture**: opencode has a full HTTP server between TUI and core. Is this over-engineering for early stages or a good foundation for extensibility?
5. **Provider SDK usage**: opencode uses ai-sdk heavily, pi-agent rolls its own, codex-rs is Rust-native. The "no SDK" approach (planned for diligent) offers more control but more maintenance.
