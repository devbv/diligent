# P077 follow-up: launcher init deployment behavior change — Studio launcher owner handoff

> Audience: whoever runs and monitors the `overdare-ai-agent` launcher (`init` / `start`) inside Studio
> Related commit: P077 launcher hardening (#301, `686f9d74`)
> Follow-up changes: PR #347, #348, #350 (below)

---

## 0. One-line summary

**No Studio integration code needs to change.** Exit codes, the machine protocol (`INIT_RESULT`, `FALLBACK_REASON`, `ERROR_CODE`), and env vars are **all unchanged**. The only difference is that init used to **overwrite user files** on update and now **preserves** them. Operationally there are just two new signals to be aware of: a `[init] Failed to deploy ...` stderr warning, and a `.init-staging` temp folder.

---

## 1. Background

P077 (#301) established the launcher's **resilience** (retry/fallback/recovery for init/start, so a "transient failure doesn't kill agent startup for the whole editor session"). Studio treats a non-zero init exit as session-fatal and applies a 60 s timeout, which is why this matters.

These three follow-up PRs fixed init's **asset deployment** logic (bootstrap → `~/.overdare/`) on top of that. Originally, when an update was actually applied (FullSync), init **overwrote the whole** of the user's global storage with the bootstrap files — a bug that wiped the user's configured values and skills.

---

## 2. Contract summary (most important — no changes)

| Item | Status |
| --- | --- |
| `INIT_RESULT=updated\|up-to-date\|fallback\|skipped` | **Unchanged** |
| `FALLBACK_REASON=<code>` (on fallback) | **Unchanged** |
| `ERROR_CODE=<code>` + exit code (10/20/21/30/40) | **Unchanged** |
| exit 0 resilience rule (bootable install > transient failure) | **Unchanged, reinforced** |
| env vars (`DILIGENT_INIT_NETWORK_BUDGET_SECS`, etc.) | **Unchanged, none added** |
| init / start invocation and arguments | **Unchanged** |

> The follow-up PRs **add no new hard-fail path.** Even if an individual asset copy fails during deployment, init still boots with exit 0 (see §4). This follows P077's design principle unchanged.

---

## 3. Behavior changes (per PR)

### PR #347 — preserve global `config.jsonc`
- **Before**: an applied update overwrote `~/.overdare/config.jsonc` wholesale with the bootstrap template → the user's commit-delegation permissions (`permissions`), tool toggles (`tools`, e.g. Bash), and model selection were reset on every version bump.
- **After**: `config.jsonc` is **never overwritten on update** (seeded only when missing). User settings are preserved.
- **Side fix**: added `configSchemaVersion` (an anchor for future migrations) and `updateMode` to the schema. In particular, putting `updateMode: "disabled"` (turn off auto-update) in the config no longer invalidates the entire runtime config.

### PR #348 — preserve user-created global skills/agents
- **Before**: an update wiped and recopied `~/.overdare/skills/` and `~/.overdare/agents/` wholesale → skills/agents the user created directly in those locations were deleted.
- **After**: **per-entry sync by skill/agent name**. Only names shipped in bootstrap (product-provided) are overwritten; names the user added are left in place.
- (Known limitation: a product skill dropped from a newer bootstrap lingers — chosen over data loss. Noted in a code comment.)

### PR #350 — atomic deployment + surface failures (stacked on #348)
- **Before**: each asset was "remove existing → copy in place", all fs errors ignored (`let _ =`), success reported even on partial failure.
- **After**: each file/folder is **fully copied into `.init-staging/` under the global root first, then swapped** (remove existing → atomic rename). If a copy fails, the **existing asset stays intact**. Failures are logged per-entry to stderr and boot continues.

> `system-prompt.txt` is still overwritten on update (an intentional product-managed asset).

---

## 4. What the Studio launcher owner needs to know (operational)

1. **No invocation change** — how init/start are called, their arguments, and the stdout lines you parse are all identical.

2. **New stderr warning (non-fatal)** — when an individual asset fails to deploy, init prints to stderr:
   ```
   [init] Failed to deploy <entry>: <error>
   [init] Failed to deploy plugins/<scope>/<name>: <error>
   [init] Failed to deploy <dir>/<name>: <error>
   ```
   - **This is not a fatal error.** init still boots with exit 0 (that asset keeps its last-good copy).
   - **Do not treat these lines as fatal** in monitoring. Collect them as warnings / observability signals only (repeated occurrences are a signal to investigate disk / permissions / AV locks).

3. **`.init-staging` temp folder** — during init a `~/.overdare/.init-staging/` folder briefly appears and is auto-removed. If you watch the storage directory, ignore this folder. (It lives outside the scanned `skills/` and `agents/`, so it is never mistaken for a skill.)

4. **User-data preservation may generate support questions** — updates now keep the user's config and custom skills/agents. The old symptom of "my settings reset after updating" is gone. Conversely, if you get "why doesn't it go back to defaults" type questions, this change is the reason.

5. **Improved crash tolerance** — if init is interrupted mid-deploy, no half-written assets are left behind (atomic swap). A rerun recovers naturally.

---

## 5. Rollout order

| PR | Branch | base | Notes |
| --- | --- | --- | --- |
| #347 | `fix/preserve-user-config-on-update` | main | independent |
| #348 | `fix/preserve-user-global-skills-agents` | main | independent |
| #350 | `fix/atomic-init-deploy` | #348 | **retarget to main after #348 merges** |

→ Recommended merge order: **#347 (independent) · #348 → #350**.

---

## 6. Note (pre-existing, unrelated to this change)

- The `update::tests::concurrent_finalizes_over_broken_leftover_converge` test fails in some environments. The P077 commit already flagged this as a **pre-existing race** ("~1/10 flake under full-parallel runs, 15/15 pass in isolation"); it is unrelated to these follow-up PRs. The init deployment logic change does not affect this test.
