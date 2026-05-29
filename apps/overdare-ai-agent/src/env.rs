use std::str::FromStr;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Env {
    Prod,
    Dev,
}

impl Env {
    pub const fn as_str(self) -> &'static str {
        match self {
            Env::Prod => "prod",
            Env::Dev => "dev",
        }
    }
}

impl FromStr for Env {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "prod" => Ok(Env::Prod),
            "dev" => Ok(Env::Dev),
            other => Err(format!(
                "Unknown env: '{other}' (expected 'prod' or 'dev')"
            )),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvSelection {
    pub env: Env,
    pub pinned_version: Option<String>,
}

impl EnvSelection {
    pub fn latest(env: Env) -> Self {
        EnvSelection {
            env,
            pinned_version: None,
        }
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err("Empty --env value".to_string());
        }
        let (env_part, version_part) = match trimmed.split_once('@') {
            Some((e, v)) => (e, Some(v)),
            None => (trimmed, None),
        };
        let env: Env = env_part.parse()?;
        let pinned_version = match version_part {
            Some(v) if v.trim().is_empty() => {
                return Err(format!(
                    "Empty version after '@' in --env={raw} (use --env={env_part} or --env={env_part}@<version>)",
                    raw = raw,
                    env_part = env_part
                ));
            }
            Some(v) => Some(v.trim().to_string()),
            None => None,
        };
        Ok(EnvSelection {
            env,
            pinned_version,
        })
    }

    pub fn resolve(cli_arg: Option<&str>) -> Result<Self, String> {
        if let Some(raw) = cli_arg {
            return Self::parse(raw);
        }
        if let Ok(raw) = std::env::var("DILIGENT_ENV") {
            if !raw.trim().is_empty() {
                return Self::parse(&raw);
            }
        }
        if let Some(raw) = option_env!("DILIGENT_ENV") {
            if !raw.trim().is_empty() {
                return Self::parse(raw);
            }
        }
        Ok(EnvSelection::latest(Env::Prod))
    }
}

const RELEASE_BASE: &str = "https://github.com/overdare/diligent/releases";

/// Returns the URL to fetch the update manifest for the given env selection.
///
/// Matrix from docs/plan/infra/P067:
///   prod (latest)  → {base}/latest/download/update-manifest-prod.json
///   dev  (latest)  → {base}/download/dev-latest/update-manifest-dev.json
///   prod@<version> → {base}/download/prod-v<version>/update-manifest-prod.json
///   dev @<version> → {base}/download/dev-v<version>/update-manifest-dev.json
///
/// Notes for the implementer:
/// - Use `selection.env.as_str()` for the "prod"/"dev" literal — never hard-code.
/// - Manifest filename is always `update-manifest-{env}.json`.
/// - For "latest" prod we lean on GitHub's `/releases/latest/...` redirect (it skips
///   prereleases, so dev never accidentally surfaces here).
/// - For "latest" dev we use a workflow-maintained rolling release tagged `dev-latest`.
/// - For pinned versions, the tag is `{env}-v{version}` — the version string is taken
///   verbatim from the user's input. We trust them; the GitHub 404 is the validator.
pub fn manifest_url_for(selection: &EnvSelection) -> String {
    let env = selection.env.as_str();
    let manifest_file = format!("update-manifest-{env}.json");
    match (selection.env, selection.pinned_version.as_deref()) {
        (Env::Prod, None) => format!("{RELEASE_BASE}/latest/download/{manifest_file}"),
        (Env::Dev, None) => format!("{RELEASE_BASE}/download/dev-latest/{manifest_file}"),
        (_, Some(version)) => {
            format!("{RELEASE_BASE}/download/{env}-v{version}/{manifest_file}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_env_only_defaults_to_latest() {
        let s = EnvSelection::parse("prod").unwrap();
        assert_eq!(s.env, Env::Prod);
        assert_eq!(s.pinned_version, None);
    }

    #[test]
    fn parse_env_with_version_pins() {
        let s = EnvSelection::parse("dev@1.4.0-beta.2").unwrap();
        assert_eq!(s.env, Env::Dev);
        assert_eq!(s.pinned_version.as_deref(), Some("1.4.0-beta.2"));
    }

    #[test]
    fn parse_unknown_env_errors() {
        assert!(EnvSelection::parse("staging").is_err());
    }

    #[test]
    fn parse_empty_version_errors() {
        let err = EnvSelection::parse("prod@").unwrap_err();
        assert!(err.contains("Empty version"));
    }

    #[test]
    fn parse_empty_input_errors() {
        assert!(EnvSelection::parse("   ").is_err());
    }

    #[test]
    fn resolve_cli_arg_wins() {
        let s = EnvSelection::resolve(Some("dev@9.9.9")).unwrap();
        assert_eq!(s.env, Env::Dev);
        assert_eq!(s.pinned_version.as_deref(), Some("9.9.9"));
    }

    #[test]
    fn url_prod_latest() {
        let s = EnvSelection::latest(Env::Prod);
        assert_eq!(
            manifest_url_for(&s),
            "https://github.com/overdare/diligent/releases/latest/download/update-manifest-prod.json"
        );
    }

    #[test]
    fn url_dev_latest_uses_rolling_tag() {
        let s = EnvSelection::latest(Env::Dev);
        assert_eq!(
            manifest_url_for(&s),
            "https://github.com/overdare/diligent/releases/download/dev-latest/update-manifest-dev.json"
        );
    }

    #[test]
    fn url_prod_pinned() {
        let s = EnvSelection::parse("prod@1.2.3").unwrap();
        assert_eq!(
            manifest_url_for(&s),
            "https://github.com/overdare/diligent/releases/download/prod-v1.2.3/update-manifest-prod.json"
        );
    }

    #[test]
    fn url_dev_pinned_with_prerelease_suffix() {
        let s = EnvSelection::parse("dev@1.4.0-beta.2").unwrap();
        assert_eq!(
            manifest_url_for(&s),
            "https://github.com/overdare/diligent/releases/download/dev-v1.4.0-beta.2/update-manifest-dev.json"
        );
    }
}
