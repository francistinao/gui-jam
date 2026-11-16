mod claude_code;
mod error;
mod process;

use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use async_trait::async_trait;
use gjd_core::contracts::VariantSet;
use tokio_util::sync::CancellationToken;

pub use claude_code::ClaudeCode;
pub use error::ProviderError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderId {
    ClaudeCode,
    Codex,
}

impl ProviderId {
    pub const ALL: [Self; 2] = [Self::ClaudeCode, Self::Codex];

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
        }
    }

    #[must_use]
    pub fn display_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
        }
    }

    #[must_use]
    pub fn install_command(self) -> &'static str {
        match self {
            Self::ClaudeCode => "npm install -g @anthropic-ai/claude-code",
            Self::Codex => "npm install -g @openai/codex",
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
        match value {
            "claude-code" => Ok(Self::ClaudeCode),
            "codex" => Ok(Self::Codex),
            other => Err(format!(
                "unknown provider `{other}` (expected claude-code or codex)"
            )),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Discovery {
    pub binary: PathBuf,
    pub version: String,
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

#[derive(Clone, Debug)]
pub struct GenerationRequest {
    pub model: Option<String>,
    pub system_prompt: String,
    pub user_prompt: String,
    pub images: Vec<ImageInput>,
    pub tools: ToolPolicy,
    pub timeout: Duration,
    pub cwd: PathBuf,
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
        ProviderId::Codex => None,
    }
}
