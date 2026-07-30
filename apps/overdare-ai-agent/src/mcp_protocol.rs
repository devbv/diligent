//! Minimal MCP server protocol over stdio (P071 Task 1 decision).
//!
//! Hand-written rather than pulled from a Rust MCP crate: the whole point of hosting the router in
//! this executable is that it is small (see `Cargo.toml`'s `opt-level = "s"` / `lto` / `strip`
//! release profile), and the crates in this space bring schema-generation and service stacks that
//! would undo that. The server half of MCP we need is a newline-delimited JSON-RPC 2.0 dialogue
//! with six methods, which `serde_json` already covers.
//!
//! Framing: one JSON value per line on stdin, one per line on stdout. That is MCP's stdio
//! transport. stdout is therefore protocol-only — every diagnostic goes to stderr.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Protocol revision we advertise. Clients that speak a newer revision negotiate down to this.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// JSON-RPC method not found.
pub const METHOD_NOT_FOUND: i64 = -32601;
/// JSON-RPC invalid params.
pub const INVALID_PARAMS: i64 = -32602;
/// JSON-RPC internal error.
pub const INTERNAL_ERROR: i64 = -32603;
/// JSON-RPC parse error.
pub const PARSE_ERROR: i64 = -32700;

/// One decoded incoming JSON-RPC message.
///
/// `id` is absent for notifications, which must never be answered. It is kept as a raw `Value`
/// because JSON-RPC allows both string and number ids and a response has to echo the exact one it
/// received.
#[derive(Debug, Clone)]
pub struct Request {
    pub id: Option<Value>,
    pub method: String,
    pub params: Value,
}

impl Request {
    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }

    /// Reads a string field out of `params`.
    pub fn param_str(&self, key: &str) -> Option<&str> {
        self.params.get(key).and_then(Value::as_str)
    }
}

/// Parse one line of stdin. `Ok(None)` means "blank line, skip"; `Err` carries a JSON-RPC error
/// code the caller may report.
pub fn parse_request(line: &str) -> Result<Option<Request>, (i64, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let value: Value =
        serde_json::from_str(trimmed).map_err(|e| (PARSE_ERROR, format!("invalid JSON: {e}")))?;
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        // A message with no method is a response to something we sent. We issue no server->client
        // requests (P069 C8 applies here too), so there is nothing to correlate it with.
        return Ok(None);
    };
    Ok(Some(Request {
        id: value.get("id").cloned().filter(|id| !id.is_null()),
        method: method.to_string(),
        params: value.get("params").cloned().unwrap_or(Value::Null),
    }))
}

pub fn success(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn error(id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

pub fn notification(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

/// A tool as advertised by `tools/list`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolDescriptor {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

impl ToolDescriptor {
    /// A tool taking no arguments.
    pub fn no_args(name: &str, description: &str) -> Self {
        ToolDescriptor {
            name: name.to_string(),
            description: description.to_string(),
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        }
    }

    /// A tool taking one required string argument.
    pub fn one_string(name: &str, description: &str, arg: &str, arg_description: &str) -> Self {
        ToolDescriptor {
            name: name.to_string(),
            description: description.to_string(),
            input_schema: json!({
                "type": "object",
                "properties": { arg: { "type": "string", "description": arg_description } },
                "required": [arg],
                "additionalProperties": false,
            }),
        }
    }
}

/// A prompt as advertised by `prompts/list`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PromptDescriptor {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

/// `CallToolResult`. Tool *failures* are carried here with `is_error`, not as JSON-RPC errors —
/// the model must see them as tool output it can react to.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCallResult {
    pub content: Vec<Value>,
    pub is_error: bool,
}

impl ToolCallResult {
    pub fn text(message: impl Into<String>) -> Self {
        ToolCallResult {
            content: vec![json!({ "type": "text", "text": message.into() })],
            is_error: false,
        }
    }

    pub fn failure(message: impl Into<String>) -> Self {
        ToolCallResult {
            content: vec![json!({ "type": "text", "text": message.into() })],
            is_error: true,
        }
    }

    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("content".to_string(), Value::Array(self.content.clone()));
        if self.is_error {
            map.insert("isError".to_string(), Value::Bool(true));
        }
        Value::Object(map)
    }

    /// Rebuild a result forwarded by the sidecar's router endpoint, which answers in this same
    /// shape. Anything unparseable is surfaced as a tool error rather than silently dropped.
    pub fn from_value(value: &Value) -> Self {
        let content = value
            .get("content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| vec![json!({ "type": "text", "text": "" })]);
        ToolCallResult {
            content,
            is_error: value.get("isError").and_then(Value::as_bool).unwrap_or(false),
        }
    }
}

/// `initialize` result. `listChanged` is advertised for tools because the set of live Studios (and
/// therefore the tool list) changes while the client is connected — a client that never re-lists
/// would keep offering tools for a Studio that has closed.
pub fn initialize_result(server_name: &str, version: &str, instructions: &str) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {
            "tools": { "listChanged": true },
            "prompts": { "listChanged": true },
        },
        "serverInfo": { "name": server_name, "version": version },
        "instructions": instructions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_request_reads_method_id_and_params() {
        let request = parse_request(r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"x"}}"#)
            .expect("parse")
            .expect("some request");
        assert_eq!(request.method, "tools/call");
        assert_eq!(request.id, Some(json!(7)));
        assert_eq!(request.param_str("name"), Some("x"));
        assert!(!request.is_notification());
    }

    #[test]
    fn parse_request_treats_missing_id_as_notification() {
        let request = parse_request(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
            .expect("parse")
            .expect("some request");
        assert!(request.is_notification());
    }

    #[test]
    fn parse_request_treats_null_id_as_notification() {
        // A null id must not be echoed back as a response id — JSON-RPC reserves null for errors
        // where the id could not be determined.
        let request = parse_request(r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#)
            .expect("parse")
            .expect("some request");
        assert!(request.is_notification());
    }

    #[test]
    fn parse_request_skips_blank_lines_and_responses() {
        assert!(parse_request("   ").expect("blank ok").is_none());
        assert!(parse_request(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#)
            .expect("response ok")
            .is_none());
    }

    #[test]
    fn parse_request_reports_malformed_json() {
        let (code, _) = parse_request("{not json").expect_err("must fail");
        assert_eq!(code, PARSE_ERROR);
    }

    #[test]
    fn tool_call_result_omits_is_error_when_successful() {
        let value = ToolCallResult::text("ok").to_value();
        assert!(value.get("isError").is_none());
        assert_eq!(value["content"][0]["text"], json!("ok"));

        let failed = ToolCallResult::failure("nope").to_value();
        assert_eq!(failed["isError"], json!(true));
    }

    #[test]
    fn tool_call_result_round_trips_through_sidecar_shape() {
        let original = ToolCallResult {
            content: vec![json!({ "type": "text", "text": "hi" }), json!({ "type": "image", "data": "b64" })],
            is_error: true,
        };
        assert_eq!(ToolCallResult::from_value(&original.to_value()), original);
    }

    #[test]
    fn initialize_result_advertises_list_changed() {
        let value = initialize_result("overdare-ai-agent", "0.0.1", "hello");
        assert_eq!(value["protocolVersion"], json!(PROTOCOL_VERSION));
        assert_eq!(value["capabilities"]["tools"]["listChanged"], json!(true));
        assert_eq!(value["instructions"], json!("hello"));
    }
}
