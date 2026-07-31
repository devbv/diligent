pub mod cli;
mod env;
mod init;
mod mcp_protocol;
mod mcp_router;
mod monitoring;
mod storage;
mod studio_registry;
mod studio_router;
mod update;
mod webserver;

#[cfg(test)]
mod testutil;
