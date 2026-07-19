# Core and Runtime Live Eval Construct-Validity Audit

Date: 2026-07-19

## Scope and method

This audit began with every task exported by `CORE_EVAL_TASKS` and `RUNTIME_EVAL_TASKS`: 7 core tasks and 35 runtime
tasks. The inventory was derived from the registries rather than from a plan or a report manifest. After the audit,
four runtime tasks were retired at the user's direction; the current registry contains 31 runtime tasks.
The tables retain the retired rows so the initial inventory and removal rationale remain auditable. The audit compared
task prompts, tool descriptions, budgets, evaluators, deterministic tests, runtime policy enforcement, and all three
preserved 70-execution reports. Related focused P084 calibration reports were used to distinguish recurring behavior
from evaluator and harness artifacts. No preserved report was modified.

The root seed controls fixture values only. It does not make provider output deterministic. A failure appearing once,
or disappearing in a later report with the same root seed, is evidence about that execution and is not by itself a
stable defect rate or capability score.

References to the “current” 31-task registry in the original audit sections mean the post-audit state at that time.
The later implementation-closure section records the subsequent plugin-task retirement and present 30-task registry.

This review uses the following dimensions:

- `semantic_goal`: the user-visible result, checked by a deterministic oracle;
- `runtime_policy`: permission, mutation, persistence, model-class, agent-type, and tool-access invariants;
- `behavior`: model routing, abstention, adaptation, recovery, or collaboration choices;
- `format_contract`: bytes or syntax explicitly required by the prompt or an external interface;
- `efficiency`: bounded extra reads, searches, and recoveries, reported separately unless they violate a declared cap;
- `harness_terminal`: timeout, budget exhaustion, provider failure, or eval-policy rejection, attributed before semantic
  evaluation.

The report contract now carries these dimensions additively while retaining `schemaVersion: 1` and the existing
top-level `passed`, `failure`, and `failures` semantics. Non-gating diagnostics are preserved on passing or failing
executions and omitted when empty. Several task evaluators still combine semantic, policy, behavioral, and
evidence-envelope checks; separating those remaining checks is follow-up design debt, not a reason to weaken them.

## Complete task audit

“Headroom” is measured against the shortest ordinary successful trace, not against the number of provider calls.
“None observed” means none in the preserved P084 reports reviewed here; it is not evidence of perfect reliability.

### Core registry

| Task id | Intended live-model decision | Deterministic oracle | Hard invariants | Incidental or soft invariants | Provider parity | Minimum successful trace | Current budget headroom | Observed preserved failures | Attribution | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| `direct-response` | Follow an explicit no-tool, exact-response instruction. | Exact nonce text. | No tool use; explicit response bytes. | Stream chunking and provider envelope. | Equivalent no-tool prompt and output contract. | One final response. | 1 turn, 0 tools; exact by design. | None in the reviewed runtime manifests; core is outside those 70 runs. | Evidence absent. | Keep. |
| `single-tool` | Select the lookup tool and carry its hidden receipt to the answer. | Exact record id, successful receipt, and final code. | Correct tool and id; no fabricated result. | Provider-call count and prose around a receipt. | Equivalent function schema and receipt. | One lookup, then final. | 1 tool; no recovery headroom, but the prompt requests one lookup. | No P084 runtime evidence. | Evidence absent. | Keep; separate efficiency from semantic result if diagnostics are added. |
| `tool-chain` | Use dependent outputs rather than inventing downstream tokens. | Exact get/quote/submit inputs, outputs, order, and final receipt. | Three causally dependent successful operations. | Provider-native call serialization. | Equivalent schemas and opaque values. | Three dependent calls, then final. | 3 tools; exact because all three are the task. | No P084 runtime evidence. | Evidence absent. | Keep. |
| `recover-tool-error` | Read a corrective revision from a recoverable error and retry safely. | First stale failure, exact corrected retry, final receipt. | Only the declared bounded recovery; correct record and revision. | Wording of the final acknowledgment. | Equivalent structured error result and retry affordance. | Failed update, corrected update, final. | 2 tools; exact because recovery is the construct. | No P084 runtime evidence. | Evidence absent. | Keep. |
| `structured-tool-args` | Preserve nested values and types in one call. | Deep normalized argument equality and exact receipt. | Correct selected tool, schema values, types, and no additions. | Provider-native JSON syntax. | Same semantic schema for both providers. | One submit, then final. | 1 tool; prompt explicitly says once. | No P084 runtime evidence. | Evidence absent. | Keep. |
| `parallel-tools` | Recognize three independent lookups and issue them in one batch. | Exact set of fragment ids, overlap before results, and final assembly. | Each fragment once; actual parallel decision; correct combined answer. | Order within the parallel batch and provider block layout. | Both providers receive the same three function affordances. | Three calls in one assistant batch, then final. | 3 tools; exact task cardinality. | No P084 runtime evidence. | Evidence absent. | Keep; preserve set-based rather than array-order checks. |
| `image-tool-result` | Inspect two returned images and map their order to colors. | Seeded image pixels plus exact explicitly requested answer. | One image-result call; both images classified in order. | Image transport envelope and non-tool blocks. | Both providers receive equivalent ordered image content. | One image tool, then final. | 1 tool; prompt explicitly says once. | No P084 runtime evidence. | Evidence absent. | Keep. |

### Runtime registry

| Task id | Intended live-model decision | Deterministic oracle | Hard invariants | Incidental or soft invariants | Provider parity | Minimum successful trace | Current budget headroom | Observed preserved failures | Attribution | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| `project-fix` | Diagnose, repair, and verify a seeded TypeScript defect. | Independent test command and bounded workspace diff. | Correct code behavior; allowed paths/commands; no undeclared mutation. | Exact read sequence, final prose, and additional safe inspection. | Equivalent read/write/execute surface. | Read, write, passing test. | 24 tools versus about 3; ample. | Focused runs passed both profiles. | No defect observed. | Keep. |
| `plan-readonly` | Diagnose without executing a mutation. | Expected diagnosis facts plus zero workspace/runtime mutation. | Read-only policy and correct root cause. | Search count, file order, explanatory style. | Equivalent read-only surface. | One or more reads, final diagnosis. | 12 tools; ample. | None observed. | No defect observed. | Keep. |
| `skill-guided-change` | Follow an explicitly named local skill and its referenced contract. | Exact artifact plus skill/reference receipt. | Skill boundary, declared reference, allowed mutation. | Exact skill/read count when repeated safe reads add no semantic value. | Equivalent skill and write affordances. | Skill load, reference read, write. | 10 tools versus 3; ample. | None observed. | No defect observed; construct overlaps `skill-auto-select`. | Removed after audit; selection and abstention remain covered by `skill-auto-select` and `skill-abstain`. |
| `session-resume` | Use earlier conversation state after restart to perform the requested mutation. | Exact artifact derived from pre-restart opaque fact; session identity. | Same persisted thread; no fact leakage or undeclared state change. | Exact persisted line count and provider envelope. | Equivalent resume context. | Initial fact turn, restart, one write turn. | 8 tools versus 1; ample. | None observed. | No defect observed. | Keep; move low-level JSONL projection checks to deterministic runtime tests. |
| `plan-to-execute` | Carry a correct diagnosis across a plan-to-default transition and implement it. | Independent tests and exact allowed diff. | Plan phase cannot mutate; default phase fixes the defect. | Exact number/order of exploratory reads. | Equivalent mode and tool surfaces. | Read in plan, transition, write/test. | 24 tools; ample. | Focused both-profile calibration passed. | No defect observed. | Keep. |
| `knowledge-recall` | Apply relevant injected durable knowledge without a lookup tool. | Exact file content from the seeded knowledge entry. | Correct knowledge value; allowed write only. | Exact provider prompt placement and write syntax. | Same knowledge section and write capability. | One write, final. | 6 tools; ample. | None observed. | No defect observed. | Keep behavior; move prompt-assembly mechanics to deterministic tests. |
| `knowledge-update` | Find the durable entry and update it rather than create transient state. | Stable id and exact updated durable record. | Only intended knowledge mutation; no workspace mutation. | Exact search phrasing and call count. | Equivalent knowledge tools. | Search then update. | 6 tools versus 2; ample. | None observed. | No defect observed; overlaps intent/forget tasks. | Removed after audit; durable update/delete boundaries remain covered by `knowledge-intent-split` and `knowledge-forget`. |
| `manual-compaction-resume` | Retain two facts through manual compaction and restart. | Parse `CONTEXT.json`; require exactly `alpha`/`beta`, exact values, no extra fields, and exactly one final newline. | Facts survive compaction/restart; valid declared artifact; bounded mutation. | JSON whitespace and key order. | Equivalent write affordances; semantic JSON is provider-neutral. | Pre-fact turn, compact/restart, one write. | 8 tools versus 1; ample. | Final manifest: Anthropic preserved both values but pretty-printed JSON. | Evaluator defect; clear false negative. | Harden; semantic verifier implemented with positive and adjacent negative regressions. |
| `clarify-then-execute` | Abstain from guessing one unavailable value, ask once, then act. | Exact bounded question receipt and exact resulting artifact. | At most one user-input request; no pre-answer mutation; correct value. | Question wording beyond the scripted meaning. | Same user-input and write capabilities. | Ask, receive answer, write. | 8 tools versus 2; ample. | None observed. | No defect observed. | Keep. |
| `read-image-pair` | Select both image paths and map each visible color. | Seeded pixels, exact two paths, and explicit exact answer format. | Both intended images; correct path-to-color mapping. | Order of independent reads and transport metadata. | Equivalent image-read results. | Two reads, final. | 4 tools versus 2; bounded headroom. | None observed. | No defect observed. | Keep. |
| `collaboration-delegation` | Delegate a protected read to one child and use the returned fact. | Child actor attribution, protected read ownership, wait receipt, and exact artifact. | Parent must not read protected file; one child; allowed write only. | Exact nickname, wait order, and transcript cardinality. | Equivalent child read and parent write affordances. | Spawn, child read, wait, parent write. | 8 tools versus 4; ample. | None observed. | No defect observed; capability overlaps newer collaboration tasks. | Removed after audit; custom routing, isolation, parallel join, and resume remain covered by the three stronger collaboration tasks. |
| `file-roundtrip` | Read a seeded index, select its active record among decoys, and apply the indexed pending status while preserving record identity. | Parse the selected JSON and require exactly `record`, `owner`, and `status`; exact seeded identity/status; unchanged index and decoys. | Index-grounded target; selected path only; correct semantic record; no undeclared mutation. | Optional safe decoy read, one bounded failed read within the records fixture, JSON representation, and post-write confirmation read. | Both providers receive the same read surface and semantically equivalent patch/edit affordance. | Index read, selected-record read, one write. | 5 tools versus 3; two calls for bounded recovery/search. | Focused v1 passed both profiles. In the first current-registry full run, Anthropic produced the correct artifact and passed the verifier after one failed records-directory read, but the evaluator rejected that safe recovery. | Evaluator defect / false negative, fixed after preserved-trace review. | Hardened in place as v1; accepted recovery emits an `efficiency` diagnostic, while wrong target/content, unsafe recovery, decoy mutation, and repeated failures remain negative regressions. |
| `instruction-hierarchy` | Combine root and nested instructions at a nested cwd. | Exact artifact derived from independently seeded instruction facts. | Correct precedence/scope; only declared mutation. | Which instruction files are reread and in what order. | Same assembled instructions and tools. | Read as needed, one write. | 3 tools; modest. | None observed. | No defect observed. | Keep. |
| `plan-converge` | Discover available facts, ask for the unavailable preference, and produce a final plan. | Plan contains both exact fixture facts and scripted answer; no mutation. | No guessing; one bounded question; correct facts. | Read order and a single bounded paired path recovery. | Both providers have equivalent reads/question; known relative-path recovery is explicitly bounded. | Two reads plus one question. | 5 tools versus 3; two-call recovery headroom. | Early focused `plan_facts`; recalibrated Anthropic paired relative-read failures exhausted the old budget; focused v2 passed. | Harness artifact, fixed earlier with exact negative mutations. | Keep. |
| `execute-autonomous` | Choose sufficient inspection, repair, and post-write verification without prompting. | Passing independent verifier and a passing declared test after the last mutation. | Correct repair; allowed command; no user input. | Failed safe command probes and extra reads are efficiency diagnostics. | Bash description exposes the same command allowlist to both providers. | Read, write, passing test. | 10 tools plus an 11th response turn; ample bounded recovery. | Initial manifest: Anthropic turn limit after safe probes; focused v3 passed. | Mixed hidden-contract/harness artifact, previously fixed. | Keep. |
| `plan-progress` | Maintain a coherent one-active-step plan while implementing a multi-file pipeline. | Independent pipeline tests, exact allowed files, and plan state-machine invariants. | Correct pipeline; no simultaneous active steps; completed plan at success. | Number of plan updates and a test-caused bounded reopen. | Same plan/write/execute tools. | Several plan updates, three writes, verification. | 24 tools; ample. | Initial OpenAI plan regression; focused v6 proved fail-reopen-repair path. | Earlier evaluator overfit, fixed; single run was ambiguous until trace review. | Split dimensions: keep semantic artifact and plan-policy hard, report plan efficiency diagnostically. |
| `hook-context-follow` | Follow a trusted prompt-boundary context fact. | Exact artifact from injected seeded value plus hook receipt. | Injection provenance and correct value; no raw leakage. | Exact provider message position and lifecycle counts. | Same trusted context and write affordance. | One write. | 2 tools; one spare. | Early focused Anthropic `tool_scope`; both profiles later passed. | No current defect observed. | Keep behavior; move hook plumbing mirrors to deterministic tests. |
| `skill-auto-select` | Select the unique relevant skill and only its declared reference. | Selected skill id, reference path, exact artifact, and no decoy reads. | Correct routing and isolation. | One exact absent-file create recovery is accepted only when adjacent and exact. | Equivalent skill/read/write capabilities; provider-native write recovery bounded. | Skill, reference read, write. | 4 tools versus 3; one recovery call. | Early focused OpenAI `wrong_write`; initial manifest Anthropic turn limit after exact create recovery; focused v2 passed. | Harness artifact, previously fixed. | Keep. |
| `skill-abstain` | Avoid irrelevant advertised skills for a fully specified direct edit. | Exact artifact, zero skill calls, no decoy access. | Abstention and allowed mutation. | Final prose and provider-call count. | Equivalent advertised decoys and write tools. | One write. | 2 tools; one spare. | Early focused OpenAI `wrong_write`; later focused runs passed. | Model behavior in the failed trace; no evaluator defect found. | Keep. |
| `knowledge-intent-split` | Persist only durable preference while completing transient workspace intent. | Exact knowledge record plus exact artifact and no transient leakage. | Durable/transient separation; declared mutations only. | Up to two safe result-independent searches and one exact create recovery. | Equivalent knowledge/write tools. | Search, update, write. | 5 tools versus 3; two calls for bounded search/recovery. | Earlier P084 trace-count failure was recalibrated. In the first current-registry full run, Anthropic passed both exact verifiers after two safe searches in the same assistant step, but the evaluator still required at most one. | Evaluator defect / false negative, fixed after preserved-trace review. | Keep; a second safe search emits an `efficiency` diagnostic, while a third, unsafe, failed, or post-mutation search remains strict. |
| `knowledge-forget` | Delete the durable fact while completing unrelated current work. | Target absent from knowledge, exact artifact, and no transient leakage. | Correct deletion and declared mutation. | One bounded empty confirmation search is efficiency evidence. | Equivalent knowledge/write tools. | Search, delete, write. | 4 tools versus 3; one confirmation. | Recalibrated OpenAI post-delete search failure; focused v5 passed. | Evaluator overfit, previously fixed. | Keep. |
| `steer-during-fix` | Replace an in-flight requirement after the target read. | Exact steered artifact; superseded value absent; trigger receipt. | Successful-read trigger, correct new value, one mutation. | One bounded read recovery or post-write confirmation. | Both providers receive the same steering point; relative-path recovery is bounded. | Read, steer, write. | 4 tools versus 2; two-call headroom. | Initial Anthropic and recalibrated OpenAI harness failures; focused v3 passed. | Harness repeated-trigger defect, previously fixed. | Keep. |
| `auto-compaction-resume` | Continue one outer turn after automatic compaction and reconstruct opaque facts. | Exact three-line artifact plus compaction source/adoption evidence. | Facts preserved; only an eligible automatic candidate may be adopted; no undeclared mutation. | Summary/source size for tiny candidates, exact provider summarizer envelope, and a second optional compaction. | Native/provider compaction paths should share eligibility and adoption guards; the current native-only 50k minimum can fall back to local compaction without an equivalent gate. | Inflate once, write once. | 2 tools; no spare because one-shot inflation is intentional. | A preserved small source segment produced a larger structured summary; another Anthropic sample repeated the one-shot inflation call. | Missing local-candidate/window eligibility is evidenced; growth on one tiny source is not proof that every summary must shrink regardless of input size. | Redesign/split. Proposed, not implemented: 50k automatic-local candidate minimum plus an adoption shrink guard. Manual/force and overflow behavior require user decision. |
| `image-resume-recall` | Recall a visually derived fact after restart without rereading. | Seeded image pixels, one pre-restart read, and exact post-restart answer. | Same session; no second read; correct color. | Sidecar layout and exact persistence cardinality. | Equivalent image evidence before restart. | Read image, restart, final answer. | 1 tool; exact because reread is disallowed. | Recalibrated OpenAI answered navy for BLUE; later sample passed. | Model behavior in one run; stochastic evidence insufficient for a rate. | Keep. |
| `stop-hook-revision` | None under the clarified product contract: Stop is an external turn-completion lifecycle event, not model feedback or semantic accept/reject. | Deterministic runtime tests for one provider lifecycle, parent/child parity, sync waiting, async detachment, and failure isolation. | No provider re-call, no injected message, no interpreted hook result. | Hook return shape and lifecycle handler ordering. | The contract is provider-independent because no provider sees Stop output. | One completed model turn followed by one lifecycle notification. | No live budget is applicable. | Historical Anthropic runs retained the original candidate after the runtime injected hook output as a user message. | Retired construct: the historical failure is evidence of the obsolete harness/task contract, not product or model quality. | Retire and replace mechanics with deterministic runtime tests. |
| `loop-context-adaptation` | Adapt a pending write after an internal loop-context requirement changes. | Exact artifact contains only injected value; hook/context/persistence receipts. | Injection after successful read; no stale value; only intended file. | One normal absent-file edit-mode recovery and provider envelope counts. | OpenAI patch and Anthropic edit now document equivalent create affordances. | Read then write. | 3 tools versus 2; one bounded recovery. | Early focused OpenAI call-limit and `final_answer` failures; final Anthropic formed the exact create but the old 2-call budget blocked it. | Tool-description/task defect plus harness artifact, not semantic failure. | Harden; description, budget, and exact recovery regressions implemented. |
| `large-output-recovery` | Recognize truncation and use the registered bounded full-output handle. | Exact hidden fact, truncation receipt, exact handle read, and final response. | No guessing; one retrieval and one bounded read; no leaked decoys. | Provider-call and output-file envelope details. | Same truncated result and registered read affordance. | Retrieve, read full output, final. | 2 tools; exact because recovery is the construct. | Early focused OpenAI `result_count` and `event_order`; v3 later passed both provider paths. | Earlier evaluator calibration; no current defect observed. | Keep behavior; move output-registration plumbing to deterministic tests. |
| `bundled-tool-routing` | Select one of two bundled tools and construct exact nested input. | Selected tool, normalized args, receipt, and no decoy call. | Correct routing and request transformation. | Provider schema bytes and exact one-call envelope. | Both providers get equivalent function schemas. | One call, final. | 1 tool; natural task requires one operation. | Early focused OpenAI `provider_progression`; later v2 runs passed. | Earlier evaluator overfit; no current defect observed. | Keep. |
| `plugin-tool-routing` | Select a fixture-plugin tool and construct exact nested input. | Plugin tool identity, normalized args, receipt, and isolated fixture state. | Correct routing; plugin loaded from fixture only; no decoy call. | Plugin assembly and provider schema envelope. | Same plugin tools for both providers. | One call, final. | 1 tool; natural task requires one operation. | Early focused `provider_progression` and `turn_transcript`; v3 passed. | Earlier evaluator overfit; current construct overlaps bundled routing. | Keep routing behavior; move plugin loading mechanics to deterministic tests. |
| `mcp-lazy-tool` | Discover the connected tool from natural intent and invoke it with exact normalized args. | Selected server/tool, schema-grounded search receipts, normalized request, approval, and exact receipt. | Intended tool only; correct args; approval; no decoy. | A second result-independent search in the same parallel batch and provider envelope counts. | Both providers receive the same lazy search/run proxies and pass condition. | Search, then run. | 3 tools versus 2; one bounded parallel search. | Early focused OpenAI/Anthropic `trace`; final Anthropic two-search batch formed the exact run but the old 2-call budget blocked it. | Harness artifact; parallel calls were chosen before either result existed. | Harden; accept exactly one or two grounded searches in one batch, reject a third/wrong query. |
| `mcp-resource-grounding` | Discover the relevant resource among decoys, read it, and ground an artifact. | Exact server/URI, normalized args, read receipt, and exact artifact verifier. | Correct resource and hidden fact; approval; isolated fixture and mutation. | Exact provider-call/lifecycle cardinality and list ordering. | Equivalent MCP list/read and provider-native write affordances. | List, read, write. | 3 tools; no spare. | Focused `trace`, `provider_progression`, `thread`, and `lifecycle` calibration failures; later v2 attempts passed; no full-manifest failure. | Earlier envelope overfit; zero recovery headroom remains a risk. | Split dimensions; keep behavior, move transport mirrors deterministic, monitor budget. |
| `mcp-prompt-grounding` | Discover and instantiate the relevant MCP prompt, then ground its hidden fact. | Exact server/prompt, normalized args, prompt receipt, and exact artifact. | Correct prompt and fact; approval; isolated mutation. | Exact provider/lifecycle cardinality and harmless progress blocks. | Equivalent list/get and write affordances. | List, get, write. | 4 tools versus 3; one spare. | Focused OpenAI/Anthropic `trace` and Anthropic turn-limit failures; later v2 attempts passed. | Mixed earlier behavior/budget and evaluator calibration; no current defect observed. | Split dimensions; keep behavior, move transport mirrors deterministic. |
| `custom-agent-routing` | Select the appropriate custom role to access a protected fact. | Agent type/model/tool surface, child-only read, wait receipt, and exact artifact. | Correct role; protected path isolation; parent-only write; one child. | Exact spawn payload defaults, report wrapping, and transcript counts. | Both providers receive equivalent custom roles and parent writes. | Spawn, child read, wait, parent write. | 5 tools versus 4; one bounded write recovery. | Focused tool/turn limits plus `provider_count`, `trace_contract`, and `persistence`; v8 passed both; invalid extra child/wrong newline remain rejected. | Earlier evaluator and provider-boundary defects fixed; no current full-manifest failure. | Split dimensions; keep routing/security hard, move envelope mechanics deterministic. |
| `collaboration-parallel-synthesis` | Recognize two independent regions, delegate concurrently, isolate reads, join, and synthesize. | Two child actors, causal overlap, region isolation, exact-set wait, and exact artifact. | Exactly two declared children; no cross/parent reads; correct ordered artifact; no undeclared mutation. | Provider-native write recovery, child completion order, report wrapping. | Children are read-only for both providers; parent has equivalent create affordance. | Two spawns, two child reads, wait, parent write. | 8 tools versus 6; two bounded recovery calls. | Recalibrated OpenAI child recovery was overfit; final Anthropic wrote placeholder then attempted a third child. | Earlier evaluator defect; final mixed hidden prompt contract plus genuine bad mutation/delegation. | Harden: prompt now declares two-child and parent-write ownership; keep placeholder/third-child failure strict. |
| `collaboration-resume-reference` | Resume the same persisted specialist and continue its scoped read assignment. | Same child id/session plus original agent type, model class, tool allowlist, nesting policy, exact reads, waits, and artifact. | Immutable child security policy; read isolation; same actor; allowed parent mutation. | Exact spawn defaults, provider envelope, and report wrapping. | Policy must be restored identically for both providers. | Spawn/read/wait, restart, resume/read/wait, parent write. | 8 tools versus 7; one bounded write recovery. | Initial OpenAI provider-message overfit; final Anthropic resumed explore/lite/read-only as general/Sonnet/read-write. | Confirmed runtime security/product defect, plus earlier evaluator overfit. | Split dimensions; deterministic security regression and runtime fix required and implemented in this batch. |

## Priority findings

### Security and product defects

1. `collaboration-resume-reference` exposed a real privilege-preservation defect. Historical restoration retained only a
   child thread id and nickname. Resume arguments could recompute agent type, model class, nesting, and allowed tools.
   The final preserved Anthropic trace demonstrated an `explore`/lite/read-only child becoming
   `general`/Sonnet/read-write under the same child session. This is a hard runtime-policy failure, not an evaluator
   condition to relax. The runtime fix restores the original spawn policy and rejects incompatible resume arguments;
   focused deterministic tests protect extraction and enforcement.

2. `auto-compaction-resume` preserves evidence that automatic local compaction considered a tiny source segment and
   adopted a larger structured summary. The user correctly noted that a useful structured summary can exceed a very
   small source; the trace therefore does not prove a universal “every summary must shrink” invariant. It does expose
   a missing minimum local-candidate/window gate: the native path has a 50k minimum, but a non-triggered native path can
   fall back to local compaction without the same floor. A 50k automatic-local minimum and an adoption shrink guard are
   proposed but not implemented. Manual/force and overflow behavior require an explicit product decision.

### False negatives and harness artifacts

1. `manual-compaction-resume` used whole-file SHA equality for a JSON semantic goal. Its prompt did not require compact
   serialization. Parsing the JSON and checking exact keys, values, extra-field exclusion, and one final newline
   removes the false negative without accepting a wrong adjacent artifact.

2. `loop-context-adaptation` advertised Anthropic `edit` without documenting its empty-`old_string` create mode and
   set `maxToolCalls` to the two-call shortest path. One exact failed replacement against an absent declared target,
   immediately followed by the exact create, is a bounded valid path. The new third-call ceiling is still a runaway
   cap, and mutations to path, content, error, order, adjacency, or count remain failures.

3. `mcp-lazy-tool` treated two searches emitted in one parallel assistant batch as if the second had been selected
   after observing the first result. Both decisions necessarily preceded both results. The task now reserves one call
   for that bounded provider-neutral path and accepts only one or two grounded searches followed by the exact run.

4. The first current-registry full run exposed two additional evaluator false negatives. `file-roundtrip` reached the
   exact selected-record state and passed its verifier after one bounded failed read of the fixture's records
   directory. `knowledge-intent-split` passed the exact durable-record and transient-file verifiers after two safe
   searches issued in the same assistant step. Both accepted paths are now covered by positive and adjacent negative
   tests and emit `efficiency` diagnostics rather than changing pass semantics.

5. Existing P084 fixes for `execute-autonomous`, `plan-converge`, `skill-auto-select`, `knowledge-intent-split`,
   `knowledge-forget`, `steer-during-fix`, and collaboration recovery were independently consistent with the same
   standard: each admitted path is bounded, contract-justified, provider-neutral where possible, positively reproduced,
   and guarded by adjacent negative mutations.

### Provider parity defects

1. `loop-context-adaptation` gave OpenAI an obvious file-create patch path while the Anthropic edit description omitted
   its supported create mode. The edit contract now states that mode explicitly.

2. `collaboration-parallel-synthesis` enforced exactly two specialists and a parent-owned write without stating those
   ownership constraints in the user prompt. The prompt now makes the two-child and parent-write contract explicit for
   both providers. It does not forgive the preserved placeholder mutation or third child.

3. No pass condition in the revised tasks depends on OpenAI tool-call JSON versus Anthropic content-block syntax.
   Focused assembled executions cover both default profiles; normalized tool traces and artifacts remain the oracle.

### Overfitted evaluators and dimension coupling

The report contract now adds the six audit dimensions to every failure without changing `schemaVersion: 1` or the
existing top-level pass/failure fields. Legacy task-semantic failures default to `semantic_goal`, core/runtime contract
failures to `runtime_policy`, and configuration/provider/budget/evaluator/runner terminals to `harness_terminal`.
Evaluators can select another dimension and can emit non-gating diagnostics on pass or failure. The MCP grounding and
collaboration evaluators still combine some exact provider-call counts, transcript cardinalities, lifecycle arrays,
and persistence projections with the user result. Those residual checks should be split only after deterministic
ownership exists; the additive report work does not silently make them diagnostic.

### Weak or redundant live tasks

The post-audit action is complete:

- `skill-guided-change`, `knowledge-update`, `collaboration-delegation`, and `stop-hook-revision` were removed from the registry and their
  implementations deleted. Their stronger neighboring tasks retain the live decisions and policy coverage identified
  above; Stop has no live-model decision to retain. The runtime suite is now 31 tasks and the unfiltered two-provider
  manifest is 62 executions.
- `file-roundtrip` retains its stable task id but no longer prescribes a read/write/re-read script. Its v1 fixture
  seed-selects one active record through an index and requires the model to discover the correct target and status
  among decoys. The deterministic verifier checks normalized JSON semantics and protected files. A confirmation read
  is optional; one bounded failed read inside the records fixture is accepted with an `efficiency` diagnostic. Wrong
  paths, content, mutations, unsafe recovery, and repeated failures remain strict.

## Revalidation of the six final-manifest hypotheses

| Task | Independent trace finding | Reclassification |
|---|---|---|
| `manual-compaction-resume` | Both exact values survived compaction and restart; only JSON serialization whitespace differed. | Evaluator defect / false negative. |
| `stop-hook-revision` | The preserved runtime appended hook output as a normal user-role message, but the clarified product contract says Stop output is never model feedback. | Retired task/harness mismatch; the prior mixed attribution is superseded and is not product/model quality evidence. |
| `loop-context-adaptation` | The injected value was used; an absent-file replacement failed; the next exact create was blocked at the old call ceiling. | Tool-description/task defect plus harness artifact. |
| `mcp-lazy-tool` | Two grounded searches were emitted together; both returned the exact schema; the next exact run was formed but blocked. | Harness artifact, not post-result redundant search behavior. |
| `collaboration-parallel-synthesis` | Parallel children, isolated reads, join, and synthesis facts succeeded; the parent then wrote unrelated placeholder bytes and attempted a third child. | Mixed hidden-contract defect and genuine model mutation/delegation failure. |
| `collaboration-resume-reference` | The same persisted child session changed from explore/lite/read-only to general/Sonnet/read-write. | Confirmed runtime security/product defect. |

## Live revalidation after deterministic changes

Focused revalidation ran six revised tasks against both default providers. All 12 first attempts passed, each report
used its own preserved root seed, and no semantic retry was used:

| Report | Task | Root seed | First attempts |
|---|---|---|---|
| `artifacts/evals/construct-validity-2026-07-19/manual-compaction-resume-both.json` | `manual-compaction-resume` | `34a40f879695059a1c136908508d09d7bb4cc042de39e2470c16265565823917` | 2/2 |
| `artifacts/evals/construct-validity-2026-07-19/loop-context-adaptation-both.json` | `loop-context-adaptation` | `c1d8f5ecf6c3faf4744019b1b12f583b7a893d1ea661d9a8cbf89b0c0fbf37eb` | 2/2 |
| `artifacts/evals/construct-validity-2026-07-19/mcp-lazy-tool-both.json` | `mcp-lazy-tool` | `fd2285a3205096c60e3b6f8d6f8636e97eb3e98ede84258c5bebb12e2f58d207` | 2/2 |
| `artifacts/evals/construct-validity-2026-07-19/collaboration-parallel-synthesis-both.json` | `collaboration-parallel-synthesis` | `716bb6b49a30e6dd42614bbe8d1404a6efdab82d7930c7e2434064cda21d4ce5` | 2/2 |
| `artifacts/evals/construct-validity-2026-07-19/collaboration-resume-reference-both.json` | `collaboration-resume-reference` | `d0d4aa87cb4834f564e9e508e7028feecb3c90a302f1f2e7855d88c9b76a6e3f` | 2/2 |
| `artifacts/evals/construct-validity-2026-07-19/file-roundtrip-both.json` | `file-roundtrip` | `d22afd14420be8da4c7c7113f00fd6e1bb269560533d474833ed83763f7c45e1` | 2/2 |

The first full current-registry run then executed 32 tasks against both providers: 64 first attempts in 8 minutes 47
seconds, with no semantic retry. `artifacts/evals/construct-validity-2026-07-19/runtime-full-64.json` preserves root
seed `3eae9ab7b52cbdc647117f037973c126c5e34b1c35fdcec8cb9b3bdd43ea5d16` and records 61/64 passes. This is one
stochastic sample of those model executions, not a stable capability score, defect rate, or prediction for another run.

The three failures require different attribution:

- Anthropic `file-roundtrip` selected the correct record, preserved its identity and owner, applied the exact indexed
  status, left the index and decoys unchanged, and passed the independent verifier and final semantic checks. It made
  one bounded failed read of the fixture's `records` directory, then recovered with the exact record path. The old
  recovery whitelist caused an evaluator false negative. The evaluator and positive/negative regressions are fixed;
  the accepted recovery now emits an `efficiency` diagnostic.
- Anthropic `knowledge-intent-split` produced the exact durable knowledge record, kept the transient value out of
  knowledge, created the exact transient file, and passed both independent verifier surfaces. Its two safe knowledge
  searches were selected in the same assistant step before either result was observed. The one-search ceiling caused
  an evaluator false negative. The evaluator and positive/negative regressions are fixed; the second safe search now
  emits an `efficiency` diagnostic.
- Anthropic `stop-hook-revision` received the revised value and included it in the second response, but also retained
  the original candidate, violating the explicit exact-only answer. The failure remains strict. Attribution remains
  ambiguous/mixed because the runtime presents the hook reason as an ordinary user-role message rather than trusted
  runtime validation provenance.

That last attribution records the conclusion at the time of the preserved 32-task run. Subsequent authoritative
contract clarification supersedes it: Stop is only an external lifecycle notification, and its return value must never
become provider input. The task is retired, and its preserved failure is not evidence of a current product defect or
model-quality failure. The report itself remains unchanged.

The original 61/64 report is preserved and was not rewritten after the two evaluator fixes. There was no “63/64
rerun”; inferring that label by rescoring or retrying would erase first-attempt evidence.

## Runtime contract follow-through

The immutable collaboration-resume policy fix remains protected deterministically: resumed children retain agent
type, model class, tool allowlist, and nesting policy, and incompatible overrides are rejected. Both focused provider
executions and both executions in the full current-registry sample passed `collaboration-resume-reference`; those live
passes supplement rather than replace the deterministic security regression.

The user also approved and the runtime now implements a deterministic collaboration wait contract. A wait has ALL
semantics, returns status entries in requested-id order, and snapshots its result at completion, timeout, or abort so
late child updates cannot mutate the returned status or emit late updates to the closed wait. The tool enforces a
60-second minimum timeout. The complete runtime suite passes 926 tests with these regressions.

The clarified Stop contract is now deterministic as well. `SessionManager` invokes Stop once after a normally
completed turn and never translates lifecycle output into a user message or provider re-call. Parent and child turns
use the same app-server lifecycle runner. `mode: "sync"` handlers are awaited, `mode: "async"` handlers detach, and
one handler's error or former `blocked` result cannot prevent later handlers. UserPromptSubmit retains its existing
blocking and additional-context behavior. Analytics remains async; StudioRPC save/baseline work remains sync.

## Compaction attribution correction and open contract

A tiny source segment can legitimately yield a larger structured continuity summary. The preserved
`auto-compaction-resume` evidence therefore does not prove that every summary must shrink regardless of candidate
size. It does show that the automatic local path lacks a minimum candidate/window eligibility gate: a native path
that does not meet its 50k minimum can fall back to local summarization of a much smaller segment.

This interpretation is consistent with primary provider guidance. Anthropic server-side compaction is threshold
driven, defaults to 150,000 input tokens, and requires a trigger of at least 50,000 tokens
([Anthropic compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)). Anthropic context editing
also exposes `clear_at_least` so an edit is skipped when it cannot clear a worthwhile minimum
([Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)). OpenAI likewise
documents threshold-triggered server compaction and explicit compaction for long-running windows
([OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction)). These sources are research context,
not a claim that Diligent must copy a provider-specific protocol.

The proposed Diligent contract is not implemented: require at least a 50k-token candidate for automatic local
compaction and refuse automatic adoption unless the resulting effective context shrinks. Whether manual/forced
compaction may adopt a nonshrinking but useful summary, and how imminent-overflow fallback should behave, require user
decision. The live task should be redesigned around the chosen eligibility/adoption policy; this audit does not claim
a runtime compaction fix.

## What remains strict

The changes do not accept wrong JSON values or extra fields, wrong file paths or content, missing required newlines,
wrong MCP server/tool/arguments/receipt, ungrounded or third searches, unrelated edit failures, non-adjacent or repeated
retries, policy rejection, extra collaboration children, cross-region reads, parent reads of protected sources,
placeholder mutations, agent-policy elevation, undeclared mutation, or unbounded retry. Subjective prose quality and
elegance remain outside this deterministic suite; they are candidates for a separately governed judged or human eval,
not for an LLM judge added here.

## Verification results

- Registry assertion: 7 unique core tasks, 31 unique current runtime tasks, and 62 default runtime task/profile
  executions. The four retired ids are absent.
- `bun test packages/evals/test`: 239 passed, 0 failed.
- `bun test packages/runtime/test`: 926 passed, 0 failed.
- `bun test packages/e2e/plugin-hooks.test.ts`: 5 passed, 0 failed.
- Focused StudioRPC Stop save/baseline test: 1 passed, 0 failed; analytics tests: 2 passed, 0 failed.
- `bun run typecheck`: passed for every configured package and application target.
- Touched-file lint: passed.
- `git diff --check`: passed.
- Focused live revalidation: 12/12 first attempts passed across six tasks and both providers, with distinct preserved
  root seeds and no semantic retry.
- First full current-registry live sample: 61/64 first attempts passed in 8 minutes 47 seconds, with one preserved root
  seed and no semantic retry.

A supplemental whole-file StudioRPC test attempt reached 15 passes but two unrelated mobility integration cases could
not connect to the external local Studio RPC endpoint at `127.0.0.1:13377`. The changed Stop save/baseline case passes
in isolation, so this environment dependency does not block the lifecycle contract. No new live-provider execution was
run for the retired task.

Focused assembled regressions exercise both default provider profiles for the revised MCP parallel-search path and the
new index-grounded `file-roundtrip` task. Existing assembled coverage exercises both direct provider write surfaces for
loop adaptation and parallel collaboration; the extra absent-file edit recovery is Anthropic-specific because only
that profile receives `edit`, whose newly documented create mode is semantically equivalent to OpenAI's patch create.
The collaboration resume policy regression is provider-independent runtime enforcement. Every admitted path has an
adjacent wrong-path, wrong-content, wrong-query, extra-call, arbitrary-error, or policy-escalation mutation as
appropriate.

The earlier P084 repository-wide lint result of 1,029 checked files remains a historical verification fact in the plan;
this final documentation pass reran touched-file lint rather than claiming a new repository-wide lint run. All live
counts above describe exact preserved executions. Root seeds reconstruct fixture values only and do not make model
output deterministic.

## Follow-up work and blockers

- Decide automatic local-compaction eligibility and adoption behavior. The proposed 50k candidate minimum and shrink
  guard are not implemented; manual/force and imminent-overflow behavior remain explicit product choices.
- Move low-level session, lifecycle, MCP transport, hook, compaction, plugin-loading, and collaboration persistence
  invariants into focused deterministic runtime tests before splitting the remaining combined evaluator booleans.
- Keep subjective explanation quality and elegance outside this deterministic suite; a judged/human-eval proposal
  needs separate governance and was not implemented.
- Treat the 61/64 full result only as a first-attempt trace sample. Additional runs may characterize variance, but must
  preserve each original report and must not use semantic retry to overwrite a failure.

## Later implementation closure (2026-07-19)

This section records implementation completed after the audit and the earlier verification sections above. It does
not rescore or rewrite any preserved execution. In particular, the 35-task/70-execution P084 manifests, the later
32-task/64-execution sample, and the intermediate 31-task/62-execution registry remain historical facts about their
respective points in time.

### Compaction contract implemented

The previously open product choices are now resolved in one provider-neutral contract:

- automatic and manual local/native compaction require a candidate of at least 50,000 estimated tokens
- manual compaction below the minimum returns `compacted: false` rather than forcing a summary
- local and native results are adopted only when estimated effective provider context shrinks
- rejecting an ineligible or nonshrinking result preserves both the source messages and provider-native context state
- a confirmed provider context overflow may bypass the minimum for one bounded attempt
- overflow recovery still requires shrinkage; a thrown, rejected, or nonshrinking result resurfaces the original
  context-overflow failure
- no retry loop or provider-specific eligibility, adoption, or recovery behavior was added

Focused deterministic tests cover eligible local and native adoption, below-threshold manual rejection,
nonshrinking local and native rejection with source-state preservation, and the one-attempt overflow success and
failure boundaries. The live `auto-compaction-resume` task now measures only reconstruction of seeded facts after an
eligible compaction; deterministic tests own triggering, lifecycle, adoption, persistence, and shrink mechanics.

### Dimension and live-decision audit completed

The registries were re-derived after retirement: the current suite contains 7 core tasks and 30 runtime tasks, or 60
runtime task/profile executions with both default providers. Every current task's evaluator failure paths were audited
and assigned to `semantic_goal`, `runtime_policy`, `behavior`, `format_contract`, `efficiency`, or
`harness_terminal`. A failed evaluator result must provide a dimension. There is no `semantic_goal` default; an
omission is an `evaluator_error` under `harness_terminal`.

The additive report shape still uses `schemaVersion: 1` and preserves `passed`, `failure`, and `failures`
compatibility. Diagnostics remain non-gating on passing and failing executions. Prompt-declared bytes and syntax use
`format_contract`; routing, abstention, adaptation, recovery, and collaboration choices use `behavior`; security,
actor isolation, mutation, resume policy, and tool allowlists use `runtime_policy`; and provider rejection, timeout,
budget, or eval-policy termination uses `harness_terminal`. Safe additional search, bounded recovery, and
nonessential call-count variation are `efficiency` diagnostics unless an explicit prompt or external contract makes
them hard requirements.

Live evaluators now stop at normalized model decisions and externally visible results. Exact provider-call and
message counts, provider-native envelopes, core/runtime/notification mirror equality, session persistence plumbing,
MCP transport resolution, collaboration and compaction lifecycle plumbing, plugin loading, and hook scheduling are
owned by focused deterministic tests when they are not model choices. Wrong artifacts, paths, tools, MCP targets or
arguments, permission broadening, undeclared mutation, actor-policy escalation, unsafe recovery, and unbounded retry
remain hard failures.

Provider-neutral positive regressions exercise accepted OpenAI and Anthropic normalized traces or synthetic
equivalents. Adjacent negative mutations retain wrong-target, wrong-path, wrong-content, cross-actor, extra-call,
unsafe-retry, and policy-broadening failures. No task uses an LLM judge.

### Deterministic ownership and plugin retirement

The eval output store now has a focused ownership regression: one registered bounded read is accepted, while forged
suffixes, unregistered same-root paths, out-of-root paths, and oversized reads are rejected before execution. Missing
evaluator dimensions have focused runner regressions in both core and runtime execution paths.

`plugin-tool-routing` was retired after confirming that it contained no remaining live-model decision. Deterministic
plugin-loader coverage owns import and manifest failures, package/name and API-version checks, synchronous and
asynchronous `createTools`, tool/schema shape filtering, duplicate names, render normalization, discovery mode, and
SDK exposure rules. Bundled-tool and MCP tasks retain meaningful live routing choices. Removing the plugin task is
provider-neutral because loader correctness is independent of OpenAI or Anthropic response behavior.

The current registry is therefore 30 runtime tasks and 60 default provider executions; `plugin-tool-routing` is
absent. The complex construct-validity batch passed 241 deterministic eval tests, both eval TypeScript checks, touched
file lint, and `git diff --check`. Focused plugin-loader, executor, output-store, tool-policy, and MCP runtime gates also
passed. These are later implementation results, not replacements for the earlier 239-test, 31/62, 32/64, or 35/70
historical evidence above.
