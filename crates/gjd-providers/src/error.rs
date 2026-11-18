use std::time::Duration;

use crate::ProviderId;

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("{0} is not installed")]
    NotInstalled(ProviderId),
    #[error("{provider} refused the request{}; run `{login_command}` in a terminal, then retry", said(.detail.as_deref()))]
    NotAuthenticated {
        provider: ProviderId,
        login_command: &'static str,
        detail: Option<String>,
    },
    #[error("the provider is rate limited")]
    RateLimited,
    #[error("the provider is overloaded")]
    Overloaded,
    #[error("no answer within {0:?}")]
    Timeout(Duration),
    #[error("cancelled")]
    Cancelled,
    #[error("the model's answer was not a valid variant set: {0}")]
    InvalidOutput(String),
    #[error("the provider exited without an answer (exit code {exit_code:?}): {stderr_tail}")]
    Crashed {
        exit_code: Option<i32>,
        stderr_tail: String,
    },
    #[error("the provider reported an error: {0}")]
    Failed(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

fn said(detail: Option<&str>) -> String {
    detail
        .map(str::trim)
        .filter(|detail| !detail.is_empty())
        .map_or_else(String::new, |detail| format!(" ({detail})"))
}
