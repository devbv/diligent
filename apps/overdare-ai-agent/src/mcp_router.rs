//! The stable OVERDARE MCP entrypoint (P071 Task 5).
//!
//! `overdare-ai-agent start-mcp-router` is the one command an MCP client configures. It lives in
//! this executable — not in the Bun sidecar — because the sidecar's path moves with every runtime
//! update, which is the breakage this plan exists to fix.
//!
//! What it owns: the MCP dialogue, the session-management tools, and which Studio a call targets.
//! What it does not own: tool behavior. Studio tools and prompts are re-advertised from the selected
//! sidecar's catalog and executed inside that sidecar (see `studio_router`).

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::mcp_protocol::{
    self, PromptDescriptor, Request, ToolCallResult, ToolDescriptor, INTERNAL_ERROR, INVALID_PARAMS,
    METHOD_NOT_FOUND,
};
use crate::studio_registry::{self, CatalogSnapshot};
use crate::studio_router::{
    self, RouterOptions, StudioRouter, GET_ACTIVE_OVERDARE_STUDIO, LIST_OVERDARE_STUDIOS,
    SET_ACTIVE_OVERDARE_STUDIO,
};

const SERVER_NAME: &str = "overdare-ai-agent";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// How often the registry is re-read to decide whether to tell the client the tool list changed.
const WATCH_INTERVAL: Duration = Duration::from_secs(2);

/// Router-level guidance, prepended to the selected Studio's own instructions.
///
/// The multi-Studio rule has to be stated here rather than left to the tool descriptions: a client
/// reads `instructions` once, and a model that does not know selection exists will read the
/// ambiguous-target refusal as a hard failure instead of a prompt to choose.
const ROUTER_INSTRUCTIONS: &str = "This server routes OVERDARE Studio tool calls to one open Studio \
instance. If several Studios are open, call list_overdare_studios and set_active_overdare_studio to \
choose the one the user means before using any other Studio tool — ask the user when it is not \
obvious, because the wrong choice edits the wrong project. If no Studio is open, ask the user to \
open one.";

pub struct McpRouterOptions {
    pub registry_dir: std::path::PathBuf,
    pub default_active_studio_id: Option<String>,
}

/// Everything the request handlers need. `catalog` is re-read per request rather than cached at
/// startup so a Studio that opens mid-session is picked up without a reconnect.
struct RouterState {
    router: StudioRouter,
    registry_dir: std::path::PathBuf,
}

impl RouterState {
    fn catalog(&self) -> CatalogSnapshot {
        studio_registry::best_catalog(
            &self.registry_dir,
            chrono::Utc::now(),
            studio_registry::DEFAULT_STALE_AFTER,
        )
        .unwrap_or_default()
    }

    /// Session-management tools first, then whatever the Studio exposes.
    ///
    /// Session tools always come first and are never shadowed: a Studio catalog that happened to
    /// contain the same name would otherwise make selection unreachable.
    fn tools(&self) -> Vec<ToolDescriptor> {
        let mut tools = studio_router::session_tools();
        for tool in self.catalog().tools {
            if studio_router::is_session_tool(&tool.name) {
                continue;
            }
            tools.push(tool);
        }
        tools
    }

    fn prompts(&self) -> Vec<PromptDescriptor> {
        self.catalog().prompts
    }

    fn instructions(&self) -> String {
        match self.catalog().instructions {
            Some(studio) if !studio.trim().is_empty() => {
                format!("{ROUTER_INSTRUCTIONS}\n\n{studio}")
            }
            _ => ROUTER_INSTRUCTIONS.to_string(),
        }
    }

    /// A fingerprint of what the client currently believes. When it changes, the client is told to
    /// re-list.
    fn catalog_fingerprint(&self) -> String {
        let live = self
            .router
            .live_studios()
            .into_iter()
            .map(|record| record.id)
            .collect::<Vec<_>>()
            .join(",");
        let catalog = self.catalog();
        let names = catalog
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>()
            .join(",");
        format!("{live}|{names}|{}", catalog.prompts.len())
    }
}

/// Dispatch one request into a response. Callers filter out notifications first — those carry no id
/// and must never be answered.
async fn handle(state: &RouterState, request: &Request, id: &Value) -> Value {
    let result: Result<Value, (i64, String)> = match request.method.as_str() {
        "initialize" => Ok(mcp_protocol::initialize_result(
            SERVER_NAME,
            SERVER_VERSION,
            &state.instructions(),
        )),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": state.tools() })),
        "prompts/list" => Ok(json!({ "prompts": state.prompts() })),
        "tools/call" => Ok(call_tool(state, request).await.to_value()),
        "prompts/get" => match request.param_str("name") {
            None => Err((INVALID_PARAMS, "prompts/get requires a name".to_string())),
            Some(name) => match state.router.resolve().await {
                // A prompt lives in a Studio's bootstrap dir, so it needs a target just like a tool
                // does. Reported as a JSON-RPC error because prompts/get has no isError channel.
                Err(message) => Err((INTERNAL_ERROR, message)),
                Ok(record) => state
                    .router
                    .get_prompt(&record, name)
                    .await
                    .map_err(|message| (INTERNAL_ERROR, message)),
            },
        },
        // Optional capabilities we never advertised. Answering "method not found" is the correct
        // reply and keeps clients that probe for them from treating it as a transport fault.
        other => Err((METHOD_NOT_FOUND, format!("Unknown method: {other}"))),
    };

    match result {
        Ok(value) => mcp_protocol::success(id, value),
        Err((code, message)) => mcp_protocol::error(id, code, message),
    }
}

/// Execute a `tools/call`. Session tools are answered locally; everything else is resolved to a
/// Studio and proxied.
async fn call_tool(state: &RouterState, request: &Request) -> ToolCallResult {
    let Some(name) = request.param_str("name") else {
        return ToolCallResult::failure("tools/call requires a name");
    };
    let args = request
        .params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match name {
        LIST_OVERDARE_STUDIOS => return state.router.tool_list_studios().await,
        SET_ACTIVE_OVERDARE_STUDIO => return state.router.tool_set_active(&args).await,
        GET_ACTIVE_OVERDARE_STUDIO => return state.router.tool_get_active().await,
        _ => {}
    }

    // Ambiguity and "no Studio open" surface as tool errors, not JSON-RPC errors: the model has to
    // read them and act (list, then select), which it cannot do with a protocol-level failure.
    let record = match state.router.resolve().await {
        Ok(record) => record,
        Err(message) => return ToolCallResult::failure(message),
    };
    let call_id = request
        .id
        .as_ref()
        .map(|id| id.to_string())
        .unwrap_or_else(|| "0".to_string());
    state.router.call_tool(&record, name, &args, &call_id).await
}

/// Run the stdio MCP router until stdin closes.
///
/// stdout carries the JSON-RPC stream and nothing else — every diagnostic goes to stderr. A stray
/// write to stdout corrupts the framing and makes the client drop the session mid-turn.
pub async fn run_mcp_router(options: McpRouterOptions) -> Result<(), String> {
    let router = StudioRouter::new(RouterOptions {
        registry_dir: options.registry_dir.clone(),
        stale_after: studio_registry::DEFAULT_STALE_AFTER,
        default_active_studio_id: options.default_active_studio_id,
    })?;
    let state = Arc::new(RouterState {
        router,
        registry_dir: options.registry_dir,
    });

    eprintln!(
        "[mcp-router] ready on stdio; watching {}",
        state.registry_dir.display()
    );

    // One writer task owns stdout so the watcher's notifications can never interleave with a
    // response mid-line.
    let (outbox, mut inbox) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = inbox.recv().await {
            let mut line = message.to_string();
            line.push('\n');
            if stdout.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = stdout.flush().await;
        }
    });

    let watcher = tokio::spawn(watch_for_changes(Arc::clone(&state), outbox.clone()));

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            // Client closed stdin: it is done with us.
            Ok(None) => break,
            Err(err) => {
                eprintln!("[mcp-router] stdin read failed: {err}");
                break;
            }
        };
        match mcp_protocol::parse_request(&line) {
            Ok(None) => continue,
            Ok(Some(request)) => {
                // A notification (no id) gets no reply — answering one is a protocol violation.
                if request.is_notification() {
                    continue;
                }
                let id = request.id.clone().expect("a non-notification carries an id");
                if outbox.send(handle(&state, &request, &id).await).is_err() {
                    break;
                }
            }
            Err((code, message)) => {
                eprintln!("[mcp-router] {message}");
                // No id is recoverable from an unparseable line, so JSON-RPC's null-id form is the
                // only correct reply.
                let _ = outbox.send(mcp_protocol::error(&Value::Null, code, message));
            }
        }
    }

    watcher.abort();
    drop(outbox);
    let _ = writer.await;
    Ok(())
}

/// Tell the client to re-list whenever the set of live Studios (or their catalog) changes.
///
/// Without this, a client that connected before Studio opened would keep offering only the
/// session-management tools for the rest of the session.
async fn watch_for_changes(state: Arc<RouterState>, outbox: tokio::sync::mpsc::UnboundedSender<Value>) {
    let mut fingerprint = state.catalog_fingerprint();
    loop {
        tokio::time::sleep(WATCH_INTERVAL).await;
        let next = state.catalog_fingerprint();
        if next == fingerprint {
            continue;
        }
        fingerprint = next;
        if outbox
            .send(mcp_protocol::notification(
                "notifications/tools/list_changed",
                json!({}),
            ))
            .is_err()
        {
            return;
        }
        if outbox
            .send(mcp_protocol::notification(
                "notifications/prompts/list_changed",
                json!({}),
            ))
            .is_err()
        {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "overdare-mcp-router-{}-{}-{}",
            label,
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_record(dir: &Path, id: &str, tools: &[&str]) {
        let now = chrono::Utc::now().to_rfc3339();
        let record = json!({
            "id": id,
            "displayName": format!("project-{id}"),
            "cwd": format!("/projects/{id}"),
            "studioHost": "localhost",
            "studioPort": 13377,
            "sidecarUrl": "http://127.0.0.1:1",
            "sidecarToken": format!("token-{id}"),
            "pid": std::process::id(),
            "startedAt": now,
            "heartbeatAt": now,
            "catalog": {
                "tools": tools.iter().map(|name| json!({
                    "name": name,
                    "description": "d",
                    "inputSchema": { "type": "object" },
                })).collect::<Vec<_>>(),
                "prompts": [{ "name": "agent-builder", "description": "p" }],
                "instructions": "STUDIO INSTRUCTIONS",
            },
        });
        fs::write(dir.join(format!("{id}.json")), record.to_string()).expect("write record");
    }

    fn state(dir: PathBuf) -> RouterState {
        RouterState {
            router: StudioRouter::new(RouterOptions {
                registry_dir: dir.clone(),
                stale_after: studio_registry::DEFAULT_STALE_AFTER,
                default_active_studio_id: None,
            })
            .expect("router"),
            registry_dir: dir,
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
    }

    fn request(id: i64, method: &str, params: Value) -> Request {
        Request {
            id: Some(json!(id)),
            method: method.to_string(),
            params,
        }
    }

    /// Dispatch one request the way the read loop does, and return the response.
    fn respond(state: &RouterState, id: i64, method: &str, params: Value) -> Value {
        let request = request(id, method, params);
        let request_id = request.id.clone().expect("test request carries an id");
        runtime().block_on(handle(state, &request, &request_id))
    }

    #[test]
    fn tools_list_offers_session_tools_even_with_no_studio_open() {
        let dir = temp_dir("tools-empty");
        let state = state(dir.clone());
        let names: Vec<String> = state.tools().into_iter().map(|tool| tool.name).collect();
        assert_eq!(
            names,
            vec![
                LIST_OVERDARE_STUDIOS.to_string(),
                SET_ACTIVE_OVERDARE_STUDIO.to_string(),
                GET_ACTIVE_OVERDARE_STUDIO.to_string()
            ]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tools_list_appends_the_studio_catalog() {
        let dir = temp_dir("tools-catalog");
        write_record(&dir, "alpha", &["studiorpc_instance_read", "ensure_system_prompt"]);
        let state = state(dir.clone());
        let names: Vec<String> = state.tools().into_iter().map(|tool| tool.name).collect();
        assert_eq!(names.len(), 5);
        assert_eq!(names[0], LIST_OVERDARE_STUDIOS, "session tools come first");
        assert!(names.contains(&"studiorpc_instance_read".to_string()));
        // The bootstrap tools are proxied from the sidecar, not reimplemented here.
        assert!(names.contains(&"ensure_system_prompt".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_studio_catalog_cannot_shadow_a_session_tool() {
        let dir = temp_dir("tools-shadow");
        write_record(&dir, "alpha", &[LIST_OVERDARE_STUDIOS, "studiorpc_instance_read"]);
        let state = state(dir.clone());
        let names: Vec<String> = state.tools().into_iter().map(|tool| tool.name).collect();
        assert_eq!(
            names.iter().filter(|name| *name == LIST_OVERDARE_STUDIOS).count(),
            1,
            "selection must stay reachable"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn instructions_prepend_the_router_rules_to_the_studio_text() {
        let dir = temp_dir("instructions");
        let state = state(dir.clone());
        assert_eq!(state.instructions(), ROUTER_INSTRUCTIONS, "no Studio: router text alone");

        write_record(&dir, "alpha", &["studiorpc_instance_read"]);
        let with_studio = state.instructions();
        assert!(with_studio.starts_with(ROUTER_INSTRUCTIONS));
        assert!(with_studio.contains("STUDIO INSTRUCTIONS"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn initialize_advertises_the_router_and_list_changed() {
        let dir = temp_dir("initialize");
        let state = state(dir.clone());
        let response = respond(&state, 1, "initialize", json!({}));
        assert_eq!(response["id"], json!(1));
        assert_eq!(response["result"]["serverInfo"]["name"], json!(SERVER_NAME));
        assert_eq!(response["result"]["capabilities"]["tools"]["listChanged"], json!(true));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn notifications_are_never_answered() {
        let dir = temp_dir("notify");
        let state = state(dir.clone());
        // The read loop filters on this, so a notification never reaches handle().
        let notification = Request {
            id: None,
            method: "notifications/initialized".to_string(),
            params: Value::Null,
        };
        assert!(notification.is_notification());
        assert!(!request(1, "initialize", Value::Null).is_notification());
        let _ = &state;
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unknown_method_gets_method_not_found() {
        let dir = temp_dir("unknown-method");
        let state = state(dir.clone());
        let response = respond(&state, 2, "resources/list", json!({}));
        assert_eq!(response["error"]["code"], json!(METHOD_NOT_FOUND));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ping_answers_empty() {
        let dir = temp_dir("ping");
        let state = state(dir.clone());
        let response = respond(&state, 3, "ping", Value::Null);
        assert_eq!(response["result"], json!({}));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_studio_tool_with_no_studio_open_is_a_tool_error_not_a_protocol_error() {
        let dir = temp_dir("call-no-studio");
        let state = state(dir.clone());
        let response = respond(
            &state,
            4,
            "tools/call",
            json!({ "name": "studiorpc_instance_read", "arguments": {} }),
        );
        assert!(response.get("error").is_none(), "must stay a tool result: {response}");
        assert_eq!(response["result"]["isError"], json!(true));
        let text = response["result"]["content"][0]["text"].as_str().unwrap_or_default();
        assert!(text.contains("No OVERDARE Studio"), "got: {text}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_tools_work_with_no_studio_open() {
        let dir = temp_dir("session-empty");
        let state = state(dir.clone());
        let response = respond(&state, 5, "tools/call", json!({ "name": LIST_OVERDARE_STUDIOS }));
        assert_ne!(response["result"]["isError"], json!(true));
        let text = response["result"]["content"][0]["text"].as_str().unwrap_or_default();
        assert!(text.contains("No OVERDARE Studio"), "got: {text}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prompts_list_comes_from_the_studio_catalog() {
        let dir = temp_dir("prompts");
        let state = state(dir.clone());
        assert!(state.prompts().is_empty());

        write_record(&dir, "alpha", &["studiorpc_instance_read"]);
        let response = respond(&state, 6, "prompts/list", json!({}));
        assert_eq!(response["result"]["prompts"][0]["name"], json!("agent-builder"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prompts_get_requires_a_name() {
        let dir = temp_dir("prompts-no-name");
        let state = state(dir.clone());
        let response = respond(&state, 7, "prompts/get", json!({}));
        assert_eq!(response["error"]["code"], json!(INVALID_PARAMS));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_fingerprint_changes_when_a_studio_appears() {
        let dir = temp_dir("fingerprint");
        let state = state(dir.clone());
        let before = state.catalog_fingerprint();
        write_record(&dir, "alpha", &["studiorpc_instance_read"]);
        assert_ne!(
            before,
            state.catalog_fingerprint(),
            "a Studio opening must trigger a list_changed notification"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
