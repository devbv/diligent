# Layer 4: Approval

## Problem Definition

The Approval layer provides a **rule-based permission system** that gates tool execution. It sits between the Tool System (L2), which dispatches tool calls, and the TUI (L7), which renders approval prompts to the user. The approval layer must:

1. Evaluate whether a tool call requires user approval, is auto-allowed, or is forbidden
2. Provide an inline permission check mechanism (ctx.ask()) within tool execution
3. Support configurable rules with pattern matching (per-tool, per-command, per-path)
4. Handle user responses: approve once, approve always, reject (with optional feedback)
5. Persist "always" approvals within the session scope
6. Detect doom loops (same tool+input repeated N times) as a safety mechanism
7. Remove denied tools from the LLM's tool list to prevent wasted calls
8. Propose rule amendments to streamline future approvals

### Key Questions

1. How are permission rules defined and evaluated?
2. How does the approval flow integrate with the tool execution pipeline?
3. What are the user response options and how do they cascade?
4. How are "always" approvals persisted and scoped?
5. How is doom loop detection implemented?
6. How are denied tools removed from the LLM tool list?
7. What is the approval UI flow (event publishing, promise resolution)?
8. How do rule amendments (auto-allow suggestions) work?

### Layer Scope

- Permission rule definition (rule, ruleset, action types)
- Rule evaluation engine (pattern matching, last-match-wins)
- Inline permission check (ctx.ask())
- Approval request/reply flow (promise-based, event-driven)
- Approval caching (session-scoped "always" rules)
- Doom loop detection
- Disabled tool filtering
- Error types (RejectedError, CorrectedError, DeniedError)

### Boundary: What Is NOT in This Layer

- Tool framework (L2: Tool System)
- Concrete tool implementations (L3: Core Tools)
- OS-level sandboxing (deferred per D030)
- Config-level permission settings (L5: Config provides the config; L4 evaluates it)
- UI rendering of approval prompts (L7: TUI)

---

## codex-rs Analysis

### Architecture

codex-rs has the **most sophisticated** approval system of the three projects, tightly integrating rule-based command approval with OS-level sandboxing. The architecture spans multiple crates and modules:

```
core/src/
  exec_policy.rs          - ExecPolicyManager, rule loading, command evaluation
  tools/orchestrator.rs   - ToolOrchestrator: approval -> sandbox -> attempt -> retry
  tools/sandboxing.rs     - ApprovalStore, ApprovalCtx, traits (Approvable, Sandboxable, ToolRuntime)

protocol/src/
  approvals.rs            - ExecPolicyAmendment, ExecApprovalRequestEvent, ReviewDecision

utils/
  approval-presets/       - Pre-built approval preset configurations
  cli/approval_mode_cli_arg.rs - CLI argument for approval mode
```

The core flow is: **ExecPolicyManager evaluates rules** -> **ToolOrchestrator drives the approval/sandbox/retry pipeline** -> **ApprovalStore caches decisions**.

### Key Types/Interfaces

**Policy Enum (`AskForApproval`)** -- 5 levels controlling when to prompt:
```rust
enum AskForApproval {
    Never,          // Auto-approve everything, dangerous commands forbidden
    OnFailure,      // Only ask when sandbox execution fails
    OnRequest,      // Ask unless running in full-access sandbox
    UnlessTrusted,  // Always ask unless command is known safe
    Reject(RejectConfig), // Auto-reject with granular sub-flags
}
```

**Approval Requirement (`ExecApprovalRequirement`)** -- the evaluation output:
```rust
enum ExecApprovalRequirement {
    Skip { bypass_sandbox: bool, proposed_execpolicy_amendment: Option<ExecPolicyAmendment> },
    NeedsApproval { reason: Option<String>, proposed_execpolicy_amendment: Option<ExecPolicyAmendment> },
    Forbidden { reason: String },
}
```

**Review Decision (`ReviewDecision`)** -- user response:
```rust
enum ReviewDecision {
    Approved,
    ApprovedForSession,
    ApprovedExecpolicyAmendment { amendment: ExecPolicyAmendment },
    Denied,
    Abort,
}
```

**ApprovalStore** -- session-scoped cache using serialized keys:
```rust
struct ApprovalStore {
    map: HashMap<String, ReviewDecision>,
}
```

**ExecPolicyManager** -- hot-reloadable rule engine using `ArcSwap<Policy>`:
```rust
struct ExecPolicyManager {
    policy: ArcSwap<Policy>,
}
```

### Implementation Details

**Rule Loading**: Rules are loaded from `*.rules` files in `rules/` subdirectories within each config layer directory. Files use a Starlark-like DSL (`codex_execpolicy` crate) with `prefix_rule()` declarations:
```
prefix_rule(pattern=["rm"], decision="forbidden")
prefix_rule(pattern=["cargo", "build"], decision="allow")
prefix_rule(pattern=["git"], decision="prompt", justification="requires review")
```

Rules from multiple config layers are loaded in precedence order (lowest first), and the last matching rule wins.

**Command Evaluation Pipeline** (`create_exec_approval_requirement_for_command`):
1. Parse shell commands (handles `bash -lc "cmd1 && cmd2"` by extracting inner commands)
2. Evaluate each sub-command against the policy using `exec_policy.check_multiple()`
3. If no rule matches, fall back to heuristics: `is_known_safe_command()` and `command_might_be_dangerous()`
4. Derive the most restrictive decision across all sub-commands
5. Generate proposed amendments for "always allow" suggestions

**Safety Heuristics**: When no explicit rule matches:
- `is_known_safe_command()` -- whitelist of safe commands (echo, cat, ls, etc.)
- `command_might_be_dangerous()` -- checks for destructive patterns (rm -rf, sudo, etc.)
- Over 40 banned prefix suggestions that cannot be auto-approved (python, bash, git, sudo, node, etc.)

**Orchestrator Pipeline** (`ToolOrchestrator.run()`):
1. Evaluate exec approval requirement (custom per-tool or default from policy)
2. If `Forbidden` -> return `ToolError::Rejected`
3. If `NeedsApproval` -> call `tool.start_approval_async()` via `Approvable` trait
4. If rejected -> return `ToolError::Rejected`
5. Select sandbox type for first attempt
6. Execute tool with sandbox
7. On sandbox denial: if `escalate_on_failure()` -> ask for approval to retry without sandbox
8. Handle network approval (immediate or deferred)

**Amendment Persistence**: When a user approves an `ExecPolicyAmendment`, `append_amendment_and_update()` writes a new `prefix_rule()` to `~/.codex/rules/default.rules` and hot-updates the in-memory policy via `ArcSwap`.

**Multi-Key Approval Cache**: The `with_cached_approval()` function supports multiple keys per request. For `apply_patch`, each file path is a separate key. The request is auto-approved only when ALL keys have `ApprovedForSession` status.

### Layer Boundaries

- **Above (L2)**: Tool handlers implement the `Approvable`, `Sandboxable`, and `ToolRuntime` traits. The `ToolOrchestrator` wraps tool execution with the approval pipeline.
- **Below (L5)**: Config provides `AskForApproval` policy and `SandboxPolicy`. Rules are loaded from config layer directories.
- **Lateral (L7)**: Approval requests are sent as `ExecApprovalRequestEvent` / `ApplyPatchApprovalRequestEvent` events to the TUI for user interaction.

---

## pi-agent Analysis

### Architecture

pi-agent has **no built-in permission/approval system**. Permission handling is entirely delegated to the extension system. The only relevant file is an example extension:

```
packages/coding-agent/examples/extensions/permission-gate.ts
```

### Key Types/Interfaces

There are no approval types in the core codebase. The extension API provides hooks that can intercept tool calls:

```typescript
// Extension hook for tool calls
pi.on("tool_call", async (event, ctx) => {
    // event: { toolName, input }
    // ctx: { hasUI, ui: { select() } }
    // Return: undefined (allow) | { block: true, reason: string } (deny)
});
```

### Implementation Details

**Permission Gate Example**: The example extension demonstrates pattern-based blocking:
```typescript
const dangerousPatterns = [
    /\brm\s+(-rf?|--recursive)/i,
    /\bsudo\b/i,
    /\b(chmod|chown)\b.*777/i,
];

pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = event.input.command as string;
    const isDangerous = dangerousPatterns.some((p) => p.test(command));
    if (isDangerous) {
        if (!ctx.hasUI) {
            return { block: true, reason: "Dangerous command blocked (no UI)" };
        }
        const choice = await ctx.ui.select("Allow?", ["Yes", "No"]);
        if (choice !== "Yes") return { block: true, reason: "Blocked by user" };
    }
    return undefined;
});
```

**No Rule Persistence**: Extensions do not persist approval decisions. Each tool call is evaluated fresh.

**No Doom Loop Detection**: pi-agent has no built-in doom loop detection. The `getSteeringMessages()` mechanism (user can inject messages between tool calls) provides the only interruption point.

### Layer Boundaries

- **Above (L2)**: Extensions hook into the tool execution pipeline via event hooks
- **Below**: No config-level permission settings
- **Lateral**: UI interaction through `ctx.ui.select()` for interactive approval

---

## opencode Analysis

### Architecture

opencode implements a **mid-complexity rule-based permission system** with Zod-validated types, wildcard pattern matching, promise-based ask/reply flow, and doom loop detection:

```
packages/opencode/src/
  permission/next.ts      - PermissionNext namespace: Rule, Ruleset, ask(), reply(), evaluate()
  config/config.ts        - Config.Permission schema (Zod)
  agent/agent.ts          - Default permission rulesets per agent
  session/processor.ts    - Doom loop detection (DOOM_LOOP_THRESHOLD = 3)
```

### Key Types/Interfaces

**Rule** (Zod-validated):
```typescript
const Rule = z.object({
    permission: z.string(),  // tool name or wildcard (e.g., "bash", "edit", "*")
    pattern: z.string(),     // path pattern or wildcard (e.g., "/src/*", "*")
    action: z.enum(["allow", "deny", "ask"]),
})
type Ruleset = Rule[]
```

**Request** (permission check request):
```typescript
const Request = z.object({
    id: Identifier.schema("permission"),
    sessionID: Identifier.schema("session"),
    permission: z.string(),
    patterns: z.string().array(),     // patterns to check (e.g., file paths)
    metadata: z.record(z.string(), z.any()),
    always: z.string().array(),       // broad patterns for "always allow"
    tool: z.object({ messageID, callID }).optional(),
})
```

**Reply** types:
```typescript
const Reply = z.enum(["once", "always", "reject"])
```

**Error Types**:
```typescript
class RejectedError extends Error     // User rejected without message
class CorrectedError extends Error    // User rejected with feedback message
class DeniedError extends Error       // Auto-rejected by config rule
```

### Implementation Details

**Rule Evaluation** (`evaluate()`): Merges multiple rulesets (flat concatenation) and uses **last-match-wins** semantics via `findLast()`:
```typescript
function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
    const merged = merge(...rulesets)  // flat concatenation
    const match = merged.findLast(
        (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
    )
    return match ?? { action: "ask", permission, pattern: "*" }  // default: ask
}
```

**Ask Flow** (`ask()`): For each pattern in the request:
1. Evaluate against merged rulesets (config rules + session approvals)
2. If `"deny"` -> throw `DeniedError` immediately
3. If `"ask"` -> create a pending promise, publish `Event.Asked` on bus
4. If `"allow"` -> continue (resolve immediately)

**Reply Flow** (`reply()`):
- `"once"` -> resolve the single pending request
- `"reject"` -> reject this request AND all other pending requests for the same session
- `"always"` -> add patterns to session-scoped approved ruleset, resolve this request, then auto-resolve all other pending requests in the same session that now match

The "always" cascade is notable: approving one request can automatically resolve multiple pending requests.

**Rule Sources** (merged in order):
1. Default agent permissions (e.g., `{ "*": "allow", doom_loop: "ask", external_directory: { "*": "ask" } }`)
2. Config permissions (from `opencode.json{c}` `permission` field)
3. Per-agent permission overrides
4. Session-scoped approvals (accumulated via "always" replies)

**Config Permission Schema** (`Config.Permission`):
```typescript
// Supports both flat and nested forms:
permission: {
    read: "allow",
    edit: "ask",
    bash: { "rm *": "deny", "*": "ask" },
    doom_loop: "ask",
}
```
The `fromConfig()` function converts this to a flat `Ruleset`.

**Doom Loop Detection** (in `SessionProcessor`):
```typescript
const DOOM_LOOP_THRESHOLD = 3
// When a tool call starts, check the last 3 completed tool parts
const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)
if (lastThree.length === DOOM_LOOP_THRESHOLD &&
    lastThree.every(p =>
        p.type === "tool" &&
        p.tool === value.toolName &&
        p.state.status !== "pending" &&
        JSON.stringify(p.state.input) === JSON.stringify(value.input)
    )) {
    await PermissionNext.ask({
        permission: "doom_loop",
        patterns: [value.toolName],
        sessionID: ...,
        metadata: { tool: value.toolName, input: value.input },
        ...
    })
}
```
This triggers a permission check with `permission: "doom_loop"`, which defaults to `"ask"` in the agent config.

**Disabled Tools** (`disabled()`):
```typescript
function disabled(tools: string[], ruleset: Ruleset): Set<string> {
    for (const tool of tools) {
        const permission = EDIT_TOOLS.includes(tool) ? "edit" : tool
        const rule = ruleset.findLast((r) => Wildcard.match(permission, r.permission))
        if (rule && rule.pattern === "*" && rule.action === "deny") result.add(tool)
    }
}
```
Tools with a blanket deny rule (pattern `"*"`) are removed from the LLM's tool list entirely.

**Persistence**: Session-scoped approvals are stored in-memory. The codebase has a `PermissionTable` in SQLite but persistence is currently disabled with a TODO comment: "we don't save the permission ruleset to disk yet until there's UI to manage it".

**Path Expansion**: The `expand()` function handles `~/` and `$HOME/` in patterns.

### Layer Boundaries

- **Above (L2)**: Tools call `ctx.ask()` inline during execution. The tool system's `context()` function creates the context with the `ask` hook bound to `PermissionNext.ask()`.
- **Below (L5)**: Config provides `Config.Permission` schema. Agent config provides per-agent permission overrides.
- **Lateral (L7)**: `Event.Asked` is published on the bus; the TUI subscribes and renders the approval overlay. `reply()` is called when the user responds.
- **Lateral (L6)**: Sessions store their own permission rulesets in `Session.Info.permission`.

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|--------|----------|----------|----------|
| **Architecture** | Trait-based (Approvable/Sandboxable/ToolRuntime) + ExecPolicyManager + ToolOrchestrator | Extension hooks only (no built-in system) | PermissionNext namespace with Zod types, wildcard matching, promise-based ask/reply |
| **Rule Format** | Starlark `.rules` files with `prefix_rule()` DSL | N/A (regex in extension code) | JSON config with wildcard patterns |
| **Rule Evaluation** | `Policy.check_multiple()` with heuristic fallbacks | Extension regex matching | `findLast()` with `Wildcard.match()` (last-match-wins) |
| **Policy Levels** | 5 (Never/OnFailure/OnRequest/UnlessTrusted/Reject) | N/A | 3 actions (allow/deny/ask) |
| **Decision Types** | Skip/NeedsApproval/Forbidden | Block or allow | allow/deny/ask |
| **User Responses** | Approved/ApprovedForSession/ApprovedExecpolicyAmendment/Denied/Abort | Yes/No (via UI select) | once/always/reject |
| **Approval Caching** | HashMap-based ApprovalStore, per-key, session-scoped | None | In-memory ruleset accumulation |
| **Rule Persistence** | `.rules` files (via amendments) + in-memory cache | None | TODO (PermissionTable exists but disabled) |
| **Cascading** | Multi-key: all keys must be approved individually | N/A | "always" auto-resolves matching pending requests |
| **Rule Amendments** | `proposed_execpolicy_amendment` -> write to default.rules | N/A | "always" adds to session ruleset only |
| **Doom Loop** | Not in approval layer (separate concern) | None | `DOOM_LOOP_THRESHOLD = 3` -> triggers `doom_loop` permission check |
| **Disabled Tools** | Not observed (tools always in LLM list) | N/A | `disabled()` removes tools with blanket deny from LLM list |
| **Command Parsing** | Shell command parsing (bash -lc extraction, pipe splitting) | N/A | Tree-sitter for bash command parsing |
| **Safety Heuristics** | `is_known_safe_command()`, `command_might_be_dangerous()`, 40+ banned prefixes | Simple regex patterns | N/A (rule-based only) |
| **OS Sandboxing** | Full (macOS seatbelt, Linux seccomp, Windows sandbox) | None | None |
| **Network Control** | Network proxy with domain allow/deny | None | None |
| **Error Types** | `ToolError::Rejected(String)` | `{ block: true, reason }` | `RejectedError`, `CorrectedError`, `DeniedError` |
| **Integration Point** | Trait methods on tool runtime (compile-time) | Extension event hooks (runtime) | `ctx.ask()` inline in tool execution |
| **Complexity** | Very high (~2000+ lines across multiple crates) | Minimal (~30 lines example) | Medium (~280 lines in next.ts) |

---

## Synthesis

### Common Patterns

1. **Permission as a Gate**: All projects that implement permissions treat it as a gate in the tool execution pipeline. The tool call is paused until a permission decision is made. codex-rs uses trait methods, opencode uses promise-based `ctx.ask()`, pi-agent uses extension hooks.

2. **Session-Scoped Caching**: Both codex-rs and opencode cache "always approve" decisions within the session scope. codex-rs uses a HashMap with serialized keys; opencode uses a flat ruleset that accumulates "allow" rules.

3. **Pattern-Based Rules**: Both codex-rs and opencode use pattern-based rules to match tool calls. codex-rs uses prefix matching on command tokens; opencode uses wildcard matching on permission names and file paths.

4. **Default to Ask**: Both codex-rs (via heuristics) and opencode (via `evaluate()` default) fall back to asking the user when no rule matches. This is the safest default.

5. **Rejection Cascading**: Both codex-rs and opencode handle rejection cascading. In opencode, rejecting one request rejects ALL pending requests for the same session. In codex-rs, rejection is per-request but the orchestrator handles abort propagation.

### Key Differences

1. **Rule Complexity**: codex-rs has a full Starlark-based rule engine with hot-reloading, heuristic fallbacks, and shell command parsing. opencode uses simple wildcard matching with `findLast()`. The codex-rs approach is more powerful but significantly more complex.

2. **Amendment vs Always**: codex-rs proposes exec policy amendments that create persistent rules in `.rules` files. opencode's "always" only adds to the session-scoped ruleset (no disk persistence yet). codex-rs's approach is more durable.

3. **Doom Loop as Permission**: opencode cleverly integrates doom loop detection into the permission system by using `permission: "doom_loop"`. This allows it to be configured via the same rules as other permissions. codex-rs does not have this integration.

4. **Disabled Tools**: opencode removes completely denied tools from the LLM tool list, preventing wasted API calls. codex-rs does not appear to filter the tool list based on approval rules.

5. **Error Granularity**: opencode distinguishes between `RejectedError` (halt), `CorrectedError` (continue with feedback), and `DeniedError` (auto-blocked by rule). codex-rs uses a single `ToolError::Rejected(String)`. The three-type system is more expressive.

### Best Practices Identified

1. **opencode's `ctx.ask()` pattern**: Inline permission checks within tool execution is the most ergonomic approach. Tools explicitly declare what they need permission for, when they need it.

2. **opencode's doom loop as permission**: Treating doom loop detection as a permission type that flows through the same evaluation pipeline is elegant and configurable.

3. **opencode's disabled tool filtering**: Removing denied tools from the LLM tool list prevents the LLM from calling tools it cannot use, saving tokens and avoiding user confusion.

4. **codex-rs's amendment system**: Proposing persistent rule amendments when users approve commands is a great UX pattern that reduces approval fatigue over time.

5. **opencode's CorrectedError**: Allowing users to reject with a feedback message (CorrectedError) lets the agent self-correct without completely halting, which is better UX than a hard reject.

---

## Open Questions

### Q1: Should doom loop detection be part of the permission system?

opencode integrates it as `permission: "doom_loop"`, making it configurable via the same rules. codex-rs treats it separately.

**Recommendation**: Follow opencode's approach (existing decision D031). Treating doom loop as a permission type simplifies the architecture and makes it configurable. The threshold (3 identical tool+input calls) can be a constant.

### Q2: Should "always" approvals persist to disk?

codex-rs persists amendments to `.rules` files. opencode keeps them in memory only (persistence disabled).

**Recommendation**: Start with session-scoped only (existing D029). Add disk persistence later when there is UI to manage saved rules. This matches opencode's current approach and avoids the complexity of rule file management.

### Q3: How should rule evaluation order work?

codex-rs: Starlark prefix rules with heuristic fallbacks. opencode: flat array with last-match-wins via `findLast()`.

**Recommendation**: Last-match-wins with flat array (existing D027). This is simpler than codex-rs's approach and sufficient for the permission granularity we need. Multiple rulesets are merged via concatenation.

### Q4: Should denied tools be removed from the LLM tool list?

opencode does this. codex-rs does not.

**Recommendation**: Yes (existing D070). Removing denied tools from the LLM's view prevents wasted API calls and improves the agent's behavior.

### Q5: What error types should rejection produce?

codex-rs: single `Rejected(String)`. opencode: `RejectedError`, `CorrectedError`, `DeniedError`.

**Recommendation**: Three error types (aligned with opencode). `RejectedError` halts the tool. `CorrectedError` provides feedback for self-correction. `DeniedError` is auto-rejection by rule (with the matching ruleset for context).

## Decision Validation

| Decision | Status | Notes |
|----------|--------|-------|
| D027 (Rule-based, wildcard, last-match-wins) | **Confirmed** | opencode proves this works well; `findLast()` with `Wildcard.match()` |
| D028 (ctx.ask() inline in tool execution) | **Confirmed** | opencode's approach is clean and ergonomic |
| D029 (once/always/reject responses) | **Confirmed** | opencode's cascading on "always" and "reject" is worth adopting |
| D030 (No OS-level sandbox at MVP) | **Confirmed** | Only codex-rs has sandboxing; very complex, not needed for MVP |
| D031 (Doom loop: same tool+input 3x) | **Confirmed + Refined** | Integrate as a permission type like opencode (`permission: "doom_loop"`) |
| D070 (Denied tools removed from LLM list) | **Confirmed** | opencode's `disabled()` function is the right pattern |
