mod claude_code;
mod codex;
mod error;
mod gemini_cli;
mod opencode;
mod process;
mod qwen_code;
mod schema;
#[cfg(any(windows, test))]
mod shim;
pub mod spawn;
mod text_answer;

use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use async_trait::async_trait;
use gjd_core::contracts::VariantSet;
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

pub use claude_code::ClaudeCode;
pub use codex::Codex;
pub use error::ProviderError;
pub use gemini_cli::GeminiCli;
pub use opencode::OpenCode;
pub use qwen_code::QwenCode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderId {
    ClaudeCode,
    Codex,
    OpenCode,
    QwenCode,
    GeminiCli,
}

impl ProviderId {
    pub const ALL: [Self; 5] = [
        Self::ClaudeCode,
        Self::Codex,
        Self::OpenCode,
        Self::QwenCode,
        Self::GeminiCli,
    ];

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
            Self::QwenCode => "qwen-code",
            Self::GeminiCli => "gemini-cli",
        }
    }

    #[must_use]
    pub fn display_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
            Self::OpenCode => "OpenCode",
            Self::QwenCode => "Qwen Code",
            Self::GeminiCli => "Gemini CLI",
        }
    }

    #[must_use]
    pub fn fast_model(self) -> Option<&'static str> {
        match self {
            Self::ClaudeCode => Some("haiku"),
            Self::Codex => Some("gpt-6-luna"),
            Self::OpenCode | Self::QwenCode | Self::GeminiCli => None,
        }
    }

    #[must_use]
    pub fn standard_model(self) -> Option<&'static str> {
        match self {
            Self::ClaudeCode => Some("sonnet"),
            Self::Codex | Self::OpenCode | Self::QwenCode | Self::GeminiCli => None,
        }
    }

    #[must_use]
    pub fn install_command(self) -> &'static str {
        match self {
            Self::ClaudeCode => "npm install -g @anthropic-ai/claude-code",
            Self::Codex => "npm install -g @openai/codex",
            Self::OpenCode => "npm install -g opencode-ai",
            Self::QwenCode => "npm install -g @qwen-code/qwen-code",
            Self::GeminiCli => "npm install -g @google/gemini-cli",
        }
    }
}

impl fmt::Display for ProviderId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ProviderId {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|id| id.as_str() == value)
            .ok_or_else(|| {
                let known: Vec<&str> = Self::ALL.iter().map(|id| id.as_str()).collect();
                format!(
                    "unknown provider `{value}` (expected one of {})",
                    known.join(", ")
                )
            })
    }
}

#[derive(Clone, Debug)]
pub struct Discovery {
    pub binary: PathBuf,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub images: bool,
    pub free: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthStatus {
    LoggedIn,
    NotLoggedIn { login_command: &'static str },
    Unknown { reason: String },
}

impl fmt::Display for AuthStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LoggedIn => f.write_str("logged in"),
            Self::NotLoggedIn { login_command } => {
                write!(f, "not logged in (run `{login_command}`)")
            }
            Self::Unknown { reason } => write!(f, "login status unknown: {reason}"),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Capabilities {
    pub structured_output: bool,
    pub image_input: bool,
    pub tool_restriction: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolPolicy {
    None,
    ReadOnly,
}

#[derive(Clone, Debug)]
pub struct ImageInput {
    pub media_type: String,
    pub base64: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderEvent {
    Started,
    Ready,
    Writing { bytes: usize },
    Retrying(String),
}

#[derive(Clone, Debug)]
pub struct GenerationRequest {
    pub model: Option<String>,
    pub system_prompt: String,
    pub user_prompt: String,
    pub images: Vec<ImageInput>,
    pub tools: ToolPolicy,
    pub timeout: Duration,
    pub cwd: PathBuf,
    pub events: Option<UnboundedSender<ProviderEvent>>,
}

impl GenerationRequest {
    pub fn emit(&self, event: ProviderEvent) {
        if let Some(events) = &self.events {
            let _ = events.send(event);
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct RunTimings {
    pub ready: Option<Duration>,
    pub answer: Duration,
}

#[derive(Clone, Debug)]
pub struct GenerationOutput {
    pub variant_set: VariantSet,
    pub timings: RunTimings,
    pub cost_usd: Option<f64>,
}

#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    fn id(&self) -> ProviderId;

    async fn discover(&self) -> Result<Discovery, ProviderError>;

    async fn check_auth(&self, discovery: &Discovery) -> AuthStatus;

    fn capabilities(&self) -> Capabilities;

    async fn models(&self, _discovery: &Discovery) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(Vec::new())
    }

    async fn generate(
        &self,
        discovery: &Discovery,
        request: GenerationRequest,
        cancel: CancellationToken,
    ) -> Result<GenerationOutput, ProviderError>;
}

#[must_use]
pub fn adapter(id: ProviderId) -> Option<Box<dyn ProviderAdapter>> {
    match id {
        ProviderId::ClaudeCode => Some(Box::new(ClaudeCode)),
        ProviderId::Codex => Some(Box::new(Codex)),
        ProviderId::OpenCode => Some(Box::new(OpenCode)),
        ProviderId::QwenCode => Some(Box::new(QwenCode)),
        ProviderId::GeminiCli => Some(Box::new(GeminiCli)),
    }
}
