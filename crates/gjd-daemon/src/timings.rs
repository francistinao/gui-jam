use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;
use std::sync::{Mutex, PoisonError};

const KEPT: usize = 10;
const MIN_RUNS: usize = 3;

static WRITING: Mutex<()> = Mutex::new(());

type Waits = BTreeMap<String, Vec<u64>>;

#[must_use]
pub fn key(provider: &str, model: &str, tier: &str) -> String {
    format!("{provider} · {model} · {tier}")
}

fn load(path: &Path) -> Waits {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

#[must_use]
pub fn expected(path: &Path, key: &str) -> Option<u64> {
    let mut waits = load(path).remove(key)?;
    if waits.len() < MIN_RUNS {
        return None;
    }
    waits.sort_unstable();
    waits.get(waits.len() / 2).copied()
}

pub fn record(path: &Path, key: &str, waited_ms: u64) -> io::Result<()> {
    let _writing = WRITING.lock().unwrap_or_else(PoisonError::into_inner);
    let mut all = load(path);
    let waits = all.entry(key.to_owned()).or_default();
    waits.push(waited_ms);
    let over = waits.len().saturating_sub(KEPT);
    waits.drain(..over);
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&temp, serde_json::to_vec(&all).map_err(io::Error::other)?)?;
    fs::rename(temp, path)
}

#[cfg(test)]
mod tests {
    use super::{KEPT, expected, key, record};

    #[test]
    fn expects_the_median_of_the_last_runs_once_there_are_three() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("timings.json");
        let opus = key("Claude Code", "opus", "R2");
        let haiku = key("Claude Code", "haiku", "R1");

        record(&path, &opus, 50_000).expect("record");
        record(&path, &opus, 90_000).expect("record");
        record(&path, &haiku, 8_000).expect("record");

        assert_eq!(expected(&path, &opus), None);

        record(&path, &opus, 40_000).expect("record");

        assert_eq!(expected(&path, &opus), Some(50_000));
        assert_eq!(expected(&path, &haiku), None);
    }

    #[test]
    fn keeps_only_the_most_recent_runs() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("timings.json");
        let codex = key("Codex", "default model", "R2");

        for _ in 0..KEPT {
            record(&path, &codex, 120_000).expect("record");
        }
        for _ in 0..=KEPT / 2 {
            record(&path, &codex, 30_000).expect("record");
        }

        assert_eq!(expected(&path, &codex), Some(30_000));
    }

    #[test]
    fn an_unreadable_file_means_no_estimate() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("timings.json");
        std::fs::write(&path, "not json").expect("write");

        assert_eq!(expected(&path, &key("Gemini CLI", "flash", "R1")), None);
        record(&path, &key("Gemini CLI", "flash", "R1"), 9_000).expect("record");
    }
}
