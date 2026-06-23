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
            if should_copy_entry(existed_before, mode) {
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
