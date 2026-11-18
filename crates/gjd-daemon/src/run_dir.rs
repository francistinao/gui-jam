use std::fs::{self, DirBuilder, File, OpenOptions, TryLockError};
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonInfo {
    pub pid: u32,
    pub port: u16,
    pub token: String,
    pub version: String,
    pub protocol: u32,
}

pub struct RunDir {
    dir: PathBuf,
}

impl RunDir {
    #[must_use]
    pub fn of(project: &Path) -> Self {
        Self {
            dir: project.join(".guijam").join("run"),
        }
    }

    pub fn create(project: &Path) -> io::Result<Self> {
        let run_dir = Self::of(project);
        let mut builder = DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(&run_dir.dir)?;
        Ok(run_dir)
    }

    #[must_use]
    pub fn info_path(&self) -> PathBuf {
        self.dir.join("daemon.json")
    }

    #[must_use]
    pub fn timings_path(&self) -> PathBuf {
        self.dir.join("timings.json")
    }

    pub fn lock(&self) -> io::Result<Option<File>> {
        let file = private_file()
            .create(true)
            .write(true)
            .truncate(false)
            .open(self.dir.join("lock"))?;
        match file.try_lock() {
            Ok(()) => Ok(Some(file)),
            Err(TryLockError::WouldBlock) => Ok(None),
            Err(TryLockError::Error(error)) => Err(error),
        }
    }

    pub fn write_info(&self, info: &DaemonInfo) -> io::Result<()> {
        let temp = self.dir.join(format!("daemon.json.{}.tmp", info.pid));
        let mut file = private_file()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&temp)?;
        file.write_all(&serde_json::to_vec(info).map_err(io::Error::other)?)?;
        file.sync_all()?;
        fs::rename(temp, self.info_path())
    }

    pub fn read_info(&self) -> io::Result<DaemonInfo> {
        let bytes = fs::read(self.info_path())?;
        serde_json::from_slice(&bytes)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    pub fn remove_info_if_ours(&self, pid: u32) {
        if self.read_info().is_ok_and(|info| info.pid == pid) {
            let _ = fs::remove_file(self.info_path());
        }
    }
}

#[cfg(unix)]
fn private_file() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.mode(0o600);
    options
}

#[cfg(not(unix))]
fn private_file() -> OpenOptions {
    OpenOptions::new()
}
