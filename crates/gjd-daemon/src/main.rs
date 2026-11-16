use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use clap::{Parser, Subcommand};
use gjd_daemon::Outcome;
use gjd_daemon::run_dir::RunDir;
use gjd_providers::{
    AuthStatus, GenerationRequest, ProviderAdapter, ProviderId, RunTimings, ToolPolicy, adapter,
};
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use tokio_util::sync::CancellationToken;

const PROBE_TIMEOUT: Duration = Duration::from_mins(2);
const STOP_WAIT: Duration = Duration::from_secs(5);
const PROBE_SYSTEM_PROMPT: &str = "Answer only with the requested JSON.";
const PROBE_PROMPT: &str = "Return exactly one variant: label Probe, system project, style plain, \
rationale probe, missing empty, and a single create_file op for src/GuiJamProbe.tsx with content \
'export {}'.";

#[derive(Parser)]
#[command(name = "gjd", version, about = "GUIJam daemon and developer CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    #[command(subcommand)]
    Provider(ProviderCommand),
    #[command(subcommand)]
    Daemon(DaemonCommand),
}

#[derive(Subcommand)]
enum DaemonCommand {
    Run {
        #[arg(long)]
        project: PathBuf,
        #[arg(long, default_value_t = 1800)]
        idle_seconds: u64,
    },
    Status {
        #[arg(long, default_value = ".")]
        project: PathBuf,
    },
    Stop {
        #[arg(long, default_value = ".")]
        project: PathBuf,
    },
}

#[derive(Subcommand)]
enum ProviderCommand {
    List {
        #[arg(long)]
        json: bool,
    },
    Use {
        id: ProviderId,
        #[arg(long)]
        model: Option<String>,
    },
    Models {
        id: ProviderId,
        #[arg(long)]
        json: bool,
    },
    Test {
        id: ProviderId,
        #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u32).range(1..))]
        runs: u32,
        #[arg(long)]
        model: Option<String>,
    },
}

fn percentile(samples: &[Duration], p: usize) -> Duration {
    let mut sorted = samples.to_vec();
    sorted.sort();
    let rank = (p * sorted.len()).div_ceil(100).max(1);
    sorted[rank - 1]
}

async fn list_json() -> ExitCode {
    let active = gjd_daemon::config::active_provider();
    let mut entries = Vec::new();
    for id in ProviderId::ALL {
        let mut entry = serde_json::json!({
            "id": id.as_str(),
            "name": id.display_name(),
            "active": active == Some(id),
            "installCommand": id.install_command(),
            "installed": false,
            "auth": "unknown",
        });
        if let Some(model) = gjd_daemon::config::provider_model(id) {
            entry["model"] = model.into();
        }
        if let Some(provider) = adapter(id)
            && let Ok(discovery) = provider.discover().await
        {
            entry["installed"] = true.into();
            entry["version"] = discovery.version.clone().into();
            match provider.check_auth(&discovery).await {
                AuthStatus::LoggedIn => entry["auth"] = "logged_in".into(),
                AuthStatus::NotLoggedIn { login_command } => {
                    entry["auth"] = "not_logged_in".into();
                    entry["loginCommand"] = login_command.into();
                }
                AuthStatus::Unknown { reason } => entry["reason"] = reason.into(),
            }
        }
        entries.push(entry);
    }
    println!("{}", serde_json::Value::Array(entries));
    ExitCode::SUCCESS
}

fn use_provider(id: ProviderId, model: Option<&str>) -> ExitCode {
    if adapter(id).is_none() {
        eprintln!("{id}: adapter not available in this build");
        return ExitCode::FAILURE;
    }
    match gjd_daemon::config::set_active_provider(id, model) {
        Ok(path) => {
            let with = model.map_or_else(String::new, |model| format!(" with {model}"));
            println!(
                "{}{with} is now the AI tool for GUIJam ({})",
                id.display_name(),
                path.display()
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("cannot save the choice: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn models(id: ProviderId, json: bool) -> ExitCode {
    let Some(provider) = adapter(id) else {
        eprintln!("{id}: adapter not available in this build");
        return ExitCode::FAILURE;
    };
    let listed = match provider.discover().await {
        Ok(discovery) => provider.models(&discovery).await,
        Err(error) => Err(error),
    };
    let models = match listed {
        Ok(models) => models,
        Err(error) => {
            eprintln!("{id}: {error}");
            return ExitCode::FAILURE;
        }
    };
    if json {
        let entries: Vec<serde_json::Value> = models
            .iter()
            .map(|model| {
                serde_json::json!({
                    "id": model.id,
                    "name": model.name,
                    "images": model.images,
                    "free": model.free,
                })
            })
            .collect();
        println!("{}", serde_json::Value::Array(entries));
    } else {
        for model in &models {
            let images = if model.images { " · images" } else { "" };
            let free = if model.free { " · free" } else { "" };
            println!("{:<40} {}{images}{free}", model.id, model.name);
        }
    }
    ExitCode::SUCCESS
}

async fn list() -> ExitCode {
    for id in ProviderId::ALL {
        let Some(provider) = adapter(id) else {
            println!("{id:<12} adapter not available in this build");
            continue;
        };
        match provider.discover().await {
            Ok(discovery) => {
                let auth = provider.check_auth(&discovery).await;
                println!("{id:<12} {} · {auth}", discovery.version);
            }
            Err(error) => println!("{id:<12} {error}"),
        }
    }
    ExitCode::SUCCESS
}

async fn run_probe(
    provider: &dyn ProviderAdapter,
    discovery: &gjd_providers::Discovery,
    model: Option<&str>,
    cwd: &std::path::Path,
) -> Result<(RunTimings, Option<f64>), gjd_providers::ProviderError> {
    let request = GenerationRequest {
        model: model.map(str::to_owned),
        system_prompt: PROBE_SYSTEM_PROMPT.to_owned(),
        user_prompt: PROBE_PROMPT.to_owned(),
        images: Vec::new(),
        tools: ToolPolicy::None,
        timeout: PROBE_TIMEOUT,
        cwd: cwd.to_path_buf(),
        events: None,
    };
    let output = provider
        .generate(discovery, request, CancellationToken::new())
        .await?;
    Ok((output.timings, output.cost_usd))
}

async fn test(id: ProviderId, runs: u32, model: Option<String>) -> ExitCode {
    let Some(provider) = adapter(id) else {
        eprintln!("{id}: adapter not available in this build");
        return ExitCode::FAILURE;
    };
    let discovery = match provider.discover().await {
        Ok(discovery) => discovery,
        Err(error) => {
            eprintln!("{id}: {error}");
            return ExitCode::FAILURE;
        }
    };
    let auth = provider.check_auth(&discovery).await;
    println!("{id} {} · {auth}", discovery.version);
    if let AuthStatus::NotLoggedIn { .. } = auth {
        return ExitCode::FAILURE;
    }

    let workdir = match tempfile::tempdir() {
        Ok(dir) => dir,
        Err(error) => {
            eprintln!("cannot create a scratch directory: {error}");
            return ExitCode::FAILURE;
        }
    };
    let model = model.or_else(|| id.fast_model().map(str::to_owned));
    let mut ready = Vec::new();
    let mut answer = Vec::new();
    for run in 1..=runs {
        match run_probe(
            provider.as_ref(),
            &discovery,
            model.as_deref(),
            workdir.path(),
        )
        .await
        {
            Ok((timings, cost)) => {
                println!(
                    "run {run}: ready {} ms · answer {} ms{}",
                    timings
                        .ready
                        .map_or_else(|| "?".to_owned(), |d| d.as_millis().to_string()),
                    timings.answer.as_millis(),
                    cost.map_or_else(String::new, |cost| format!(" · cost ${cost:.4}")),
                );
                ready.extend(timings.ready);
                answer.push(timings.answer);
            }
            Err(error) => {
                eprintln!("run {run}: {error}");
                return ExitCode::FAILURE;
            }
        }
    }
    if runs > 1 {
        if !ready.is_empty() {
            println!(
                "ready  p50 {} ms · p95 {} ms",
                percentile(&ready, 50).as_millis(),
                percentile(&ready, 95).as_millis()
            );
        }
        println!(
            "answer p50 {} ms · p95 {} ms",
            percentile(&answer, 50).as_millis(),
            percentile(&answer, 95).as_millis()
        );
    }
    ExitCode::SUCCESS
}

fn running_pid(project: &Path) -> Option<(Pid, u16)> {
    let info = RunDir::of(project).read_info().ok()?;
    let pid = Pid::from_raw(i32::try_from(info.pid).ok()?);
    kill(pid, None).ok().map(|()| (pid, info.port))
}

async fn run_daemon(project: &Path, idle_seconds: u64) -> ExitCode {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();
    match gjd_daemon::run(project, Duration::from_secs(idle_seconds)).await {
        Ok(Outcome::Stopped) => ExitCode::SUCCESS,
        Ok(Outcome::AlreadyRunning) => {
            eprintln!("a daemon already serves {}", project.display());
            ExitCode::SUCCESS
        }
        Err(error) => {
            tracing::error!(%error, "daemon failed");
            ExitCode::FAILURE
        }
    }
}

fn daemon_status(project: &Path) -> ExitCode {
    let Some((pid, port)) = running_pid(project) else {
        println!("not running");
        return ExitCode::FAILURE;
    };
    println!("running · pid {pid} · port {port}");
    ExitCode::SUCCESS
}

async fn stop_daemon(project: &Path) -> ExitCode {
    let Some((pid, _)) = running_pid(project) else {
        println!("not running");
        return ExitCode::SUCCESS;
    };
    if let Err(error) = kill(pid, Signal::SIGTERM) {
        eprintln!("cannot stop pid {pid}: {error}");
        return ExitCode::FAILURE;
    }
    let info_path = RunDir::of(project).info_path();
    let deadline = Instant::now() + STOP_WAIT;
    while Instant::now() < deadline {
        if !info_path.exists() {
            println!("stopped");
            return ExitCode::SUCCESS;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    eprintln!("pid {pid} did not stop within {STOP_WAIT:?}");
    ExitCode::FAILURE
}

#[tokio::main]
async fn main() -> ExitCode {
    match Cli::parse().command {
        Command::Daemon(DaemonCommand::Run {
            project,
            idle_seconds,
        }) => run_daemon(&project, idle_seconds).await,
        Command::Daemon(DaemonCommand::Status { project }) => daemon_status(&project),
        Command::Daemon(DaemonCommand::Stop { project }) => stop_daemon(&project).await,
        Command::Provider(ProviderCommand::List { json: true }) => list_json().await,
        Command::Provider(ProviderCommand::List { json: false }) => list().await,
        Command::Provider(ProviderCommand::Use { id, model }) => use_provider(id, model.as_deref()),
        Command::Provider(ProviderCommand::Models { id, json }) => models(id, json).await,
        Command::Provider(ProviderCommand::Test { id, runs, model }) => test(id, runs, model).await,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::percentile;

    #[test]
    fn percentile_uses_the_nearest_rank() {
        let samples: Vec<_> = (1..=20).map(Duration::from_millis).collect();

        assert_eq!(percentile(&samples, 50), Duration::from_millis(10));
        assert_eq!(percentile(&samples, 95), Duration::from_millis(19));
        assert_eq!(percentile(&samples[..1], 95), Duration::from_millis(1));
    }
}
