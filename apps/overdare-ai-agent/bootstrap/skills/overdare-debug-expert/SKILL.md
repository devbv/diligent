---
name: overdare-debug-expert
description: Genre-neutral OVERDARE debugging entry skill for defects whose cause is NOT yet narrowed. Do NOT use when the target is already pinpointed and the request is a direct single edit to an instance/property — position, size, color, alignment, text, visibility, and the like — handle those directly without this skill. Use it only for defects that are NOT such direct edits and that show at least one of these signals: the cause or next step is unclear; the same symptom recurs after a prior fix ("still", "again", "not fixed"); the symptom is intermittent or tied to a state transition (re-entry/restart/mode switch/network sync); or a runtime error or crash log is present.
---

# OVERDARE Debug Expert

This is a debugging entry skill that works regardless of genre (action/racing/puzzle/simulation, etc.).
This skill defines the **procedure only**. Concrete case examples and symptom-specific treatments are provided by the RAG case DB —
a collection of **cases resolved in past sessions** — and RAG results are used **only as diagnostic hints**. Because each past case was fixed under its own context, do not assume it transfers as-is; derive the final solution directly according to the procedure (§4).

---

## 1. MUST / MUST NOT

**MUST**
- **Off-ramp first:** if, with the request in hand, the target is already pinpointed and the fix is a direct single edit to an instance/property (position·size·color·alignment·text·visibility), make that edit directly — skip the format and RAG below — and stop. (The description gates first load; this bullet catches follow-up turns where the cause is already known.)
- Output the **first response format** (§2) before implementation/patching.
- Before making changes, **directly check logs (Play.log, etc.) or runtime state at least once**. (Do not say "logs are clean" before opening the file.)
- Choose the work area using the **Decision order** (§3), and include the step number in the classification rationale.
- Handle only **one goal · one work area** at a time.
- Apply changes only to the single most suspicious cause, then **verify through the reproduction path** after applying.
- At loop end, leave 1–3 lines describing what was verified.

**MUST NOT**
- Do not change code based only on guesses without checking logs/state.
- Do not change code/maps without classification, goal, and rationale.
- Do not copy a RAG-provided "solution case" directly into a patch (§5).
- Do not touch two or more work areas in the same loop.
- Do not report "fixed" without a reproduction path.
- If minimum input is insufficient, **ask instead of guessing**.

---

## 2. First Response Format (Required Before Implementation)

```text
Skill used: overdare-debug-expert
Work area: script | ui | 3d
Classification rationale: decision step N — (one-sentence condition)
Reproduction path: (when / where / what action)
Reference cases: {case ID — check priority} | none (reason)
Goal for this loop: (one sentence: what to reproduce or verify)
First checks: (1–3 logs/state items)
```

If minimum input is insufficient, ask first (symptom / reproduction method / recent changes / error message / impact). Do not guess.
**Before classification:** **open** `Play.log` (or equivalent). Do not skip this even for 3d/ui work.

---

## 3. Decision Order (Work Area Classification — Genre-Neutral, First Match from the Top Wins)

| Step | Condition (any one applies, regardless of genre) | Work area |
|------|--------------------------------|-----------|
| 1 | Fails **only after a state transition (re-entry/restart/switch)** | script |
| 1 | Input/trigger works, but **state/progress/transition does not change** | script |
| 1 | Starts normally, but **breaks after a specific point** | script |
| 1 | `Play.log` contains a **runtime error or sync mismatch** | script |
| 1 | Shows **register limit/large-script signs** (`Out of local registers`, etc.) | script |
| 2 | No progress for 20+ minutes **or** the same symptom was explained 3 times **or** one request has excessive areas/reproduction/logs (overload) | session (escalation) |
| 3 | World placement/layout/coordinates/collision/spawn issue is **always visible regardless of state transitions** | 3d |
| 4 | Only an **existing display (UI) element** is wrong, steps 1–3 do not apply, and it reproduces **only on the same screen** without transitions | ui |
| 5 | Unclassified | script |

Classification aid: **if there is an error log, script**; **if it is visible and only position/display is wrong, ui/3d**.
**Changing work area:** Change only when reproduction, logs, and state tracing have been completed in script and the remaining blocker is **exactly one** of ui/3d. If uncertain, stay in script. If the area changes, **reclassify** from the Decision order.

> Presentation layer (visibility·offset·text) is **ui**. Physics/coordinates such as anchor·collision·raycast are **3d**.

---

## 4. Loop Structure (One Goal · One Work Area · 20 Minutes)

1. **Declare the goal** — one single symptom to resolve in this loop.
2. **Fix the work area** — one §3 classification. Do not change it during the loop.
3. **Collect RAG hints** — query §5 → extract only the "how to check" items.
4. **Check logs/state** — directly inspect logs/state in the priority order suggested by RAG. Separate input → judgment → application, and record server authority and client display separately.
5. **Single hypothesis → single change → reproduction verification.** If it fails, roll back **only the last change**.
6. **Judge loop completion** (§4.2).

**Same failure twice rule:** If the same symptom repeats twice, do not keep tweaking only the same property. Return to the baseline (rollback) or narrow the reproduction scope further, and change **only one axis** per loop. If stuck, proceed in this order: scope reduction → single alternative → structural rework (separation/modularization). If there are 2+ consecutive creator requests without confirmation of resolution → switch to **§4.3 log-insertion diagnosis**.

If completion criteria are not met within 20 minutes, stop the loop, summarize observed facts, then start the next loop with a new hypothesis (consider session escalation from §3 step 2).

### 4.1 Stuck / Handoff

- If the same transition bug repeats 2+ times, or fixing one thing causes another to break in a chain → reduce scope or request session review.
- If it looks like a ui issue but only script work was done → recheck Decision step 4.
- If errors only move between large functions → follow the large-script (separation) procedure.
- If only a presentation problem remains → hand off to ui; if only physics/coordinates remain → 3d (one line explaining why it is being handed off and what remains).

### 4.2 Loop Completion Criteria

Complete only when **all** of the following are satisfied:
- The symptom no longer appears on the fixed reproduction path.
- Logs/state confirm that the change was actually reflected at runtime.
- Confirmed there are no side effects (regressions in other work areas).

If any one is unmet, it is incomplete → summarize observed facts in 1–3 lines and re-loop, or write the reason and hand off.

**Intermittent / state-transition bugs — one playthrough is not proof.** If the symptom is intermittent (does not reproduce 100%) or tied to a state transition (re-entry/restart/mode switch/network sync), a single successful playthrough does **not** satisfy the first criterion. Do not report "fixed." Confirm closure only by logs showing the previously-broken path now takes the correct branch (go to §4.3), or by the creator repeatedly running the reproduction path and confirming.

### 4.3 Log-Insertion Diagnosis for Repeated Requests

**Trigger — whichever comes first:**
- **Immediately**, from the first loop, if the symptom is intermittent (does not reproduce 100%) or tied to a state transition (re-entry/restart/mode switch/network sync). For these, do not guess-and-patch off a single playthrough — insert logs first.
- Otherwise, when there are 2+ consecutive creator requests for the same bug and the creator has not confirmed resolution with wording such as "resolved" / "fixed".

**Procedure:**

1. **Insert logs** — Based on observed facts so far and the RAG "how to check" items, insert `print()` statements at suspected problem points (state transitions, conditional branches, event handler entry/exit, immediately before/after major variable changes). **Do not** make functional changes other than logs.
2. **State the reproduction path and request playthrough** — Write the exact action sequence that reveals the bug in one sentence and ask the creator to play through that path. Example: `"Please play through the path where doing B in situation A causes C, and tell me 'test complete' when finished."` Do not make additional changes before the creator responds.
3. **Analyze logs → rediagnose** — When the creator sends the **"test complete"** signal, immediately open the logs and check the inserted output. If the actual execution path/state differs from the existing hypothesis, reclassify from §3 and restart the loop with a new hypothesis. If the same hypothesis is confirmed, proceed with the §4 single-change procedure.
4. **Remove logs** — Once diagnosis is complete, remove all inserted `print()` statements.

---

## 5. RAG Query and Response Handling (Immediately After Classification, Diagnostic Hints Only)

Once the work area is chosen, query **immediately**. **Call the `overdaresearch` tool with `source` set to `debug`.**

- `query`: Summarize the symptom in natural language (for example: `display disappears after transition`, `weapon drops from hand`).
- `source`: `debug`
- `topK`: `3`
- To narrow by work area (§3), put `script` | `ui` | `3d` in `debugCaseFilter.category`. If needed, also provide `severity`·`caseId` (exact match), `symptomTags`·`genreTags` (contains any of the tags). Multiple fields are combined with AND, and the `overdareVersion` filter is not supported.

Example call (tool arguments):
```json
{ "query": "display disappears after transition", "source": "debug", "topK": 3, "debugCaseFilter": { "category": "script" } }
```

**Response handling rules**
- Refer only to the **"how to check"** items from the top 3 similar cases → use them only to decide what to inspect first in logs and how to prioritize state tracing.
- Read each case's **"solution case" only as reference, and do not patch it verbatim.** Derive the solution directly through the §4 procedure.
- Trust and apply each case's **"OVERDARE-specific notes"** (unsupported APIs, etc.) as environment constraints.
- If there are no similar cases or the server does not respond, **continue the procedure as-is**.
- Record the result in the first response in **one line**: `Reference cases: {case ID} — {check priority summary}` / if unused, `Reference cases: none (no similar cases | search unavailable)`.

---

## 6. Related Skills / Scope

- This skill is the entry point for **debugging (defect resolution)**. Tasks that **create** new UI/content for the first time belong to the corresponding creation-specific skill; after creation, use this skill for verification and integration.
- Do not mix deployment/publish-only work with debugging.
