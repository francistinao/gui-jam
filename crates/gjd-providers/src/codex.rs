use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use gjd_core::VARIANT_SET_PROVIDER_SCHEMA;
use gjd_core::contracts::VariantSet;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::process::Command;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::process::{EventFold, ProviderProcess, run_to_answer};
use crate::{
    AuthStatus, Capabilities, Discovery, GenerationOutput, GenerationRequest, ImageInput,
    ProviderAdapter, ProviderError, ProviderId, RunTimings, ToolPolicy,
};

const BINARY: &str = "codex";
const LOGIN_COMMAND: &str = "codex login";
const QUERY_TIMEOUT: Duration = Duration::from_secs(10);
const DISABLED_FEATURES: [&str; 4] = ["hooks", "apps", "browser_use", "computer_use"];

pub struct Codex;

struct StrictSchema {
    json: String,
    nullable: BTreeSet<String>,
}

static STRICT_SCHEMA: LazyLock<StrictSchema> =
    LazyLock::new(|| strict_schema(VARIANT_SET_PROVIDER_SCHEMA));

fn strict_schema(source: &str) -> StrictSchema {
    let mut schema: Value =
        serde_json::from_str(source).expect("the provider schema is valid JSON");
    let mut optional = BTreeSet::new();
    let mut required = BTreeSet::new();
    tighten(&mut schema, &mut optional, &mut required);
    StrictSchema {
        json: schema.to_string(),
        nullable: optional.difference(&required).cloned().collect(),
    }
}

fn tighten(node: &mut Value, optional: &mut BTreeSet<String>, required: &mut BTreeSet<String>) {
    match node {
        Value::Array(items) => {
            for item in items {
                tighten(item, optional, required);
            }
        }
        Value::Object(map) => {
            for child in map.values_mut() {
                tighten(child, optional, required);
            }
            if let Some(one_of) = map.remove("oneOf") {
                map.insert("anyOf".to_owned(), one_of);
            }
            require_every_property(map, optional, required);
        }
        _ => {}
    }
}

fn require_every_property(
    map: &mut Map<String, Value>,
    optional: &mut BTreeSet<String>,
    required: &mut BTreeSet<String>,
) {
    let listed: BTreeSet<String> = map
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let Some(Value::Object(properties)) = map.get_mut("properties") else {
        return;
    };
    let mut names = Vec::with_capacity(properties.len());
    for (name, property) in properties.iter_mut() {
        names.push(Value::String(name.clone()));
        if listed.contains(name) {
            required.insert(name.clone());
        } else {
            optional.insert(name.clone());
            let schema = property.take();
            *property = json!({ "anyOf": [schema, { "type": "null" }] });
        }
    }
    map.insert("required".to_owned(), Value::Array(names));
}

fn drop_null_optionals(value: &mut Value, nullable: &BTreeSet<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                drop_null_optionals(item, nullable);
            }
        }
        Value::Object(map) => {
            map.retain(|name, field| !(field.is_null() && nullable.contains(name)));
            for field in map.values_mut() {
                drop_null_optionals(field, nullable);
            }
        }
        _ => {}
    }
}

fn parse_answer(text: &str) -> Result<VariantSet, ProviderError> {
    let mut value: Value = serde_json::from_str(text).map_err(|error| {
        ProviderError::InvalidOutput(format!("the answer is not JSON: {error}"))
    })?;
    drop_null_optionals(&mut value, &STRICT_SCHEMA.nullable);
    serde_json::from_value(value).map_err(|error| ProviderError::InvalidOutput(error.to_string()))
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Event {
    #[serde(rename = "thread.started")]
    ThreadStarted {},
    #[serde(rename = "item.completed")]
    ItemCompleted { item: Item },
    #[serde(rename = "turn.completed")]
    TurnCompleted {},
    #[serde(rename = "turn.failed")]
    TurnFailed { error: EventError },
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Item {
    AgentMessage {
        text: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct EventError {
    message: String,
}

#[derive(Default)]
struct CodexStream {
    ready: Option<Duration>,
    message: Option<String>,
}

impl EventFold for CodexStream {
    type Answer = VariantSet;

    fn feed(&mut self, line: &str, elapsed: Duration) -> Option<Result<VariantSet, ProviderError>> {
        if line.trim().is_empty() {
            return None;
        }
        let event = match serde_json::from_str::<Event>(line) {
            Ok(event) => event,
            Err(error) => {
                return Some(Err(ProviderError::InvalidOutput(format!(
                    "unreadable event: {error}"
                ))));
            }
        };
        match event {
            Event::ThreadStarted {} => {
                self.ready.get_or_insert(elapsed);
                None
            }
            Event::ItemCompleted {
                item: Item::AgentMessage { text },
            } => {
                self.message = Some(text);
                None
            }
            Event::Error { message } if unauthorized(&message) => Some(Err(not_authenticated())),
            Event::TurnFailed { error } => Some(Err(classify(error.message))),
            Event::TurnCompleted {} => Some(self.message.take().map_or_else(
                || {
                    Err(ProviderError::InvalidOutput(
                        "the turn ended without an answer".to_owned(),
                    ))
                },
                |text| parse_answer(&text),
            )),
            Event::ItemCompleted { .. } | Event::Error { .. } | Event::Other => None,
        }
    }
}

fn unauthorized(message: &str) -> bool {
    message.contains("status 401")
}

fn not_authenticated() -> ProviderError {
    ProviderError::NotAuthenticated {
        provider: ProviderId::Codex,
        login_command: LOGIN_COMMAND,
    }
}

fn classify(message: String) -> ProviderError {
    if unauthorized(&message) {
        not_authenticated()
    } else if message.contains("status 429") {
        ProviderError::RateLimited
    } else if message.contains("status 503") || message.contains("status 529") {
        ProviderError::Overloaded
    } else {
        ProviderError::Failed(message)
    }
}

fn toml_string(text: &str) -> String {
    Value::String(text.to_owned()).to_string()
}

fn args(request: &GenerationRequest, schema: &Path, images: &[PathBuf]) -> Vec<String> {
    let mut args: Vec<String> = [
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "-c",
        "web_search=\"disabled\"",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    args.push("-c".to_owned());
    args.push(format!(
        "developer_instructions={}",
        toml_string(&request.system_prompt)
    ));
    args.push("--output-schema".to_owned());
    args.push(schema.display().to_string());
    let disabled = DISABLED_FEATURES
        .iter()
        .chain((request.tools == ToolPolicy::None).then_some(&"shell_tool"));
    for feature in disabled {
        args.push("--disable".to_owned());
        args.push((*feature).to_owned());
    }
    if let Some(model) = &request.model {
        args.push("-m".to_owned());
        args.push(model.clone());
    }
    for image in images {
        args.push("-i".to_owned());
        args.push(image.display().to_string());
    }
    args
}

fn image_extension(media_type: &str) -> Result<&'static str, ProviderError> {
    match media_type {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/webp" => Ok("webp"),
        "image/gif" => Ok("gif"),
        other => Err(ProviderError::Failed(format!(
            "Codex can't read {other} images"
        ))),
    }
}

async fn write_images(dir: &Path, images: &[ImageInput]) -> Result<Vec<PathBuf>, ProviderError> {
    let mut paths = Vec::with_capacity(images.len());
    for (index, image) in images.iter().enumerate() {
        let bytes = STANDARD.decode(&image.base64).map_err(|error| {
            ProviderError::Failed(format!("image {index} is not base64: {error}"))
        })?;
        let path = dir.join(format!(
            "image-{index}.{}",
            image_extension(&image.media_type)?
        ));
        tokio::fs::write(&path, bytes).await?;
        paths.push(path);
    }
    Ok(paths)
}

async fn query(binary: &Path, args: &[&str]) -> Result<Output, ProviderError> {
    timeout(
        QUERY_TIMEOUT,
        Command::new(binary)
            .args(args)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| ProviderError::Timeout(QUERY_TIMEOUT))?
    .map_err(ProviderError::from)
}

#[async_trait]
impl ProviderAdapter for Codex {
    fn id(&self) -> ProviderId {
        ProviderId::Codex
    }

    async fn discover(&self) -> Result<Discovery, ProviderError> {
        let binary =
            which::which(BINARY).map_err(|_| ProviderError::NotInstalled(ProviderId::Codex))?;
        let output = query(&binary, &["--version"]).await?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let version = stdout
            .split_whitespace()
            .last()
            .filter(|_| output.status.success())
            .ok_or_else(|| ProviderError::Failed("`codex --version` printed nothing".to_owned()))?
            .to_owned();
        Ok(Discovery { binary, version })
    }

    async fn check_auth(&self, discovery: &Discovery) -> AuthStatus {
        let output = match query(&discovery.binary, &["login", "status"]).await {
            Ok(output) => output,
            Err(error) => {
                return AuthStatus::Unknown {
                    reason: error.to_string(),
                };
            }
        };
        if output.status.success() {
            return AuthStatus::LoggedIn;
        }
        let said = |stream: &[u8]| String::from_utf8_lossy(stream).contains("Not logged in");
        if said(&output.stdout) || said(&output.stderr) {
            AuthStatus::NotLoggedIn {
                login_command: LOGIN_COMMAND,
            }
        } else {
            AuthStatus::Unknown {
                reason: format!("`codex login status` exited with {}", output.status),
            }
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
        let inputs = tempfile::tempdir()?;
        let schema = inputs.path().join("variant-set.schema.json");
        tokio::fs::write(&schema, &STRICT_SCHEMA.json).await?;
        let images = write_images(inputs.path(), &request.images).await?;
        let process = ProviderProcess::spawn(
            &discovery.binary,
            args(&request, &schema, &images),
            &request.cwd,
            request.user_prompt.as_bytes(),
        )
        .await?;
        let mut stream = CodexStream::default();
        let variant_set =
            run_to_answer(process, &mut stream, request.timeout, &cancel, started).await?;
        Ok(GenerationOutput {
            variant_set,
            timings: RunTimings {
                ready: stream.ready,
                answer: started.elapsed(),
            },
            cost_usd: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use gjd_core::contracts::EditOp;
    use serde_json::{Value, json};

    use super::{CodexStream, STRICT_SCHEMA, args, strict_schema};
    use crate::process::EventFold;
    use crate::{GenerationRequest, ProviderError, ToolPolicy};

    const SUCCESS: &str = include_str!("../tests/fixtures/codex/0.169.0/success.jsonl");
    const NOT_LOGGED_IN: &str = include_str!("../tests/fixtures/codex/0.169.0/not-logged-in.jsonl");
    const SCHEMA_REJECTED: &str =
        include_str!("../tests/fixtures/codex/0.169.0/schema-rejected.jsonl");

    fn replay(
        lines: &str,
    ) -> (
        CodexStream,
        Option<Result<gjd_core::contracts::VariantSet, ProviderError>>,
    ) {
        let mut stream = CodexStream::default();
        let finished = lines
            .lines()
            .enumerate()
            .find_map(|(i, line)| stream.feed(line, Duration::from_millis(100 * (i as u64 + 1))));
        (stream, finished)
    }

    fn request(tools: ToolPolicy) -> GenerationRequest {
        GenerationRequest {
            model: Some("gpt-6-luna".to_owned()),
            system_prompt: "Say \"hi\"\nthen stop.".to_owned(),
            user_prompt: "user".to_owned(),
            images: Vec::new(),
            tools,
            timeout: Duration::from_secs(1),
            cwd: PathBuf::from("."),
        }
    }

    fn flag_values<'a>(args: &'a [String], flag: &str) -> Vec<&'a str> {
        args.windows(2)
            .filter(|pair| pair[0] == flag)
            .map(|pair| pair[1].as_str())
            .collect()
    }

    fn every_object(value: &Value, visit: &mut impl FnMut(&serde_json::Map<String, Value>)) {
        match value {
            Value::Array(items) => items.iter().for_each(|item| every_object(item, visit)),
            Value::Object(map) => {
                visit(map);
                map.values().for_each(|child| every_object(child, visit));
            }
            _ => {}
        }
    }

    #[test]
    fn parses_the_recorded_answer_into_a_variant_set() {
        let (stream, finished) = replay(SUCCESS);

        let variant_set = finished.expect("a result").expect("a valid variant set");

        assert_eq!(stream.ready, Some(Duration::from_millis(100)));
        assert!(variant_set.answer.is_none());
        assert_eq!(variant_set.variants.len(), 1);
        assert!(variant_set.variants[0].assets.is_empty());
        assert!(matches!(
            variant_set.variants[0].ops.as_slice(),
            [EditOp::ClassTokens { .. }]
        ));
    }

    #[test]
    fn stops_at_the_first_unauthorized_error_instead_of_waiting_for_retries() {
        let (_, finished) = replay(NOT_LOGGED_IN);

        assert!(matches!(
            finished,
            Some(Err(ProviderError::NotAuthenticated {
                login_command: "codex login",
                ..
            }))
        ));
    }

    #[test]
    fn reports_a_failed_turn_with_its_message() {
        let (_, finished) = replay(SCHEMA_REJECTED);

        assert!(
            matches!(finished, Some(Err(ProviderError::Failed(message))) if message.contains("Invalid schema"))
        );
    }

    #[test]
    fn maps_rate_limits_and_overload_from_the_failed_turn() {
        let failed = |status: &str| {
            json!({ "type": "turn.failed", "error": { "message": format!("unexpected status {status}") } })
                .to_string()
        };

        assert!(matches!(
            replay(&failed("429 Too Many Requests")).1,
            Some(Err(ProviderError::RateLimited))
        ));
        assert!(matches!(
            replay(&failed("503 Service Unavailable")).1,
            Some(Err(ProviderError::Overloaded))
        ));
    }

    #[test]
    fn rejects_a_completed_turn_without_an_answer_and_lines_that_are_not_events() {
        assert!(matches!(
            replay(r#"{"type":"turn.completed","usage":{}}"#).1,
            Some(Err(ProviderError::InvalidOutput(_)))
        ));
        assert!(matches!(
            replay("Reading prompt from stdin...").1,
            Some(Err(ProviderError::InvalidOutput(_)))
        ));
    }

    #[test]
    fn makes_every_property_required_and_optional_ones_nullable() {
        let strict = strict_schema(
            r#"{"type":"object","required":["a"],"additionalProperties":false,
                "properties":{"a":{"oneOf":[{"type":"string"}]},"b":{"type":"string"}}}"#,
        );
        let schema: Value = serde_json::from_str(&strict.json).expect("json");

        assert_eq!(schema["required"], json!(["a", "b"]));
        assert_eq!(
            schema["properties"]["a"],
            json!({ "anyOf": [{ "type": "string" }] })
        );
        assert_eq!(
            schema["properties"]["b"],
            json!({ "anyOf": [{ "type": "string" }, { "type": "null" }] })
        );
        assert_eq!(strict.nullable.iter().collect::<Vec<_>>(), ["b"]);
    }

    #[test]
    fn the_provider_schema_meets_strict_mode_everywhere() {
        let schema: Value = serde_json::from_str(&STRICT_SCHEMA.json).expect("json");
        every_object(&schema, &mut |map| {
            assert!(!map.contains_key("oneOf"));
            if let Some(Value::Object(properties)) = map.get("properties") {
                let required: Vec<&str> = map["required"]
                    .as_array()
                    .expect("required is listed")
                    .iter()
                    .filter_map(Value::as_str)
                    .collect();
                assert_eq!(
                    required,
                    properties.keys().map(String::as_str).collect::<Vec<_>>()
                );
            }
        });
        assert!(STRICT_SCHEMA.nullable.contains("answer"));
        assert!(!STRICT_SCHEMA.nullable.contains("value"));
    }

    #[test]
    fn widget_runs_are_read_only_ignore_the_developers_config_and_quote_instructions() {
        let schema = Path::new("/tmp/schema.json");
        let images = [PathBuf::from("/tmp/image-0.png")];
        let none = args(&request(ToolPolicy::None), schema, &images);
        let read_only = args(&request(ToolPolicy::ReadOnly), schema, &[]);

        for run in [&none, &read_only] {
            for flag in [
                "--ignore-user-config",
                "--ignore-rules",
                "--ephemeral",
                "--json",
            ] {
                assert!(run.iter().any(|arg| arg == flag), "{flag} missing");
            }
            assert_eq!(flag_values(run, "--sandbox"), ["read-only"]);
            assert_eq!(flag_values(run, "--output-schema"), ["/tmp/schema.json"]);
            assert!(flag_values(run, "--disable").contains(&"hooks"));
        }
        assert!(flag_values(&none, "--disable").contains(&"shell_tool"));
        assert!(!flag_values(&read_only, "--disable").contains(&"shell_tool"));
        assert_eq!(flag_values(&none, "-i"), ["/tmp/image-0.png"]);
        assert_eq!(flag_values(&none, "-m"), ["gpt-6-luna"]);
        assert!(
            flag_values(&none, "-c")
                .contains(&r#"developer_instructions="Say \"hi\"\nthen stop.""#)
        );
    }
}
