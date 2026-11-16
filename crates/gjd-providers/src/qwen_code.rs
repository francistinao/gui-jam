use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use gjd_core::VARIANT_SET_PROVIDER_SCHEMA;
use serde::Deserialize;
use serde_json::Value;
use tokio::process::Command;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::process::{EventFold, ProviderProcess, Signals, run_to_answer};
use crate::text_answer::{TextRun, generate_with_retry};
use crate::{
    AuthStatus, Capabilities, Discovery, GenerationOutput, GenerationRequest, ProviderAdapter,
    ProviderError, ProviderEvent, ProviderId, RunTimings, ToolPolicy,
};

const BINARY: &str = "qwen";
const LOGIN_COMMAND: &str = "qwen";
const QUERY_TIMEOUT: Duration = Duration::from_secs(20);
const STRUCTURED_TOOL: &str = "structured_output";

pub struct QwenCode;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Event {
    System {
        subtype: Option<String>,
    },
    Assistant {
        message: AssistantMessage,
    },
    Result(ResultEvent),
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct AssistantMessage {
    #[serde(default)]
    content: Vec<ContentBlock>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ContentBlock {
    Text {
        text: String,
    },
    ToolUse {
        name: String,
        #[serde(default)]
        input: Value,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct ResultEvent {
    #[serde(default)]
    is_error: bool,
    result: Option<String>,
    structured_output: Option<Value>,
    error: Option<ResultError>,
    total_cost_usd: Option<f64>,
}

#[derive(Deserialize)]
struct ResultError {
    message: Option<String>,
}

#[derive(Default)]
struct QwenStream {
    ready: Option<Duration>,
    text: String,
    structured: Option<Value>,
    signals: Signals,
}

struct Answer {
    text: String,
    cost: Option<f64>,
}

fn classify(message: &str) -> ProviderError {
    let lower = message.to_lowercase();
    if lower.contains("auth type")
        || lower.contains("discontinued")
        || lower.contains("401")
        || lower.contains("api key")
        || lower.contains("unauthorized")
    {
        ProviderError::NotAuthenticated {
            provider: ProviderId::QwenCode,
            login_command: LOGIN_COMMAND,
        }
    } else if lower.contains("429") || lower.contains("rate limit") || lower.contains("quota") {
        ProviderError::RateLimited
    } else if lower.contains("529") || lower.contains("overloaded") {
        ProviderError::Overloaded
    } else {
        ProviderError::Failed(message.to_owned())
    }
}

impl EventFold for QwenStream {
    type Answer = Answer;

    fn feed(&mut self, line: &str, elapsed: Duration) -> Option<Result<Answer, ProviderError>> {
        if line.trim().is_empty() {
            return None;
        }
        let event = match serde_json::from_str::<Event>(line) {
            Ok(event) => event,
            Err(error) => {
                return Some(Err(ProviderError::InvalidOutput(format!(
                    "unreadable Qwen Code event ({error})"
                ))));
            }
        };
        match event {
            Event::System { subtype } => {
                if subtype.as_deref() == Some("init") {
                    self.ready.get_or_insert(elapsed);
                    self.signals.ready();
                }
                None
            }
            Event::Assistant { message } => {
                for block in message.content {
                    match block {
                        ContentBlock::Text { text } => {
                            self.signals.wrote(text.len());
                            self.text.push_str(&text);
                        }
                        ContentBlock::ToolUse { name, input } if name == STRUCTURED_TOOL => {
                            self.signals.wrote(input.to_string().len());
                            self.structured = Some(input);
                        }
                        ContentBlock::ToolUse { .. } | ContentBlock::Other => {}
                    }
                }
                None
            }
            Event::Result(result) => Some(self.finish(result)),
            Event::Other => None,
        }
    }
}

impl QwenStream {
    fn finish(&mut self, result: ResultEvent) -> Result<Answer, ProviderError> {
        if result.is_error {
            let message = result
                .error
                .and_then(|error| error.message)
                .or(result.result)
                .unwrap_or_else(|| "Qwen Code reported an error".to_owned());
            return Err(classify(&message));
        }
        let text = match result.structured_output.or_else(|| self.structured.take()) {
            Some(value) => value.to_string(),
            None => result
                .result
                .filter(|text| !text.trim().is_empty())
                .unwrap_or_else(|| std::mem::take(&mut self.text)),
        };
        Ok(Answer {
            text,
            cost: result.total_cost_usd,
        })
    }
}

fn args(request: &GenerationRequest) -> Vec<String> {
    let seconds = request.timeout.as_secs().max(1);
    let mut args: Vec<String> = vec![
        "-o".into(),
        "stream-json".into(),
        "--safe-mode".into(),
        "--chat-recording".into(),
        "false".into(),
        "--approval-mode".into(),
        "plan".into(),
        "--system-prompt".into(),
        request.system_prompt.clone(),
        "--json-schema".into(),
        VARIANT_SET_PROVIDER_SCHEMA.into(),
        "--max-wall-time".into(),
        format!("{seconds}s"),
    ];
    if request.tools == ToolPolicy::None {
        args.extend(["--max-tool-calls".into(), "0".into()]);
    }
    if let Some(model) = &request.model {
        args.extend(["-m".into(), model.clone()]);
    }
    args
}

async fn version(binary: &Path) -> Result<String, ProviderError> {
    let output = timeout(
        QUERY_TIMEOUT,
        Command::new(binary)
            .arg("--version")
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| ProviderError::Timeout(QUERY_TIMEOUT))??;
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .next()
        .map(str::to_owned)
        .ok_or_else(|| ProviderError::Failed("`qwen --version` printed nothing".to_owned()))
}

impl QwenCode {
    async fn run_once(
        binary: PathBuf,
        request: GenerationRequest,
        cancel: CancellationToken,
    ) -> Result<TextRun, ProviderError> {
        let started = Instant::now();
        let process = ProviderProcess::spawn(
            &binary,
            args(&request),
            &request.cwd,
            request.user_prompt.as_bytes(),
        )
        .await?;
        request.emit(ProviderEvent::Started);
        let mut stream = QwenStream {
            signals: Signals::new(request.events.clone()),
            ..QwenStream::default()
        };
        let answer = run_to_answer(process, &mut stream, request.timeout, &cancel, started).await?;
        Ok(TextRun {
            text: answer.text,
            timings: RunTimings {
                ready: stream.ready,
                answer: started.elapsed(),
            },
            cost_usd: answer.cost,
        })
    }
}

#[async_trait]
impl ProviderAdapter for QwenCode {
    fn id(&self) -> ProviderId {
        ProviderId::QwenCode
    }

    async fn discover(&self) -> Result<Discovery, ProviderError> {
        let binary =
            which::which(BINARY).map_err(|_| ProviderError::NotInstalled(ProviderId::QwenCode))?;
        let version = version(&binary).await?;
        Ok(Discovery { binary, version })
    }

    async fn check_auth(&self, _discovery: &Discovery) -> AuthStatus {
        AuthStatus::Unknown {
            reason: "Qwen Code has no login-status command. If the first run fails, run `qwen` and choose /auth".to_owned(),
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            structured_output: true,
            image_input: false,
            tool_restriction: true,
        }
    }

    async fn generate(
        &self,
        discovery: &Discovery,
        request: GenerationRequest,
        cancel: CancellationToken,
    ) -> Result<GenerationOutput, ProviderError> {
        let binary = discovery.binary.clone();
        let run_cancel = cancel.clone();
        generate_with_retry(request, &cancel, move |request| {
            Self::run_once(binary.clone(), request, run_cancel.clone())
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use super::{QwenStream, args};
    use crate::process::EventFold;
    use crate::{GenerationRequest, ProviderError, ToolPolicy};

    const NO_AUTH: &str = include_str!("../tests/fixtures/qwen-code/0.26.6/no-auth-type.jsonl");
    const DISCONTINUED: &str =
        include_str!("../tests/fixtures/qwen-code/0.26.6/oauth-discontinued.jsonl");

    fn replay(lines: &str) -> Option<Result<super::Answer, ProviderError>> {
        let mut stream = QwenStream::default();
        lines
            .lines()
            .find_map(|line| stream.feed(line, Duration::from_millis(100)))
    }

    #[test]
    fn recorded_login_failures_point_at_qwen_auth() {
        for fixture in [NO_AUTH, DISCONTINUED] {
            assert!(matches!(
                replay(fixture),
                Some(Err(ProviderError::NotAuthenticated {
                    login_command: "qwen",
                    ..
                }))
            ));
        }
    }

    #[test]
    fn takes_structured_output_from_the_result_the_tool_call_or_the_text() {
        let from_result = concat!(
            r#"{"type":"system","subtype":"init"}"#,
            "\n",
            r#"{"type":"result","is_error":false,"structured_output":{"variants":[]},"total_cost_usd":0.01}"#
        );
        let from_tool = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"structured_output","input":{"answer":"x","variants":[]}}]}}"#,
            "\n",
            r#"{"type":"result","is_error":false}"#
        );
        let from_text =
            r#"{"type":"result","is_error":false,"result":"```json\n{\"variants\":[]}\n```"}"#;

        let answer = replay(from_result).expect("done").expect("answer");
        assert_eq!(answer.text, r#"{"variants":[]}"#);
        assert_eq!(answer.cost, Some(0.01));
        let tool = replay(from_tool).expect("done").expect("answer");
        assert!(tool.text.contains("\"answer\":\"x\""), "{}", tool.text);
        let text = replay(from_text).expect("done").expect("answer");
        assert!(text.text.starts_with("```json"));
    }

    #[test]
    fn widget_runs_are_safe_mode_plan_only_and_without_tool_calls() {
        let request = GenerationRequest {
            model: Some("qwen3-coder-plus".to_owned()),
            system_prompt: "Be brief.".to_owned(),
            user_prompt: "Element: <button>".to_owned(),
            images: Vec::new(),
            tools: ToolPolicy::None,
            timeout: Duration::from_secs(60),
            cwd: PathBuf::from("."),
            events: None,
        };
        let none = args(&request);
        let read_only = args(&GenerationRequest {
            tools: ToolPolicy::ReadOnly,
            ..request
        });

        let after = |run: &[String], flag: &str| {
            run.iter()
                .position(|arg| arg == flag)
                .map(|index| run[index + 1].clone())
        };
        for run in [&none, &read_only] {
            assert!(run.iter().any(|arg| arg == "--safe-mode"));
            assert_eq!(after(run, "--approval-mode").as_deref(), Some("plan"));
            assert_eq!(after(run, "--chat-recording").as_deref(), Some("false"));
            assert_eq!(after(run, "--system-prompt").as_deref(), Some("Be brief."));
            assert_eq!(after(run, "--max-wall-time").as_deref(), Some("60s"));
            assert!(after(run, "--json-schema").is_some_and(|schema| schema.contains("variants")));
        }
        assert_eq!(after(&none, "--max-tool-calls").as_deref(), Some("0"));
        assert_eq!(after(&read_only, "--max-tool-calls"), None);
        assert_eq!(after(&none, "-m").as_deref(), Some("qwen3-coder-plus"));
    }
}
