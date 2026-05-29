use std::path::{Path, PathBuf};

use crate::env::Env;

pub const DEFAULT_STORAGE_NAMESPACE: &str = "diligent";
pub const PACKAGED_STORAGE_NAMESPACE_PROD: &str = "overdare";
pub const PACKAGED_STORAGE_NAMESPACE_DEV: &str = "overdare-dev";

pub fn storage_namespace(env: Env) -> &'static str {
    if let Some(value) = option_env!("DILIGENT_STORAGE_NAMESPACE") {
        if !value.trim().is_empty() {
            return value;
        }
    }
    match env {
        Env::Prod => PACKAGED_STORAGE_NAMESPACE_PROD,
        Env::Dev => PACKAGED_STORAGE_NAMESPACE_DEV,
    }
}

pub fn hidden_dir_name(env: Env) -> String {
    format!(".{}", storage_namespace(env))
}

/// The pre-P067 directory name (`.diligent`), shared across all envs.
///
/// Legacy paths intentionally do NOT take an `Env` argument: there was no
/// per-env directory before P067, so there is only one possible legacy
/// location per host/project. Migration callers pair this with an
/// `env`-aware target path produced by [`hidden_dir_name`].
pub fn legacy_hidden_dir_name() -> String {
    format!(".{}", DEFAULT_STORAGE_NAMESPACE)
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME").map(PathBuf::from);
    home
}

pub fn global_storage_dir(env: Env) -> Option<PathBuf> {
    home_dir().map(|h| h.join(hidden_dir_name(env)))
}

pub fn global_legacy_storage_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(legacy_hidden_dir_name()))
}

pub fn local_storage_dir(cwd: &str, env: Env) -> PathBuf {
    PathBuf::from(cwd).join(hidden_dir_name(env))
}

pub fn local_legacy_storage_dir(cwd: &str) -> PathBuf {
    PathBuf::from(cwd).join(legacy_hidden_dir_name())
}

pub fn migrate_global_namespace_if_needed(env: Env) -> Result<MigrationOutcome, String> {
    if !env_uses_legacy_migration(env) {
        return Ok(MigrationOutcome::SkippedByPolicy);
    }
    let legacy =
        global_legacy_storage_dir().ok_or("Cannot determine home directory for migration")?;
    let target = global_storage_dir(env).ok_or("Cannot determine home directory for migration")?;
    migrate_namespace_if_needed(&legacy, &target)
}

pub fn migrate_local_namespace_if_needed(
    cwd: &str,
    env: Env,
) -> Result<MigrationOutcome, String> {
    if !env_uses_legacy_migration(env) {
        return Ok(MigrationOutcome::SkippedByPolicy);
    }
    let legacy = local_legacy_storage_dir(cwd);
    let target = local_storage_dir(cwd, env);
    migrate_namespace_if_needed(&legacy, &target)
}

fn env_uses_legacy_migration(env: Env) -> bool {
    matches!(env, Env::Prod)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationOutcome {
    /// Successfully moved the legacy directory onto the target path.
    Migrated { from: PathBuf, to: PathBuf },
    /// No legacy directory existed to migrate from. Treated as a clean install.
    SkippedNoLegacy,
    /// The target directory already exists; legacy data was left untouched.
    SkippedTargetExists,
    /// The current env's policy disables legacy migration entirely (e.g. dev,
    /// which has no `.diligent-dev` predecessor on disk).
    SkippedByPolicy,
}

pub fn migrate_namespace_if_needed(
    legacy: &Path,
    target: &Path,
) -> Result<MigrationOutcome, String> {
    if target.exists() {
        return Ok(MigrationOutcome::SkippedTargetExists);
    }
    if !legacy.exists() {
        return Ok(MigrationOutcome::SkippedNoLegacy);
    }
    std::fs::rename(legacy, target)
        .map(|_| MigrationOutcome::Migrated {
            from: legacy.to_path_buf(),
            to: target.to_path_buf(),
        })
        .map_err(|e| {
            format!(
                "Failed to migrate {} -> {}: {e}",
                legacy.display(),
                target.display()
            )
        })
}

#[cfg(test)]
mod tests {
    use super::{
        hidden_dir_name, legacy_hidden_dir_name, migrate_namespace_if_needed, storage_namespace,
        MigrationOutcome, PACKAGED_STORAGE_NAMESPACE_DEV, PACKAGED_STORAGE_NAMESPACE_PROD,
    };
    use crate::env::Env;
    use std::fs;
    use std::path::PathBuf;

    fn unique_temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "overdare-ai-agent-storage-test-{}-{}-{}",
            label,
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ))
    }

    #[test]
    fn prod_namespace_defaults_to_overdare() {
        assert_eq!(storage_namespace(Env::Prod), PACKAGED_STORAGE_NAMESPACE_PROD);
        assert_eq!(hidden_dir_name(Env::Prod), ".overdare");
        assert_eq!(legacy_hidden_dir_name(), ".diligent");
    }

    #[test]
    fn dev_namespace_defaults_to_overdare_dev() {
        assert_eq!(storage_namespace(Env::Dev), PACKAGED_STORAGE_NAMESPACE_DEV);
        assert_eq!(hidden_dir_name(Env::Dev), ".overdare-dev");
    }

    #[test]
    fn dev_env_skips_global_migration_by_policy() {
        let outcome = super::migrate_global_namespace_if_needed(Env::Dev).expect("dev skip");
        assert_eq!(outcome, MigrationOutcome::SkippedByPolicy);
    }

    #[test]
    fn dev_env_skips_local_migration_by_policy() {
        let outcome = super::migrate_local_namespace_if_needed("/tmp/whatever", Env::Dev)
            .expect("dev skip local");
        assert_eq!(outcome, MigrationOutcome::SkippedByPolicy);
    }

    #[test]
    fn migrate_namespace_if_needed_moves_legacy_when_target_missing() {
        let root = unique_temp_dir("migrated");
        let legacy = root.join(".diligent");
        let target = root.join(".overdare");
        fs::create_dir_all(&legacy).expect("create legacy dir");
        fs::write(legacy.join("state.txt"), "ok").expect("write legacy file");

        let outcome = migrate_namespace_if_needed(&legacy, &target).expect("migrate namespace");
        assert!(matches!(outcome, MigrationOutcome::Migrated { .. }));
        assert!(!legacy.exists());
        assert_eq!(
            fs::read_to_string(target.join("state.txt")).expect("read target file"),
            "ok"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_namespace_if_needed_skips_when_legacy_missing() {
        let root = unique_temp_dir("skip-no-legacy");
        let legacy = root.join(".diligent");
        let target = root.join(".overdare");

        let outcome = migrate_namespace_if_needed(&legacy, &target).expect("skip without legacy");
        assert_eq!(outcome, MigrationOutcome::SkippedNoLegacy);
        assert!(!target.exists());
    }

    #[test]
    fn migrate_namespace_if_needed_skips_when_target_exists() {
        let root = unique_temp_dir("skip-target-exists");
        let legacy = root.join(".diligent");
        let target = root.join(".overdare");
        fs::create_dir_all(&legacy).expect("create legacy dir");
        fs::create_dir_all(&target).expect("create target dir");
        fs::write(legacy.join("legacy.txt"), "legacy").expect("write legacy file");

        let outcome =
            migrate_namespace_if_needed(&legacy, &target).expect("skip when target exists");
        assert_eq!(outcome, MigrationOutcome::SkippedTargetExists);
        assert!(legacy.exists());
        assert!(target.exists());

        let _ = fs::remove_dir_all(&root);
    }
}
