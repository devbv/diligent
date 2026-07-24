use std::fmt::Write as FmtWrite;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::env::{is_valid_pinned_version, manifest_url_for, Env, EnvSelection};
use crate::storage::{global_legacy_storage_dir, global_storage_dir};

const BUNDLED_RUNTIME_VERSION: &str = match option_env!("DILIGENT_RUNTIME_VERSION") {
    Some(v) => v,
    None => "0.0.0-dev",
};

#[derive(Debug, Deserialize, Serialize)]
struct UpdateManifest {
    version: String,
    #[serde(default)]
    env: Option<String>,
    #[serde(default)]
    platforms: std::collections::HashMap<String, PlatformBundle>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct PlatformBundle {
    url: String,
    sha256: String,
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InstalledVersion {
    pub version: String,
    pub applied_at: String,
    pub sha256: String,
}

/// Failure classification behind the machine-readable init lines
/// (`ERROR_CODE=` / `FALLBACK_REASON=`, P077 P4). Buckets answer "what should
/// the consumer do", not "what exactly happened" — details stay in the
/// human-readable message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureKind {
    /// Transient network trouble — retrying later is likely to work.
    Network,
    /// Local filesystem / install trouble — check disk space or AV locks.
    Disk,
    /// Download stayed corrupt across retries — a release-side problem.
    Verify,
    /// Manifest invalid or mismatched — a release-pipeline/config problem;
    /// retrying fails the same way.
    Manifest,
}

impl FailureKind {
    pub fn code(self) -> i32 {
        match self {
            FailureKind::Network => 10,
            FailureKind::Disk => 20,
            FailureKind::Verify => 21,
            FailureKind::Manifest => 30,
        }
    }
}

#[derive(Debug)]
pub struct UpdateError {
    pub kind: FailureKind,
    pub message: String,
}

impl UpdateError {
    fn network(message: impl Into<String>) -> Self {
        UpdateError {
            kind: FailureKind::Network,
            message: message.into(),
        }
    }

    fn verify(message: impl Into<String>) -> Self {
        UpdateError {
            kind: FailureKind::Verify,
            message: message.into(),
        }
    }

    fn manifest(message: impl Into<String>) -> Self {
        UpdateError {
            kind: FailureKind::Manifest,
            message: message.into(),
        }
    }
}

/// Untagged String errors inside the update path are filesystem/install work
/// (write, extract, rename, pointer) — everything network/manifest/verify is
/// tagged explicitly at its source.
impl From<String> for UpdateError {
    fn from(message: String) -> Self {
        UpdateError {
            kind: FailureKind::Disk,
            message,
        }
    }
}

impl From<&str> for UpdateError {
    fn from(message: &str) -> Self {
        UpdateError::from(message.to_string())
    }
}

#[derive(Debug, Clone)]
pub enum UpdateProgress {
    Disabled,
    BootstrapRequired,
    Checking { current_version: String },
    Downloading { target_version: String },
    Verifying { target_version: String },
    Extracting { target_version: String },
    Applying { target_version: String },
    UpToDate,
    Updated { target_version: String },
}

struct FetchedUpdate {
    version: String,
    sha256: String,
    bytes: Vec<u8>,
}

struct LocalBundle {
    env: Env,
    version: String,
}

/// What an update check resolved to, before any destructive filesystem work.
enum UpdateOutcome {
    /// The active runtime already matches the manifest — nothing to do.
    UpToDate,
    /// The manifest version is already installed on disk in its versioned dir,
    /// just not the active pointer. Reuse it: no download, no delete — only
    /// switch the pointer.
    ReuseInstalled { version: String, sha256: String },
    /// A fresh bundle was downloaded and must be installed.
    Fetched(FetchedUpdate),
}

fn updates_dir(env: Env) -> Option<PathBuf> {
    global_storage_dir(env).map(|g| g.join("updates"))
}

/// Per-process staging dir. Keyed by `token` (the process id) so two concurrent
/// updates of the same version never share — and clobber — one extract dir.
fn staging_dir(updates: &Path, version: &str, token: u32) -> PathBuf {
    updates.join(format!("runtime_staging_{version}_{token}"))
}

/// Per-process bundle zip path, isolated by `token` for the same reason as
/// `staging_dir`: concurrent downloads of the same version must not write the
/// same file.
fn bundle_zip_path(updates: &Path, version: &str, platform: &str, token: u32) -> PathBuf {
    updates.join(format!("runtime-bundle-{version}-{platform}-{token}.zip"))
}

/// Crash-orphaned update scratch older than this is reclaimed at update start.
const SCRATCH_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Total wall-clock budget for init's network work (manifest fetch + bundle
/// download) when a bootable runtime already exists to fall back to. Must stay
/// comfortably below Studio's init monitor timeout (60 s) so the fallback exit
/// lands before Studio gives up on init entirely (P077).
const DEFAULT_INIT_NETWORK_BUDGET_SECS: u64 = 45;

fn init_network_budget() -> Duration {
    let secs = nonempty_env("DILIGENT_INIT_NETWORK_BUDGET_SECS")
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .unwrap_or(DEFAULT_INIT_NETWORK_BUDGET_SECS);
    Duration::from_secs(secs)
}

/// Network deadline for this init run. `Some` only when a bootable runtime is
/// already installed — the fallback target. Bootstrap installs (no runtime
/// yet) are never budget-limited: there is nothing to fall back to, and a
/// first download legitimately takes longer than any sane budget.
pub fn init_network_deadline(env: Env) -> Option<Instant> {
    runtime_installed(env).then(|| Instant::now() + init_network_budget())
}

/// Time left before `deadline`. `Err` once the budget is exhausted — callers
/// abort their network work so init can fall back to the installed runtime.
fn remaining_budget(deadline: Option<Instant>) -> Result<Option<Duration>, String> {
    let Some(deadline) = deadline else {
        return Ok(None);
    };
    let now = Instant::now();
    if now >= deadline {
        return Err(
            "init network budget exhausted (override with DILIGENT_INIT_NETWORK_BUDGET_SECS)"
                .to_string(),
        );
    }
    Ok(Some(deadline - now))
}

/// Freshly modified runtime-v* dirs are exempt from cleanup: a concurrent
/// process may have renamed its staging in but not yet written its pointer,
/// so the dir is neither "current" nor probe-detectably in use.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
const CLEANUP_GRACE: Duration = Duration::from_secs(10 * 60);

/// Best-effort reclaim of this process's scratch after a failed install. The
/// install error that brought us here must surface unchanged, but a removal
/// failure (e.g. an AV lock on a freshly extracted file) is logged so an
/// orphaned multi-hundred-MB dir stays diagnosable.
fn discard_transient_install(staging: &Path, zip: &Path, log: &mut String) {
    for (label, result) in [
        ("staging", fs::remove_dir_all(staging)),
        ("bundle zip", fs::remove_file(zip)),
    ] {
        if let Err(e) = result {
            if e.kind() != std::io::ErrorKind::NotFound {
                let _ = writeln!(
                    log,
                    "[update] Failed to discard {label} after failed install: {e}"
                );
            }
        }
    }
}

/// Best-effort reclaim of crash-orphaned update scratch: staging dirs, bundle
/// zips, and pointer temp files older than `max_age`. Per-process (pid-keyed)
/// names never self-heal via a later run reusing the path — a SIGKILL
/// mid-install would otherwise leak a full extracted runtime forever. Also
/// reclaims pre-isolation shared-name leftovers from older launcher versions.
/// The age guard protects the scratch of live concurrent updates (minutes old
/// at most). Never touches `runtime-v*`, the legacy `runtime` dir, or the
/// pointer itself.
fn sweep_stale_scratch(env: Env, max_age: Duration, log: &mut String) {
    let Some(updates) = updates_dir(env) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&updates) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let is_scratch = name.starts_with("runtime_staging_")
            || (name.starts_with("runtime-bundle-") && name.ends_with(".zip"))
            || (name.starts_with("runtime-current.json.") && name.ends_with(".tmp"));
        if !is_scratch {
            continue;
        }
        let path = entry.path();
        // Only reclaim when the age is known to exceed max_age — unknown
        // mtimes are kept (conservative for a destructive sweep).
        let old_enough = path
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age >= max_age);
        if !old_enough {
            continue;
        }
        let result = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        match result {
            Ok(()) => {
                let _ = writeln!(log, "[update] Swept stale update scratch {name}");
            }
            Err(e) => {
                let _ = writeln!(log, "[update] Failed to sweep stale scratch {name}: {e}");
            }
        }
    }
}

/// Legacy flat runtime directory (`updates/runtime`). Kept as a fallback for
/// installs that predate the versioned layout.
fn legacy_runtime_dir(env: Env) -> Option<PathBuf> {
    updates_dir(env).map(|u| u.join("runtime"))
}

/// Versioned runtime directory for a specific version, e.g.
/// `updates/runtime-v1.2.3`.
fn runtime_version_dir(env: Env, version: &str) -> Option<PathBuf> {
    updates_dir(env).map(|u| u.join(format!("runtime-v{version}")))
}

/// Path to the active-version pointer file (`updates/runtime-current.json`).
fn runtime_current_metadata_path(env: Env) -> Option<PathBuf> {
    updates_dir(env).map(|u| u.join("runtime-current.json"))
}

fn sidecar_bin_name() -> &'static str {
    if cfg!(windows) {
        "diligent-web-server.exe"
    } else {
        "diligent-web-server"
    }
}

/// A directory has a usable runtime layout when it contains both the sidecar
/// binary and the bundled web client.
fn runtime_layout_exists(dir: &Path) -> bool {
    dir.join(sidecar_bin_name()).exists() && dir.join("dist/client").exists()
}

/// A directory is a *complete* install of `version` when it has the runtime
/// layout AND its version.json records that exact version. This separates a
/// genuine installed runtime — which a running agent may hold open and must
/// never be deleted — from a broken/mislabeled leftover of an interrupted
/// update, which is safe to clear.
fn is_complete_install(dir: &Path, version: &str) -> bool {
    runtime_layout_exists(dir) && installed_version_at(dir).is_some_and(|v| v.version == version)
}

/// Active-version pointer. Holds exactly one version — the one the next
/// no-pin `start` launches. It is not a list and does not track previous
/// versions; on-disk directories and live processes are the source of truth
/// for "what exists" and "what is running".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeCurrent {
    pub version: String,
    pub dir: String,
    pub sha256: String,
    pub updated_at: String,
}

/// Reject a pointer `dir` that is not a bare directory name. This blocks path
/// traversal and absolute paths from steering runtime resolution outside the
/// updates root.
fn is_valid_pointer_dir(dir: &str) -> bool {
    !dir.is_empty()
        && !dir.contains('/')
        && !dir.contains('\\')
        && !dir.split(['/', '\\']).any(|c| c == "..")
        && dir != "."
        && dir != ".."
}

/// Read and validate the active pointer. Returns `Ok(None)` when the file is
/// absent (a fresh or legacy install). A malformed or out-of-bounds pointer is
/// an error so callers can decide whether to fall back to the legacy layout.
fn read_runtime_current(env: Env) -> Result<Option<RuntimeCurrent>, String> {
    let path = match runtime_current_metadata_path(env) {
        Some(p) => p,
        None => return Ok(None),
    };
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read runtime-current.json: {e}")),
    };
    let parsed: RuntimeCurrent = serde_json::from_str(&content)
        .map_err(|e| format!("parse runtime-current.json: {e}"))?;
    if !is_valid_pointer_dir(&parsed.dir) {
        return Err(format!(
            "runtime-current.json points at an invalid dir: {}",
            parsed.dir
        ));
    }
    Ok(Some(parsed))
}

/// Atomically write the active pointer via temp-file + rename so a crash
/// mid-write never leaves a half-written pointer. The temp name is unique per
/// writer (pid + in-process counter): with one shared temp, two concurrent
/// writers race — the loser's rename fails ENOENT, or the winner publishes the
/// other writer's (possibly still-being-written) bytes.
fn write_runtime_current_atomic(env: Env, current: &RuntimeCurrent) -> Result<(), String> {
    static WRITE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let path =
        runtime_current_metadata_path(env).ok_or("cannot resolve runtime-current.json path")?;
    let tmp = path.with_file_name(format!(
        "runtime-current.json.{}-{}.tmp",
        std::process::id(),
        WRITE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let json = serde_json::to_string_pretty(current)
        .map(|json| format!("{json}\n"))
        .map_err(|e| format!("serialize runtime-current.json: {e}"))?;
    fs::write(&tmp, json).map_err(|e| format!("write runtime-current.json.tmp: {e}"))?;
    retry_fs_op("finalize runtime-current.json", || fs::rename(&tmp, &path))?;
    Ok(())
}

/// Resolve the active runtime directory used by no-pin `start` and by `init`.
///
/// Order: valid pointer with a usable layout -> legacy flat `updates/runtime`.
/// A corrupt or stale pointer falls through to the legacy layout rather than
/// failing, so an existing install stays bootable.
pub fn current_runtime_dir(env: Env) -> Option<PathBuf> {
    if let Some(current) = read_runtime_current(env).ok().flatten() {
        let dir = updates_dir(env)?.join(&current.dir);
        if runtime_layout_exists(&dir) {
            return Some(dir);
        }
    }
    let legacy = legacy_runtime_dir(env)?;
    runtime_layout_exists(&legacy).then_some(legacy)
}

/// A freshly extracted bundle must contain the sidecar and web client before we
/// promote it to a versioned runtime directory.
fn validate_runtime_layout(dir: &Path) -> Result<(), String> {
    if runtime_layout_exists(dir) {
        Ok(())
    } else {
        Err(format!(
            "runtime bundle is missing the sidecar binary or dist/client under {}",
            dir.display()
        ))
    }
}

/// Records a validated staging directory as an installed runtime and makes it
/// active. Both downloaded and locally supplied bundles use this exact
/// promotion path so their on-disk contract cannot diverge.
fn install_staged_runtime(env: Env, version: &str, sha256: &str, staging: &Path) -> Result<(), String> {
    validate_runtime_layout(staging)?;
    let version_info = InstalledVersion {
        version: version.to_string(),
        applied_at: chrono::Local::now().to_rfc3339(),
        sha256: sha256.to_string(),
    };
    fs::write(
        staging.join("version.json"),
        serde_json::to_string_pretty(&version_info)
            .map(|json| format!("{json}\n"))
            .map_err(|e| format!("serialize version info: {e}"))?,
    )
    .map_err(|e| format!("write staging version.json: {e}"))?;
    finalize_runtime_install(env, version, sha256, staging)
}

/// Promote a validated staging directory to `runtime-v<version>` beside the
/// active runtime, then atomically switch the pointer. The previously active
/// version is never removed here — only stale, non-active leftovers are.
///
/// Rename-first: apart from a fast-path shortcut, the target is only ever
/// inspected AFTER a failed rename — i.e. after any concurrent winner's rename
/// has landed — so the inspection always sees the truth. A check-then-act
/// order here let a concurrent same-version install make the loser error out,
/// or worse, remove_dir_all a target the winner had just completed.
fn finalize_runtime_install(
    env: Env,
    version: &str,
    sha256: &str,
    staging: &Path,
) -> Result<(), String> {
    let updates = updates_dir(env).ok_or("cannot resolve updates dir")?;
    let target_name = format!("runtime-v{version}");
    let target = updates.join(&target_name);

    if is_complete_install(&target, version) {
        // Fast path: an already-complete install of this same version (a
        // re-publish, a rollback re-serve, or a concurrent install that
        // finished first). It may be in use by a running sidecar — that is
        // exactly what a complete on-disk runtime is — so never delete it:
        // drop the redundant staging and just (re)point below.
        let _ = fs::remove_dir_all(staging);
    } else {
        const ATTEMPTS: usize = 3;
        for attempt in 1..=ATTEMPTS {
            match retry_fs_op("move staging to versioned runtime", || {
                fs::rename(staging, &target)
            }) {
                Ok(()) => break,
                // Lost a same-version race: a concurrent install completed
                // the target between our check and our rename. Converge —
                // keep the winner, drop our identical staging.
                Err(_) if is_complete_install(&target, version) => {
                    let _ = fs::remove_dir_all(staging);
                    break;
                }
                Err(e) => {
                    if !target.exists() || attempt == ATTEMPTS {
                        return Err(e);
                    }
                    // A broken/incomplete leftover blocks the rename (nothing
                    // can be running from it). Claim it ASIDE atomically
                    // instead of deleting in place: only one concurrent
                    // process wins this rename, so a completed install that
                    // lands in the same window is never destroyed. The trash
                    // name matches the scratch sweep pattern, so a crash here
                    // is reclaimed later.
                    let trash = updates.join(format!(
                        "runtime_staging_stale-{version}-{}",
                        std::process::id()
                    ));
                    if fs::rename(&target, &trash).is_ok() {
                        let _ = fs::remove_dir_all(&trash);
                    }
                    // Target is now free (or a concurrent winner renamed in —
                    // the next attempt converges above).
                }
            }
        }
    }

    write_runtime_current_atomic(
        env,
        &RuntimeCurrent {
            version: version.to_string(),
            dir: target_name,
            sha256: sha256.to_string(),
            updated_at: chrono::Local::now().to_rfc3339(),
        },
    )
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// One-time migration for installs created before the versioned layout.
///
/// When no pointer exists yet but a legacy flat `updates/runtime` is present,
/// copy it into `runtime-v<version>` and write the pointer so versioned and
/// pinned launches resolve. We copy (not move) so a sidecar still running from
/// the flat directory is never disturbed. Best-effort: any failure is logged and
/// ignored — the no-pin legacy fallback keeps the agent bootable either way.
fn migrate_flat_runtime_if_needed(env: Env, log: &mut String) {
    // Already on the versioned layout?
    if runtime_current_metadata_path(env)
        .map(|p| p.exists())
        .unwrap_or(false)
    {
        return;
    }
    let Some(legacy) = legacy_runtime_dir(env) else {
        return;
    };
    if !runtime_layout_exists(&legacy) {
        return; // nothing to migrate (fresh install or no flat runtime)
    }
    let Some(installed) = installed_version_at(&legacy) else {
        let _ = writeln!(
            log,
            "[update] Skipping flat-runtime migration: legacy runtime has no readable version.json"
        );
        return;
    };
    let version = installed.version.trim().to_string();
    if version.is_empty() {
        return;
    }
    let Some(target) = runtime_version_dir(env, &version) else {
        return;
    };

    if !runtime_layout_exists(&target) {
        // Clear any incomplete leftover before copying.
        if target.exists() {
            let _ = fs::remove_dir_all(&target);
        }
        if let Err(e) = copy_dir_recursive(&legacy, &target) {
            let _ = fs::remove_dir_all(&target);
            let _ = writeln!(log, "[update] Flat-runtime migration copy failed: {e}");
            return;
        }
    }

    let current = RuntimeCurrent {
        version: version.clone(),
        dir: format!("runtime-v{version}"),
        sha256: installed.sha256.clone(),
        updated_at: chrono::Local::now().to_rfc3339(),
    };
    if let Err(e) = write_runtime_current_atomic(env, &current) {
        let _ = writeln!(
            log,
            "[update] Flat-runtime migration pointer write failed: {e}"
        );
        return;
    }
    let _ = writeln!(log, "[update] Migrated flat runtime to runtime-v{version}");
}

/// All installed `runtime-v*` directories except the active one. In-use
/// filtering is applied separately and is platform-specific. The legacy flat
/// `runtime` directory is never a candidate.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn cleanup_candidate_dirs(env: Env, grace: Duration) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let updates = match updates_dir(env) {
        Some(u) => u,
        None => return out,
    };
    let current = current_runtime_dir(env);
    let entries = match fs::read_dir(&updates) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let is_versioned = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("runtime-v"))
            .unwrap_or(false);
        if !is_versioned {
            continue;
        }
        if current.as_deref() == Some(path.as_path()) {
            continue;
        }
        // Skip dirs modified within the grace window: a concurrent process may
        // have just renamed its staging here and not yet written its pointer —
        // the dir is neither "current" nor probe-detectably in use in that
        // window. ponytail: mtime grace instead of a cross-process lock; an
        // old idle pinned version outside the window still needs the lock-file
        // design if that ever matters.
        let fresh = path
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age < grace);
        if fresh {
            continue;
        }
        out.push(path);
    }
    out
}

/// Windows in-use probe: open the sidecar binary with an exclusive (no-share)
/// handle. A running process holds the image open, so the exclusive open fails
/// with a sharing violation — report in-use. Any other open error is also
/// treated as in-use so cleanup stays conservative (best-effort).
#[cfg(windows)]
fn runtime_in_use(dir: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    let bin = dir.join(sidecar_bin_name());
    if !bin.exists() {
        return false;
    }
    fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&bin)
        .is_err()
}

/// Best-effort cleanup of idle, non-active runtime directories. Runs after the
/// pointer switch and never fails the update. Never deletes the active runtime
/// or a version still in use.
///
/// Windows uses a probe-before-delete check (exclusive-open) and skips the whole
/// directory if the version is in use — `remove_dir_all` is not atomic, so
/// starting to delete and hitting a lock partway through could corrupt a dir.
/// mac/Linux are not targeted by Studio yet; POSIX allows unlinking files held
/// by a running process, so destructive cleanup is intentionally not run there
/// until explicit in-use detection exists.
fn cleanup_old_runtimes(env: Env, log: &mut String) {
    #[cfg(not(windows))]
    {
        let _ = (env, log);
    }
    #[cfg(windows)]
    {
        for path in cleanup_candidate_dirs(env, CLEANUP_GRACE) {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("<runtime>")
                .to_string();
            if runtime_in_use(&path) {
                let _ = writeln!(log, "[update] Keeping in-use runtime {name}");
                continue;
            }
            match fs::remove_dir_all(&path) {
                Ok(_) => {
                    let _ = writeln!(log, "[update] Removed old runtime {name}");
                }
                Err(e) => {
                    let _ = writeln!(log, "[update] Skipped cleanup of {name}: {e}");
                }
            }
        }
    }
}

fn current_platform() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "darwin-arm64";
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "darwin-x64";
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "linux-x64";
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return "linux-arm64";
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "windows-x64";
}

fn strip_jsonc_line_comment(line: &str) -> &str {
    let mut in_string = false;
    let mut escape_next = false;
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if escape_next {
            escape_next = false;
            i += 1;
            continue;
        }
        match chars[i] {
            '\\' if in_string => escape_next = true,
            '"' => in_string = !in_string,
            '/' if !in_string && i + 1 < chars.len() && chars[i + 1] == '/' => {
                let byte_offset = line
                    .char_indices()
                    .nth(i)
                    .map(|(b, _)| b)
                    .unwrap_or(line.len());
                return &line[..byte_offset];
            }
            _ => {}
        }
        i += 1;
    }
    line
}

fn read_jsonc_file(path: &Path) -> Option<serde_json::Value> {
    let content = fs::read_to_string(path).ok()?;
    let stripped: String = content
        .lines()
        .map(strip_jsonc_line_comment)
        .collect::<Vec<_>>()
        .join("\n");
    serde_json::from_str::<serde_json::Value>(&stripped).ok()
}

fn read_user_config_json(env: Env) -> Option<serde_json::Value> {
    let path = global_storage_dir(env)?.join("config.jsonc");
    read_jsonc_file(&path)
}

fn read_legacy_user_config_json() -> Option<serde_json::Value> {
    // Pre-P067 admin policy lived in ~/.diligent/config.jsonc. For prod runs
    // the migration moves that file into ~/.overdare/. For dev runs migration
    // is SkippedByPolicy, so the legacy directory remains and the policy
    // must still apply — otherwise a pre-existing "updateMode: disabled"
    // opt-out is silently bypassed the first time a user passes --agent-env=dev.
    let path = global_legacy_storage_dir()?.join("config.jsonc");
    read_jsonc_file(&path)
}

fn extract_update_mode_disabled(value: &serde_json::Value) -> Option<bool> {
    value
        .get("updateMode")
        .and_then(|v| v.as_str())
        .map(|s| s == "disabled")
}

fn is_update_disabled(env: Env) -> bool {
    // Env-specific config wins. If absent, honor the legacy admin policy so
    // dev installs respect an existing pre-P067 opt-out.
    if let Some(value) = read_user_config_json(env) {
        if let Some(disabled) = extract_update_mode_disabled(&value) {
            return disabled;
        }
    }
    read_legacy_user_config_json()
        .as_ref()
        .and_then(extract_update_mode_disabled)
        .unwrap_or(false)
}

fn nonempty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().and_then(|raw| {
        let trimmed = raw.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn resolve_manifest_url(selection: &EnvSelection) -> String {
    // 1) Env-specific runtime override (`DILIGENT_UPDATE_URL_PROD` /
    //    `DILIGENT_UPDATE_URL_DEV`). Lets an operator point one channel at a
    //    mirror without disturbing the other — the previous single override
    //    silently routed dev requests to a prod-shaped URL.
    let env_key = format!(
        "DILIGENT_UPDATE_URL_{}",
        selection.env.as_str().to_ascii_uppercase()
    );
    if let Some(url) = nonempty_env(&env_key) {
        return url;
    }
    // 2) Generic runtime override (legacy escape-hatch, env-agnostic). The
    //    manifest's `env` field is the validator: a mismatched override is
    //    rejected loudly by validate_manifest_env.
    if let Some(url) = nonempty_env("DILIGENT_UPDATE_URL") {
        return url;
    }
    // 3) Compile-time generic override (legacy P060 packagers).
    if let Some(url) = option_env!("DILIGENT_UPDATE_URL") {
        if !url.is_empty() {
            return url.to_string();
        }
    }
    manifest_url_for(selection)
}

fn runtime_bootstrap_required(env: Env) -> bool {
    // `current_runtime_dir` already enforces the sidecar + dist/client layout
    // (versioned pointer first, legacy flat dir as fallback), so a resolvable
    // active runtime means no bootstrap is required.
    current_runtime_dir(env).is_none()
}

fn should_download_update(
    manifest_version: &str,
    effective_version: &str,
    bootstrap_required: bool,
) -> bool {
    bootstrap_required || manifest_version != effective_version
}

fn is_windows_lock_error(err: &std::io::Error) -> bool {
    #[cfg(windows)]
    {
        err.kind() == std::io::ErrorKind::PermissionDenied
            || matches!(err.raw_os_error(), Some(5) | Some(32))
    }
    #[cfg(not(windows))]
    {
        let _ = err;
        false
    }
}

fn retry_fs_op<T, F>(label: &str, mut op: F) -> Result<T, String>
where
    F: FnMut() -> std::io::Result<T>,
{
    const ATTEMPTS: usize = 8;
    const WAIT_MS: u64 = 350;
    for attempt in 1..=ATTEMPTS {
        match op() {
            Ok(value) => return Ok(value),
            Err(err) => {
                let should_retry = is_windows_lock_error(&err) && attempt < ATTEMPTS;
                if should_retry {
                    thread::sleep(Duration::from_millis(WAIT_MS));
                    continue;
                }
                if is_windows_lock_error(&err) {
                    return Err(format!(
                        "{label}: {err} (file may still be locked by another Diligent process or antivirus scan)"
                    ));
                }
                return Err(format!("{label}: {err}"));
            }
        }
    }
    Err(format!("{label}: unexpected retry state"))
}

pub fn installed_version_at(dir: &Path) -> Option<InstalledVersion> {
    let content = fs::read_to_string(dir.join("version.json")).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn installed_version(env: Env) -> Option<InstalledVersion> {
    installed_version_at(&current_runtime_dir(env)?)
}

/// Resolve the runtime directory `start` should launch from.
///
/// With a pinned version, resolve that exact installed version directory and
/// fail clearly when it is not installed — never fall back to a different
/// version. Without a pin, use the active pointer (then legacy fallback).
pub fn resolve_runtime_dir(selection: &EnvSelection) -> Result<PathBuf, String> {
    let env = selection.env;
    if let Some(version) = selection.pinned_version.as_deref() {
        let dir = runtime_version_dir(env, version).ok_or("cannot resolve updates dir")?;
        if runtime_layout_exists(&dir) {
            return Ok(dir);
        }
        return Err(format!(
            "Pinned runtime v{version} is not installed for env '{env_str}'. Run 'overdare-ai-agent --agent-env={env_str}@{version} init' first.",
            env_str = env.as_str(),
        ));
    }
    current_runtime_dir(env).ok_or_else(|| {
        format!(
            "No runtime installed for env '{env_str}'. Run 'overdare-ai-agent --agent-env={env_str} init' first.",
            env_str = env.as_str(),
        )
    })
}

pub fn runtime_installed(env: Env) -> bool {
    !runtime_bootstrap_required(env)
}

fn report_progress(progress: &mut Option<&mut dyn FnMut(UpdateProgress)>, event: UpdateProgress) {
    if let Some(callback) = progress.as_deref_mut() {
        callback(event);
    }
}

fn validate_manifest_env(manifest: &UpdateManifest, requested: Env) -> Result<(), String> {
    // Normalize the declared field the same way the CLI parses --agent-env (trim +
    // lowercase). A pipeline that writes `"env": "Prod"` or accidentally
    // appends whitespace must not block updates for what is semantically the
    // same value.
    let normalized = manifest
        .env
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase());
    match normalized.as_deref() {
        None | Some("") => match requested {
            Env::Prod => Ok(()),
            Env::Dev => Err(
                "Manifest is missing 'env' field; refusing to install on dev env (no legacy dev releases exist)."
                    .to_string(),
            ),
        },
        Some(declared) => {
            if declared == requested.as_str() {
                Ok(())
            } else {
                Err(format!(
                    "Manifest declares env='{declared}' but agent requested env='{}'. Check --agent-env or DILIGENT_UPDATE_URL.",
                    requested.as_str()
                ))
            }
        }
    }
}

fn validate_pinned_version(
    manifest: &UpdateManifest,
    selection: &EnvSelection,
) -> Result<(), String> {
    let Some(pin) = selection.pinned_version.as_deref() else {
        return Ok(());
    };
    if manifest.version == pin {
        Ok(())
    } else {
        Err(format!(
            "Pinned version '{pin}' but manifest at the pinned URL declares version '{}'. The release may have been retagged or the URL is wrong.",
            manifest.version
        ))
    }
}

/// Classify an HTTP status code into a retryable / terminal bucket.
///
/// Retryable:
///   - 5xx server errors (transient backend issues)
///   - 404, ONLY for the `dev-latest` rolling tag window: the release
///     publish workflow deletes the previous `dev-latest` release before
///     creating the new one, and a 404 during that window is recoverable.
///
/// Terminal: every other 4xx (wrong URL, missing release at a pinned tag,
/// auth/403, malformed request) — repeating will fail the same way.
fn is_retryable_manifest_status(status: reqwest::StatusCode) -> bool {
    status.is_server_error() || status == reqwest::StatusCode::NOT_FOUND
}

const BASE_BACKOFF_MS: u64 = 500;

fn http_client(total_timeout: Option<Duration>) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(format!("overdare-ai-agent/{BUNDLED_RUNTIME_VERSION}"));
    if let Some(timeout) = total_timeout {
        builder = builder.timeout(timeout);
    }
    builder.build().map_err(|e| format!("http client: {e}"))
}

fn fetch_manifest(
    manifest_url: &str,
    deadline: Option<Instant>,
) -> Result<UpdateManifest, UpdateError> {
    // Retry transient failures: network errors, 5xx, 404 (dev-latest swap),
    // and body-read errors (truncated body during CDN swap). Parse errors are
    // terminal because a malformed JSON document does not become valid on
    // retry — repeating it just delays the failure.
    const ATTEMPTS: u32 = 3;
    const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

    let client = http_client(None).map_err(UpdateError::network)?;

    let mut last_err = UpdateError::network("fetch manifest: no attempt ran");
    for attempt in 1..=ATTEMPTS {
        // Cap each attempt at the remaining init budget so retries never push
        // the launcher past the point where the fallback exit stops mattering.
        let timeout = match remaining_budget(deadline) {
            Ok(remaining) => remaining.map_or(REQUEST_TIMEOUT, |r| REQUEST_TIMEOUT.min(r)),
            Err(budget_err) => {
                return Err(UpdateError::network(if attempt == 1 {
                    budget_err
                } else {
                    format!("{budget_err}; last error: {}", last_err.message)
                }));
            }
        };
        let outcome: Result<UpdateManifest, (UpdateError, bool)> = (|| {
            let response = client
                .get(manifest_url)
                .timeout(timeout)
                .send()
                .map_err(|e| (UpdateError::network(format!("fetch manifest: {e}")), true))?;
            let status = response.status();
            if !status.is_success() {
                let retryable = is_retryable_manifest_status(status);
                return Err((
                    UpdateError::network(format!(
                        "fetch manifest failed: HTTP {status} ({manifest_url})"
                    )),
                    retryable,
                ));
            }
            let body = response
                .text()
                .map_err(|e| (UpdateError::network(format!("read manifest body: {e}")), true))?;
            serde_json::from_str::<UpdateManifest>(&body)
                .map_err(|e| (UpdateError::manifest(format!("parse manifest: {e}")), false))
        })();

        match outcome {
            Ok(manifest) => return Ok(manifest),
            Err((err, retryable)) => {
                last_err = err;
                if !retryable || attempt == ATTEMPTS {
                    return Err(last_err);
                }
            }
        }
        thread::sleep(Duration::from_millis(
            BASE_BACKOFF_MS * (1u64 << (attempt - 1)),
        ));
    }
    Err(last_err)
}

pub fn fetch_latest_version(
    selection: &EnvSelection,
    deadline: Option<Instant>,
) -> Result<String, UpdateError> {
    let manifest = fetch_manifest(&resolve_manifest_url(selection), deadline)?;
    validate_manifest_env(&manifest, selection.env).map_err(UpdateError::manifest)?;
    validate_pinned_version(&manifest, selection).map_err(UpdateError::manifest)?;
    Ok(manifest.version)
}

pub fn init_status(
    selection: &EnvSelection,
    deadline: Option<Instant>,
) -> Result<(Option<String>, String), UpdateError> {
    let current = installed_version(selection.env).map(|item| item.version);
    let latest = fetch_latest_version(selection, deadline)?;
    Ok((current, latest))
}

fn fetch_update(
    selection: &EnvSelection,
    manifest_url: &str,
    effective_version: String,
    bootstrap_required: bool,
    deadline: Option<Instant>,
    progress: &mut Option<&mut dyn FnMut(UpdateProgress)>,
) -> Result<UpdateOutcome, UpdateError> {
    let manifest = fetch_manifest(manifest_url, deadline)?;
    validate_manifest_env(&manifest, selection.env).map_err(UpdateError::manifest)?;
    validate_pinned_version(&manifest, selection).map_err(UpdateError::manifest)?;
    if !should_download_update(&manifest.version, &effective_version, bootstrap_required) {
        return Ok(UpdateOutcome::UpToDate);
    }
    // Disk-aware reuse: the target version may already be installed in a
    // versioned dir that simply is not the active pointer — e.g. a rollback, a
    // re-served version, or a version a second agent is currently running.
    // Reuse it instead of re-downloading and overwriting the on-disk copy;
    // that overwrite is exactly what makes an update fail (or corrupt a
    // runtime) while a sidecar still holds it.
    if let Some(dir) = runtime_version_dir(selection.env, &manifest.version) {
        if is_complete_install(&dir, &manifest.version) {
            let sha256 = installed_version_at(&dir)
                .map(|v| v.sha256)
                .unwrap_or_default();
            return Ok(UpdateOutcome::ReuseInstalled {
                version: manifest.version,
                sha256,
            });
        }
    }
    let bundle = manifest
        .platforms
        .get(current_platform())
        .ok_or_else(|| {
            UpdateError::manifest(format!("no bundle for platform {}", current_platform()))
        })?
        .clone();
    report_progress(
        progress,
        UpdateProgress::Downloading {
            target_version: manifest.version.clone(),
        },
    );
    let bytes = download_bundle(&bundle, deadline)?;
    Ok(UpdateOutcome::Fetched(FetchedUpdate {
        version: manifest.version,
        sha256: bundle.sha256,
        bytes,
    }))
}

/// Download the bundle with the same retry policy as `fetch_manifest`
/// (network / 5xx / 404 / truncated body are transient). A SHA256 mismatch is
/// also retried once within the attempt budget — a CDN swap can serve a
/// truncated-but-complete-looking body. The per-request timeout is generous
/// (a bundle is hundreds of MB; the old 30 s total timeout failed legitimate
/// slow downloads) but always capped at the remaining init network budget.
fn download_bundle(
    bundle: &PlatformBundle,
    deadline: Option<Instant>,
) -> Result<Vec<u8>, UpdateError> {
    const ATTEMPTS: u32 = 3;
    const MAX_DOWNLOAD_TIME: Duration = Duration::from_secs(10 * 60);

    let client = http_client(None).map_err(UpdateError::network)?;

    let mut last_err = UpdateError::network("download bundle: no attempt ran");
    for attempt in 1..=ATTEMPTS {
        let timeout = match remaining_budget(deadline) {
            Ok(remaining) => remaining.map_or(MAX_DOWNLOAD_TIME, |r| MAX_DOWNLOAD_TIME.min(r)),
            Err(budget_err) => {
                return Err(UpdateError::network(if attempt == 1 {
                    budget_err
                } else {
                    format!("{budget_err}; last error: {}", last_err.message)
                }));
            }
        };
        let outcome: Result<Vec<u8>, (UpdateError, bool)> = (|| {
            let response = client
                .get(&bundle.url)
                .timeout(timeout)
                .send()
                .map_err(|e| (UpdateError::network(format!("download bundle: {e}")), true))?;
            let status = response.status();
            if !status.is_success() {
                return Err((
                    UpdateError::network(format!("download failed: HTTP {status}")),
                    is_retryable_manifest_status(status),
                ));
            }
            let bytes = response
                .bytes()
                .map_err(|e| (UpdateError::network(format!("read bundle bytes: {e}")), true))?;
            let actual = format!("{:x}", Sha256::digest(&bytes));
            if actual != bundle.sha256 {
                return Err((
                    UpdateError::verify("Downloaded bundle failed SHA256 verification"),
                    true,
                ));
            }
            Ok(bytes.to_vec())
        })();

        match outcome {
            Ok(bytes) => return Ok(bytes),
            Err((err, retryable)) => {
                last_err = err;
                if !retryable || attempt == ATTEMPTS {
                    return Err(last_err);
                }
            }
        }
        thread::sleep(Duration::from_millis(
            BASE_BACKOFF_MS * (1u64 << (attempt - 1)),
        ));
    }
    Err(last_err)
}

fn extract_zip(zip_path: &Path, out_dir: &Path) -> Result<(), String> {
    if out_dir.exists() {
        retry_fs_op("clean extract dir", || fs::remove_dir_all(out_dir))?;
    }
    fs::create_dir_all(out_dir).map_err(|e| format!("create extract dir: {e}"))?;
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("powershell");
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        let status = cmd
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                    zip_path.display().to_string().replace('\'', "''"),
                    out_dir.display().to_string().replace('\'', "''")
                ),
            ])
            .status()
            .map_err(|e| format!("launch Expand-Archive: {e}"))?;
        if !status.success() {
            return Err(format!("Expand-Archive failed with status: {status}"));
        }
    }
    #[cfg(not(windows))]
    {
        let status = std::process::Command::new("unzip")
            .args([
                "-oq",
                &zip_path.to_string_lossy(),
                "-d",
                &out_dir.to_string_lossy(),
            ])
            .status()
            .map_err(|e| format!("launch unzip: {e}"))?;
        if !status.success() {
            return Err(format!("unzip failed with status: {status}"));
        }
    }
    Ok(())
}

/// Parses the ZIP name emitted by `build-overdare-runtime-bundle.ts`.
///
/// The name carries the release environment and version, preventing a dev
/// bundle from being accidentally installed into prod (or vice versa) and
/// ensuring the launcher writes the same versioned layout as a remote update.
fn parse_local_bundle_path(path: &Path) -> Result<LocalBundle, String> {
    let name = path
        .file_name()
        .and_then(|item| item.to_str())
        .ok_or("Local runtime bundle path must end in a UTF-8 file name")?;
    let prefix = "overdare-ai-agent-runtime-";
    let platform_suffix = format!("-{}.zip", current_platform());
    let rest = name
        .strip_prefix(prefix)
        .and_then(|item| item.strip_suffix(&platform_suffix))
        .ok_or_else(|| {
            format!(
                "Local runtime bundle must be named {prefix}<prod|dev>-<version>-{}.zip (got {name})",
                current_platform()
            )
        })?;
    for env in [Env::Prod, Env::Dev] {
        let marker = format!("{}-", env.as_str());
        if let Some(version) = rest.strip_prefix(&marker) {
            if is_valid_pinned_version(version) {
                return Ok(LocalBundle {
                    env,
                    version: version.to_string(),
                });
            }
            return Err(format!("Local runtime bundle has an invalid version: {version}"));
        }
    }
    Err(format!("Local runtime bundle has an invalid release env: {name}"))
}

/// Installs a locally built runtime ZIP without contacting the update manifest
/// or network. The archive must come from the canonical runtime-bundle build
/// script; its env, version, and platform are validated from the filename.
pub fn install_local_bundle(selection: &EnvSelection, bundle_path: &Path) -> Result<String, UpdateError> {
    let bundle = parse_local_bundle_path(bundle_path).map_err(UpdateError::manifest)?;
    if bundle.env != selection.env {
        return Err(UpdateError::manifest(format!(
            "Local bundle env '{}' does not match --agent-env='{}'",
            bundle.env.as_str(),
            selection.env.as_str()
        )));
    }
    if let Some(pinned_version) = selection.pinned_version.as_deref() {
        if pinned_version != bundle.version {
            return Err(UpdateError::manifest(format!(
                "Local bundle version '{}' does not match pinned version '{pinned_version}'",
                bundle.version
            )));
        }
    }
    if !bundle_path.is_file() {
        return Err(UpdateError::from(format!(
            "Local runtime bundle does not exist or is not a file: {}",
            bundle_path.display()
        )));
    }

    let updates = updates_dir(selection.env).ok_or("cannot resolve updates dir")?;
    fs::create_dir_all(&updates).map_err(|e| format!("create updates dir: {e}"))?;
    let token = std::process::id();
    let staging = staging_dir(&updates, &bundle.version, token);
    let sha256 = fs::read(bundle_path)
        .map(|bytes| format!("{:x}", Sha256::digest(&bytes)))
        .map_err(|e| format!("read local runtime bundle: {e}"))?;

    let install = (|| -> Result<(), String> {
        extract_zip(bundle_path, &staging)?;
        install_staged_runtime(selection.env, &bundle.version, &sha256, &staging)
    })();
    if let Err(error) = install {
        let _ = fs::remove_dir_all(&staging);
        return Err(UpdateError::from(error));
    }

    let mut log = String::new();
    cleanup_old_runtimes(selection.env, &mut log);
    if !log.is_empty() {
        eprint!("{log}");
    }
    Ok(bundle.version)
}


pub fn run_with_progress(
    log: &mut String,
    mut progress: Option<&mut dyn FnMut(UpdateProgress)>,
    selection: &EnvSelection,
    deadline: Option<Instant>,
) -> Result<bool, UpdateError> {
    if is_update_disabled(selection.env) {
        let _ = writeln!(log, "[update] auto-update disabled via config");
        report_progress(&mut progress, UpdateProgress::Disabled);
        return Ok(false);
    }

    // Adopt a pre-versioned flat runtime into the versioned layout before
    // deciding anything else, so an already-up-to-date install still gains a
    // pointer and a runtime-v<version> directory (needed for pinned `start`).
    migrate_flat_runtime_if_needed(selection.env, log);

    // Reclaim scratch orphaned by crashed/killed earlier updates before
    // starting new work — per-process names never self-heal on their own.
    sweep_stale_scratch(selection.env, SCRATCH_MAX_AGE, log);

    let bootstrap_required = runtime_bootstrap_required(selection.env);
    if bootstrap_required {
        let _ = writeln!(
            log,
            "[update] Runtime bootstrap required (missing updated runtime)"
        );
        report_progress(&mut progress, UpdateProgress::BootstrapRequired);
    }

    let manifest_url = resolve_manifest_url(selection);
    let effective_version = installed_version(selection.env)
        .map(|v| v.version)
        .unwrap_or_else(|| BUNDLED_RUNTIME_VERSION.to_string());

    report_progress(
        &mut progress,
        UpdateProgress::Checking {
            current_version: effective_version.clone(),
        },
    );
    let _ = writeln!(
        log,
        "[update] Checking for updates (env={}, current: v{effective_version})...",
        selection.env.as_str()
    );

    let fetched = match fetch_update(
        selection,
        &manifest_url,
        effective_version.clone(),
        bootstrap_required,
        deadline,
        &mut progress,
    )? {
        UpdateOutcome::UpToDate => {
            let _ = writeln!(log, "[update] Already up-to-date");
            report_progress(&mut progress, UpdateProgress::UpToDate);
            return Ok(false);
        }
        UpdateOutcome::ReuseInstalled { version, sha256 } => {
            // The version is already installed on disk — make it active by
            // switching the pointer only. No download, no delete, so a running
            // agent holding another version is never disturbed.
            write_runtime_current_atomic(
                selection.env,
                &RuntimeCurrent {
                    version: version.clone(),
                    dir: format!("runtime-v{version}"),
                    sha256,
                    updated_at: chrono::Local::now().to_rfc3339(),
                },
            )?;
            cleanup_old_runtimes(selection.env, log);
            let _ = writeln!(log, "[update] Reusing already-installed runtime v{version}");
            report_progress(
                &mut progress,
                UpdateProgress::Updated {
                    target_version: version,
                },
            );
            return Ok(true);
        }
        UpdateOutcome::Fetched(item) => item,
    };

    let updates = updates_dir(selection.env).ok_or("cannot resolve updates dir")?;
    fs::create_dir_all(&updates).map_err(|e| format!("create updates dir: {e}"))?;

    // Isolate the download/extract scratch by process id so two concurrent
    // updates of the same version (e.g. two Studio launchers started at once
    // when a fresh release drops) never share — and clobber — one another's zip
    // or staging dir. The final `runtime-v<version>` target is still shared, but
    // finalize's is_complete_install guard makes the second finalize converge
    // (discard its staging, keep the winner) rather than corrupt it.
    let token = std::process::id();
    let zip_path = bundle_zip_path(&updates, &fetched.version, current_platform(), token);
    let staging = staging_dir(&updates, &fetched.version, token);

    // Any failure between here and finalize leaves this process's own zip /
    // staging behind. Isolated (per-process) names no longer self-heal via a
    // later run reusing a shared path, so reclaim them explicitly on the way
    // out. ponytail: a hard crash mid-install still orphans one staging dir;
    // sweep stale runtime_staging_*/runtime-bundle-* by age if that accrues.
    let install = (|| -> Result<(), String> {
        report_progress(
            &mut progress,
            UpdateProgress::Verifying {
                target_version: fetched.version.clone(),
            },
        );
        // Verify the in-memory bytes before anything touches disk: no
        // redundant full re-read of the bundle, and a corrupt download is
        // never persisted.
        let actual = format!("{:x}", Sha256::digest(&fetched.bytes));
        if actual != fetched.sha256 {
            return Err("Downloaded bundle failed SHA256 verification".into());
        }
        fs::write(&zip_path, &fetched.bytes).map_err(|e| format!("write bundle: {e}"))?;

        report_progress(
            &mut progress,
            UpdateProgress::Extracting {
                target_version: fetched.version.clone(),
            },
        );
        // One retry absorbs a transient AV/indexer lock on the freshly written
        // zip or extract dir; extract_zip re-creates the staging dir itself so
        // the retry is idempotent. A second failure is terminal.
        if extract_zip(&zip_path, &staging).is_err() {
            thread::sleep(Duration::from_secs(2));
            extract_zip(&zip_path, &staging)?;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for name in ["diligent-web-server", "rg"] {
                let bin = staging.join(name);
                if bin.exists() {
                    let _ = fs::set_permissions(&bin, fs::Permissions::from_mode(0o755));
                }
            }
        }

        report_progress(
            &mut progress,
            UpdateProgress::Applying {
                target_version: fetched.version.clone(),
            },
        );
        // Install beside the active runtime and atomically switch the pointer.
        // The previously active runtime directory is intentionally left in place
        // so a running sidecar is never deleted mid-update.
        install_staged_runtime(selection.env, &fetched.version, &fetched.sha256, &staging)
    })();
    if install.is_err() {
        discard_transient_install(&staging, &zip_path, log);
    }
    install?;
    let _ = fs::remove_file(&zip_path);

    // Best-effort, runs after the pointer switch so it can never fail the
    // update. Reclaims idle old versions; in-use and active dirs are preserved.
    cleanup_old_runtimes(selection.env, log);

    let _ = writeln!(log, "[update] Updated runtime to v{}", fetched.version);
    report_progress(
        &mut progress,
        UpdateProgress::Updated {
            target_version: fetched.version,
        },
    );
    Ok(true)
}
#[cfg(test)]
mod tests {
    use super::{
        is_retryable_manifest_status, is_update_disabled, strip_jsonc_line_comment,
        validate_manifest_env, validate_pinned_version, UpdateManifest,
    };
    use crate::env::{Env, EnvSelection};
    use crate::testutil::with_temp_home;
    use std::fs;
    use std::sync::Mutex;

    fn manifest_with_env(version: &str, env_field: Option<&str>) -> UpdateManifest {
        UpdateManifest {
            version: version.to_string(),
            env: env_field.map(|s| s.to_string()),
            platforms: Default::default(),
        }
    }

    #[test]
    fn strip_jsonc_preserves_url_content() {
        let line = r#"{ "url": "https://example.com" } // comment"#;
        assert_eq!(
            strip_jsonc_line_comment(line),
            r#"{ "url": "https://example.com" } "#
        );
    }

    #[test]
    fn manifest_env_missing_allowed_for_prod() {
        let m = manifest_with_env("1.0.0", None);
        assert!(validate_manifest_env(&m, Env::Prod).is_ok());
    }

    #[test]
    fn manifest_env_missing_rejected_for_dev() {
        let m = manifest_with_env("1.0.0", None);
        let err = validate_manifest_env(&m, Env::Dev).unwrap_err();
        assert!(err.contains("dev"));
    }

    #[test]
    fn manifest_env_match_ok() {
        let m = manifest_with_env("1.0.0", Some("dev"));
        assert!(validate_manifest_env(&m, Env::Dev).is_ok());
    }

    #[test]
    fn manifest_env_match_prod_ok() {
        let m = manifest_with_env("1.0.0", Some("prod"));
        assert!(validate_manifest_env(&m, Env::Prod).is_ok());
    }

    #[test]
    fn manifest_env_mismatch_rejected() {
        let m = manifest_with_env("1.0.0", Some("dev"));
        let err = validate_manifest_env(&m, Env::Prod).unwrap_err();
        assert!(err.contains("env="));
    }

    #[test]
    fn manifest_env_is_case_insensitive_and_trimmed() {
        // Symmetric with the CLI's --agent-env parsing, which lowercases + trims.
        // A pipeline that produces `"Prod"` or `"prod\n"` must not block updates.
        assert!(validate_manifest_env(&manifest_with_env("1.0.0", Some("Prod")), Env::Prod).is_ok());
        assert!(validate_manifest_env(&manifest_with_env("1.0.0", Some("DEV")), Env::Dev).is_ok());
        assert!(validate_manifest_env(&manifest_with_env("1.0.0", Some(" prod ")), Env::Prod).is_ok());
        assert!(validate_manifest_env(&manifest_with_env("1.0.0", Some("\tdev\n")), Env::Dev).is_ok());
    }

    #[test]
    fn manifest_env_blank_treated_as_missing() {
        // Empty/whitespace-only declared env is functionally equivalent to a
        // missing field — same back-compat policy applies.
        assert!(validate_manifest_env(&manifest_with_env("1.0.0", Some("   ")), Env::Prod).is_ok());
        assert!(validate_manifest_env(&manifest_with_env("1.0.0", Some("")), Env::Dev).is_err());
    }

    #[test]
    fn pinned_version_match_ok() {
        let m = manifest_with_env("1.2.3", Some("prod"));
        let sel = EnvSelection::parse("prod@1.2.3").unwrap();
        assert!(validate_pinned_version(&m, &sel).is_ok());
    }

    #[test]
    fn pinned_version_mismatch_rejected() {
        let m = manifest_with_env("1.2.4", Some("prod"));
        let sel = EnvSelection::parse("prod@1.2.3").unwrap();
        let err = validate_pinned_version(&m, &sel).unwrap_err();
        assert!(err.contains("1.2.3"));
        assert!(err.contains("1.2.4"));
    }

    #[test]
    fn pinned_validation_noop_when_no_pin() {
        let m = manifest_with_env("9.9.9", Some("prod"));
        let sel = EnvSelection::latest(Env::Prod);
        assert!(validate_pinned_version(&m, &sel).is_ok());
    }

    #[test]
    fn retry_policy_covers_dev_latest_swap_404() {
        use reqwest::StatusCode;
        // 404 must be retryable to absorb the dev-latest delete-then-create
        // publish window — the inline comment in fetch_manifest documents this.
        assert!(is_retryable_manifest_status(StatusCode::NOT_FOUND));
    }

    #[test]
    fn retry_policy_retries_server_errors() {
        use reqwest::StatusCode;
        assert!(is_retryable_manifest_status(StatusCode::INTERNAL_SERVER_ERROR));
        assert!(is_retryable_manifest_status(StatusCode::BAD_GATEWAY));
        assert!(is_retryable_manifest_status(StatusCode::SERVICE_UNAVAILABLE));
    }

    #[test]
    fn retry_policy_does_not_retry_permanent_4xx() {
        use reqwest::StatusCode;
        // 400/401/403 reflect a wrong URL or credential; retrying just delays
        // the failure.
        assert!(!is_retryable_manifest_status(StatusCode::BAD_REQUEST));
        assert!(!is_retryable_manifest_status(StatusCode::UNAUTHORIZED));
        assert!(!is_retryable_manifest_status(StatusCode::FORBIDDEN));
    }

    #[test]
    fn failure_kind_codes_match_line_protocol_table() {
        use super::{FailureKind, UpdateError};
        assert_eq!(FailureKind::Network.code(), 10);
        assert_eq!(FailureKind::Disk.code(), 20);
        assert_eq!(FailureKind::Verify.code(), 21);
        assert_eq!(FailureKind::Manifest.code(), 30);
        // Untagged String errors in the update path are filesystem/install work.
        assert_eq!(
            UpdateError::from("boom".to_string()).kind,
            FailureKind::Disk
        );
    }

    #[test]
    fn init_network_budget_env_override_and_default() {
        use std::time::Duration;
        // Serialize process-wide env mutation with the other env-touching tests.
        let _guard = crate::testutil::HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("DILIGENT_INIT_NETWORK_BUDGET_SECS");
        assert_eq!(super::init_network_budget(), Duration::from_secs(45));
        std::env::set_var("DILIGENT_INIT_NETWORK_BUDGET_SECS", "90");
        assert_eq!(super::init_network_budget(), Duration::from_secs(90));
        // Zero / garbage fall back to the default rather than disabling the budget.
        std::env::set_var("DILIGENT_INIT_NETWORK_BUDGET_SECS", "0");
        assert_eq!(super::init_network_budget(), Duration::from_secs(45));
        std::env::set_var("DILIGENT_INIT_NETWORK_BUDGET_SECS", "abc");
        assert_eq!(super::init_network_budget(), Duration::from_secs(45));
        std::env::remove_var("DILIGENT_INIT_NETWORK_BUDGET_SECS");
    }

    #[test]
    fn init_network_deadline_only_with_installed_runtime() {
        // Bootstrap (no runtime) must never be budget-limited — there is no
        // fallback target, and a first download can legitimately run long.
        with_temp_home("net-deadline", |home| {
            assert!(super::init_network_deadline(Env::Prod).is_none());

            let runtime = home.join(".overdare/updates/runtime");
            fs::create_dir_all(runtime.join("dist/client")).expect("create dist/client");
            let bin = if cfg!(windows) {
                "diligent-web-server.exe"
            } else {
                "diligent-web-server"
            };
            fs::write(runtime.join(bin), b"#!/bin/sh\n").expect("write sidecar");

            assert!(super::init_network_deadline(Env::Prod).is_some());
        });
    }

    #[test]
    fn remaining_budget_reports_exhaustion() {
        use std::time::{Duration, Instant};
        assert!(super::remaining_budget(None).expect("no deadline").is_none());
        let future = Instant::now() + Duration::from_secs(60);
        assert!(super::remaining_budget(Some(future))
            .expect("not exhausted")
            .is_some());
        if let Some(past) = Instant::now().checked_sub(Duration::from_secs(1)) {
            assert!(super::remaining_budget(Some(past)).is_err());
        }
    }

    #[test]
    fn is_update_disabled_reads_env_specific_config() {
        with_temp_home("env-config", |home| {
            let dir = home.join(".overdare");
            fs::create_dir_all(&dir).expect("create env dir");
            fs::write(
                dir.join("config.jsonc"),
                "{ \"updateMode\": \"disabled\" }\n",
            )
            .expect("write env config");
            assert!(is_update_disabled(Env::Prod));
        });
    }

    #[test]
    fn is_update_disabled_falls_back_to_legacy_when_env_config_missing() {
        with_temp_home("legacy-fallback", |home| {
            // Pre-P067 admin opt-out lives in ~/.diligent/config.jsonc. The
            // dev env has no config of its own (migration is skipped by policy),
            // so without the fallback the legacy policy would be ignored.
            let legacy = home.join(".diligent");
            fs::create_dir_all(&legacy).expect("create legacy dir");
            fs::write(
                legacy.join("config.jsonc"),
                "{ \"updateMode\": \"disabled\" }\n",
            )
            .expect("write legacy config");
            assert!(
                is_update_disabled(Env::Dev),
                "dev should inherit legacy .diligent admin opt-out"
            );
        });
    }

    #[test]
    fn is_update_disabled_env_specific_overrides_legacy() {
        with_temp_home("override-legacy", |home| {
            // Env-specific config takes precedence — admins moving off the
            // legacy file should not be silently overridden by it.
            let env_dir = home.join(".overdare-dev");
            fs::create_dir_all(&env_dir).expect("create env dir");
            fs::write(env_dir.join("config.jsonc"), "{ \"updateMode\": \"enabled\" }\n")
                .expect("write env config");
            let legacy = home.join(".diligent");
            fs::create_dir_all(&legacy).expect("create legacy dir");
            fs::write(legacy.join("config.jsonc"), "{ \"updateMode\": \"disabled\" }\n")
                .expect("write legacy config");
            assert!(
                !is_update_disabled(Env::Dev),
                "env-specific 'enabled' must win over legacy 'disabled'"
            );
        });
    }

    #[test]
    fn is_update_disabled_defaults_false_when_no_config() {
        with_temp_home("no-config", |_home| {
            assert!(!is_update_disabled(Env::Prod));
            assert!(!is_update_disabled(Env::Dev));
        });
    }

    // Serialize env-var mutation across tests that twiddle DILIGENT_UPDATE_URL*.
    static URL_ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_clean_url_env<F: FnOnce()>(f: F) {
        let guard = URL_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for key in [
            "DILIGENT_UPDATE_URL",
            "DILIGENT_UPDATE_URL_PROD",
            "DILIGENT_UPDATE_URL_DEV",
        ] {
            std::env::remove_var(key);
        }
        f();
        for key in [
            "DILIGENT_UPDATE_URL",
            "DILIGENT_UPDATE_URL_PROD",
            "DILIGENT_UPDATE_URL_DEV",
        ] {
            std::env::remove_var(key);
        }
        drop(guard);
    }

    #[test]
    fn env_specific_url_override_beats_generic_one() {
        with_clean_url_env(|| {
            std::env::set_var("DILIGENT_UPDATE_URL", "https://generic.example/m.json");
            std::env::set_var(
                "DILIGENT_UPDATE_URL_DEV",
                "https://dev-mirror.example/m.json",
            );
            let dev = EnvSelection::latest(Env::Dev);
            let prod = EnvSelection::latest(Env::Prod);
            assert_eq!(
                super::resolve_manifest_url(&dev),
                "https://dev-mirror.example/m.json"
            );
            assert_eq!(
                super::resolve_manifest_url(&prod),
                "https://generic.example/m.json"
            );
        });
    }

    #[test]
    fn url_override_falls_through_to_manifest_url_for() {
        with_clean_url_env(|| {
            let prod = EnvSelection::latest(Env::Prod);
            assert!(super::resolve_manifest_url(&prod).contains("update-manifest-prod.json"));
            let dev = EnvSelection::latest(Env::Dev);
            assert!(super::resolve_manifest_url(&dev).contains("update-manifest-dev.json"));
        });
    }

    use super::{
        current_runtime_dir, installed_version, resolve_runtime_dir, runtime_bootstrap_required,
        sidecar_bin_name, write_runtime_current_atomic, RuntimeCurrent,
    };
    use std::path::Path;

    fn write_runtime_layout(dir: &Path, version: &str) {
        fs::create_dir_all(dir.join("dist/client")).expect("create dist/client");
        fs::write(dir.join(sidecar_bin_name()), b"#!/bin/sh\n").expect("write sidecar");
        fs::write(
            dir.join("version.json"),
            format!("{{\"version\":\"{version}\",\"applied_at\":\"t\",\"sha256\":\"deadbeef\"}}\n"),
        )
        .expect("write version.json");
    }

    fn pointer(version: &str) -> RuntimeCurrent {
        RuntimeCurrent {
            version: version.to_string(),
            dir: format!("runtime-v{version}"),
            sha256: "deadbeef".to_string(),
            updated_at: "t".to_string(),
        }
    }

    #[test]
    fn current_runtime_dir_uses_valid_pointer() {
        with_temp_home("current-pointer", |home| {
            let vdir = home.join(".overdare/updates/runtime-v1.2.4");
            write_runtime_layout(&vdir, "1.2.4");
            write_runtime_current_atomic(Env::Prod, &pointer("1.2.4")).expect("write pointer");
            assert_eq!(current_runtime_dir(Env::Prod), Some(vdir));
        });
    }

    #[test]
    fn current_runtime_dir_falls_back_to_legacy_when_no_pointer() {
        with_temp_home("legacy-fallback-dir", |home| {
            let legacy = home.join(".overdare/updates/runtime");
            write_runtime_layout(&legacy, "1.0.0");
            assert_eq!(current_runtime_dir(Env::Prod), Some(legacy));
        });
    }

    #[test]
    fn current_runtime_dir_falls_back_when_pointer_target_missing() {
        with_temp_home("stale-pointer", |home| {
            let updates = home.join(".overdare/updates");
            let legacy = updates.join("runtime");
            write_runtime_layout(&legacy, "1.0.0");
            // Pointer references a version dir that was never installed.
            fs::write(
                updates.join("runtime-current.json"),
                "{\"version\":\"9.9.9\",\"dir\":\"runtime-v9.9.9\",\"sha256\":\"x\",\"updated_at\":\"t\"}\n",
            )
            .expect("write stale pointer");
            assert_eq!(current_runtime_dir(Env::Prod), Some(legacy));
        });
    }

    #[test]
    fn current_runtime_dir_rejects_path_traversal_pointer() {
        with_temp_home("traversal-pointer", |home| {
            let updates = home.join(".overdare/updates");
            fs::create_dir_all(&updates).expect("create updates");
            fs::write(
                updates.join("runtime-current.json"),
                "{\"version\":\"9\",\"dir\":\"../evil\",\"sha256\":\"x\",\"updated_at\":\"t\"}\n",
            )
            .expect("write traversal pointer");
            // No legacy install either -> nothing resolvable, never escapes updates.
            assert_eq!(current_runtime_dir(Env::Prod), None);
        });
    }

    #[test]
    fn installed_version_reads_from_pointer_dir() {
        with_temp_home("installed-version-pointer", |home| {
            let vdir = home.join(".overdare/updates/runtime-v2.0.0");
            write_runtime_layout(&vdir, "2.0.0");
            write_runtime_current_atomic(Env::Prod, &pointer("2.0.0")).expect("write pointer");
            assert_eq!(
                installed_version(Env::Prod).map(|v| v.version),
                Some("2.0.0".to_string())
            );
        });
    }

    #[test]
    fn runtime_bootstrap_required_toggles_with_layout() {
        with_temp_home("bootstrap-required", |home| {
            assert!(runtime_bootstrap_required(Env::Prod));
            let legacy = home.join(".overdare/updates/runtime");
            write_runtime_layout(&legacy, "1.0.0");
            assert!(!runtime_bootstrap_required(Env::Prod));
        });
    }

    #[test]
    fn finalize_install_keeps_previous_version() {
        with_temp_home("finalize-keeps-old", |home| {
            let updates = home.join(".overdare/updates");
            let v1 = updates.join("runtime-v1.0.0");
            write_runtime_layout(&v1, "1.0.0");
            write_runtime_current_atomic(Env::Prod, &pointer("1.0.0")).expect("pointer v1");

            let staging = updates.join("runtime_staging_2.0.0");
            write_runtime_layout(&staging, "2.0.0");
            super::finalize_runtime_install(Env::Prod, "2.0.0", "deadbeef", &staging)
                .expect("finalize v2");

            assert!(v1.exists(), "previous version dir must remain after update");
            assert_eq!(
                current_runtime_dir(Env::Prod),
                Some(updates.join("runtime-v2.0.0"))
            );
            assert!(!staging.exists(), "staging must be consumed");
        });
    }

    #[test]
    fn resolve_runtime_dir_without_pin_uses_pointer() {
        with_temp_home("resolve-no-pin", |home| {
            let updates = home.join(".overdare/updates");
            write_runtime_layout(&updates.join("runtime-v2.0.0"), "2.0.0");
            write_runtime_current_atomic(Env::Prod, &pointer("2.0.0")).expect("pointer v2");
            let sel = EnvSelection::latest(Env::Prod);
            assert_eq!(
                resolve_runtime_dir(&sel).expect("resolve"),
                updates.join("runtime-v2.0.0")
            );
        });
    }

    #[test]
    fn resolve_runtime_dir_with_pin_ignores_pointer() {
        with_temp_home("resolve-pin", |home| {
            let updates = home.join(".overdare/updates");
            write_runtime_layout(&updates.join("runtime-v1.0.0"), "1.0.0");
            write_runtime_layout(&updates.join("runtime-v2.0.0"), "2.0.0");
            // Pointer says v2, but a pinned start for v1 must launch v1.
            write_runtime_current_atomic(Env::Prod, &pointer("2.0.0")).expect("pointer v2");
            let sel = EnvSelection::parse("prod@1.0.0").expect("parse pin");
            assert_eq!(
                resolve_runtime_dir(&sel).expect("resolve pin"),
                updates.join("runtime-v1.0.0")
            );
        });
    }

    #[test]
    fn resolve_runtime_dir_with_missing_pin_errors_without_fallback() {
        with_temp_home("resolve-pin-missing", |home| {
            let updates = home.join(".overdare/updates");
            // A different version is installed and active, but the pin is absent.
            write_runtime_layout(&updates.join("runtime-v2.0.0"), "2.0.0");
            write_runtime_current_atomic(Env::Prod, &pointer("2.0.0")).expect("pointer v2");
            let sel = EnvSelection::parse("prod@9.9.9").expect("parse pin");
            let err = resolve_runtime_dir(&sel).unwrap_err();
            assert!(err.contains("9.9.9"), "error names the missing version: {err}");
            assert!(err.contains("init"), "error tells user to init: {err}");
        });
    }

    #[test]
    fn resolve_runtime_dir_without_install_errors() {
        with_temp_home("resolve-none", |_home| {
            let sel = EnvSelection::latest(Env::Prod);
            assert!(resolve_runtime_dir(&sel).is_err());
        });
    }

    #[test]
    fn migrate_flat_runtime_promotes_and_writes_pointer() {
        with_temp_home("migrate-flat", |home| {
            let updates = home.join(".overdare/updates");
            let legacy = updates.join("runtime");
            write_runtime_layout(&legacy, "0.5.4"); // pre-versioned flat install
            assert!(!updates.join("runtime-current.json").exists());

            let mut log = String::new();
            super::migrate_flat_runtime_if_needed(Env::Prod, &mut log);

            // Versioned dir created with a valid layout, pointer written to it.
            let versioned = updates.join("runtime-v0.5.4");
            assert!(super::runtime_layout_exists(&versioned));
            assert_eq!(current_runtime_dir(Env::Prod), Some(versioned.clone()));
            // Flat runtime left intact (copy, not move) so a running sidecar is safe.
            assert!(legacy.join(sidecar_bin_name()).exists());
            // A pinned start for the installed version now resolves.
            let sel = EnvSelection::parse("prod@0.5.4").expect("parse pin");
            assert_eq!(resolve_runtime_dir(&sel).expect("resolve pin"), versioned);
        });
    }

    #[test]
    fn migrate_flat_runtime_is_noop_when_pointer_exists() {
        with_temp_home("migrate-noop", |home| {
            let updates = home.join(".overdare/updates");
            write_runtime_layout(&updates.join("runtime-v1.0.0"), "1.0.0");
            write_runtime_current_atomic(Env::Prod, &pointer("1.0.0")).expect("pointer");
            // A stale flat runtime is present but must be ignored once migrated.
            write_runtime_layout(&updates.join("runtime"), "0.0.1");

            let mut log = String::new();
            super::migrate_flat_runtime_if_needed(Env::Prod, &mut log);

            assert_eq!(
                current_runtime_dir(Env::Prod),
                Some(updates.join("runtime-v1.0.0"))
            );
            assert!(!updates.join("runtime-v0.0.1").exists());
        });
    }

    #[test]
    fn migrate_flat_runtime_is_noop_without_flat_runtime() {
        with_temp_home("migrate-none", |home| {
            let updates = home.join(".overdare/updates");
            fs::create_dir_all(&updates).expect("create updates");
            let mut log = String::new();
            super::migrate_flat_runtime_if_needed(Env::Prod, &mut log);
            assert!(!updates.join("runtime-current.json").exists());
        });
    }

    #[test]
    fn cleanup_candidates_exclude_current_and_legacy() {
        with_temp_home("cleanup-candidates", |home| {
            let updates = home.join(".overdare/updates");
            write_runtime_layout(&updates.join("runtime-v1.0.0"), "1.0.0");
            write_runtime_layout(&updates.join("runtime-v2.0.0"), "2.0.0");
            // Legacy flat dir is not a runtime-v* candidate.
            write_runtime_layout(&updates.join("runtime"), "0.9.0");
            write_runtime_current_atomic(Env::Prod, &pointer("2.0.0")).expect("pointer v2");

            let mut names: Vec<String> = super::cleanup_candidate_dirs(Env::Prod, std::time::Duration::ZERO)
                .iter()
                .filter_map(|p| p.file_name()?.to_str().map(str::to_string))
                .collect();
            names.sort();
            assert_eq!(names, vec!["runtime-v1.0.0".to_string()]);
        });
    }

    #[test]
    fn cleanup_never_removes_current() {
        with_temp_home("cleanup-keeps-current", |home| {
            let updates = home.join(".overdare/updates");
            write_runtime_layout(&updates.join("runtime-v2.0.0"), "2.0.0");
            write_runtime_current_atomic(Env::Prod, &pointer("2.0.0")).expect("pointer v2");

            let mut log = String::new();
            super::cleanup_old_runtimes(Env::Prod, &mut log);

            assert!(
                updates.join("runtime-v2.0.0").exists(),
                "active runtime must survive cleanup"
            );
            assert_eq!(
                current_runtime_dir(Env::Prod),
                Some(updates.join("runtime-v2.0.0"))
            );
        });
    }

    #[test]
    fn finalize_install_republish_of_current_does_not_wipe_running_dir() {
        with_temp_home("finalize-republish", |home| {
            let updates = home.join(".overdare/updates");
            let v1 = updates.join("runtime-v1.0.0");
            write_runtime_layout(&v1, "1.0.0");
            write_runtime_current_atomic(Env::Prod, &pointer("1.0.0")).expect("pointer v1");
            fs::write(v1.join("sentinel"), b"x").expect("write sentinel");

            let staging = updates.join("runtime_staging_1.0.0");
            write_runtime_layout(&staging, "1.0.0");
            super::finalize_runtime_install(Env::Prod, "1.0.0", "deadbeef", &staging)
                .expect("finalize re-publish");

            assert!(
                v1.join("sentinel").exists(),
                "active dir must not be wiped when the same version is re-published"
            );
            assert!(!staging.exists(), "staging must be consumed");
        });
    }

    #[test]
    fn finalize_install_reuses_existing_valid_noncurrent_version() {
        // Regression: installing a version whose complete dir already exists but
        // is NOT the active pointer (rollback / a version another agent runs)
        // must NOT delete that dir — only switch the pointer to it.
        with_temp_home("finalize-reuse-valid", |home| {
            let updates = home.join(".overdare/updates");
            let v1 = updates.join("runtime-v1.0.0");
            write_runtime_layout(&v1, "1.0.0");
            write_runtime_current_atomic(Env::Prod, &pointer("1.0.0")).expect("pointer v1");

            // v2 is a complete install already present, just not active.
            let v2 = updates.join("runtime-v2.0.0");
            write_runtime_layout(&v2, "2.0.0");
            fs::write(v2.join("sentinel"), b"x").expect("write sentinel");

            let staging = updates.join("runtime_staging_2.0.0");
            write_runtime_layout(&staging, "2.0.0");
            super::finalize_runtime_install(Env::Prod, "2.0.0", "deadbeef", &staging)
                .expect("finalize reuse");

            assert!(
                v2.join("sentinel").exists(),
                "an existing complete install must never be wiped by finalize"
            );
            assert!(!staging.exists(), "staging must be consumed");
            assert_eq!(current_runtime_dir(Env::Prod), Some(v2));
        });
    }

    #[test]
    fn finalize_install_replaces_incomplete_leftover() {
        // The other side of the guard: a broken leftover (invalid layout, so
        // nothing can be running from it) IS replaced by the fresh staging.
        with_temp_home("finalize-leftover", |home| {
            let updates = home.join(".overdare/updates");
            write_runtime_layout(&updates.join("runtime-v1.0.0"), "1.0.0");
            write_runtime_current_atomic(Env::Prod, &pointer("1.0.0")).expect("pointer v1");

            // Broken v2 leftover: sidecar present but no dist/client -> invalid.
            let broken = updates.join("runtime-v2.0.0");
            fs::create_dir_all(&broken).expect("create broken");
            fs::write(broken.join(sidecar_bin_name()), b"x").expect("partial bin");
            assert!(!super::runtime_layout_exists(&broken));

            let staging = updates.join("runtime_staging_2.0.0");
            write_runtime_layout(&staging, "2.0.0");
            super::finalize_runtime_install(Env::Prod, "2.0.0", "deadbeef", &staging)
                .expect("finalize replace");

            assert!(
                super::runtime_layout_exists(&updates.join("runtime-v2.0.0")),
                "broken leftover must be replaced by the valid staging"
            );
            assert!(!staging.exists(), "staging must be consumed");
            assert_eq!(
                current_runtime_dir(Env::Prod),
                Some(updates.join("runtime-v2.0.0"))
            );
        });
    }

    #[test]
    fn staging_and_bundle_paths_are_isolated_per_process() {
        // Two concurrent updates to the SAME new version (e.g. two Studio
        // launchers started at once when a fresh release drops) must NOT share
        // the staging dir or the bundle zip — a shared path lets one process's
        // extract/download clobber the other's in-flight files, aborting the
        // update. Isolation is keyed by a per-process token. (Pure path math —
        // no temp home / global HOME lock needed.)
        let updates = std::path::PathBuf::from("updates");
        assert_ne!(
            super::staging_dir(&updates, "3.0.0", 111),
            super::staging_dir(&updates, "3.0.0", 222),
            "same-version concurrent updates must not share a staging dir"
        );
        assert_ne!(
            super::bundle_zip_path(&updates, "3.0.0", "darwin-arm64", 111),
            super::bundle_zip_path(&updates, "3.0.0", "darwin-arm64", 222),
            "same-version concurrent updates must not share a bundle zip path"
        );
    }

    #[test]
    fn concurrent_same_version_finalize_converges_without_data_loss() {
        // Safety lock: with isolated staging, two processes installing the same
        // new version finalize in sequence. The first becomes the install; the
        // second sees a complete install and discards its own staging without
        // wiping the winner. No file loss either way.
        with_temp_home("concurrent-converge", |home| {
            let updates = home.join(".overdare/updates");
            fs::create_dir_all(&updates).expect("create updates");
            let s1 = super::staging_dir(&updates, "3.0.0", 111);
            let s2 = super::staging_dir(&updates, "3.0.0", 222);
            // Both extracts land on disk at once (as two live processes would).
            write_runtime_layout(&s1, "3.0.0");
            write_runtime_layout(&s2, "3.0.0");
            assert!(s1.exists() && s2.exists(), "isolated stagings coexist");

            super::finalize_runtime_install(Env::Prod, "3.0.0", "deadbeef", &s1)
                .expect("finalize p1");
            assert!(
                super::runtime_layout_exists(&s2),
                "p1's finalize must not disturb p2's in-flight staging"
            );
            let target = updates.join("runtime-v3.0.0");
            fs::write(target.join("sentinel"), b"x").expect("mark winner");
            super::finalize_runtime_install(Env::Prod, "3.0.0", "deadbeef", &s2)
                .expect("finalize p2");

            assert!(
                target.join("sentinel").exists(),
                "the already-installed winner must never be wiped by a second concurrent finalize"
            );
            assert!(!s1.exists() && !s2.exists(), "both stagings consumed");
            assert_eq!(current_runtime_dir(Env::Prod), Some(target));
        });
    }

    #[test]
    fn discard_transient_install_removes_own_scratch_and_nothing_else() {
        // A failed install must reclaim its own (now per-process) staging + zip
        // — and must never disturb the active pointer or an installed runtime.
        with_temp_home("discard-transient", |home| {
            let updates = home.join(".overdare/updates");
            let v1 = updates.join("runtime-v1.0.0");
            write_runtime_layout(&v1, "1.0.0");
            write_runtime_current_atomic(Env::Prod, &pointer("1.0.0")).expect("pointer v1");

            let staging = super::staging_dir(&updates, "3.0.0", 111);
            let zip = super::bundle_zip_path(&updates, "3.0.0", "darwin-arm64", 111);
            write_runtime_layout(&staging, "3.0.0");
            fs::write(&zip, b"zip").expect("write zip");

            let mut log = String::new();
            super::discard_transient_install(&staging, &zip, &mut log);

            assert!(!staging.exists(), "failed-install staging must be removed");
            assert!(!zip.exists(), "failed-install bundle zip must be removed");
            assert!(
                super::runtime_layout_exists(&v1),
                "a failed install must not touch the installed runtime"
            );
            assert_eq!(
                current_runtime_dir(Env::Prod),
                Some(v1),
                "a failed install must not move or clear the active pointer"
            );
        });
    }

    #[test]
    fn concurrent_same_version_finalizes_all_converge() {
        // True concurrency: both processes pass any pre-rename check before
        // either rename lands. The loser must converge on the winner's
        // complete install (drop its own identical staging), never report
        // failure — a check-then-act finalize fails here.
        with_temp_home("concurrent-finalize-race", |home| {
            let updates = home.join(".overdare/updates");
            fs::create_dir_all(&updates).expect("create updates");
            for i in 0..50 {
                let version = format!("9.{i}.0");
                let stagings: Vec<_> = [111u32, 222]
                    .iter()
                    .map(|&t| {
                        let s = super::staging_dir(&updates, &version, t);
                        write_runtime_layout(&s, &version);
                        s
                    })
                    .collect();
                let barrier = std::sync::Barrier::new(stagings.len());
                let results: Vec<Result<(), String>> = std::thread::scope(|scope| {
                    let handles: Vec<_> = stagings
                        .iter()
                        .map(|s| {
                            let (b, v) = (&barrier, &version);
                            scope.spawn(move || {
                                b.wait();
                                super::finalize_runtime_install(Env::Prod, v, "deadbeef", s)
                            })
                        })
                        .collect();
                    handles.into_iter().map(|h| h.join().expect("join")).collect()
                });
                let target = updates.join(format!("runtime-v{version}"));
                assert!(
                    super::is_complete_install(&target, &version),
                    "iter {i}: target must be a complete install"
                );
                for r in &results {
                    assert!(r.is_ok(), "iter {i}: concurrent finalize must converge, got {r:?}");
                }
                for s in &stagings {
                    assert!(!s.exists(), "iter {i}: staging must be consumed");
                }
            }
        });
    }

    #[test]
    fn concurrent_finalizes_over_broken_leftover_converge() {
        // The other entry state: a broken leftover blocks the target name.
        // Both processes must still converge without ever leaving the target
        // missing or incomplete at the end.
        with_temp_home("concurrent-leftover-race", |home| {
            let updates = home.join(".overdare/updates");
            fs::create_dir_all(&updates).expect("create updates");
            for i in 0..50 {
                let version = format!("8.{i}.0");
                let target = updates.join(format!("runtime-v{version}"));
                // Broken leftover: partial binary, no dist/client.
                fs::create_dir_all(&target).expect("create broken");
                fs::write(target.join(sidecar_bin_name()), b"x").expect("partial bin");
                let stagings: Vec<_> = [111u32, 222]
                    .iter()
                    .map(|&t| {
                        let s = super::staging_dir(&updates, &version, t);
                        write_runtime_layout(&s, &version);
                        s
                    })
                    .collect();
                let barrier = std::sync::Barrier::new(stagings.len());
                let results: Vec<Result<(), String>> = std::thread::scope(|scope| {
                    let handles: Vec<_> = stagings
                        .iter()
                        .map(|s| {
                            let (b, v) = (&barrier, &version);
                            scope.spawn(move || {
                                b.wait();
                                super::finalize_runtime_install(Env::Prod, v, "deadbeef", s)
                            })
                        })
                        .collect();
                    handles.into_iter().map(|h| h.join().expect("join")).collect()
                });
                assert!(
                    super::is_complete_install(&target, &version),
                    "iter {i}: broken leftover must end as a complete install"
                );
                for r in &results {
                    assert!(r.is_ok(), "iter {i}: finalize over leftover must converge, got {r:?}");
                }
            }
        });
    }

    #[test]
    fn concurrent_pointer_writes_all_succeed_and_stay_parseable() {
        // The pointer tmp must be per-process: with one shared tmp a writer's
        // rename consumes the other's file (spurious ENOENT) or publishes
        // another process's bytes mid-write.
        with_temp_home("concurrent-pointer-race", |home| {
            fs::create_dir_all(home.join(".overdare/updates")).expect("create updates");
            for i in 0..50 {
                let barrier = std::sync::Barrier::new(2);
                let results: Vec<Result<(), String>> = std::thread::scope(|scope| {
                    let handles: Vec<_> = ["1.0.0", "2.0.0"]
                        .iter()
                        .map(|v| {
                            let b = &barrier;
                            scope.spawn(move || {
                                b.wait();
                                write_runtime_current_atomic(Env::Prod, &pointer(v))
                            })
                        })
                        .collect();
                    handles.into_iter().map(|h| h.join().expect("join")).collect()
                });
                for r in &results {
                    assert!(r.is_ok(), "iter {i}: concurrent pointer writes must succeed, got {r:?}");
                }
                let current = super::read_runtime_current(Env::Prod)
                    .expect("pointer must stay parseable")
                    .expect("pointer must exist");
                assert!(
                    ["1.0.0", "2.0.0"].contains(&current.version.as_str()),
                    "iter {i}: pointer must hold one writer's intact content"
                );
            }
        });
    }

    #[test]
    fn sweep_reclaims_stale_scratch_but_never_installs() {
        with_temp_home("sweep-scratch", |home| {
            let updates = home.join(".overdare/updates");
            // Scratch in both pid-keyed (new) and shared (old launcher) forms.
            let pid_staging = updates.join("runtime_staging_1.0.0_999");
            let old_staging = updates.join("runtime_staging_1.0.0");
            write_runtime_layout(&pid_staging, "1.0.0");
            write_runtime_layout(&old_staging, "1.0.0");
            let pid_zip = updates.join("runtime-bundle-1.0.0-darwin-arm64-999.zip");
            let old_zip = updates.join("runtime-bundle-1.0.0-darwin-arm64.zip");
            fs::write(&pid_zip, b"z").expect("write pid zip");
            fs::write(&old_zip, b"z").expect("write old zip");
            let ptr_tmp = updates.join("runtime-current.json.999.tmp");
            fs::write(&ptr_tmp, b"{}").expect("write ptr tmp");
            // Installs and the pointer must survive any sweep.
            let v1 = updates.join("runtime-v1.0.0");
            let legacy = updates.join("runtime");
            write_runtime_layout(&v1, "1.0.0");
            write_runtime_layout(&legacy, "0.9.0");
            write_runtime_current_atomic(Env::Prod, &pointer("1.0.0")).expect("pointer");

            let mut log = String::new();
            // Zero max-age: everything is old enough — all scratch reclaimed.
            super::sweep_stale_scratch(Env::Prod, std::time::Duration::ZERO, &mut log);
            for gone in [&pid_staging, &old_staging] {
                assert!(!gone.exists(), "stale staging must be swept: {}", gone.display());
            }
            for gone in [&pid_zip, &old_zip, &ptr_tmp] {
                assert!(!gone.exists(), "stale file must be swept: {}", gone.display());
            }
            assert!(super::runtime_layout_exists(&v1), "installed runtime must survive sweep");
            assert!(super::runtime_layout_exists(&legacy), "legacy runtime must survive sweep");
            assert_eq!(current_runtime_dir(Env::Prod), Some(v1), "pointer must survive sweep");

            // Real threshold: freshly created scratch (a live concurrent
            // update) must be kept.
            let fresh = updates.join("runtime_staging_2.0.0_1");
            write_runtime_layout(&fresh, "2.0.0");
            super::sweep_stale_scratch(Env::Prod, super::SCRATCH_MAX_AGE, &mut log);
            assert!(fresh.exists(), "fresh scratch must not be swept");
        });
    }

    #[test]
    fn cleanup_candidates_skip_just_installed_dirs() {
        // A dir modified within the grace window may be a concurrent
        // process's install between its rename and its pointer write — it is
        // neither "current" nor probe-detectably in use, so age is the only
        // available signal.
        with_temp_home("cleanup-grace", |home| {
            let updates = home.join(".overdare/updates");
            write_runtime_layout(&updates.join("runtime-v1.0.0"), "1.0.0");
            write_runtime_layout(&updates.join("runtime-v2.0.0"), "2.0.0");
            write_runtime_current_atomic(Env::Prod, &pointer("2.0.0")).expect("pointer v2");

            // Freshly created v1 is inside the grace window -> not a candidate.
            assert!(
                super::cleanup_candidate_dirs(Env::Prod, super::CLEANUP_GRACE).is_empty(),
                "just-modified dirs must be exempt from cleanup"
            );
            // Zero grace restores the plain non-current filter.
            let names: Vec<String> = super::cleanup_candidate_dirs(Env::Prod, std::time::Duration::ZERO)
                .iter()
                .filter_map(|p| p.file_name()?.to_str().map(str::to_string))
                .collect();
            assert_eq!(names, vec!["runtime-v1.0.0".to_string()]);
        });
    }

    #[test]
    fn is_complete_install_requires_layout_and_matching_version() {
        with_temp_home("complete-install", |home| {
            let dir = home.join(".overdare/updates/runtime-v2.0.0");
            // Missing layout -> not complete.
            assert!(!super::is_complete_install(&dir, "2.0.0"));
            // Valid layout + matching version.json -> complete.
            write_runtime_layout(&dir, "2.0.0");
            assert!(super::is_complete_install(&dir, "2.0.0"));
            // Layout valid but version.json disagrees -> not a complete install
            // of the requested version (mislabeled dir).
            assert!(!super::is_complete_install(&dir, "9.9.9"));
        });
    }

    #[test]
    fn parses_canonical_local_bundle_name() {
        let path = format!(
            "C:/releases/overdare-ai-agent-runtime-dev-1.2.3-{}.zip",
            super::current_platform()
        );
        let bundle = super::parse_local_bundle_path(std::path::Path::new(&path))
            .expect("parse bundle name");

        assert_eq!(bundle.env, Env::Dev);
        assert_eq!(bundle.version, "1.2.3");
    }

    #[test]
    fn install_staged_runtime_writes_version_and_activates_it() {
        with_temp_home("local-runtime-install", |home| {
            let staging = home.join(".overdare-dev/updates/runtime_staging_1.2.3_test");
            fs::create_dir_all(staging.join("dist/client")).expect("create client");
            fs::write(staging.join(super::sidecar_bin_name()), b"sidecar").expect("write sidecar");

            super::install_staged_runtime(Env::Dev, "1.2.3", "local-sha", &staging)
                .expect("install staged runtime");

            let installed = home.join(".overdare-dev/updates/runtime-v1.2.3");
            assert!(super::runtime_layout_exists(&installed));
            assert_eq!(
                super::installed_version_at(&installed)
                    .expect("installed version")
                    .sha256,
                "local-sha"
            );
            assert_eq!(super::current_runtime_dir(Env::Dev), Some(installed));
        });
    }
}
