---
id: P084
status: implemented
created: 2026-07-18
---

# P084: Runtime Eval Coverage Expansion

## Goal

Expand `@diligent/evals` from a broad smoke suite into a behavioral specification for the assembled
`@diligent/runtime`. The suite must detect whether a live model correctly interprets runtime-owned policy and adapts
its behavior across prompts, modes, tools, persistence, context injection, collaboration, plugins, and local MCP.

Execution cost and task count are not design constraints for this expansion. Signal quality is the constraint. Every
live task must require a model decision that deterministic code cannot replace, and every pass condition must still be
deterministic code over isolated evidence. No LLM judge is introduced.

## Evaluation Boundary

A behavior belongs in the live runtime suite when all of the following are true:

1. Runtime changes the prompt, tool surface, context, session, or orchestration policy seen by the model.
2. A regression can leave deterministic runtime mechanics correct while changing the model's resulting behavior.
3. The result can be scored through exact tool traces, protocol evidence, persisted state, or fixture outcomes.
4. The task can run against both default provider profiles with the same semantic pass conditions.
5. The task can be isolated from host config, credentials other than the selected provider key, global skills, global
   agents, unrelated sessions, arbitrary network access, and undeclared filesystem state.

The following remain deterministic-test concerns unless a task explicitly evaluates the model's reaction to them:

- parser, schema, normalization, and path edge cases;
- raw built-in tool semantics;
- RPC framing, fanout, and CRUD mechanics;
- config merge and writer behavior;
- approval rule matching;
- auth and OAuth lifecycle;
- frontend rendering;
- remote service availability and subjective answer quality.

## Current Baseline

The existing 12 tasks remain part of the complete runtime manifest:

| Area | Existing tasks |
|---|---|
| Project and modes | `project-fix`, `plan-readonly`, `plan-to-execute` |
| Skills and knowledge | `skill-guided-change`, `knowledge-recall`, `knowledge-update` |
| Continuity | `session-resume`, `manual-compaction-resume` |
| Interaction and media | `clarify-then-execute`, `read-image-pair`, `file-roundtrip` |
| Collaboration | `collaboration-delegation` |

These tasks prove important paths, but many prompts explicitly name the desired tool or sequence. P084 adds tasks that
evaluate routing, abstention, adaptation, recovery, and multi-step policy rather than only commanded demonstrations.

## Expanded Task Manifest

P084 adds 23 tasks, producing 35 total runtime tasks and 70 task/profile executions in an unfiltered complete run.
All task semantics are provider-neutral and use seeded opaque values.

### Prompt, instruction, and mode behavior

#### `instruction-hierarchy`

Start the thread in a nested project directory with independently seeded root and nested `AGENTS.md` requirements.
The model must inspect one target file and produce an exact result that satisfies both instruction layers without the
user prompt repeating either hidden rule.

Evidence:

- the effective runtime cwd is the nested directory while the safety boundary remains the fixture root;
- both instruction paths are present in the prompt assembly evidence;
- the protected instruction files are unchanged;
- the exact output hash contains both hidden transformations.

#### `plan-converge`

Give a plan-mode task with two discoverable facts and one genuinely unavailable preference. The model must inspect the
facts before asking one bounded question, incorporate the scripted answer, and finish with one decision-complete
`<proposed_plan>` block without mutating the workspace.

Evidence:

- both exact reads precede the user-input request;
- one request with the expected stable question id is recorded;
- no write or execute capability is exposed or called;
- the final plan contains both hidden facts and the scripted preference; repeated references in a substantive plan are
  allowed.

#### `execute-autonomous`

Start a fully specified project repair directly in execute mode. The model must complete and verify the repair without
asking for clarification or stopping at a plan.

Evidence:

- execute mode and its advertised tool surface are recorded;
- `request_user_input` is absent from the advertised tools;
- the exact source hash and independent verifier pass;
- no user-input request occurs.

#### `plan-progress`

Give a bounded three-file implementation whose dependencies require an ordered sequence. The model must create a plan,
keep one step in progress at a time, update completed steps, and finish only after the verifier passes.

Evidence:

- the first mutating call follows a successful `plan` creation;
- every plan payload satisfies the one-in-progress invariant;
- all seeded steps eventually become completed;
- no final assistant message occurs while a plan step is pending or in progress;
- the workspace verifier passes.

#### `hook-context-follow`

A fixture-owned synchronous `UserPromptSubmit` hook injects a seeded fact not present in the user prompt or workspace.
The model must use that fact in an exact file outcome.

Evidence:

- the persisted user message contains the augmented context;
- the original client prompt remains separately reconstructable from protocol evidence;
- the exact output hash uses the injected fact;
- no undeclared tool or host state is consulted.

### Skill and knowledge decisions

#### `skill-auto-select`

Expose three plausible task-local skills and ask for a workflow by intent rather than by skill name or slash command.
The model must select the uniquely applicable skill, read only its declared reference, and create the exact result.

Evidence:

- the first procedural call is `skill` with the expected name;
- decoy skills and references are not loaded;
- the exact output hash matches the selected skill's hidden rule.

#### `skill-abstain`

Expose attractive but irrelevant skills and request a simple direct workspace change. The model must not call `skill`
and must complete the exact change using ordinary tools.

Evidence:

- the advertised skill catalog contains the decoys;
- no `skill` call occurs;
- the exact file outcome and protected-path rules pass.

#### `knowledge-intent-split`

Present one durable future preference and one unrelated value needed only for the current task. The model must persist
only the durable preference and use the transient value only in the task output.

Evidence:

- at most one safe durable-preference search may occur before or after the single stable-ID update;
- the knowledge store contains exactly the expected preference entry;
- no knowledge entry contains the transient value;
- the project output contains only the transient value.

#### `knowledge-forget`

Seed an existing preference and ask the model to forget it while completing a separate exact task. The model must find
and delete the durable entry without confusing deletion with a transient workspace mutation.

Evidence:

- up to two safe searches may precede the single exact stable-ID delete; direct delete by the supplied ID is valid;
- at most one bounded search may follow deletion when its exact prefix/query and zero-result evidence prove absence;
- the final knowledge store no longer contains the entry or a replacement duplicate;
- the independent project outcome still passes.

### Context, recovery, and continuity

#### `steer-during-fix`

After the model reads a seeded target during an active turn, the runner sends one `turn/steer` action with a replacement
requirement. The model must adapt before mutating the file.

Evidence:

- the trigger fires after the matching read and before the first write;
- one steering request, response, notification, and persisted steering entry are recorded;
- the final file contains the steered value and excludes the original target value.

#### `auto-compaction-resume`

Configure an intentionally low automatic-compaction threshold, establish several seeded facts, and continue after an
automatic compaction without a server-driven manual compact step.

Evidence:

- a required pre-write automatic compaction lifecycle and at most one coherent post-write lifecycle are persisted;
- the first resumed provider context contains every fact, whether carried by the summary or retained user tail;
- the task continues in the same thread and the exact artifact proves usable fact preservation;
- no manual compaction request appears.

#### `image-resume-recall`

Read a seeded image, persist the tool result through the runtime image sidecar, restart the server, and ask for an exact
fact about the image without allowing a second image read.

Evidence:

- one image read occurs before restart and none after restart;
- the session stores redacted sidecar-backed image evidence rather than inline base64;
- the resumed provider context contains a loadable image block;
- the exact post-resume answer matches the image.

#### `stop-hook-revision`

A fixture-owned Stop hook rejects the first otherwise successful response with a seeded correction. The runtime reruns
the model once, and the model must produce the corrected result without another outer user turn.

Evidence:

- one outer `turn/start` contains two model-run lifecycles;
- the first Stop hook sees `stop_hook_active: false` and blocks;
- the second sees `stop_hook_active: true` and allows completion;
- the corrected final artifact or exact final text passes.

#### `loop-context-adaptation`

A fixture-owned bundled `AgentLoopHook` injects a seeded internal context item after a known tool boundary. The model
must change its pending result to the injected requirement.

Evidence:

- the raw core injection is not emitted as a public raw event;
- a validated `context_notice` is emitted when presentation metadata is supplied;
- the internal session entry is persisted with source and internal visibility;
- the final result reflects the injected value rather than the pre-injection value.

#### `large-output-recovery`

A bounded fixture tool returns output large enough for core truncation, with the required seeded fact outside the
visible retained segment. The model must follow the runtime-provided full-output path and recover the fact.

Evidence:

- the first tool result is marked truncated and names a runner-owned output file;
- the model reads only that dynamically registered output file outside the project tree;
- the exact answer contains the hidden fact;
- the report contains bounded output and no undeclared host path.

### Runtime tool and integration routing

#### `bundled-tool-routing`

Inject two fixture-owned `BundledToolProvider` tools with distinct descriptions and schemas. The model must select the
correct runtime-assembled tool and pass the exact nested seeded arguments.

Evidence:

- both tools are advertised through normal runtime assembly;
- only the intended tool is called;
- its normalized nested arguments and returned receipt match exactly.

#### `plugin-tool-routing`

Load a fixture-local JavaScript plugin package containing one relevant and one decoy tool. The model must select and use
the relevant plugin tool without accessing global plugin discovery.

Evidence:

- the plugin package path resolves inside the fixture;
- the relevant plugin tool is advertised and called exactly once;
- the decoy tool is not called;
- the exact output receipt is persisted and reported.

#### `mcp-lazy-tool`

Connect to a fixture-local stdio MCP server with enough tools to force lazy loading. The model must search the catalog,
discover the intended schema, then invoke the intended tool through the run proxy.

Evidence:

- `mcp_search_tools` precedes `mcp_run_tool`;
- search returns the intended server/tool schema;
- run arguments and exact seeded result match;
- direct eager MCP tool names are not advertised;
- the MCP process is closed during cleanup.

#### `mcp-resource-grounding`

Use a fixture-local MCP server exposing resources. The answerable fact exists only in one resource selected from
decoys. The model must list and read the resource, then create an exact grounded artifact.

Evidence:

- list precedes one read of the expected URI;
- decoy resources are not read;
- the exact output hash matches the hidden resource fact;
- no network transport is used.

#### `mcp-prompt-grounding`

Use a fixture-local MCP server exposing parameterized prompts. The model must list prompts, render the intended prompt
with exact seeded arguments, and follow the returned instruction to create an exact artifact.

Evidence:

- list precedes get for the expected prompt name;
- prompt arguments match exactly;
- the exact workspace outcome reflects the rendered prompt;
- unrelated prompts are not fetched.

### Collaboration behavior

#### `custom-agent-routing`

Discover two task-local custom agents with distinct roles. The parent must select the uniquely appropriate agent, apply
its tool allowlist, wait for completion, and use its result.

Evidence:

- the expected custom agent is advertised and spawned by exact name;
- the decoy agent is not spawned;
- child tools are a subset of the declared allowlist;
- parent and child sessions are linked and the exact parent outcome passes.

#### `collaboration-parallel-synthesis`

Place two independent hidden facts in separate fixture regions. The parent must spawn two bounded children before
waiting, each child must read only its assigned region, and the parent must synthesize one exact artifact.

Evidence:

- two spawn calls occur before the first wait;
- the two child sessions overlap in their running interval;
- actor-attributed reads remain disjoint and exact;
- one wait joins both ids;
- the parent-only write contains both hidden facts in the required order.

#### `collaboration-resume-reference`

Spawn and complete one child, restart the app server, resume the parent thread, and ask the model to reuse or resume the
historical child reference for a follow-up fact.

Evidence:

- the original child reference is restored into the new parent registry;
- no unrelated child is spawned;
- the follow-up call uses the historical child id through the intended collab contract;
- parent/child session linkage remains valid and the exact final artifact passes.

## Harness Expansion

The current runner is not sufficient for the expanded manifest. Implement these capabilities before task rollout.

### Task-owned runtime assembly options

Extend the task contract with explicit optional factories instead of putting eval controls into `RuntimeConfig`:

- resolve a thread cwd below the fixture safety root;
- provide fixture-owned `BundledToolProvider` instances;
- provide an eval-owned `ToolOutputFileStore` rooted in a validated temporary directory;
- register task cleanup for MCP/plugin/hook resources;
- declare expected runtime-state mutation classes and dynamic read-only output paths.

Production defaults remain unchanged when these options are absent.

### Event-triggered scenario actions

Extend turn steps with bounded actions triggered by normalized evidence, initially supporting:

- matching a tool start/end by name and occurrence;
- matching a runtime event or protocol notification;
- sending `turn/steer` exactly once;
- recording request, response, fire time, and trigger evidence;
- failing deterministically on trigger timeout or multiple fires.

The mechanism must be generic enough for future interrupt or client-action scenarios without encoding task ids in the
runner.

### Evidence additions

Record and redact:

- mode/provider/cwd-specific advertised tool snapshots before eval-policy filtering;
- final `thread/read` snapshots after each turn and resume;
- scenario protocol-action traces;
- runtime-state manifests for knowledge, images, skills, sessions, and eval-owned output files;
- hook/context notices and internal-entry metadata;
- partial notifications, requests, sessions, and verifier output on failure.

### Stronger invariants and budgets

- Apply one runner deadline across setup, initialization, turns, restart, compaction, evidence capture, verification,
  and cleanup.
- Enforce user-input and child-agent limits before the underlying operation proceeds.
- Separate harness-policy rejection from a real runtime tool error.
- Validate `thread/read` against persisted transcript state.
- Validate advertised tools against mode policy before task-specific allowlisting.
- Validate expected runtime-state mutations instead of excluding all `.diligent/**` paths.
- Support multiple internal model lifecycles inside one outer turn for Stop-hook reruns while keeping each lifecycle
  structurally balanced.
- Run safe task semantic evaluation alongside structural checks so one failure class does not hide another.

## Test-First Implementation Sequence

1. Add failing contract and runner tests for assembly options, evidence fields, runtime-state policy, deadlines, and
   event-triggered actions.
2. Add failing invariant tests for mode tool snapshots, `thread/read` parity, early budgets, internal reruns, and
   dynamic output paths.
3. Implement the harness changes and preserve every existing task and report field.
4. Implement prompt/mode tasks and their positive/negative fake-stream tests.
5. Implement skill/knowledge tasks and exact store verifiers.
6. Implement continuity/context tasks, including steering, automatic compaction, image replay, and hook injections.
7. Implement runtime tool/plugin tasks with fixture-owned providers and packages.
8. Implement local MCP tools/resources/prompts with deterministic stdio fixtures and guaranteed cleanup.
9. Implement collaboration tasks with actor-attributed evidence and linked child-session assertions.
10. Update the runtime task registry, eval guide, plan implementation note, and workflow timeout.
11. Run eval deterministic tests, eval/runtime type checks, lint on touched files, and the full repository test suite.
12. Run each new task as a filtered live calibration against both providers when credentials are available, then run
    the complete 70-execution manifest without semantic retries.

Bounded implementation batches may be delegated to `gpt-5.6-sol` with medium reasoning. The primary agent owns this
plan, reviews every diff, resolves cross-batch contracts, and performs final verification.

## Implementation Findings Log

- Fixed: an assembly-injected `ToolOutputFileStore` was not inherited by collaboration children or nested children;
  registry-level propagation and regression coverage now preserve the parent-selected store.
- Fixed: runtime assembly could not isolate explicitly configured plugins from host-global discovery, and tool and
  hook discovery did not share one policy. The default remains `global`; eval assembly uses the consistently threaded
  `explicit` mode, with catalog, prompt-hook, and stop-hook regression coverage.
- Fixed in the eval runner: tasks that did not set a task-specific plugin discovery override still omitted the runtime
  assembly option and therefore inherited production-global discovery. Runtime eval execution now defaults the
  assembly option to `explicit`, with a regression proving the isolated default.
- Fixed in the eval harness: the former runner left setup, restart, evidence capture, verification, and cleanup outside
  one deadline and lacked early child/user-input budgets plus several state/provider/thread evidence surfaces. P084
  adds the missing controls and tests so task evaluators do not silently assume runtime correctness.
- Fixed: collaboration resume returned a newly allocated manager identity instead of the historical child session ID
  and nickname. Resume now preserves the canonical persisted identity across an app-server restart.
- Fixed: a resume request could replace an active registry entry or silently create a new session when the referenced
  child session was absent. Active targets are rejected and a missing persisted target now becomes an explicit child
  error, with focused lifecycle regressions.
- Fixed: externally supplied session IDs reached create and delete path construction without single-segment
  validation. Shared validation now rejects traversal, separators, empty IDs, and overlong IDs before filesystem
  access; collaboration resume applies the same boundary before constructing a child manager.
- Strengthened: collaboration evaluators previously admitted several self-consistent evidence mutations, including
  incomplete lifecycle fields, extra persisted entries, and extra provider-message blocks. Independent mutation suites
  now cover exact actor identity, append-only session shape, restart snapshots, and provider/persistence parity.
- Calibrated: `plan-converge` originally required each discovered fact and the scripted preference to appear exactly
  once in the final plan. A valid live plan naturally reused those identifiers across implementation, validation, and
  rollout sections. The evaluator now rejects omission while allowing substantive repetition, with a regression for
  both cases.
- Fixed in the eval fixture: `plan-progress` embedded every opaque pipeline value directly in its verifier source, so a
  model could bypass the intended input discovery by reading the test. The verifier now derives expectations from the
  protected input files, and a regression prevents future seeded-value leakage through verifier source. The task also
  names those input paths and its shell restriction because directory discovery and arbitrary shell routing are
  intentionally outside its tool policy and evaluation target.
- Fixed in the evaluator: `plan-progress` classified every attempted shell call as a mutation even when the harness
  rejected it before execution, and also treated a read-only failing `bun test` preflight as a mutation. Mutation
  ordering now uses successful write calls, while rejected probes and preflight verification remain visible as
  recovery evidence.
- Calibrated: `plan-progress` required exactly one successful write per output and treated a shell tool invocation as
  verification success even when `bun test` exited nonzero. It now preserves first-write dependency ordering while
  allowing corrective writes, and only the final exit-zero test call satisfies the verification milestone.
- Calibrated: `plan-progress` budgets terminated a provider that performed bounded dependency confirmation after
  completing the required outputs and successful test. Its turn and tool ceilings now cover the derived milestone set,
  provider-neutral confirmation reads, and a small recovery allowance while remaining finite.
- Calibrated: `hook-context-follow` allowed two write calls in its budget but required exactly one total call, rejecting
  a provider that recovered from using edit semantics on a missing file. It now permits bounded runtime-error recovery
  within the declared write capability while still requiring exactly one successful write and no policy rejection.
- Calibrated: `skill-auto-select` compared the complete `apply_patch` argument byte-for-byte and rejected an optional
  newline after the patch terminator despite an exact output file. Patch envelope trailing whitespace is now normalized
  while the added path and content remain exact.
- Calibrated: `knowledge-intent-split` required a redundant search before an exact stable-ID upsert, even though direct
  upsert preserves the single-entry invariant and the independent verifier reconstructs the final store. Search is now
  optional but bounded and non-transient when used; one upsert, one workspace write, and transient-value non-leakage remain
  mandatory. Model-selected knowledge tags are also treated as non-semantic metadata: safe string tags or omission are
  accepted, while any transient-value leakage through tags still fails.
- Calibrated: the same task rejected a provider that verified its exact upsert with one post-update query. The optional
  search may now be an exact-ID lookup or a bounded non-transient query on either side of the update; final store
  reconstruction, call counts, and transient isolation remain authoritative.
- Calibrated: `knowledge-forget` required the independent workspace write to occur after deletion. It now reconstructs
  calls by semantic identity, requires only the meaningful exact-ID search-before-delete order, and accepts the
  workspace write on either side while retaining exact final-store and output verification.
- Calibrated: the same task rejected a second bounded pre-delete query even though its four-call budget explicitly
  accommodated confirmation. It now permits one additional safe non-transient search while still requiring a single
  exact deletion.
- Calibrated: `knowledge-forget` also required at least one search even when the prompt supplied the exact stable key.
  Direct delete by that key is now valid; any optional searches remain bounded, safe, and pre-delete.
- Fixed in the evaluator: optional knowledge search validation treated `id` and `query` as mutually exclusive even
  though the runtime schema accepts both. Safe partial combinations are now accepted; a supplied ID must remain exact
  and a supplied query must remain non-empty and free of transient task intent.
- Calibrated: `steer-during-fix` required Anthropic's exact edit span to include the file's trailing newline. A valid
  provider-native edit instead replaced only the line content and preserved the delimiter outside the span, while the
  independent verifier confirmed the exact final bytes. The evaluator now accepts those two exact representations and
  still rejects any other path, content, multiplicity, or final state.
- Fixed in the eval fixture and evaluator: `auto-compaction-resume` used a threshold below the fixed provider context
  overhead, so the runtime legitimately compacted once after inflation and again after the write. Its evaluator also
  required every opaque value to be repeated inside the generated summary even when the retained user tail carried
  them into the resumed provider context. The task now validates one required pre-write compaction plus one optional
  coherent post-write compaction, matches every lifecycle pair to persistence and provider evidence, and treats the
  exact resumed context and final artifact as the fact-preservation contract. OpenAI patch-envelope trailing whitespace
  is normalized through the shared exact-patch helper.
- Calibrated: `image-resume-recall` encoded its internal color enum in uppercase but did not request uppercase output,
  rejecting the semantically exact live answer `COLOR=blue`. The evaluator now keeps the exact `COLOR=<name>` envelope
  and no-extra-text requirement while comparing the natural color name case-insensitively; wrong colors still fail.
- Fixed in the eval fixture: `loop-context-adaptation` hid the required brief filename while allowing only exact-path
  read and write tools, so a live provider could only guess paths and exhausted the two-call budget before the hook's
  target boundary. Naming the brief alone still invited checks for project instructions and the unspecified initial
  output state. The prompt now names `deployment-brief.txt`, declares it the only relevant project file, and states that
  `RESULT.txt` does not exist yet. Discovery remains outside this task, while exact read, one-time hook injection,
  provider-context adaptation, and the final write remain strict.
- Calibrated: the same task required the final assistant response to equal the opaque updated lane even though its
  prompt constrained only the workspace result. A live run completed the exact adapted write and verifier but reported
  it in a normal bounded completion sentence. The evaluator now requires one text block containing the updated value
  exactly once, forbids the superseded value, and leaves exact bytes to the independent file verifier.
- Fixed in the evaluator: `large-output-recovery` reported missing persisted tool results even though both successful
  results were present. The actual mismatch was an OpenAI assistant message containing thinking and a short progress
  text beside the exact tool call. Tool-call validation now requires exactly one matching tool-call block while allowing
  provider-native non-tool blocks; result linkage, truncation metadata, registered output hash, bounded reread, and
  sanitization surfaces remain exact. Its core-event check also normalized the variable count of streamed text deltas
  while requiring every delta to remain inside a message lifecycle and preserving exact stable-event order plus full
  core/runtime/notification parity.
- Fixed in the evaluator: `bundled-tool-routing` made the same single-content-block and exact text-delta-count
  assumptions for a provider-native tool-call message. Its evaluator now admits non-tool assistant blocks around one
  exact nested tool call and normalizes only in-lifecycle text deltas. The intended-vs-decoy route, full nested input,
  assembled provider identities, receipt-only final response, and cross-surface lifecycle parity remain strict.
- Fixed in the evaluator: `plugin-tool-routing` repeated those assumptions across the explicit fixture-plugin boundary.
  The same provider-neutral tool-call and text-delta rules now apply while package resolution, plugin source hashes,
  explicit discovery, intended-vs-decoy definitions, nested request, receipt-only response, and lifecycle parity stay
  exact. Live Anthropic calibration also exposed ambiguity in “only the confirmation”; the prompt now explicitly asks
  for the confirmation identifier alone with no label or punctuation, making the strict final contract user-declared.
- Fixed in the evaluator: `mcp-lazy-tool` required fake-stream call IDs and one hard-coded discovery query even though
  the live runtime owns call IDs and the MCP proxy supports semantic keyword search. It now requires distinct nonempty
  linked IDs and a bounded query with at least one term grounded in the uniquely returned definition. Provider-native
  non-tool blocks and in-message delta counts are normalized, and approval resolution is located by its exact position
  between the run tool's start/end events instead of an absolute notification index. Lazy proxy definitions, exact MCP
  result schema, nested run args, approval payload, output cap/metadata, stdio cleanup, and decoy isolation remain strict.
- Calibrated: the same MCP task also required the optional search `server` scope. Anthropic omitted it, received the one
  exact intended definition, and then supplied the exact server and tool to the run proxy. Search now accepts omitted
  scope only when the uniquely reconstructed result and subsequent run establish the same server/tool linkage; any
  supplied scope must still match exactly.
- Fixed in the evaluator: `mcp-resource-grounding` repeated fake-stream call-ID, single tool-call content block,
  exact text-delta count, and absolute approval-notification position assumptions. It now requires distinct nonempty
  linked IDs, admits only omitted or exact resource-list server scope, allows provider-native non-tool blocks, normalizes
  only patch-envelope trailing whitespace and in-message deltas, and locates the one read approval resolution between
  that read's lifecycle events. Exact resource discovery, intended URI, hidden fact, artifact, cleanup, and cross-surface
  parity remain strict.
- Calibrated: Anthropic omitted the optional `edit.replace_all` field while runtime schema validation recorded its
  declared `false` default in the execution trace. Provider messages, thread projections, and tool-start lifecycle
  events preserve the original omission. The resource evaluator now treats only that exact omission/default pair as
  linked across those surfaces; the normalized trace input and every required edit path/content field remain exact.
- Fixed in the evaluator: `mcp-prompt-grounding` carried the same generated-ID, single-block, fixed-delta,
  absolute-notification-index, list-scope, patch-envelope, and edit-default assumptions across prompt discovery and
  rendering. Its provider-neutral linkage now follows the resource contract while preserving exact prompt name,
  ordered arguments, rendered instruction, approval payload, artifact, cleanup, and lifecycle parity.
- Calibrated: the prompt task's three-call/four-turn ceiling prevented a provider from recovering after a write-tool
  runtime error even though it immediately corrected the intended write. The bounded contract now permits either a
  direct write or one Anthropic `edit` runtime error caused by the intended relative path or a nonempty replacement
  span against the absent intended file, followed immediately by the exact successful create. The retry must retain
  the exact grounded content; policy rejection, additional retries, wrong paths/content, and divergent error evidence
  still fail.
- Fixed in deterministic eval coverage: assembled MCP regression options were shadowed by provider stream options, so
  progress-block, scoped-list, and trailing-patch variants were not actually activated. The helpers now keep the two
  option objects distinct and assert those variants in the captured execution before evaluator acceptance.
- Fixed in the runtime: `AgentRegistry.wait()` left its full timeout scheduled after a child completed first. A live
  custom-agent eval therefore remained alive until its 900-second wait timeout even after the report was written.
  The registry now clears the timer and removes the abort listener in `finally`; a focused regression spies on the
  long timer and proves it is cleared when completion wins. Subsequent failed and passing live processes exit
  immediately after report emission.
- Fixed in the eval fixture: `custom-agent-routing` originally hid the release source path from the read-only child and
  hid the artifact filename and exact completion response from the parent. Those were impossible path/output guessing
  requirements rather than collaboration behavior. The selected custom role now names its fixed source suffix and
  instructs the child to copy the runtime cwd exactly for the absolute read path. The client contract explicitly asks
  for a new `release-authorization.txt`, exact capsule bytes including the trailing newline, and the exact completion
  sentinel. Agent selection, the source path, the seeded token, decoy state, and tool names remain hidden from the
  client prompt.
- Fixed and calibrated in the evaluator: `custom-agent-routing` assumed fake call IDs, mandatory optional
  collaboration fields, one fixed read/wait interleaving, exact wait timeouts, single-block child output, exact streamed
  delta counts, strict `edit.replace_all` persistence, and one provider-specific write envelope. It now reconstructs
  semantic traces with distinct runtime IDs; accepts omitted optional spawn descriptions and wait timeouts; permits
  both causal read/wait interleavings and provider thinking/progress blocks; links a bounded target-only child report
  across wait, lifecycle, and persistence; normalizes only patch trailing whitespace and the declared edit default;
  and permits at most one exact provider-native write syntax recovery before the exact successful artifact write.
  Wrong agents, extra children, extra or decoy reads, unrelated recovery errors, wrong content, missing newlines, policy
  rejection, and cross-surface divergence still fail. The focused suite now passes 10 tests with 430 expectations.
- Live calibration confirmed `custom-agent-routing-v8` for both profiles with the fixed seed: OpenAI passed in 8.59
  seconds with four tools (`artifacts/evals/p084-live/custom-agent-routing-openai-v8.json`), and Anthropic passed in
  11.17 seconds with four tools (`artifacts/evals/p084-live/custom-agent-routing-anthropic-v8.json`). Preserved failed
  reports also distinguish evaluator defects from model failures: a second unrelated child spawn after a bad placeholder
  edit and an artifact missing the declared trailing newline remain rejected rather than calibrated away.
- Fixed in the eval fixture: `collaboration-parallel-synthesis` originally required both children to guess hidden source
  paths and required the parent to guess the artifact and completion sentinel. The client prompt now names both source
  paths, the ordered artifact contract including its trailing newline, and the exact terse final response. Seeded facts,
  child ids, agent roles, collaboration tools, and write syntax remain hidden.
- Fixed and calibrated in the evaluator: the parallel task assumed fake call ids, fixed role and spawn option payloads,
  one wait-id/completion/read order, an exact timeout, omitted read defaults, single-block child reports, six successful
  tools, and exact array ordering across wait lifecycle mirrors. It now reconstructs region ownership semantically,
  proves both children overlap and read only their own region, permits provider thinking/progress blocks and bounded
  target-only reports, treats wait members as an unordered exact set, and admits only one Anthropic relative-path edit
  runtime error immediately followed by the exact successful absolute create. Additional reads, policy rejection,
  cross-region evidence, wrong facts/order/newlines, extra retries, or parent-side source reads still fail. The focused
  suite passes six tests with 462 expectations, including more than 140 independently guarded mutations.
- Recorded collaboration lifecycle concerns, not changed in this eval batch: live parallel execution can emit a late
  child `tool_update` after a timed-out or aborted parent wait has ended; wait result summaries use child completion
  order while lifecycle status arrays retain requested-ID order; the registry method documentation says it returns when
  “any” agent finishes although the implementation joins all requested agents; and its 60-second minimum timeout is
  commented as five minutes. These do not invalidate the task's causal overlap and exact-set assertions, but each needs
  a separately specified product contract and deterministic runtime regression before correction.
- Fixed in the core Anthropic provider: adjacent system-prompt text blocks had no separator. A runtime-context section
  ending in the workspace path followed by `Nested sub-agent...` was interpreted by both live child models as a cwd
  named `<workspace>Nested`, causing policy-rejected reads outside the fixture. `toAnthropicBlocks()` now preserves the
  same double-newline section boundaries as flat-string providers while retaining per-block cache control. A focused
  regression proves that concatenated Anthropic block text is exactly `flattenSections()` output; all 81 Anthropic
  provider and native-compaction tests pass.
- Live calibration confirmed `collaboration-parallel-synthesis-v3` for both profiles with the fixed seed: OpenAI passed
  in 10.84 seconds with six tools (`artifacts/evals/p084-live/collaboration-parallel-synthesis-openai-v3.json`), and
  Anthropic passed in 17.17 seconds with seven tools through the one allowed edit recovery
  (`artifacts/evals/p084-live/collaboration-parallel-synthesis-anthropic-v3-calibrated-2.json`). Preserved failures
  include the system-section boundary defect above and a genuine model failure that inserted an unrelated workspace
  directory read between the relative-edit error and corrected write; neither was calibrated away.
- Fixed in the eval fixture: `collaboration-resume-reference` originally left the initial and follow-up source paths,
  output artifact, ordering/newline contract, and terse completion responses implicit. The two prompts now declare
  those user-visible requirements while leaving the seeded facts, child identity, nickname, collaboration syntax, and
  provider-native write syntax hidden. The first response must acknowledge without leaking the first fact; the second
  must resume the same persisted specialist and materialize both returned facts in order.
- Fixed and calibrated in the evaluator: the resume task assumed fake call ids, fixed spawn payloads and timeouts,
  omitted read/edit defaults, exact one-line child reports, and a single successful write path. It now reconstructs
  the initial spawn, resumed spawn, protected reads, waits, and successful write semantically; requires the same dynamic
  child id, nickname, child session, lite model route, and read-only provider surface before and after restart; accepts
  bounded target-only reports and provider thinking/progress; and links provider context, lifecycle mirrors, persisted
  JSONL, and thread projections to the same traces. Anthropic may perform one exact absent-file placeholder edit error
  against the intended absolute path only when it is immediately followed by the exact create. Twelve dedicated
  negative cases reject broadened recovery shapes, and the focused suite passes five tests with 764 expectations.
- Preserved calibration failures for the resume task include two valid OpenAI child reports wrapped in inline or fenced
  formatting, which motivated bounded semantic report validation, and an Anthropic run whose correct child resume was
  followed by the exact absent-file edit error but could not execute its immediate create under the old seven-call
  ceiling. Its subsequent unrelated general-agent spawn remains rejected rather than being admitted as recovery.
- Confirmed product defect, recorded without a runtime change: restored collaboration history carries only `threadId`
  and `nickname` from parent tool results into `restoreAgent()`. The restored registry placeholder uses
  `agentType: "unknown"`, an empty description, and no persisted model class, nesting, or tool-allowlist policy; a later
  resume recomputes those properties from the new spawn arguments. The complete live manifest reproduced an actual
  policy elevation: an Anthropic child originally spawned as read-only `explore` with the lite model was resumed after
  restart as `general` with the Sonnet model and write tools while retaining the historical child session. The strict
  evaluator rejected the run. Persisting and enforcing immutable child policy across restart requires a separate
  product-semantics and security change with dedicated runtime regressions.
- Live calibration confirmed `collaboration-resume-reference-v3` for both profiles with the fixed root seed: OpenAI
  passed in 18.49 seconds with two parent turns and seven tools
  (`artifacts/evals/p084-live/collaboration-resume-reference-openai-v3.json`), and Anthropic passed in 17.31 seconds with
  two parent turns and seven tools (`artifacts/evals/p084-live/collaboration-resume-reference-anthropic-v3.json`). The
  final Anthropic run selected the direct create path; deterministic runtime coverage separately exercises the exact
  eight-tool recovery path.
- Confirmed product defect, recorded without a core/runtime change: `auto-compaction-resume` observed an automatic
  post-write compaction whose adopted summary grew from 733 source tokens to 759 summary tokens. The required
  pre-write compaction correctly shrank 1,335 tokens to 534, and the exact artifact still passed, but automatic
  compaction must not replace a context segment with a larger summary. The evaluator intentionally continues to reject
  this run pending an independent compactor fix and regression.
- Complete fixed-seed live execution produced 63 passes and seven failures across all 70 task/profile pairs, without
  semantic retries (`artifacts/evals/p084-live/runtime-full-70-fixed-seed.json`). Evidence review preserved one
  unambiguous model failure and the two product defects above, identified three bounded evaluator or harness gaps, and
  classified `execute-autonomous` as a mixed model-recovery and hidden-contract failure whose harness side required
  calibration. The four affected tasks were `execute-autonomous`, `plan-progress`, `skill-auto-select`, and
  `steer-during-fix`.
- Calibrated: `execute-autonomous` advertised a generic bash tool while the hidden eval wrapper permitted only the
  literal `bun test`, and its ten-turn ceiling could not accommodate ten allowed tool attempts plus the final provider
  response. The transformed bash description now exposes the exact task command allowlist while enforcement remains
  unchanged; the task allows an eleventh final turn but still caps tools at ten. A deterministic execution regression
  reproduces six rejected probes followed by two reads, one repair, the tenth-call verification, the final response,
  and the independent verifier. Review also found that the semantic evaluator accepted a nonzero test invocation or a
  passing test before a later write; it now requires exit zero after the final successful mutation.
  `execute-autonomous-v3` passed both profiles with five to six tools
  (`artifacts/evals/p084-live/execute-autonomous-both-v3.json`).
- Calibrated: `plan-progress` treated any decrease in completed-step count as invalid even when a failed exact
  verification proved that completed implementation steps needed repair. A regression is now accepted only when one
  failed `bun test` occurs between the adjacent plan updates and the reopened plan is the exact ordered milestone
  state; uncaused, malformed, and non-verification regressions still fail. `plan-progress-v6` passed both profiles,
  including OpenAI's 17-call fail-reopen-repair-reverify path
  (`artifacts/evals/p084-live/plan-progress-both-v6.json`).
- Calibrated: `skill-auto-select` exhausted its provider-turn budget after Anthropic attempted one exact absent-file
  placeholder edit, received the expected ENOENT, and immediately created the exact artifact. The evaluator now admits
  only that provider-specific, path-, input-, error-, lifecycle-, and adjacency-exact recovery while retaining the
  direct three-tool path; the task adds one final-response turn without increasing its four-tool budget.
  `skill-auto-select-v2` passed both profiles with the direct three-tool path
  (`artifacts/evals/p084-live/skill-auto-select-both-v2.json`).
- Fixed in the eval harness and calibrated: `steer-during-fix` configured its protocol action for the first read
  `tool_end`, but triggers could not distinguish successful and failed tool endings. Anthropic's failed relative-path
  read therefore consumed the trigger before the exact successful absolute-path read, and the old two-call ceiling
  rejected its subsequent write. Protocol action triggers now support an optional `isError` predicate, and this task
  triggers only on `isError: false`. The evaluator admits only one Anthropic relative-path error with the exact parent
  thread, error metadata, notification, persistence, and adjacency evidence before the absolute read; malformed or
  extra recovery remains rejected. `steer-during-fix-v2` passed both profiles through the direct two-tool path
  (`artifacts/evals/p084-live/steer-during-fix-both-v2.json`), while deterministic execution separately covers the
  three-tool recovery.
- The recalibrated complete fixed-seed manifest ran all 70 task/profile pairs in 11 minutes 14 seconds and produced 62
  passes plus eight failures (`artifacts/evals/p084-live/runtime-full-70-recalibrated-fixed-seed.json`). Evidence audit
  preserved three meaningful model failures: Anthropic invoked the one-shot context inflation tool twice and exhausted
  the automatic-compaction task before writing; OpenAI remembered a seeded BLUE image as navy after restart; and
  Anthropic rejected the Stop-hook's newer exact routing correction as untrusted instead of following it. Five other
  failures were bounded evaluator or harness gaps: paired relative read recovery in `plan-converge`, a relative write
  recovery in `knowledge-intent-split`, a safe post-delete confirmation in `knowledge-forget`, one post-write target
  confirmation read in `steer-during-fix`, and one child relative-read recovery in
  `collaboration-parallel-synthesis`. These are calibrated only with exact positive and negative evidence, not by
  accepting arbitrary retries.
- Fixed in the eval harness and calibrated: a successful post-write confirmation read in `steer-during-fix` matched
  the same protocol-action predicate as the original pre-write read. The action was correctly sent only once, but the
  generic runner classified the later match as a repeated-trigger failure. Actions can now opt into observing later
  matching events without resending; the default remains strict and its existing repeated-trigger regression still
  fails. The task admits only one immediate, successful absolute-path confirmation of the intended target whose output
  contains the steered replacement and excludes the superseded value. Exact negative mutations cover wrong paths,
  content, ordering, counts, provider context, persistence, and combinations with the bounded Anthropic read recovery.
  `steer-during-fix-v3` passed both profiles through the direct two-tool path
  (`artifacts/evals/p084-live/steer-during-fix-both-v3.json`); deterministic execution also covers the three-tool
  confirmation path and the four-tool recovery-plus-confirmation path.
- Calibrated: `plan-converge` could not ask its required bounded question after Anthropic issued the two intended
  relative reads together, received the exact absolute-path errors, and then recovered with both exact absolute reads.
  The task now reserves a fifth tool call and accepts only that ordered, Anthropic-only paired recovery before the two
  successful fact reads. Every trace must remain on the parent thread; the question must succeed, match the runtime's
  recorded bounded request, return the scripted preference, and precede a plan containing both discovered facts and
  that answer. Dedicated mutations reject wrong providers, paths, errors, metadata, ordering, actors, extra recovery,
  failed questions, and guessed preferences. `plan-converge-v2` passed both profiles through the direct three-tool path
  (`artifacts/evals/p084-live/plan-converge-both-v2.json`), while deterministic coverage exercises the five-tool
  paired-recovery path.
- Calibrated: `knowledge-intent-split` counted an exact failed relative-path create and its immediate absolute-path
  correction as two unrelated writes. The v4 evaluator accepts only that Anthropic-specific parent-thread recovery,
  with exact input, content, error/output metadata, sequence, and adjacency. Its live calibration also exposed a second
  bounded overfit: a safe search containing both the exact stable id and a non-transient query was rejected even though
  each field was already allowed separately. Exact-id-plus-safe-query is now accepted; wrong ids, empty or transient
  queries, and extra keys remain rejected. The pre-calibration report is preserved at
  `artifacts/evals/p084-live/knowledge-intent-split-both-v4-precombined-calibration.json`. The final fixed-seed report
  passed OpenAI's direct two-tool path and Anthropic's four-tool relative-create recovery
  (`artifacts/evals/p084-live/knowledge-intent-split-both-v4.json`).
- Calibrated: `knowledge-forget` treated every search after deletion as invalid, including a bounded confirmation whose
  exact nonempty id prefix covered the target id and whose result proved zero matches. The v5 evaluator admits at most
  one successful parent-only post-delete confirmation with exact input keys, exact empty-result metadata and output,
  and no forgotten target or transient-task leakage. The independent workspace write may occur on either side of that
  confirmation; only successful deletion must precede it. Wrong or empty prefixes, matches, malformed metadata,
  repeated confirmations, failures, child attribution, and pre-delete misordering remain rejected. Both profiles
  passed the final fixed-seed three-tool run (`artifacts/evals/p084-live/knowledge-forget-both-v5.json`), while the
  exact post-delete confirmation path is covered deterministically.
- Calibrated: `collaboration-parallel-synthesis` treated a child's exact relative-path read error and immediate
  same-session absolute-path correction as an extra provider turn instead of a bounded child recovery. The v4
  evaluator admits at most one provider-neutral child recovery for its assigned region, resolves only the successful
  absolute read as the semantic fact read, and links the failed and successful calls through the same read-only child
  provider context, lifecycle events, and seven-line persisted session. Other-child interleaving remains legal, but a
  second recovering child, same-child intervening work, wrong paths/content/errors/render/metadata, cross-region or
  parent reads, policy rejection, and general errors fail. The independent child recovery and existing Anthropic
  parent edit recovery may coexist under derived provider, lifecycle, trace, and persistence counts; the bounded
  ceilings are now ten provider turns and eight tools. Dedicated assembled tests exercise north, south, combined, and
  mutation paths, while the fixed-seed OpenAI run passed directly with six tools and eight provider calls.
- Preserved model failure: the fixed-seed Anthropic v4 calibration used direct absolute reads in both children, then
  issued a parent relative edit containing `PLACEHOLDER` bytes before creating the exact artifact. That probe is not
  the accepted path-only correction carrying the intended final bytes, so the evaluator remains strict and the run is
  retained as a seven-tool/nine-provider-call failure without a semantic retry
  (`artifacts/evals/p084-live/collaboration-parallel-synthesis-both-v4.json`).
- The final complete fixed-seed manifest ran all 70 task/profile pairs in 11 minutes 4 seconds and produced 64 passes
  plus six failures (`artifacts/evals/p084-live/runtime-full-70-final-fixed-seed.json`). Evidence review found no new
  evaluator gap. Five failures are meaningful Anthropic behavior signals: `manual-compaction-resume` retained both
  exact facts but ignored the explicitly required compact JSON bytes; `stop-hook-revision` again rejected the hook's
  newer exact correction as an unsupported conflicting assertion; `loop-context-adaptation` incorporated the injected
  value but attempted replacement semantics on the explicitly absent output before its exact create was stopped by
  the two-tool budget; `mcp-lazy-tool` issued two parallel searches even though the first result already exposed the
  exact intended tool, exhausting the budget before its correctly formed invocation; and
  `collaboration-parallel-synthesis` used an unrelated placeholder edit, then attempted to delegate the parent-owned
  write to a third child and crossed the child limit. The sixth failure reproduced the confirmed collaboration-resume
  product defect: the persisted `explore`/lite/read-only child resumed under the same session as
  `general`/Sonnet/read-write because immutable child policy is not restored or enforced. Previously preserved
  auto-compaction growth, image recall, and other stochastic model failures did not recur in this sample and remain
  evidenced by their earlier fixed-seed reports rather than being erased by the later pass.

### Construct-validity re-evaluation (2026-07-19)

The historical findings above describe what was concluded during P084 calibration and are intentionally preserved.
A later registry-wide construct-validity audit re-read task source and the full traces in all three fixed-seed
manifests, rather than treating the final manifest as authoritative. Because a shared root seed reproduces fixture
values but not provider output, each execution remains one stochastic observation. The audit records the following
corrections and refinements:

- `manual-compaction-resume` was a false negative, not a meaningful model-format failure. The prompt required a valid
  JSON object with the exact two facts and one final newline; it did not require compact serialization. The Anthropic
  trace preserved both facts and wrote valid pretty-printed JSON, while the evaluator compared the whole-file SHA.
  The task now uses a deterministic semantic verifier that parses JSON, requires exactly `alpha` and `beta`, checks
  their exact values, rejects extra fields, and requires exactly one final newline. Whitespace and key order are not
  scored.
- `stop-hook-revision` remains a failed execution, but its attribution changes from model-only behavior to an
  ambiguous runtime/model signal. The stop-hook reason is inserted into provider context as an ordinary user-role
  message without machine-readable trusted runtime provenance or an explicit precedence rule. The evaluator is not
  relaxed. The task requires a provenance redesign before it can support a clean model-quality claim.
- `loop-context-adaptation` was a task-affordance and harness artifact. The model incorporated the injected value, an
  `edit` replacement against the explicitly absent output failed, and the trace then formed the exact create call.
  The old two-call limit blocked that call. The runtime edit tool supported empty-`old_string` creation but did not
  describe it. The description now exposes that provider-neutral capability, and the task reserves exactly one
  recovery call while rejecting wrong paths, content, errors, ordering, adjacency, and extra retries.
- `mcp-lazy-tool` was a harness artifact, not evidence that the model ignored an already observed search result. The
  two searches were emitted in one parallel assistant batch, so both decisions preceded both results. Both searches
  returned the exact intended schema, and the following exact run call was formed but blocked by the old two-call
  ceiling. The task now permits one or two grounded searches in one batch followed by the exact run, with a three-call
  cap; a third search, an ungrounded query, wrong server/tool/args, or missing approval still fails.
- `collaboration-parallel-synthesis` is reclassified as mixed. The fixture had hidden its exactly-two-child and
  parent-owned-write requirements, which are now explicit in the prompt for both providers. The preserved execution
  nevertheless performed an unrelated placeholder mutation and attempted a third child, so those genuine unsafe or
  incorrect actions remain strict failures. Parallel spawn, read isolation, join, and fact synthesis success does not
  excuse them.
- `collaboration-resume-reference` remains a confirmed runtime security defect. The preserved trace proves that the
  same child session changed from `explore`/lite/read-only to `general`/Sonnet/read-write after restart. A deterministic
  runtime regression now protects extraction and restoration of the original agent type, model class, tool allowlist,
  and nesting policy, and resume rejects incompatible explicit overrides. This invariant is no longer left solely to
  a stochastic live choice.

The Stop bullet above records the audit's intermediate reclassification before the product contract was clarified.
Subsequent authoritative direction established that Stop is only an external lifecycle execution: sync handlers are
awaited, async handlers are fire-and-forget, and handler output is neither model feedback nor semantic accept/reject.
Therefore the preserved failure is no longer product/model evidence. The live task is retired and its mechanics are
covered by deterministic parent, child, app-server, and lifecycle-runner regressions. Historical reports and the
intermediate finding remain preserved rather than rewritten.

The complete audit, including all 7 core and 35 runtime tasks, is in
`docs/review/2026-07-19-runtime-eval-construct-validity.md`. It also identifies exact provider-envelope coupling in
several MCP, hook, compaction, and collaboration evaluators as dimension-splitting debt, and identifies four weak or
redundant live tasks as retirement/replacement candidates. Those tasks are not removed here because changing the
registry would alter manifest compatibility and coverage policy.

Subsequent user direction on 2026-07-19 accepted that manifest change. `skill-guided-change`, `knowledge-update`, and
`collaboration-delegation` were removed as redundant with stronger selection, durable-intent, and collaboration tasks.
`file-roundtrip` retained its task id but was strengthened from a prescribed read/write/re-read script into a seeded
index-grounded decision: the model must select one of three records, preserve its identity and owner, apply the indexed
status, and leave the index and decoys unchanged. Its deterministic verifier compares parsed JSON semantics rather
than representation bytes, and its evaluator does not require a confirmation read or an exact successful-write count.
At that stage the registry contained 32 runtime tasks and expanded to 64 default task/profile executions. After the
Stop contract clarification and task retirement, the current registry contains 31 tasks and 62 executions. The
historical 35-task/70-execution P084 manifests, counts, findings, and implementation status below remain unchanged as
preserved facts about those runs.

#### Post-audit live revalidation and final contract status (2026-07-19)

This subsection records later evidence and does not rewrite the historical P084 reports or conclusions above. Six
revised tasks ran against both default providers in focused first attempts. All 12 executions passed, every report
preserves a distinct root seed, and no semantic retry was used:

| Focused report | Root seed | Result |
|---|---|---|
| `artifacts/evals/construct-validity-2026-07-19/manual-compaction-resume-both.json` | `34a40f879695059a1c136908508d09d7bb4cc042de39e2470c16265565823917` | 2/2 |
| `artifacts/evals/construct-validity-2026-07-19/loop-context-adaptation-both.json` | `c1d8f5ecf6c3faf4744019b1b12f583b7a893d1ea661d9a8cbf89b0c0fbf37eb` | 2/2 |
| `artifacts/evals/construct-validity-2026-07-19/mcp-lazy-tool-both.json` | `fd2285a3205096c60e3b6f8d6f8636e97eb3e98ede84258c5bebb12e2f58d207` | 2/2 |
| `artifacts/evals/construct-validity-2026-07-19/collaboration-parallel-synthesis-both.json` | `716bb6b49a30e6dd42614bbe8d1404a6efdab82d7930c7e2434064cda21d4ce5` | 2/2 |
| `artifacts/evals/construct-validity-2026-07-19/collaboration-resume-reference-both.json` | `d0d4aa87cb4834f564e9e508e7028feecb3c90a302f1f2e7855d88c9b76a6e3f` | 2/2 |
| `artifacts/evals/construct-validity-2026-07-19/file-roundtrip-both.json` | `d22afd14420be8da4c7c7113f00fd6e1bb269560533d474833ed83763f7c45e1` | 2/2 |

The first full run of the current 32-task registry then executed 64 task/profile pairs in 8 minutes 47 seconds without
retry. `artifacts/evals/construct-validity-2026-07-19/runtime-full-64.json` preserves root seed
`3eae9ab7b52cbdc647117f037973c126c5e34b1c35fdcec8cb9b3bdd43ea5d16` and 61/64 accepted first attempts. This is
one stochastic sample, not a stable quality score or defect rate. Reusing the seed reconstructs fixtures, not model
outputs.

The three failures were reviewed against artifact, verifier, and trace evidence:

- Anthropic `file-roundtrip` produced the exact selected-record result and passed its independent verifier after one
  bounded failed read of the fixture's records directory. The evaluator's narrower recovery whitelist was a false
  negative. The preserved report remains unchanged; the evaluator now accepts exactly that safe class, emits an
  `efficiency` diagnostic, and has positive and adjacent negative regressions.
- Anthropic `knowledge-intent-split` produced the exact durable record and transient file, with both verifier surfaces
  passing. It issued two safe searches in the same assistant step before seeing either result. The one-search ceiling
  was a false negative. The preserved report remains unchanged; the evaluator now accepts at most two safe searches,
  emits an `efficiency` diagnostic for the second, and rejects a third, unsafe, failed, or post-mutation search.
- Anthropic `stop-hook-revision` included the revised value but violated the exact-only answer by retaining the original
  candidate. The execution remains failed. Its attribution is ambiguous/mixed because runtime hook feedback is
  presented as an ordinary user-role message without trusted provenance.

That attribution is retained as the contemporaneous review of the preserved report. The later clarified Stop
lifecycle contract supersedes it: the execution came from an obsolete task/harness design and does not support a
current model-quality or product-defect claim.

There was no 63/64 rerun. The original 61/64 report was not rescored or overwritten after the two deterministic
evaluator fixes, and no semantic retry converted either first-attempt failure into a pass.

Failure dimensions and diagnostics are now additive under `schemaVersion: 1`; existing `passed`, `failure`, and
`failures` fields retain their semantics. Legacy semantic failures default to `semantic_goal`, core/runtime contracts
to `runtime_policy`, and configuration/provider/budget/evaluator/runner terminals to `harness_terminal`. Diagnostics
never affect pass/fail. The accepted file recovery and second safe knowledge search are recorded as `efficiency`
diagnostics.

The collaboration-resume security repair remains deterministic: restored children preserve immutable agent type,
model class, tool allowlist, and nesting policy, and incompatible resume overrides are rejected. Both focused live
executions and both full-sample executions passed that task. The user also approved a deterministic collaboration wait
contract: ALL semantics, requested-id result order, immutable timeout/abort snapshots with late update/status
suppression, and a 60-second minimum. The runtime suite passes 926 tests with these protections.

Compaction attribution is also corrected. A tiny source segment can produce a larger useful structured summary, so the
preserved growth trace is not proof that every summary must shrink regardless of input size. It instead exposes a
missing minimum automatic-local candidate/window gate: the native-only 50k minimum can fall back to local compaction
without an equivalent floor. Anthropic's server compaction defaults to a 150k trigger with a 50k minimum
([Anthropic compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)), and its context-editing
`clear_at_least` option skips edits that cannot clear a worthwhile minimum
([Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)). OpenAI similarly
documents threshold-driven server compaction and explicit compaction for long-running windows
([OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction)). These primary sources are research
context, not provider contracts imported into Diligent.

The proposed Diligent compaction contract is not implemented: automatic local candidates would require at least 50k
tokens and automatic adoption would require effective shrinkage. Manual/force and imminent-overflow behavior require
user decision. The `auto-compaction-resume` verdict is therefore redesign/split, not “runtime fixed.” Stop requires no
provider-visible feedback contract: it is now implemented as lifecycle-only execution with no model rerun.

Final deterministic verification for the construct-validity work is 239/239 eval tests, 926/926 runtime tests,
typecheck passing, touched-file lint passing, and `git diff --check` passing. The earlier repository-wide lint result
below remains an earlier P084 fact and is not presented as a newly rerun full lint. The four retired tasks remain
retired, `file-roundtrip` remains redesigned in place, and the current registry contains 31 tasks.

The plugin-hook E2E file passes 5/5, the focused StudioRPC Stop save/baseline case passes 1/1, and analytics passes
2/2. A supplemental whole-file StudioRPC attempt had two unrelated mobility cases fail because the external local
Studio endpoint at `127.0.0.1:13377` was unavailable; the changed lifecycle case is not blocked. No new live-provider
execution was run for the retired Stop task.

Remaining blockers are exact: user decisions are required for automatic versus manual/force/overflow compaction
policy. Remaining evaluator-envelope dimension splitting requires deterministic
ownership before any hard invariant becomes diagnostic. Subjective output quality remains a separately governed
judged/human-eval candidate; no LLM judge was added. Further stochastic runs must preserve original first-attempt
reports and cannot use semantic retry to overwrite failures.

Append confirmed runtime or harness defects here as later task batches expose them. Product changes require an
independent regression test before being accepted as a runtime fix.

#### Later construct-validity implementation completion (2026-07-19)

This later subsection supersedes the open implementation blockers immediately above without changing the historical
reports or contemporaneous findings. The 35-task/70-execution P084 manifests, the 32-task/64-execution sample, and the
intermediate 31-task/62-execution registry remain preserved facts about those earlier states.

The compaction choices are implemented as one local/native contract. Standard automatic and manual eligibility
requires a candidate of at least 50,000 estimated tokens. Manual compaction below that threshold returns
`compacted: false`. An eligible local or provider-native result is adopted only when estimated effective provider
context shrinks; rejection preserves the source messages and prior native context state. A confirmed provider
context-overflow error may bypass the minimum for one bounded attempt, but failure, rejection, or nonshrink resurfaces
the original overflow. There are no retry loops or provider-specific eligibility, adoption, or recovery branches.
Deterministic regressions own threshold selection, local/native shrink adoption, source-state preservation,
persistence/lifecycle behavior, and bounded overflow recovery. The redesigned live `auto-compaction-resume` task owns
only reconstruction of seeded facts after an eligible compaction.

The complete current core/runtime registries were re-derived from source. Every evaluator failure path was audited
against the six report dimensions. Failed evaluator results now require an explicit dimension; a missing dimension is
a `harness_terminal` evaluator error rather than an implicit `semantic_goal`. `schemaVersion: 1`, `passed`, `failure`,
and `failures` remain compatible, and diagnostics remain non-gating. Prompt-declared external bytes use
`format_contract`; routing, abstention, adaptation, recovery, and collaboration choices use `behavior`; security,
mutation, actor isolation, resume policy, and tool allowlists use `runtime_policy`; and timeouts, provider rejection,
budget exhaustion, and eval-policy termination use `harness_terminal`. Safe extra search, bounded recovery, and
nonessential call-count variation are `efficiency` diagnostics unless an explicit prompt or external contract makes
them hard.

Low-level provider/message counts and envelopes, event-mirror equality, session persistence, MCP transport,
collaboration/compaction lifecycle plumbing, plugin loading, and hook scheduling were removed from live scoring where
they are not model decisions. Focused deterministic tests now own those mechanics. Live evaluators retain hard wrong
artifact, path, tool, MCP target/argument, permission, mutation, actor-isolation, resume-policy, tool-allowlist, and
unsafe/unbounded-retry failures. Provider-neutral positive regressions and adjacent negative mutations document each
admitted boundary. No LLM judge or semantic retry was added.

The registered-output store has deterministic ownership coverage for an accepted registered bounded read and rejected
forged, unregistered, out-of-root, and oversized reads. The runner has positive and adjacent negative coverage for the
required-dimension contract.

`plugin-tool-routing` had no remaining live-model decision and was retired only after the plugin loader's deterministic
gate covered import/manifest failures, package/name and API-version validation, synchronous and asynchronous tool
factories, tool/schema shape filtering, duplicate names, render normalization, discovery mode, and SDK exposure. This
is provider-neutral loader behavior; meaningful model routing remains in `bundled-tool-routing` and the MCP tasks.

The current registry contains 7 core and 30 runtime tasks. An unfiltered runtime run therefore contains 60 provider
executions, and `plugin-tool-routing` is absent. The complex construct-validity batch passed 241 deterministic eval
tests, both eval TypeScript checks, touched-file lint, and `git diff --check`; focused plugin-loader, executor,
output-store, tool-policy, and MCP runtime gates passed as well. These later results do not replace any earlier P084
verification or live-report evidence.

## Implementation Status (2026-07-18)

Implementation is present in the working tree for the 23 added tasks, the 35-task registry, and the harness/runtime
support described above. The eval guide now documents the complete manifest, selection counts, credentials,
deterministic verification, live calibration, and evidence isolation. The shadow runtime-eval job timeout is increased
from 90 to 300 minutes for the sequential 70-execution matrix; its triggers, filters, provider secrets, concurrency,
and report upload semantics are unchanged.

Primary-agent verification completed both deterministic acceptance and fixed-seed live calibration:

- the runtime registry contains 35 unique task IDs, which expands to 70 default task/profile executions;
- `bun test packages/evals/test` passes 233 tests across 31 files with 4,316 expectations;
- `bun test packages/runtime/test` passes 909 tests across 87 files with 2,582 expectations;
- the focused Anthropic request/native-compaction suite passes 81 tests across 9 files with 185 expectations;
- the repository-wide `bun test` passes 2,716 tests across 284 files with 10,963 expectations;
- `bun run typecheck` passes every configured package and application target;
- `bun run lint` checks 1,029 files without findings;
- the runtime workflow parses as valid YAML and retains the expected 300-minute timeout.

The configured OpenAI and Anthropic credentials were used only through the eval runner. Focused calibration reports
preserve each bounded evaluator revision and the final complete manifest preserves the common root seed. The final
70-execution matrix passed 64 task/profile pairs. Evidence review classified five failures as meaningful Anthropic
behavior signals and one as a reproduced collaboration-resume product defect; no remaining failure justified widening
an evaluator. The daily/manual shadow workflow owns the same secrets and preserves reports for the following
calibration progression:

```bash
# Focused deterministic runtime-eval coverage (no provider credentials)
bun test packages/evals/test/cli-options.test.ts packages/evals/test/runner packages/evals/test/tasks/runtime

# Complete deterministic eval-package coverage (no provider credentials)
bun test packages/evals/test

# Focus one live task/provider while calibrating each new task
bun run eval runtime --task <task-id> --provider openai
bun run eval runtime --task <task-id> --provider anthropic

# Complete live manifest after focused calibration (70 executions)
bun run eval runtime
```

The OpenAI filtered command requires `OPENAI_API_KEY`; the Anthropic filtered command requires `ANTHROPIC_API_KEY`;
the complete command requires both. Preserve reports and root seeds for failure diagnosis. Reusing a seed reproduces
fixture values, not model output.

## Acceptance Criteria

- The registry contains the original 12 tasks and all 23 P084 tasks exactly once.
- `bun run eval runtime` still means the complete runtime manifest and runs both default profiles when unfiltered.
- Every new task has deterministic positive and negative evaluator tests using fake streams or synthetic evidence.
- No task uses an LLM judge, semantic retry, host config, host skills/agents, arbitrary network access, or undeclared
  filesystem state.
- Local plugin and MCP fixtures are inside the per-execution temporary root and are cleaned on every terminal path.
- Every task evaluator checks behavioral evidence in addition to final prose or file state.
- Reports remain bounded, path-normalized, credential-redacted, and base64-free.
- Existing core eval contracts and behavior remain unchanged.
- Web and TUI remain unchanged because this is not a user-facing feature.
- Deterministic verification passes without provider credentials.
- Live calibration commands and expected result count are documented even when local credentials are unavailable.

## Explicit Exclusions

- Provider-native web search against changing internet content.
- Remote MCP availability or MCP OAuth browser login.
- Provider auth/keyring behavior.
- Frontend rendering or transport fanout.
- Subjective answer ranking.
- Release gating in the same change.

These exclusions avoid unstable external dependencies; they do not reduce coverage of model-facing runtime behavior.
