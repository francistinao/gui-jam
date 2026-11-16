use std::process::ExitCode;
use std::time::Duration;

use clap::{Parser, Subcommand};
use gjd_providers::{
    AuthStatus, GenerationRequest, ProviderAdapter, ProviderId, RunTimings, ToolPolicy, adapter,
};
use tokio_util::sync::CancellationToken;

const PROBE_TIMEOUT: Duration = Duration::from_mins(2);
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
}

#[derive(Subcommand)]
enum ProviderCommand {
    /// Show each supported provider CLI with its version and login status.
    List,
    /// Check that a provider can answer a widget request, and time it.
    Test {
        /// claude-code or codex
        id: ProviderId,
        /// Number of probe requests; with more than one, p50 and p95 are printed.
        #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u32).range(1..))]
        runs: u32,
        /// Model argument passed to the CLI; defaults to the provider's fast tier.
        #[arg(long)]
        model: Option<String>,
    },
}

// Aliases the CLIs document; a provider without one uses its own default model.
fn fast_tier_model(id: ProviderId) -> Option<&'static str> {
    match id {
        ProviderId::ClaudeCode => Some("haiku"),
        ProviderId::Codex => None,
    }
}

fn percentile(samples: &[Duration], p: usize) -> Duration {
    let mut sorted = samples.to_vec();
    sorted.sort();
    let rank = (p * sorted.len()).div_ceil(100).max(1);
    sorted[rank - 1]
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
    let model = model.or_else(|| fast_tier_model(id).map(str::to_owned));
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
                    "run {run}: ready {} ms · answer {} ms · cost ${:.4}",
                    timings
                        .ready
                        .map_or_else(|| "?".to_owned(), |d| d.as_millis().to_string()),
                    timings.answer.as_millis(),
                    cost.unwrap_or_default(),
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

#[tokio::main]
async fn main() -> ExitCode {
    match Cli::parse().command {
        Command::Provider(ProviderCommand::List) => list().await,
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
