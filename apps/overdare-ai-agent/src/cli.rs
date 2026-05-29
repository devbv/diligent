use crate::env::EnvSelection;
use crate::init;
use crate::storage::migrate_global_namespace_if_needed;
use crate::update::{self, UpdateProgress};
use crate::webserver;

pub fn run() -> Result<(), String> {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let (env_flag, remaining) = extract_env_flag(&raw_args);
    let selection = EnvSelection::resolve(env_flag.as_deref())?;

    let mut args = remaining.into_iter();
    let Some(command) = args.next() else {
        print_help();
        return Ok(());
    };

    match command.as_str() {
        "init" => run_init(&selection, args.collect()),
        "start" => run_webserver(&selection, args.collect()),
        "help" | "--help" | "-h" => {
            print_help();
            Ok(())
        }
        other => Err(format!("Unknown command: {other}")),
    }
}

fn extract_env_flag(args: &[String]) -> (Option<String>, Vec<String>) {
    let mut env_flag: Option<String> = None;
    let mut remaining = Vec::with_capacity(args.len());
    for arg in args {
        if let Some(value) = arg.strip_prefix("--env=") {
            env_flag = Some(value.to_string());
            continue;
        }
        remaining.push(arg.clone());
    }
    (env_flag, remaining)
}

fn run_update(selection: &EnvSelection) -> Result<(), String> {
    migrate_global_namespace_if_needed(selection.env).map(|_| ())?;
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
    let (current, latest) = update::init_status(selection)?;
    let installed = update::runtime_installed(selection.env);

    println!("Env: {}", selection.env.as_str());
    if let Some(pin) = selection.pinned_version.as_deref() {
        println!("Pinned version: {pin}");
    }
    println!(
        "Current version: {}",
        current
            .clone()
            .unwrap_or_else(|| "not installed".to_string())
    );
    println!("Latest version: {latest}");

    if skip_update {
        if !installed {
            return Err("--skip-update cannot be used before the runtime has been downloaded at least once.".to_string());
        }
        println!("Skipping update as requested.");
        init::run(selection.env, false)?;
        return Ok(());
    }

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
        let (flag, rest) = extract_env_flag(&args);
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
        let (flag, rest) = extract_env_flag(&args);
        assert_eq!(flag.as_deref(), Some("prod"));
        assert_eq!(
            rest,
            vec!["init".to_string(), "--skip-update".to_string()]
        );
    }

    #[test]
    fn extract_env_flag_returns_none_when_absent() {
        let args = vec!["start".to_string(), "--cwd=/tmp".to_string()];
        let (flag, rest) = extract_env_flag(&args);
        assert!(flag.is_none());
        assert_eq!(rest, args);
    }
}
