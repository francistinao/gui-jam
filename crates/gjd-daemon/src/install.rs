use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::process::Command;
use tokio::time::timeout;

use crate::libraries::{self, MIN_AGE_DAYS, Need};
use crate::project::PackageManager;

pub const LOOKUP_TIMEOUT: Duration = Duration::from_secs(20);
pub const INSTALL_TIMEOUT: Duration = Duration::from_secs(240);
const OUTPUT_LINES: usize = 8;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum InstallError {
    #[error("timed out after {0} s")]
    Timeout(u64),
    #[error("{0}")]
    Failed(String),
}

#[must_use]
pub fn install_args(manager: PackageManager, needs: &[Need]) -> Vec<String> {
    let base: &[&str] = match manager {
        PackageManager::Npm => &["install", "--save-exact"],
        PackageManager::Pnpm => &["add", "--save-exact"],
        PackageManager::Yarn | PackageManager::Bun => &["add", "--exact"],
    };
    base.iter()
        .map(|arg| (*arg).to_owned())
        .chain(
            needs
                .iter()
                .map(|need| format!("{}@{}", need.name, need.version)),
        )
        .collect()
}

#[must_use]
pub fn command_line(manager: PackageManager, needs: &[Need]) -> String {
    format!(
        "{} {}",
        manager.command(),
        install_args(manager, needs).join(" ")
    )
}

fn tail(output: &[u8]) -> String {
    let text = String::from_utf8_lossy(output);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .collect();
    lines[lines.len().saturating_sub(OUTPUT_LINES)..].join("\n")
}

async fn run(command: &mut Command, limit: Duration) -> Result<std::process::Output, InstallError> {
    let output = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output();
    timeout(limit, output)
        .await
        .map_err(|_| InstallError::Timeout(limit.as_secs()))?
        .map_err(|error| InstallError::Failed(error.to_string()))
}

pub async fn lookup(
    npm: &Path,
    name: &str,
    major: Option<u64>,
    today: i64,
    limit: Duration,
) -> Result<String, InstallError> {
    let output = run(
        Command::new(npm).args(["view", name, "time", "--json"]),
        limit,
    )
    .await?;
    if !output.status.success() {
        let reason = tail(&output.stderr);
        return Err(InstallError::Failed(if reason.is_empty() {
            format!("npm view {name} failed")
        } else {
            reason
        }));
    }
    let times: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        InstallError::Failed(format!("npm printed something unexpected ({error})"))
    })?;
    libraries::choose_version(&times, major, today).ok_or_else(|| {
        InstallError::Failed(match major {
            Some(major) => {
                format!("no {name} {major}.x release is at least {MIN_AGE_DAYS} days old")
            }
            None => format!("no {name} release is at least {MIN_AGE_DAYS} days old"),
        })
    })
}

pub async fn install(
    binary: &Path,
    manager: PackageManager,
    needs: &[Need],
    root: &Path,
    limit: Duration,
) -> Result<(), InstallError> {
    let output = run(
        Command::new(binary)
            .args(install_args(manager, needs))
            .current_dir(root),
        limit,
    )
    .await?;
    if output.status.success() {
        return Ok(());
    }
    let mut combined = output.stdout;
    combined.extend_from_slice(&output.stderr);
    let reason = tail(&combined);
    Err(InstallError::Failed(if reason.is_empty() {
        format!("{} exited with {}", manager.command(), output.status)
    } else {
        reason
    }))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use super::{InstallError, command_line, install, install_args, lookup};
    use crate::libraries::Need;
    use crate::project::PackageManager;

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    fn need(name: &str, version: &str) -> Need {
        Need {
            name: name.to_owned(),
            version: version.to_owned(),
        }
    }

    #[test]
    fn builds_exact_install_commands_for_each_package_manager() {
        let needs = [
            need("three", "0.187.0"),
            need("@react-three/fiber", "9.8.2"),
        ];
        assert_eq!(
            command_line(PackageManager::Pnpm, &needs),
            "pnpm add --save-exact three@0.187.0 @react-three/fiber@9.8.2"
        );
        assert_eq!(
            install_args(PackageManager::Npm, &needs)[..2],
            ["install", "--save-exact"]
        );
        assert_eq!(
            install_args(PackageManager::Yarn, &needs)[..2],
            ["add", "--exact"]
        );
        assert_eq!(
            command_line(PackageManager::Bun, &needs[..1]),
            "bun add --exact three@0.187.0"
        );
    }

    #[tokio::test]
    async fn looks_up_the_newest_old_enough_version_with_npm() {
        let dir = tempfile::tempdir().expect("tempdir");
        let npm = script(
            dir.path(),
            "npm",
            r#"[ "$1 $2 $3 $4" = "view three time --json" ] || exit 9
echo '{"created":"2012-12-07T19:51:25.349Z","0.186.1":"2026-09-24T00:00:00Z","0.187.0":"2026-10-30T00:00:00Z","0.188.0":"2026-11-16T00:00:00Z"}'"#,
        );
        let today = crate::libraries::day_of("2026-11-17").expect("today");

        let version = lookup(&npm, "three", None, today, Duration::from_secs(5)).await;

        assert_eq!(version.as_deref(), Ok("0.187.0"));
        let none = lookup(&npm, "three", Some(1), today, Duration::from_secs(5)).await;
        assert_eq!(
            none,
            Err(InstallError::Failed(
                "no three 1.x release is at least 14 days old".to_owned()
            ))
        );
    }

    #[tokio::test]
    async fn npm_failures_and_hangs_come_back_as_errors() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = script(
            dir.path(),
            "missing",
            "echo 'npm error code E404' >&2\necho 'npm error 404 Not Found - three-nope' >&2\nexit 1",
        );
        let garbled = script(dir.path(), "garbled", "echo 'not json'");
        let silent = script(dir.path(), "silent", "exit 1");
        let hangs = script(dir.path(), "hangs", "sleep 10");
        let second = Duration::from_secs(5);

        assert_eq!(
            lookup(&missing, "three-nope", None, 0, second).await,
            Err(InstallError::Failed(
                "npm error code E404\nnpm error 404 Not Found - three-nope".to_owned()
            ))
        );
        assert!(
            matches!(lookup(&garbled, "x", None, 0, second).await, Err(InstallError::Failed(reason)) if reason.starts_with("npm printed something unexpected"))
        );
        assert_eq!(
            lookup(&silent, "x", None, 0, second).await,
            Err(InstallError::Failed("npm view x failed".to_owned()))
        );
        assert_eq!(
            lookup(&hangs, "x", None, 0, Duration::from_millis(200)).await,
            Err(InstallError::Timeout(0))
        );
    }

    #[tokio::test]
    async fn installs_in_the_project_root_and_reports_the_output_tail_on_failure() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("app");
        std::fs::create_dir_all(&root).expect("root");
        let pnpm = script(dir.path(), "pnpm", "echo \"$@\" > installed.txt");
        let broken = script(
            dir.path(),
            "broken",
            "for n in 1 2 3 4 5 6 7 8 9 10; do echo \"line $n\"; done\necho 'ERR_PNPM_FETCH_404' >&2\nexit 1",
        );
        let needs = [need("three", "0.187.0")];

        install(
            &pnpm,
            PackageManager::Pnpm,
            &needs,
            &root,
            Duration::from_secs(5),
        )
        .await
        .expect("installs");

        assert_eq!(
            std::fs::read_to_string(root.join("installed.txt")).expect("ran in root"),
            "add --save-exact three@0.187.0\n"
        );
        let failure = install(
            &broken,
            PackageManager::Pnpm,
            &needs,
            &root,
            Duration::from_secs(5),
        )
        .await
        .expect_err("fails");
        let InstallError::Failed(reason) = failure else {
            panic!("expected a failure");
        };
        assert!(reason.starts_with("line 4\n"), "{reason}");
        assert!(reason.ends_with("line 10\nERR_PNPM_FETCH_404"), "{reason}");
    }
}
