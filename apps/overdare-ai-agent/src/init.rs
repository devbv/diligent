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

/// Sync a directory that mixes product-managed entries (shipped in bootstrap)
/// with user-created ones. `~/.overdare/skills` and `~/.overdare/agents` are
/// discovered as global user extension locations (skills/agents discovery.ts),
/// yet they also hold the bundled product skills/agents. Overwrite only the
/// entries whose names exist in the bootstrap source; never delete a user-added
/// entry that isn't shipped. Mirrors deploy_plugins' per-entry behavior instead
/// of remove_dir_all-ing the whole destination (which wiped user content).
///
/// ponytail: an entry dropped from a newer bootstrap lingers in dest (we can't
/// tell "user removed a product skill" from "user's own skill"). Upgrade path:
/// track a manifest of product-managed names and prune those absent from src.
fn deploy_managed_dir(
    src: &Path,
    dest: &Path,
    log: &mut String,
    mode: DeployMode,
) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    let dir_label = dest.file_name().unwrap_or_default().to_string_lossy().into_owned();
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let src_child = entry.path();
        let dest_child = dest.join(&name);
        let exists = dest_child.exists();
        if !should_copy_entry(exists, mode) {
            let _ = writeln!(
                log,
                "[init] Kept existing {}/{}",
                dir_label,
                name.to_string_lossy()
            );
            continue;
        }
        if exists {
            if dest_child.is_dir() {
                fs::remove_dir_all(&dest_child)?;
            } else {
                fs::remove_file(&dest_child)?;
            }
        }
        if src_child.is_dir() {
            copy_dir_recursive(&src_child, &dest_child)?;
        } else {
            fs::copy(&src_child, &dest_child)?;
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
                // skills/agents (and any bootstrap dir) mix bundled product
                // entries with user-created ones; sync per-entry so an applied
                // update overwrites bundled names but preserves user additions.
                let _ = deploy_managed_dir(&src, &dest, &mut log, mode);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn managed_dir_overwrites_product_and_preserves_user_entries() {
        // Simulate an applied update (FullSync) syncing bootstrap skills over a
        // global skills dir that holds a bundled skill + a user-made skill.
        let base = std::env::temp_dir()
            .join(format!("overdare-init-managed-fullsync-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let src = base.join("bootstrap-skills");
        let dest = base.join("global-skills");

        // Bootstrap ships one product skill with new content.
        write(&src.join("agent-guide/SKILL.md"), "v2 product");
        // Global dir has the old product skill + a user-created skill.
        write(&dest.join("agent-guide/SKILL.md"), "v1 product");
        write(&dest.join("my-skill/SKILL.md"), "user content");

        let mut log = String::new();
        deploy_managed_dir(&src, &dest, &mut log, DeployMode::FullSync).unwrap();

        // Product skill overwritten; user skill untouched.
        assert_eq!(
            fs::read_to_string(dest.join("agent-guide/SKILL.md")).unwrap(),
            "v2 product"
        );
        assert_eq!(
            fs::read_to_string(dest.join("my-skill/SKILL.md")).unwrap(),
            "user content",
            "user-created skill must survive an update"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn managed_dir_missing_only_keeps_existing_product_entry() {
        // Non-update run (MissingOnly): don't touch an existing bundled entry.
        let base = std::env::temp_dir().join(format!(
            "overdare-init-managed-missingonly-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        let src = base.join("bootstrap-skills");
        let dest = base.join("global-skills");

        write(&src.join("agent-guide/SKILL.md"), "v2 product");
        write(&dest.join("agent-guide/SKILL.md"), "v1 product");

        let mut log = String::new();
        deploy_managed_dir(&src, &dest, &mut log, DeployMode::MissingOnly).unwrap();

        assert_eq!(
            fs::read_to_string(dest.join("agent-guide/SKILL.md")).unwrap(),
            "v1 product",
            "MissingOnly must not overwrite an existing entry"
        );

        let _ = fs::remove_dir_all(&base);
    }

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
