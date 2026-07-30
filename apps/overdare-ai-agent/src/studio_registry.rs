//! Reader for the per-Studio sidecar registration records the MCP router discovers instances from
//! (P071 Task 2, Rust half).
//!
//! The writer is `apps/overdare-ai-agent/sidecar/src/studio-registry.ts`. The two sides agree only
//! through the directory path and the JSON field names below — keep them in step.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::env::Env;
use crate::mcp_protocol::{PromptDescriptor, ToolDescriptor};
use crate::storage::global_storage_dir;

/// How long a record stays trusted after its last heartbeat. Mirrors the sidecar's
/// `DEFAULT_STALE_AFTER_MS` (three missed 5 s heartbeats).
pub const DEFAULT_STALE_AFTER: Duration = Duration::from_secs(15);

/// The sidecar's snapshot of its MCP surface, carried in the record so the router can answer
/// `tools/list` without a round-trip — and even when no Studio is currently live.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct CatalogSnapshot {
    #[serde(default)]
    pub tools: Vec<ToolDescriptor>,
    #[serde(default)]
    pub prompts: Vec<PromptDescriptor>,
    #[serde(default)]
    pub instructions: Option<String>,
}

/// Deliberately not `Deserialize`: the on-disk record is camelCase, so it is parsed by
/// [`record_from_value`] instead. A derive here would silently accept snake_case JSON no sidecar
/// writes.
#[derive(Debug, Clone, PartialEq)]
pub struct StudioInstanceRecord {
    pub id: String,
    pub display_name: String,
    pub cwd: String,
    pub project_id: Option<String>,
    pub studio_host: String,
    pub studio_port: u16,
    pub sidecar_url: String,
    pub sidecar_token: String,
    pub pid: i64,
    pub started_at: String,
    pub heartbeat_at: String,
    pub catalog: Option<CatalogSnapshot>,
}

/// serde's `rename_all` cannot be applied selectively, and the record is camelCase on disk while
/// Rust fields are snake_case, so the mapping is spelled out here. Doing it by hand (rather than
/// with a `#[serde(rename_all = "camelCase")]` derive) is deliberate: every field is optional-safe,
/// so a record written by an older or newer sidecar still parses as long as it carries the four
/// fields the router genuinely needs to route a call.
fn record_from_value(value: &Value) -> Option<StudioInstanceRecord> {
    let id = value.get("id")?.as_str()?.to_string();
    let sidecar_url = value.get("sidecarUrl")?.as_str()?.to_string();
    let sidecar_token = value.get("sidecarToken")?.as_str()?.to_string();
    let heartbeat_at = value.get("heartbeatAt")?.as_str()?.to_string();
    if id.is_empty() || sidecar_url.is_empty() || sidecar_token.is_empty() {
        return None;
    }
    let str_field = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    Some(StudioInstanceRecord {
        id,
        display_name: str_field("displayName"),
        cwd: str_field("cwd"),
        project_id: value
            .get("projectId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        studio_host: str_field("studioHost"),
        studio_port: value
            .get("studioPort")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .unwrap_or_default(),
        sidecar_url,
        sidecar_token,
        pid: value.get("pid").and_then(Value::as_i64).unwrap_or_default(),
        started_at: str_field("startedAt"),
        heartbeat_at,
        catalog: value
            .get("catalog")
            .and_then(|catalog| serde_json::from_value(catalog.clone()).ok()),
    })
}

impl StudioInstanceRecord {
    /// Label for the ambiguous-Studio error and `list_overdare_studios` output.
    pub fn label(&self) -> String {
        if self.display_name.is_empty() {
            self.cwd.clone()
        } else {
            self.display_name.clone()
        }
    }

    /// Whether the last heartbeat is recent enough to trust.
    ///
    /// A heartbeat in the future is clock skew between the writing sidecar and this process, not
    /// staleness — treat it as fresh rather than hiding a Studio that is plainly alive.
    pub fn is_fresh(&self, now: chrono::DateTime<chrono::Utc>, stale_after: Duration) -> bool {
        let Ok(beat) = chrono::DateTime::parse_from_rfc3339(&self.heartbeat_at) else {
            return false;
        };
        let age = now.signed_duration_since(beat.with_timezone(&chrono::Utc));
        age.num_milliseconds() <= stale_after.as_millis() as i64
    }
}

/// Registry directory. Must stay byte-identical to the sidecar's `resolveRegistryDir()`.
pub fn registry_dir(env: Env) -> Option<PathBuf> {
    global_storage_dir(env).map(|dir| dir.join("mcp").join("studios"))
}

/// Read every parseable record in `dir`, newest heartbeat first.
///
/// Unreadable and malformed files are skipped rather than failing the whole read: a sidecar
/// mid-write, a truncated file from a hard kill, or a stray file in the directory must not be able
/// to make the router blind to healthy Studios. (The writer renames into place, so a torn read is
/// unlikely — this is the belt to that braces.)
pub fn read_all(dir: &Path) -> Vec<StudioInstanceRecord> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut records = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if let Some(record) = record_from_value(&value) {
            records.push(record);
        }
    }
    records.sort_by(|a, b| heartbeat_key(b).cmp(&heartbeat_key(a)));
    records
}

fn heartbeat_key(record: &StudioInstanceRecord) -> i64 {
    chrono::DateTime::parse_from_rfc3339(&record.heartbeat_at)
        .map(|beat| beat.timestamp_millis())
        .unwrap_or(i64::MIN)
}

/// Records whose heartbeat is fresh, newest first.
///
/// Unlike the sidecar's `list`, this does not check PID liveness: doing so portably would mean a
/// `libc`/`windows-sys` dependency, which the size budget that put the router in this executable
/// does not have room for. Heartbeat age already bounds how long a dead sidecar lingers, and the
/// router additionally probes reachability (`studio_router::probe`) before it commits to a choice.
pub fn read_live(
    dir: &Path,
    now: chrono::DateTime<chrono::Utc>,
    stale_after: Duration,
) -> Vec<StudioInstanceRecord> {
    read_all(dir)
        .into_iter()
        .filter(|record| record.is_fresh(now, stale_after))
        .collect()
}

/// Best catalog available to advertise, preferring a live Studio.
///
/// Falling back to the newest *stale* record is what lets an MCP client that connects before Studio
/// opens still see the Studio tools: without it, `tools/list` at connect time would return only the
/// session-management tools and many clients would never look again.
pub fn best_catalog(dir: &Path, now: chrono::DateTime<chrono::Utc>, stale_after: Duration) -> Option<CatalogSnapshot> {
    let all = read_all(dir);
    all.iter()
        .find(|record| record.is_fresh(now, stale_after) && record.catalog.is_some())
        .or_else(|| all.iter().find(|record| record.catalog.is_some()))
        .and_then(|record| record.catalog.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "overdare-studio-registry-{}-{}-{}",
            label,
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_record(dir: &Path, id: &str, heartbeat: &str, with_catalog: bool) {
        let mut record = json!({
            "id": id,
            "displayName": format!("project-{id}"),
            "cwd": format!("/projects/{id}"),
            "studioHost": "localhost",
            "studioPort": 13377,
            "sidecarUrl": format!("http://127.0.0.1:900{}", id.len()),
            "sidecarToken": format!("token-{id}"),
            "pid": 4242,
            "startedAt": heartbeat,
            "heartbeatAt": heartbeat,
        });
        if with_catalog {
            record["catalog"] = json!({
                "tools": [{ "name": format!("tool_{id}"), "description": "d", "inputSchema": { "type": "object" } }],
                "prompts": [{ "name": "agent-x", "description": "p" }],
                "instructions": format!("instructions-{id}"),
            });
        }
        fs::write(
            dir.join(format!("{id}.json")),
            serde_json::to_string_pretty(&record).expect("serialize"),
        )
        .expect("write record");
    }

    #[test]
    fn read_all_parses_camel_case_records_newest_first() {
        let dir = temp_dir("read-all");
        write_record(&dir, "a", "2026-07-10T00:00:00Z", true);
        write_record(&dir, "bb", "2026-07-10T00:00:10Z", false);

        let records = read_all(&dir);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].id, "bb", "newest heartbeat sorts first");
        assert_eq!(records[1].id, "a");
        assert_eq!(records[1].display_name, "project-a");
        assert_eq!(records[1].studio_port, 13377);
        assert_eq!(records[1].sidecar_token, "token-a");
        let catalog = records[1].catalog.as_ref().expect("catalog");
        assert_eq!(catalog.tools[0].name, "tool_a");
        assert_eq!(catalog.prompts[0].name, "agent-x");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_all_tolerates_malformed_and_incomplete_files() {
        let dir = temp_dir("malformed");
        write_record(&dir, "good", "2026-07-10T00:00:00Z", false);
        fs::write(dir.join("torn.json"), "{\"id\": \"torn\", \"sidecarUr").expect("write torn");
        // Missing sidecarToken — unroutable, so it must not be offered as a target.
        fs::write(
            dir.join("partial.json"),
            r#"{"id":"partial","sidecarUrl":"http://127.0.0.1:1","heartbeatAt":"2026-07-10T00:00:00Z"}"#,
        )
        .expect("write partial");
        fs::write(dir.join("notes.txt"), "ignore me").expect("write stray");

        let records = read_all(&dir);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, "good");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_all_returns_empty_for_missing_dir() {
        assert!(read_all(Path::new("/definitely/not/here")).is_empty());
    }

    #[test]
    fn read_live_filters_by_heartbeat_age() {
        let dir = temp_dir("live");
        write_record(&dir, "fresh", "2026-07-10T00:00:55Z", false);
        write_record(&dir, "stale", "2026-07-10T00:00:00Z", false);
        let now = chrono::DateTime::parse_from_rfc3339("2026-07-10T00:01:00Z")
            .expect("parse now")
            .with_timezone(&chrono::Utc);

        let live = read_live(&dir, now, DEFAULT_STALE_AFTER);
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].id, "fresh");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn heartbeat_in_the_future_counts_as_fresh() {
        // Clock skew between the sidecar and the router must not hide a live Studio.
        let dir = temp_dir("skew");
        write_record(&dir, "skewed", "2026-07-10T00:05:00Z", false);
        let now = chrono::DateTime::parse_from_rfc3339("2026-07-10T00:00:00Z")
            .expect("parse now")
            .with_timezone(&chrono::Utc);

        assert_eq!(read_live(&dir, now, DEFAULT_STALE_AFTER).len(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unparseable_heartbeat_is_never_fresh() {
        let dir = temp_dir("bad-beat");
        write_record(&dir, "bad", "not-a-timestamp", false);
        let now = chrono::Utc::now();
        assert!(read_live(&dir, now, DEFAULT_STALE_AFTER).is_empty());
        assert_eq!(read_all(&dir).len(), 1, "still readable, just not trusted as live");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn best_catalog_prefers_live_then_falls_back_to_stale() {
        let dir = temp_dir("catalog");
        write_record(&dir, "stale", "2026-07-10T00:00:00Z", true);
        let now = chrono::DateTime::parse_from_rfc3339("2026-07-10T00:01:00Z")
            .expect("parse now")
            .with_timezone(&chrono::Utc);

        // No live Studio: the last-known catalog still describes the tool surface, so a client that
        // connected before Studio opened is not left with only the session tools.
        let fallback = best_catalog(&dir, now, DEFAULT_STALE_AFTER).expect("stale fallback");
        assert_eq!(fallback.tools[0].name, "tool_stale");

        write_record(&dir, "livewire", "2026-07-10T00:00:59Z", true);
        let live = best_catalog(&dir, now, DEFAULT_STALE_AFTER).expect("live catalog");
        assert_eq!(live.tools[0].name, "tool_livewire", "a live Studio outranks a stale snapshot");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn registry_dir_is_env_scoped_under_the_storage_namespace() {
        crate::testutil::with_temp_home("registry-dir", |home| {
            let prod = registry_dir(Env::Prod).expect("prod dir");
            assert_eq!(prod, home.join(".overdare/mcp/studios"));
            let dev = registry_dir(Env::Dev).expect("dev dir");
            assert_eq!(dev, home.join(".overdare-dev/mcp/studios"));
        });
    }
}
