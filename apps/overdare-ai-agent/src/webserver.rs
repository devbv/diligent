use std::path::PathBuf;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};

use crate::storage::{
    global_storage_dir, migrate_global_namespace_if_needed, migrate_local_namespace_if_needed,
    storage_namespace,
};
use crate::update::installed_version;

pub struct WebServerOptions {
    pub cwd: String,
    pub userid: Option<String>,
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

pub fn parse_args(args: &[String]) -> Result<WebServerOptions, String> {
    let mut cwd: Option<String> = None;
    let mut userid: Option<String> = None;
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
                "Usage: overdare-ai-agent start --cwd=/path/to/project [--userid=abc] [--studio-rpc-port=12345] [--web-server-port=3000] [--hub-domain=hub.example.com]"
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
        userid,
        studio_rpc_port,
        web_server_port,
        hub_domain,
    })
}

fn default_web_log_path() -> Result<PathBuf, String> {
    let global = global_storage_dir().ok_or("Cannot determine home directory for web logs")?;
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

fn resolve_updated_sidecar_path() -> Option<PathBuf> {
    let bin_name = if cfg!(windows) {
        "diligent-web-server.exe"
    } else {
        "diligent-web-server"
    };
    let path = global_storage_dir()?.join("updates/runtime").join(bin_name);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

fn resolve_updated_dist_dir() -> Option<PathBuf> {
    let candidate = global_storage_dir()?.join("updates/runtime/dist/client");
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

fn resolve_updated_rg_bin() -> Option<PathBuf> {
    let bin_name = if cfg!(windows) { "rg.exe" } else { "rg" };
    let path = global_storage_dir()?.join("updates/runtime").join(bin_name);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

fn resolve_installed_runtime_version() -> Option<String> {
    let version = installed_version()?.version;
    let trimmed = version.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

async fn wait_for_health(port: u16) -> Result<(), String> {
    use tokio::time::{sleep, timeout};
    let url = format!("http://127.0.0.1:{}/health", port);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| format!("Cannot build HTTP client: {e}"))?;
    let deadline = Duration::from_secs(30);
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
    .map_err(|_| format!("Server at :{} did not become healthy within 30 s", port))?
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

pub async fn start_foreground(options: WebServerOptions) -> Result<RunningWebServer, String> {
    migrate_global_namespace_if_needed().map(|_| ())?;
    migrate_local_namespace_if_needed(&options.cwd).map(|_| ())?;

    let binary = resolve_updated_sidecar_path().ok_or(
        format!(
            "Updated runtime binary not found. Run 'overdare-ai-agent update' first so ~/.{}/updates/runtime/diligent-web-server exists.",
            storage_namespace()
        ),
    )?;
    let dist_dir = resolve_updated_dist_dir().ok_or(
        "Updated runtime dist/client not found. Run 'overdare-ai-agent update' first.".to_string(),
    )?;
    let log_path = default_web_log_path()?;
    let rg_path = resolve_updated_rg_bin();

    let desired_port = options.web_server_port.unwrap_or(0);

    let mut args = vec![
        format!("--port={desired_port}"),
        format!("--dist-dir={}", dist_dir.to_string_lossy()),
        format!("--cwd={}", options.cwd),
        format!("--log-file={}", log_path.to_string_lossy()),
        format!("--parent-pid={}", std::process::id()),
    ];
    if let Some(userid) = options.userid.filter(|value| !value.is_empty()) {
        args.push(format!("--userid={userid}"));
    }

    let mut cmd = tokio::process::Command::new(&binary);
    #[cfg(windows)]
    {
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit());
    if let Some(rg) = rg_path.as_deref() {
        cmd.env("DILIGENT_RG_PATH", rg.to_string_lossy().as_ref());
    }
    if let Some(studio_rpc_port) = options.studio_rpc_port {
        cmd.env("STUDIO_PORT", studio_rpc_port.to_string());
    }
    if let Some(hub_domain) = options.hub_domain.as_deref().filter(|v| !v.is_empty()) {
        cmd.env("HUB_DOMAIN", hub_domain);
    }
    cmd.env("DILIGENT_STORAGE_NAMESPACE", storage_namespace());
    if let Some(version) = resolve_installed_runtime_version() {
        cmd.env("DILIGENT_SERVER_VERSION", version);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn updated sidecar: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("No stdout from updated sidecar")?;

    let port = {
        let mut reader = BufReader::new(stdout);
        let deadline = Duration::from_secs(15);
        let mut line_buf = String::new();
        tokio::time::timeout(deadline, async {
            loop {
                line_buf.clear();
                let n = reader.read_line(&mut line_buf).await.map_err(|e| format!("read stdout: {e}"))?;
                if n == 0 {
                    let status = child
                        .wait()
                        .await
                        .map_err(|e| format!("wait sidecar exit: {e}"))?;
                    return Err::<u16, String>(format!(
                        "Sidecar exited before emitting WEBSERVER_PORT ({})\nBinary: {}\nLog file: {}",
                        format_child_exit(status),
                        binary.display(),
                        log_path.display()
                    ));
                }
                if let Some(port_str) = line_buf.trim().strip_prefix("DILIGENT_PORT=") {
                    let port: u16 = port_str.trim().parse().map_err(|_| format!("Invalid port value: {}", port_str.trim()))?;
                    return Ok(port);
                }
                if let Some(port_str) = line_buf.trim().strip_prefix("WEBSERVER_PORT=") {
                    let port: u16 = port_str.trim().parse().map_err(|_| format!("Invalid port value: {}", port_str.trim()))?;
                    return Ok(port);
                }
            }
        })
        .await
        .map_err(|_| "Timed out waiting for WEBSERVER_PORT from updated sidecar".to_string())?
    }?;

    wait_for_health(port).await?;
    Ok(RunningWebServer { port, child })
}

#[cfg(test)]
mod tests {
    use super::{normalize_cwd, parse_args, resolve_installed_runtime_version};
    use crate::storage::storage_namespace;
    use std::fs;

    fn with_temp_home<T>(test: T)
    where
        T: FnOnce(),
    {
        let temp_root = std::env::temp_dir().join(format!(
            "overdare-ai-agent-webserver-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&temp_root).expect("create temp root");

        let previous_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &temp_root);

        test();

        if let Some(home) = previous_home {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn parse_args_reads_cwd_and_userid() {
        let args = vec![
            "--cwd=/tmp/project".to_string(),
            "--userid=user-1".to_string(),
            "--studio-rpc-port=8123".to_string(),
            "--web-server-port=4567".to_string(),
            "--hub-domain=hub.example.com".to_string(),
        ];
        let parsed = parse_args(&args).expect("parse args");
        assert_eq!(parsed.cwd, "/tmp/project");
        assert_eq!(parsed.userid.as_deref(), Some("user-1"));
        assert_eq!(parsed.studio_rpc_port, Some(8123));
        assert_eq!(parsed.web_server_port, Some(4567));
        assert_eq!(parsed.hub_domain.as_deref(), Some("hub.example.com"));
    }

    #[cfg(windows)]
    #[test]
    fn normalize_cwd_converts_msys_drive_paths() {
        assert_eq!(
            normalize_cwd("/c/Users/devbv/git/diligent"),
            r"C:\Users\devbv\git\diligent"
        );
    }

    #[cfg(windows)]
    #[test]
    fn normalize_cwd_converts_git_bash_users_paths() {
        assert_eq!(
            normalize_cwd("/Users/devbv/git/diligent"),
            r"C:\Users\devbv\git\diligent"
        );
    }

    #[test]
    fn packaged_webserver_uses_packaged_namespace() {
        assert_eq!(storage_namespace(), "overdare");
    }

    #[test]
    fn resolve_installed_runtime_version_reads_version_json() {
        with_temp_home(|| {
            let runtime_dir = std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .expect("home path")
                .join(".overdare/updates/runtime");
            fs::create_dir_all(&runtime_dir).expect("create runtime dir");
            fs::write(
                runtime_dir.join("version.json"),
                "{\n  \"version\": \"1.2.3\",\n  \"applied_at\": \"2026-01-01T00:00:00Z\",\n  \"sha256\": \"abc\"\n}\n",
            )
            .expect("write version json");

            assert_eq!(resolve_installed_runtime_version().as_deref(), Some("1.2.3"));
        });
    }
}
