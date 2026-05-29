mod cli;
mod env;
mod init;
mod storage;
mod update;
mod webserver;

fn main() {
    if let Err(message) = cli::run() {
        eprintln!("{message}");
        std::process::exit(1);
    }
}
