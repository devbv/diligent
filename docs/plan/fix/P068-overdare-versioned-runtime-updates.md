---
id: P068
status: backlog
created: 2026-06-23
---

# P068: OVERDARE versioned runtime updates

## Goal

Prevent `overdare-ai-agent` updates from deleting or overwriting the currently running sidecar executable. Runtime bundles are installed into versioned directories, then a small metadata/pointer layer chooses the active version for launch, init bootstrap deployment, and update checks.

## Prerequisites

- P067 env split remains in place: prod uses `~/.overdare/`, dev uses `~/.overdare-dev/`.
- Existing manifest download, SHA256 verification, and env/pin validation in `apps/overdare-ai-agent/src/update.rs` remain the update source of truth.

## Artifact

On Windows, an update can be downloaded and applied while an older `diligent-web-server.exe` process is still running. The updater installs the new bundle beside the active one and atomically changes the active-version metadata instead of removing `updates/runtime/` in place.

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

The risky lines are the final remove/rename pair in `run_with_progress`: if `updates/runtime/diligent-web-server.exe` is still running, Windows can keep the executable locked. `retry_fs_op` already retries lock-like errors, but the design still depends on deleting the active runtime tree before the new runtime can become active.

The launch/init paths also assume a single fixed runtime directory:

- `update.rs`: `runtime_dir(env) -> updates/runtime`, `runtime_bootstrap_required`, `installed_version`.
- `webserver.rs`: resolves sidecar, `dist/client`, and `rg` under `updates/runtime`.
- `init.rs`: resolves bootstrap/defaults under `updates/runtime/bootstrap` or `updates/runtime/defaults`.

Build-time asset staging is separate and should not need path changes: `scripts/build-overdare-runtime-bundle.ts` copies `apps/overdare-ai-agent/sidecar/assets` into each zip as `assets/...`.

## Proposed Design

### Runtime layout

Install each runtime bundle under a version-specific directory inside the existing env-specific updates root:

```text
updates/runtime-v<version>/
```

For pinned builds or re-published diagnostics, avoid trusting only the semantic version if the content can differ. Either reject a version directory whose `version.json.sha256` differs from the target bundle, or suffix staging with a short SHA before finalizing.

Keep `version.json` inside each version directory with the current `InstalledVersion` shape:

```rust
pub struct InstalledVersion {
    pub version: String,
    pub applied_at: String,
    pub sha256: String,
}
```

Add an active pointer file at `updates/runtime-current.json`:

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
```

Resolution order:

1. If `runtime-current.json` exists and points to a valid installed runtime, use it.
2. Else, fall back to legacy `updates/runtime` for existing installs.
3. During the first successful versioned update, write `runtime-current.json` and stop writing the flat runtime layout.

This keeps old installations bootable and avoids a forced migration before the next successful update.

### Applying an update

Replace the current `runtime_staging -> runtime` flow with:

1. Extract to `updates/runtime_staging_<version>`.
2. Verify required files exist in staging: sidecar binary, `dist/client`, and bootstrap/defaults if expected.
3. Write staging `version.json`.
4. Rename staging to `updates/runtime-v<version>`.
5. Atomically write `runtime-current.json` using temp-file + rename.
6. Remove the zip.
7. Do not remove the previously active version in the update path.

This means the only directory removed during update is stale staging or a non-active target directory known to be safe. The active sidecar directory is not deleted while a child process may still be using it.

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
| `apps/overdare-ai-agent/src/update.rs` | Add versioned install directories, current metadata, active runtime resolution, and legacy fallback. |
| `apps/overdare-ai-agent/src/webserver.rs` | Resolve sidecar, `dist/client`, and `rg` from `current_runtime_dir(env)` instead of hardcoded `updates/runtime`. |
| `apps/overdare-ai-agent/src/init.rs` | Resolve bootstrap/defaults from the current runtime directory instead of hardcoded `updates/runtime`. |
| `apps/overdare-ai-agent/README.md` | Document the versioned update layout and old-version retention behavior. |
| `docs/guide/packaging.md` | Document runtime bundle install layout and active pointer metadata. |

### What does NOT change

- No change to P067 prod/dev storage isolation or `--agent-env` grammar.
- No change to release manifest URL selection, env validation, or pinned-version validation.
- No TypeScript sidecar bundle content change.
- No build-time `sidecar/assets` source path change.
- No symlink/junction requirement in the first implementation.

## File Manifest

### apps/overdare-ai-agent/src/

| File | Action | Description |
|------|--------|-------------|
| `update.rs` | MODIFY | Add `RuntimeCurrent`; replace flat `runtime_dir` usage with current/versioned runtime helpers; install into `runtime-v<version>`; atomically update pointer. |
| `webserver.rs` | MODIFY | Use active runtime resolver for sidecar binary, `dist/client`, and optional `rg`. Update error messages so they do not promise `updates/runtime`. |
| `init.rs` | MODIFY | Use active runtime resolver for `bootstrap` / legacy `defaults` lookup. |

### apps/overdare-ai-agent/

| File | Action | Description |
|------|--------|-------------|
| `README.md` | MODIFY | Explain versioned runtime directories, active metadata, and retention/cleanup expectations. |

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

### Task 3: Move launcher/init path resolution to active runtime

**Files:** `apps/overdare-ai-agent/src/webserver.rs`, `apps/overdare-ai-agent/src/init.rs`, `apps/overdare-ai-agent/src/update.rs`

Export a path resolver from `update.rs` and use it in:

- `resolve_updated_sidecar_path`
- `resolve_updated_dist_dir`
- `resolve_updated_rg_bin`
- `resolve_updated_bootstrap_dir`

Keep the legacy fallback in the resolver, not duplicated in each call site.

**Verify:** Existing start/init tests should pass; add focused tests if the Rust crate already has test coverage around path resolution.

### Task 4: Add retention cleanup outside the critical update swap

**Files:** `apps/overdare-ai-agent/src/update.rs`

Add conservative cleanup after the pointer is updated, not before. Keep at least the current version and one previous version. On Windows lock errors, log and skip cleanup rather than failing the update.

```rust
fn cleanup_old_runtimes(env: Env, keep_versions: &[String], log: &mut String) {
    // Best effort only. Never remove current_runtime_dir(env).
}
```

**Verify:** Cleanup failure does not make `run_with_progress` return an update failure after a successful pointer switch.

### Task 5: Document the new install contract

**Files:** `apps/overdare-ai-agent/README.md`, `docs/guide/packaging.md`

Document:

- `updates/runtime-current.json` is the source of truth for active runtime.
- `updates/runtime` is legacy fallback only.
- Runtime bundles still contain the same internal paths.
- Old version directories may remain temporarily and are cleaned best-effort.

**Verify:** Docs mention both prod and dev roots.

## Acceptance Criteria

1. Updating from vN to vN+1 does not remove the vN runtime directory during the apply step.
2. `start` launches the sidecar from the directory selected by `runtime-current.json`.
3. `init` deploys bootstrap assets from the active runtime directory.
4. Existing flat `updates/runtime` installs still launch when no pointer exists.
5. SHA mismatch for an existing version directory is rejected or handled without silently reusing stale content.
6. Cleanup of old runtime directories is best-effort and cannot fail an otherwise successful update.

## Testing Strategy

| Category | What to Test | How |
|----------|--------------|-----|
| Unit | Pointer parsing, relative-dir validation, legacy fallback | Rust tests with temp home. |
| Unit | Update finalization preserves old runtime | Temp updates root with fake sidecar/dist layout. |
| Integration | `init` and `start` resolve active runtime | Existing Rust command tests or focused resolver tests. |
| Manual Windows | Update while old `diligent-web-server.exe` is running | Start old sidecar, run `init` or update flow, verify no lock failure from deleting active dir. |

## Risk Areas

| Risk | Impact | Mitigation |
|------|--------|------------|
| Pointer file corrupted | Agent cannot find active runtime | Validate pointer and fall back to legacy `updates/runtime`; show clear repair message if neither works. |
| Same version republished with different SHA | Stale directory may be reused | Compare target `version.json.sha256` with manifest SHA and reject/reinstall safely. |
| Old versions accumulate | Disk growth | Best-effort retention after successful pointer switch. |
| Windows symlink/junction limitations | Launch failures if symlink is required | Do not require symlink in first implementation; use JSON pointer. |
| Bootstrap path drift | Init deploys stale defaults | Resolve bootstrap from the same active runtime directory used by start. |

## Decisions Referenced

| ID | Summary | Where Used |
|----|---------|------------|
| P067 | OVERDARE prod/dev env split and version pinning | Preserve env-specific update roots and manifest validation. |
