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

/// Per-init staging directory under the global storage root. Kept OUT of the
/// scanned skills/agents dirs so a crash mid-swap can't leave a partial copy
/// that discovery would mistake for a real skill/agent.
fn staging_dir(global: &Path) -> PathBuf {
    global.join(".init-staging")
}

/// Deploy one entry atomically: fully copy it into `staging` first, then swap it
/// into place (drop the old entry, rename the staged copy in). Rename is atomic
/// on the same filesystem, so the destructive window shrinks from a whole
/// recursive copy to a single rename — if staging the copy fails, `dest` is left
/// intact instead of half-deleted, and the error propagates to the caller.
fn stage_and_swap(src: &Path, dest: &Path, staging: &Path) -> std::io::Result<()> {
    fs::create_dir_all(staging)?;
    let staged = staging.join(dest.file_name().unwrap_or_default());
    let _ = fs::remove_dir_all(&staged);
    let _ = fs::remove_file(&staged);

    // 1. Stage the new content. A failure here leaves dest untouched.
    if src.is_dir() {
        copy_dir_recursive(src, &staged)?;
    } else {
        fs::copy(src, &staged)?;
    }

    // 2. Swap it in: remove the old entry, then move the staged copy into place.
    if dest.is_dir() {
        fs::remove_dir_all(dest)?;
    } else if dest.exists() {
        fs::remove_file(dest)?;
    }
    fs::rename(&staged, dest)
}

fn deploy_plugins(
    src: &Path,
    dest: &Path,
    staging: &Path,
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
                if let Err(e) = stage_and_swap(&src_plugin, &dest_plugin, staging) {
                    // Log and keep going: one bad entry must not abort the whole
                    // deploy or block agent start (P077 keeps a bootable install).
                    eprintln!(
                        "[init] Failed to deploy plugins/{}/{}: {e}",
                        name_str,
                        plugin_name.to_string_lossy()
                    );
                }
            }
        } else {
            let exists = dest_child.exists();
            if !should_copy_entry(exists, mode) {
                continue;
            }
            if let Err(e) = stage_and_swap(&src_child, &dest_child, staging) {
                eprintln!("[init] Failed to deploy plugins/{name_str}: {e}");
            }
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
    staging: &Path,
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
        if let Err(e) = stage_and_swap(&src_child, &dest_child, staging) {
            // Log and keep going: a failed entry leaves its old copy intact
            // (stage_and_swap swaps only after a full copy) and must not abort
            // the deploy or block agent start (P077).
            eprintln!(
                "[init] Failed to deploy {}/{}: {e}",
                dir_label,
                name.to_string_lossy()
            );
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
    // Fresh staging dir for atomic swaps; clear any leftovers from a prior crash.
    let staging = staging_dir(&global);
    let _ = fs::remove_dir_all(&staging);
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
                if let Err(e) = stage_and_swap(&src, &dest, &staging) {
                    eprintln!("[init] Failed to deploy {}: {e}", name.to_string_lossy());
                }
            }
        } else if src.is_dir() {
            if name.to_string_lossy() == "plugins" {
                let _ = deploy_plugins(&src, &dest, &staging, &mut log, mode);
            } else {
                // skills/agents (and any bootstrap dir) mix bundled product
                // entries with user-created ones; sync per-entry so an applied
                // update overwrites bundled names but preserves user additions.
                let _ = deploy_managed_dir(&src, &dest, &staging, &mut log, mode);
            }
        }
    }
    let _ = fs::remove_dir_all(&staging);
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
        deploy_managed_dir(&src, &dest, &base.join(".staging"), &mut log, DeployMode::FullSync)
            .unwrap();

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
        deploy_managed_dir(&src, &dest, &base.join(".staging"), &mut log, DeployMode::MissingOnly)
            .unwrap();

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

    #[test]
    fn failed_stage_keeps_existing_dest_intact() {
        // The anti-data-loss guarantee: if staging the new copy fails, the old
        // dest must survive (no remove-then-failed-copy destruction).
        let base = std::env::temp_dir()
            .join(format!("overdare-init-staging-fail-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let missing_src = base.join("does-not-exist");
        let dest = base.join("skill");
        write(&dest.join("SKILL.md"), "old content");

        let result = stage_and_swap(&missing_src, &dest, &base.join(".staging"));

        assert!(result.is_err(), "copying a missing source must fail");
        assert_eq!(
            fs::read_to_string(dest.join("SKILL.md")).unwrap(),
            "old content",
            "dest must be untouched when staging fails"
        );

        let _ = fs::remove_dir_all(&base);
    }
}
