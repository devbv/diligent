use std::fmt::Write as FmtWrite;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::env::{manifest_url_for, Env, EnvSelection};
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

fn updates_dir(env: Env) -> Option<PathBuf> {
    global_storage_dir(env).map(|g| g.join("updates"))
}

fn runtime_dir(env: Env) -> Option<PathBuf> {
    updates_dir(env).map(|u| u.join("runtime"))
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
    // opt-out is silently bypassed the first time a user passes --env=dev.
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
    let runtime = match runtime_dir(env) {
        Some(path) => path,
        None => return true,
    };
    let sidecar_name = if cfg!(windows) {
        "diligent-web-server.exe"
    } else {
        "diligent-web-server"
    };
    let has_sidecar = runtime.join(sidecar_name).exists();
    let has_dist = runtime.join("dist/client").exists();
    !(has_sidecar && has_dist)
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

pub fn installed_version(env: Env) -> Option<InstalledVersion> {
    let path = updates_dir(env)?.join("runtime/version.json");
    let content = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
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
    // Normalize the declared field the same way the CLI parses --env (trim +
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
                    "Manifest declares env='{declared}' but agent requested env='{}'. Check --env or DILIGENT_UPDATE_URL.",
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

fn fetch_manifest(manifest_url: &str) -> Result<UpdateManifest, String> {
    // Retry transient failures: network errors, 5xx, 404 (dev-latest swap),
    // and body-read errors (truncated body during CDN swap). Parse errors are
    // terminal because a malformed JSON document does not become valid on
    // retry — repeating it just delays the failure.
    const ATTEMPTS: u32 = 3;
    const BASE_BACKOFF_MS: u64 = 500;

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(format!("overdare-ai-agent/{BUNDLED_RUNTIME_VERSION}"))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let mut last_err = String::new();
    for attempt in 1..=ATTEMPTS {
        let outcome: Result<UpdateManifest, (String, bool)> = (|| {
            let response = client
                .get(manifest_url)
                .send()
                .map_err(|e| (format!("fetch manifest: {e}"), true))?;
            let status = response.status();
            if !status.is_success() {
                let retryable = is_retryable_manifest_status(status);
                return Err((
                    format!("fetch manifest failed: HTTP {status} ({manifest_url})"),
                    retryable,
                ));
            }
            let body = response
                .text()
                .map_err(|e| (format!("read manifest body: {e}"), true))?;
            serde_json::from_str::<UpdateManifest>(&body)
                .map_err(|e| (format!("parse manifest: {e}"), false))
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

pub fn fetch_latest_version(selection: &EnvSelection) -> Result<String, String> {
    let manifest = fetch_manifest(&resolve_manifest_url(selection))?;
    validate_manifest_env(&manifest, selection.env)?;
    validate_pinned_version(&manifest, selection)?;
    Ok(manifest.version)
}

pub fn init_status(selection: &EnvSelection) -> Result<(Option<String>, String), String> {
    let current = installed_version(selection.env).map(|item| item.version);
    let latest = fetch_latest_version(selection)?;
    Ok((current, latest))
}

fn fetch_update(
    selection: &EnvSelection,
    manifest_url: &str,
    effective_version: String,
    bootstrap_required: bool,
    progress: &mut Option<&mut dyn FnMut(UpdateProgress)>,
) -> Result<Option<FetchedUpdate>, String> {
    let manifest = fetch_manifest(manifest_url)?;
    validate_manifest_env(&manifest, selection.env)?;
    validate_pinned_version(&manifest, selection)?;
    if !should_download_update(&manifest.version, &effective_version, bootstrap_required) {
        report_progress(progress, UpdateProgress::UpToDate);
        return Ok(None);
    }
    let bundle = manifest
        .platforms
        .get(current_platform())
        .ok_or_else(|| format!("no bundle for platform {}", current_platform()))?
        .clone();
    report_progress(
        progress,
        UpdateProgress::Downloading {
            target_version: manifest.version.clone(),
        },
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(format!("overdare-ai-agent/{BUNDLED_RUNTIME_VERSION}"))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let response = client
        .get(&bundle.url)
        .send()
        .map_err(|e| format!("download bundle: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("download failed: HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .map_err(|e| format!("read bundle bytes: {e}"))?;
    Ok(Some(FetchedUpdate {
        version: manifest.version,
        sha256: bundle.sha256,
        bytes: bytes.to_vec(),
    }))
}

fn verify_sha256(path: &Path, expected_sha256: &str) -> Result<bool, String> {
    let bytes = fs::read(path).map_err(|e| format!("read zip for sha256: {e}"))?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    Ok(actual == expected_sha256)
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
                    "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                    zip_path.display(),
                    out_dir.display()
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


pub fn run_with_progress(
    log: &mut String,
    mut progress: Option<&mut dyn FnMut(UpdateProgress)>,
    selection: &EnvSelection,
) -> Result<bool, String> {
    if is_update_disabled(selection.env) {
        let _ = writeln!(log, "[update] auto-update disabled via config");
        report_progress(&mut progress, UpdateProgress::Disabled);
        return Ok(false);
    }

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
        &mut progress,
    )? {
        Some(item) => item,
        None => {
            let _ = writeln!(log, "[update] Already up-to-date");
            report_progress(&mut progress, UpdateProgress::UpToDate);
            return Ok(false);
        }
    };

    let updates = updates_dir(selection.env).ok_or("cannot resolve updates dir")?;
    fs::create_dir_all(&updates).map_err(|e| format!("create updates dir: {e}"))?;
    let zip_path = updates.join(format!(
        "runtime-bundle-{}-{}.zip",
        fetched.version,
        current_platform()
    ));
    fs::write(&zip_path, &fetched.bytes).map_err(|e| format!("write bundle: {e}"))?;

    report_progress(
        &mut progress,
        UpdateProgress::Verifying {
            target_version: fetched.version.clone(),
        },
    );
    if !verify_sha256(&zip_path, &fetched.sha256)? {
        let _ = fs::remove_file(&zip_path);
        return Err("Downloaded bundle failed SHA256 verification".into());
    }

    let staging = updates.join("runtime_staging");
    report_progress(
        &mut progress,
        UpdateProgress::Extracting {
            target_version: fetched.version.clone(),
        },
    );
    extract_zip(&zip_path, &staging)?;

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
    let version_info = InstalledVersion {
        version: fetched.version.clone(),
        applied_at: chrono::Local::now().to_rfc3339(),
        sha256: fetched.sha256.clone(),
    };
    fs::write(
        staging.join("version.json"),
        serde_json::to_string_pretty(&version_info)
            .map(|json| format!("{json}\n"))
            .map_err(|e| format!("serialize version info: {e}"))?,
    )
    .map_err(|e| format!("write staging version.json: {e}"))?;

    let runtime = runtime_dir(selection.env).ok_or("cannot resolve runtime dir")?;
    if runtime.exists() {
        retry_fs_op("remove old runtime", || fs::remove_dir_all(&runtime))?;
    }
    retry_fs_op("move staging to runtime", || fs::rename(&staging, &runtime))?;
    let _ = fs::remove_file(&zip_path);

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
        // Symmetric with the CLI's --env parsing, which lowercases + trims.
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
}
