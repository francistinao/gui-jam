use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::spawn::command;
use async_trait::async_trait;
use serde::Deserialize;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::process::{EventFold, ProviderProcess, Signals, SpawnOptions, run_to_answer};
use crate::text_answer::{TextRun, generate_with_retry};
use crate::{
    AuthStatus, Capabilities, Discovery, GenerationOutput, GenerationRequest, ProviderAdapter,
    ProviderError, ProviderEvent, ProviderId, RunTimings, ToolPolicy,
};

const BINARY: &str = "gemini";
const LOGIN_COMMAND: &str = "gemini";
const QUERY_TIMEOUT: Duration = Duration::from_secs(20);
const NO_AUTH_EXIT: i32 = 41;
const NO_MCP_SERVER: &str = "guijam-none";
const DENY_ALL_POLICY: &str = "[[rule]]\ntoolName = \"*\"\ndecision = \"deny\"\npriority = 999\ndenyMessage = \"GUIJam runs have no tools.\"\n";

pub struct GeminiCli;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Event {
    Init {},
    Message {
        role: Option<String>,
        #[serde(default)]
        content: String,
    },
    Result {
        status: Option<String>,
        error: Option<ResultError>,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct ResultError {
    message: Option<String>,
}

#[derive(Default)]
struct GeminiStream {
    ready: Option<Duration>,
    text: String,
    signals: Signals,
}

fn classify(message: &str) -> ProviderError {
    let lower = message.to_lowercase();
    if lower.contains("api key not valid")
        || lower.contains("unauthenticated")
        || lower.contains("permission_denied")
        || lower.contains("auth method")
        || lower.contains("401")
    {
        ProviderError::NotAuthenticated {
            provider: ProviderId::GeminiCli,
            login_command: LOGIN_COMMAND,
            detail: Some(message.to_owned()),
        }
    } else if lower.contains("resource_exhausted")
        || lower.contains("429")
        || lower.contains("quota")
    {
        ProviderError::RateLimited
    } else if lower.contains("unavailable") || lower.contains("503") || lower.contains("overloaded")
    {
        ProviderError::Overloaded
    } else {
        ProviderError::Failed(message.to_owned())
    }
}

impl EventFold for GeminiStream {
    type Answer = String;

    fn feed(&mut self, line: &str, elapsed: Duration) -> Option<Result<String, ProviderError>> {
        if line.trim().is_empty() {
            return None;
        }
        let event = match serde_json::from_str::<Event>(line) {
            Ok(event) => event,
            Err(error) => {
                return Some(Err(ProviderError::InvalidOutput(format!(
                    "unreadable Gemini CLI event ({error})"
                ))));
            }
        };
        match event {
            Event::Init {} => {
                self.ready.get_or_insert(elapsed);
                self.signals.ready();
                None
            }
            Event::Message { role, content } => {
                if role.as_deref() == Some("assistant") {
                    self.signals.wrote(content.len());
                    self.text.push_str(&content);
                }
                None
            }
            Event::Result { status, error } => {
                if status.as_deref() == Some("success") {
                    return Some(Ok(std::mem::take(&mut self.text)));
                }
                let message = error
                    .and_then(|error| error.message)
                    .unwrap_or_else(|| "Gemini CLI reported an error".to_owned());
                Some(Err(classify(&message)))
            }
            Event::Other => None,
        }
    }
}

fn args(request: &GenerationRequest, policy: &Path) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        "Answer the request above.".into(),
        "-o".into(),
        "stream-json".into(),
        "--skip-trust".into(),
        "--allowed-mcp-server-names".into(),
        NO_MCP_SERVER.into(),
        "-e".into(),
        "none".into(),
    ];
    match request.tools {
        ToolPolicy::None => args.extend(["--admin-policy".into(), policy.display().to_string()]),
        ToolPolicy::ReadOnly => args.extend(["--approval-mode".into(), "plan".into()]),
    }
    if let Some(model) = &request.model {
        args.extend(["-m".into(), model.clone()]);
    }
    args
}

fn after_exit(error: ProviderError) -> ProviderError {
    if let ProviderError::Crashed {
        exit_code,
        stderr_tail,
    } = &error
        && (*exit_code == Some(NO_AUTH_EXIT) || stderr_tail.contains("Please set an Auth method"))
    {
        return ProviderError::NotAuthenticated {
            provider: ProviderId::GeminiCli,
            login_command: LOGIN_COMMAND,
            detail: stderr_tail
                .lines()
                .map(str::trim)
                .rfind(|line| !line.is_empty())
                .map(str::to_owned),
        };
    }
    error
}

impl GeminiCli {
    async fn run_once(
        binary: PathBuf,
        request: GenerationRequest,
        cancel: CancellationToken,
    ) -> Result<TextRun, ProviderError> {
        let started = Instant::now();
        let dir = tempfile::tempdir()?;
        let system = dir.path().join("system.md");
        let policy = dir.path().join("guijam-policy.toml");
        tokio::fs::write(&system, &request.system_prompt).await?;
        tokio::fs::write(&policy, DENY_ALL_POLICY).await?;
        let process = ProviderProcess::spawn_with(
            &binary,
            args(&request, &policy),
            &request.cwd,
            request.user_prompt.as_bytes(),
            SpawnOptions {
                env: vec![
                    ("GEMINI_SYSTEM_MD".to_owned(), system.display().to_string()),
                    ("NO_COLOR".to_owned(), "1".to_owned()),
                ],
                watch_stderr: false,
            },
        )
        .await?;
        request.emit(ProviderEvent::Started);
        let mut stream = GeminiStream {
            signals: Signals::new(request.events.clone()),
            ..GeminiStream::default()
        };
        let text = run_to_answer(process, &mut stream, request.timeout, &cancel, started)
            .await
            .map_err(after_exit)?;
        Ok(TextRun {
            text,
            timings: RunTimings {
                ready: stream.ready,
                answer: started.elapsed(),
            },
            cost_usd: None,
        })
    }
}

async fn version(binary: &Path) -> Result<String, ProviderError> {
    let output = timeout(
        QUERY_TIMEOUT,
        command(binary)
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
        .ok_or_else(|| ProviderError::Failed("`gemini --version` printed nothing".to_owned()))
}

#[async_trait]
impl ProviderAdapter for GeminiCli {
    fn id(&self) -> ProviderId {
        ProviderId::GeminiCli
    }

    async fn discover(&self) -> Result<Discovery, ProviderError> {
        let binary =
            which::which(BINARY).map_err(|_| ProviderError::NotInstalled(ProviderId::GeminiCli))?;
        let version = version(&binary).await?;
        Ok(Discovery { binary, version })
    }

    async fn check_auth(&self, _discovery: &Discovery) -> AuthStatus {
        AuthStatus::Unknown {
            reason: "Gemini CLI has no login-status command. It needs GEMINI_API_KEY or a login set up by running `gemini`".to_owned(),
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            structured_output: false,
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
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use super::{GeminiStream, after_exit, args};
    use crate::process::EventFold;
    use crate::{GenerationRequest, ProviderError, ToolPolicy};

    const INVALID_KEY: &str =
        include_str!("../tests/fixtures/gemini-cli/0.66.0/invalid-api-key.jsonl");
    const NO_AUTH: &str = include_str!("../tests/fixtures/gemini-cli/0.66.0/no-auth.stderr");

    fn replay(lines: &str) -> (GeminiStream, Option<Result<String, ProviderError>>) {
        let mut stream = GeminiStream::default();
        let finished = lines
            .lines()
            .find_map(|line| stream.feed(line, Duration::from_millis(100)));
        (stream, finished)
    }

    #[test]
    fn recorded_failures_map_to_not_authenticated() {
        let (stream, finished) = replay(INVALID_KEY);

        assert_eq!(stream.ready, Some(Duration::from_millis(100)));
        assert!(matches!(
            finished,
            Some(Err(ProviderError::NotAuthenticated {
                login_command: "gemini",
                ..
            }))
        ));
        for crash in [
            ProviderError::Crashed {
                exit_code: Some(41),
                stderr_tail: String::new(),
            },
            ProviderError::Crashed {
                exit_code: Some(1),
                stderr_tail: NO_AUTH.to_owned(),
            },
        ] {
            assert!(matches!(
                after_exit(crash),
                ProviderError::NotAuthenticated { .. }
            ));
        }
    }

    #[test]
    fn collects_assistant_text_until_a_successful_result() {
        let lines = concat!(
            r#"{"type":"init","session_id":"s","model":"gemini-2.5-flash"}"#,
            "\n",
            r#"{"type":"message","role":"user","content":"Element: <button>"}"#,
            "\n",
            r#"{"type":"message","role":"assistant","content":"{\"variants\":","delta":true}"#,
            "\n",
            r#"{"type":"message","role":"assistant","content":"[]}","delta":true}"#,
            "\n",
            r#"{"type":"result","status":"success","stats":{}}"#
        );

        let (_, finished) = replay(lines);

        assert_eq!(finished.expect("done").expect("text"), r#"{"variants":[]}"#);
    }

    #[test]
    fn widget_runs_deny_every_tool_and_load_no_mcp_servers_or_extensions() {
        let request = GenerationRequest {
            model: None,
            system_prompt: "Be brief.".to_owned(),
            user_prompt: "Element: <button>".to_owned(),
            images: Vec::new(),
            tools: ToolPolicy::None,
            timeout: Duration::from_secs(60),
            cwd: PathBuf::from("."),
            events: None,
        };
        let policy = Path::new("/tmp/guijam-policy.toml");
        let none = args(&request, policy);
        let read_only = args(
            &GenerationRequest {
                tools: ToolPolicy::ReadOnly,
                ..request
            },
            policy,
        );

        let after = |run: &[String], flag: &str| {
            run.iter()
                .position(|arg| arg == flag)
                .map(|index| run[index + 1].clone())
        };
        for run in [&none, &read_only] {
            assert_eq!(after(run, "-o").as_deref(), Some("stream-json"));
            assert_eq!(after(run, "-e").as_deref(), Some("none"));
            assert_eq!(
                after(run, "--allowed-mcp-server-names").as_deref(),
                Some("guijam-none")
            );
        }
        assert_eq!(
            after(&none, "--admin-policy").as_deref(),
            Some("/tmp/guijam-policy.toml")
        );
        assert_eq!(
            after(&read_only, "--approval-mode").as_deref(),
            Some("plan")
        );
        assert!(super::DENY_ALL_POLICY.contains("toolName = \"*\""));
    }
}
