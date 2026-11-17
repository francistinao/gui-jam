use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::spawn::command;
use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::process::{EventFold, ProviderProcess, Signals, SpawnOptions, run_to_answer};
use crate::text_answer::{TextRun, generate_with_retry};
use crate::{
    AuthStatus, Capabilities, Discovery, GenerationOutput, GenerationRequest, ModelInfo,
    ProviderAdapter, ProviderError, ProviderEvent, ProviderId, RunTimings, ToolPolicy,
};

const BINARY: &str = "opencode";
const LOGIN_COMMAND: &str = "opencode auth login";
const AGENT: &str = "guijam";
const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const FREE_TIER_SINCE: (u64, u64) = (1, 18);
const READ_ONLY_TOOLS: [&str; 3] = ["read", "glob", "grep"];

pub struct OpenCode;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Event {
    StepStart {},
    Text {
        part: TextPart,
    },
    StepFinish {
        part: FinishPart,
    },
    Error {
        error: ErrorBody,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct TextPart {
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
struct FinishPart {
    reason: Option<String>,
    cost: Option<f64>,
}

#[derive(Deserialize)]
struct ErrorBody {
    name: Option<String>,
    data: Option<ErrorData>,
}

#[derive(Deserialize)]
struct ErrorData {
    message: Option<String>,
    #[serde(rename = "statusCode")]
    status_code: Option<u16>,
}

struct Answer {
    text: String,
    cost: Option<f64>,
}

#[derive(Default)]
struct OpenCodeStream {
    ready: Option<Duration>,
    text: String,
    cost: Option<f64>,
    signals: Signals,
}

fn not_authenticated() -> ProviderError {
    ProviderError::NotAuthenticated {
        provider: ProviderId::OpenCode,
        login_command: LOGIN_COMMAND,
    }
}

fn classify(status: Option<u16>, message: &str) -> ProviderError {
    match status {
        Some(401 | 403) => not_authenticated(),
        Some(429) => ProviderError::RateLimited,
        Some(503 | 529) => ProviderError::Overloaded,
        Some(426) => ProviderError::Failed(format!(
            "{message}. Update OpenCode with: npm install -g opencode-ai"
        )),
        _ => ProviderError::Failed(message.to_owned()),
    }
}

fn logged_error(line: &str) -> Option<String> {
    if !line.contains("message=\"stream error\"") {
        return None;
    }
    let start = line.find("error.error=\"")? + "error.error=\"".len();
    let mut message = String::new();
    let mut escaped = false;
    for ch in line[start..].chars() {
        match ch {
            _ if escaped => {
                message.push(ch);
                escaped = false;
            }
            '\\' => escaped = true,
            '"' => break,
            _ => message.push(ch),
        }
    }
    Some(message.trim_start_matches("AI_APICallError: ").to_owned())
}

fn classify_logged(message: &str) -> Option<ProviderError> {
    let lower = message.to_lowercase();
    if lower.contains("usage limit") || lower.contains("rate limit") || lower.contains("429") {
        Some(ProviderError::RateLimited)
    } else if lower.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("api key")
        || lower.contains("authentication")
    {
        Some(not_authenticated())
    } else if lower.contains("model is unavailable")
        || lower.contains("model not found")
        || lower.contains("or newer is required")
    {
        Some(ProviderError::Failed(message.to_owned()))
    } else {
        None
    }
}

impl EventFold for OpenCodeStream {
    type Answer = Answer;

    fn feed(&mut self, line: &str, elapsed: Duration) -> Option<Result<Answer, ProviderError>> {
        if line.trim().is_empty() {
            return None;
        }
        let event = match serde_json::from_str::<Event>(line) {
            Ok(event) => event,
            Err(error) => {
                return Some(Err(ProviderError::InvalidOutput(format!(
                    "unreadable OpenCode event ({error})"
                ))));
            }
        };
        match event {
            Event::StepStart {} => {
                self.ready.get_or_insert(elapsed);
                self.signals.ready();
                None
            }
            Event::Text { part } => {
                self.signals.wrote(part.text.len());
                self.text.push_str(&part.text);
                None
            }
            Event::StepFinish { part } => {
                if let Some(cost) = part.cost {
                    self.cost = Some(self.cost.unwrap_or(0.0) + cost);
                }
                if part.reason.as_deref() == Some("tool-calls") {
                    return None;
                }
                Some(Ok(Answer {
                    text: std::mem::take(&mut self.text),
                    cost: self.cost,
                }))
            }
            Event::Error { error } => {
                let data = error.data.unwrap_or(ErrorData {
                    message: None,
                    status_code: None,
                });
                let message = data
                    .message
                    .or(error.name)
                    .unwrap_or_else(|| "OpenCode reported an error".to_owned());
                Some(Err(classify(data.status_code, &message)))
            }
            Event::Other => None,
        }
    }

    fn feed_stderr(&mut self, line: &str) -> Option<Result<Answer, ProviderError>> {
        logged_error(line)
            .and_then(|message| classify_logged(&message))
            .map(Err)
    }
}

fn agent_config(system_prompt: &str, tools: ToolPolicy) -> String {
    let mut permission = serde_json::Map::new();
    permission.insert("*".to_owned(), json!("deny"));
    if tools == ToolPolicy::ReadOnly {
        for tool in READ_ONLY_TOOLS {
            permission.insert(tool.to_owned(), json!("allow"));
        }
    }
    json!({
        "$schema": "https://opencode.ai/config.json",
        "agent": {
            AGENT: {
                "description": "GUIJam widget runs",
                "mode": "primary",
                "prompt": system_prompt,
                "permission": permission,
            }
        },
        "mcp": {},
        "plugin": [],
        "instructions": [],
        "share": "disabled",
        "autoupdate": false,
    })
    .to_string()
}

fn isolated_env(config_home: &Path) -> Vec<(String, String)> {
    vec![
        (
            "XDG_CONFIG_HOME".to_owned(),
            config_home.display().to_string(),
        ),
        ("OPENCODE_DISABLE_PROJECT_CONFIG".to_owned(), "1".to_owned()),
        ("OPENCODE_DISABLE_CLAUDE_CODE".to_owned(), "1".to_owned()),
        ("OPENCODE_DISABLE_AUTOUPDATE".to_owned(), "1".to_owned()),
        ("NO_COLOR".to_owned(), "1".to_owned()),
    ]
}

fn args(request: &GenerationRequest, images: &[PathBuf]) -> Vec<String> {
    let mut args: Vec<String> = [
        "run",
        request.user_prompt.as_str(),
        "--format",
        "json",
        "--pure",
        "--print-logs",
        "--log-level",
        "ERROR",
        "--agent",
        AGENT,
        "--title",
        "GUIJam",
    ]
    .iter()
    .map(|arg| (*arg).to_owned())
    .collect();
    if let Some(model) = &request.model {
        args.extend(["-m".to_owned(), model.clone()]);
    }
    for image in images {
        args.extend(["-f".to_owned(), image.display().to_string()]);
    }
    args
}

async fn write_images(
    dir: &Path,
    request: &GenerationRequest,
) -> Result<Vec<PathBuf>, ProviderError> {
    let mut paths = Vec::with_capacity(request.images.len());
    for (index, image) in request.images.iter().enumerate() {
        let extension = match image.media_type.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            other => {
                return Err(ProviderError::Failed(format!(
                    "OpenCode can't send {other} images"
                )));
            }
        };
        let bytes = STANDARD
            .decode(&image.base64)
            .map_err(|error| ProviderError::Failed(format!("an image is not base64: {error}")))?;
        let path = dir.join(format!("image-{index}.{extension}"));
        tokio::fs::write(&path, bytes).await?;
        paths.push(path);
    }
    Ok(paths)
}

async fn query(
    binary: &Path,
    args: &[&str],
    env: &[(String, String)],
) -> Result<String, ProviderError> {
    let output = timeout(
        QUERY_TIMEOUT,
        command(binary)
            .args(args)
            .envs(env.iter().cloned())
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| ProviderError::Timeout(QUERY_TIMEOUT))??;
    if !output.status.success() {
        return Err(ProviderError::Failed(format!(
            "`opencode {}` exited with {}",
            args.join(" "),
            output.status
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn strip_ansi(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for code in chars.by_ref() {
                if code.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            plain.push(ch);
        }
    }
    plain
}

fn configured_sources(auth_list: &str) -> Option<u64> {
    let plain = strip_ansi(auth_list);
    let mut total = None;
    for line in plain.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        if let [_, count, kind, ..] = words.as_slice()
            && (kind.starts_with("credential") || *kind == "environment")
            && let Ok(count) = count.parse::<u64>()
        {
            total = Some(total.unwrap_or(0) + count);
        }
    }
    total
}

fn version_at_least(version: &str, (major, minor): (u64, u64)) -> bool {
    let mut parts = version
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0));
    let found = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    found >= (major, minor)
}

fn model_info(id: String, body: &str) -> Option<ModelInfo> {
    let meta = serde_json::from_str::<Value>(body).ok()?;
    if meta.get("status").and_then(Value::as_str) == Some("deprecated") {
        return None;
    }
    let cost = |key: &str| meta["cost"][key].as_f64().unwrap_or(1.0);
    Some(ModelInfo {
        name: meta["name"].as_str().unwrap_or(&id).to_owned(),
        images: meta["capabilities"]["input"]["image"].as_bool() == Some(true),
        free: cost("input") == 0.0 && cost("output") == 0.0,
        id,
    })
}

fn parse_models(verbose: &str) -> Vec<ModelInfo> {
    let mut models = Vec::new();
    let mut current: Option<(String, String)> = None;
    for line in verbose.lines() {
        let is_id = !line.starts_with([' ', '{', '}', '"'])
            && line.contains('/')
            && !line.contains(char::is_whitespace);
        if is_id {
            if let Some((id, body)) = current.take() {
                models.extend(model_info(id, &body));
            }
            current = Some((line.to_owned(), String::new()));
        } else if let Some((_, body)) = current.as_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    if let Some((id, body)) = current.take() {
        models.extend(model_info(id, &body));
    }
    models
}

impl OpenCode {
    async fn list_models(&self, discovery: &Discovery) -> Result<Vec<ModelInfo>, ProviderError> {
        let home = tempfile::tempdir()?;
        let stdout = query(
            &discovery.binary,
            &["models", "--verbose"],
            &isolated_env(home.path()),
        )
        .await?;
        Ok(parse_models(&stdout))
    }

    async fn run_once(
        binary: PathBuf,
        request: GenerationRequest,
        cancel: CancellationToken,
    ) -> Result<TextRun, ProviderError> {
        let started = Instant::now();
        let dir = tempfile::tempdir()?;
        let config_home = dir.path().join("config");
        tokio::fs::create_dir_all(&config_home).await?;
        let images = write_images(dir.path(), &request).await?;
        let mut env = isolated_env(&config_home);
        env.push((
            "OPENCODE_CONFIG_CONTENT".to_owned(),
            agent_config(&request.system_prompt, request.tools),
        ));
        let process = ProviderProcess::spawn_with(
            &binary,
            args(&request, &images),
            &request.cwd,
            b"",
            SpawnOptions {
                env,
                watch_stderr: true,
            },
        )
        .await?;
        request.emit(ProviderEvent::Started);
        let mut stream = OpenCodeStream {
            signals: Signals::new(request.events.clone()),
            ..OpenCodeStream::default()
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
impl ProviderAdapter for OpenCode {
    fn id(&self) -> ProviderId {
        ProviderId::OpenCode
    }

    async fn discover(&self) -> Result<Discovery, ProviderError> {
        let binary =
            which::which(BINARY).map_err(|_| ProviderError::NotInstalled(ProviderId::OpenCode))?;
        let stdout = query(&binary, &["--version"], &[]).await?;
        let version = stdout
            .split_whitespace()
            .next()
            .ok_or_else(|| {
                ProviderError::Failed("`opencode --version` printed nothing".to_owned())
            })?
            .to_owned();
        Ok(Discovery { binary, version })
    }

    async fn check_auth(&self, discovery: &Discovery) -> AuthStatus {
        let env = [("NO_COLOR".to_owned(), "1".to_owned())];
        let listed = match query(&discovery.binary, &["auth", "list"], &env).await {
            Ok(listed) => listed,
            Err(error) => {
                return AuthStatus::Unknown {
                    reason: error.to_string(),
                };
            }
        };
        match configured_sources(&listed) {
            Some(count) if count > 0 => AuthStatus::LoggedIn,
            Some(_) if version_at_least(&discovery.version, FREE_TIER_SINCE) => {
                AuthStatus::Unknown {
                    reason: "no provider key yet, so only OpenCode's free models will answer"
                        .to_owned(),
                }
            }
            Some(_) => AuthStatus::NotLoggedIn {
                login_command: LOGIN_COMMAND,
            },
            None => AuthStatus::Unknown {
                reason: "unreadable `opencode auth list` output".to_owned(),
            },
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            structured_output: false,
            image_input: true,
            tool_restriction: true,
        }
    }

    async fn models(&self, discovery: &Discovery) -> Result<Vec<ModelInfo>, ProviderError> {
        self.list_models(discovery).await
    }

    async fn generate(
        &self,
        discovery: &Discovery,
        request: GenerationRequest,
        cancel: CancellationToken,
    ) -> Result<GenerationOutput, ProviderError> {
        if !request.images.is_empty()
            && let Some(model) = request.model.as_deref()
        {
            let models = self.list_models(discovery).await?;
            if models.iter().any(|info| info.id == model && !info.images) {
                return Err(ProviderError::Failed(format!(
                    "{model} can't read images, so sketches need a model that can. Pick another with: npx guijam init"
                )));
            }
        }
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

    use super::{
        OpenCodeStream, agent_config, args, classify_logged, configured_sources, logged_error,
        parse_models, version_at_least,
    };
    use crate::process::EventFold;
    use crate::{GenerationRequest, ProviderError, ToolPolicy};

    const SUCCESS: &str = include_str!("../tests/fixtures/opencode/1.19.5/success.jsonl");
    const FREE_LIMIT: &str = include_str!("../tests/fixtures/opencode/1.19.5/free-limit.stderr");
    const TOO_OLD: &str =
        include_str!("../tests/fixtures/opencode/1.17.13/free-tier-too-old.jsonl");
    const UNAVAILABLE: &str =
        include_str!("../tests/fixtures/opencode/1.17.13/model-unavailable.jsonl");
    const AUTH_EMPTY: &str = include_str!("../tests/fixtures/opencode/1.19.5/auth-list-empty.txt");
    const AUTH_ENV: &str = include_str!("../tests/fixtures/opencode/1.19.5/auth-list-env.txt");
    const MODELS: &str = include_str!("../tests/fixtures/opencode/1.19.5/models-verbose.txt");

    fn replay(fixture: &str) -> (OpenCodeStream, Option<Result<super::Answer, ProviderError>>) {
        let mut stream = OpenCodeStream::default();
        for (index, line) in fixture.lines().enumerate() {
            let elapsed = Duration::from_millis(100 * (index as u64 + 1));
            if let Some(finished) = stream.feed(line, elapsed) {
                return (stream, Some(finished));
            }
        }
        (stream, None)
    }

    #[test]
    fn collects_the_text_of_the_recorded_run_and_its_cost() {
        let (stream, finished) = replay(SUCCESS);

        let answer = finished.expect("a result").expect("an answer");

        assert_eq!(stream.ready, Some(Duration::from_millis(100)));
        assert_eq!(answer.text, "hi");
        assert_eq!(answer.cost, Some(0.0));
    }

    #[test]
    fn keeps_reading_after_a_step_that_called_tools() {
        let mut stream = OpenCodeStream::default();
        let tool_step = r#"{"type":"step_finish","part":{"reason":"tool-calls","cost":0.001}}"#;
        let text = r#"{"type":"text","part":{"text":"{\"variants\":[]}"}}"#;
        let stop = r#"{"type":"step_finish","part":{"reason":"stop","cost":0.002}}"#;

        assert!(stream.feed(tool_step, Duration::ZERO).is_none());
        assert!(stream.feed(text, Duration::ZERO).is_none());
        let answer = stream
            .feed(stop, Duration::ZERO)
            .expect("finished")
            .expect("answer");

        assert_eq!(answer.text, r#"{"variants":[]}"#);
        assert!((answer.cost.expect("cost") - 0.003).abs() < 1e-9);
    }

    #[test]
    fn maps_recorded_errors_and_the_logged_free_limit() {
        assert!(matches!(
            replay(TOO_OLD).1,
            Some(Err(ProviderError::Failed(message))) if message.contains("npm install -g opencode-ai")
        ));
        assert!(matches!(
            replay(UNAVAILABLE).1,
            Some(Err(ProviderError::Failed(message))) if message.contains("Model is unavailable")
        ));
        let mut stream = OpenCodeStream::default();
        assert!(matches!(
            stream.feed_stderr(FREE_LIMIT.trim()),
            Some(Err(ProviderError::RateLimited))
        ));
        assert!(
            stream
                .feed_stderr("level=ERROR message=\"stream error\" error.error=\"socket hang up\"")
                .is_none()
        );
        assert!(stream.feed_stderr("level=INFO message=init").is_none());
        assert!(matches!(
            classify_logged("AI_APICallError: Invalid API key provided"),
            Some(ProviderError::NotAuthenticated { .. })
        ));
        assert_eq!(
            logged_error(r#"message="stream error" error.error="say \"hi\"" x=1"#).as_deref(),
            Some(r#"say "hi""#)
        );
    }

    #[test]
    fn counts_configured_providers_without_reading_keys() {
        assert_eq!(configured_sources(AUTH_EMPTY), Some(0));
        assert_eq!(configured_sources(AUTH_ENV), Some(1));
        assert_eq!(configured_sources("nothing useful"), None);
        assert!(version_at_least("1.19.5", (1, 18)));
        assert!(!version_at_least("1.17.13", (1, 18)));
    }

    #[test]
    fn lists_models_with_their_image_support() {
        let models = parse_models(MODELS);

        let summary: Vec<(&str, bool)> = models
            .iter()
            .map(|model| (model.id.as_str(), model.images))
            .collect();
        assert_eq!(summary, [("zai/glm-4.6", false), ("zai/glm-4.6v", true)]);
        assert!(models.iter().all(|model| !model.free));
    }

    fn request(tools: ToolPolicy) -> GenerationRequest {
        GenerationRequest {
            model: Some("deepseek/deepseek-chat".to_owned()),
            system_prompt: "Be brief.".to_owned(),
            user_prompt: "Element: <button>".to_owned(),
            images: Vec::new(),
            tools,
            timeout: Duration::from_secs(60),
            cwd: PathBuf::from("."),
            events: None,
        }
    }

    #[test]
    fn widget_runs_use_the_locked_agent_and_put_files_after_the_message() {
        let images = [PathBuf::from("/tmp/image-0.png")];
        let run = args(&request(ToolPolicy::None), &images);

        assert_eq!(run[..2], ["run", "Element: <button>"]);
        for flag in ["--pure", "--print-logs"] {
            assert!(run.iter().any(|arg| arg == flag), "{flag} missing");
        }
        let after = |flag: &str| {
            run.iter()
                .position(|arg| arg == flag)
                .map(|index| run[index + 1].as_str())
        };
        assert_eq!(after("--agent"), Some("guijam"));
        assert_eq!(after("--format"), Some("json"));
        assert_eq!(after("-m"), Some("deepseek/deepseek-chat"));
        assert_eq!(run.last().map(String::as_str), Some("/tmp/image-0.png"));
        assert!(Path::new(&run[run.len() - 1]).is_absolute());
    }

    #[test]
    fn the_agent_denies_every_tool_unless_reading_is_allowed() {
        let locked: serde_json::Value =
            serde_json::from_str(&agent_config("Be brief.", ToolPolicy::None)).expect("json");
        let reading: serde_json::Value =
            serde_json::from_str(&agent_config("Be brief.", ToolPolicy::ReadOnly)).expect("json");

        let agent = &locked["agent"]["guijam"];
        assert_eq!(agent["prompt"], "Be brief.");
        assert_eq!(agent["permission"], serde_json::json!({ "*": "deny" }));
        assert_eq!(locked["mcp"], serde_json::json!({}));
        assert_eq!(reading["agent"]["guijam"]["permission"]["read"], "allow");
        assert_eq!(reading["agent"]["guijam"]["permission"]["*"], "deny");
    }
}
