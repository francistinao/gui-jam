use base64::Engine as _;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use serde::Deserialize;
use url::Url;

const PREFIX: &str = "gjp_";
const VERSION: u64 = 1;
const MIN_TOKEN: usize = 32;
const MAX_TOKEN: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PairingError {
    #[error("That isn't a GUIJam pairing code. Copy the whole code from the GUIJam panel in Jira.")]
    Malformed,
    #[error("This pairing code is from a newer GUIJam for Jira. Update GUIJam, then pair again.")]
    Version,
    #[error("The pairing code points somewhere GUIJam won't send your token: {0}")]
    Address(String),
}

#[derive(Deserialize)]
struct Payload {
    v: u64,
    url: String,
    token: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct Pairing {
    pub url: String,
    pub token: String,
}

impl std::fmt::Debug for Pairing {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Pairing")
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

pub fn decode(code: &str) -> Result<Pairing, PairingError> {
    let encoded = code
        .trim()
        .strip_prefix(PREFIX)
        .ok_or(PairingError::Malformed)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded.trim_end_matches('='))
        .or_else(|_| URL_SAFE.decode(encoded))
        .map_err(|_| PairingError::Malformed)?;
    let payload: Payload = serde_json::from_slice(&bytes).map_err(|_| PairingError::Malformed)?;
    if payload.v != VERSION {
        return Err(PairingError::Version);
    }
    let token_ok = (MIN_TOKEN..=MAX_TOKEN).contains(&payload.token.len())
        && payload
            .token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if !token_ok {
        return Err(PairingError::Malformed);
    }
    check_url(&payload.url)?;
    Ok(Pairing {
        url: payload.url,
        token: payload.token,
    })
}

pub fn check_url(raw: &str) -> Result<Url, PairingError> {
    let url = Url::parse(raw).map_err(|_| PairingError::Malformed)?;
    let loopback = matches!(
        url.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    );
    match url.scheme() {
        "https" => Ok(url),
        "http" if loopback => Ok(url),
        other => Err(PairingError::Address(format!(
            "{other}://{}",
            url.host_str().unwrap_or("")
        ))),
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    use super::{PairingError, decode};

    const TOKEN: &str = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd";

    fn code(json: &str) -> String {
        format!("gjp_{}", URL_SAFE_NO_PAD.encode(json))
    }

    #[test]
    fn decodes_a_code_from_the_jira_panel() {
        let pairing = decode(&code(&format!(
            r#"{{"v":1,"url":"https://abc.webtrigger.atlassian.app/public/xyz","token":"{TOKEN}"}}"#
        )))
        .expect("decodes");
        assert_eq!(
            pairing.url,
            "https://abc.webtrigger.atlassian.app/public/xyz"
        );
        assert_eq!(pairing.token, TOKEN);
        assert!(
            decode(&format!(
                "  {}\n",
                code(&format!(
                    r#"{{"v":1,"url":"http://127.0.0.1:4000/x","token":"{TOKEN}"}}"#
                ))
            ))
            .is_ok()
        );
    }

    #[test]
    fn refuses_bad_codes_old_versions_and_plain_http() {
        assert_eq!(decode("hello"), Err(PairingError::Malformed));
        assert_eq!(decode("gjp_!!!"), Err(PairingError::Malformed));
        assert_eq!(
            decode(&code(&format!(
                r#"{{"v":2,"url":"https://a.b/x","token":"{TOKEN}"}}"#
            ))),
            Err(PairingError::Version)
        );
        assert_eq!(
            decode(&code(r#"{"v":1,"url":"https://a.b/x","token":"short"}"#)),
            Err(PairingError::Malformed)
        );
        assert!(matches!(
            decode(&code(&format!(
                r#"{{"v":1,"url":"http://evil.example/x","token":"{TOKEN}"}}"#
            ))),
            Err(PairingError::Address(_))
        ));
    }
}
