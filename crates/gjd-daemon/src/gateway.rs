use std::sync::Arc;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use gjd_core::contracts::GuijamMessage;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::daemon::{Daemon, Failure, PluginLink};

#[derive(Clone)]
struct Gateway {
    daemon: Arc<Daemon>,
    token: Arc<str>,
    port: u16,
}

pub async fn serve(
    listener: TcpListener,
    daemon: Arc<Daemon>,
    token: String,
    shutdown: CancellationToken,
) -> std::io::Result<()> {
    let port = listener.local_addr()?.port();
    let gateway = Gateway {
        daemon,
        token: token.into(),
        port,
    };
    let app = Router::new().route("/ws", get(upgrade)).with_state(gateway);
    axum::serve(listener, app)
        .with_graceful_shutdown(async move { shutdown.cancelled().await })
        .await
}

async fn upgrade(
    State(gateway): State<Gateway>,
    headers: HeaderMap,
    socket: WebSocketUpgrade,
) -> Response {
    if let Err(status) = admit(&headers, &gateway) {
        return status.into_response();
    }
    socket.on_upgrade(move |socket| connection(gateway.daemon, socket))
}

fn admit(headers: &HeaderMap, gateway: &Gateway) -> Result<(), StatusCode> {
    let header_text = |name| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
    };
    let host = header_text(header::HOST);
    let port = gateway.port;
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return Err(StatusCode::FORBIDDEN);
    }
    if headers.contains_key(header::ORIGIN) {
        return Err(StatusCode::FORBIDDEN);
    }
    let presented = header_text(header::AUTHORIZATION)
        .strip_prefix("Bearer ")
        .unwrap_or_default();
    if !constant_time_eq(presented.as_bytes(), gateway.token.as_bytes()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(())
}

fn constant_time_eq(presented: &[u8], expected: &[u8]) -> bool {
    presented.len() == expected.len()
        && presented
            .iter()
            .zip(expected)
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

async fn connection(daemon: Arc<Daemon>, mut socket: WebSocket) {
    let (outbox, mut outgoing) = mpsc::unbounded_channel();
    let link = PluginLink::new(outbox);
    daemon.connected();
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => dispatch(&daemon, &link, text.as_str()),
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            Some(message) = outgoing.recv() => {
                let Ok(json) = serde_json::to_string(&message) else { continue };
                if socket.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
            }
        }
    }
    daemon.disconnected(&link);
}

fn dispatch(daemon: &Arc<Daemon>, link: &PluginLink, text: &str) {
    let message = match serde_json::from_str::<GuijamMessage>(text) {
        Ok(message) => message,
        Err(error) => {
            let _ = link.send(
                Failure::invalid_request(format!("unreadable message: {error}")).into_message(None),
            );
            return;
        }
    };
    let daemon = Arc::clone(daemon);
    let link = link.clone();
    tokio::spawn(async move {
        if let Some(reply) = daemon.handle(message, &link).await {
            let _ = link.send(reply);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::constant_time_eq;

    #[test]
    fn compares_tokens_exactly() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abd", b"abc"));
        assert!(!constant_time_eq(b"ab", b"abc"));
        assert!(!constant_time_eq(b"", b"abc"));
    }
}
