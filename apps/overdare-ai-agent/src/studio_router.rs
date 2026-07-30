//! Active-Studio selection and router-to-sidecar proxying (P071 Tasks 3 and 6).
//!
//! The router owns *which* Studio a call goes to and nothing else. Execution stays in the sidecar's
//! TypeScript tool registry, reached over its authenticated loopback endpoint, so approval metadata,
//! snapshot/rollback hooks, render payloads, and future tool additions cannot drift from a
//! reimplementation here.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use crate::mcp_protocol::{ToolCallResult, ToolDescriptor};
use crate::studio_registry::{self, StudioInstanceRecord};

pub const LIST_OVERDARE_STUDIOS: &str = "list_overdare_studios";
pub const SET_ACTIVE_OVERDARE_STUDIO: &str = "set_active_overdare_studio";
pub const GET_ACTIVE_OVERDARE_STUDIO: &str = "get_active_overdare_studio";

/// Health probes must be fast: they gate `tools/list` and ambiguous-target resolution, both of which
/// sit in front of a user-visible model turn.
const PROBE_TIMEOUT: Duration = Duration::from_millis(400);
/// Studio tool calls can legitimately take a while (level edits, procedural runs). This only bounds
/// a wedged sidecar, so it is generous.
const CALL_TIMEOUT: Duration = Duration::from_secs(600);

/// Session-management tools the router adds on top of whatever the selected Studio exposes.
pub fn session_tools() -> Vec<ToolDescriptor> {
    vec![
        ToolDescriptor::no_args(
            LIST_OVERDARE_STUDIOS,
            "List the OVERDARE Studio instances currently open, with their id, project folder, and \
             which one is active. Call this when a Studio tool reports that the target is ambiguous.",
        ),
        ToolDescriptor::one_string(
            SET_ACTIVE_OVERDARE_STUDIO,
            "Select which open OVERDARE Studio instance subsequent Studio tool calls target. Pass \
             an id from list_overdare_studios. If you are unsure which one the user means, ask them \
             instead of guessing — the wrong choice edits the wrong project.",
            "id",
            "Studio instance id from list_overdare_studios.",
        ),
        ToolDescriptor::no_args(
            GET_ACTIVE_OVERDARE_STUDIO,
            "Report which OVERDARE Studio instance Studio tool calls currently target.",
        ),
    ]
}

pub fn is_session_tool(name: &str) -> bool {
    matches!(
        name,
        LIST_OVERDARE_STUDIOS | SET_ACTIVE_OVERDARE_STUDIO | GET_ACTIVE_OVERDARE_STUDIO
    )
}

pub struct RouterOptions {
    pub registry_dir: std::path::PathBuf,
    pub stale_after: Duration,
    /// Pre-selects a Studio so a wrapper script can pin one without a tool call.
    pub default_active_studio_id: Option<String>,
}

pub struct StudioRouter {
    options: RouterOptions,
    /// Active selection is in-memory, so it is scoped to this router process. In stdio mode that
    /// process *is* the MCP session, which is exactly the boundary we want: one client's choice can
    /// never move another client's target.
    active_id: Mutex<Option<String>>,
    http: reqwest::Client,
}

impl StudioRouter {
    pub fn new(options: RouterOptions) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .build()
            .map_err(|e| format!("cannot build HTTP client: {e}"))?;
        let active_id = Mutex::new(options.default_active_studio_id.clone());
        Ok(StudioRouter {
            options,
            active_id,
            http,
        })
    }

    /// The Studio currently selected, if any. Not validated against the registry — callers that need
    /// a routable target use [`Self::resolve`].
    pub fn active_id(&self) -> Option<String> {
        self.active_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn write_active(&self, id: Option<String>) {
        *self.active_id.lock().unwrap_or_else(|e| e.into_inner()) = id;
    }

    /// Records with a fresh heartbeat, newest first. No reachability probe — callers that need one
    /// use [`Self::reachable_studios`].
    pub fn live_studios(&self) -> Vec<StudioInstanceRecord> {
        studio_registry::read_live(
            &self.options.registry_dir,
            chrono::Utc::now(),
            self.options.stale_after,
        )
    }

    /// Live records that actually answer on their sidecar port.
    ///
    /// A sidecar killed hard leaves a record behind for up to the staleness window. Without this
    /// probe the router would see a phantom second Studio and refuse every Studio tool call as
    /// ambiguous — the exact failure this plan exists to prevent.
    pub async fn reachable_studios(&self) -> Vec<StudioInstanceRecord> {
        let candidates = self.live_studios();
        if candidates.len() <= 1 {
            // Nothing to disambiguate: skip the probe and let a real call surface a dead sidecar.
            return candidates;
        }
        let probes = candidates
            .into_iter()
            .map(|record| async {
                let ok = self.probe(&record).await;
                (record, ok)
            })
            .collect::<Vec<_>>();
        futures_join_all(probes)
            .await
            .into_iter()
            .filter_map(|(record, ok)| ok.then_some(record))
            .collect()
    }

    /// Whether this sidecar answers its health endpoint.
    pub async fn probe(&self, record: &StudioInstanceRecord) -> bool {
        self.http
            .get(format!("{}/health", record.sidecar_url.trim_end_matches('/')))
            .timeout(PROBE_TIMEOUT)
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false)
    }

    /// Resolve which Studio a Studio tool call targets.
    ///
    /// Policy (P071): exactly one live Studio auto-selects; zero asks the user to open Studio; more
    /// than one with no active selection refuses rather than guessing, because guessing edits the
    /// wrong project. The refusal text names the tools the model should call next — a bare error
    /// leaves it stuck.
    pub async fn resolve(&self) -> Result<StudioInstanceRecord, String> {
        if let Some(active) = self.active_id() {
            if let Some(record) = self.live_studios().into_iter().find(|r| r.id == active) {
                return Ok(record);
            }
            // The selection went away (Studio closed, or an id was pinned that never showed up).
            // Clear it so the next call re-resolves instead of failing forever.
            self.write_active(None);
        }

        let candidates = self.reachable_studios().await;
        match candidates.len() {
            0 => Err("No OVERDARE Studio is currently open. Ask the user to open a Studio project, \
                      then retry."
                .to_string()),
            1 => {
                let record = candidates.into_iter().next().expect("one candidate");
                self.write_active(Some(record.id.clone()));
                Ok(record)
            }
            _ => Err(ambiguous_error(&candidates)),
        }
    }

    /// Explicit selection. Validated against the live set so a stale or invented id fails loudly
    /// here instead of silently routing nowhere on the next tool call.
    pub async fn set_active(&self, id: &str) -> Result<StudioInstanceRecord, String> {
        let candidates = self.reachable_studios().await;
        let Some(record) = candidates.iter().find(|record| record.id == id).cloned() else {
            let known = if candidates.is_empty() {
                "No OVERDARE Studio is currently open.".to_string()
            } else {
                format!("Currently open:\n{}", describe_studios(&candidates, None))
            };
            return Err(format!("Unknown Studio instance id \"{id}\". {known}"));
        };
        self.write_active(Some(record.id.clone()));
        Ok(record)
    }

    /// Execute one Studio tool inside the selected Studio's sidecar.
    ///
    /// A transport failure clears the active selection: the sidecar it pointed at is gone, and
    /// leaving the selection in place would make every later call fail the same way.
    pub async fn call_tool(
        &self,
        record: &StudioInstanceRecord,
        tool: &str,
        args: &Value,
        router_call_id: &str,
    ) -> ToolCallResult {
        let url = format!(
            "{}/mcp-router/tools/call",
            record.sidecar_url.trim_end_matches('/')
        );
        let response = self
            .http
            .post(&url)
            .bearer_auth(&record.sidecar_token)
            .timeout(CALL_TIMEOUT)
            .json(&json!({ "tool": tool, "args": args, "routerCallId": router_call_id }))
            .send()
            .await;

        match response {
            Err(err) => {
                self.write_active(None);
                ToolCallResult::failure(format!(
                    "Lost contact with OVERDARE Studio \"{}\" ({err}). It may have been closed. \
                     Call {LIST_OVERDARE_STUDIOS} and {SET_ACTIVE_OVERDARE_STUDIO} to pick a Studio, \
                     then retry.",
                    record.label()
                ))
            }
            Ok(response) if !response.status().is_success() => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                ToolCallResult::failure(format!(
                    "OVERDARE Studio \"{}\" rejected the call to {tool} (HTTP {status}). {body}",
                    record.label()
                ))
            }
            Ok(response) => match response.json::<Value>().await {
                Ok(value) => ToolCallResult::from_value(&value),
                Err(err) => ToolCallResult::failure(format!(
                    "Unreadable response from OVERDARE Studio \"{}\" for {tool}: {err}",
                    record.label()
                )),
            },
        }
    }

    /// Fetch one prompt from the selected Studio's sidecar.
    pub async fn get_prompt(&self, record: &StudioInstanceRecord, name: &str) -> Result<Value, String> {
        let url = format!(
            "{}/mcp-router/prompts/get",
            record.sidecar_url.trim_end_matches('/')
        );
        let response = self
            .http
            .post(&url)
            .bearer_auth(&record.sidecar_token)
            .timeout(CALL_TIMEOUT)
            .json(&json!({ "name": name }))
            .send()
            .await
            .map_err(|e| format!("cannot reach OVERDARE Studio \"{}\": {e}", record.label()))?;
        if !response.status().is_success() {
            let status = response.status();
            return Err(format!("prompt \"{name}\" unavailable (HTTP {status})"));
        }
        response
            .json::<Value>()
            .await
            .map_err(|e| format!("unreadable prompt response: {e}"))
    }

    /// `list_overdare_studios`.
    pub async fn tool_list_studios(&self) -> ToolCallResult {
        let candidates = self.reachable_studios().await;
        if candidates.is_empty() {
            return ToolCallResult::text(
                "No OVERDARE Studio is currently open. Ask the user to open a Studio project.",
            );
        }
        ToolCallResult::text(format!(
            "Open OVERDARE Studio instances:\n{}",
            describe_studios(&candidates, self.active_id().as_deref())
        ))
    }

    /// `set_active_overdare_studio`.
    pub async fn tool_set_active(&self, args: &Value) -> ToolCallResult {
        let Some(id) = args.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) else {
            return ToolCallResult::failure(format!(
                "{SET_ACTIVE_OVERDARE_STUDIO} requires an \"id\". Call {LIST_OVERDARE_STUDIOS} first."
            ));
        };
        match self.set_active(id).await {
            Ok(record) => ToolCallResult::text(format!(
                "Active OVERDARE Studio is now \"{}\" (id {}, cwd {}). Studio tool calls target it.",
                record.label(),
                record.id,
                record.cwd
            )),
            Err(message) => ToolCallResult::failure(message),
        }
    }

    /// `get_active_overdare_studio`.
    pub async fn tool_get_active(&self) -> ToolCallResult {
        let active = self.active_id();
        let live = self.live_studios();
        match active.and_then(|id| live.into_iter().find(|record| record.id == id)) {
            Some(record) => ToolCallResult::text(format!(
                "Active OVERDARE Studio: \"{}\" (id {}, cwd {}, studio {}:{}).",
                record.label(),
                record.id,
                record.cwd,
                record.studio_host,
                record.studio_port
            )),
            None => ToolCallResult::text(format!(
                "No active OVERDARE Studio is selected. Call {LIST_OVERDARE_STUDIOS}, then \
                 {SET_ACTIVE_OVERDARE_STUDIO}."
            )),
        }
    }
}

fn ambiguous_error(candidates: &[StudioInstanceRecord]) -> String {
    format!(
        "{} OVERDARE Studio instances are open and none is selected, so this call would edit an \
         unknown project. Call {LIST_OVERDARE_STUDIOS}, confirm with the user which one they mean, \
         then call {SET_ACTIVE_OVERDARE_STUDIO}.\n{}",
        candidates.len(),
        describe_studios(candidates, None)
    )
}

fn describe_studios(records: &[StudioInstanceRecord], active_id: Option<&str>) -> String {
    records
        .iter()
        .map(|record| {
            let marker = if Some(record.id.as_str()) == active_id {
                " [active]"
            } else {
                ""
            };
            format!(
                "- id: {} | {} | cwd: {} | studio: {}:{}{marker}",
                record.id,
                record.label(),
                record.cwd,
                record.studio_host,
                record.studio_port
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Await a set of futures concurrently, preserving order.
///
/// Hand-rolled instead of `futures::future::join_all`: the `futures` crate is not a dependency and
/// adding one for a single helper works against the size budget that motivated hosting the router
/// here. `tokio::join!` needs a fixed arity, so a small poll-all loop it is.
async fn futures_join_all<F: std::future::Future>(futures: Vec<F>) -> Vec<F::Output> {
    let mut pinned: Vec<std::pin::Pin<Box<F>>> = futures.into_iter().map(Box::pin).collect();
    let mut outputs: Vec<Option<F::Output>> = (0..pinned.len()).map(|_| None).collect();
    let mut remaining = pinned.len();
    std::future::poll_fn(|cx| {
        for (index, future) in pinned.iter_mut().enumerate() {
            if outputs[index].is_some() {
                continue;
            }
            if let std::task::Poll::Ready(value) = future.as_mut().poll(cx) {
                outputs[index] = Some(value);
                remaining -= 1;
            }
        }
        if remaining == 0 {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    })
    .await;
    outputs.into_iter().map(|value| value.expect("all resolved")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "overdare-studio-router-{}-{}-{}",
            label,
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// Writes a record whose heartbeat is now, so it reads as live.
    fn write_live_record(dir: &Path, id: &str, sidecar_url: &str) {
        let now = chrono::Utc::now().to_rfc3339();
        let record = json!({
            "id": id,
            "displayName": format!("project-{id}"),
            "cwd": format!("/projects/{id}"),
            "studioHost": "localhost",
            "studioPort": 13377,
            "sidecarUrl": sidecar_url,
            "sidecarToken": format!("token-{id}"),
            "pid": std::process::id(),
            "startedAt": now,
            "heartbeatAt": now,
        });
        fs::write(dir.join(format!("{id}.json")), record.to_string()).expect("write record");
    }

    fn router(dir: PathBuf) -> StudioRouter {
        StudioRouter::new(RouterOptions {
            registry_dir: dir,
            stale_after: studio_registry::DEFAULT_STALE_AFTER,
            default_active_studio_id: None,
        })
        .expect("build router")
    }

    #[test]
    fn session_tools_are_named_and_recognized() {
        let tools = session_tools();
        let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                LIST_OVERDARE_STUDIOS,
                SET_ACTIVE_OVERDARE_STUDIO,
                GET_ACTIVE_OVERDARE_STUDIO
            ]
        );
        for name in names {
            assert!(is_session_tool(name));
        }
        assert!(!is_session_tool("studiorpc_instance_read"));
    }

    #[test]
    fn set_active_tool_requires_an_id() {
        let dir = temp_dir("set-active-no-id");
        let router = router(dir.clone());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let result = runtime.block_on(router.tool_set_active(&json!({})));
        assert!(result.is_error);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_reports_no_studio_when_registry_is_empty() {
        let dir = temp_dir("resolve-empty");
        let router = router(dir.clone());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let err = runtime.block_on(router.resolve()).expect_err("must fail");
        assert!(err.contains("No OVERDARE Studio"), "got: {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_auto_selects_the_only_studio_and_remembers_it() {
        let dir = temp_dir("resolve-single");
        write_live_record(&dir, "solo", "http://127.0.0.1:9");
        let router = router(dir.clone());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");

        let record = runtime.block_on(router.resolve()).expect("auto-select");
        assert_eq!(record.id, "solo");
        // Sticky: a second Studio opening later must not silently move the target mid-session.
        assert_eq!(router.active_id().as_deref(), Some("solo"));
        write_live_record(&dir, "second", "http://127.0.0.1:10");
        assert_eq!(
            runtime.block_on(router.resolve()).expect("still solo").id,
            "solo"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A stand-in sidecar: answers `/health` and records which tool calls it received, so a routing
    /// test can assert that only the selected Studio was contacted.
    struct FakeSidecar {
        url: String,
        calls: std::sync::Arc<Mutex<Vec<String>>>,
        shutdown: tokio::sync::oneshot::Sender<()>,
        joined: tokio::task::JoinHandle<()>,
    }

    async fn spawn_fake_sidecar(token: &str) -> FakeSidecar {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake sidecar");
        let port = listener.local_addr().expect("addr").port();
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        let recorded = std::sync::Arc::clone(&calls);
        let expected_token = token.to_string();
        let (shutdown, mut stop) = tokio::sync::oneshot::channel();

        let joined = tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    _ = &mut stop => break,
                    accepted = listener.accept() => accepted,
                };
                let Ok((mut socket, _)) = accepted else { break };
                let recorded = std::sync::Arc::clone(&recorded);
                let expected_token = expected_token.clone();
                tokio::spawn(async move {
                    let mut buffer = vec![0u8; 8192];
                    let read = socket.read(&mut buffer).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                    let body = if request.starts_with("GET /health") {
                        Some(json!({ "ok": true }))
                    } else if request.contains("/mcp-router/tools/call") {
                        if !request.contains(&format!("Bearer {expected_token}")) {
                            None
                        } else {
                            let tool = request
                                .rsplit_once("\r\n\r\n")
                                .and_then(|(_, body)| serde_json::from_str::<Value>(body).ok())
                                .and_then(|value| {
                                    value.get("tool").and_then(Value::as_str).map(str::to_string)
                                })
                                .unwrap_or_default();
                            recorded.lock().unwrap_or_else(|e| e.into_inner()).push(tool.clone());
                            Some(json!({ "content": [{ "type": "text", "text": format!("ran {tool}") }] }))
                        }
                    } else {
                        None
                    };
                    let response = match body {
                        Some(body) => {
                            let payload = body.to_string();
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                                payload.len()
                            )
                        }
                        None => "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_string(),
                    };
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.flush().await;
                });
            }
        });

        FakeSidecar {
            url: format!("http://127.0.0.1:{port}"),
            calls,
            shutdown,
            joined,
        }
    }

    impl FakeSidecar {
        fn received(&self) -> Vec<String> {
            self.calls.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }

        async fn stop(self) {
            let _ = self.shutdown.send(());
            let _ = self.joined.await;
        }
    }

    #[test]
    fn resolve_refuses_when_several_reachable_studios_are_open() {
        let dir = temp_dir("resolve-ambiguous");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");

        runtime.block_on(async {
            let alpha = spawn_fake_sidecar("token-alpha").await;
            let beta = spawn_fake_sidecar("token-beta").await;
            write_live_record(&dir, "alpha", &alpha.url);
            write_live_record(&dir, "beta", &beta.url);
            let router = router(dir.clone());

            let error = router.resolve().await.expect_err("ambiguous must refuse");
            assert!(error.contains(LIST_OVERDARE_STUDIOS), "got: {error}");
            assert!(error.contains(SET_ACTIVE_OVERDARE_STUDIO), "got: {error}");
            assert!(error.contains("alpha") && error.contains("beta"), "got: {error}");
            assert_eq!(router.active_id(), None, "an ambiguous resolve must not pick one");

            alpha.stop().await;
            beta.stop().await;
        });

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreachable_record_does_not_make_the_target_ambiguous() {
        // A hard-killed sidecar leaves its record behind for the staleness window. The survivor must
        // still auto-select rather than every Studio tool refusing until the record expires.
        let dir = temp_dir("resolve-phantom");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");

        runtime.block_on(async {
            let alive = spawn_fake_sidecar("token-alive").await;
            write_live_record(&dir, "alive", &alive.url);
            // Discard port 1: nothing listens, so the probe fails.
            write_live_record(&dir, "phantom", "http://127.0.0.1:1");
            let router = router(dir.clone());

            let record = router.resolve().await.expect("survivor auto-selects");
            assert_eq!(record.id, "alive");

            alive.stop().await;
        });

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tool_call_only_reaches_the_selected_studio() {
        let dir = temp_dir("routing");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");

        runtime.block_on(async {
            let alpha = spawn_fake_sidecar("token-alpha").await;
            let beta = spawn_fake_sidecar("token-beta").await;
            write_live_record(&dir, "alpha", &alpha.url);
            write_live_record(&dir, "beta", &beta.url);
            let router = router(dir.clone());

            let selected = router.set_active("beta").await.expect("select beta");
            assert_eq!(selected.id, "beta");

            let resolved = router.resolve().await.expect("resolve to the selection");
            let result = router
                .call_tool(&resolved, "studiorpc_instance_read", &json!({ "guid": "G" }), "call-1")
                .await;
            assert!(!result.is_error, "{result:?}");
            assert_eq!(result.content[0]["text"], json!("ran studiorpc_instance_read"));

            assert_eq!(beta.received(), vec!["studiorpc_instance_read".to_string()]);
            assert!(alpha.received().is_empty(), "the unselected Studio must never be called");

            alpha.stop().await;
            beta.stop().await;
        });

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_dead_sidecar_clears_the_active_selection() {
        let dir = temp_dir("routing-dead");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");

        runtime.block_on(async {
            let alpha = spawn_fake_sidecar("token-alpha").await;
            write_live_record(&dir, "alpha", &alpha.url);
            let router = router(dir.clone());
            let record = router.resolve().await.expect("auto-select");
            assert_eq!(router.active_id().as_deref(), Some("alpha"));

            // The sidecar goes away while its record is still fresh.
            alpha.stop().await;
            let result = router
                .call_tool(&record, "studiorpc_instance_read", &json!({}), "call-1")
                .await;
            assert!(result.is_error);
            let text = result.content[0]["text"].as_str().unwrap_or_default();
            assert!(text.contains(LIST_OVERDARE_STUDIOS), "got: {text}");
            assert_eq!(
                router.active_id(),
                None,
                "a lost sidecar must release the selection so the next call re-resolves"
            );
        });

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_active_rejects_an_unknown_id() {
        let dir = temp_dir("set-active-unknown");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");

        runtime.block_on(async {
            let alpha = spawn_fake_sidecar("token-alpha").await;
            write_live_record(&dir, "alpha", &alpha.url);
            let router = router(dir.clone());

            let error = router.set_active("nope").await.expect_err("unknown id must fail");
            assert!(error.contains("nope"), "got: {error}");
            assert!(error.contains("alpha"), "the error should list what is open: {error}");
            assert_eq!(router.active_id(), None);

            alpha.stop().await;
        });

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_wrong_token_is_reported_as_a_tool_error() {
        let dir = temp_dir("bad-token");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");

        runtime.block_on(async {
            let sidecar = spawn_fake_sidecar("the-real-token").await;
            write_live_record(&dir, "alpha", &sidecar.url);
            let router = router(dir.clone());
            let mut record = router.resolve().await.expect("auto-select");
            record.sidecar_token = "forged".to_string();

            let result = router.call_tool(&record, "studiorpc_instance_read", &json!({}), "c").await;
            assert!(result.is_error);
            let text = result.content[0]["text"].as_str().unwrap_or_default();
            assert!(text.contains("401"), "got: {text}");

            sidecar.stop().await;
        });

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_clears_a_pinned_id_that_is_not_live() {
        let dir = temp_dir("resolve-pinned-gone");
        let router = StudioRouter::new(RouterOptions {
            registry_dir: dir.clone(),
            stale_after: studio_registry::DEFAULT_STALE_AFTER,
            default_active_studio_id: Some("ghost".to_string()),
        })
        .expect("build router");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");

        assert!(runtime.block_on(router.resolve()).is_err());
        assert_eq!(
            router.active_id(),
            None,
            "a selection that is not live must be dropped, not retried forever"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn describe_studios_marks_the_active_one() {
        let dir = temp_dir("describe");
        write_live_record(&dir, "alpha", "http://127.0.0.1:9");
        write_live_record(&dir, "beta", "http://127.0.0.1:10");
        let router = router(dir.clone());
        let text = describe_studios(&router.live_studios(), Some("beta"));
        assert!(text.contains("id: beta"));
        assert!(text.contains("[active]"));
        assert_eq!(text.matches("[active]").count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    /// One concrete future type, so a `Vec` of them type-checks (no two async blocks share a type).
    async fn sleep_then(millis: u64, value: i32) -> i32 {
        tokio::time::sleep(Duration::from_millis(millis)).await;
        value
    }

    #[test]
    fn futures_join_all_preserves_order() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        // Ordering must hold even when the futures complete out of order, which is the whole point
        // of the index-keyed output slots.
        let values = runtime.block_on(futures_join_all(vec![
            sleep_then(30, 1),
            sleep_then(0, 2),
            sleep_then(15, 3),
        ]));
        assert_eq!(values, vec![1, 2, 3]);
        let empty: Vec<i32> = runtime.block_on(futures_join_all(Vec::<std::future::Ready<i32>>::new()));
        assert!(empty.is_empty());
    }
}
