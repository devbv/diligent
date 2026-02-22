# Layer 3: Approval & Sandbox

## Key Questions

1. What is the permission/approval model? (What triggers approval, what decisions are possible?)
2. How are approval decisions cached/persisted?
3. How is sandboxing implemented? (OS-level, network-level, process-level?)
4. How do approval and sandbox interact with the tool system?
5. What is the approval lifecycle (request → decision → enforcement)?
6. How are rules/policies defined and loaded?
7. How does the system handle escalation (sandbox failure → retry without sandbox)?
8. What are the error types for rejected/forbidden operations?
9. How are network requests controlled?
10. What are the key abstractions and their relationships?

## codex-rs Analysis

### Architecture Overview

**Most sophisticated of the three projects.** Approval and sandboxing are deeply integrated through a trait-based system with three core traits: `Approvable`, `Sandboxable`, and `ToolRuntime` (which combines both).

The central orchestrator (`ToolOrchestrator`) drives a pipeline: **Approval -> Sandbox Selection -> Attempt -> Retry with Escalation -> Network Approval**.

### Approval Model

**`AskForApproval` policy enum** (5 variants, set per-session via config):
- `Never` — never ask (auto-approve everything)
- `OnFailure` — only ask when sandbox execution fails
- `OnRequest` — ask unless running in full-access sandbox
- `UnlessTrusted` — always ask for every tool call
- `Reject` — auto-reject (with granular `rules`/`sandbox_approval` sub-flags)

**`ExecApprovalRequirement` enum** (the decision output):
- `Skip { bypass_sandbox, proposed_execpolicy_amendment }` — no approval needed
- `NeedsApproval { reason, proposed_execpolicy_amendment }` — must ask user
- `Forbidden { reason }` — execution blocked entirely

**`ReviewDecision` enum** (user responses):
- `ApprovedOnce`
- `ApprovedForSession`
- `Rejected`

### Approval Caching

**`ApprovalStore`** — HashMap-based, session-scoped, uses serialized keys for generic caching:
```rust
pub(crate) struct ApprovalStore {
    map: HashMap<String, ReviewDecision>,
}
```

`with_cached_approval()` function: checks cache for all keys, fetches if any missing, stores `ApprovedForSession` decisions per-key. Multi-key support enables `apply_patch` to approve per-file while treating the whole request as approved only when all files are approved.

### Rule-Based Command Approval (ExecPolicy)

**`ExecPolicyManager`** — hot-reloadable rule engine:
- Wraps `ArcSwap<Policy>` for lock-free reads
- Rules loaded from `*.rules` files in config layer stack directories (Starlark-like format)
- `RULES_DIR_NAME = "rules"`, `RULE_EXTENSION = "rules"`
- Evaluates commands via `create_exec_approval_requirement_for_command()`
- `Decision` enum: `Allow`, `Prompt`, `Forbidden`
- Safety heuristics: `is_known_safe_command()`, `command_might_be_dangerous()`
- `BANNED_PREFIX_SUGGESTIONS`: 40+ prefix patterns (python, bash, git, sudo, node, etc.) that cannot be auto-approved via "always allow" amendments

**`proposed_execpolicy_amendment`**: When a command needs approval, the system suggests an exec policy amendment (prefix rule) that would auto-allow similar commands in the future. Users can accept to create persistent rules.

### Sandbox System

**`SandboxPolicy` enum** (set per-session):
- `DangerFullAccess` — no sandbox
- `ExternalSandbox { ... }` — external sandbox management
- (Plus platform-specific modes)

**`SandboxManager`** — central sandbox factory, creates `SandboxAttempt` instances.

**`SandboxAttempt`** carries:
```rust
pub(crate) struct SandboxAttempt<'a> {
    pub sandbox: SandboxType,
    pub policy: &'a SandboxPolicy,
    pub enforce_managed_network: bool,
    pub manager: Option<&'a SandboxManager>,
}
```

**Platform-specific sandboxing:**
- macOS: seatbelt profiles (`MacOsSeatbeltProfileExtensions`)
- Linux: seccomp-bpf
- Windows: Windows Sandbox (`WindowsSandboxModeToml`, `WindowsSandboxLevel`)

**Escalation**: If sandbox execution fails, `escalate_on_failure()` returns true (default), triggering retry without sandbox (may require user approval depending on policy).

### Network Control

**`NetworkApprovalSpec`** — per-tool network requirements:
- `NetworkApprovalMode`: `Immediate` | `Deferred`
- Network proxy with domain allow/deny lists (`NetworkToml`)
- `PermissionsToml { network: Option<NetworkToml> }` in config
- `NetworkToml`: `enabled`, `proxy_url`, `mode` (Limited/Full), `allowed_domains`, `denied_domains`

### Orchestrator Pipeline

`ToolOrchestrator.run()`:
1. Get `exec_approval_requirement` (custom or default based on policy + sandbox policy)
2. If `Forbidden` → return error
3. If `NeedsApproval` → call `start_approval_async()` via `Approvable` trait
4. If rejected → return `ToolError::Rejected`
5. Select sandbox (`sandbox_preference()` → `SandboxAttempt`)
6. First attempt: `tool.run(req, attempt, ctx)`
7. On failure: if `escalate_on_failure()` → retry without sandbox (may need approval)
8. Network approval: `begin_network_approval()` → `finish_immediate/deferred_network_approval()`

### Trait System

```rust
trait Approvable<Req> {
    type ApprovalKey: Hash + Eq + Clone + Debug + Serialize;
    fn approval_keys(&self, req: &Req) -> Vec<Self::ApprovalKey>;
    fn sandbox_mode_for_first_attempt(&self, _req: &Req) -> SandboxOverride;
    fn should_bypass_approval(&self, policy, already_approved) -> bool;
    fn exec_approval_requirement(&self, _req: &Req) -> Option<ExecApprovalRequirement>;
    fn wants_no_sandbox_approval(&self, policy) -> bool;
    fn start_approval_async<'a>(&'a mut self, req, ctx: ApprovalCtx) -> BoxFuture<ReviewDecision>;
}

trait Sandboxable {
    fn sandbox_preference(&self) -> SandboxablePreference; // Auto | Require | Forbid
    fn escalate_on_failure(&self) -> bool; // default: true
}

trait ToolRuntime<Req, Out>: Approvable<Req> + Sandboxable {
    fn network_approval_spec(&self, req, ctx) -> Option<NetworkApprovalSpec>;
    async fn run(&mut self, req, attempt: &SandboxAttempt, ctx: &ToolCtx) -> Result<Out, ToolError>;
}
```

### Error Handling

```rust
pub(crate) enum ToolError {
    Rejected(String),       // User declined
    Codex(CodexErr),        // Execution error (sandbox timeout, etc.)
}
```

---

## pi-agent Analysis

### Architecture Overview

**No built-in permission/approval system.** pi-agent relies entirely on an extension/hook system for permissions. The core agent loop has no approval gates — tools execute directly after being selected by the LLM.

### Extension-Based Approach

Permission handling is implemented through the extension API:
- Extensions can register hooks that intercept tool execution
- Example `permission-gate.ts` demonstrates the pattern
- Extensions can reject tool calls by throwing errors or returning modified results

### No Sandbox

pi-agent has no OS-level sandboxing:
- Shell commands execute directly via `spawn` with no containment
- No network proxy or domain restrictions
- No file access restrictions beyond what the OS provides

### Implications

- Simplest approach: zero approval overhead
- All safety relies on the user trusting the LLM and reviewing output
- The `getSteeringMessages()` mechanism (between sequential tool calls) provides the only interruption point
- Extensions can add approval after the fact, but it's not a first-class concern

---

## opencode Analysis

### Architecture Overview

**Mid-complexity rule-based permission system.** Uses a `PermissionNext` namespace with Zod-validated types, wildcard pattern matching, and a promise-based ask/reply flow.

### Permission Model

**`Rule` type** (Zod-validated):
```typescript
Rule { permission: string, pattern: string, action: "allow" | "deny" | "ask" }
```

**`Ruleset = Rule[]`** — flat array, evaluated with **last-match-wins** semantics (via `findLast`).

**`evaluate(permission, pattern, ...rulesets)`**: merges rulesets, finds last matching rule using `Wildcard.match()` for both permission name and pattern. Default (no match): `"ask"`.

### Rule Sources

1. **Config rules** (`Config.Permission`): per-tool permission settings in `opencode.json{c}`
   - Converted to ruleset via `fromConfig()`: `{ read: "allow", bash: { "rm *": "deny", "*": "ask" } }`
2. **Session-scoped approvals**: accumulated via "always" replies, stored in `PermissionTable` (SQLite)
3. **Agent-specific rulesets**: per-agent permission overrides in agent config

Multiple rulesets are merged (flat concatenation) and evaluated together.

### Ask/Reply Flow

**`ask()`** — async function, creates a promise-based approval flow:
1. For each pattern in the request, evaluate against merged rulesets
2. If `"deny"` → throw `DeniedError` immediately
3. If `"ask"` → create pending promise, publish `Event.Asked` on bus
4. If `"allow"` → continue (resolve immediately)

**`reply()`** — handles user response:
- `"once"` — resolve the single pending request
- `"always"` — add patterns to session-scoped approved ruleset, resolve this request AND all other pending requests that now match
- `"reject"` — reject this request AND all other pending requests in the same session

The "always" cascade is notable: approving one request can auto-resolve multiple pending requests.

### Permission Request

```typescript
Request {
    id: string,
    sessionID: string,
    permission: string,        // e.g., "bash", "edit", "read"
    patterns: string[],        // e.g., ["/path/to/file"]
    metadata: Record<string, any>,  // context for UI display
    always: string[],          // broad patterns for "always allow"
    tool?: { messageID, callID }
}
```

### Integration with Tools

Tools call `ctx.ask()` mid-execution:
```typescript
await ctx.ask({
    permission: "read",
    patterns: [filepath],
    always: ["*"],
    metadata: { filepath, diff },
});
```

The `ctx.ask()` call blocks tool execution until the user responds. On rejection, throws `RejectedError` or `CorrectedError` (with user feedback message).

### Disabled Tools

`disabled(tools, ruleset)`: scans ruleset for tools that have a blanket `"deny"` rule (pattern `"*"`) — these tools are excluded from the LLM's tool list entirely.

### Persistence

Session-scoped approvals stored in `PermissionTable` (SQLite via Drizzle ORM):
- Loaded on startup from DB
- "Always" approvals accumulate during session
- NOTE: disk persistence is currently disabled (TODO comment in source: "we don't save the permission ruleset to disk yet until there's UI to manage it")

### Error Types

```typescript
class RejectedError extends Error     // User rejected without message — halts execution
class CorrectedError extends Error    // User rejected with message — continues with guidance
class DeniedError extends Error       // Auto-rejected by config rule — halts, includes matching ruleset
```

### No OS-Level Sandbox

opencode has no OS-level sandboxing (no seatbelt, seccomp, etc.). Permission enforcement is purely at the tool-call level. However, it does use tree-sitter for bash command parsing to enable finer-grained command-level permissions.

---

## Comparison Table

| Aspect | codex-rs | pi-agent | opencode |
|---|---|---|---|
| **Approval System** | Trait-based (Approvable + Sandboxable + ToolRuntime) | None (extension hooks only) | Rule-based (PermissionNext with Zod types) |
| **Policy Levels** | 5 levels (Never/OnFailure/OnRequest/UnlessTrusted/Reject) | N/A | 3 actions (allow/deny/ask) |
| **Rule Engine** | ExecPolicyManager with .rules files (Starlark), hot-reloadable | N/A | Wildcard pattern matching, last-match-wins |
| **Approval Caching** | HashMap-based ApprovalStore, per-key, session-scoped | N/A | Session-scoped ruleset accumulation, SQLite storage (disabled) |
| **OS Sandbox** | Platform-specific (macOS seatbelt, Linux seccomp, Windows sandbox) | None | None |
| **Network Control** | Network proxy with domain allow/deny, proxy URL | None | None |
| **Escalation** | Sandbox failure → retry without sandbox (may need approval) | N/A | N/A |
| **Tool Integration** | Traits on tool runtime (compile-time) | Extension hooks (runtime) | ctx.ask() inline in tool execution |
| **Decision Persistence** | Session-scoped cache + .rules files | N/A | PermissionTable (SQLite, currently disabled) |
| **Error Types** | ToolError::Rejected, ToolError::Codex, FunctionCallError | N/A | RejectedError, CorrectedError, DeniedError |
| **Cascading Approval** | Multi-key: approve all keys individually, skip if all cached | N/A | "always" reply resolves all matching pending requests |
| **Rule Amendments** | proposed_execpolicy_amendment for persistent "always allow" | N/A | "always" reply adds to session ruleset |
| **Complexity** | Very high (orchestrator, traits, sandbox, network, rules engine) | None | Medium (rule evaluation, ask/reply flow, bus events) |

## Open Questions

1. **Approval granularity**: codex-rs has per-command approval with rule amendments. opencode has per-tool with pattern matching. What is the right granularity for a new agent? Per-tool (simpler) vs per-command (more precise)?

2. **Sandbox necessity at MVP**: Only codex-rs implements OS-level sandboxing, and it's complex (platform-specific). Is sandboxing needed for MVP, or can it be deferred?

3. **Rule format**: codex-rs uses Starlark .rules files (powerful, custom DSL). opencode uses JSON config with wildcard patterns (simpler, declarative). Which approach balances power and simplicity?

4. **Approval persistence**: codex-rs caches in-memory per-session. opencode stores in SQLite but has it disabled. Should approvals persist across sessions?

5. **Network sandboxing**: Only codex-rs has network proxy/domain control. Is network-level sandboxing important for a coding agent?

6. **Escalation pattern**: codex-rs's "retry without sandbox on failure" is sophisticated. Is this pattern needed, or is a simpler "approve and run" sufficient?

7. **Integration point**: codex-rs integrates at the trait level (compile-time). opencode integrates via ctx.ask() (runtime). pi-agent has no integration. The D016 decision (approval hook placeholder in ToolContext) aligns with opencode's approach.

8. **Doom loop detection**: opencode detects same tool+input 3x in a row. This is orthogonal to approval but related to safety. Should it be part of L3 or separate?

9. **Disabled tools**: opencode's pattern of completely removing tools from the LLM's view based on deny rules is interesting. Is this better than letting the LLM try and fail?

10. **"Always" cascading**: opencode's pattern where approving one request auto-resolves matching pending requests is elegant. Worth adopting?
