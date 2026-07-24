use std::fmt::Write as FmtWrite;
use std::fs;
use std::path::{Path, PathBuf};

use crate::env::Env;
use crate::storage::global_storage_dir;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DeployMode {
    MissingOnly,
    FullSync,
}

fn should_copy_entry(dest_exists: bool, mode: DeployMode) -> bool {
    match mode {
        DeployMode::MissingOnly => !dest_exists,
        DeployMode::FullSync => true,
    }
}

/// Deploy mode for a single bootstrap file. `config.jsonc` holds user settings
/// (model, permissions/commit delegation, tool toggles, MCP servers) that only
/// ever live in the global config; an applied update must never clobber it, so
/// force MissingOnly regardless of the run's mode. Every other bootstrap file
/// (e.g. system-prompt.txt) keeps the run's mode and still FullSyncs on update.
fn deploy_mode_for_file(name: &str, mode: DeployMode) -> DeployMode {
    if name == "config.jsonc" {
        DeployMode::MissingOnly
    } else {
        mode
    }
}

fn resolve_updated_bootstrap_dir(env: Env, log: &mut String) -> Option<PathBuf> {
    // Resolve bootstrap/defaults from the active runtime directory (versioned
    // pointer first, legacy flat dir as fallback) so init deploys assets from
    // the same runtime that start will launch.
    let runtime = crate::update::current_runtime_dir(env)?;

    let bootstrap = runtime.join("bootstrap");
    if bootstrap.exists() {
        let _ = writeln!(
            log,
            "[init] Using updated bootstrap path: {}",
            bootstrap.display()
        );
        return Some(bootstrap);
    }

    let defaults = runtime.join("defaults");
    if defaults.exists() {
        let _ = writeln!(
            log,
            "[init] Falling back to legacy defaults path: {}",
            defaults.display()
        );
        return Some(defaults);
    }

    None
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path)?;
        }
    }
    Ok(())
}

fn deploy_plugins(
    src: &Path,
    dest: &Path,
    log: &mut String,
    mode: DeployMode,
) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let src_child = entry.path();
        let dest_child = dest.join(&name);
        if !src_child.is_dir() {
            continue;
        }
        if name_str.starts_with('@') {
            fs::create_dir_all(&dest_child)?;
            for plugin_entry in fs::read_dir(&src_child)? {
                let plugin_entry = plugin_entry?;
                let plugin_name = plugin_entry.file_name();
                let src_plugin = plugin_entry.path();
                let dest_plugin = dest_child.join(&plugin_name);
                if !src_plugin.is_dir() {
                    continue;
                }
                let exists = dest_plugin.exists();
                if !should_copy_entry(exists, mode) {
                    let _ = writeln!(
                        log,
                        "[init] Kept existing plugins/{}/{}/",
                        name_str,
                        plugin_name.to_string_lossy()
                    );
                    continue;
                }
                if exists {
                    fs::remove_dir_all(&dest_plugin)?;
                }
                copy_dir_recursive(&src_plugin, &dest_plugin)?;
            }
        } else {
            let exists = dest_child.exists();
            if !should_copy_entry(exists, mode) {
                continue;
            }
            if exists {
                fs::remove_dir_all(&dest_child)?;
            }
            copy_dir_recursive(&src_child, &dest_child)?;
        }
    }
    Ok(())
}

pub fn run(env: Env, update_applied: bool) -> Result<(), String> {
    let mut log = String::new();
    let mode = if update_applied {
        DeployMode::FullSync
    } else {
        DeployMode::MissingOnly
    };
    let Some(global) = global_storage_dir(env) else {
        return Ok(());
    };
    fs::create_dir_all(&global).map_err(|e| format!("Cannot create {}: {e}", global.display()))?;
    let Some(bootstrap) = resolve_updated_bootstrap_dir(env, &mut log) else {
        return Ok(());
    };
    let entries =
        fs::read_dir(&bootstrap).map_err(|e| format!("Cannot read bootstrap dir: {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let src = entry.path();
        let dest = global.join(&name);
        if src.is_file() {
            let existed_before = dest.exists();
            let file_mode = deploy_mode_for_file(&name.to_string_lossy(), mode);
            if should_copy_entry(existed_before, file_mode) {
                let _ = fs::copy(&src, &dest);
            }
        } else if src.is_dir() {
            if name.to_string_lossy() == "plugins" {
                let _ = deploy_plugins(&src, &dest, &mut log, mode);
            } else {
                let existed_before = dest.exists();
                if !should_copy_entry(existed_before, mode) {
                    continue;
                }
                if existed_before {
                    let _ = fs::remove_dir_all(&dest);
                }
                let _ = copy_dir_recursive(&src, &dest);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_jsonc_is_never_overwritten_on_full_sync() {
        // The whole point of the fix: an applied update (FullSync) must not
        // clobber the user's existing global config.jsonc.
        let mode = deploy_mode_for_file("config.jsonc", DeployMode::FullSync);
        assert_eq!(mode, DeployMode::MissingOnly);
        assert!(!should_copy_entry(true, mode)); // exists -> keep user's file
        assert!(should_copy_entry(false, mode)); // missing -> seed from bootstrap
    }

    #[test]
    fn other_files_still_full_sync() {
        // system-prompt.txt and friends are stock assets: keep overwriting them.
        let mode = deploy_mode_for_file("system-prompt.txt", DeployMode::FullSync);
        assert_eq!(mode, DeployMode::FullSync);
        assert!(should_copy_entry(true, mode));
    }

    #[test]
    fn missing_only_run_is_unchanged_for_config() {
        // On a non-update run the whole deploy is MissingOnly already; the
        // config.jsonc special case must not change that.
        assert_eq!(
            deploy_mode_for_file("config.jsonc", DeployMode::MissingOnly),
            DeployMode::MissingOnly
        );
    }
}
