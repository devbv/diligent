fn main() {
    if let Err(err) = overdare_ai_agent::cli::run_mcp_router_binary() {
        eprintln!("{}", err.message);
        eprintln!("ERROR_CODE={}", err.code);
        std::process::exit(err.code);
    }
}
