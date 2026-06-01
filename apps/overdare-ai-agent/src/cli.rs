use crate::env::EnvSelection;
use crate::init;
use crate::storage::migrate_global_namespace_if_needed;
use crate::update::{self, UpdateProgress};
use crate::webserver;

pub fn run() -> Result<(), String> {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let (env_flag, remaining) = extract_env_flag(&raw_args)?;

    let mut args = remaining.into_iter();
    let Some(command) = args.next() else {
        print_help();
        return Ok(());
    };

    // Help must remain reachable even when `--env=<invalid>` is supplied —
    // resolving the env first would block the very flag the help text
    // documents.
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        print_help();
        return Ok(());
    }

    let selection = EnvSelection::resolve(env_flag.as_deref())?;

    match command.as_str() {
        "init" => run_init(&selection, args.collect()),
        "start" => run_webserver(&selection, args.collect()),
        other => Err(format!("Unknown command: {other}")),
    }
}

/// Extracts the `--env=<value>` / `--env <value>` flag from `args`, returning
/// the remaining (non-env) arguments untouched.
///
/// Behavior:
/// - `--env=<value>` and bare `--env <value>` are both accepted; mixing them is
///   fine in different positions but specifying more than one is an error.
/// - A bare `--env` with no following token is rejected — silently treating it
///   as "no env" would route a user who typed `--env dev` (with a space) to
///   prod by default, which is a release-channel footgun.
/// - Duplicate `--env=` flags are rejected so a script that accidentally
///   stacks them does not silently overwrite the first value.
fn extract_env_flag(args: &[String]) -> Result<(Option<String>, Vec<String>), String> {
    let mut env_flag: Option<String> = None;
    let mut remaining = Vec::with_capacity(args.len());
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if let Some(value) = arg.strip_prefix("--env=") {
            if env_flag.is_some() {
                return Err(
                    "Conflicting --env flags. Specify --env exactly once.".to_string(),
                );
            }
            env_flag = Some(value.to_string());
            continue;
        }
        if arg == "--env" {
            let Some(value) = iter.next() else {
                return Err(
                    "--env requires a value (e.g. --env=dev, --env=prod@1.2.3, or --env dev)."
                        .to_string(),
                );
            };
            if env_flag.is_some() {
                return Err(
                    "Conflicting --env flags. Specify --env exactly once.".to_string(),
                );
            }
            env_flag = Some(value.clone());
            continue;
        }
        remaining.push(arg.clone());
    }
    Ok((env_flag, remaining))
}

fn run_update(selection: &EnvSelection) -> Result<(), String> {
    // Migration is owned by the entry point (run_init / start_foreground); this
    // function trusts that it already ran. Calling it here would be idempotent
    // but wasteful — and obscures who is responsible for ordering.
    let mut log = String::new();
    let mut progress = |event: UpdateProgress| match event {
        UpdateProgress::Disabled => println!("update disabled"),
        UpdateProgress::BootstrapRequired => println!("runtime bootstrap required"),
        UpdateProgress::Checking { current_version } => {
            println!("checking updates (current: v{current_version})")
        }
        UpdateProgress::Downloading { target_version } => println!("downloading v{target_version}"),
        UpdateProgress::Verifying { target_version } => println!("verifying v{target_version}"),
        UpdateProgress::Extracting { target_version } => println!("extracting v{target_version}"),
        UpdateProgress::Applying { target_version } => println!("applying v{target_version}"),
        UpdateProgress::UpToDate => println!("already up-to-date"),
        UpdateProgress::Updated { target_version } => println!("updated to v{target_version}"),
    };

    let updated = update::run_with_progress(&mut log, Some(&mut progress), selection)?;
    if !log.is_empty() {
        eprint!("{log}");
    }
    init::run(selection.env, updated)?;
    Ok(())
}

fn run_init(selection: &EnvSelection, args: Vec<String>) -> Result<(), String> {
    migrate_global_namespace_if_needed(selection.env).map(|_| ())?;
    let skip_update = args.iter().any(|arg| arg == "--skip-update");

    // Echo the resolved env/pin before doing any network work so a user
    // troubleshooting "is --env even being picked up?" sees the parsed
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
            return Err("--skip-update cannot be used before the runtime has been downloaded at least once.".to_string());
        }
        println!("Current version: {}", current_display());
        println!("Skipping update as requested.");
        init::run(selection.env, false)?;
        return Ok(());
    }

    let (_, latest) = update::init_status(selection)?;
    println!("Current version: {}", current_display());
    println!("Latest version: {latest}");
    run_update(selection)
}

fn run_webserver(selection: &EnvSelection, args: Vec<String>) -> Result<(), String> {
    let options = webserver::parse_args(&args, selection.env)?;
    let runtime = tokio::runtime::Runtime::new()
        .map_err(|e| format!("failed to create tokio runtime: {e}"))?;
    let running = runtime.block_on(webserver::start_foreground(options))?;
    println!("WEBSERVER_PORT={}", running.port);
    runtime.block_on(running.wait())?;
    Ok(())
}

fn print_help() {
    println!(
        "overdare-ai-agent\n\nGlobal flags:\n  --env=<env>[@<version>]   Select release env (prod|dev). Optionally pin a version, e.g. prod@1.2.3 or dev@1.4.0-beta.2. Defaults to prod.\n\nCommands:\n  init [--skip-update]   Ensure runtime exists, print current/latest, and update unless skipped\n  start [options]        Run updated runtime diligent-web-server as a subprocess"
    );
}

#[cfg(test)]
mod tests {
    use super::extract_env_flag;

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
            "--env=dev@1.2.3".to_string(),
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
            "--env=prod".to_string(),
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
        // `--env dev` was previously silently dropped (the bare token didn't
        // match `--env=` and the value flowed into the subcommand args). A
        // user typing the space form must get the env they asked for.
        let args = vec![
            "--env".to_string(),
            "dev@1.2.3".to_string(),
            "init".to_string(),
        ];
        let (flag, rest) = extract_env_flag(&args).expect("parse space-form env flag");
        assert_eq!(flag.as_deref(), Some("dev@1.2.3"));
        assert_eq!(rest, vec!["init".to_string()]);
    }

    #[test]
    fn extract_env_flag_rejects_duplicate_env_flags() {
        // Stacked `--env=` flags previously silently took the last value,
        // routing a wrapper script's intended env to a caller's override.
        let args = vec!["--env=prod".to_string(), "--env=dev".to_string()];
        let err = extract_env_flag(&args).unwrap_err();
        assert!(err.contains("Conflicting --env"));
    }

    #[test]
    fn extract_env_flag_rejects_mixed_form_duplicates() {
        let args = vec![
            "--env=prod".to_string(),
            "--env".to_string(),
            "dev".to_string(),
        ];
        let err = extract_env_flag(&args).unwrap_err();
        assert!(err.contains("Conflicting --env"));
    }

    #[test]
    fn extract_env_flag_rejects_bare_env_with_no_value() {
        let args = vec!["--env".to_string()];
        let err = extract_env_flag(&args).unwrap_err();
        assert!(err.contains("requires a value"));
    }
}
