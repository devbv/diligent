//! Test helpers shared across modules.
//!
//! Several tests mutate the `HOME` (and on Windows, `USERPROFILE`) environment
//! variable to redirect `global_storage_dir(env)` at runtime. Without a shared
//! lock, parallel test threads poison each other's view of the process-wide
//! env. `HOME_LOCK` serializes any test that touches those vars.

use std::sync::Mutex;

pub static HOME_LOCK: Mutex<()> = Mutex::new(());

/// Run `f` with `HOME` (and `USERPROFILE` on Windows) pointed at a fresh
/// temporary directory. The directory and the env mutation are reverted on
/// exit. The shared `HOME_LOCK` is held for the duration of `f`.
pub fn with_temp_home<F: FnOnce(&std::path::Path)>(label: &str, f: F) {
    let guard = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let root = std::env::temp_dir().join(format!(
        "overdare-ai-agent-test-{}-{}-{}",
        label,
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    std::fs::create_dir_all(&root).expect("create temp home root");

    let previous_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &root);
    #[cfg(windows)]
    let previous_userprofile = std::env::var_os("USERPROFILE");
    #[cfg(windows)]
    std::env::set_var("USERPROFILE", &root);

    f(&root);

    if let Some(home) = previous_home {
        std::env::set_var("HOME", home);
    } else {
        std::env::remove_var("HOME");
    }
    #[cfg(windows)]
    {
        if let Some(profile) = previous_userprofile {
            std::env::set_var("USERPROFILE", profile);
        } else {
            std::env::remove_var("USERPROFILE");
        }
    }
    let _ = std::fs::remove_dir_all(&root);
    drop(guard);
}
