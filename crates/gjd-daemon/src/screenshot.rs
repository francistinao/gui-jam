use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use tokio::sync::Semaphore;

use futures_util::{SinkExt, StreamExt};
use gjd_providers::ImageInput;
use gjd_providers::spawn::{ProcessTree, command};
use serde_json::{Value, json};
use tokio::net::TcpStream;
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
const READ_SETTLE: Duration = Duration::from_millis(1500);
const BROWSERS: usize = 3;
static RUNNING: Semaphore = Semaphore::const_new(BROWSERS);
const READ_PAGE: &str = r#"(() => {
  const top = (map, count) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, count);
  const tally = (map, value) => map.set(value, (map.get(value) || 0) + 1);
  const colors = new Map();
  const fonts = new Map();
  const spacing = new Map();
  for (const element of [...document.querySelectorAll('body *')].slice(0, 1500)) {
    const style = getComputedStyle(element);
    for (const color of [style.color, style.backgroundColor]) {
      if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') tally(colors, color);
    }
    const family = style.fontFamily.split(',')[0].replace(/["']/g, '').trim();
    if (family) tally(fonts, family);
    for (const value of [style.paddingTop, style.paddingLeft, style.rowGap, style.columnGap, style.borderTopLeftRadius]) {
      if (value && value !== '0px' && value !== 'normal') tally(spacing, value);
    }
  }
  const code = [...document.querySelectorAll('pre')].slice(0, 4).map((pre) => {
    const classes = `${pre.className} ${pre.querySelector('code')?.className ?? ''}`;
    const found = /lang(?:uage)?-([\w-]+)/.exec(classes);
    return { language: found ? found[1] : null, text: pre.innerText.slice(0, 2500) };
  });
  return {
    title: document.title,
    headings: [...document.querySelectorAll('h1, h2, h3')].map((heading) => heading.innerText.trim()).filter(Boolean).slice(0, 12),
    text: document.body ? document.body.innerText.slice(0, 6000) : '',
    colors: top(colors, 8).map(([color, count]) => `${color} (${count})`),
    fonts: top(fonts, 4).map(([font]) => font),
    spacing: top(spacing, 8).map(([value, count]) => `${value} (${count})`),
    code,
  };
})()"#;
const POLL: Duration = Duration::from_millis(50);
const OFF: [&str; 3] = ["off", "none", "0"];
const MAC_APPS: [&str; 4] = [
    "Google Chrome.app/Contents/MacOS/Google Chrome",
    "Brave Browser.app/Contents/MacOS/Brave Browser",
    "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "Chromium.app/Contents/MacOS/Chromium",
];
const WINDOWS_ROOTS: [&str; 3] = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"];
const WINDOWS_APPS: [&str; 4] = [
    "Google/Chrome/Application/chrome.exe",
    "BraveSoftware/Brave-Browser/Application/brave.exe",
    "Microsoft/Edge/Application/msedge.exe",
    "Chromium/Application/chrome.exe",
];
const PATH_NAMES: [&str; 9] = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "microsoft-edge",
    "chrome",
    "brave",
    "msedge",
];
const EXIT_WAIT: Duration = Duration::from_secs(2);
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

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct SeenCode {
    pub language: Option<String>,
    pub text: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Seen {
    pub title: String,
    pub headings: Vec<String>,
    pub text: String,
    pub colors: Vec<String>,
    pub fonts: Vec<String>,
    pub spacing: Vec<String>,
    pub code: Vec<SeenCode>,
}

#[derive(Debug)]
pub struct Capture {
    pub image: ImageInput,
    pub seen: Option<Seen>,
}

#[must_use]
pub fn browser_allowed(start: &Url, url: &str) -> bool {
    let Ok(target) = Url::parse(url) else {
        return false;
    };
    match target.scheme() {
        "data" | "blob" => true,
        "http" | "https" => crate::links::hop_allowed(start, &target).is_ok(),
        _ => false,
    }
}

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
    let installed = installed_apps(|name| std::env::var_os(name), cfg!(windows));
    find_browser_with(std::env::var_os(BROWSER_ENV), &installed, |name| {
        which::which(name).ok()
    })
}

fn installed_apps(var: impl Fn(&str) -> Option<OsString>, windows: bool) -> Vec<PathBuf> {
    let (roots, apps): (Vec<PathBuf>, &[&str]) = if windows {
        let roots = WINDOWS_ROOTS
            .iter()
            .filter_map(|name| var(name))
            .filter(|root| !root.is_empty())
            .map(PathBuf::from)
            .collect();
        (roots, &WINDOWS_APPS)
    } else {
        let mut roots = vec![PathBuf::from("/Applications")];
        roots.extend(var("HOME").map(|home| PathBuf::from(home).join("Applications")));
        (roots, &MAC_APPS)
    };
    roots
        .iter()
        .flat_map(|root| apps.iter().map(move |app| root.join(app)))
        .collect()
}

fn find_browser_with(
    chosen: Option<OsString>,
    installed: &[PathBuf],
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
    installed
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .or_else(|| PATH_NAMES.iter().find_map(|name| lookup(name)))
        .map_or(Browser::Missing, Browser::Path)
}

struct Running {
    browser: ProcessTree,
    profile: tempfile::TempDir,
}

impl Running {
    async fn stop(mut self) {
        self.browser.kill();
        let _ = tokio::time::timeout(EXIT_WAIT, self.browser.wait()).await;
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.browser.kill();
    }
}

fn launch(binary: &Path) -> Result<Running, ShotError> {
    let profile = tempfile::Builder::new()
        .prefix("guijam-browser-")
        .tempdir()?;
    let mut browser = command(binary);
    browser
        .args(FLAGS)
        .arg(format!("--user-data-dir={}", profile.path().display()))
        .arg(format!("--window-size={WIDTH},{HEIGHT}"))
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    Ok(Running {
        browser: ProcessTree::spawn(browser)?,
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
        if running.browser.try_wait()?.is_some() {
            return Err(ShotError::Exited);
        }
        sleep(POLL).await;
    }
}

struct Cdp {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next: u64,
    events: Vec<String>,
    start: Url,
}

impl Cdp {
    async fn read(&mut self) -> Result<Value, ShotError> {
        loop {
            match self.socket.next().await {
                Some(Ok(Message::Text(text))) => {
                    let value: Value = serde_json::from_str(text.as_str()).map_err(protocol)?;
                    if let Some(method) = value.get("method").and_then(Value::as_str) {
                        self.events.push(method.to_owned());
                        if method == "Fetch.requestPaused" {
                            self.answer_paused(&value).await?;
                        }
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

    async fn answer_paused(&mut self, event: &Value) -> Result<(), ShotError> {
        let params = event.get("params").cloned().unwrap_or(Value::Null);
        let request_id = text_field(&params, "requestId")?;
        let session = event
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let url = params
            .get("request")
            .and_then(|request| request.get("url"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if browser_allowed(&self.start, url) {
            self.send(
                "Fetch.continueRequest",
                json!({ "requestId": request_id }),
                session.as_deref(),
            )
            .await?;
        } else {
            self.send(
                "Fetch.failRequest",
                json!({ "requestId": request_id, "errorReason": "BlockedByClient" }),
                session.as_deref(),
            )
            .await?;
        }
        Ok(())
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
    read: bool,
) -> Result<Capture, ShotError> {
    let endpoint = devtools_endpoint(running).await?;
    let (socket, _) = tokio_tungstenite::connect_async(endpoint.as_str())
        .await
        .map_err(protocol)?;
    let mut cdp = Cdp {
        socket,
        next: 0,
        events: Vec::new(),
        start: url.clone(),
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
        "Fetch.enable",
        json!({ "patterns": [{ "urlPattern": "*" }] }),
        Some(&session),
    )
    .await?;
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
    let settle = if read { READ_SETTLE } else { SETTLE };
    sleep(settle.min(deadline.saturating_duration_since(Instant::now()))).await;
    let seen = if read {
        let evaluated = cdp
            .call(
                "Runtime.evaluate",
                json!({ "expression": READ_PAGE, "returnByValue": true }),
                Some(&session),
            )
            .await?;
        evaluated
            .get("result")
            .and_then(|result| result.get("value"))
            .and_then(|value| serde_json::from_value(value.clone()).ok())
    } else {
        None
    };
    let shot = cdp
        .call(
            "Page.captureScreenshot",
            json!({ "format": "jpeg", "quality": JPEG_QUALITY }),
            Some(&session),
        )
        .await?;
    let data = text_field(&shot, "data")?;
    let _ = cdp.send("Browser.close", json!({}), None).await;
    Ok(Capture {
        image: ImageInput {
            media_type: "image/jpeg".to_owned(),
            base64: data,
        },
        seen,
    })
}

pub async fn capture(
    binary: &Path,
    url: &Url,
    limit: Duration,
    read: bool,
) -> Result<Capture, ShotError> {
    let deadline = Instant::now() + limit;
    let _turn = timeout_at(deadline, RUNNING.acquire())
        .await
        .map_err(|_| ShotError::Timeout)?
        .map_err(protocol)?;
    let mut running = launch(binary)?;
    let result = timeout_at(deadline, shoot(&mut running, url, deadline, read)).await;
    running.stop().await;
    result.map_err(|_| ShotError::Timeout)?
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use url::Url;

    use super::{
        Browser, MAC_APPS, browser_allowed, capture, find_browser, find_browser_with,
        installed_apps,
    };

    fn executable(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(&path, body).expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        path
    }

    #[test]
    fn a_public_page_cannot_reach_private_addresses_or_other_schemes_in_the_browser() {
        let public = Url::parse("https://93.184.216.34/docs").unwrap();
        let local = Url::parse("http://127.0.0.1:5173/").unwrap();

        assert!(browser_allowed(&public, "https://8.8.8.8/app.js"));
        assert!(browser_allowed(&public, "data:image/png;base64,AA=="));
        assert!(browser_allowed(&public, "blob:https://93.184.216.34/1"));
        assert!(!browser_allowed(&public, "http://127.0.0.1:8080/admin"));
        assert!(!browser_allowed(&public, "http://10.0.0.1/"));
        assert!(!browser_allowed(&public, "http://[::1]/"));
        assert!(!browser_allowed(&public, "file:///etc/passwd"));
        assert!(!browser_allowed(&public, "chrome://settings"));
        assert!(!browser_allowed(&public, "not a url"));
        assert!(browser_allowed(
            &local,
            "http://127.0.0.1:5173/src/main.tsx"
        ));
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
        let roots: Vec<PathBuf> = roots
            .iter()
            .flat_map(|root| MAC_APPS.iter().map(move |app| root.join(app)))
            .collect();
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
            find_browser_with(None, &roots[..MAC_APPS.len()], on_path),
            Browser::Path(PathBuf::from("/usr/bin/chromium"))
        );
        assert_eq!(find_browser_with(None, &[], nothing), Browser::Missing);
    }

    #[test]
    fn looks_for_installed_browsers_where_each_platform_puts_them() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| OsString::from(value))
            }
        };
        let windows = installed_apps(
            env(&[
                ("ProgramFiles", "C:/Program Files"),
                ("ProgramFiles(x86)", ""),
                ("LOCALAPPDATA", "C:/Users/me/AppData/Local"),
                ("HOME", "/home/me"),
            ]),
            true,
        );
        let mac = installed_apps(env(&[("HOME", "/Users/me")]), false);

        assert_eq!(windows.len(), 8);
        assert_eq!(
            windows[0],
            PathBuf::from("C:/Program Files/Google/Chrome/Application/chrome.exe")
        );
        assert!(windows.contains(&PathBuf::from(
            "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
        )));
        assert!(windows.contains(&PathBuf::from(
            "C:/Users/me/AppData/Local/Google/Chrome/Application/chrome.exe"
        )));
        assert_eq!(mac.len(), 2 * MAC_APPS.len());
        assert_eq!(
            mac[MAC_APPS.len()],
            PathBuf::from("/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_browser_that_closes_at_once_is_reported() {
        let dir = tempfile::tempdir().expect("tempdir");
        let browser = executable(dir.path(), "closes", "#!/bin/sh\nexit 3\n");
        let url = Url::parse("http://127.0.0.1:9/").expect("url");

        let error = capture(&browser, &url, Duration::from_secs(5), false)
            .await
            .expect_err("fails");

        assert!(matches!(error, super::ShotError::Exited), "{error}");
    }

    #[cfg(unix)]
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

        let error = capture(&browser, &url, Duration::from_secs(3), false)
            .await
            .expect_err("fails");

        assert!(matches!(error, super::ShotError::Timeout), "{error}");
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

        let image = capture(&browser, &url, Duration::from_secs(20), false)
            .await
            .expect("screenshot");

        assert_eq!(image.image.media_type, "image/jpeg");
        assert!(
            image.image.base64.starts_with("/9j/"),
            "{}",
            &image.image.base64[..12]
        );
        eprintln!("{} in {:?}", browser.display(), started.elapsed());
    }
}
