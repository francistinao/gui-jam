use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use gjd_core::VARIANT_SET_PROVIDER_SCHEMA;
use gjd_core::contracts::VariantSet;
use serde::Deserialize;
use serde_json::json;
use tokio::process::Command;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::process::ProviderProcess;
use crate::{
    AuthStatus, Capabilities, Discovery, GenerationOutput, GenerationRequest, ProviderAdapter,
    ProviderError, ProviderId, RunTimings, ToolPolicy,
};

const BINARY: &str = "claude";
const LOGIN_COMMAND: &str = "claude auth login";
const READ_ONLY_TOOLS: &str = "Read,Grep,Glob";
const QUERY_TIMEOUT: Duration = Duration::from_secs(10);
const EXIT_GRACE: Duration = Duration::from_secs(10);

pub struct ClaudeCode;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum StreamEvent {
    System {
        #[serde(default)]
        subtype: Option<String>,
    },
    Assistant {
        #[serde(default)]
        error: Option<String>,
    },
    Result(ResultEvent),
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct ResultEvent {
    is_error: bool,
    #[serde(default)]
    api_error_status: Option<u16>,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    structured_output: Option<serde_json::Value>,
    #[serde(default)]
    total_cost_usd: Option<f64>,
}

#[derive(Deserialize)]
struct AuthStatusReport {
    #[serde(rename = "loggedIn")]
    logged_in: bool,
}

#[derive(Debug)]
struct Answer {
    variant_set: VariantSet,
    cost_usd: Option<f64>,
}

#[derive(Default)]
struct ClaudeStream {
    ready: Option<Duration>,
    assistant_error: Option<String>,
}

impl ClaudeStream {
    fn feed(&mut self, line: &str, elapsed: Duration) -> Option<Result<Answer, ProviderError>> {
        if line.trim().is_empty() {
            return None;
        }
        let event = match serde_json::from_str::<StreamEvent>(line) {
            Ok(event) => event,
            Err(error) => {
                return Some(Err(ProviderError::InvalidOutput(format!(
                    "unreadable stream event: {error}"
                ))));
            }
        };
        match event {
            StreamEvent::System { subtype } if subtype.as_deref() == Some("init") => {
                self.ready.get_or_insert(elapsed);
                None
            }
            StreamEvent::Assistant { error: Some(error) } => {
                self.assistant_error = Some(error);
                None
            }
            StreamEvent::Result(result) => Some(self.finish(result)),
            StreamEvent::System { .. } | StreamEvent::Assistant { .. } | StreamEvent::Other => None,
        }
    }

    fn finish(&self, result: ResultEvent) -> Result<Answer, ProviderError> {
        if result.is_error {
            let authentication_failed = result.api_error_status == Some(401)
                || self.assistant_error.as_deref() == Some("authentication_failed");
            return Err(if authentication_failed {
                ProviderError::NotAuthenticated {
                    provider: ProviderId::ClaudeCode,
                    login_command: LOGIN_COMMAND,
                }
            } else {
                match result.api_error_status {
                    Some(429) => ProviderError::RateLimited,
                    Some(529) => ProviderError::Overloaded,
                    _ => ProviderError::Failed(
                        result
                            .result
                            .unwrap_or_else(|| "no error message".to_owned()),
                    ),
                }
            });
        }
        let structured = result.structured_output.ok_or_else(|| {
            ProviderError::InvalidOutput("the result carries no structured_output".to_owned())
        })?;
        let variant_set = serde_json::from_value(structured)
            .map_err(|error| ProviderError::InvalidOutput(error.to_string()))?;
        Ok(Answer {
            variant_set,
            cost_usd: result.total_cost_usd,
        })
    }
}

fn args(request: &GenerationRequest) -> Vec<&str> {
    let mut args = vec![
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--json-schema",
        VARIANT_SET_PROVIDER_SCHEMA,
        "--append-system-prompt",
        &request.system_prompt,
        "--tools",
        match request.tools {
            ToolPolicy::None => "",
            ToolPolicy::ReadOnly => READ_ONLY_TOOLS,
        },
    ];
    if let Some(model) = &request.model {
        args.extend(["--model", model]);
    }
    args
}

fn user_message(request: &GenerationRequest) -> String {
    let images = request.images.iter().map(|image| {
        json!({
            "type": "image",
            "source": { "type": "base64", "media_type": image.media_type, "data": image.base64 },
        })
    });
    let text = json!({ "type": "text", "text": request.user_prompt });
    let content: Vec<_> = images.chain(std::iter::once(text)).collect();
    format!(
        "{}\n",
        json!({ "type": "user", "message": { "role": "user", "content": content } })
    )
}

async fn query(binary: &Path, args: &[&str]) -> Result<String, ProviderError> {
    let output = timeout(
        QUERY_TIMEOUT,
        Command::new(binary)
            .args(args)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| ProviderError::Timeout(QUERY_TIMEOUT))??;
    if !output.status.success() {
        return Err(ProviderError::Failed(format!(
            "`claude {}` exited with {}: {}",
            args.join(" "),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn read_answer(
    process: &mut ProviderProcess,
    stream: &mut ClaudeStream,
    started: Instant,
) -> std::io::Result<Option<Result<Answer, ProviderError>>> {
    while let Some(line) = process.next_line().await? {
        if let Some(finished) = stream.feed(&line, started.elapsed()) {
            return Ok(Some(finished));
        }
    }
    Ok(None)
}

#[async_trait]
impl ProviderAdapter for ClaudeCode {
    fn id(&self) -> ProviderId {
        ProviderId::ClaudeCode
    }

    async fn discover(&self) -> Result<Discovery, ProviderError> {
        let binary = which::which(BINARY)
            .map_err(|_| ProviderError::NotInstalled(ProviderId::ClaudeCode))?;
        let stdout = query(&binary, &["--version"]).await?;
        let version = stdout
            .split_whitespace()
            .next()
            .ok_or_else(|| ProviderError::Failed("`claude --version` printed nothing".to_owned()))?
            .to_owned();
        Ok(Discovery { binary, version })
    }

    async fn check_auth(&self, discovery: &Discovery) -> AuthStatus {
        let stdout = match query(&discovery.binary, &["auth", "status", "--json"]).await {
            Ok(stdout) => stdout,
            Err(error) => {
                return AuthStatus::Unknown {
                    reason: error.to_string(),
                };
            }
        };
        match serde_json::from_str::<AuthStatusReport>(&stdout) {
            Ok(report) if report.logged_in => AuthStatus::LoggedIn,
            Ok(_) => AuthStatus::NotLoggedIn {
                login_command: LOGIN_COMMAND,
            },
            Err(error) => AuthStatus::Unknown {
                reason: format!("unreadable `claude auth status` output: {error}"),
            },
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            structured_output: true,
            image_input: true,
            tool_restriction: true,
        }
    }

    async fn generate(
        &self,
        discovery: &Discovery,
        request: GenerationRequest,
        cancel: CancellationToken,
    ) -> Result<GenerationOutput, ProviderError> {
        let started = Instant::now();
        let mut process = ProviderProcess::spawn(
            &discovery.binary,
            args(&request),
            &request.cwd,
            user_message(&request).as_bytes(),
        )
        .await?;
        let mut stream = ClaudeStream::default();

        let read = tokio::select! {
            () = cancel.cancelled() => Err(ProviderError::Cancelled),
            read = timeout(request.timeout, read_answer(&mut process, &mut stream, started)) => {
                match read {
                    Err(_elapsed) => Err(ProviderError::Timeout(request.timeout)),
                    Ok(io_result) => io_result.map_err(ProviderError::from),
                }
            }
        };

        match read {
            Ok(Some(finished)) => {
                process.reap_in_background(EXIT_GRACE);
                let answer = finished?;
                Ok(GenerationOutput {
                    variant_set: answer.variant_set,
                    timings: RunTimings {
                        ready: stream.ready,
                        answer: started.elapsed(),
                    },
                    cost_usd: answer.cost_usd,
                })
            }
            Ok(None) => {
                let (exit_code, stderr_tail) = process.exit_code_and_stderr().await;
                Err(ProviderError::Crashed {
                    exit_code,
                    stderr_tail,
                })
            }
            Err(error) => {
                process.terminate().await;
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use gjd_core::contracts::EditOp;

    use super::{Answer, ClaudeStream, args};
    use crate::{GenerationRequest, ProviderError, ToolPolicy};

    const SUCCESS: &str = include_str!("../tests/fixtures/claude-code/2.1.325/success.jsonl");
    const AUTH_FAILURE: &str =
        include_str!("../tests/fixtures/claude-code/2.1.325/auth-failure.jsonl");

    fn replay(stream: &mut ClaudeStream, lines: &str) -> Option<Result<Answer, ProviderError>> {
        lines
            .lines()
            .enumerate()
            .find_map(|(i, line)| stream.feed(line, Duration::from_millis(100 * (i as u64 + 1))))
    }

    fn request(tools: ToolPolicy) -> GenerationRequest {
        GenerationRequest {
            model: None,
            system_prompt: "system".to_owned(),
            user_prompt: "user".to_owned(),
            images: Vec::new(),
            tools,
            timeout: Duration::from_secs(1),
            cwd: PathBuf::from("."),
        }
    }

    fn flag_value<'a>(args: &[&'a str], flag: &str) -> Option<&'a str> {
        let position = args.iter().position(|arg| *arg == flag)?;
        args.get(position + 1).copied()
    }

    #[test]
    fn parses_the_recorded_success_stream_into_a_variant_set() {
        let mut stream = ClaudeStream::default();

        let answer = replay(&mut stream, SUCCESS)
            .expect("stream has a result")
            .expect("result is a valid variant set");

        assert_eq!(stream.ready, Some(Duration::from_millis(100)));
        assert_eq!(answer.variant_set.variants.len(), 1);
        assert!(matches!(
            answer.variant_set.variants[0].ops.as_slice(),
            [EditOp::CreateFile { .. }]
        ));
        assert!(answer.cost_usd.is_some_and(|cost| cost > 0.0));
    }

    #[test]
    fn classifies_the_recorded_invalid_credentials_stream_as_not_authenticated() {
        let mut stream = ClaudeStream::default();

        let result = replay(&mut stream, AUTH_FAILURE).expect("stream has a result");

        assert!(matches!(
            result,
            Err(ProviderError::NotAuthenticated {
                login_command: "claude auth login",
                ..
            })
        ));
    }

    #[test]
    fn maps_api_status_429_to_rate_limited_and_529_to_overloaded() {
        let rate_limited = r#"{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"Rate limited"}"#;
        let overloaded = r#"{"type":"result","subtype":"success","is_error":true,"api_error_status":529,"result":"Overloaded"}"#;

        assert!(matches!(
            replay(&mut ClaudeStream::default(), rate_limited),
            Some(Err(ProviderError::RateLimited))
        ));
        assert!(matches!(
            replay(&mut ClaudeStream::default(), overloaded),
            Some(Err(ProviderError::Overloaded))
        ));
    }

    #[test]
    fn rejects_a_successful_result_without_structured_output() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"Sure!"}"#;

        assert!(matches!(
            replay(&mut ClaudeStream::default(), line),
            Some(Err(ProviderError::InvalidOutput(_)))
        ));
    }

    #[test]
    fn rejects_structured_output_that_breaks_the_edit_op_contract() {
        let line = r#"{"type":"result","is_error":false,"structured_output":{"variants":[{"label":"x","system":"project","style":"s","rationale":"r","missing":[],"ops":[{"kind":"delete_file","file":"src/A.tsx"}]}]}}"#;

        assert!(matches!(
            replay(&mut ClaudeStream::default(), line),
            Some(Err(ProviderError::InvalidOutput(_)))
        ));
    }

    #[test]
    fn rejects_a_stdout_line_that_is_not_a_stream_event() {
        assert!(matches!(
            replay(&mut ClaudeStream::default(), "Loading settings…"),
            Some(Err(ProviderError::InvalidOutput(_)))
        ));
    }

    #[test]
    fn ignores_event_types_it_does_not_know() {
        let lines =
            "{\"type\":\"system\",\"subtype\":\"init\"}\n{\"type\":\"hook_event\",\"name\":\"x\"}";

        assert!(replay(&mut ClaudeStream::default(), lines).is_none());
    }

    #[test]
    fn widget_runs_offer_no_write_tools_and_no_mcp_servers() {
        let no_tools = request(ToolPolicy::None);
        let read_only = request(ToolPolicy::ReadOnly);
        let no_tools_args = args(&no_tools);
        let read_only_args = args(&read_only);

        assert_eq!(flag_value(&no_tools_args, "--tools"), Some(""));
        assert_eq!(
            flag_value(&read_only_args, "--tools"),
            Some("Read,Grep,Glob")
        );
        for run in [&no_tools_args, &read_only_args] {
            assert!(run.contains(&"--strict-mcp-config"));
            assert_eq!(flag_value(run, "--permission-mode"), Some("dontAsk"));
        }
    }
}
