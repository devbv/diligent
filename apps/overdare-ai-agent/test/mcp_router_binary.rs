use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

#[test]
fn dedicated_binary_starts_the_router_without_a_subcommand() {
    let executable = env!("CARGO_BIN_EXE_overdare-mcp");
    let expected_name = if cfg!(windows) {
        "overdare-mcp.exe"
    } else {
        "overdare-mcp"
    };
    assert_eq!(
        Path::new(executable)
            .file_name()
            .and_then(|name| name.to_str()),
        Some(expected_name)
    );

    let temporary_home =
        std::env::temp_dir().join(format!("overdare-mcp-binary-{}", std::process::id()));
    std::fs::create_dir_all(&temporary_home).expect("create temporary home");

    let mut child = Command::new(executable)
        .env("HOME", &temporary_home)
        .env("USERPROFILE", &temporary_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start dedicated MCP router");

    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {
                "name": "dedicated-router-test",
                "version": "1.0.0"
            }
        }
    });
    writeln!(child.stdin.as_mut().expect("router stdin"), "{}", request)
        .expect("write initialize request");
    drop(child.stdin.take());

    let output = child.wait_with_output().expect("wait for router");
    assert!(
        output.status.success(),
        "router failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let response: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("parse initialize response");
    assert_eq!(response["id"], 1);
    assert_eq!(
        response["result"]["serverInfo"]["name"],
        "overdare-ai-agent"
    );
    assert!(response["result"]["capabilities"]["tools"].is_object());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("[mcp-router] ready on stdio"),
        "router readiness log missing"
    );

    let _ = std::fs::remove_dir_all(temporary_home);
}
