use std::ffi::OsStr;
use std::io;
use std::process::ExitStatus;
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
use nix::sys::signal::{Signal, killpg};
#[cfg(unix)]
use nix::unistd::Pid;
use tokio::process::{ChildStderr, ChildStdin, ChildStdout, Command};
#[cfg(unix)]
use tokio::time::timeout;

#[cfg(unix)]
const INTERRUPT_GRACE: Duration = Duration::from_secs(2);
#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_secs(3);

#[must_use]
pub fn command(program: impl AsRef<OsStr>) -> Command {
    without_window(Command::new(program))
}

#[cfg(windows)]
fn without_window(mut command: Command) -> Command {
    command.creation_flags(windows::Win32::System::Threading::CREATE_NO_WINDOW.0);
    command
}

#[cfg(not(windows))]
fn without_window(command: Command) -> Command {
    command
}

pub struct ProcessTree {
    #[cfg(unix)]
    child: tokio::process::Child,
    #[cfg(unix)]
    group: Pid,
    #[cfg(windows)]
    child: Box<dyn process_wrap::tokio::ChildWrapper>,
}

#[cfg(unix)]
impl ProcessTree {
    pub fn spawn(mut command: Command) -> io::Result<Self> {
        let child = command.process_group(0).spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("the process exited before it could be tracked"))?;
        let group = Pid::from_raw(i32::try_from(pid).map_err(io::Error::other)?);
        Ok(Self { child, group })
    }

    pub fn stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }

    pub fn stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    pub fn stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.wait().await
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    pub fn kill(&mut self) {
        let _ = killpg(self.group, Signal::SIGKILL);
    }

    pub async fn terminate(&mut self) {
        for (signal, grace) in [
            (Signal::SIGINT, INTERRUPT_GRACE),
            (Signal::SIGTERM, TERMINATE_GRACE),
        ] {
            if killpg(self.group, signal).is_err() {
                return;
            }
            if timeout(grace, self.child.wait()).await.is_ok() {
                self.kill();
                return;
            }
        }
        self.kill();
        let _ = self.child.wait().await;
    }
}

#[cfg(windows)]
impl ProcessTree {
    pub fn spawn(command: Command) -> io::Result<Self> {
        use process_wrap::tokio::{CommandWrap, CreationFlags, JobObject, KillOnDrop};
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;

        let child = CommandWrap::from(command)
            .wrap(CreationFlags(CREATE_NO_WINDOW))
            .wrap(JobObject)
            .wrap(KillOnDrop)
            .spawn()?;
        Ok(Self { child })
    }

    pub fn stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin().take()
    }

    pub fn stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout().take()
    }

    pub fn stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr().take()
    }

    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.inner_mut().wait().await
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.inner_mut().try_wait()
    }

    pub fn kill(&mut self) {
        let _ = self.child.start_kill();
    }

    pub async fn terminate(&mut self) {
        self.kill();
        let _ = self.wait().await;
    }
}
