mod cli;
mod env;
mod init;
mod storage;
mod update;
mod webserver;

#[cfg(test)]
mod testutil;

fn main() {
    if let Err(err) = cli::run() {
        eprintln!("{}", err.message);
        // Machine-readable failure line, last on stderr (P077 P4). The exit
        // code carries the same value; Studio today only checks non-zero.
        eprintln!("ERROR_CODE={}", err.code);
        std::process::exit(err.code);
    }
}
