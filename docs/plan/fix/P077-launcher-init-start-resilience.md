---
id: P077
status: in-progress # Launcher-side Phase 1–3 implemented (2026-07-15). Remaining: Studio-side line parsing/UI consumption, Confluence doc updates (§7)
created: 2026-07-15
---

# Agent launcher init/start failure handling, retry, and recovery hardening

## Goal

Harden the retry and recovery (fallback) logic in the `init` / `start` paths of
the Rust launcher (`apps/overdare-ai-agent`) that the OVERDARE Studio desktop app
invokes, so that transient failures (network flakes, AV locks, slow boots) do not
block Studio's agent execution itself. Two principles:

1. **The launcher absorbs transient failures** — failures that a retry resolves
   are not propagated up to Studio.
2. **Never break an already-bootable state** — an update/check failure must not
   block the execution of an already-installed runtime.

> Reference docs: Confluence [MCP AI Agent Web Server initialization design](https://overdare.atlassian.net/wiki/spaces/NFTMetaverse/pages/394002463),
> [MCP Service system implementation](https://overdare.atlassian.net/wiki/spaces/NFTMetaverse/pages/236879957).
> Both reviewed — the Studio-side call sequence is captured in §1.1, and the
> resulting constraints in §4/§7.

## 1. Current structure summary

Studio desktop app → launcher CLI call flow:

```
overdare-ai-agent init            # ensure runtime is downloaded/updated
overdare-ai-agent start --cwd=... --studio-rpc-port=...
  → prints WEBSERVER_PORT=<port> on stdout; Studio parses it and connects
```

### 1.1 Studio (editor)-side launcher lifecycle — from the Confluence docs

`MCPAgentWebServer.cpp` / `MCP.cpp` (editor-side implementation, per the docs):

- **init runs once per editor session**, at editor startup (`Initialize()`). A
  worker thread (`InitMonitorThread`) drains the pipe and detects termination on
  a 0.2 s cycle.
- **init timeout is 60 s** (`INIT_MONITOR_TIMEOUT = 60.0f`). On timeout or
  `InitReturnCode != 0`, `bInitCompleted == false`, which **blocks start for the
  entire editor session**. There is no in-session init retry path (documented
  known limitation #1).
- **start runs on project/map open.** If init is in progress, it defers via a
  ticker and runs after completion. Studio only judges init's **exit code 0 vs
  non-zero**, and the start process is cleaned up together with the editor via a
  Job Object (`KILL_ON_JOB_CLOSE`).
- There is no automatic restart after a start-process crash on the Studio side
  either (confirms the premise of the §4 no-change decision).

> The two "launcher-perspective" key constraints from this:
> **(A) init must effectively finish within a 60 s budget** — if it takes longer,
> Studio has already timed out even if init succeeds.
> **(B) if init exits non-zero, all agent functionality for that session dies** —
> treating a fallback success (P1) as exit 0 is not a mere UX improvement but a
> session-survival issue.

### init path (`cli.rs::run_init` → `update.rs::run_with_progress` → `init.rs::run`)

1. Namespace migration → print env/pin
2. `init_status()`: confirm latest version via manifest fetch
3. `run_with_progress()`: flat runtime migration → clear stale scratch →
   manifest fetch (re-confirm) → bundle download → SHA256 verify → extract →
   layout verify → promote `runtime-v<ver>` + atomic pointer switch → clean up
   old versions
4. `init::run()`: deploy bootstrap assets (best-effort)

### start path (`cli.rs::run_webserver` → `webserver.rs::start_foreground`)

1. Migration → `resolve_runtime_dir()` (pinned version or pointer, legacy
   fallback if absent)
2. Spawn the sidecar (`diligent-web-server`) (passing `--parent-pid` → the
   sidecar self-terminates when it detects the parent died)
3. Wait for the `WEBSERVER_PORT=` line on stdout (**15 s timeout**)
4. Poll `/health` (**30 s deadline**, 2 s per request, 200 ms interval)
5. Print `WEBSERVER_PORT=<port>`, then wait for the child process to exit

### Stability mechanisms already in place (do not reinvent)

| Mechanism | Location |
|---|---|
| Manifest fetch retry ×3 + exponential backoff + retryable classification (5xx / dev-latest 404 / network·body errors) | `update.rs::fetch_manifest` |
| Windows file-lock retry ×8 @ 350 ms | `update.rs::retry_fs_op` |
| pid-isolated staging/zip + atomic pointer switch + concurrent-install converge | `update.rs::finalize_runtime_install` |
| Immediate scratch discard on failed install + 24 h orphan sweep | `discard_transient_install`, `sweep_stale_scratch` |
| Disk reuse (skip download when reinstalling the same version) | `UpdateOutcome::ReuseInstalled` |
| SHA256 pre-verification (before writing to disk) | `run_with_progress` |
| Corrupt pointer → legacy flat runtime fallback | `current_runtime_dir` |
| `--skip-update` offline path (no network contact) | `cli.rs::run_init` |

Cleanup of failure leftovers is already covered end to end: a download exists
only in memory until SHA verification, so an interrupted one leaves no disk
residue; errors during install are cleaned up immediately by
`discard_transient_install`; zip/staging left behind by a force-kill (including
Studio's 60 s kill) use pid-isolated names so they don't collide with the next
run and are reclaimed by the sweep after 24 h. Broken `runtime-v*` remnants are
distinguished from complete installs by `is_complete_install` and cleaned up. In
other words, there is no path where "leftover files cause the next init/start to
fail."

## 2. Gap analysis (init)

### G1. Update check/download failure = total init failure (even with an existing runtime)

`run_init` returns the error as-is if `init_status()`'s manifest fetch fails
(after retries are exhausted). **Even when a bootable runtime is already
installed**, a single network flake fails init, and from Studio's perspective
agent execution itself is blocked. The biggest recovery gap.

### G2. No retry on bundle download and inappropriate timeout

`fetch_update`'s bundle download is a single attempt, and `Client::timeout(30s)`
is based on **total request time** (including body reception). Runtime bundles
are hundreds of MB, so on slow connections even a normal download exceeds 30 s
and fails. The retry/backoff/retryable classification that manifest fetch has is
absent from the download.

### G3. No retry on extraction failure

`extract_zip` uses `Expand-Archive` on Windows. If AV real-time scanning briefly
holds the zip or extracted files, it can fail transiently, and being a single
attempt it becomes an init failure. Since the zip passed SHA verification and is
on disk, the retry cost is low.

### G4. Studio cannot distinguish failure kinds

Every failure is exit code `1` + free-form stderr text. Studio cannot
distinguish "network problem (worth retrying)" vs "install corruption (needs
init rerun)" vs "config error (needs user intervention)", so it can only show a
blanket-failure UI.

## 3. Gap analysis (start)

### G5. Child process not explicitly cleaned up on port/health wait failure

In `start_foreground`, on port-line timeout (15 s) or health-check failure
(30 s) an error is returned and the `tokio::process::Child` is dropped, but
`kill_on_drop` is not set so the sidecar stays alive. It is eventually cleaned up
by the sidecar's `--parent-pid` watch after the CLI process exits, but (a) it's a
leak if reused library-style, and (b) **to implement retry you must first kill
the previous child** (especially to avoid a conflict on a fixed
`--web-server-port`), so an explicit kill is a prerequisite.

### G6. No retry on start failure

Spawn failure, port-line timeout, and health-check timeout all terminate
immediately on the first failure. Cases where first boot is transiently slow
(e.g. Windows Defender scanning a new binary) can be absorbed by a single retry.

### G7. Health deadline fixed at 30 s

In slow-disk / AV-scanning environments, if first boot exceeds 30 s there is no
remedy (not adjustable without a rebuild).

### G8. start requires manual recovery when the runtime is absent

On corrupt pointer + legacy absence (or the user deleting `~/.overdare`), start
only emits a "run init first" error. Unless Studio parses this string and reruns
init, the user is stuck.

## 4. Proposed changes

### P1. init: fall back to the existing runtime on update failure (G1) — top priority

How the fallback works: Studio only calls start when init exits 0, so this is not
"init failed but start runs" — it is **not promoting an update-step failure to a
total init failure, and instead ending init with exit 0**. Afterward start (no
pin) does not search/compare installed versions but runs the single active
version the pointer file (`runtime-current.json`) points at; since the pointer is
updated only on a successful install, a session with a failed update naturally
boots the last known-good version.

In `run_init`, when manifest fetch / download / install fails:

- If `runtime_installed(env) == true` (a bootable runtime exists):
  leave a warning on stderr and **succeed with exit 0**, keeping the existing
  runtime. `init::run(env, false)` (bootstrap deployment) still runs.
  - "Bootable" is judged by the **same predicate** start's `resolve_runtime_dir`
    uses before launch (`runtime_layout_exists`: sidecar binary + `dist/client`
    present). So the directory init declares for fallback and the directory start
    actually launches always match. Being a file-existence check, the extreme
    case where content is corrupted by external tampering after install passes
    this check — but that is caught by start-stage failure reporting (P5/P4).
  - Observability: the fallback warning includes the current version, the latest
    version, and the failure reason. Studio's init monitor captures the
    stdout/stderr pipes into the editor log (§1.1), so log exposure happens with
    no extra work; the user-facing UI notification is done by Studio consuming the
    `INIT_RESULT=fallback` line from P4 (no parsing of log strings).
- If there is no runtime (first-time bootstrap): fail as today. There is no
  fallback target.
- Carry `INIT_RESULT=fallback` + failure reason in the structured output (P4) so
  Studio can show a "running on an old version" notice.
- **Made top priority by §1.1-(B)**: currently a single update-check failure
  (non-zero exit) blocks all agent functionality for that editor session. The
  fallback exit 0 directly resolves this.

Note: the `updateMode: disabled` path and a pinned (`@<version>`) init have
different semantics. If a pinned version is not installed and the download fails,
it must not fall back and must fail (a pin is an "exactly that version" contract —
same as `resolve_runtime_dir`'s no-fallback principle).

Policy rationale: init's contract is not "guarantee latest" but "guarantee a
runnable runtime, latest if possible." `--skip-update` and `updateMode: disabled`
already accept "exit 0 on an old version" as a normal state, and P1 merely
extends this to transient network failures. If a release requiring a forced
update (protocol incompatibility, etc.) ever arises, add a `minVersion` field to
the manifest and extend to "refuse fallback if installed < minVersion" — no such
release exists now, so it is not implemented.

### P2. init: bundle-download retry + timeout redesign (G2)

- Reuse the same policy as `fetch_manifest`: 3 attempts, exponential backoff
  (500 ms base), retryable classification (network errors / 5xx / body-read
  errors retry; other 4xx terminate).
- The download client uses `connect_timeout(10s)` + a relaxed total timeout.
  Remove the 30 s total timeout since it fails normal downloads. (Streaming +
  no-progress detection is over-engineering — a total cap is sufficient.)
- SHA256 verification failure is also treated as a "corrupt download" and
  included in the one-time re-download target (the case where a truncated body
  during a CDN swap came down as-is).
- **§1.1-(A) 60 s budget constraint**: since Studio times init out at 60 s, it is
  pointless for the launcher to spin on minutes-long retries internally (the
  session is already blocked even on success). Therefore:
  - **init with an existing runtime** (common case): cap the download+retry total
    budget at a **default of 45 s** and switch immediately to the P1 fallback on
    overrun. The budget must be strictly shorter than Studio's timeout — if equal
    (60 s = 60 s), Studio's clock fires before fallback handling finishes after
    the budget is spent, making exit 0 meaningless. The value is exposed as
    `DILIGENT_INIT_NETWORK_BUDGET_SECS` (default 45) so if Studio raises its
    timeout, the launcher follows without a rebuild. The update eventually catches
    up because init retries on the next editor startup.
  - **first-time bootstrap** (no runtime): there is no fallback target, and a
    hundreds-of-MB download can legitimately exceed 60 s depending on the
    connection. This cannot be solved by the launcher alone — it requires
    increasing Studio's fixed 60 s timeout, or agreeing that Studio's monitor
    interprets the launcher's progress output (already printing `downloading v…`,
    etc. on stdout) as a "in progress" signal and extends the timeout (§7-1).

### P3. init: one-time extract retry (G3)

Retry `extract_zip` once after a short wait (1–2 s) on failure. staging is safe
to retry (idempotent) because `extract_zip` already initializes it. Terminate on
a second failure.

### P4. init/start: structured result output + exit-code scheme (G4)

Extend the protocol Studio already parses (`WEBSERVER_PORT=`) as-is:

- Just before process exit, a machine-readable result line at the end of stdout:
  - `INIT_RESULT=updated|up-to-date|fallback|skipped`
  - On fallback, also emit a `FALLBACK_REASON=<code>` line (a success, but
    conveys why the update step failed)
  - On failure (non-zero exit), an `ERROR_CODE=<code>` line at the end of stderr
  - `ERROR_CODE` and `FALLBACK_REASON` **share the same reason-code table**.
    Because the key name distinguishes success/failure, the invariant
    "`ERROR_CODE` present ⇔ exit non-zero" holds, keeping Studio-side parsing
    simple.
- Reason-code table (classified by "what should the receiver do" — the detailed
  reason lives in the human-facing log message, not the code; values finalized in
  §7-3):

  | Code | Name | Failure point | Worth retrying |
  |---|---|---|---|
  | `10` | `network` | manifest fetch/bundle download network error·timeout·5xx·404 retries exhausted, including 45 s budget overrun | Yes (may resolve naturally on next startup) |
  | `20` | `disk` | FS failures like zip write·extract·rename·pointer write (including AV-lock retries exhausted) | Yes (check space/AV) |
  | `21` | `verify` | SHA256 mismatch persists after re-download | No (release corruption) |
  | `30` | `manifest` | manifest parse failure·env mismatch·pinned-version mismatch·no platform bundle | No (release/config problem) |

  The same code splits by channel: exit 0 + `FALLBACK_REASON=10` is "running on an
  old version (network)"; exit non-zero + `ERROR_CODE=10` is "first install failed
  (no fallback target)". A 45 s budget overrun is fundamentally a slow network so
  it is included in `10`; subdivide later if a distinction becomes necessary.
- The delivery path needs no new infrastructure: Studio's init monitor
  (`PollInit`) already drains and captures the stdout/stderr pipes on every poll
  (§1.1). Only parsing the line and reflecting it in the UI is new Studio-side
  work.
- exit-code distinctions (example):
  - `0` success (including fallback) / `10` network (worth retrying) / `20`
    install·disk corruption (needs init rerun) / `30` config·argument error (user
    intervention) / `40` start boot failure
- Existing human-facing messages are kept — only lines are added, so it is
  backward-compatible.
- Since Studio currently judges only init's **exit code 0 vs non-zero** (§1.1),
  the granular codes are purely additive — safe to ship even before Studio starts
  consuming them. init's stdout/stderr pipes are captured and logged by Studio, so
  the line protocol is delivered as-is.
- **Requires agreement with the Studio team on the code scheme** (§7). The
  Confluence doc updates happen at this stage too.

### P5. start: kill the child on failure + re-spawn once (G5, G6)

- Set `cmd.kill_on_drop(true)` + explicit `child.kill().await` on the port/health
  wait-failure paths (errors ignored — best-effort).
- Group spawn → port wait → health check into one attempt for a **total of 2
  attempts** (2 s wait before retry). Since the previous child is killed for
  certain before re-spawning, it is safe even on a fixed port
  (`--web-server-port`).
- If the sidecar self-terminates before printing the port (the path that shows the
  exit code + log path well), **do not retry** — a crash is likely to produce the
  same result on re-spawn, and it is better to surface the diagnostic message
  quickly. Retry only the timeout class.

### P6. start: make the health deadline an env var (G7)

Add just `DILIGENT_START_HEALTH_TIMEOUT_SECS` (default 30). The port-line timeout
(15 s) too, the same way (`DILIGENT_START_PORT_TIMEOUT_SECS`). Kept as env vars,
not flags, so as not to touch Studio's call signature.

### P7. start: `--init-if-missing` option (G8)

`start --init-if-missing`: if `resolve_runtime_dir` fails with "no runtime", run
init (including update) once internally, then resume start.

- Applies to pinned-version start as well (pinned-version init, then start).
- Default behavior is unchanged (fails as today without the flag) — Studio
  opts in.
- With this flag, Studio also gains the option of collapsing the two-step
  init/start call into a single start (to be decided after doc review).

### Non-changes (intentionally excluded)

- **Automatic restart of the sidecar after a crash post-start (restart policy)**:
  the launcher cannot recover running-session state, and the restart decision (UI
  notification, reconnection) is naturally Studio's responsibility. The launcher
  only clearly signals "abnormal termination" via P4's exit code. (Doc-confirmed:
  Studio has no restart logic either — it only guarantees cleanup on editor exit
  via the Job Object; the post-crash restart UX is filed as a Studio-side task in
  §7.)
- **Download resume (HTTP Range)**: full re-download retry is sufficient.
  Introduce it when bundle size grows to the GB range.
- **Random-port fallback on fixed-port conflict**: a caller that fixed the port
  expects that port. A clear failure is better than silently coming up on a
  different port.

## 5. Implementation phases

### Phase 1 — recovery core (highest user impact)

1. P1: init update failure → fall back to existing runtime (`cli.rs::run_init`)
2. P5 first half: `kill_on_drop` + explicit kill on failure paths (`webserver.rs`)
3. P2: download retry + timeout redesign (`update.rs::fetch_update`)

### Phase 2 — retry hardening

4. P5 second half: start timeout-class one-time retry (`webserver.rs::start_foreground` call site)
5. P3: extract one-time retry (`update.rs::extract_zip` call site)
6. P6: make timeouts env-configurable

### Phase 3 — Studio integration protocol

7. P4: `INIT_RESULT=` / `ERROR_CODE=` / exit-code scheme — **launcher side
   implemented** (additive, so safe to ship before Studio consumes; code values
   finalized in §7-3)
8. P7: `start --init-if-missing` — **implemented** (opt-in, no effect until Studio
   uses it)
9. Update the two Confluence docs (launcher execution guide, MCP Service) +
   Studio-side line parsing/UI consumption — **remaining work**

## 6. Test plan

- **Unit**: fallback decision (runtime presence × failure kind × pin presence
  matrix), download retryable classification (reuse the existing
  `is_retryable_manifest_status` test pattern), exit-code mapping. Use the
  existing `with_temp_home` test utility.
- **Manual scenarios** (Windows first — Studio's target platform):
  1. Network blocked while installed → `init` exit 0 + `INIT_RESULT=fallback`
  2. First install (no runtime) + network blocked → `init` fails (exit 10)
  3. Inject one 5xx via proxy during download → succeeds on retry
  4. Fixed `--web-server-port` + induce a health timeout on the first attempt →
     confirm the previous child is terminated, retry succeeds, no port conflict
  5. Delete `~/.overdare/updates`, then `start --init-if-missing` → auto-recovery
  6. Confirm no orphan `diligent-web-server.exe` via `tasklist` right after a
     start failure

## 7. Studio-team discussion items (remaining after doc review)

Reviewing the two Confluence docs resolved the call sequence (§1.1), the
exit-code consumption model (0/non-zero only), and the absence of crash restart.
Remaining discussion items:

1. **Conflict between the 60 s init timeout and first-time bootstrap** (see P2):
   the hundreds-of-MB download of a first install can legitimately exceed 60 s.
   Options — (a) raise Studio's `INIT_MONITOR_TIMEOUT`, (b) treat the launcher's
   progress lines (`downloading v…`, etc.) as an "in progress" signal and extend
   the timeout based on progress, (c) a separate timeout for bootstrap only. The
   launcher's P4 line protocol is the basis for (b).
2. **Whole-session block policy on init timeout/failure** (Studio doc's known
   limitation #1): once the P1 fallback is in, only "first-ever failure with no
   runtime at all" remains. Discuss whether to put an in-session init-retry UX (a
   manual retry button, etc.) in Studio for this case.
3. Finalize the values of the P4 `ERROR_CODE=`/exit-code scheme and the timing of
   Studio consumption.
4. Is there a separate retry on the Studio side during the `dev-latest` release
   swap window? (If so, adjust so it doesn't multiply with the launcher's retry
   count — not mentioned in the docs.)
