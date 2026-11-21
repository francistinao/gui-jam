use std::io::Read as _;
use std::time::Duration;

use gjd_core::contracts::{
    BridgeErrorCode, BridgeImage, BridgePosted, BridgeTicket, BridgeTicketPage, BridgeWhoami,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use url::Url;

use super::pairing;

const USER_AGENT: &str = "GUIJam tracker client";
const PROTOCOL: &str = "1";
const READ_LIMIT: u64 = 24 * 1024 * 1024;
pub const QUICK: Duration = Duration::from_secs(8);
pub const NORMAL: Duration = Duration::from_secs(20);
pub const POST: Duration = Duration::from_secs(50);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BridgeFailure {
    #[error("Jira no longer accepts this pairing.")]
    Unauthorized,
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    NotFound(String),
    #[error("Jira is busy right now.")]
    RateLimited,
    #[error("The screenshots are too large to post to Jira.")]
    TooLarge,
    #[error("{0}")]
    Rejected(String),
    #[error("Jira said: {0}")]
    Jira(String),
    #[error("Jira didn't answer in time.")]
    Timeout,
    #[error("Can't reach Jira: {0}")]
    Network(String),
    #[error("The GUIJam for Jira app answered with something GUIJam can't read.")]
    Unreadable,
}

impl BridgeFailure {
    #[must_use]
    pub fn action(&self) -> Option<&'static str> {
        match self {
            Self::Unauthorized => Some(
                "Pair again: open any ticket's GUIJam panel in Jira, then run npx guijam jira pair <code>.",
            ),
            Self::RateLimited => Some("Wait a minute, then try again."),
            Self::TooLarge => Some("Turn off screenshots for this post, or try a smaller page."),
            Self::Timeout | Self::Network(_) => Some("Check your connection, then try again."),
            Self::Unreadable => Some("Update GUIJam and ask your Jira admin to update the app."),
            Self::Forbidden(_) | Self::NotFound(_) | Self::Rejected(_) | Self::Jira(_) => None,
        }
    }
}

#[derive(Clone)]
pub struct Bridge {
    url: Url,
    token: String,
}

impl std::fmt::Debug for Bridge {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Bridge").finish_non_exhaustive()
    }
}

impl Bridge {
    pub fn new(url: &str, token: String) -> Result<Self, BridgeFailure> {
        let url =
            pairing::check_url(url).map_err(|error| BridgeFailure::Rejected(error.to_string()))?;
        Ok(Self { url, token })
    }

    fn endpoint(&self, path: &str, query: &[(&str, &str)]) -> Url {
        let mut url = self.url.clone();
        let joined = format!("{}{path}", url.path().trim_end_matches('/'));
        url.set_path(&joined);
        url.set_query(None);
        if !query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in query {
                pairs.append_pair(key, value);
            }
        }
        url
    }

    fn call<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
        timeout: Duration,
    ) -> Result<T, BridgeFailure> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .max_redirects(0)
            .http_status_as_error(false)
            .user_agent(USER_AGENT)
            .timeout_global(Some(timeout))
            .build()
            .into();
        let url = self.endpoint(path, query);
        let bearer = format!("Bearer {}", self.token);
        let sent = match body {
            Some(body) => agent
                .post(url.as_str())
                .header("Authorization", &bearer)
                .header("X-GUIJam-Version", PROTOCOL)
                .header("Content-Type", "application/json")
                .send(serde_json::to_vec(body).map_err(|_| BridgeFailure::Unreadable)?),
            None => agent
                .get(url.as_str())
                .header("Authorization", &bearer)
                .header("X-GUIJam-Version", PROTOCOL)
                .call(),
        };
        let mut response = sent.map_err(network)?;
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(READ_LIMIT)
            .read_to_end(&mut bytes)
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::TimedOut => BridgeFailure::Timeout,
                _ => BridgeFailure::Network(error.kind().to_string()),
            })?;
        answer(status, &bytes)
    }

    pub fn whoami(&self, timeout: Duration) -> Result<BridgeWhoami, BridgeFailure> {
        self.call("/v1/whoami", &[], None, timeout)
    }

    pub fn unpair(&self) -> Result<Value, BridgeFailure> {
        self.call("/v1/unpair", &[], Some(&json!({})), QUICK)
    }

    pub fn search(&self, preset: &str, query: &str) -> Result<BridgeTicketPage, BridgeFailure> {
        self.call(
            "/v1/tickets",
            &[("preset", preset), ("q", query)],
            None,
            NORMAL,
        )
    }

    pub fn ticket(&self, key: &str) -> Result<BridgeTicket, BridgeFailure> {
        self.call(&format!("/v1/tickets/{key}"), &[], None, NORMAL)
    }

    pub fn attachment(&self, key: &str, id: &str) -> Result<BridgeImage, BridgeFailure> {
        self.call(
            &format!("/v1/tickets/{key}/attachments/{id}"),
            &[],
            None,
            NORMAL,
        )
    }

    pub fn start(&self, key: &str, body: &Value) -> Result<Value, BridgeFailure> {
        self.call(&format!("/v1/tickets/{key}/start"), &[], Some(body), NORMAL)
    }

    pub fn result(&self, key: &str, body: &Value) -> Result<BridgePosted, BridgeFailure> {
        self.call(&format!("/v1/tickets/{key}/result"), &[], Some(body), POST)
    }

    pub fn reverted(&self, key: &str, journal_id: &str) -> Result<Value, BridgeFailure> {
        self.call(
            &format!("/v1/tickets/{key}/reverted"),
            &[],
            Some(&json!({ "journalId": journal_id })),
            NORMAL,
        )
    }

    pub fn create(&self, body: &Value) -> Result<BridgePosted, BridgeFailure> {
        self.call("/v1/tickets", &[], Some(body), POST)
    }
}

fn network(error: ureq::Error) -> BridgeFailure {
    match error {
        ureq::Error::Timeout(_) => BridgeFailure::Timeout,
        ureq::Error::Io(error) if error.kind() == std::io::ErrorKind::TimedOut => {
            BridgeFailure::Timeout
        }
        ureq::Error::Io(error) => BridgeFailure::Network(error.kind().to_string()),
        ureq::Error::HostNotFound => BridgeFailure::Network("the host wasn't found".to_owned()),
        ureq::Error::ConnectionFailed => BridgeFailure::Network("the connection failed".to_owned()),
        _ => BridgeFailure::Network("the request failed".to_owned()),
    }
}

fn answer<T: DeserializeOwned>(status: u16, bytes: &[u8]) -> Result<T, BridgeFailure> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| match status {
        401 => BridgeFailure::Unauthorized,
        429 => BridgeFailure::RateLimited,
        413 => BridgeFailure::TooLarge,
        _ => BridgeFailure::Unreadable,
    })?;
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        let data = value.get("data").cloned().unwrap_or(Value::Null);
        return serde_json::from_value(data).map_err(|_| BridgeFailure::Unreadable);
    }
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("The request failed.")
        .to_owned();
    let code = value
        .get("code")
        .cloned()
        .and_then(|code| serde_json::from_value::<BridgeErrorCode>(code).ok());
    Err(match code {
        Some(BridgeErrorCode::Unauthorized) => BridgeFailure::Unauthorized,
        Some(BridgeErrorCode::Forbidden) => BridgeFailure::Forbidden(message),
        Some(BridgeErrorCode::NotFound) => BridgeFailure::NotFound(message),
        Some(BridgeErrorCode::RateLimited) => BridgeFailure::RateLimited,
        Some(BridgeErrorCode::TooLarge) => BridgeFailure::TooLarge,
        Some(BridgeErrorCode::InvalidRequest) => BridgeFailure::Rejected(message),
        Some(BridgeErrorCode::JiraError | BridgeErrorCode::Internal) => {
            BridgeFailure::Jira(message)
        }
        None => match status {
            401 => BridgeFailure::Unauthorized,
            429 => BridgeFailure::RateLimited,
            _ => BridgeFailure::Unreadable,
        },
    })
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead as _, BufReader, Read as _, Write as _};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use serde_json::json;

    use super::{Bridge, BridgeFailure};

    const TOKEN: &str = "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

    struct Seen {
        line: String,
        headers: Vec<String>,
        body: String,
    }

    fn serve(status: u16, body: &'static str, delay: Duration) -> (String, mpsc::Receiver<Seen>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (sender, seen) = mpsc::channel();
        thread::spawn(move || {
            let Ok((stream, _)) = listener.accept() else {
                return;
            };
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));
            let mut line = String::new();
            reader.read_line(&mut line).expect("line");
            let mut headers = Vec::new();
            let mut length = 0usize;
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).expect("header");
                let header = header.trim_end().to_owned();
                if header.is_empty() {
                    break;
                }
                if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().expect("length");
                }
                headers.push(header);
            }
            let mut sent = vec![0u8; length];
            reader.read_exact(&mut sent).expect("body");
            let _ = sender.send(Seen {
                line: line.trim_end().to_owned(),
                headers,
                body: String::from_utf8_lossy(&sent).into_owned(),
            });
            thread::sleep(delay);
            let mut stream = stream;
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
        });
        (format!("http://127.0.0.1:{port}/public/trigger"), seen)
    }

    #[test]
    fn sends_the_token_only_as_a_bearer_header_and_reads_the_data() {
        let (url, seen) = serve(
            200,
            r#"{"ok":true,"data":{"accountId":"a1","displayName":"Francis","site":"acme.atlassian.net","url":"https://acme.atlassian.net","projects":[{"key":"WEB","name":"Web"}]}}"#,
            Duration::ZERO,
        );
        let bridge = Bridge::new(&url, TOKEN.to_owned()).expect("bridge");
        let whoami = bridge.whoami(Duration::from_secs(5)).expect("whoami");
        assert_eq!(whoami.display_name, "Francis");
        let request = seen.recv().expect("request");
        assert_eq!(request.line, "GET /public/trigger/v1/whoami HTTP/1.1");
        assert!(
            request
                .headers
                .iter()
                .any(|header| header == &format!("authorization: Bearer {TOKEN}")
                    || header == &format!("Authorization: Bearer {TOKEN}"))
        );
        assert!(!request.line.contains(TOKEN));
    }

    #[test]
    fn posts_json_with_the_query_encoded() {
        let (url, seen) = serve(200, r#"{"ok":true,"data":{"tickets":[]}}"#, Duration::ZERO);
        let bridge = Bridge::new(&url, TOKEN.to_owned()).expect("bridge");
        bridge.search("assigned", "pill & blue").expect("search");
        assert_eq!(
            seen.recv().expect("request").line,
            "GET /public/trigger/v1/tickets?preset=assigned&q=pill+%26+blue HTTP/1.1"
        );
        let (url, seen) = serve(200, r#"{"ok":true,"data":{}}"#, Duration::ZERO);
        let bridge = Bridge::new(&url, TOKEN.to_owned()).expect("bridge");
        bridge
            .start(
                "WEB-1",
                &json!({"pageUrl": "http://localhost:5173/", "src": "src/App.tsx:1:1"}),
            )
            .expect("start");
        let request = seen.recv().expect("request");
        assert_eq!(
            request.line,
            "POST /public/trigger/v1/tickets/WEB-1/start HTTP/1.1"
        );
        assert!(
            request
                .body
                .contains("\"pageUrl\":\"http://localhost:5173/\"")
        );
    }

    #[test]
    fn maps_bridge_errors_and_never_puts_the_token_in_them() {
        let cases: [(u16, &'static str, BridgeFailure); 5] = [
            (
                401,
                r#"{"ok":false,"code":"UNAUTHORIZED","message":"no"}"#,
                BridgeFailure::Unauthorized,
            ),
            (
                403,
                r#"{"ok":false,"code":"FORBIDDEN","message":"You can't edit WEB-1."}"#,
                BridgeFailure::Forbidden("You can't edit WEB-1.".to_owned()),
            ),
            (
                429,
                r#"{"ok":false,"code":"RATE_LIMITED","message":"slow"}"#,
                BridgeFailure::RateLimited,
            ),
            (500, "<html>", BridgeFailure::Unreadable),
            (401, "Unauthorized", BridgeFailure::Unauthorized),
        ];
        for (status, body, expected) in cases {
            let (url, _seen) = serve(status, body, Duration::ZERO);
            let bridge = Bridge::new(&url, TOKEN.to_owned()).expect("bridge");
            let error = bridge.whoami(Duration::from_secs(5)).expect_err("fails");
            assert_eq!(error, expected);
            assert!(!error.to_string().contains(TOKEN));
            assert!(!format!("{error:?}{bridge:?}").contains(TOKEN));
        }
    }

    #[test]
    fn times_out_and_refuses_plain_http_off_this_machine() {
        let (url, _seen) = serve(200, r#"{"ok":true,"data":{}}"#, Duration::from_secs(3));
        let bridge = Bridge::new(&url, TOKEN.to_owned()).expect("bridge");
        assert_eq!(
            bridge
                .whoami(Duration::from_millis(400))
                .expect_err("times out"),
            BridgeFailure::Timeout
        );
        assert!(matches!(
            Bridge::new("http://jira.example/x", TOKEN.to_owned()),
            Err(BridgeFailure::Rejected(_))
        ));
    }
}
