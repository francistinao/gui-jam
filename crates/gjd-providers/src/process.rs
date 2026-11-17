use std::ffi::OsStr;
use std::io;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::ChildStdout;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::spawn::{ProcessTree, command};
use crate::{ProviderError, ProviderEvent};

const STDERR_TAIL_BYTES: usize = 4096;
const EXIT_GRACE: Duration = Duration::from_secs(10);

pub(crate) struct ProviderProcess {
    tree: ProcessTree,
    stdout: Lines<BufReader<ChildStdout>>,
    stderr_tail: JoinHandle<String>,
    stderr_lines: Option<mpsc::UnboundedReceiver<String>>,
}

#[derive(Default)]
pub(crate) struct SpawnOptions {
    pub(crate) env: Vec<(String, String)>,
    pub(crate) watch_stderr: bool,
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
        Self::spawn_with(binary, args, cwd, stdin_payload, SpawnOptions::default()).await
    }

    pub(crate) async fn spawn_with<I, S>(
        binary: &Path,
        args: I,
        cwd: &Path,
        stdin_payload: &[u8],
        options: SpawnOptions,
    ) -> io::Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut provider = command(binary);
        provider
            .args(args)
            .envs(options.env)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut tree = ProcessTree::spawn(provider)?;

        let mut stdin = tree.stdin().expect("stdin is piped");
        let stdout = tree.stdout().expect("stdout is piped");
        let mut stderr = tree.stderr().expect("stderr is piped");

        stdin.write_all(stdin_payload).await?;
        drop(stdin);

        let (stderr_tail, stderr_lines) = if options.watch_stderr {
            let (sender, receiver) = mpsc::unbounded_channel();
            let tail = tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                let mut tail = String::new();
                while let Ok(Some(line)) = lines.next_line().await {
                    tail.push_str(&line);
                    tail.push('\n');
                    if tail.len() > STDERR_TAIL_BYTES * 2 {
                        tail = keep_tail(&tail);
                    }
                    let _ = sender.send(line);
                }
                keep_tail(&tail)
            });
            (tail, Some(receiver))
        } else {
            let tail = tokio::spawn(async move {
                let mut buf = Vec::new();
                let _ = stderr.read_to_end(&mut buf).await;
                let start = buf.len().saturating_sub(STDERR_TAIL_BYTES);
                String::from_utf8_lossy(&buf[start..]).into_owned()
            });
            (tail, None)
        };

        Ok(Self {
            tree,
            stdout: BufReader::new(stdout).lines(),
            stderr_tail,
            stderr_lines,
        })
    }

    async fn next_event(&mut self) -> io::Result<Option<Line>> {
        loop {
            let Some(receiver) = self.stderr_lines.as_mut() else {
                return Ok(self.stdout.next_line().await?.map(Line::Stdout));
            };
            tokio::select! {
                line = self.stdout.next_line() => return Ok(line?.map(Line::Stdout)),
                line = receiver.recv() => match line {
                    Some(line) => return Ok(Some(Line::Stderr(line))),
                    None => self.stderr_lines = None,
                },
            }
        }
    }

    pub(crate) async fn exit_code_and_stderr(mut self) -> (Option<i32>, String) {
        let exit_code = self.tree.wait().await.ok().and_then(|status| status.code());
        let stderr = self.stderr_tail.await.unwrap_or_default();
        (exit_code, stderr)
    }

    pub(crate) async fn terminate(mut self) {
        self.tree.terminate().await;
    }

    pub(crate) fn reap_in_background(mut self, grace: Duration) {
        tokio::spawn(async move {
            if timeout(grace, self.tree.wait()).await.is_err() {
                self.terminate().await;
            }
        });
    }
}

enum Line {
    Stdout(String),
    Stderr(String),
}

fn keep_tail(text: &str) -> String {
    let mut start = text.len().saturating_sub(STDERR_TAIL_BYTES);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_owned()
}

const WRITING_STEP_BYTES: usize = 2048;

#[derive(Default)]
pub(crate) struct Signals {
    events: Option<mpsc::UnboundedSender<ProviderEvent>>,
    ready: bool,
    written: usize,
    reported: Option<usize>,
}

impl Signals {
    pub(crate) fn new(events: Option<mpsc::UnboundedSender<ProviderEvent>>) -> Self {
        Self {
            events,
            ..Self::default()
        }
    }

    fn send(&self, event: ProviderEvent) {
        if let Some(events) = &self.events {
            let _ = events.send(event);
        }
    }

    pub(crate) fn ready(&mut self) {
        if !self.ready {
            self.ready = true;
            self.send(ProviderEvent::Ready);
        }
    }

    pub(crate) fn wrote(&mut self, bytes: usize) {
        self.ready();
        self.written += bytes;
        let due = self
            .reported
            .is_none_or(|last| self.written >= last + WRITING_STEP_BYTES);
        if due {
            self.reported = Some(self.written);
            self.send(ProviderEvent::Writing {
                bytes: self.written,
            });
        }
    }
}

pub(crate) trait EventFold {
    type Answer;

    fn feed(
        &mut self,
        line: &str,
        elapsed: Duration,
    ) -> Option<Result<Self::Answer, ProviderError>>;

    fn feed_stderr(&mut self, _line: &str) -> Option<Result<Self::Answer, ProviderError>> {
        None
    }
}

async fn read_answer<F: EventFold>(
    process: &mut ProviderProcess,
    fold: &mut F,
    started: Instant,
) -> io::Result<Option<Result<F::Answer, ProviderError>>> {
    while let Some(line) = process.next_event().await? {
        let finished = match line {
            Line::Stdout(line) => fold.feed(&line, started.elapsed()),
            Line::Stderr(line) => fold.feed_stderr(&line),
        };
        if let Some(finished) = finished {
            return Ok(Some(finished));
        }
    }
    Ok(None)
}

pub(crate) async fn run_to_answer<F: EventFold>(
    mut process: ProviderProcess,
    fold: &mut F,
    limit: Duration,
    cancel: &CancellationToken,
    started: Instant,
) -> Result<F::Answer, ProviderError> {
    let read = tokio::select! {
        () = cancel.cancelled() => Err(ProviderError::Cancelled),
        read = timeout(limit, read_answer(&mut process, fold, started)) => match read {
            Err(_elapsed) => Err(ProviderError::Timeout(limit)),
            Ok(io_result) => io_result.map_err(ProviderError::from),
        },
    };
    match read {
        Ok(Some(Ok(answer))) => {
            process.reap_in_background(EXIT_GRACE);
            Ok(answer)
        }
        Ok(Some(Err(error))) | Err(error) => {
            process.terminate().await;
            Err(error)
        }
        Ok(None) => {
            let (exit_code, stderr_tail) = process.exit_code_and_stderr().await;
            Err(ProviderError::Crashed {
                exit_code,
                stderr_tail,
            })
        }
    }
}

#[cfg(test)]
mod signal_tests {
    use super::Signals;
    use crate::ProviderEvent;

    #[test]
    fn writing_is_reported_first_and_then_every_two_kilobytes() {
        let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
        let mut signals = Signals::new(Some(events));

        signals.ready();
        signals.ready();
        signals.wrote(10);
        signals.wrote(100);
        signals.wrote(2000);
        signals.wrote(1);
        signals.wrote(3000);

        let mut seen = Vec::new();
        while let Ok(event) = received.try_recv() {
            seen.push(event);
        }
        assert_eq!(
            seen,
            [
                ProviderEvent::Ready,
                ProviderEvent::Writing { bytes: 10 },
                ProviderEvent::Writing { bytes: 2110 },
                ProviderEvent::Writing { bytes: 5111 },
            ]
        );
    }

    #[test]
    fn writing_implies_ready_and_no_channel_is_fine() {
        let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
        let mut signals = Signals::new(Some(events));
        signals.wrote(5);
        assert_eq!(received.try_recv().ok(), Some(ProviderEvent::Ready));
        assert_eq!(
            received.try_recv().ok(),
            Some(ProviderEvent::Writing { bytes: 5 })
        );

        let mut silent = Signals::default();
        silent.ready();
        silent.wrote(9999);
    }
}
