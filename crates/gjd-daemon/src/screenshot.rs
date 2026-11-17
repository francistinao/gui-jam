use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use gjd_providers::ImageInput;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::time::{Instant, sleep, timeout_at};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use url::Url;

pub const BROWSER_ENV: &str = "GUIJAM_BROWSER";
pub const WIDTH: u32 = 1280;
pub const HEIGHT: u32 = 960;
const JPEG_QUALITY: u8 = 80;
const LOAD_WAIT: Duration = Duration::from_secs(8);
const CAPTURE_RESERVE: Duration = Duration::from_secs(2);
const SETTLE: Duration = Duration::from_millis(600);
const POLL: Duration = Duration::from_millis(50);
const OFF: [&str; 3] = ["off", "none", "0"];
const MAC_APPS: [&str; 4] = [
    "Google Chrome.app/Contents/MacOS/Google Chrome",
    "Brave Browser.app/Contents/MacOS/Brave Browser",
    "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "Chromium.app/Contents/MacOS/Chromium",
];
const PATH_NAMES: [&str; 6] = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "microsoft-edge",
];
const FLAGS: [&str; 13] = [
    "--headless=new",
    "--use-mock-keychain",
    "--password-store=basic",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-component-update",
    "--disable-background-networking",
    "--disable-sync",
    "--remote-debugging-port=0",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Browser {
    Path(PathBuf),
    Off,
    Missing,
}

#[derive(Debug, thiserror::Error)]
pub enum ShotError {
    #[error("timed out")]
    Timeout,
    #[error("the browser closed before it was ready")]
    Exited,
    #[error("the browser couldn't open the page ({0})")]
    Navigation(String),
    #[error("the browser answered unexpectedly ({0})")]
    Protocol(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

fn protocol(error: impl std::fmt::Display) -> ShotError {
    ShotError::Protocol(error.to_string())
}

#[must_use]
pub fn find_browser() -> Browser {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    find_browser_with(std::env::var_os(BROWSER_ENV), &roots, |name| {
        which::which(name).ok()
    })
}

fn find_browser_with(
    chosen: Option<OsString>,
    roots: &[PathBuf],
    lookup: impl Fn(&str) -> Option<PathBuf>,
) -> Browser {
    if let Some(chosen) = chosen {
        let text = chosen.to_string_lossy().trim().to_owned();
        if text.is_empty() || OFF.contains(&text.to_ascii_lowercase().as_str()) {
            return Browser::Off;
        }
        let path = PathBuf::from(&text);
        return if path.is_file() {
            Browser::Path(path)
        } else {
            lookup(&text).map_or(Browser::Missing, Browser::Path)
        };
    }
    roots
        .iter()
        .flat_map(|root| MAC_APPS.iter().map(move |app| root.join(app)))
        .find(|path| path.is_file())
        .or_else(|| PATH_NAMES.iter().find_map(|name| lookup(name)))
        .map_or(Browser::Missing, Browser::Path)
}

struct Running {
    child: Child,
    group: Option<Pid>,
    profile: tempfile::TempDir,
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(group) = self.group {
            let _ = killpg(group, Signal::SIGKILL);
        }
    }
}

fn launch(binary: &Path) -> Result<Running, ShotError> {
    let profile = tempfile::Builder::new()
        .prefix("guijam-browser-")
        .tempdir()?;
    let child = Command::new(binary)
        .args(FLAGS)
        .arg(format!("--user-data-dir={}", profile.path().display()))
        .arg(format!("--window-size={WIDTH},{HEIGHT}"))
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .process_group(0)
        .spawn()?;
    let group = child
        .id()
        .and_then(|id| i32::try_from(id).ok())
        .map(Pid::from_raw);
    Ok(Running {
        child,
        group,
        profile,
    })
}

async fn devtools_endpoint(running: &mut Running) -> Result<String, ShotError> {
    let file = running.profile.path().join("DevToolsActivePort");
    loop {
        if let Ok(text) = tokio::fs::read_to_string(&file).await {
            let mut lines = text.lines().map(str::trim);
            if let (Some(port), Some(path)) = (lines.next(), lines.next())
                && port.parse::<u16>().is_ok()
                && path.starts_with('/')
            {
                return Ok(format!("ws://127.0.0.1:{port}{path}"));
            }
        }
        if running.child.try_wait()?.is_some() {
            return Err(ShotError::Exited);
        }
        sleep(POLL).await;
    }
}

struct Cdp {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next: u64,
    events: Vec<String>,
}

impl Cdp {
    async fn read(&mut self) -> Result<Value, ShotError> {
        loop {
            match self.socket.next().await {
                Some(Ok(Message::Text(text))) => {
                    let value: Value = serde_json::from_str(text.as_str()).map_err(protocol)?;
                    if let Some(method) = value.get("method").and_then(Value::as_str) {
                        self.events.push(method.to_owned());
                    }
                    return Ok(value);
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => return Err(protocol(error)),
                None => return Err(protocol("the connection closed")),
            }
        }
    }

    async fn send(
        &mut self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<u64, ShotError> {
        self.next += 1;
        let mut message = json!({ "id": self.next, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        self.socket
            .send(Message::Text(message.to_string().into()))
            .await
            .map_err(protocol)?;
        Ok(self.next)
    }

    async fn call(
        &mut self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value, ShotError> {
        let id = self.send(method, params, session).await?;
        loop {
            let reply = self.read().await?;
            if reply.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = reply.get("error") {
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("error");
                return Err(ShotError::Protocol(format!("{method}: {message}")));
            }
            return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    async fn wait_for(&mut self, event: &str, limit: Duration) {
        let deadline = Instant::now() + limit;
        while !self.events.iter().any(|seen| seen == event) {
            if !matches!(timeout_at(deadline, self.read()).await, Ok(Ok(_))) {
                return;
            }
        }
    }
}

fn text_field(value: &Value, field: &str) -> Result<String, ShotError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| protocol(format!("no {field}")))
}

async fn shoot(
    running: &mut Running,
    url: &Url,
    deadline: Instant,
) -> Result<ImageInput, ShotError> {
    let endpoint = devtools_endpoint(running).await?;
    let (socket, _) = tokio_tungstenite::connect_async(endpoint.as_str())
        .await
        .map_err(protocol)?;
    let mut cdp = Cdp {
        socket,
        next: 0,
        events: Vec::new(),
    };
    let target = cdp
        .call("Target.createTarget", json!({ "url": "about:blank" }), None)
        .await?;
    let target_id = text_field(&target, "targetId")?;
    let attached = cdp
        .call(
            "Target.attachToTarget",
            json!({ "targetId": target_id, "flatten": true }),
            None,
        )
        .await?;
    let session = text_field(&attached, "sessionId")?;
    cdp.call("Page.enable", json!({}), Some(&session)).await?;
    cdp.call(
        "Emulation.setDeviceMetricsOverride",
        json!({ "width": WIDTH, "height": HEIGHT, "deviceScaleFactor": 1, "mobile": false }),
        Some(&session),
    )
    .await?;
    cdp.events.clear();
    let navigated = cdp
        .call(
            "Page.navigate",
            json!({ "url": url.as_str() }),
            Some(&session),
        )
        .await?;
    if let Ok(error) = text_field(&navigated, "errorText") {
        return Err(ShotError::Navigation(error));
    }
    let left = deadline.saturating_duration_since(Instant::now());
    cdp.wait_for(
        "Page.loadEventFired",
        LOAD_WAIT.min(left.saturating_sub(CAPTURE_RESERVE)),
    )
    .await;
    sleep(SETTLE.min(deadline.saturating_duration_since(Instant::now()))).await;
    let shot = cdp
        .call(
            "Page.captureScreenshot",
            json!({ "format": "jpeg", "quality": JPEG_QUALITY }),
            Some(&session),
        )
        .await?;
    let data = text_field(&shot, "data")?;
    let _ = cdp.send("Browser.close", json!({}), None).await;
    Ok(ImageInput {
        media_type: "image/jpeg".to_owned(),
        base64: data,
    })
}

pub async fn capture(binary: &Path, url: &Url, limit: Duration) -> Result<ImageInput, ShotError> {
    let deadline = Instant::now() + limit;
    let mut running = launch(binary)?;
    let result = timeout_at(deadline, shoot(&mut running, url, deadline)).await;
    drop(running);
    result.map_err(|_| ShotError::Timeout)?
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use url::Url;

    use super::{Browser, ShotError, capture, find_browser, find_browser_with};

    fn executable(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(&path, body).expect("write");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    #[test]
    fn picks_the_configured_browser_then_an_installed_app_then_the_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let brave = executable(
            dir.path(),
            "Brave Browser.app/Contents/MacOS/Brave Browser",
            "",
        );
        let roots = [dir.path().join("missing"), dir.path().to_path_buf()];
        let on_path = |name: &str| (name == "chromium").then(|| PathBuf::from("/usr/bin/chromium"));
        let nothing = |_: &str| None;

        for off in ["off", "OFF", "none", "0", "", "  "] {
            assert_eq!(
                find_browser_with(Some(OsString::from(off)), &roots, on_path),
                Browser::Off,
                "{off:?}"
            );
        }
        assert_eq!(
            find_browser_with(Some(brave.clone().into_os_string()), &[], nothing),
            Browser::Path(brave.clone())
        );
        assert_eq!(
            find_browser_with(Some(OsString::from("chromium")), &[], on_path),
            Browser::Path(PathBuf::from("/usr/bin/chromium"))
        );
        assert_eq!(
            find_browser_with(Some(OsString::from("/no/such/browser")), &roots, nothing),
            Browser::Missing
        );
        assert_eq!(
            find_browser_with(None, &roots, on_path),
            Browser::Path(brave)
        );
        assert_eq!(
            find_browser_with(None, &[dir.path().join("missing")], on_path),
            Browser::Path(PathBuf::from("/usr/bin/chromium"))
        );
        assert_eq!(find_browser_with(None, &[], nothing), Browser::Missing);
    }

    #[tokio::test]
    async fn a_browser_that_closes_at_once_is_reported() {
        let dir = tempfile::tempdir().expect("tempdir");
        let browser = executable(dir.path(), "closes", "#!/bin/sh\nexit 3\n");
        let url = Url::parse("http://127.0.0.1:9/").expect("url");

        let error = capture(&browser, &url, Duration::from_secs(5))
            .await
            .expect_err("fails");

        assert!(matches!(error, ShotError::Exited), "{error}");
    }

    #[tokio::test]
    async fn a_browser_that_never_gets_ready_times_out_and_is_stopped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let marker = dir.path().join("pid");
        let browser = executable(
            dir.path(),
            "hangs",
            &format!(
                "#!/bin/sh\nsleep 30 &\necho $! > '{}'\nwait\n",
                marker.display()
            ),
        );
        let url = Url::parse("http://127.0.0.1:9/").expect("url");
        let started = Instant::now();

        let error = capture(&browser, &url, Duration::from_secs(3))
            .await
            .expect_err("fails");

        assert!(matches!(error, ShotError::Timeout), "{error}");
        assert!(started.elapsed() < Duration::from_secs(6));
        let sleeper = std::fs::read_to_string(&marker).expect("pid");
        tokio::time::sleep(Duration::from_millis(200)).await;
        let alive = std::process::Command::new("kill")
            .args(["-0", sleeper.trim()])
            .status()
            .expect("kill -0");
        assert!(
            !alive.success(),
            "the browser's child process is still running"
        );
    }

    #[tokio::test]
    #[ignore = "needs Chrome, Brave, Edge or Chromium installed"]
    async fn live_screenshot_of_a_local_page() {
        let Browser::Path(browser) = find_browser() else {
            panic!("no browser found");
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let page = dir.path().join("page.html");
        std::fs::write(
            &page,
            "<body style='background:#1f6feb'><h1>Probe</h1></body>",
        )
        .expect("page");
        let url = Url::from_file_path(&page).expect("file url");
        let started = Instant::now();

        let image = capture(&browser, &url, Duration::from_secs(20))
            .await
            .expect("screenshot");

        assert_eq!(image.media_type, "image/jpeg");
        assert!(image.base64.starts_with("/9j/"), "{}", &image.base64[..12]);
        eprintln!("{} in {:?}", browser.display(), started.elapsed());
    }
}
