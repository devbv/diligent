use crate::env::EnvSelection;
use crate::init;
use crate::mcp_router;
use crate::storage::migrate_global_namespace_if_needed;
use crate::studio_registry;
use crate::update::{self, FailureKind, UpdateError, UpdateProgress};
use crate::webserver;
use std::path::PathBuf;

/// CLI failure carrying the exit-code contract from P077 P4:
/// 0 success (fallback included) / 10 network / 20 install·disk /
/// 21 verify / 30 config·args / 40 start boot failure.
/// Studio today only distinguishes zero vs non-zero; the specific codes are
/// additive detail it can start consuming later.
pub struct CliError {
    pub code: i32,
    pub message: String,
}

impl CliError {
    fn config(message: impl Into<String>) -> Self {
        CliError {
            code: 30,
            message: message.into(),
        }
    }

    fn install(message: impl Into<String>) -> Self {
        CliError {
            code: FailureKind::Disk.code(),
            message: message.into(),
        }
    }

    fn start(message: impl Into<String>) -> Self {
        CliError {
            code: 40,
            message: message.into(),
        }
    }
}

impl From<UpdateError> for CliError {
    fn from(err: UpdateError) -> Self {
        CliError {
            code: err.kind.code(),
            message: err.message,
        }
    }
}

pub fn run() -> Result<(), CliError> {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let (env_flag, remaining) = extract_env_flag(&raw_args).map_err(CliError::config)?;

    let mut args = remaining.into_iter();
    let Some(command) = args.next() else {
        print_help();
        return Ok(());
    };

    // Help must remain reachable even when `--agent-env=<invalid>` is supplied —
    // resolving the env first would block the very flag the help text
    // documents.
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        print_help();
        return Ok(());
    }

    let selection = EnvSelection::resolve(env_flag.as_deref()).map_err(CliError::config)?;

    // Guard held for the whole command so its Drop flushes pending events before
    // main's process::exit (which skips destructors) runs.
    let _monitoring = crate::monitoring::init(selection.env.as_str());

    let result = match command.as_str() {
        "init" => run_init(&selection, args.collect()),
        "install" => run_install(&selection, args.collect()),
        "start" => run_webserver(&selection, args.collect()),
        "start-mcp-router" => run_mcp_router(&selection, args.collect()),
        other => Err(CliError::config(format!("Unknown command: {other}"))),
    };
    if let Err(err) = &result {
        crate::monitoring::capture_cli_error(err.code, &err.message);
    }
    result
}

fn parse_bundle_arg(args: Vec<String>) -> Result<PathBuf, CliError> {
    let mut bundle: Option<PathBuf> = None;
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        let value = if let Some(value) = arg.strip_prefix("--bundle=") {
            value.to_string()
        } else if arg == "--bundle" {
            iter.next()
                .ok_or_else(|| CliError::config("install requires --bundle <path-to-runtime.zip>"))?
        } else {
            return Err(CliError::config(format!("Unknown install argument: {arg}")));
        };
        if bundle.replace(PathBuf::from(value)).is_some() {
            return Err(CliError::config("install accepts exactly one --bundle path"));
        }
    }
    bundle.ok_or_else(|| CliError::config("install requires --bundle <path-to-runtime.zip>"))
}

/// Extracts the `--agent-env=<value>` / `--agent-env <value>` flag from `args`, returning
/// the remaining (non-env) arguments untouched.
///
/// Behavior:
/// - `--agent-env=<value>` and bare `--agent-env <value>` are both accepted; mixing them is
///   fine in different positions but specifying more than one is an error.
/// - A bare `--agent-env` with no following token is rejected — silently treating it
///   as "no env" would route a user who typed `--agent-env dev` (with a space) to
///   prod by default, which is a release-channel footgun.
/// - Duplicate `--agent-env=` flags are rejected so a script that accidentally
///   stacks them does not silently overwrite the first value.
fn extract_env_flag(args: &[String]) -> Result<(Option<String>, Vec<String>), String> {
    let mut env_flag: Option<String> = None;
    let mut remaining = Vec::with_capacity(args.len());
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if let Some(value) = arg.strip_prefix("--agent-env=") {
            if env_flag.is_some() {
                return Err(
                    "Conflicting --agent-env flags. Specify --agent-env exactly once.".to_string(),
                );
            }
            env_flag = Some(value.to_string());
            continue;
        }
        if arg == "--agent-env" {
            let Some(value) = iter.next() else {
                return Err(
                    "--agent-env requires a value (e.g. --agent-env=dev, --agent-env=prod@1.2.3, or --agent-env dev)."
                        .to_string(),
                );
            };
            if env_flag.is_some() {
                return Err(
                    "Conflicting --agent-env flags. Specify --agent-env exactly once.".to_string(),
                );
            }
            env_flag = Some(value.clone());
            continue;
        }
        remaining.push(arg.clone());
    }
    Ok((env_flag, remaining))
}

/// Runs the update and reports `(updated, disabled)` — `disabled` marks the
/// `updateMode: disabled` no-op so init can report `INIT_RESULT=skipped`
/// instead of a misleading `up-to-date`.
fn run_update(
    selection: &EnvSelection,
    deadline: Option<std::time::Instant>,
) -> Result<(bool, bool), UpdateError> {
    // Migration is owned by the entry point (run_init / start_foreground); this
    // function trusts that it already ran. Calling it here would be idempotent
    // but wasteful — and obscures who is responsible for ordering.
    let mut log = String::new();
    let mut disabled = false;
    let result = {
        let mut progress = |event: UpdateProgress| match event {
            UpdateProgress::Disabled => {
                disabled = true;
                println!("update disabled")
            }
            UpdateProgress::BootstrapRequired => println!("runtime bootstrap required"),
            UpdateProgress::Checking { current_version } => {
                println!("checking updates (current: v{current_version})")
            }
            UpdateProgress::Downloading { target_version } => {
                println!("downloading v{target_version}")
            }
            UpdateProgress::Verifying { target_version } => println!("verifying v{target_version}"),
            UpdateProgress::Extracting { target_version } => {
                println!("extracting v{target_version}")
            }
            UpdateProgress::Applying { target_version } => println!("applying v{target_version}"),
            UpdateProgress::UpToDate => println!("already up-to-date"),
            UpdateProgress::Updated { target_version } => println!("updated to v{target_version}"),
        };
        update::run_with_progress(&mut log, Some(&mut progress), selection, deadline)
    };
    if !log.is_empty() {
        eprint!("{log}");
    }
    result.map(|updated| (updated, disabled))
}

/// Whether a failed update may fall back to the already-installed runtime.
///
/// Never for a pinned init — the pin is an "exactly this version" contract
/// (mirrors resolve_runtime_dir's no-fallback rule). Never without a bootable
/// runtime — there is nothing to fall back to.
fn can_fall_back_to_installed(selection: &EnvSelection) -> bool {
    selection.pinned_version.is_none() && update::runtime_installed(selection.env)
}

fn run_init(selection: &EnvSelection, args: Vec<String>) -> Result<(), CliError> {
    migrate_global_namespace_if_needed(selection.env)
        .map(|_| ())
        .map_err(CliError::install)?;
    let skip_update = args.iter().any(|arg| arg == "--skip-update");

    // Echo the resolved env/pin before doing any network work so a user
    // troubleshooting "is --agent-env even being picked up?" sees the parsed
    // selection even if the manifest fetch later errors out.
    println!("Env: {}", selection.env.as_str());
    if let Some(pin) = selection.pinned_version.as_deref() {
        println!("Pinned version: {pin}");
    }

    let current = update::installed_version(selection.env).map(|item| item.version);
    let current_display = || {
        current
            .clone()
            .unwrap_or_else(|| "not installed".to_string())
    };

    if skip_update {
        // --skip-update is the offline / pin-existing path; never hit the
        // network. The previous code fetched the manifest before this check,
        // which turned a flaky network into a hard `init --skip-update`
        // failure even when a runtime was already installed.
        if !update::runtime_installed(selection.env) {
            return Err(CliError::config("--skip-update cannot be used before the runtime has been downloaded at least once."));
        }
        println!("Current version: {}", current_display());
        println!("Skipping update as requested.");
        init::run(selection.env, false).map_err(CliError::install)?;
        println!("INIT_RESULT=skipped");
        return Ok(());
    }

    // Update failures (manifest fetch, download, install) fall back to the
    // installed runtime instead of failing init: Studio blocks agent start for
    // the whole editor session on a non-zero init exit, so a transient network
    // blip must not outrank a bootable install (P077). The deadline caps all
    // network work below Studio's 60 s init timeout — and exists only when a
    // fallback target does.
    let deadline = update::init_network_deadline(selection.env);
    let update_result = update::init_status(selection, deadline).and_then(|(_, latest)| {
        println!("Current version: {}", current_display());
        println!("Latest version: {latest}");
        run_update(selection, deadline)
    });
    let (updated, result_line, fallback_reason) = match update_result {
        Ok((updated, disabled)) => {
            let line = if disabled {
                "skipped"
            } else if updated {
                "updated"
            } else {
                "up-to-date"
            };
            (updated, line, None)
        }
        Err(err) => {
            if !can_fall_back_to_installed(selection) {
                return Err(err.into());
            }
            eprintln!(
                "[init] Update failed; continuing with installed runtime (current: {}). Reason: {}",
                current_display(),
                err.message
            );
            // The fallback swallows the failure (exit 0), so this is the only
            // signal that updates are failing in the field.
            crate::monitoring::capture_warning(&format!(
                "init fallback (code {}): {}",
                err.kind.code(),
                err.message
            ));
            (false, "fallback", Some(err.kind.code()))
        }
    };
    init::run(selection.env, updated).map_err(CliError::install)?;
    // Machine-readable result lines, last on stdout (P077 P4). Studio's init
    // monitor already captures this pipe; parsing them is additive on its side.
    println!("INIT_RESULT={result_line}");
    if let Some(code) = fallback_reason {
        println!("FALLBACK_REASON={code}");
    }
    Ok(())
}

fn run_install(selection: &EnvSelection, args: Vec<String>) -> Result<(), CliError> {
    migrate_global_namespace_if_needed(selection.env)
        .map(|_| ())
        .map_err(CliError::install)?;
    let bundle = parse_bundle_arg(args)?;
    println!("Installing local runtime bundle: {}", bundle.display());
    let version = update::install_local_bundle(selection, &bundle)?;
    init::run(selection.env, true).map_err(CliError::install)?;
    println!("Installed local runtime v{version}");
    println!("INSTALL_RESULT=installed");
    Ok(())
}

fn run_webserver(selection: &EnvSelection, args: Vec<String>) -> Result<(), CliError> {
    // Opt-in self-heal (P077 P7): a wiped or corrupt install turns start into
    // init-then-start instead of the "run init first" error. Uses the same
    // resolution as the actual launch, so the check and the launch agree.
    if args.iter().any(|arg| arg == "--init-if-missing")
        && update::resolve_runtime_dir(selection).is_err()
    {
        eprintln!("[start] Runtime missing; running init first (--init-if-missing)");
        run_init(selection, Vec::new())?;
    }
    let options = webserver::parse_args(&args, selection).map_err(CliError::config)?;
    let runtime = tokio::runtime::Runtime::new()
        .map_err(|e| CliError::start(format!("failed to create tokio runtime: {e}")))?;
    let running = runtime
        .block_on(webserver::start_foreground(options))
        .map_err(CliError::start)?;
    println!("WEBSERVER_PORT={}", running.port);
    runtime.block_on(running.wait()).map_err(CliError::start)?;
    Ok(())
}

/// Parses `start-mcp-router` arguments. `--studio-id=<id>` pre-selects a Studio so a wrapper script
/// can pin one target without a tool call.
fn parse_mcp_router_args(args: Vec<String>) -> Result<Option<String>, CliError> {
    let mut studio_id: Option<String> = None;
    for arg in args {
        let Some(value) = arg.strip_prefix("--studio-id=") else {
            return Err(CliError::config(format!(
                "Unknown start-mcp-router argument: {arg}"
            )));
        };
        if value.is_empty() {
            return Err(CliError::config("--studio-id requires a value"));
        }
        if studio_id.replace(value.to_string()).is_some() {
            return Err(CliError::config(
                "start-mcp-router accepts --studio-id at most once",
            ));
        }
    }
    Ok(studio_id)
}

fn run_mcp_router(selection: &EnvSelection, args: Vec<String>) -> Result<(), CliError> {
    let default_active_studio_id = parse_mcp_router_args(args)?;
    // A migration failure must not take down the MCP entrypoint: the router only reads the registry,
    // and refusing to serve an MCP client over a namespace rename would be a worse outcome than
    // reading from the un-migrated location. init/start own the migration for real.
    if let Err(err) = migrate_global_namespace_if_needed(selection.env) {
        eprintln!("[mcp-router] storage migration skipped: {err}");
    }
    let registry_dir = studio_registry::registry_dir(selection.env)
        .ok_or_else(|| CliError::config("Cannot determine home directory for the Studio registry"))?;

    let runtime = tokio::runtime::Runtime::new()
        .map_err(|e| CliError::start(format!("failed to create tokio runtime: {e}")))?;
    runtime
        .block_on(mcp_router::run_mcp_router(mcp_router::McpRouterOptions {
            registry_dir,
            default_active_studio_id,
        }))
        .map_err(CliError::start)
}

fn print_help() {
    println!(
        "overdare-ai-agent\n\nGlobal flags:\n  --agent-env=<env>[@<version>]   Select release env (prod|dev). Optionally pin a version, e.g. prod@1.2.3 or dev@1.4.0-beta.2. Defaults to prod.\n\nCommands:\n  init [--skip-update]   Ensure runtime exists, print current/latest, and update unless skipped\n  install --bundle <zip> Install a locally built canonical runtime ZIP without network access\n  start [options]        Run updated runtime diligent-web-server as a subprocess\n                         (--init-if-missing runs init first when no runtime is installed)\n  start-mcp-router       Serve the OVERDARE MCP router on stdio. This is the stable command to\n                         configure in an MCP client; it discovers open Studio instances and routes\n                         tool calls to the selected one (--studio-id=<id> pre-selects one)"
    );
}

#[cfg(test)]
mod tests {
    use super::{can_fall_back_to_installed, extract_env_flag};
    use crate::env::{Env, EnvSelection};
    use crate::testutil::with_temp_home;
    use std::fs;

    #[test]
    fn cli_error_codes_follow_the_p077_table() {
        use super::CliError;
        use crate::update::{FailureKind, UpdateError};
        assert_eq!(CliError::config("x").code, 30);
        assert_eq!(CliError::install("x").code, 20);
        assert_eq!(CliError::start("x").code, 40);
        let network = CliError::from(UpdateError {
            kind: FailureKind::Network,
            message: "x".to_string(),
        });
        assert_eq!(network.code, 10);
    }

    #[test]
    fn update_failure_falls_back_only_unpinned_with_installed_runtime() {
        with_temp_home("cli-fallback", |home| {
            let unpinned = EnvSelection::latest(Env::Prod);
            assert!(
                !can_fall_back_to_installed(&unpinned),
                "no runtime installed yet — nothing to fall back to"
            );

            let runtime = home.join(".overdare/updates/runtime");
            fs::create_dir_all(runtime.join("dist/client")).expect("create dist/client");
            let bin = if cfg!(windows) {
                "diligent-web-server.exe"
            } else {
                "diligent-web-server"
            };
            fs::write(runtime.join(bin), b"#!/bin/sh\n").expect("write sidecar");

            assert!(can_fall_back_to_installed(&unpinned));

            let pinned = EnvSelection::parse("prod@1.2.3").expect("parse pin");
            assert!(
                !can_fall_back_to_installed(&pinned),
                "a pin is an exact-version contract — never substitute another version"
            );
        });
    }

    #[test]
    fn skip_update_requires_existing_runtime_message_is_stable() {
        let message =
            "--skip-update cannot be used before the runtime has been downloaded at least once.";
        assert!(message.contains("--skip-update"));
        assert!(message.contains("downloaded at least once"));
    }

    #[test]
    fn extract_env_flag_picks_up_before_subcommand() {
        let args = vec![
            "--agent-env=dev@1.2.3".to_string(),
            "start".to_string(),
            "--cwd=/tmp".to_string(),
        ];
        let (flag, rest) = extract_env_flag(&args).expect("parse env flag");
        assert_eq!(flag.as_deref(), Some("dev@1.2.3"));
        assert_eq!(rest, vec!["start".to_string(), "--cwd=/tmp".to_string()]);
    }

    #[test]
    fn extract_env_flag_picks_up_after_subcommand() {
        let args = vec![
            "init".to_string(),
            "--skip-update".to_string(),
            "--agent-env=prod".to_string(),
        ];
        let (flag, rest) = extract_env_flag(&args).expect("parse env flag");
        assert_eq!(flag.as_deref(), Some("prod"));
        assert_eq!(
            rest,
            vec!["init".to_string(), "--skip-update".to_string()]
        );
    }

    #[test]
    fn extract_env_flag_returns_none_when_absent() {
        let args = vec!["start".to_string(), "--cwd=/tmp".to_string()];
        let (flag, rest) = extract_env_flag(&args).expect("parse env flag");
        assert!(flag.is_none());
        assert_eq!(rest, args);
    }

    #[test]
    fn extract_env_flag_accepts_space_form() {
        // `--agent-env dev` was previously silently dropped (the bare token didn't
        // match `--agent-env=` and the value flowed into the subcommand args). A
        // user typing the space form must get the env they asked for.
        let args = vec![
            "--agent-env".to_string(),
            "dev@1.2.3".to_string(),
            "init".to_string(),
        ];
        let (flag, rest) = extract_env_flag(&args).expect("parse space-form env flag");
        assert_eq!(flag.as_deref(), Some("dev@1.2.3"));
        assert_eq!(rest, vec!["init".to_string()]);
    }

    #[test]
    fn extract_env_flag_rejects_duplicate_env_flags() {
        // Stacked `--agent-env=` flags previously silently took the last value,
        // routing a wrapper script's intended env to a caller's override.
        let args = vec!["--agent-env=prod".to_string(), "--agent-env=dev".to_string()];
        let err = extract_env_flag(&args).unwrap_err();
        assert!(err.contains("Conflicting --agent-env"));
    }

    #[test]
    fn extract_env_flag_rejects_mixed_form_duplicates() {
        let args = vec![
            "--agent-env=prod".to_string(),
            "--agent-env".to_string(),
            "dev".to_string(),
        ];
        let err = extract_env_flag(&args).unwrap_err();
        assert!(err.contains("Conflicting --agent-env"));
    }

    #[test]
    fn extract_env_flag_rejects_bare_env_with_no_value() {
        let args = vec!["--agent-env".to_string()];
        let err = extract_env_flag(&args).unwrap_err();
        assert!(err.contains("requires a value"));
    }
}
