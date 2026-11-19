pub mod assets;
pub mod config;
pub mod daemon;
pub mod diff;
pub mod gateway;
pub mod generate;
pub mod html_text;
pub mod index;
pub mod install;
pub mod libraries;
pub mod links;
pub mod project;
pub mod r0;
pub mod references;
pub mod related;
pub mod route;
pub mod run_dir;
pub mod screenshot;
pub mod timings;

use std::fmt::Write as _;
use std::io;
use std::net::Ipv4Addr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use gjd_core::journal::{CommitError, Journal};
use gjd_core::policy::ProjectRoot;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::daemon::Daemon;
use crate::run_dir::{DaemonInfo, PROTOCOL_VERSION, RunDir};

const TOKEN_BYTES: usize = 32;

pub const VERSION: &str = match option_env!("GJD_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};
const IDLE_CHECK_EVERY: Duration = Duration::from_secs(15);

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Stopped,
    AlreadyRunning,
}

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Journal(#[from] CommitError),
}

pub async fn run(project: &Path, idle_timeout: Duration) -> Result<Outcome, RunError> {
    let project = ProjectRoot::new(project)?;
    let run_dir = RunDir::create(project.path())?;
    let Some(_lock) = run_dir.lock()? else {
        return Ok(Outcome::AlreadyRunning);
    };

    let journal = Journal::open(project.clone())?;
    for recovery in journal.recover()? {
        tracing::warn!(
            ?recovery,
            "settled a change interrupted by a previous daemon"
        );
    }

    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();
    let token = new_token()?;
    let pid = std::process::id();
    run_dir.write_info(&DaemonInfo {
        pid,
        port,
        token: token.clone(),
        version: VERSION.to_owned(),
        protocol: PROTOCOL_VERSION,
    })?;

    let daemon = Arc::new(Daemon::new(project, journal));
    let shutdown = CancellationToken::new();
    tokio::spawn(stop_on_signal(shutdown.clone()));
    tokio::spawn(stop_when_idle(
        Arc::clone(&daemon),
        idle_timeout,
        shutdown.clone(),
    ));
    tracing::info!(port, pid, "listening");

    let served = gateway::serve(listener, daemon, token, shutdown).await;
    run_dir.remove_info_if_ours(pid);
    served?;
    Ok(Outcome::Stopped)
}

fn new_token() -> io::Result<String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
    let mut hex = String::with_capacity(TOKEN_BYTES * 2);
    for byte in bytes {
        write!(hex, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(hex)
}

#[cfg(unix)]
async fn stop_on_signal(shutdown: CancellationToken) {
    use tokio::signal::unix::{SignalKind, signal};

    let Ok(mut terminate) = signal(SignalKind::terminate()) else {
        tracing::warn!("cannot listen for SIGTERM; the daemon stops on Ctrl-C or when idle");
        return;
    };
    tokio::select! {
        _ = terminate.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
    shutdown.cancel();
}

#[cfg(windows)]
async fn stop_on_signal(shutdown: CancellationToken) {
    use tokio::signal::windows::{ctrl_break, ctrl_close};

    let (Ok(mut close), Ok(mut brk)) = (ctrl_close(), ctrl_break()) else {
        tracing::warn!("cannot listen for console events; the daemon stops on Ctrl-C or when idle");
        let _ = tokio::signal::ctrl_c().await;
        shutdown.cancel();
        return;
    };
    tokio::select! {
        _ = close.recv() => {}
        _ = brk.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
    shutdown.cancel();
}

async fn stop_when_idle(daemon: Arc<Daemon>, idle_timeout: Duration, shutdown: CancellationToken) {
    let mut checks = tokio::time::interval(idle_timeout.min(IDLE_CHECK_EVERY));
    loop {
        checks.tick().await;
        if daemon.idle_for().is_some_and(|idle| idle >= idle_timeout) {
            tracing::info!(?idle_timeout, "no client connected; stopping");
            shutdown.cancel();
            return;
        }
    }
}
