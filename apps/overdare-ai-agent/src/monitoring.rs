//! Sentry crash/error reporting for the launcher (Sentry project: diligent-launcher).
//!
//! No-ops without a DSN: runtime `SENTRY_DSN` overrides the compile-time value CI
//! bakes via `option_env!` (same pattern as storage.rs's namespace). Privacy policy
//! (docs/plan/infra/sentry-integration.md): diagnostics only — home paths are
//! scrubbed and no conversation content exists at this layer.

use std::time::Duration;

fn resolve_dsn() -> Option<String> {
    match std::env::var("SENTRY_DSN") {
        Ok(value) if !value.trim().is_empty() => Some(value),
        _ => option_env!("SENTRY_DSN").map(str::to_string),
    }
}

/// Replaces the home directory in `message` so usernames never leave the machine.
fn scrub_home(message: &str) -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    if home.is_empty() {
        message.to_string()
    } else {
        message.replace(&home, "~")
    }
}

/// Initializes Sentry; returns `None` (fully disabled) when no DSN is configured.
/// Hold the guard for the whole command run — its Drop flushes pending events.
pub fn init(environment: &str) -> Option<sentry::ClientInitGuard> {
    let dsn = resolve_dsn()?;
    // Cargo.toml's version is a fixed 0.0.1; the real launcher version is the CI
    // release version, baked at build time (same pattern as the DSN above).
    let release = match option_env!("LAUNCHER_VERSION") {
        Some(version) => Some(format!("overdare-ai-agent@{version}").into()),
        None => sentry::release_name!(),
    };
    let guard = sentry::init((
        dsn,
        sentry::ClientOptions {
            release,
            environment: Some(environment.to_string().into()),
            ..Default::default()
        },
    ));
    // SENTRY_TEST marks the whole run as a manual test: events still record, but
    // alert rules filter on no_alert != true so the Slack channel stays quiet.
    if std::env::var("SENTRY_TEST").is_ok_and(|value| !value.is_empty()) {
        sentry::configure_scope(|scope| scope.set_tag("no_alert", "true"));
    }
    // The release profile builds with `panic = "abort"`, so unwinding — and the
    // guard's Drop flush — never happens on panic. Chain a synchronous flush onto
    // the panic hook; sentry's own hook (`prev`) has already captured the event.
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        prev(info);
        if let Some(client) = sentry::Hub::current().client() {
            client.flush(Some(Duration::from_secs(2)));
        }
    }));
    Some(guard)
}

/// Reports a fatal CLI failure (P077 exit-code contract) before the process exits.
pub fn capture_cli_error(code: i32, message: &str) {
    sentry::with_scope(
        |scope| scope.set_tag("exit_code", code),
        || sentry::capture_message(&scrub_home(message), sentry::Level::Error),
    );
}

/// Reports a swallowed failure (e.g. init falling back to the installed runtime).
pub fn capture_warning(message: &str) {
    sentry::capture_message(&scrub_home(message), sentry::Level::Warning);
}

/// Attaches scrubbed diagnostic content to the current Sentry scope as an
/// extra. It rides along on whatever error event is captured next (extras do
/// not affect issue grouping); no-op when Sentry is disabled.
pub fn attach_diagnostics(key: &str, content: &str) {
    let value = scrub_home(content);
    sentry::configure_scope(|scope| scope.set_extra(key, value.into()));
}

#[cfg(test)]
mod tests {
    use super::scrub_home;

    #[test]
    fn scrub_home_replaces_home_prefix() {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .expect("test environment has a home dir");
        let message = format!("failed to write {}/.overdare/updates", home);
        let scrubbed = scrub_home(&message);
        assert!(!scrubbed.contains(&home));
        assert!(scrubbed.contains("~/.overdare/updates"));
    }
}
