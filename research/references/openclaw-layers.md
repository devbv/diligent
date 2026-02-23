# Reference Research: OpenClaw — Layer-Mapped Analysis

Date: 2026-02-23
Repo: https://github.com/openclaw/openclaw
Stack: TypeScript, built on `@mariozechner/pi-agent-core` + `@mariozechner/pi-coding-agent`
Supplementary: `openclaw-memory-system.md` (memory & context overflow deep-dive)

---

## Table of Contents

- [L0: Provider](#l0-provider)
- [L1: Agent Loop](#l1-agent-loop)
- [L2: Tool System](#l2-tool-system)
- [L3: Core Tools](#l3-core-tools)
- [L4: Approval](#l4-approval)
- [L5: Config](#l5-config)
- [L6: Session](#l6-session)
- [L7: TUI & Commands](#l7-tui--commands)
- [L8: Skills](#l8-skills)
- [L9: MCP](#l9-mcp)
- [L10: Multi-Agent](#l10-multi-agent)
- [Cross-Cutting Observations](#cross-cutting-observations)

---

## L0: Provider

### Architecture

OpenClaw does NOT implement its own provider interface. It delegates to `@mariozechner/pi-ai` which abstracts providers through `Model<Api>`. Each provider registers an `api` field: `"anthropic"`, `"openai-completions"`, `"openai-responses"`, `"google-generative"`, etc.

### Key Files

| File | Role |
|------|------|
| `src/agents/pi-embedded-runner/model.ts` | Model resolution & discovery |
| `src/agents/pi-model-discovery.ts` | Model registry & auth storage init |
| `src/agents/model-auth.ts` | API key resolution, auth mode handling |
| `src/agents/auth-profiles/` | Multi-profile auth (store, profiles, usage, order, oauth) |
| `src/agents/model-selection.ts` | Provider normalization, model ref parsing |
| `src/agents/pi-embedded-runner/extra-params.ts` | Provider-specific streaming parameters |
| `src/agents/usage.ts` | Token counting / cost calculation |
| `src/agents/failover-error.ts` | Error classification (retryable vs fatal) |

### Provider Abstraction

```typescript
// No custom Provider trait — relies on pi-ai's Model<Api>:
type StreamFn = (
  model: Model<Api>,
  context: ExtensionContext,
  options?: SimpleStreamOptions
) => AsyncIterable<AgentEvent>

// Wraps streamSimple with provider-specific parameters:
function createStreamFnWithExtraParams(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): StreamFn | undefined
```

### Multi-Profile Auth

```typescript
type ResolvedProviderAuth = {
  apiKey?: string;
  profileId?: string;
  source: string;
  mode: "api-key" | "oauth" | "token" | "aws-sdk";
};

// Auth profile store (auth.json):
// - Multiple credentials per provider
// - lastGood tracking for sticky routing
// - Cooldown periods after auth failures
// - Automatic rotation on failure
```

### Token Counting

```typescript
type UsageLike = {
  input?: number; output?: number;
  cacheRead?: number; cacheWrite?: number;
  total?: number;
  // + provider-specific aliases (inputTokens, promptTokens, etc.)
};

function normalizeUsage(raw?: UsageLike): NormalizedUsage | undefined
// Token estimation: chars/4 heuristic + SAFETY_MARGIN = 1.2 (20% buffer)
```

### Error Classification

```typescript
type FailoverReason =
  | "auth" | "billing" | "rate_limit" | "timeout"
  | "format" | "model_not_found" | "context_overflow"
  | "compaction_failure" | "image_size" | "role_ordering";

class FailoverError extends Error {
  readonly reason: FailoverReason;
  readonly provider?: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly status?: number;
}

function isLikelyContextOverflowError(errorMessage?: string): boolean
// Patterns: "context window", "prompt is too long", "request_too_large", etc.
// Excludes rate limit messages to avoid false positives
```

### Provider-Specific Quirks

| Provider | Quirk Handling |
|----------|---------------|
| Anthropic | Cache control via `anthropic-beta` header, 1M context beta |
| OpenAI | Force `store=true` for direct API, OAuth for Codex |
| Google Gemini | Turn ordering validation (no consecutive same-role) |
| OpenRouter | Pass-through proxy, provider routing preferences |
| Ollama/vLLM | Dummy API key for local providers |

### Design Decisions

| Decision | OpenClaw Choice | Implication |
|----------|----------------|-------------|
| Provider interface | None — delegates to pi-ai `Model<Api>` | Zero-cost new provider support via config |
| Auth management | Multi-profile store with failover + cooldown | Production-grade key rotation |
| Token estimation | chars/4 + 20% safety margin | No tokenizer dependency, acceptable accuracy |
| Error classification | 3-layer: HTTP code → error text → fuzzy match | Covers all provider error formats |
| Streaming | `AsyncIterable<AgentEvent>` from pi-ai | Uniform event model across providers |

---

## L1: Agent Loop

### Architecture

The agent loop is built on `@mariozechner/pi-coding-agent`'s `AgentSession`. OpenClaw wraps it with retry logic, context overflow recovery, event streaming, and system prompt assembly.

### Key Files

| File | Role |
|------|------|
| `src/agents/pi-embedded-runner/run.ts` | Main agent run orchestration |
| `src/agents/pi-embedded-runner/run/attempt.ts` | Single LLM attempt execution |
| `src/agents/pi-embedded-runner/run/payloads.ts` | Assistant output → user-facing payloads |
| `src/agents/pi-embedded-subscribe.ts` | Event streaming & message accumulation |
| `src/agents/pi-embedded-subscribe.handlers.*.ts` | Event handlers (lifecycle, messages, tools) |
| `src/agents/pi-embedded-runner/compact.ts` | Session compaction (context recovery) |
| `src/agents/pi-embedded-runner/system-prompt.ts` | System prompt assembly |
| `src/agents/compaction.ts` | Message summarization algorithm |
| `src/agents/context-window-guard.ts` | Context window size resolution |

### Turn Lifecycle

```
1. User message added to session
2. System prompt assembled (dynamic: time, tools, workspace, skills)
3. Messages sent to LLM via streamSimple()
4. Events streamed via AsyncIterable<AgentEvent>
5. Tool calls parsed from response → dispatched to tool system
6. Tool results added back → LLM continues
7. Stop reason reached → turn ends
```

### Retry Strategy

```typescript
const BASE_RUN_RETRY_ITERATIONS = 24;
const RUN_RETRY_ITERATIONS_PER_PROFILE = 8;
const MAX_RUN_RETRY_ITERATIONS = 160;

// On failure:
// 1. Classify: auth/rate_limit/context_overflow/fatal
// 2. Retryable → next auth profile, backoff, or compaction
// 3. Fatal → return error immediately
```

### Context Overflow Recovery

```
Detect: isLikelyContextOverflowError()
  → MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3
  → Trigger compaction: summarizeInStages()
  → Retry with compressed history
  → If still overflows: truncateOversizedToolResultsInSession()
  → Safety timeout: EMBEDDED_COMPACTION_TIMEOUT_MS = 300_000 (5 min)
```

### Compaction Algorithm

```typescript
const BASE_CHUNK_RATIO = 0.4;
const MIN_CHUNK_RATIO = 0.15;
const SAFETY_MARGIN = 1.2;
const SUMMARIZATION_OVERHEAD_TOKENS = 4096;

// 1. pruneHistoryForContextShare() — drop oldest chunks
// 2. summarizeInStages() — chunk → individual summary → merge
// 3. computeAdaptiveChunkRatio() — adjust based on avg message size
// 4. Failure fallback: "Context contained N messages. Summary unavailable."
```

### System Prompt Assembly

```typescript
function buildEmbeddedSystemPrompt(params: {
  workspaceDir: string;
  promptMode?: "full" | "minimal";
  extraSystemPrompt?: string;
  skillsPrompt?: string;
  tools: AgentTool[];
  runtimeInfo: { agentId, host, os, arch, model, provider, capabilities, channel };
  userTimezone: string;
  contextFiles?: EmbeddedContextFile[];
  // ... 20+ parameters
}): string

// System prompt NOT stored in session — regenerated each run
// Incorporates: identity, workspace, tools, runtime env, channel guidance,
//   memory citations, reasoning/thinking tags, custom docs, TTS guidance
```

### Streaming Event Model

```typescript
// subscribeEmbeddedPiSession() maintains state machine:
// - assistantTexts[], toolMetas[], deltaBuffer, blockBuffer
// - Tracks: thinking blocks, reasoning mode, compaction state
// - Block chunking: intelligent splitting (paragraph > sentence > heading)
//   with code block awareness (don't split inside ```)
```

### Design Decisions

| Decision | OpenClaw Choice | Implication |
|----------|----------------|-------------|
| Loop model | Delegate to pi-coding-agent + wrap | Thin layer over battle-tested library |
| System prompt | Regenerated each run (not persisted) | Always fresh context (time, tools, workspace) |
| Compaction | Multi-stage summarization + adaptive chunking | Handles variable message sizes |
| Tool details | Never included in LLM prompts/summaries | Security + context savings |
| Retry | Profile-aware failover (up to 160 iterations) | Resilient multi-key rotation |
| Streaming | Stateful event-driven accumulation | Correct handling of thinking/tool/text blocks |

---

## L2: Tool System

### Architecture

Built on pi-agent-core's `AgentTool` type, extended with policy management, hook wrapping, and provider-specific schema normalization.

### Key Files

| File | Role |
|------|------|
| `src/agents/pi-tools.ts` | Main tool creation and composition |
| `src/agents/pi-tool-definition-adapter.ts` | Adapter: pi-agent-core ↔ OpenClaw |
| `src/agents/tool-policy-pipeline.ts` | Policy application pipeline |
| `src/agents/tool-policy.ts` | Policy enforcement and authorization |
| `src/agents/tool-policy-shared.ts` | Shared policy utilities |
| `src/plugins/tools.ts` | Plugin tool resolution |
| `src/agents/pi-tools.schema.ts` | Provider-specific schema normalization |
| `src/agents/pi-tools.before-tool-call.ts` | Loop detection & hooks |

### Tool Definition

```typescript
type AgentTool<P = any, R = unknown> = {
  name: string;
  label?: string;
  description?: string;
  parameters?: Record<string, unknown>;  // JSON Schema
  ownerOnly?: boolean;
  execute: (
    toolCallId: string, params: P,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<R>
  ) => Promise<AgentToolResult<R>>;
};

type AgentToolResult<R = unknown> = {
  content: Array<{
    type: "text" | "image" | "document";
    text?: string; data?: string; mimeType?: string;
  }>;
  details?: {
    status?: "completed" | "failed" | "pending";
    truncation?: { truncated: boolean; outputLines?: number };
    [key: string]: unknown;
  };
};
```

### Tool Wrapping Pipeline

```
1. Create base tools (from pi-coding-agent + OpenClaw custom)
2. Resolve plugin tools (dynamic discovery via resolvePluginTools())
3. Apply policy pipeline (profile → provider → group → agent → sandbox)
4. Normalize schemas for provider (Gemini/OpenAI quirks)
5. Add hooks (loop detection, before/after tool call)
6. Add abort signal support
```

### Policy Pipeline

```
Profile Policy (minimal/coding/messaging/full)
  ↓
Provider Profile (anthropic-specific, etc.)
  ↓
Global tools.allow/deny
  ↓
Global tools.byProvider.allow/deny
  ↓
Agent-specific tools.allow/deny
  ↓
Agent tools.byProvider.allow/deny
  ↓
Channel/Group policies
  ↓
Sandbox policies
  ↓
Subagent depth-based policies
```

### Tool Result Truncation

```typescript
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;   // 30% of context window
const HARD_MAX_TOOL_RESULT_CHARS = 400_000;   // Universal cap (~100K tokens)
const MIN_KEEP_CHARS = 2_000;                 // Always keep opening

maxChars = min(contextWindowTokens * 0.3 * 4, 400_000)
// Proportional truncation for multi-block results
// Suffix: "⚠️ [Content truncated — original was too large...]"
```

### Loop Detection

```typescript
const LOOP_WARNING_BUCKET_SIZE = 10;    // calls per bucket
const MAX_LOOP_WARNING_KEYS = 256;      // max tracked tool patterns
// Fires warning when same tool called repeatedly with similar args
```

### Design Decisions

| Decision | OpenClaw Choice | Implication |
|----------|----------------|-------------|
| Registry | No persistent registry — tools resolved per-session | Dynamic based on config/plugins |
| Schema | Provider-specific normalization (Gemini, OpenAI) | Broad model compatibility |
| Policy | Multi-layer pipeline with plugin group expansion | Fine-grained access control |
| Truncation | 30% context share, 400K char hard cap | Prevents single tool from filling context |
| Hooks | Before/after tool call with priority ordering | Extensible interception points |
| Progress | `onUpdate` callback with typed progress events | Real-time streaming to UI |

---

## L3: Core Tools

### Tool Inventory

#### File Operations (read, write, edit, apply_patch)
- Base from `@mariozechner/pi-coding-agent`, sandboxed variants in OpenClaw
- Adaptive read: `ADAPTIVE_READ_CONTEXT_SHARE = 0.2` → 50KB–512KB based on context window

#### Shell Execution (exec)
```typescript
// src/agents/bash-tools.exec.ts (600+ lines)
const execSchema = Type.Object({
  command: Type.String(),
  workdir?: Type.String(),
  env?: Type.Record(Type.String(), Type.String()),
  timeout?: Type.Number(),
  background?: Type.Boolean(),
  pty?: Type.Boolean(),
  host?: Type.String(),      // "sandbox" | "gateway" | "node"
  security?: Type.String(),  // "deny" | "allowlist" | "full"
  ask?: Type.String(),       // "off" | "on-miss" | "always"
});

// Limits:
DEFAULT_MAX_OUTPUT = 200_000 chars
DEFAULT_TIMEOUT_SEC = 1800 (30 min)
```

#### Background Process Management (process)
```typescript
// src/agents/bash-tools.process.ts (500+ lines)
// Actions: list | poll | log | kill | write | send-keys | paste
// Per-scope (session/agent) process registry with TTL cleanup
```

#### Web Tools (web_search, web_fetch)
- External search provider + readability parsing
- SSRF protection, markdown extraction

#### Session Tools (sessions_list, sessions_history, sessions_spawn, sessions_send, subagents)
- Spawn sub-agents, send messages, query history
- Subagent depth limiting

#### Memory Tools (memory_search, memory_get)
- Semantic vector search, citation tracking, session-scoped isolation

#### Media Tools (image, tts, browser, canvas)
- Vision understanding, TTS, headless browser, interactive UI

### Security Features

1. **Owner-Only Tools**: whatsapp_login, cron, gateway
2. **Workspace Root Guard**: File ops confined when `fs.workspaceOnly=true`
3. **Safe Binary Profiles**: exec validates against allowlist
4. **Script Preflight**: Detects shell variable injection
5. **SSRF Protection**: web_fetch validates against blocklist
6. **Sandbox Isolation**: Docker container execution

### Key Limits

| Limit | Value |
|-------|-------|
| Max tool result chars | 400,000 |
| Default read page | 50 KB |
| Max adaptive read | 512 KB |
| Max exec output | 200,000 chars |
| Default exec timeout | 1800 sec (30 min) |
| Loop warning bucket | 10 calls |

---

## L4: Approval

### Architecture

Socket-based approval server with file-persisted allowlist. Two-phase: request (JSON → socket) → decision (JSON response).

### Key Files

| File | Role |
|------|------|
| `src/infra/exec-approvals.ts` | Core approval runtime: socket, persistence, allowlist |
| `src/infra/exec-approvals-allowlist.ts` | Allowlist pattern matching & evaluation |
| `src/infra/exec-approvals-analysis.ts` | Shell command static analysis & safety checks |
| `src/agents/bash-tools.exec-approval-request.ts` | Socket approval request formatting |
| `src/security/audit.ts` | Security audit framework |
| `src/config/types.approvals.ts` | Approval config types |

### Permission Model

```typescript
type ExecAsk = "off" | "on-miss" | "always";
type ExecSecurity = "deny" | "allowlist" | "full";

type ExecApprovalRequest = {
  id: string;
  request: { command, cwd, host, security, ask, agentId, sessionKey };
  createdAtMs: number;
  expiresAtMs: number;   // 120s default timeout
};

type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";
```

### Approval Fallback Chain

```
if (ask === "always"):
  ask user → denied? → fall back to askFallback security level
elif (ask === "on-miss"):
  if (security === "allowlist" && (!analysisOk || !allowlistSatisfied)):
    ask user
  else:
    proceed with security level
else (ask === "off"):
  proceed with security level

// Security merging: minSecurity() (most restrictive wins)
// Ask merging: maxAsk() (most prompting wins)
```

### Persistence

```typescript
// ~/.openclaw/exec-approvals.json
type ExecApprovalsFile = {
  version: 1;
  socket?: { path?: string; token?: string };   // auto-generated
  defaults?: ExecApprovalsDefaults;
  agents?: Record<string, ExecApprovalsAgent>;
};

// File mode: 0o600 (owner read/write only)
// Token: 24-byte base64url random
```

### Allowlist Pattern Matching

```typescript
type ExecAllowlistEntry = {
  id?: string;
  pattern: string;               // shell glob (case-insensitive)
  lastUsedAt?: number;
  lastUsedCommand?: string;
  lastResolvedPath?: string;     // resolved binary path for auditing
};
```

### Doom Loop Prevention

No explicit doom loop detection — instead uses `askFallback` for controlled degradation. When user denies on `always` ask, falls back to `askFallback` security (typically `"deny"`), preventing infinite re-asking.

### Design Decisions

| Decision | OpenClaw Choice | Implication |
|----------|----------------|-------------|
| Transport | Unix socket + JSON | Local IPC, no network exposure |
| Persistence | JSON file (exec-approvals.json) | Simple, human-readable |
| Anti-doom-loop | `askFallback` degrades gracefully | No infinite retry |
| Pattern format | Shell glob (case-insensitive) | Familiar to users |
| Timeout | 120s per request | Prevents hung approvals |
| Forwarding | Can forward to chat channels | Team approval workflows |

---

## L5: Config

### Architecture

JSON5 config file with Zod validation, `$include` directives, env variable expansion, and atomic file writes.

### Key Files

| File | Role |
|------|------|
| `src/config/config.ts` | Main export facade |
| `src/config/io.ts` | Config I/O: load, parse, write with atomic swaps |
| `src/config/paths.ts` | Config path resolution, legacy support |
| `src/config/types.ts` + `types.*.ts` | All type definitions (~150+ files) |
| `src/config/zod-schema.ts` | Zod schema compilation & JSON schema export |
| `src/config/validation.ts` | Validation logic & issue reporting |
| `src/config/includes.ts` | `$include` directive for modular configs |
| `src/config/merge-patch.ts` | RFC 6902 merge-patch + id-keyed array merging |
| `src/config/env-substitution.ts` | `${VAR}` variable expansion with validation |
| `src/config/env-preserve.ts` | Restore `${VAR}` refs when writing back |

### Config Format & Discovery

```
Format: JSON5 (comments, trailing commas, etc.)
Default path: ~/.openclaw/openclaw.json
Override: OPENCLAW_CONFIG_PATH env var
Legacy: ~/.clawdbot/, ~/.moldbot/, ~/.moltbot/

File mode: 0o600 (owner read/write only)
Write: temp file + atomic rename (POSIX); 3-retry backoff (Windows)
```

### Config Hierarchy

```
$include directives (deep merge, max depth 10, circular detection)
  → env.vars inline overrides
  → ${VAR} substitution (validated, restored on write)
  → env.shellEnv (lazy import from $SHELL -l -c 'env -0')
  → Zod schema validation
  → Semantic validation (duplicates, accessibility)
  → Plugin-specific validation
```

### Include System

```json5
{
  "$include": "./base.json5",             // single file
  "$include": ["./a.json5", "./b.json5"], // multiple (merged in order)
  "agents": { ... }                       // local overrides
}
```

### Merge Strategy

```typescript
// Two-phase:
// 1. applyMergePatch (RFC 6902-like): deep merge, null deletes keys
// 2. mergeObjectArraysById: arrays with id fields merge by id, not replace
```

### Env Variable Handling

```typescript
// Three mechanisms:
// 1. ${VAR} expansion: "token": "${OPENAI_API_KEY}" — validated at load
// 2. env.vars inline: "env": { "vars": { "CUSTOM_KEY": "value" } }
// 3. env.shellEnv: runs $SHELL -l -c 'env -0' to import missing secrets (15s timeout)
```

### No CLAUDE.md Equivalent

OpenClaw does NOT have project-scoped instruction files. Config is centralized at `~/.openclaw/openclaw.json` with `$include` for modularity.

### Design Decisions

| Decision | OpenClaw Choice | Implication |
|----------|----------------|-------------|
| Format | JSON5 (not JSONC) | More permissive (unquoted keys, trailing commas) |
| Validation | Zod (TypeScript-first) | Type-safe, auto-generates JSON schema |
| Hierarchy | Single file + `$include` (no project-local) | Centralized control |
| Env vars | `${VAR}` with restore-on-write | Secrets never persisted in config |
| Shell env | Lazy `$SHELL -l -c 'env -0'` | Imports from login shell on demand |
| Merge | RFC 6902 + id-keyed arrays | Non-destructive array merging |

---

## L6: Session

### Architecture

Per-agent session metadata (JSON) + individual transcripts (JSONL). Session store uses 45s cache TTL with atomic writes.

### Key Files

| File | Role |
|------|------|
| `src/config/sessions/store.ts` | Session metadata store (JSON, cached) |
| `src/config/sessions/transcript.ts` | Append messages to JSONL transcripts |
| `src/config/sessions/types.ts` | `SessionEntry` & related types |
| `src/config/sessions/metadata.ts` | Derive session metadata from context |
| `src/config/sessions/paths.ts` | Path resolution & containment checks |
| `src/config/sessions/reset.ts` | Session reset & cleanup |
| `src/sessions/send-policy.ts` | Send policy evaluation |
| `src/sessions/transcript-events.ts` | Event emission for transcript updates |

### Storage Structure

```
~/.openclaw/agents/<agentId>/sessions/
├── sessions.json            ← Session metadata store (JSON)
└── <sessionId>.jsonl        ← Individual transcripts
    ├── {"type":"session","version":2,"id":"..."}     ← Header
    ├── {"type":"message","role":"user",...}           ← Messages
    ├── {"type":"message","role":"assistant",...}
    └── ...
```

### Session Entry

```typescript
type SessionEntry = {
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
  spawnedBy?: string;           // parent session key (for forks)
  forkedFromParent?: boolean;
  spawnDepth?: number;          // 0=main, 1+=sub-agent
  chatType?: "dm" | "group" | "channel";
  totalTokens?: number;
  totalTokensFresh?: boolean;
  compactionCount?: number;
  memoryFlushAt?: number;
  cacheRead?: number;
  cacheWrite?: number;
  origin?: SessionOrigin;       // where originated (provider, surface, from, to)
  deliveryContext?: DeliveryContext;
  // ... more fields
};
```

### Resume & Fork

```typescript
// Fork workflow:
// 1. Main session transcript appended normally
// 2. Thread/topic created → new session spawned (spawnedBy=parent key)
// 3. First append: forkedFromParent=true, spawnedBy preserved
// 4. Recursive: sub-agent sessions tracked via spawnDepth

// Session key format: agent:<agentId>:<sessionKey>
// Subagent key: agent:<agentId>:subagent:<uuid>
```

### Compaction & Maintenance

```typescript
type SessionMaintenanceConfig = {
  mode?: "off" | "auto" | "manual";
  compaction?: {
    enabled?: boolean;
    intervalMinutes?: number;
    maxTokens?: number;
    minMessagesForCompact?: number;
  };
  pruning?: {
    enabled?: boolean;
    olderThanDays?: number;
    retentionDays?: number;
  };
  archival?: { enabled?: boolean; archiveDir?: string };
};
```

### Send Policy

```typescript
// Per-session send policy (can override global):
// Priority: entry.sendPolicy → config rules (match by channel/chatType/keyPrefix) → default "allow"
cfg.session.sendPolicy.rules: Array<{
  match: { channel?, chatType?, keyPrefix?, rawKeyPrefix? };
  action: "allow" | "deny";
}>
```

### Design Decisions

| Decision | OpenClaw Choice | Implication |
|----------|----------------|-------------|
| Format | JSON (metadata) + JSONL (transcript) | Append-only transcripts, structured metadata |
| Cache | 45s TTL on metadata store | Balances freshness vs I/O |
| Versioning | version: 2 in session header | Forward migration support |
| Fork model | spawnedBy + spawnDepth tracking | Hierarchical session trees |
| Containment | Path validation, no escape from sessions dir | Security against path traversal |
| Events | In-memory listener for transcript updates | Enables UI refresh, memory indexing |

---

## L7: TUI & Commands

### Architecture

Component-based TUI using `@mariozechner/pi-tui` with chalk-based ANSI rendering. Slash commands dispatched via parsed command handlers.

### Key Files

| File | Role |
|------|------|
| `src/tui/tui.ts` | Main TUI orchestrator |
| `src/tui/tui-types.ts` | Type definitions |
| `src/tui/commands.ts` | Slash command definitions and help text |
| `src/tui/tui-command-handlers.ts` | Command handler implementations |
| `src/tui/tui-event-handlers.ts` | Event handling logic |
| `src/tui/tui-overlays.ts` | Overlay/modal management |
| `src/tui/components/chat-log.ts` | Chat message display |
| `src/tui/components/custom-editor.ts` | Custom input editor |
| `src/tui/components/markdown-message.ts` | Markdown rendering |
| `src/tui/theme/theme.ts` | Theme system (colors, syntax highlighting) |
| `src/terminal/ansi.ts` | ANSI escape code handling |

### Built-in Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show command help |
| `/status` | Gateway status summary |
| `/agent <id>` | Switch agent |
| `/session <key>` | Switch session |
| `/model <provider/model>` | Set model |
| `/think <level>` | Set thinking level |
| `/verbose <on\|off>` | Toggle verbose output |
| `/new` / `/reset` | Reset session |
| `/abort` | Abort active run |
| `/settings` | Open settings overlay |
| `/exit` / `/quit` | Exit TUI |

### Input Processing

```
1. Lines starting with `!` → bash execution
2. Lines starting with `/` → slash command dispatch
3. Regular text → send to agent
```

### Component Architecture

```
Container (pi-tui)
  ├── ChatLog (extends Container, max 180 components)
  │   ├── UserMessageComponent
  │   ├── AssistantMessageComponent (streaming via runId)
  │   ├── ToolExecutionComponent
  │   └── SystemMessageComponent
  ├── CustomEditor (input with history)
  └── Overlays (model/agent/session selectors, settings)
```

### Markdown Rendering

```typescript
class MarkdownMessageComponent extends Container {
  private body: Markdown;
  // Uses pi-tui Markdown component with custom theme
  // Syntax highlighting via cli-highlight
  // Semantic palette: accent, error, success, dim, borders
}
```

### Overlay System

```typescript
// Overlays: model selector, agent selector, session picker, settings
function openOverlay(component: Component): void
function closeOverlay(): void
// Focus automatically returns to editor on close
// Fuzzy filtering for large lists
```

### Design Decisions

| Decision | OpenClaw Choice | Implication |
|----------|----------------|-------------|
| Framework | `@mariozechner/pi-tui` (custom components) | Lightweight, component-based |
| Rendering | chalk + ANSI escape codes | Terminal-native, no external UI |
| Markdown | In-terminal with syntax highlighting | Rich display without browser |
| Streaming | runId-tracked concurrent message streams | Multi-agent output support |
| Commands | parseCommand() → handleCommand() switch | Simple, extensible dispatch |
| Overlays | showOverlay/hideOverlay with focus mgmt | Non-blocking UI modals |

---

## L8: Skills

### Architecture

Plugin-based system with `.md` frontmatter skills, TypeScript plugin modules, hook system with priority ordering, and plugin command registry.

### Key Files

| File | Role |
|------|------|
| `src/agents/skills/frontmatter.ts` | Skill metadata parsing from YAML frontmatter |
| `src/agents/skills/types.ts` | SkillEntry, SkillMetadata types |
| `src/agents/skills/plugin-skills.ts` | Plugin skill directory resolution |
| `src/plugins/discovery.ts` | Plugin candidate discovery with security checks |
| `src/plugins/loader.ts` | Plugin module loading (via jiti) |
| `src/plugins/manifest.ts` | Plugin manifest parsing (openclaw.plugin.json) |
| `src/plugins/hooks.ts` | Hook runner with priority ordering |
| `src/plugins/registry.ts` | Plugin registry management |
| `src/plugins/commands.ts` | Plugin command registration and dispatch |
| `src/plugins/tools.ts` | Tool resolution from plugins |
| `src/plugins/types.ts` | Complete plugin type definitions |

### Skill Definition (Frontmatter)

```typescript
type OpenClawSkillMetadata = {
  always?: boolean;            // Always include (non-filtering)
  skillKey?: string;           // Override skill name
  primaryEnv?: string;         // Primary env var
  os?: string[];               // Supported OSes
  requires?: {
    bins?: string[]; anyBins?: string[];
    env?: string[]; config?: string[];
  };
  install?: SkillInstallSpec[];
};

type SkillInvocationPolicy = {
  userInvocable: boolean;              // User can invoke explicitly
  disableModelInvocation: boolean;     // Block LLM from using
};
```

### Plugin Discovery

```
Sources (priority order):
1. Config-specified extra paths
2. Workspace .openclaw/extensions/
3. Global ~/.config/openclaw/extensions/
4. Bundled plugins

Security checks:
- Path escape validation (must stay inside rootDir)
- World-writable rejection (mode & 0o002)
- Ownership check for non-bundled plugins
```

### Plugin API

```typescript
type OpenClawPluginApi = {
  registerTool: (tool, opts?) => void;
  registerHook: (events, handler, opts?) => void;
  registerCommand: (command) => void;
  registerChannel: (registration) => void;
  registerGatewayMethod: (method, handler) => void;
  registerCli: (registrar, opts?) => void;
  registerService: (service) => void;
  registerProvider: (provider) => void;
  registerHttpHandler: (handler) => void;
  registerHttpRoute: (params) => void;
  on: <K>(hookName, handler, opts?) => void;
  resolvePath: (input) => string;
};

type OpenClawPluginModule =
  | OpenClawPluginDefinition
  | ((api: OpenClawPluginApi) => void | Promise<void>);
```

### Hook System (23 hook types)

**Agent hooks**: before_model_resolve, before_prompt_build, before_agent_start, llm_input, llm_output, agent_end, before_compaction, after_compaction, before_reset

**Message hooks**: message_received, message_sending, message_sent

**Tool hooks**: before_tool_call, after_tool_call, tool_result_persist (sync), before_message_write (sync)

**Session hooks**: session_start, session_end, subagent_spawning, subagent_spawned, subagent_ended, subagent_delivery_target, gateway_start, gateway_stop

**Execution strategies**:
- Fire-and-forget (parallel): agent_end, llm_input/output, message_received/sent
- Sequential with merging (priority ordered): before_model_resolve, before_prompt_build, before_tool_call, message_sending
- Synchronous (hot path): tool_result_persist, before_message_write

### Plugin Commands

```typescript
type OpenClawPluginCommandDefinition = {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;      // default: true
  handler: PluginCommandHandler;
};

// Reserved commands (cannot be overridden):
// help, commands, status, stop, restart, reset, new, compact,
// skill, subagents, kill, steer, tell, model, models, queue,
// think, verbose, reasoning, elevated, usage, bash, exec, etc.
```

### Design Decisions

| Decision | OpenClaw Choice | Implication |
|----------|----------------|-------------|
| Skill format | YAML frontmatter in .md files | Human-readable, version-controllable |
| Plugin loading | jiti (TypeScript runtime loader) | Direct TS support without build step |
| Hook priority | Numeric priority, sequential for modifying | Deterministic interception order |
| Plugin isolation | Per-plugin config schema, allowlist | Scoped permissions |
| Command safety | Reserved names, arg sanitization, auth check | Prevents override of core commands |
| Discovery security | World-writable check, ownership validation | Prevents plugin injection attacks |

---

## L9: MCP

### Architecture

OpenClaw implements an **ACP bridge** (Agent Client Protocol), NOT a traditional MCP server. It translates between IDE clients speaking ACP and the OpenClaw Gateway.

### Key Files

| File | Role |
|------|------|
| `src/acp/client.ts` | ACP client: spawns `openclaw acp` subprocess, permission resolution |
| `src/acp/server.ts` | ACP server entry: config, Gateway connection, AgentSideConnection |
| `src/acp/translator.ts` | Core ACP-to-Gateway translator (AcpGatewayAgent) |
| `src/acp/session-mapper.ts` | Maps ACP session IDs to Gateway session keys |
| `src/acp/event-mapper.ts` | Converts Gateway events to ACP updates |
| `src/acp/commands.ts` | Available commands advertised to ACP clients |
| `src/acp/types.ts` | ACP configuration and constants |

### ACP Bridge (not MCP)

```typescript
class AcpGatewayAgent implements Agent {
  async prompt(params: PromptRequest): Promise<PromptResponse>;
  async cancel(params: CancelNotification): Promise<void>;
  async initialize(params: InitializeRequest): Promise<InitializeResponse>;
  async newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;
  async unstable_listSessions(params): Promise<ListSessionsResponse>;
}

// Capabilities advertised:
agentCapabilities: {
  loadSession: true,
  promptCapabilities: { image: true, audio: false, embeddedContext: true },
  mcpCapabilities: { http: false, sse: false },  // No MCP transports!
  sessionCapabilities: { list: {} }
}
```

### Transport

- **Stdio only** (no SSE, no HTTP)
- NDJSON framing via `@agentclientprotocol/sdk`
- Subprocess IPC: client spawns `openclaw acp` process

### Permission Handling

```typescript
// Tool kind inference from name patterns:
SAFE_AUTO_APPROVE_KINDS: ["read", "search"]
// Interactive TTY prompts with 30s timeout
// Dangerous tools list in src/security/dangerous-tools.js
```

### Session Mapping

```typescript
// ACP session UUID → Gateway session key
// Default key: acp:<uuid>
// Rate limiting: 120 requests per 10s window on session creation
// MAX_PROMPT_BYTES = 2MB (CWE-400 mitigation)
```

### Design Decisions

| Decision | OpenClaw Choice | Implication |
|----------|----------------|-------------|
| Protocol | ACP (not MCP) | IDE-first, not LLM-to-tool |
| Transport | Stdio + NDJSON | Lightweight, no server needed |
| MCP servers | Ignored (logs warning) | Bridge doesn't manage MCP servers |
| Permission | Tool kind inference + TTY prompt | Heuristic-based auto-approval |
| Rate limit | Fixed-window on session creation | DoS prevention |

---

## L10: Multi-Agent

### Architecture

Hierarchical subagent spawning with depth limits, model overrides, auto-announce completion, and cascading kill. Two modes: one-shot runs vs persistent sessions.

### Key Files

| File | Role |
|------|------|
| `src/agents/subagent-registry.ts` | Central registry for active subagent runs |
| `src/agents/subagent-spawn.ts` | Spawn logic: validate depth/permissions, create child session |
| `src/agents/tools/sessions-spawn-tool.ts` | `sessions_spawn` tool wrapper |
| `src/agents/tools/subagents-tool.ts` | `subagents` tool (list/kill/steer) |
| `src/agents/subagent-announce.ts` | Auto-announce completion to requester |
| `src/agents/subagent-depth.ts` | Depth validation against limits |

### Subagent Run Record

```typescript
type SubagentRunRecord = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  runTimeoutSeconds?: number;
  spawnMode?: "run" | "session";  // one-shot vs persistent
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;   // {status: "ok"|"error"|"timeout"}
  // ... more fields
};
```

### Spawn Modes

- **"run"**: One-shot execution; cleanup by default
- **"session"**: Persistent thread-bound session; remains active for follow-ups

### Depth & Permission Control

```typescript
// Max depth: config.agents.defaults.subagents.maxSpawnDepth (default 5)
// Child depth = parent depth + 1
// Max active children per parent: maxChildrenPerAgent (default 5)
// Spawn allowlist: config.agents.<agentId>.subagents.allowAgents
```

### Subagent Control Tool

```typescript
// subagents tool actions:
list(recentMinutes?)       // Show active + recent
kill(target, [all])        // Terminate by index/label/runId
steer(target, message)     // Send message, restart run
```

### Cascading Kill

- Killing a parent cascades to all descendants recursively
- Maintains session key → children index for fast traversal
- Prevents orphaned subagent trees

### Steer (Restart)

```
1. Suppress announce for original run
2. Abort current embedded execution
3. Clear queued work (follow-ups, lanes)
4. Wait for graceful settle (5s timeout)
5. Launch replacement run with new runId
6. Update registry: replaceSubagentRunAfterSteer
// Rate limited: 1 per 2 seconds per parent-child pair
```

### Result Announcement

```typescript
// Auto-announce via runSubagentAnnounceFlow
// Includes: outcome, token usage, model used
// Retry: exponential backoff (1s → 8s max), max 3 attempts
// Expires after 5 minutes
// Suppressed on steer-restart to avoid duplicates
```

### Persistence

```
~/.openclaw/agents/<agentId>/subagent-runs.jsonl
// In-memory map persisted on every mutation
// Archive sweep every 60s (configurable archiveAfterMinutes)
```

### Session Key Format

```
agent:<agentId>:subagent:<uuid>
```

### Design Decisions

| Decision | OpenClaw Choice | Implication |
|----------|----------------|-------------|
| Spawn model | Hierarchical with depth limits (default 5) | Prevents runaway nesting |
| Registry | In-memory map + JSONL persistence | Fast access + crash recovery |
| Two modes | "run" (one-shot) vs "session" (persistent) | Flexible task patterns |
| Kill | Cascading recursive termination | No orphaned subagents |
| Steer | Kill + restart with new prompt | Live correction without full restart |
| Announce | Auto-announce with retry/backoff | Reliable result delivery |
| Isolation | Per-agent permission allowlist | Prevents unauthorized delegation |
| Model override | Per-spawn model + thinking level | Task-appropriate model selection |

---

## Cross-Cutting Observations

### vs. Other Reference Projects (codex-rs, pi-agent, opencode)

| Aspect | codex-rs | pi-agent | opencode | OpenClaw |
|--------|----------|----------|----------|----------|
| Language | Rust | Go | Go | TypeScript |
| Provider | Custom crate | Custom interface | Custom interface | Delegates to pi-ai |
| Agent loop | Custom in core | Custom | Custom | Wraps pi-coding-agent |
| Tool system | Registry + dispatch | Interface-based | Interface-based | AgentTool + policy pipeline |
| Config | TOML | YAML | TOML | JSON5 + Zod |
| Session | Custom JSONL | SQLite | SQLite | JSONL + JSON metadata |
| TUI | Ink (React) | Bubble Tea | Bubble Tea | pi-tui (custom) |
| Skills/Plugins | None | None | None | Full plugin system + hooks |
| MCP | Full client | Full client | Full client | ACP bridge (not MCP) |
| Multi-agent | TaskTool | None | None | Full subagent system |

### Unique OpenClaw Strengths

1. **Plugin Ecosystem**: Most complete plugin system of all reference projects (23 hook types, tool/command/channel/provider registration)
2. **Multi-Agent**: Only project with full subagent spawning, kill, steer, and cascading lifecycle
3. **Auth Profiles**: Multi-key management with failover, cooldown, and sticky routing
4. **Multi-Channel**: Primary use case is messaging platforms (WhatsApp, Telegram, Discord, etc.), not just terminal
5. **Context Management**: 6-layer defense against context overflow (guard → history limit → tool result guard → auto-compaction → overflow recovery → truncation)

### Key Takeaways for Our Project

| Layer | OpenClaw Insight | Our Implication |
|-------|-----------------|-----------------|
| L0 | Delegate to existing library, focus on auth profiles | Consider provider library vs custom |
| L1 | Multi-stage context recovery is essential | Build compaction into loop from start |
| L2 | Policy pipeline > simple allow/deny | Plan for composable tool policies |
| L3 | Adaptive read size based on context window | Dynamic limits, not static |
| L4 | askFallback > doom loop detection | Graceful degradation pattern |
| L5 | `$include` + env substitution + Zod | Modular config with type safety |
| L6 | Separate metadata store from transcripts | JSON (fast lookup) + JSONL (append-only) |
| L7 | Component-based TUI with overlay system | Composable UI components |
| L8 | YAML frontmatter + 23 hook types | Rich extension points |
| L9 | ACP bridge vs MCP server — different approach | Consider which protocol pattern |
| L10 | Cascading kill + steer is critical | Plan lifecycle management early |
