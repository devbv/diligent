---
id: P068
status: backlog
created: 2026-06-23
---

# P068: OVERDARE versioned runtime updates

## Goal

Prevent `overdare-ai-agent` updates from deleting or overwriting a runtime
executable that is still in use by a running sidecar. Runtime bundles are
installed into versioned directories, and a small pointer file selects the
active version for launch, init bootstrap deployment, and update checks.

Two additional outcomes fall out of the versioned layout:

- `start --agent-env=<env>@<version>` launches that exact installed version.
  Today the `@<version>` grammar is parsed but silently ignored by `start`
  (see "Bug: start ignores the pinned version"), so this is also a bug fix.
- Multiple agents can run different versions concurrently, because a
  version-pinned `start` resolves its runtime directory directly instead of
  reading the shared mutable pointer.

## Prerequisites

- P067 env split remains in place: prod uses `~/.overdare/`, dev uses `~/.overdare-dev/`.
- Existing manifest download, SHA256 verification, and env/pin validation in `apps/overdare-ai-agent/src/update.rs` remain the update source of truth.

## Artifact

On Windows, an update can be downloaded and applied while an older
`diligent-web-server.exe` process is still running. The updater installs the new
bundle beside the active one and atomically changes the active-version metadata
instead of removing `updates/runtime/` in place. Cleanup of old versions never
deletes a directory whose sidecar is still running.

```text
~/.overdare/updates/
  runtime-current.json
  runtime-v1.2.3/
    diligent-web-server.exe
    dist/client/
    bootstrap/
    version.json
  runtime-v1.2.4/
    diligent-web-server.exe
    dist/client/
    bootstrap/
    version.json
```

## Current State

The updater currently performs an in-place runtime swap in `apps/overdare-ai-agent/src/update.rs`:

1. Download bundle zip.
2. Verify SHA256.
3. Extract to `updates/runtime_staging`.
4. Write `version.json` into staging.
5. Remove existing `updates/runtime` with `fs::remove_dir_all`.
6. Rename staging to `updates/runtime`.

The risky lines are the final remove/rename pair in `run_with_progress`: if
`updates/runtime/diligent-web-server.exe` is still running, Windows can keep the
executable locked. `retry_fs_op` already retries lock-like errors, but the design
still depends on deleting the active runtime tree before the new runtime can
become active.

The launch/init paths also assume a single fixed runtime directory:

- `update.rs`: `runtime_dir(env) -> updates/runtime`, `runtime_bootstrap_required`, `installed_version`.
- `webserver.rs`: resolves sidecar, `dist/client`, and `rg` under `updates/runtime`.
- `init.rs`: resolves bootstrap/defaults under `updates/runtime/bootstrap` or `updates/runtime/defaults`.

### Bug: start ignores the pinned version

`--agent-env=<env>[@<version>]` is a global flag parsed by `EnvSelection` for
both `init` and `start`. But `run_webserver` in `cli.rs` passes only
`selection.env` into `webserver::parse_args`; `selection.pinned_version` is
dropped. `webserver.rs` then resolves the sidecar from `updates/runtime` using
the env alone. As a result `start --agent-env=prod@1.2.3` does not launch
`1.2.3` — it launches whatever single runtime is installed. The documented
`@<version>` grammar is therefore inert for `start` today. This plan makes
`start` honor the pin.

Build-time asset staging is separate and should not need path changes:
`scripts/build-overdare-runtime-bundle.ts` copies
`apps/overdare-ai-agent/sidecar/assets` into each zip as `assets/...`.

## Proposed Design

### Runtime layout

Install each runtime bundle under a version-specific directory inside the existing env-specific updates root:

```text
updates/runtime-v<version>/
```

For pinned builds or re-published diagnostics, do not trust the semantic version
alone if the content can differ. Either reject a version directory whose
`version.json.sha256` differs from the target bundle, or suffix staging with a
short SHA before finalizing.

Keep `version.json` inside each version directory with the current
`InstalledVersion` shape:

```rust
pub struct InstalledVersion {
    pub version: String,
    pub applied_at: String,
    pub sha256: String,
}
```

Add an active pointer file at `updates/runtime-current.json`. It holds exactly
one version — the active one. It is not a list and does not track previous
versions; "which versions still exist on disk" is the directory listing, and
"which versions are still running" is determined at cleanup time (see
Retention).

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct RuntimeCurrent {
    pub version: String,
    pub dir: String,
    pub sha256: String,
    pub updated_at: String,
}
```

Use `dir` as a relative directory name, for example `runtime-v1.2.4`, and validate that it does not contain path separators before resolving it.

### Active runtime resolution

Introduce helper functions in `update.rs` or a small runtime-install module:

```rust
fn runtime_version_dir(env: Env, version: &str) -> Option<PathBuf>;
fn runtime_current_metadata_path(env: Env) -> Option<PathBuf>;
fn current_runtime_dir(env: Env) -> Option<PathBuf>;
fn legacy_runtime_dir(env: Env) -> Option<PathBuf>;
/// Single entry point used by start: pin -> version dir; otherwise -> current.
fn resolve_runtime_dir(selection: &EnvSelection) -> Result<PathBuf, String>;
```

`current_runtime_dir` resolution order (used by no-pin `start` and by `init`):

1. If `runtime-current.json` exists and points to a valid installed runtime, use it.
2. Else, fall back to legacy `updates/runtime` for existing installs.
3. During the first successful versioned update, write `runtime-current.json` and stop writing the flat runtime layout.

This keeps old installations bootable and avoids a forced migration before the next successful update.

### Version-pinned launch (fixes the start bug)

`resolve_runtime_dir(selection)`:

- If `selection.pinned_version` is `Some(v)`, resolve `runtime_version_dir(env, v)`.
  The directory must exist and pass the runtime layout check. If it does not,
  fail with a clear message telling the user to run
  `overdare-ai-agent --agent-env=<env>@<v> init` first. Never silently fall back
  to a different version when a pin was requested.
- If `selection.pinned_version` is `None`, use `current_runtime_dir(env)`.

Thread the full `EnvSelection` (not just `env`) from `cli.rs::run_webserver`
into the launcher so `webserver.rs` can resolve the right directory. Resolve the
runtime directory once, then derive the sidecar binary, `dist/client`, and `rg`
relative to it.

Because a version-pinned `start` resolves its directory directly, several agents
can run different versions at the same time without depending on the shared
mutable pointer — there is no race where one instance's `init` changes the
pointer that another instance's `start` is about to read.

### Applying an update

Replace the current `runtime_staging -> runtime` flow with:

1. Extract to `updates/runtime_staging_<version>`.
2. Verify required files exist in staging: sidecar binary, `dist/client`, and bootstrap/defaults if expected.
3. Write staging `version.json`.
4. Rename staging to `updates/runtime-v<version>`.
5. Atomically write `runtime-current.json` using temp-file + rename.
6. Remove the zip.
7. Do not remove the previously active version in the update path.

This means the only directory removed during update is stale staging or a
non-active target directory known to be safe. The active sidecar directory is
not deleted while a child process may still be using it.

### Retention (usage-based, not count-based)

**Trigger:** cleanup runs at the end of `run_with_progress`, after the pointer
switch — never before, and never as a step that can fail the update. This is the
moment disk just grew (a new version landed), and running it after the pointer
write guarantees it cannot fail an otherwise-successful update. It is not wired
into `start` (latency-sensitive — Studio waits for `WEBSERVER_PORT`) or a
separate gc command. Note that the just-superseded version is usually still
running at this point, so on Windows it is skipped (locked) and reclaimed on the
*next* update once its process has exited. Disk stays bounded to
"active + still-running + at most one not-yet-collected".

The rule is usage-based rather than "keep N versions":

- Never delete `current_runtime_dir(env)`.
- Never delete a version directory whose sidecar is still in use by a running
  process.
- Idle, non-current version directories are eligible for best-effort cleanup.

Whether 2 or 3 versions are installed is irrelevant; what matters is whether a
directory is still in use.

**Windows (the only platform Studio targets today):**

- Use probe-before-delete. Before touching a candidate directory, probe whether
  its sidecar binary is in use by opening it with an exclusive (no-share) handle
  (`OpenOptions` + `share_mode(0)`). A running process keeps the image open with
  `FILE_SHARE_READ`, so the exclusive open fails with a sharing violation — treat
  that as in-use and skip the entire directory. If the open succeeds, close it
  and proceed to delete.
- Do NOT probe by attempting a rename: Windows allows renaming a running `.exe`
  even though it cannot be deleted, so "rename succeeded" would falsely report
  the directory as safe to remove.
- Do not begin removing files and rely on catching a lock error partway through —
  `remove_dir_all` is not atomic and can delete `dist/client` and other files
  before reaching the locked `.exe`, leaving a corrupted partial directory.
- The OS file lock means a running version is protected automatically; the probe
  makes that protection explicit and avoids partial deletion.

**mac / Linux (not targeted by Studio yet — memo only, do not implement):**

- POSIX allows unlinking files that a running process still has open, so the OS
  does not protect an in-use runtime the way Windows does. Enabling cleanup here
  safely requires explicit in-use detection (a per-version pidfile with liveness
  checks, or scanning running processes for the binary path).
- Until Studio supports these platforms, leave a TODO/memo and do not run
  destructive cleanup on POSIX. Installing beside the active runtime is still
  correct; only the cleanup step is deferred.

```rust
fn cleanup_old_runtimes(env: Env, log: &mut String) {
    // Best effort only.
    // - Never remove current_runtime_dir(env).
    // - Windows: probe each candidate's sidecar lock; skip the whole dir if in use.
    // - mac/Linux: not implemented yet (see Retention memo); no destructive cleanup.
}
```

### Symlink / latest folder decision

Prefer a JSON pointer file over a `latest` symlink for the first implementation.

Reasons:

- Windows symlink creation can require privileges or developer mode.
- Directory junctions add platform-specific behavior and cleanup edge cases.
- The Rust launcher already resolves all runtime paths before spawning the sidecar, so a pointer file is enough.
- Avoids sidecar/assets surprises because the sidecar receives explicit paths via env vars and args today.

If a stable path is later needed for external tools, add `updates/runtime-latest` as a best-effort symlink/junction on top of the metadata contract, not as the source of truth.

## Scope

### What changes

| Area | What Changes |
|------|-------------|
| `apps/overdare-ai-agent/src/update.rs` | Add versioned install directories, current metadata, active runtime resolution, version-pin resolution, legacy fallback, and usage-based cleanup. |
| `apps/overdare-ai-agent/src/cli.rs` | Pass the full `EnvSelection` (including `pinned_version`) into the launcher so `start` can honor `@<version>`. |
| `apps/overdare-ai-agent/src/webserver.rs` | Resolve the runtime directory via `resolve_runtime_dir(selection)`, then derive sidecar, `dist/client`, and `rg` from it. Update error messages so they do not promise `updates/runtime`. |
| `apps/overdare-ai-agent/src/init.rs` | Resolve bootstrap/defaults from the current runtime directory instead of hardcoded `updates/runtime`. |
| `apps/overdare-ai-agent/README.md` | Document the versioned update layout, version-pinned start, and retention behavior. |
| `docs/guide/packaging.md` | Document runtime bundle install layout and active pointer metadata. |

### What does NOT change

- No change to P067 prod/dev storage isolation or `--agent-env` grammar.
- No change to release manifest URL selection, env validation, or pinned-version validation.
- No TypeScript sidecar bundle content change.
- No build-time `sidecar/assets` source path change.
- No symlink/junction requirement in the first implementation.
- No destructive runtime cleanup on mac/Linux yet (memo only).

## File Manifest

### apps/overdare-ai-agent/src/

| File | Action | Description |
|------|--------|-------------|
| `update.rs` | MODIFY | Add `RuntimeCurrent`; replace flat `runtime_dir` usage with current/versioned runtime helpers and `resolve_runtime_dir`; install into `runtime-v<version>`; atomically update pointer; usage-based cleanup with Windows probe-before-delete. |
| `cli.rs` | MODIFY | Thread `EnvSelection` into `run_webserver` / `webserver::parse_args` so `start` honors `@<version>`. |
| `webserver.rs` | MODIFY | Resolve the runtime directory via `resolve_runtime_dir(selection)`; derive sidecar binary, `dist/client`, and optional `rg` from it. Clear error when a pinned version is not installed. |
| `init.rs` | MODIFY | Use the active runtime resolver for `bootstrap` / legacy `defaults` lookup. |

### apps/overdare-ai-agent/

| File | Action | Description |
|------|--------|-------------|
| `README.md` | MODIFY | Explain versioned runtime directories, active metadata, version-pinned start, and retention/cleanup expectations. |

### docs/

| File | Action | Description |
|------|--------|-------------|
| `guide/packaging.md` | MODIFY | Add packaging/install contract for versioned runtime updates. |

## Implementation Tasks

### Task 1: Add active runtime metadata and path helpers

**Files:** `apps/overdare-ai-agent/src/update.rs`

Add `RuntimeCurrent` and helpers for updates root, versioned dirs, current metadata, legacy flat dir, and active runtime validation.

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct RuntimeCurrent {
    pub version: String,
    pub dir: String,
    pub sha256: String,
    pub updated_at: String,
}

pub fn current_runtime_dir(env: Env) -> Option<PathBuf> {
    let updates = updates_dir(env)?;
    let pointer = read_runtime_current(env).ok().flatten();
    if let Some(current) = pointer {
        let dir = updates.join(current.dir);
        if runtime_layout_exists(&dir) {
            return Some(dir);
        }
    }
    let legacy = updates.join("runtime");
    runtime_layout_exists(&legacy).then_some(legacy)
}
```

**Verify:** Unit tests cover current pointer success, invalid pointer fallback, and legacy flat fallback.

### Task 2: Change update apply to install beside the active runtime

**Files:** `apps/overdare-ai-agent/src/update.rs`

Replace the remove-old-runtime step with versioned finalization:

```rust
let staging = updates.join(format!("runtime_staging_{}", fetched.version));
let target_name = format!("runtime-v{}", fetched.version);
let target = updates.join(&target_name);

extract_zip(&zip_path, &staging)?;
write_version_json(&staging, &version_info)?;
validate_runtime_layout(&staging)?;

if target.exists() && !is_current_runtime(selection.env, &target)? {
    retry_fs_op("remove previous incomplete target runtime", || fs::remove_dir_all(&target))?;
}
retry_fs_op("move staging to versioned runtime", || fs::rename(&staging, &target))?;
write_runtime_current_atomic(selection.env, RuntimeCurrent { /* ... */ })?;
```

Do not remove the previously active runtime as part of applying the update.

**Verify:** Tests or a temp-home integration-style test prove the old runtime directory remains after applying a new version.

### Task 3: Move launcher/init path resolution to active runtime, with version-pin support

**Files:** `apps/overdare-ai-agent/src/webserver.rs`, `apps/overdare-ai-agent/src/init.rs`, `apps/overdare-ai-agent/src/cli.rs`, `apps/overdare-ai-agent/src/update.rs`

Export `resolve_runtime_dir(selection)` from `update.rs`:

- pinned: `runtime_version_dir(env, version)`, must exist and pass layout check, else a clear "run init … @version first" error.
- unpinned: `current_runtime_dir(env)` (pointer → legacy fallback).

Use it in the launcher so sidecar binary, `dist/client`, and `rg` are derived
from one resolved directory. Keep the legacy fallback inside the resolver, not
duplicated at each call site. `init.rs` resolves bootstrap/defaults from
`current_runtime_dir(env)`.

**Verify:** Existing start/init tests pass; add tests for resolver fallback chain.

### Task 4: Make start honor the pinned version

**Files:** `apps/overdare-ai-agent/src/cli.rs`, `apps/overdare-ai-agent/src/webserver.rs`

Pass the full `EnvSelection` into `run_webserver` and the launcher instead of
only `selection.env`. When a pin is present, `start` launches
`runtime-v<version>` deterministically; when absent, it uses
`runtime-current.json`.

**Verify:**

- `start --agent-env=<env>@<version>` launches the matching directory.
- `start --agent-env=<env>@<missing>` fails with a clear "not installed; run init first" message and no fallback.
- `start --agent-env=<env>` (no pin) launches the pointer target.

### Task 5: Add usage-based retention cleanup outside the critical update swap

**Files:** `apps/overdare-ai-agent/src/update.rs`

Call cleanup at the end of `run_with_progress`, after the pointer write — never
before. Never delete the current pointer target or a version still in use.

- Windows: probe-before-delete by opening the sidecar binary with an exclusive
  (no-share) handle (`OpenOptions` + `share_mode(0)`). If the open fails with a
  sharing violation, the version is in use — skip the whole directory. Do not
  probe via rename (a running `.exe` is renamable but not deletable), and do not
  start removing files and rely on a mid-operation lock error, which can leave a
  partial directory.
- mac/Linux: not implemented (memo). Do not run destructive cleanup there until
  explicit in-use detection exists.

On any cleanup failure, log and continue; cleanup must not fail an otherwise
successful update.

```rust
fn cleanup_old_runtimes(env: Env, log: &mut String) {
    // Best effort only. Never remove current_runtime_dir(env) or an in-use dir.
    // Windows: exclusive-open probe (share_mode 0); skip whole dir if locked.
    // mac/Linux: not yet (see Retention memo).
}
```

**Verify:** Cleanup failure does not make `run_with_progress` return an update failure after a successful pointer switch.

### Task 6: Document the new install contract

**Files:** `apps/overdare-ai-agent/README.md`, `docs/guide/packaging.md`

Document:

- `updates/runtime-current.json` is the source of truth for the active runtime (single version).
- `updates/runtime` is legacy fallback only.
- `start --agent-env=<env>@<version>` launches a specific installed version; without a pin it uses the pointer.
- Runtime bundles still contain the same internal paths.
- Old version directories may remain temporarily; cleanup is best-effort, usage-based, and Windows-only for now (mac/Linux deferred).

**Verify:** Docs mention both prod and dev roots.

## Acceptance Criteria

1. Updating from vN to vN+1 does not remove the vN runtime directory during the apply step.
2. `start` without a pin launches the sidecar from the directory selected by `runtime-current.json`.
3. `start --agent-env=<env>@<version>` launches `runtime-v<version>` deterministically, independent of the pointer.
4. `start --agent-env=<env>@<version>` with a missing/invalid version directory fails with a clear "run init … @version first" error and never falls back to a different version.
5. `init` deploys bootstrap assets from the active runtime directory.
6. Existing flat `updates/runtime` installs still launch when no pointer and no pin exist.
7. SHA mismatch for an existing version directory is rejected or handled without silently reusing stale content.
8. On Windows, cleanup never partially deletes a locked version directory; the current and any in-use directories are preserved.
9. Cleanup of old runtime directories is best-effort and cannot fail an otherwise successful update.

## Testing Strategy

| Category | What to Test | How |
|----------|--------------|-----|
| Unit | Pointer parsing, relative-dir validation, legacy fallback | Rust tests with temp home. |
| Unit | `resolve_runtime_dir`: pin exists, pin missing (error), no pin → pointer/legacy | Rust tests with temp updates root. |
| Unit | Update finalization preserves old runtime | Temp updates root with fake sidecar/dist layout. |
| Integration | `start` honors `@<version>`; `init` and `start` resolve active runtime | Existing Rust command tests or focused resolver tests. |
| Manual Windows | Update + cleanup while old `diligent-web-server.exe` is running | Start old sidecar, run update flow, verify probe skips the locked dir with no partial deletion and no lock failure. |

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|------------|
| Pointer file corrupted | Agent cannot find active runtime | Validate pointer and fall back to legacy `updates/runtime`; show clear repair message if neither works. |
| Pinned `start` to an uninstalled version | Launch fails | Clear "run init … @version first" error; never silently fall back to another version. |
| Same version republished with different SHA | Stale directory may be reused | Compare target `version.json.sha256` with manifest SHA and reject/reinstall safely. |
| Old versions accumulate | Disk growth | Best-effort usage-based retention after successful pointer switch. |
| Partial deletion of a locked dir (Windows) | Corrupted version directory | Probe-before-delete; skip the whole dir if its sidecar is locked. |
| POSIX cleanup deletes an in-use runtime | Broken running process on mac/Linux | Cleanup not enabled on POSIX yet; deferred until explicit in-use detection exists (memo). |
| Windows symlink/junction limitations | Launch failures if symlink is required | Do not require symlink in first implementation; use JSON pointer. |
| Bootstrap path drift | Init deploys stale defaults | Resolve bootstrap from the same active runtime directory used by start. |

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| P067 | OVERDARE prod/dev env split and version pinning | Preserve env-specific update roots and manifest validation. |
