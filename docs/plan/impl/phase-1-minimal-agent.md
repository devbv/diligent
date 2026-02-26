# Phase 1: Minimal Viable Agent

> Merges Phase 0 (Skeleton) and Phase 1 (Minimal Agent) into a single plan.
> Goes from empty repo to a working interactive agent in one phase.

## Goal

A developer can run `bunx diligent` and have an interactive conversation with Claude. The agent can execute bash commands on the developer's machine and report the results. This is the first runnable artifact of the project.

## Prerequisites

- None. This is the first implementation phase.
- Required: Bun runtime installed (v1.2+), Anthropic API key.

## Artifact

Interactive CLI agent that converses with Claude and executes bash commands.

```
$ ANTHROPIC_API_KEY=sk-... bunx diligent

diligent> list the files in the current directory

I'll list the files for you.

[tool: bash] ls -la
total 16
drwxr-xr-x  5 user staff  160 Feb 24 10:00 .
drwxr-xr-x  3 user staff   96 Feb 24 09:00 ..
-rw-r--r--  1 user staff  456 Feb 24 10:00 package.json
-rw-r--r--  1 user staff  234 Feb 24 10:00 tsconfig.json
drwxr-xr-x  4 user staff  128 Feb 24 10:00 src

Here are the files in the current directory:
- `package.json` — project configuration
- `tsconfig.json` — TypeScript config
- `src/` — source directory

diligent> _
```

## Layer Touchpoints

| Layer | Depth | What Changes |
|-------|-------|-------------|
| L0 (Provider) | types + minimal | Model/Provider types, StreamFunction signature, single Anthropic implementation, EventStream primitive |
| L1 (Agent Loop) | types + minimal | All 15 AgentEvent types defined, ~7 emitted. Minimal loop: user→LLM→tool→LLM→response |
| L2 (Tool System) | types + minimal | Tool/ToolContext interfaces, Map registry, sequential executor |
| L3 (Core Tools) | bash only | Single bash tool with Bun.spawn, timeout, abort, output truncation |
| L5 (Config) | env-only | `ANTHROPIC_API_KEY`, `DILIGENT_MODEL` from environment |
| L7 (TUI) | raw mode minimal | Raw stdin, custom key handling, ANSI text output. No markdown, no overlays, no slash commands |

**Not touched:**
- L4 (Approval) — auto-approve all tool calls. Permission UI requires overlays (Phase 4)
- L6 (Session) — in-memory only. No persistence, no resume. Deferred to Phase 3
- L8 (Skills), L9 (MCP), L10 (Multi-Agent) — Phase 5

---

## File Manifest

### Root

| File | Action | Description |
|------|--------|-------------|
| `package.json` | CREATE | Bun workspace root with `workspaces` field (D002) |
| `tsconfig.json` | CREATE | Shared strict TypeScript config (D001) |
| `bunfig.toml` | CREATE | Bun configuration |
| `.gitignore` | MODIFY | Add `node_modules/`, `dist/`, `*.tsbuildinfo` |

### packages/core/

| File | Action | Description |
|------|--------|-------------|
| `package.json` | CREATE | `@diligent/core` package with dependencies |
| `tsconfig.json` | CREATE | Core-specific TS config extending root |

### packages/core/src/

| File | Action | Description |
|------|--------|-------------|
| `index.ts` | CREATE | Public API barrel exports |
| `types.ts` | CREATE | Shared message types: UserMessage, AssistantMessage, ToolResultMessage, content blocks, StopReason |
| `event-stream.ts` | CREATE | `EventStream<T, R>` class (~100 lines) — async iterable with push/end/result (D007) |

### packages/core/src/provider/

| File | Action | Description |
|------|--------|-------------|
| `index.ts` | CREATE | Barrel exports |
| `types.ts` | CREATE | `Model`, `StreamFunction`, `ProviderEvent` (12-type union), `Usage` (D003) |
| `anthropic.ts` | CREATE | `createAnthropicStream()` — wraps @anthropic-ai/sdk, maps SDK events to ProviderEvent stream |

### packages/core/src/agent/

| File | Action | Description |
|------|--------|-------------|
| `index.ts` | CREATE | Barrel exports |
| `types.ts` | CREATE | `AgentEvent` (15-type union, D004), `AgentLoopConfig`, `Op` type |
| `loop.ts` | CREATE | `agentLoop()` — nested while-loop with tool execution. ~200 lines |

### packages/core/src/tool/

| File | Action | Description |
|------|--------|-------------|
| `index.ts` | CREATE | Barrel exports |
| `types.ts` | CREATE | `Tool`, `ToolContext`, `ToolResult` interfaces (D013, D016, D020) |
| `registry.ts` | CREATE | `ToolRegistry` (Map) + `ToolRegistryBuilder` (D014) |
| `executor.ts` | CREATE | `executeTool()` — lookup, validate args (Zod), execute, return result (D015) |

### packages/core/src/tools/

| File | Action | Description |
|------|--------|-------------|
| `bash.ts` | CREATE | Bash tool — Bun.spawn, timeout, process tree kill, output cap (D019) |

### packages/core/test/

| File | Action | Description |
|------|--------|-------------|
| `event-stream.test.ts` | CREATE | EventStream: push/iterate, backpressure, result(), error handling |
| `provider-anthropic.test.ts` | CREATE | Anthropic event mapping with mocked SDK |
| `agent-loop.test.ts` | CREATE | Full loop integration test with mocked provider |
| `tool-executor.test.ts` | CREATE | Registry lookup, Zod validation, execution |
| `tools-bash.test.ts` | CREATE | Bash: spawn, timeout, abort, output truncation |

### packages/cli/

| File | Action | Description |
|------|--------|-------------|
| `package.json` | CREATE | `@diligent/cli` with `bin` field, depends on `@diligent/core` |
| `tsconfig.json` | CREATE | CLI-specific TS config extending root |

### packages/cli/src/

| File | Action | Description |
|------|--------|-------------|
| `index.ts` | CREATE | Entry point: parse env config → build registry → start TUI → run loop |
| `config.ts` | CREATE | `loadConfig()` — reads env vars, returns typed config object |
| `tui/terminal.ts` | CREATE | `Terminal` class: raw mode setup/teardown, write, cursor control, resize events (D045, D048) |
| `tui/input.ts` | CREATE | `StdinBuffer` for key splitting, `matchesKey()` helper, key constants |
| `tui/app.ts` | CREATE | `App` class: TextEditor + OutputPanel components, wires agent events to display |

### packages/cli/test/

| File | Action | Description |
|------|--------|-------------|
| `config.test.ts` | CREATE | Config loading: env vars present/missing, defaults |
| `tui-input.test.ts` | CREATE | StdinBuffer splitting, matchesKey for common keys |

### test/

| File | Action | Description |
|------|--------|-------------|
| `e2e/conversation.test.ts` | CREATE | Real Anthropic API: send message, get response, execute bash, verify loop |

### CI

| File | Action | Description |
|------|--------|-------------|
| `.github/workflows/ci.yml` | CREATE | Lint + typecheck + unit tests + integration tests (no E2E in CI) |

---

## Implementation Tasks

### Task 1: Monorepo Scaffolding

**Files:** root `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/cli/package.json`, `packages/cli/tsconfig.json`
**Decisions:** D001, D002

Set up the Bun workspace monorepo with two packages.

```jsonc
// package.json (root)
{
  "name": "diligent",
  "private": true,
  "workspaces": ["packages/*"]
}
```

```jsonc
// tsconfig.json (root)
{
  "compilerOptions": {
    "strict": true,
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "types": ["bun-types"]
  }
}
```

```jsonc
// packages/core/package.json
{
  "name": "@diligent/core",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.7.0"
  }
}
```

```jsonc
// packages/cli/package.json
{
  "name": "@diligent/cli",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "bin": {
    "diligent": "src/index.ts"
  },
  "dependencies": {
    "@diligent/core": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.7.0"
  }
}
```

**Verify:** `bun install` completes. `bun --filter '*' tsc --noEmit` passes with empty src/index.ts files.

---

### Task 2: Core Type Definitions

**Files:** `packages/core/src/types.ts`, `packages/core/src/provider/types.ts`, `packages/core/src/agent/types.ts`, `packages/core/src/tool/types.ts`
**Decisions:** D003, D004, D005, D007, D008, D009, D012, D013, D014, D015, D016, D020

Define all interfaces and types. No implementation code — just the type system.

#### Shared Message Types (`types.ts`)

```typescript
// Content blocks
export type ContentBlock = TextBlock | ImageBlock | ThinkingBlock | ToolCallBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Messages (D005: unified, inline content)
export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  model: string;
  usage: Usage;
  stopReason: StopReason;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "tool_result";
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error" | "aborted";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
```

#### Provider Types (`provider/types.ts`)

```typescript
import type { EventStream } from "../event-stream";

export interface Model {
  id: string;           // e.g. "claude-sonnet-4-20250514"
  provider: string;     // e.g. "anthropic"
  contextWindow: number;
  maxOutputTokens: number;
}

// D003: StreamFunction — the provider contract
export type StreamFunction = (
  model: Model,
  context: StreamContext,
  options: StreamOptions,
) => EventStream<ProviderEvent, ProviderResult>;

export interface StreamContext {
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
}

export interface StreamOptions {
  signal?: AbortSignal;
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema from Zod
}

// Provider events — 12 types, mirrors pi-agent
export type ProviderEvent =
  | { type: "start" }
  | { type: "text_delta"; delta: string }
  | { type: "text_end"; text: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_end"; thinking: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; delta: string }
  | { type: "tool_call_end"; id: string; name: string; input: Record<string, unknown> }
  | { type: "usage"; usage: Usage }
  | { type: "done"; stopReason: StopReason; message: AssistantMessage }
  | { type: "error"; error: Error };

export interface ProviderResult {
  message: AssistantMessage;
}
```

#### Agent Types (`agent/types.ts`)

```typescript
// D004: 15 AgentEvent types (all defined, ~7 emitted in Phase 1)
export type AgentEvent =
  // Lifecycle (2) — emitted in Phase 1
  | { type: "agent_start" }
  | { type: "agent_end"; messages: Message[] }
  // Turn (2) — emitted in Phase 1
  | { type: "turn_start"; turnId: string }
  | { type: "turn_end"; turnId: string; message: AssistantMessage; toolResults: ToolResultMessage[] }
  // Message streaming (3) — emitted in Phase 1
  | { type: "message_start"; message: AssistantMessage }
  | { type: "message_delta"; message: AssistantMessage; event: ProviderEvent }
  | { type: "message_end"; message: AssistantMessage }
  // Tool execution (3) — emitted in Phase 1
  | { type: "tool_start"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_update"; toolCallId: string; toolName: string; partialResult: string }
  | { type: "tool_end"; toolCallId: string; toolName: string; output: string; isError: boolean }
  // Status (1) — NOT emitted in Phase 1
  | { type: "status_change"; status: "idle" | "busy" | "retry"; retry?: { attempt: number; delayMs: number } }
  // Usage (1) — NOT emitted in Phase 1
  | { type: "usage"; usage: Usage; cost: number }
  // Error (1) — emitted in Phase 1
  | { type: "error"; error: Error; fatal: boolean };

// D008: Config for a single agent invocation
export interface AgentLoopConfig {
  model: Model;
  systemPrompt: string;
  tools: Tool[];
  streamFunction: StreamFunction;
  apiKey: string;
  signal?: AbortSignal;
  maxTurns?: number;  // Safety limit, default 100
}
```

#### Tool Types (`tool/types.ts`)

```typescript
import { z } from "zod";

// D013: Tool definition
export interface Tool<TParams extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: TParams;
  execute: (args: z.infer<TParams>, ctx: ToolContext) => Promise<ToolResult>;
}

// D016: Tool context with approval placeholder
export interface ToolContext {
  toolCallId: string;
  signal: AbortSignal;
  // Auto-approve in Phase 1, replaced in Phase 4
  approve: (request: ApprovalRequest) => Promise<boolean>;
  // Progress callback for streaming partial results
  onUpdate?: (partialResult: string) => void;
}

export interface ApprovalRequest {
  permission: "read" | "write" | "execute";
  description: string;
}

// D020: Tool result
export interface ToolResult {
  output: string;
  metadata?: Record<string, unknown>;
}

// D014: Registry type
export type ToolRegistry = Map<string, Tool>;
```

**Verify:** `bun --filter '@diligent/core' tsc --noEmit` passes. All types are connected (no orphan imports).

---

### Task 3: EventStream Implementation

**Files:** `packages/core/src/event-stream.ts`, `packages/core/test/event-stream.test.ts`
**Decisions:** D007

Implement the core streaming primitive. This is the backbone of the entire system — both provider and agent layers build on it.

```typescript
export class EventStream<T, R> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: Array<(value: IteratorResult<T>) => void> = [];
  private isDone = false;
  private resultValue: R | undefined;
  private resultResolve!: (value: R) => void;
  private resultReject!: (error: Error) => void;
  private resultPromise: Promise<R>;

  constructor(
    private isComplete: (event: T) => boolean,
    private extractResult: (event: T) => R,
  ) {
    this.resultPromise = new Promise<R>((resolve, reject) => {
      this.resultResolve = resolve;
      this.resultReject = reject;
    });
  }

  /** Producer: push an event into the stream */
  push(event: T): void {
    if (this.isDone) return;
    if (this.isComplete(event)) {
      this.isDone = true;
      this.resultValue = this.extractResult(event);
      this.resultResolve(this.resultValue);
    }
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift()!;
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
    if (this.isDone) {
      // Drain remaining waiters
      for (const resolve of this.waiting) {
        resolve({ value: undefined as T, done: true });
      }
      this.waiting = [];
    }
  }

  /** Producer: end the stream with an explicit result */
  end(result: R): void {
    if (this.isDone) return;
    this.isDone = true;
    this.resultValue = result;
    this.resultResolve(result);
    for (const resolve of this.waiting) {
      resolve({ value: undefined as T, done: true });
    }
    this.waiting = [];
  }

  /** Producer: end the stream with an error */
  error(err: Error): void {
    if (this.isDone) return;
    this.isDone = true;
    this.resultReject(err);
    for (const resolve of this.waiting) {
      resolve({ value: undefined as T, done: true });
    }
    this.waiting = [];
  }

  /** Consumer: get the final result after stream ends */
  result(): Promise<R> {
    return this.resultPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.isDone) {
          return Promise.resolve({ value: undefined as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting.push(resolve);
        });
      },
    };
  }
}
```

> The stream has three producer methods: `push(event)` for individual events, `end(result)` for explicit completion, and `error(err)` for error termination. The `isComplete`/`extractResult` callbacks handle auto-completion from a terminal event (e.g., a `"done"` event carries the final message). This dual mechanism means providers can use terminal events while the agent loop can use explicit `end()`. (D007)

**Tests to write:**
1. Push events, iterate with `for await`, verify order
2. Consumer waits for push (backpressure)
3. `result()` resolves after terminal event
4. `end(result)` resolves without terminal event
5. `error(err)` rejects the result promise
6. Iteration stops after `end()`/`error()`
7. Late pushes after `end()` are ignored

**Verify:** `bun test packages/core/test/event-stream.test.ts` — all tests pass.

---

### Task 4: Environment Config

**Files:** `packages/cli/src/config.ts`, `packages/cli/test/config.test.ts`
**Decisions:** (Phase 1 env-only, full config deferred to Phase 3)

Minimal config loading from environment variables. No files, no JSONC, no hierarchy.

```typescript
export interface AppConfig {
  apiKey: string;
  model: Model;
  systemPrompt: string;
}

const DEFAULT_MODEL: Model = {
  id: "claude-sonnet-4-20250514",
  provider: "anthropic",
  contextWindow: 200_000,
  maxOutputTokens: 16_384,
};

export function loadConfig(): AppConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required.\n" +
      "Get your API key at https://console.anthropic.com/settings/keys"
    );
  }

  const modelId = process.env.DILIGENT_MODEL;
  const model: Model = modelId
    ? { ...DEFAULT_MODEL, id: modelId }
    : DEFAULT_MODEL;

  const systemPrompt = buildSystemPrompt();

  return { apiKey, model, systemPrompt };
}

function buildSystemPrompt(): string {
  // Minimal system prompt for Phase 1
  // Phase 3 adds CLAUDE.md discovery and config-driven instructions
  return [
    "You are a coding assistant. You help developers by running commands and explaining results.",
    "Use the bash tool to execute shell commands when needed.",
    `Current working directory: ${process.cwd()}`,
    `Platform: ${process.platform}`,
    `Date: ${new Date().toISOString().split("T")[0]}`,
  ].join("\n");
}
```

**Tests:**
1. Throws if `ANTHROPIC_API_KEY` not set
2. Uses default model if `DILIGENT_MODEL` not set
3. Overrides model ID when `DILIGENT_MODEL` is set
4. System prompt includes cwd and platform

**Verify:** `bun test packages/cli/test/config.test.ts` — all pass.

---

### Task 5: Anthropic Provider

**Files:** `packages/core/src/provider/anthropic.ts`, `packages/core/src/provider/index.ts`, `packages/core/test/provider-anthropic.test.ts`
**Decisions:** D003

Wrap `@anthropic-ai/sdk` to produce an `EventStream<ProviderEvent, ProviderResult>`.

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { EventStream } from "../event-stream";
import type {
  StreamFunction, StreamContext, StreamOptions,
  Model, ProviderEvent, ProviderResult
} from "./types";

export const createAnthropicStream: StreamFunction = (
  model: Model,
  context: StreamContext,
  options: StreamOptions,
): EventStream<ProviderEvent, ProviderResult> => {
  const stream = new EventStream<ProviderEvent, ProviderResult>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return { message: event.message };
      throw (event as { type: "error"; error: Error }).error;
    },
  );

  const client = new Anthropic({ apiKey: options.apiKey });

  // Fire-and-forget async — errors pushed to stream
  (async () => {
    try {
      const sdkStream = client.messages.stream({
        model: model.id,
        max_tokens: options.maxTokens ?? model.maxOutputTokens,
        system: context.systemPrompt,
        messages: convertMessages(context.messages),
        tools: convertTools(context.tools),
        ...(options.temperature !== undefined && { temperature: options.temperature }),
      });

      stream.push({ type: "start" });

      // Map SDK events to ProviderEvent
      // ... event mapping logic ...

      const finalMessage = await sdkStream.finalMessage();
      const assistantMessage = mapToAssistantMessage(finalMessage, model);
      stream.push({ type: "done", stopReason: assistantMessage.stopReason, message: assistantMessage });
    } catch (err) {
      stream.push({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
    }
  })();

  return stream;
};
```

Key implementation details:
- Map SDK `stream.on("text", ...)` events to `text_delta` / `text_end`
- Map SDK `stream.on("inputJson", ...)` events to `tool_call_delta` / `tool_call_end`
- Map SDK `stream.on("message", ...)` to `done` with assembled `AssistantMessage`
- Convert our `Message[]` format to Anthropic SDK's expected format
- Convert our `ToolDefinition[]` to Anthropic tool format (Zod → JSON Schema)
- AbortSignal: pass to SDK's `signal` option

> The stream function returns `EventStream<ProviderEvent, ProviderResult>` — not a raw AsyncIterable — because EventStream provides both iteration AND `.result()` for the final assembled message. The agent loop iterates for real-time display and calls `.result()` to get the complete AssistantMessage for history. (D003, D007)

**Tests (mocked SDK):**
1. Text-only response: verify text_delta → text_end → done event sequence
2. Tool call response: verify tool_call_start → tool_call_delta → tool_call_end → done
3. Error response: verify error event pushed, result promise rejects
4. AbortSignal: verify stream terminates on abort
5. Message conversion: UserMessage/ToolResultMessage → Anthropic format
6. Tool conversion: Zod schema → Anthropic tool definition

**Verify:** `bun test packages/core/test/provider-anthropic.test.ts` — all pass.

---

### Task 6: Tool System + Bash Tool

**Files:** `packages/core/src/tool/registry.ts`, `packages/core/src/tool/executor.ts`, `packages/core/src/tool/index.ts`, `packages/core/src/tools/bash.ts`, `packages/core/test/tool-executor.test.ts`, `packages/core/test/tools-bash.test.ts`
**Decisions:** D012, D013, D014, D015, D016, D019, D020, D021

#### Registry (`registry.ts`)

```typescript
export class ToolRegistryBuilder {
  private tools: Map<string, Tool> = new Map();

  register<T extends z.ZodType>(tool: Tool<T>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as Tool);
    return this;
  }

  build(): ToolRegistry {
    return new Map(this.tools);
  }
}
```

#### Executor (`executor.ts`)

```typescript
export async function executeTool(
  registry: ToolRegistry,
  toolCall: ToolCallBlock,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = registry.get(toolCall.name);
  if (!tool) {
    return { output: `Error: Unknown tool "${toolCall.name}"`, metadata: { error: true } };
  }

  // D012: Zod validation
  const parsed = tool.parameters.safeParse(toolCall.input);
  if (!parsed.success) {
    return {
      output: `Error: Invalid arguments for "${toolCall.name}":\n${parsed.error.format()._errors.join("\n")}`,
      metadata: { error: true },
    };
  }

  return tool.execute(parsed.data, ctx);
}
```

#### Bash Tool (`tools/bash.ts`)

```typescript
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../tool/types";

const BashParams = z.object({
  command: z.string().min(1).describe("The shell command to execute"),
  description: z.string().optional().describe("Short description of what the command does (5-10 words)"),
  timeout: z.number().positive().optional().describe("Timeout in milliseconds. Default: 120000 (2 min)"),
});

const DEFAULT_TIMEOUT = 120_000;
const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB

export const bashTool: Tool<typeof BashParams> = {
  name: "bash",
  description: "Execute a shell command. Use this to run programs, install packages, manage files, or interact with the system.",
  parameters: BashParams,
  async execute(args, ctx): Promise<ToolResult> {
    const timeout = args.timeout ?? DEFAULT_TIMEOUT;

    // D019: Bun.spawn with process group for clean kill
    const proc = Bun.spawn(["bash", "-c", args.command], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    // Timeout handler
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeout);

    // Abort handler (D009)
    const onAbort = () => {
      aborted = true;
      proc.kill("SIGKILL");
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    try {
      // Read stdout/stderr
      const [stdoutText, stderrText] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      stdout = stdoutText;
      stderr = stderrText;

      await proc.exited;
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }

    const exitCode = proc.exitCode;

    // Truncate output if too large
    let output = stdout;
    let truncated = false;
    if (stderr) output += (output ? "\n" : "") + `[stderr]\n${stderr}`;
    if (new TextEncoder().encode(output).length > MAX_OUTPUT_BYTES) {
      output = output.slice(-MAX_OUTPUT_BYTES);
      truncated = true;
    }

    // Format result
    let header = "";
    if (timedOut) header = `[Timed out after ${timeout / 1000}s]\n`;
    if (aborted) header = `[Aborted by user]\n`;
    if (exitCode !== 0 && exitCode !== null) header += `[Exit code: ${exitCode}]\n`;

    return {
      output: header + output,
      metadata: {
        exitCode,
        timedOut,
        aborted,
        truncated,
        ...(args.description && { description: args.description }),
      },
    };
  },
};
```

**Tests for executor:**
1. Known tool with valid args → success
2. Unknown tool → error result with message
3. Invalid args (Zod failure) → error result with validation message
4. Tool that throws → propagates error

**Tests for bash:**
1. Simple command (`echo hello`) → output "hello\n"
2. Non-zero exit code → exit code in header, metadata
3. Timeout → kills process, timeout message
4. AbortSignal → kills process, aborted message
5. Large output → truncated, metadata flag set
6. stderr output → merged with [stderr] prefix

**Verify:** `bun test packages/core/test/tool-executor.test.ts packages/core/test/tools-bash.test.ts` — all pass.

---

### Task 7: Agent Loop

**Files:** `packages/core/src/agent/loop.ts`, `packages/core/src/agent/index.ts`, `packages/core/test/agent-loop.test.ts`
**Decisions:** D004, D008, D009, D015

The core agent loop. Takes user messages, streams LLM responses, executes tools, loops until no more tool calls.

```typescript
import { EventStream } from "../event-stream";
import type { AgentEvent, AgentLoopConfig } from "./types";
import type { Message, AssistantMessage, ToolResultMessage, ToolCallBlock } from "../types";
import { executeTool } from "../tool/executor";

export function agentLoop(
  messages: Message[],
  config: AgentLoopConfig,
): EventStream<AgentEvent, Message[]> {
  const stream = new EventStream<AgentEvent, Message[]>(
    (event) => event.type === "agent_end",
    (event) => (event as { type: "agent_end"; messages: Message[] }).messages,
  );

  runLoop(messages, config, stream).catch((err) => {
    stream.push({ type: "error", error: err, fatal: true });
    stream.error(err);
  });

  return stream;
}

async function runLoop(
  messages: Message[],
  config: AgentLoopConfig,
  stream: EventStream<AgentEvent, Message[]>,
): Promise<void> {
  const allMessages = [...messages];
  let turnCount = 0;
  const maxTurns = config.maxTurns ?? 100;

  stream.push({ type: "agent_start" });

  while (turnCount < maxTurns) {
    if (config.signal?.aborted) break;
    turnCount++;

    const turnId = `turn-${turnCount}`;
    stream.push({ type: "turn_start", turnId });

    // 1. Stream LLM response
    const assistantMessage = await streamAssistantResponse(
      allMessages, config, stream,
    );
    allMessages.push(assistantMessage);

    // 2. Check for tool calls
    const toolCalls = assistantMessage.content.filter(
      (b): b is ToolCallBlock => b.type === "tool_call",
    );

    if (toolCalls.length === 0) {
      // No tools — turn is done, agent is done
      stream.push({ type: "turn_end", turnId, message: assistantMessage, toolResults: [] });
      break;
    }

    // 3. Execute tools sequentially (D015)
    const toolResults: ToolResultMessage[] = [];
    const registry = new Map(config.tools.map((t) => [t.name, t]));

    for (const toolCall of toolCalls) {
      if (config.signal?.aborted) break;

      stream.push({
        type: "tool_start",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        input: toolCall.input,
      });

      const ctx: ToolContext = {
        toolCallId: toolCall.id,
        signal: config.signal ?? new AbortController().signal,
        approve: async () => true, // Auto-approve in Phase 1
        onUpdate: (partial) => {
          stream.push({
            type: "tool_update",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            partialResult: partial,
          });
        },
      };

      const result = await executeTool(registry, toolCall, ctx);
      const toolResult: ToolResultMessage = {
        role: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        output: result.output,
        isError: !!result.metadata?.error,
        timestamp: Date.now(),
      };

      toolResults.push(toolResult);
      allMessages.push(toolResult);

      stream.push({
        type: "tool_end",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        output: result.output,
        isError: toolResult.isError,
      });
    }

    stream.push({ type: "turn_end", turnId, message: assistantMessage, toolResults });
    // Loop continues — LLM sees tool results and responds
  }

  stream.push({ type: "agent_end", messages: allMessages });
  stream.end(allMessages);
}
```

The `streamAssistantResponse` helper bridges L0 → L1 by iterating provider events and re-emitting them as agent events:

```typescript
async function streamAssistantResponse(
  messages: Message[],
  config: AgentLoopConfig,
  agentStream: EventStream<AgentEvent, Message[]>,
): Promise<AssistantMessage> {
  const context: StreamContext = {
    systemPrompt: config.systemPrompt,
    messages,
    tools: config.tools.map(toolToDefinition),
  };

  const providerStream = config.streamFunction(
    config.model,
    context,
    { signal: config.signal, apiKey: config.apiKey },
  );

  let currentMessage: AssistantMessage | undefined;

  for await (const event of providerStream) {
    if (event.type === "done") {
      currentMessage = event.message;
      agentStream.push({ type: "message_end", message: event.message });
    } else if (event.type === "error") {
      throw event.error;
    } else if (event.type === "start") {
      // message_start emitted when we have partial message
    } else {
      // All delta events forwarded
      if (currentMessage === undefined) {
        // Build partial message for message_start
        currentMessage = createEmptyAssistantMessage(config.model.id);
        agentStream.push({ type: "message_start", message: currentMessage });
      }
      agentStream.push({ type: "message_delta", message: currentMessage, event });
    }
  }

  if (!currentMessage) {
    throw new Error("Provider stream ended without producing a message");
  }

  return currentMessage;
}
```

**Tests (mocked StreamFunction):**
1. Text-only response: user→LLM→response. Events: agent_start, turn_start, message_start, message_delta(s), message_end, turn_end, agent_end
2. Tool call response: user→LLM→tool_call→tool_exec→LLM→response. Two turns.
3. Multiple tool calls: LLM calls 2 tools sequentially, then responds
4. AbortSignal: abort mid-loop, verify agent_end is not emitted (or emitted with partial)
5. Max turns safety: set maxTurns=2, verify loop exits
6. Unknown tool: LLM calls non-existent tool, error result fed back, LLM recovers

**Verify:** `bun test packages/core/test/agent-loop.test.ts` — all pass.

---

### Task 8: Minimal TUI

**Files:** `packages/cli/src/tui/terminal.ts`, `packages/cli/src/tui/input.ts`, `packages/cli/src/tui/app.ts`, `packages/cli/test/tui-input.test.ts`
**Decisions:** D045, D046, D048

Raw terminal mode with custom key handling. No markdown, no overlays, no slash commands.

#### Terminal (`terminal.ts`)

```typescript
export class Terminal {
  private originalRawMode: boolean | undefined;

  get columns(): number { return process.stdout.columns ?? 80; }
  get rows(): number { return process.stdout.rows ?? 24; }

  start(onInput: (data: Buffer) => void, onResize: () => void): void {
    if (process.stdin.isTTY) {
      this.originalRawMode = process.stdin.isRaw;
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", onInput);
    process.stdout.on("resize", onResize);
  }

  stop(): void {
    if (process.stdin.isTTY && this.originalRawMode !== undefined) {
      process.stdin.setRawMode(this.originalRawMode);
    }
    process.stdin.pause();
    process.stdin.removeAllListeners("data");
    process.stdout.removeAllListeners("resize");
  }

  write(text: string): void {
    process.stdout.write(text);
  }

  writeLine(text: string): void {
    process.stdout.write(text + "\n");
  }

  clearLine(): void {
    process.stdout.write("\x1b[2K\r");
  }
}
```

#### Input Handling (`input.ts`)

```typescript
// Key constants for common key events
export const Keys = {
  ENTER: "\r",
  CTRL_C: "\x03",
  CTRL_D: "\x04",
  BACKSPACE: "\x7f",
  ESCAPE: "\x1b",
  // Arrow keys (ANSI escape sequences)
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  RIGHT: "\x1b[C",
  LEFT: "\x1b[D",
} as const;

export function matchesKey(data: Buffer | string, key: string): boolean {
  const str = typeof data === "string" ? data : data.toString("utf-8");
  return str === key;
}

// Simple line buffer for building user input
export class InputBuffer {
  text = "";
  cursorPos = 0;

  insert(char: string): void {
    this.text = this.text.slice(0, this.cursorPos) + char + this.text.slice(this.cursorPos);
    this.cursorPos += char.length;
  }

  backspace(): void {
    if (this.cursorPos > 0) {
      this.text = this.text.slice(0, this.cursorPos - 1) + this.text.slice(this.cursorPos);
      this.cursorPos--;
    }
  }

  clear(): string {
    const text = this.text;
    this.text = "";
    this.cursorPos = 0;
    return text;
  }

  moveLeft(): void { if (this.cursorPos > 0) this.cursorPos--; }
  moveRight(): void { if (this.cursorPos < this.text.length) this.cursorPos++; }
}
```

#### App (`app.ts`)

The main TUI application wires terminal input to the agent loop and agent events to terminal output.

```typescript
import { Terminal } from "./terminal";
import { InputBuffer, Keys, matchesKey } from "./input";
import { agentLoop } from "@diligent/core";
// ... other imports

export class App {
  private terminal = new Terminal();
  private input = new InputBuffer();
  private abortController: AbortController | null = null;
  private isProcessing = false;

  constructor(private config: AppConfig) {}

  async start(): Promise<void> {
    this.terminal.start(
      (data) => this.handleInput(data),
      () => {},  // resize — no-op in Phase 1
    );
    this.showPrompt();
  }

  private showPrompt(): void {
    this.terminal.write("\n\x1b[1;36mdiligent>\x1b[0m ");
  }

  private handleInput(data: Buffer): void {
    if (matchesKey(data, Keys.CTRL_C)) {
      if (this.isProcessing && this.abortController) {
        this.abortController.abort();
      } else {
        this.shutdown();
      }
      return;
    }

    if (matchesKey(data, Keys.CTRL_D)) {
      this.shutdown();
      return;
    }

    if (this.isProcessing) return; // Ignore input while agent is running

    if (matchesKey(data, Keys.ENTER)) {
      const text = this.input.clear().trim();
      if (text) {
        this.terminal.write("\n");
        this.processMessage(text);
      }
      return;
    }

    if (matchesKey(data, Keys.BACKSPACE)) {
      this.input.backspace();
      this.redrawInput();
      return;
    }

    // Printable character
    const str = data.toString("utf-8");
    if (str.length === 1 && str.charCodeAt(0) >= 32) {
      this.input.insert(str);
      this.redrawInput();
    }
  }

  private redrawInput(): void {
    this.terminal.clearLine();
    this.terminal.write(`\x1b[1;36mdiligent>\x1b[0m ${this.input.text}`);
  }

  private async processMessage(text: string): Promise<void> {
    this.isProcessing = true;
    this.abortController = new AbortController();

    const userMessage: UserMessage = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    };

    // ... build messages array, call agentLoop, iterate events
    // Display streaming text, tool execution status
    // On agent_end: show prompt again

    this.isProcessing = false;
    this.abortController = null;
    this.showPrompt();
  }

  private shutdown(): void {
    this.terminal.write("\n");
    this.terminal.stop();
    process.exit(0);
  }
}
```

Display logic for agent events:
- `message_delta` with `text_delta`: write delta text to terminal
- `tool_start`: write `\n[tool: {name}] {input.command}\n` in dim gray
- `tool_end`: write tool output (truncated for display)
- `turn_end`: add newline separator
- `error`: write error in red

**Tests for input.ts:**
1. `matchesKey` matches Enter, Ctrl+C, Backspace, arrow keys
2. `InputBuffer` insert/backspace/clear
3. Cursor movement (left/right)

**Verify:** `bun test packages/cli/test/tui-input.test.ts` — all pass. Manual test: `bun run packages/cli/src/index.ts` starts TUI, accepts input, Ctrl+C exits.

---

### Task 9: CLI Entry Point

**Files:** `packages/cli/src/index.ts`
**Decisions:** D046

Wire everything together: load config → build tool registry → start TUI app.

```typescript
#!/usr/bin/env bun
import { loadConfig } from "./config";
import { App } from "./tui/app";

async function main() {
  try {
    const config = loadConfig();
    const app = new App(config);
    await app.start();
  } catch (err) {
    console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

main();
```

> The TUI communicates with the agent core via direct in-process function calls — no HTTP server, no RPC. (D046)

**Verify:** `bun run packages/cli/src/index.ts` — shows the `diligent>` prompt and accepts input. Missing API key shows a clear error message.

---

### Task 10: CI Pipeline

**Files:** `.github/workflows/ci.yml`

```yaml
name: CI
on: [push, pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install
      - run: bun --filter '*' tsc --noEmit
      - run: bun test --filter '@diligent/core'
      - run: bun test --filter '@diligent/cli'
```

E2E test with real API is NOT run in CI — it requires `ANTHROPIC_API_KEY` and costs money. Run manually via `ANTHROPIC_API_KEY=... bun test test/e2e/`.

**Verify:** Push branch, GitHub Actions runs, all checks green.

---

### Task 11: E2E Test + Manual Verification

**Files:** `test/e2e/conversation.test.ts`

End-to-end test with real Anthropic API:

```typescript
import { describe, test, expect } from "bun:test";
import { agentLoop } from "@diligent/core";
// ... imports

describe("E2E: Real Anthropic API", () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    test.skip("ANTHROPIC_API_KEY not set", () => {});
    return;
  }

  test("simple conversation without tools", async () => {
    const messages: Message[] = [{
      role: "user",
      content: "Say exactly: hello world",
      timestamp: Date.now(),
    }];
    const stream = agentLoop(messages, { /* config with real provider */ });
    const result = await stream.result();
    // Verify result contains an assistant message
    const assistant = result.find(m => m.role === "assistant");
    expect(assistant).toBeDefined();
  });

  test("conversation with bash tool", async () => {
    const messages: Message[] = [{
      role: "user",
      content: "Run 'echo hello' using the bash tool and tell me what it outputs",
      timestamp: Date.now(),
    }];
    const stream = agentLoop(messages, { /* config with real provider + bash tool */ });

    const events: AgentEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Verify tool was called
    const toolEnd = events.find(e => e.type === "tool_end");
    expect(toolEnd).toBeDefined();
    expect(toolEnd!.toolName).toBe("bash");
  });
});
```

**Manual verification checklist:**
1. `bun run packages/cli/src/index.ts` — TUI starts
2. Type "hello" — get a response from Claude
3. Type "list files in current directory" — agent calls bash tool, shows `ls` output
4. Type "create a file called test.txt with the content 'hello'" — agent runs bash
5. Ctrl+C during streaming — aborts cleanly
6. Ctrl+C at prompt — exits
7. No API key — clear error message

**Verify:** All manual checks pass. E2E tests pass with real API key.

---

## Migration Notes

N/A — first implementation phase. No stubs to replace.

## Acceptance Criteria

1. `bun install` resolves all dependencies without errors
2. `bun --filter '*' tsc --noEmit` passes with zero errors
3. `bun test` (all packages) — all unit and integration tests pass
4. E2E: Agent responds to a text-only user message via Anthropic API
5. E2E: Agent calls bash tool, returns output, and responds with a summary
6. E2E: Multi-turn loop works (tool_use → tool_result → assistant response)
7. TUI: Raw mode input works — typing, backspace, Enter submits
8. TUI: Streaming text appears in real-time during LLM response
9. TUI: Ctrl+C aborts in-progress agent, Ctrl+C at prompt exits
10. TUI: Tool execution shows command and output
11. No `any` type escape hatches in production code (tests may use `any` sparingly)
12. Missing `ANTHROPIC_API_KEY` produces a clear, actionable error message

## Testing Strategy

| Category | What to Test | How |
|----------|-------------|-----|
| Unit | EventStream push/iterate/result/error | `bun test` with synthetic events |
| Unit | Provider event mapping (SDK → ProviderEvent) | Mock Anthropic SDK, assert event sequence |
| Unit | Tool executor — registry lookup, Zod validation | Mock tool, assert result |
| Unit | Bash tool — spawn, timeout, abort, truncation | Real `Bun.spawn` with simple commands (`echo`, `sleep`) |
| Unit | Config loading — env var parsing, defaults | Set/unset env vars in test setup |
| Unit | Input handling — key matching, InputBuffer | Synthetic key buffers |
| Integration | Full agent loop with mocked provider | Mock StreamFunction pushes events, real executor |
| E2E | Real Anthropic API conversation | Skip in CI, run manually with API key |
| Manual | Full interactive session | Run TUI, verify conversation flow end-to-end |

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|-------------|
| EventStream design locks in too early | Hard to change after Phase 2 builds on it | The ~100 line class is small enough to refactor. Tests cover the contract. |
| Anthropic SDK event model changes | Provider breaks | Pin SDK version in package.json. Event mapping is isolated in one file. |
| Bun.spawn behavior differs from Node child_process | Bash tool fails on edge cases | Test with real commands. Bun.spawn is well-documented and stable. |
| Raw mode TUI is too minimal for real use | Developer experience suffers | Phase 1 is for developers testing the agent. Markdown + spinner added in Phase 2. |
| Process tree kill doesn't work on all platforms | Zombie processes from bash tool | Test on macOS. Linux CI validates. Timeout is the safety net. |
| EventStream backpressure issues with fast producers | Events dropped or memory grows | Tests verify push-before-pull and pull-before-push scenarios. |

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| D001 | Bun + TypeScript strict | Task 1: Monorepo config |
| D002 | packages/core + packages/cli | Task 1: Workspace structure |
| D003 | Custom provider abstraction (StreamFunction) | Task 2, 5: Provider types and Anthropic impl |
| D004 | AgentEvent union (~15 types) | Task 2: Agent types (all 15 defined) |
| D005 | Unified messages (inline content) | Task 2: Message types |
| D007 | Custom EventStream<T, R> | Task 3: EventStream implementation |
| D008 | Immutable TurnContext + mutable SessionState | Task 2: AgentLoopConfig (simplified for Phase 1) |
| D009 | AbortController cancellation | Task 6, 7: Bash tool + agent loop abort |
| D012 | Zod for tool schemas | Task 6: Tool executor validation |
| D013 | Tool interface with execute | Task 2, 6: Tool type definition |
| D014 | Map-based tool registry | Task 6: ToolRegistryBuilder |
| D015 | Sequential tool execution | Task 7: Agent loop executes tools in order |
| D016 | ToolContext with approval placeholder | Task 2, 7: auto-approve stub |
| D019 | Bun.spawn with process tree kill | Task 6: Bash tool implementation |
| D020 | String output + metadata | Task 2, 6: ToolResult type |
| D021 | One file per tool | Task 6: tools/bash.ts |
| D045 | Inline mode, custom ANSI framework | Task 8: Terminal + App |
| D046 | No server between TUI and core | Task 9: Direct function calls |
| D048 | Raw mode + key handling | Task 8: Terminal.start(), InputBuffer |

## What Phase 1 Does NOT Include

- **No multi-provider support** — Anthropic only. OpenAI and others deferred to Phase 3 (D003 allows it, just not implemented)
- **No error retry / exponential backoff** — API errors surface directly. Retry logic deferred to Phase 2 (D010)
- **No auto-truncation framework** — Bash tool has hardcoded 50KB cap. The generic truncation-with-temp-file system is Phase 2 (D025)
- **No markdown rendering** — Raw text output only. `marked` + ANSI styling deferred to Phase 2 (D047)
- **No spinner** — No animation during tool execution. Deferred to Phase 2 (D049)
- **No slash commands** — No `/model`, `/new`, `/exit`. Deferred to Phase 4 (D051)
- **No overlays or modals** — No model picker, session selector. Deferred to Phase 4 (D050)
- **No approval system** — All tool calls auto-approved. Permission UI deferred to Phase 4 (D027, D028)
- **No session persistence** — In-memory only. JSONL persistence deferred to Phase 3 (D006)
- **No config files** — Env vars only. JSONC config deferred to Phase 3
- **No CLAUDE.md discovery** — System prompt is hardcoded. CLAUDE.md loading deferred to Phase 3
- **No multi-line input** — Single line per Enter press. Bracketed paste deferred to Phase 2
- **No read/write/edit/glob/grep tools** — Only bash. All 7 tools in Phase 2 (D017)
- **No streaming progress for tools** — Bash output is returned after completion. Streaming display deferred to Phase 2 (D071)
- **No cost tracking** — Usage is captured in types but not displayed. Deferred to Phase 3
