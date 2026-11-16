use std::ffi::OsStr;
use std::io;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdout, Command};
use tokio::task::JoinHandle;
use tokio::time::timeout;

const STDERR_TAIL_BYTES: usize = 4096;
const SIGINT_GRACE: Duration = Duration::from_secs(2);
const SIGTERM_GRACE: Duration = Duration::from_secs(3);

/// A provider CLI running as the leader of its own process group, so that
/// cancellation reaches every process it spawned (MCP servers, tool runners).
pub(crate) struct ProviderProcess {
    child: Child,
    group: Pid,
    stdout: Lines<BufReader<ChildStdout>>,
    stderr_tail: JoinHandle<String>,
}

impl ProviderProcess {
    pub(crate) async fn spawn<I, S>(
        binary: &Path,
        args: I,
        cwd: &Path,
        stdin_payload: &[u8],
    ) -> io::Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut child = Command::new(binary)
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()?;

        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("provider exited before it could be tracked"))?;
        let group = Pid::from_raw(i32::try_from(pid).map_err(io::Error::other)?);

        let mut stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let mut stderr = child.stderr.take().expect("stderr is piped");

        stdin.write_all(stdin_payload).await?;
        drop(stdin);

        let stderr_tail = tokio::spawn(async move {
            let mut buf = Vec::new();
            // Reading errors only shorten the diagnostic tail; the exit status is authoritative.
            let _ = stderr.read_to_end(&mut buf).await;
            let start = buf.len().saturating_sub(STDERR_TAIL_BYTES);
            String::from_utf8_lossy(&buf[start..]).into_owned()
        });

        Ok(Self {
            child,
            group,
            stdout: BufReader::new(stdout).lines(),
            stderr_tail,
        })
    }

    pub(crate) async fn next_line(&mut self) -> io::Result<Option<String>> {
        self.stdout.next_line().await
    }

    pub(crate) async fn exit_code_and_stderr(mut self) -> (Option<i32>, String) {
        let exit_code = self
            .child
            .wait()
            .await
            .ok()
            .and_then(|status| status.code());
        let stderr = self.stderr_tail.await.unwrap_or_default();
        (exit_code, stderr)
    }

    /// SIGINT first so the CLI can end its turn cleanly, then SIGTERM, then SIGKILL,
    /// each sent to the whole process group.
    pub(crate) async fn terminate(mut self) {
        for (signal, grace) in [
            (Signal::SIGINT, SIGINT_GRACE),
            (Signal::SIGTERM, SIGTERM_GRACE),
        ] {
            if self.signal_group(signal).is_err() {
                return;
            }
            if timeout(grace, self.child.wait()).await.is_ok() {
                // The leader is gone; children that ignored the signal still get SIGKILL.
                let _ = self.signal_group(Signal::SIGKILL);
                return;
            }
        }
        let _ = self.signal_group(Signal::SIGKILL);
        let _ = self.child.wait().await;
    }

    /// The CLI keeps running for a while after it has printed its answer; let it
    /// finish on its own, and terminate it if it outlives `grace`.
    pub(crate) fn reap_in_background(mut self, grace: Duration) {
        tokio::spawn(async move {
            if timeout(grace, self.child.wait()).await.is_err() {
                self.terminate().await;
            }
        });
    }

    fn signal_group(&self, signal: Signal) -> nix::Result<()> {
        killpg(self.group, signal)
    }
}
