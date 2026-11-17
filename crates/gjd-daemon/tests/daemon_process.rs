use std::fmt::Write as _;
use std::fs;
use std::io::{Read, Write as _};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command, Output};
use std::thread::sleep;
use std::time::{Duration, Instant};

use gjd_daemon::run_dir::{DaemonInfo, RunDir};

const WAIT: Duration = Duration::from_secs(10);

struct DaemonProcess(Child);

impl Drop for DaemonProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn gjd(args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_gjd"));
    command.args(args);
    command
}

fn project() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp project");
    fs::create_dir_all(dir.path().join("src")).expect("src dir");
    dir
}

fn start(project: &Path, idle_seconds: &str) -> (DaemonProcess, DaemonInfo) {
    let project_arg = project.to_str().expect("utf-8 temp path");
    let child = gjd(&[
        "daemon",
        "run",
        "--project",
        project_arg,
        "--idle-seconds",
        idle_seconds,
    ])
    .spawn()
    .expect("spawn gjd");
    let process = DaemonProcess(child);
    let run_dir = RunDir::of(project);
    let deadline = Instant::now() + WAIT;
    loop {
        if let Ok(info) = run_dir.read_info() {
            return (process, info);
        }
        assert!(Instant::now() < deadline, "daemon.json never appeared");
        sleep(Duration::from_millis(25));
    }
}

fn upgrade_status(port: u16, host: &str, extra_headers: &[(&str, &str)]) -> u16 {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    let mut request = format!(
        "GET /ws HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
    );
    for (name, value) in extra_headers {
        write!(request, "{name}: {value}\r\n").expect("writing to a String cannot fail");
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).expect("send request");
    let mut response = [0u8; 64];
    let read = stream.read(&mut response).expect("read response");
    let status_line = String::from_utf8_lossy(&response[..read]);
    status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .expect("HTTP status line")
}

fn wait_for_exit(process: &mut DaemonProcess) -> bool {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        if process.0.try_wait().expect("poll child").is_some() {
            return true;
        }
        sleep(Duration::from_millis(25));
    }
    false
}

#[test]
fn admits_only_the_bearer_of_the_token_from_a_loopback_host_without_an_origin() {
    let project = project();
    let (_daemon, info) = start(project.path(), "60");
    let host = format!("127.0.0.1:{}", info.port);
    let bearer = format!("Bearer {}", info.token);

    assert_eq!(upgrade_status(info.port, &host, &[]), 401);
    assert_eq!(
        upgrade_status(info.port, &host, &[("Authorization", "Bearer wrong")]),
        401
    );
    assert_eq!(
        upgrade_status(
            info.port,
            &host,
            &[
                ("Authorization", &bearer),
                ("Origin", "http://localhost:5173")
            ]
        ),
        403
    );
    assert_eq!(
        upgrade_status(
            info.port,
            &format!("attacker.example:{}", info.port),
            &[("Authorization", &bearer)]
        ),
        403
    );
    assert_eq!(
        upgrade_status(info.port, &host, &[("Authorization", &bearer)]),
        101
    );
    assert_eq!(
        upgrade_status(
            info.port,
            &format!("localhost:{}", info.port),
            &[("Authorization", &bearer)]
        ),
        101
    );
}

#[cfg(unix)]
#[test]
fn keeps_its_run_files_private_to_the_owner() {
    use std::os::unix::fs::PermissionsExt;

    let project = project();
    let (_daemon, _info) = start(project.path(), "60");
    let mode = |path: &Path| fs::metadata(path).expect("metadata").permissions().mode() & 0o777;
    let run_dir = project.path().join(".guijam/run");

    assert_eq!(mode(&run_dir), 0o700);
    assert_eq!(mode(&run_dir.join("daemon.json")), 0o600);
}

#[test]
fn serves_each_project_with_one_daemon_that_status_and_stop_control() {
    let project = project();
    let project_arg = project.path().to_str().expect("utf-8 temp path");
    let (mut daemon, info) = start(project.path(), "60");

    let second: Output = gjd(&["daemon", "run", "--project", project_arg])
        .output()
        .expect("run second");
    let status = gjd(&["daemon", "status", "--project", project_arg])
        .output()
        .expect("status");
    let stop = gjd(&["daemon", "stop", "--project", project_arg])
        .output()
        .expect("stop");

    assert!(second.status.success());
    assert!(String::from_utf8_lossy(&second.stderr).contains("already serves"));
    assert!(String::from_utf8_lossy(&status.stdout).contains(&format!("port {}", info.port)));
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    assert!(wait_for_exit(&mut daemon));
    assert!(!project.path().join(".guijam/run/daemon.json").exists());
}

#[test]
fn stops_on_its_own_once_no_client_has_connected_for_the_idle_timeout() {
    let project = project();
    let (mut daemon, _info) = start(project.path(), "1");

    assert!(wait_for_exit(&mut daemon));
    assert!(!project.path().join(".guijam/run/daemon.json").exists());
}
