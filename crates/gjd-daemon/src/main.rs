use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use clap::{Parser, Subcommand};
use gjd_daemon::Outcome;
use gjd_daemon::run_dir::{DaemonInfo, RunDir};
use gjd_daemon::tracker::commands;
use gjd_providers::{
    AuthStatus, Effort, GenerationRequest, ProviderAdapter, ProviderId, RunTimings, ToolPolicy,
    adapter,
};
use tokio_util::sync::CancellationToken;

const PROBE_TIMEOUT: Duration = Duration::from_mins(2);
const STOP_WAIT: Duration = Duration::from_secs(5);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(2);
const PROBE_SYSTEM_PROMPT: &str = "Answer only with the requested JSON.";
const PROBE_PROMPT: &str = "Return exactly one variant: label Probe, system project, style plain, \
rationale probe, missing empty, and a single create_file op for src/GuiJamProbe.tsx with content \
'export {}'.";

#[derive(Parser)]
#[command(name = "gjd", version = gjd_daemon::VERSION, about = "GUIJam daemon and developer CLI")]
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
    #[command(subcommand, about = "Connect GUIJam to Jira")]
    Jira(JiraCommand),
    #[command(subcommand, about = "Let GUIJam read Figma frames you link in prompts")]
    Figma(FigmaCommand),
}

#[derive(Subcommand)]
enum FigmaCommand {
    #[command(about = "Save a Figma personal access token, read from standard input")]
    Login,
    #[command(about = "Forget the saved Figma token")]
    Logout,
    #[command(about = "Show whether a Figma token is saved and accepted")]
    Status {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum JiraCommand {
    #[command(about = "Pair with Jira using the code from a ticket's GUIJam panel")]
    Pair { code: String },
    #[command(about = "Show the paired Jira sites")]
    Status {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Unpair a Jira site and revoke this device")]
    Unpair { site: Option<String> },
    #[command(about = "Check that the paired Jira site answers")]
    Test {
        #[arg(long)]
        site: Option<String>,
    },
    #[command(about = "Create a ticket with a screenshot")]
    Create {
        #[arg(long)]
        site: Option<String>,
        #[arg(long)]
        project: String,
        #[arg(long)]
        summary: String,
        #[arg(long)]
        description_file: Option<PathBuf>,
        #[arg(long)]
        image: Option<PathBuf>,
        #[arg(long, default_value = "")]
        page_url: String,
        #[arg(long, default_value = "")]
        src: String,
    },
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
        #[arg(long)]
        effort: Option<Effort>,
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
        #[arg(long)]
        effort: Option<Effort>,
    },
}

async fn jira(command: JiraCommand) -> ExitCode {
    let outcome = tokio::task::spawn_blocking(move || match command {
        JiraCommand::Pair { code } => commands::pair(&code),
        JiraCommand::Status { json } => commands::status(json),
        JiraCommand::Unpair { site } => commands::unpair(site.as_deref()),
        JiraCommand::Test { site } => commands::test(site.as_deref()),
        JiraCommand::Create {
            site,
            project,
            summary,
            description_file,
            image,
            page_url,
            src,
        } => {
            let description = match description_file {
                Some(path) => std::fs::read_to_string(&path)
                    .map_err(|error| format!("Can't read {}: {error}", path.display()))?,
                None => String::new(),
            };
            commands::create(&commands::NewTicket {
                site: site.as_deref(),
                project: &project,
                summary: &summary,
                description: &description,
                image: image.as_deref(),
                page_url: &page_url,
                src: &src,
            })
        }
    })
    .await
    .unwrap_or_else(|error| Err(error.to_string()));
    match outcome {
        Ok(text) => {
            println!("{text}");
            ExitCode::SUCCESS
        }
        Err(text) => {
            eprintln!("{text}");
            ExitCode::FAILURE
        }
    }
}

fn figma(command: &FigmaCommand) -> Result<String, String> {
    use gjd_daemon::figma;
    match command {
        FigmaCommand::Login => {
            let mut line = String::new();
            std::io::stdin()
                .read_line(&mut line)
                .map_err(|error| format!("Couldn't read the token: {error}"))?;
            let token = figma::Token::new(&line)
                .ok_or("Paste a Figma personal access token, then press Enter.")?;
            figma::check(&token).map_err(|error| format!("{error}. {}", error.action()))?;
            let stored = figma::save(&token)?;
            Ok(format!(
                "Figma token saved in {stored}. Paste a frame link into a prompt to use it."
            ))
        }
        FigmaCommand::Logout => Ok(if figma::forget()? {
            "Figma token removed.".to_owned()
        } else {
            "No Figma token was saved.".to_owned()
        }),
        FigmaCommand::Status { json } => {
            let saved = figma::load();
            let checked = saved.as_ref().map(|(token, _)| figma::check(token));
            if *json {
                return Ok(serde_json::json!({
                    "token": saved.as_ref().map(|(_, stored)| match stored {
                        figma::Stored::Env => "env",
                        figma::Stored::Keychain => "keychain",
                        figma::Stored::File => "file",
                    }),
                    "accepted": checked.as_ref().map(Result::is_ok),
                    "error": checked.and_then(Result::err).map(|error| error.to_string()),
                })
                .to_string());
            }
            Ok(match (&saved, checked) {
                (None, _) => "No Figma token is saved. Run npx guijam figma login.".to_owned(),
                (Some((_, stored)), Some(Ok(()))) => {
                    format!("Figma token in {stored} is accepted.")
                }
                (Some((_, stored)), Some(Err(error))) => {
                    format!("Figma token in {stored}: {error}. {}", error.action())
                }
                (Some(_), None) => unreachable!("a saved token is always checked"),
            })
        }
    }
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

fn use_provider(id: ProviderId, model: Option<&str>, effort: Option<Effort>) -> ExitCode {
    if adapter(id).is_none() {
        eprintln!("{id}: adapter not available in this build");
        return ExitCode::FAILURE;
    }
    match gjd_daemon::config::set_active_provider(id, model, effort) {
        Ok(path) => {
            let with = match (model, effort) {
                (Some(model), Some(effort)) => format!(" with {model} at {effort} effort"),
                (Some(model), None) => format!(" with {model}"),
                (None, Some(effort)) => format!(" at {effort} effort"),
                (None, None) => String::new(),
            };
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
    effort: Option<Effort>,
    cwd: &std::path::Path,
) -> Result<(RunTimings, Option<f64>), gjd_providers::ProviderError> {
    let request = GenerationRequest {
        model: model.map(str::to_owned),
        effort,
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

async fn test(
    id: ProviderId,
    runs: u32,
    model: Option<String>,
    effort: Option<Effort>,
) -> ExitCode {
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
        eprintln!("{id}: {auth}");
        return ExitCode::FAILURE;
    }

    let workdir = match tempfile::tempdir() {
        Ok(dir) => dir,
        Err(error) => {
            eprintln!("cannot create a scratch directory: {error}");
            return ExitCode::FAILURE;
        }
    };
    let model = model
        .or_else(|| gjd_daemon::config::provider_model(id))
        .or_else(|| id.fast_model().map(str::to_owned));
    let effort = effort
        .or_else(|| gjd_daemon::config::provider_effort(id))
        .or(Some(Effort::Low));
    println!(
        "model {} · effort {}",
        model.as_deref().unwrap_or("default"),
        effort.map_or("default", Effort::as_str)
    );
    let mut ready = Vec::new();
    let mut answer = Vec::new();
    for run in 1..=runs {
        match run_probe(
            provider.as_ref(),
            &discovery,
            model.as_deref(),
            effort,
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

fn control_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(CONTROL_TIMEOUT))
        .build()
        .into()
}

fn control_url(info: &DaemonInfo, path: &str) -> String {
    format!("http://127.0.0.1:{}/{path}", info.port)
}

fn running(project: &Path) -> Option<DaemonInfo> {
    let info = RunDir::of(project).read_info().ok()?;
    let mut response = control_agent()
        .get(control_url(&info, "status"))
        .header("Authorization", format!("Bearer {}", info.token))
        .call()
        .ok()?;
    let body = response.body_mut().read_to_string().ok()?;
    let status: serde_json::Value = serde_json::from_str(&body).ok()?;
    (status.get("pid")?.as_u64()? == u64::from(info.pid)).then_some(info)
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
    let Some(info) = running(project) else {
        println!("not running");
        return ExitCode::FAILURE;
    };
    println!("running · pid {} · port {}", info.pid, info.port);
    ExitCode::SUCCESS
}

async fn stop_daemon(project: &Path) -> ExitCode {
    let Some(info) = running(project) else {
        println!("not running");
        return ExitCode::SUCCESS;
    };
    let pid = info.pid;
    if let Err(error) = control_agent()
        .post(control_url(&info, "stop"))
        .header("Authorization", format!("Bearer {}", info.token))
        .send_empty()
    {
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
        Command::Jira(command) => jira(command).await,
        Command::Figma(command) => {
            match tokio::task::spawn_blocking(move || figma(&command))
                .await
                .unwrap_or_else(|error| Err(error.to_string()))
            {
                Ok(text) => {
                    println!("{text}");
                    ExitCode::SUCCESS
                }
                Err(text) => {
                    eprintln!("{text}");
                    ExitCode::FAILURE
                }
            }
        }
        Command::Provider(ProviderCommand::List { json: true }) => list_json().await,
        Command::Provider(ProviderCommand::List { json: false }) => list().await,
        Command::Provider(ProviderCommand::Use { id, model, effort }) => {
            use_provider(id, model.as_deref(), effort)
        }
        Command::Provider(ProviderCommand::Models { id, json }) => models(id, json).await,
        Command::Provider(ProviderCommand::Test {
            id,
            runs,
            model,
            effort,
        }) => test(id, runs, model, effort).await,
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
