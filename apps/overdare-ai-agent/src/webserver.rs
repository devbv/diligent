use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};

use crate::env::{Env, EnvSelection};
use crate::storage::{
    global_storage_dir, migrate_global_namespace_if_needed, migrate_local_namespace_if_needed,
    storage_namespace,
};
use crate::update::{installed_version_at, resolve_runtime_dir};

pub struct WebServerOptions {
    pub cwd: String,
    pub env: Env,
    pub pinned_version: Option<String>,
    pub userid: Option<String>,
    pub project_id: Option<String>,
    pub studio_rpc_port: Option<u16>,
    pub web_server_port: Option<u16>,
    pub hub_domain: Option<String>,
}

fn normalize_cwd(raw: &str) -> String {
    #[cfg(windows)]
    {
        if let Some(stripped) = raw.strip_prefix("/") {
            let mut parts = stripped.split('/');
            if let Some(first) = parts.next() {
                if first.len() == 1 && first.chars().all(|ch| ch.is_ascii_alphabetic()) {
                    let remainder = parts.collect::<Vec<_>>().join("\\");
                    if remainder.is_empty() {
                        return format!("{}:\\", first.to_ascii_uppercase());
                    }
                    return format!("{}:\\{}", first.to_ascii_uppercase(), remainder);
                }
            }

            if raw.starts_with("/Users/") || raw == "/Users" {
                let drive = std::env::var("SystemDrive")
                    .or_else(|_| std::env::var("HOMEDRIVE"))
                    .unwrap_or_else(|_| "C:".to_string());
                let trimmed_drive = drive.trim_end_matches(['\\', '/']);
                let remainder = stripped.replace('/', "\\");
                return format!("{}\\{}", trimmed_drive, remainder);
            }
        }
    }

    raw.to_string()
}

pub fn parse_args(args: &[String], selection: &EnvSelection) -> Result<WebServerOptions, String> {
    let mut cwd: Option<String> = None;
    let mut userid: Option<String> = None;
    let mut project_id: Option<String> = None;
    let mut studio_rpc_port: Option<u16> = None;
    let mut web_server_port: Option<u16> = None;
    let mut hub_domain: Option<String> = None;

    for arg in args {
        if let Some(value) = arg.strip_prefix("--cwd=") {
            if !value.is_empty() {
                cwd = Some(value.to_string());
            }
            continue;
        }
        if let Some(value) = arg.strip_prefix("--userid=") {
            if !value.is_empty() {
                userid = Some(value.to_string());
            }
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project-id=") {
            if !value.is_empty() {
                project_id = Some(value.to_string());
            }
            continue;
        }
        if let Some(value) = arg.strip_prefix("--studio-rpc-port=") {
            if !value.is_empty() {
                let parsed = value
                    .parse::<u16>()
                    .map_err(|_| format!("Invalid --studio-rpc-port value: {value}"))?;
                studio_rpc_port = Some(parsed);
            }
            continue;
        }
        if let Some(value) = arg.strip_prefix("--web-server-port=") {
            if !value.is_empty() {
                let parsed = value
                    .parse::<u16>()
                    .map_err(|_| format!("Invalid --web-server-port value: {value}"))?;
                web_server_port = Some(parsed);
            }
            continue;
        }
        if let Some(value) = arg.strip_prefix("--hub-domain=") {
            if !value.is_empty() {
                hub_domain = Some(value.to_string());
            }
            continue;
        }
        if matches!(arg.as_str(), "--help" | "-h") {
            return Err(
                "Usage: overdare-ai-agent [--agent-env=prod|dev[@version]] start --cwd=/path/to/project [--userid=abc] [--project-id=project] [--studio-rpc-port=12345] [--web-server-port=3000] [--hub-domain=hub.example.com] [--init-if-missing]"
                    .to_string(),
            );
        }
    }

    let cwd = normalize_cwd(&cwd.unwrap_or_else(|| {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .to_string_lossy()
            .to_string()
    }));
    Ok(WebServerOptions {
        cwd,
        env: selection.env,
        pinned_version: selection.pinned_version.clone(),
        userid,
        project_id,
        studio_rpc_port,
        web_server_port,
        hub_domain,
    })
}

fn default_web_log_path(env: Env) -> Result<PathBuf, String> {
    let global = global_storage_dir(env).ok_or("Cannot determine home directory for web logs")?;
    let logs_dir = global.join("logs");
    std::fs::create_dir_all(&logs_dir).map_err(|e| {
        format!(
            "Cannot create web log directory {}: {e}",
            logs_dir.display()
        )
    })?;
    let date = chrono::Local::now().format("%Y%m%d").to_string();
    let pid = std::process::id();
    Ok(logs_dir.join(format!("{}-{}.log", date, pid)))
}

fn sidecar_bin_path(runtime_dir: &Path) -> PathBuf {
    let bin_name = if cfg!(windows) {
        "diligent-web-server.exe"
    } else {
        "diligent-web-server"
    };
    runtime_dir.join(bin_name)
}

fn dist_dir_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join("dist/client")
}

fn rg_bin_path(runtime_dir: &Path) -> Option<PathBuf> {
    let bin_name = if cfg!(windows) { "rg.exe" } else { "rg" };
    // Bundled next to the other runtime assets (matches luau-lsp at
    // assets/bin/); the sidecar falls back to a PATH `rg` when this is absent.
    let path = runtime_dir.join("assets").join("bin").join(bin_name);
    path.exists().then_some(path)
}

fn resolve_installed_runtime_version(runtime_dir: &Path) -> Option<String> {
    let version = installed_version_at(runtime_dir)?.version;
    let trimmed = version.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

/// Positive whole-second duration from an env var, else `default_secs`.
/// Lets slow machines (first-boot AV scans) extend the start timeouts without
/// a rebuild and without touching the Studio-facing CLI signature.
fn env_secs(key: &str, default_secs: u64) -> Duration {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(default_secs))
}

async fn wait_for_health(port: u16) -> Result<(), String> {
    use tokio::time::{sleep, timeout};
    let url = format!("http://127.0.0.1:{}/health", port);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| format!("Cannot build HTTP client: {e}"))?;
    let deadline = env_secs("DILIGENT_START_HEALTH_TIMEOUT_SECS", 30);
    timeout(deadline, async {
        loop {
            if client
                .get(&url)
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false)
            {
                return Ok::<(), String>(());
            }
            sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .map_err(|_| {
        format!(
            "Server at :{} did not become healthy within {} s",
            port,
            deadline.as_secs()
        )
    })?
}

fn format_child_exit(status: std::process::ExitStatus) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return format!("signal {signal}");
        }
    }
    match status.code() {
        Some(code) => format!("exit code {code}"),
        None => "unknown termination".to_string(),
    }
}

pub struct RunningWebServer {
    pub port: u16,
    child: tokio::process::Child,
}

impl RunningWebServer {
    pub async fn wait(mut self) -> Result<(), String> {
        let status = self
            .child
            .wait()
            .await
            .map_err(|e| format!("wait sidecar exit: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "Webserver sidecar exited unexpectedly ({})",
                format_child_exit(status)
            ))
        }
    }
}

/// One failed start attempt. Timeout-class failures are retryable (a first
/// boot can be slowed by an AV scan of the fresh binary); a sidecar that
/// crashed on its own is not — a respawn would crash the same way and only
/// delay the diagnostics.
struct StartFailure {
    message: String,
    retryable: bool,
}

impl StartFailure {
    fn terminal(message: impl Into<String>) -> Self {
        StartFailure {
            message: message.into(),
            retryable: false,
        }
    }

    fn transient(message: impl Into<String>) -> Self {
        StartFailure {
            message: message.into(),
            retryable: true,
        }
    }
}

pub async fn start_foreground(options: WebServerOptions) -> Result<RunningWebServer, String> {
    migrate_global_namespace_if_needed(options.env).map(|_| ())?;
    migrate_local_namespace_if_needed(&options.cwd, options.env).map(|_| ())?;

    // Resolve a single runtime directory (pinned version, else the active
    // pointer), then derive every runtime path from it. resolve_runtime_dir
    // validates the layout, so the sidecar binary and dist/client are present.
    let selection = EnvSelection {
        env: options.env,
        pinned_version: options.pinned_version.clone(),
    };
    let runtime_dir = resolve_runtime_dir(&selection)?;
    let binary = sidecar_bin_path(&runtime_dir);
    let dist_dir = dist_dir_path(&runtime_dir);
    let log_path = default_web_log_path(options.env)?;
    let rg_path = rg_bin_path(&runtime_dir);
    let runtime_version = resolve_installed_runtime_version(&runtime_dir);

    const ATTEMPTS: u32 = 2;
    for attempt in 1..=ATTEMPTS {
        match start_once(
            &options,
            &binary,
            &dist_dir,
            &log_path,
            rg_path.as_deref(),
            runtime_version.as_deref(),
        )
        .await
        {
            Ok(running) => return Ok(running),
            Err(failure) => {
                if !failure.retryable || attempt == ATTEMPTS {
                    return Err(failure.message);
                }
                // start_once killed (and reaped) its child before returning a
                // retryable failure, so the respawn never races a half-alive
                // sidecar for the same fixed --web-server-port.
                eprintln!("[start] {}; retrying...", failure.message);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    unreachable!("start attempt loop always returns");
}

async fn start_once(
    options: &WebServerOptions,
    binary: &Path,
    dist_dir: &Path,
    log_path: &Path,
    rg_path: Option<&Path>,
    runtime_version: Option<&str>,
) -> Result<RunningWebServer, StartFailure> {
    let desired_port = options.web_server_port.unwrap_or(0);

    let mut args = vec![
        format!("--port={desired_port}"),
        format!("--dist-dir={}", dist_dir.to_string_lossy()),
        format!("--cwd={}", options.cwd),
        format!("--log-file={}", log_path.to_string_lossy()),
        format!("--parent-pid={}", std::process::id()),
    ];
    if let Some(userid) = options.userid.as_deref().filter(|value| !value.is_empty()) {
        args.push(format!("--userid={userid}"));
    }

    let mut cmd = tokio::process::Command::new(binary);
    #[cfg(windows)]
    {
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        // Belt-and-braces for early-return paths: the sidecar's own
        // --parent-pid watchdog only fires after this launcher exits, which is
        // too late when a retry respawns within the same process.
        .kill_on_drop(true);
    if let Some(rg) = rg_path {
        cmd.env("DILIGENT_RG_PATH", rg.to_string_lossy().as_ref());
    }
    if let Some(studio_rpc_port) = options.studio_rpc_port {
        cmd.env("STUDIO_PORT", studio_rpc_port.to_string());
    }
    if let Some(hub_domain) = options.hub_domain.as_deref().filter(|v| !v.is_empty()) {
        cmd.env("HUB_DOMAIN", hub_domain);
    }
    if let Some(project_id) = options.project_id.as_deref().filter(|v| !v.is_empty()) {
        cmd.env("OVERDARE_PROJECT_ID", project_id);
    }
    cmd.env("DILIGENT_STORAGE_NAMESPACE", storage_namespace(options.env));
    cmd.env("DILIGENT_ENV", options.env.as_str());
    if let Some(version) = runtime_version {
        cmd.env("DILIGENT_SERVER_VERSION", version);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| StartFailure::terminal(format!("Failed to spawn updated sidecar: {e}")))?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return Err(StartFailure::terminal("No stdout from updated sidecar"));
    };

    let port_result = {
        let mut reader = BufReader::new(stdout);
        let deadline = env_secs("DILIGENT_START_PORT_TIMEOUT_SECS", 15);
        let mut line_buf = String::new();
        tokio::time::timeout(deadline, async {
            loop {
                line_buf.clear();
                let n = reader
                    .read_line(&mut line_buf)
                    .await
                    .map_err(|e| StartFailure::terminal(format!("read stdout: {e}")))?;
                if n == 0 {
                    let status = child
                        .wait()
                        .await
                        .map_err(|e| StartFailure::terminal(format!("wait sidecar exit: {e}")))?;
                    return Err::<u16, StartFailure>(StartFailure::terminal(format!(
                        "Sidecar exited before emitting WEBSERVER_PORT ({})\nBinary: {}\nLog file: {}",
                        format_child_exit(status),
                        binary.display(),
                        log_path.display()
                    )));
                }
                if let Some(port_str) = line_buf.trim().strip_prefix("DILIGENT_PORT=") {
                    let port: u16 = port_str.trim().parse().map_err(|_| {
                        StartFailure::terminal(format!("Invalid port value: {}", port_str.trim()))
                    })?;
                    return Ok(port);
                }
                if let Some(port_str) = line_buf.trim().strip_prefix("WEBSERVER_PORT=") {
                    let port: u16 = port_str.trim().parse().map_err(|_| {
                        StartFailure::terminal(format!("Invalid port value: {}", port_str.trim()))
                    })?;
                    return Ok(port);
                }
            }
        })
        .await
        .unwrap_or_else(|_| {
            Err(StartFailure::transient(
                "Timed out waiting for WEBSERVER_PORT from updated sidecar",
            ))
        })
    };

    let port = match port_result {
        Ok(port) => port,
        Err(failure) => {
            // Kill and reap before surfacing the failure — a retry (or the
            // caller's next action) must never race a still-alive child.
            let _ = child.kill().await;
            return Err(failure);
        }
    };

    if let Err(err) = wait_for_health(port).await {
        let _ = child.kill().await;
        return Err(StartFailure::transient(err));
    }
    Ok(RunningWebServer { port, child })
}

#[cfg(test)]
mod tests {
    use super::{parse_args, resolve_installed_runtime_version, rg_bin_path};
    use crate::env::{Env, EnvSelection};
    use crate::storage::storage_namespace;
    use crate::testutil::with_temp_home;
    use std::fs;

    #[test]
    fn parse_args_reads_cwd_and_userid() {
        let args = vec![
            "--cwd=/tmp/project".to_string(),
            "--userid=user-1".to_string(),
            "--project-id=project-1".to_string(),
            "--studio-rpc-port=8123".to_string(),
            "--web-server-port=4567".to_string(),
            "--hub-domain=hub.example.com".to_string(),
        ];
        let parsed = parse_args(&args, &EnvSelection::latest(Env::Prod)).expect("parse args");
        assert_eq!(parsed.cwd, "/tmp/project");
        assert_eq!(parsed.env, Env::Prod);
        assert_eq!(parsed.pinned_version, None);
        assert_eq!(parsed.userid.as_deref(), Some("user-1"));
        assert_eq!(parsed.project_id.as_deref(), Some("project-1"));
        assert_eq!(parsed.studio_rpc_port, Some(8123));
        assert_eq!(parsed.web_server_port, Some(4567));
        assert_eq!(parsed.hub_domain.as_deref(), Some("hub.example.com"));
    }

    #[test]
    fn parse_args_carries_pinned_version_from_selection() {
        let selection = EnvSelection::parse("dev@1.2.3").expect("parse selection");
        let parsed = parse_args(&["--cwd=/tmp/p".to_string()], &selection).expect("parse args");
        assert_eq!(parsed.env, Env::Dev);
        assert_eq!(parsed.pinned_version.as_deref(), Some("1.2.3"));
    }

    #[cfg(windows)]
    #[test]
    fn normalize_cwd_converts_msys_drive_paths() {
        assert_eq!(
            super::normalize_cwd("/c/Users/devbv/git/diligent"),
            r"C:\Users\devbv\git\diligent"
        );
    }

    #[cfg(windows)]
    #[test]
    fn normalize_cwd_converts_git_bash_users_paths() {
        assert_eq!(
            super::normalize_cwd("/Users/devbv/git/diligent"),
            r"C:\Users\devbv\git\diligent"
        );
    }

    #[test]
    fn env_secs_parses_override_and_falls_back() {
        use super::env_secs;
        use std::time::Duration;
        let _guard = crate::testutil::HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("TEST_START_TIMEOUT_SECS");
        assert_eq!(
            env_secs("TEST_START_TIMEOUT_SECS", 15),
            Duration::from_secs(15)
        );
        std::env::set_var("TEST_START_TIMEOUT_SECS", "45");
        assert_eq!(
            env_secs("TEST_START_TIMEOUT_SECS", 15),
            Duration::from_secs(45)
        );
        std::env::set_var("TEST_START_TIMEOUT_SECS", "0");
        assert_eq!(
            env_secs("TEST_START_TIMEOUT_SECS", 15),
            Duration::from_secs(15)
        );
        std::env::remove_var("TEST_START_TIMEOUT_SECS");
    }

    #[test]
    fn packaged_webserver_uses_packaged_namespace() {
        assert_eq!(storage_namespace(Env::Prod), "overdare");
        assert_eq!(storage_namespace(Env::Dev), "overdare-dev");
    }

    #[test]
    fn rg_bin_path_resolves_under_assets_bin() {
        with_temp_home("webserver-rg-bin", |home| {
            let runtime_dir = home.join("runtime");
            let bin_name = if cfg!(windows) { "rg.exe" } else { "rg" };
            let expected = runtime_dir.join("assets").join("bin").join(bin_name);

            // Absent by default: fall back to a PATH `rg` (env stays unset).
            assert_eq!(rg_bin_path(&runtime_dir), None);

            fs::create_dir_all(expected.parent().unwrap()).expect("create assets/bin");
            fs::write(&expected, b"#!/bin/sh\n").expect("write rg");

            assert_eq!(rg_bin_path(&runtime_dir).as_deref(), Some(expected.as_path()));
        });
    }

    #[test]
    fn resolve_installed_runtime_version_reads_version_json() {
        with_temp_home("webserver-installed-version", |home| {
            // installed_version now resolves through current_runtime_dir, which
            // requires a usable layout (sidecar + dist/client), not just
            // version.json.
            let runtime_dir = home.join(".overdare/updates/runtime");
            fs::create_dir_all(runtime_dir.join("dist/client")).expect("create dist/client");
            let bin_name = if cfg!(windows) {
                "diligent-web-server.exe"
            } else {
                "diligent-web-server"
            };
            fs::write(runtime_dir.join(bin_name), b"#!/bin/sh\n").expect("write sidecar");
            fs::write(
                runtime_dir.join("version.json"),
                "{\n  \"version\": \"1.2.3\",\n  \"applied_at\": \"2026-01-01T00:00:00Z\",\n  \"sha256\": \"abc\"\n}\n",
            )
            .expect("write version json");

            assert_eq!(
                resolve_installed_runtime_version(&runtime_dir).as_deref(),
                Some("1.2.3")
            );
        });
    }
}
