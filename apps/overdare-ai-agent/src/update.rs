use std::fmt::Write as FmtWrite;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::env::{manifest_url_for, Env, EnvSelection};
use crate::storage::global_storage_dir;

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

fn read_user_config_json(env: Env) -> Option<serde_json::Value> {
    let path = global_storage_dir(env)?.join("config.jsonc");
    let content = fs::read_to_string(&path).ok()?;
    let stripped: String = content
        .lines()
        .map(strip_jsonc_line_comment)
        .collect::<Vec<_>>()
        .join("\n");
    serde_json::from_str::<serde_json::Value>(&stripped).ok()
}

fn is_update_disabled(env: Env) -> bool {
    read_user_config_json(env)
        .and_then(|val| {
            val.get("updateMode")
                .and_then(|v| v.as_str())
                .map(|s| s == "disabled")
        })
        .unwrap_or(false)
}

fn resolve_manifest_url(selection: &EnvSelection) -> String {
    if let Ok(url) = std::env::var("DILIGENT_UPDATE_URL") {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
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
    match manifest.env.as_deref() {
        None => match requested {
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

fn fetch_manifest(manifest_url: &str) -> Result<UpdateManifest, String> {
    // Retry transient failures (network errors, 5xx, dev-latest swap window).
    // Do NOT retry 4xx — those are permanent (wrong URL, missing release).
    const ATTEMPTS: u32 = 3;
    const BASE_BACKOFF_MS: u64 = 500;

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(format!("overdare-ai-agent/{BUNDLED_RUNTIME_VERSION}"))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let mut last_err = String::new();
    for attempt in 1..=ATTEMPTS {
        match client.get(manifest_url).send() {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    let body = response
                        .text()
                        .map_err(|e| format!("read manifest body: {e}"))?;
                    return serde_json::from_str(&body)
                        .map_err(|e| format!("parse manifest: {e}"));
                }
                if !status.is_server_error() || attempt == ATTEMPTS {
                    return Err(format!(
                        "fetch manifest failed: HTTP {status} ({manifest_url})"
                    ));
                }
                last_err = format!("HTTP {status} ({manifest_url})");
            }
            Err(e) => {
                last_err = format!("fetch manifest: {e}");
                if attempt == ATTEMPTS {
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

#[cfg(test)]
mod tests {
    use super::{
        strip_jsonc_line_comment, validate_manifest_env, validate_pinned_version, UpdateManifest,
    };
    use crate::env::{Env, EnvSelection};

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
