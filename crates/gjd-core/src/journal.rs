use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::content_hash;
use crate::contracts::ContentHash;
use crate::policy::{PolicyError, ProjectRoot};

const MS_PER_DAY: u64 = 86_400_000;

const ABSENT: &str = "absent";

#[derive(Debug, Clone)]
pub struct FileChange {
    pub path: String,
    pub expected_hash: Option<ContentHash>,
    pub content: Option<Vec<u8>>,
}

impl FileChange {
    #[must_use]
    pub fn edit(
        path: impl Into<String>,
        expected_hash: ContentHash,
        content: impl Into<Vec<u8>>,
    ) -> Self {
        Self {
            path: path.into(),
            expected_hash: Some(expected_hash),
            content: Some(content.into()),
        }
    }

    #[must_use]
    pub fn create(path: impl Into<String>, content: impl Into<Vec<u8>>) -> Self {
        Self {
            path: path.into(),
            expected_hash: None,
            content: Some(content.into()),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CommitError {
    #[error("{path} changed on disk since this change was made")]
    Conflict { path: String },
    #[error(transparent)]
    Policy(#[from] PolicyError),
    #[error("journal entry {0} does not exist or was never committed")]
    UnknownEntry(String),
    #[error("journal entry {0} was already undone")]
    AlreadyUndone(String),
    #[error("the journal is unreadable: {0}")]
    Corrupt(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recovery {
    Completed(String),
    NotApplied(String),
    RolledBack { id: String, untouched: Vec<String> },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum Record {
    Begin {
        id: String,
        at_ms: u64,
        origin: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        undo_of: Option<String>,
        files: Vec<FileRecord>,
    },
    Commit {
        id: String,
        at_ms: u64,
    },
    Abort {
        id: String,
        at_ms: u64,
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileRecord {
    path: String,
    pre_hash: String,
    post_hash: String,
}

struct Planned {
    target: PathBuf,
    previous: Option<Vec<u8>>,
    content: Option<Vec<u8>>,
}

fn hash_text(hash: Option<&ContentHash>) -> String {
    hash.map_or_else(|| ABSENT.to_owned(), |hash| hash.as_str().to_owned())
}

fn read_if_present(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub struct Journal {
    project: ProjectRoot,
    dir: PathBuf,
    blobs: PathBuf,
    append_lock: Mutex<()>,
}

impl Journal {
    pub fn open(project: ProjectRoot) -> io::Result<Self> {
        let dir = project.path().join(".guijam").join("journal");
        let blobs = dir.join("blobs");
        let mut builder = DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(&blobs)?;
        Ok(Self {
            project,
            dir,
            blobs,
            append_lock: Mutex::new(()),
        })
    }

    pub fn commit(
        &self,
        changes: &[FileChange],
        origin: &str,
        label: &str,
    ) -> Result<String, CommitError> {
        self.write_entry(changes, origin, label, None)
    }

    pub fn undo(&self, id: &str) -> Result<String, CommitError> {
        let records = self.records()?;
        let files = committed_files(&records, id)
            .ok_or_else(|| CommitError::UnknownEntry(id.to_owned()))?;
        let already_undone = records.iter().any(|record| {
            matches!(record, Record::Begin { id: undo_id, undo_of: Some(of), .. }
                if of == id && is_committed(&records, undo_id))
        });
        if already_undone {
            return Err(CommitError::AlreadyUndone(id.to_owned()));
        }
        let changes = files
            .iter()
            .map(|file| {
                Ok(FileChange {
                    path: file.path.clone(),
                    expected_hash: parse_optional_hash(&file.post_hash)?,
                    content: self.read_optional_blob(&file.pre_hash)?,
                })
            })
            .collect::<Result<Vec<_>, CommitError>>()?;
        self.write_entry(&changes, "undo", &format!("undo {id}"), Some(id))
    }

    pub fn paths(&self, id: &str) -> Result<Vec<String>, CommitError> {
        let records = self.records()?;
        committed_files(&records, id)
            .map(|files| files.iter().map(|file| file.path.clone()).collect())
            .ok_or_else(|| CommitError::UnknownEntry(id.to_owned()))
    }

    pub fn recover(&self) -> Result<Vec<Recovery>, CommitError> {
        let records = self.records()?;
        let mut outcomes = Vec::new();
        for record in &records {
            let Record::Begin { id, files, .. } = record else {
                continue;
            };
            if is_closed(&records, id) {
                continue;
            }
            outcomes.push(self.recover_entry(id, files)?);
        }
        Ok(outcomes)
    }

    fn recover_entry(&self, id: &str, files: &[FileRecord]) -> Result<Recovery, CommitError> {
        let mut at_post = Vec::new();
        let mut at_pre = 0;
        let mut untouched = Vec::new();
        for file in files {
            let target = self.project.resolve(&file.path)?;
            remove_quietly(&temp_path(&target, id));
            let current = hash_text(
                read_if_present(&target)?
                    .as_deref()
                    .map(content_hash)
                    .as_ref(),
            );
            if current == file.post_hash {
                at_post.push((file, target));
            } else if current == file.pre_hash {
                at_pre += 1;
            } else {
                untouched.push(file.path.clone());
            }
        }

        if at_post.len() == files.len() {
            self.append(&Record::Commit {
                id: id.to_owned(),
                at_ms: now_ms(),
            })?;
            return Ok(Recovery::Completed(id.to_owned()));
        }
        if at_pre == files.len() {
            self.append(&Record::Abort {
                id: id.to_owned(),
                at_ms: now_ms(),
                reason: "not applied before the daemon stopped".to_owned(),
            })?;
            return Ok(Recovery::NotApplied(id.to_owned()));
        }
        for (file, target) in &at_post {
            restore(
                target,
                self.read_optional_blob(&file.pre_hash)?.as_deref(),
                id,
            )?;
        }
        sync_parents(at_post.iter().map(|(_, target)| target.as_path()))?;
        self.append(&Record::Abort {
            id: id.to_owned(),
            at_ms: now_ms(),
            reason: "rolled back after the daemon stopped".to_owned(),
        })?;
        Ok(Recovery::RolledBack {
            id: id.to_owned(),
            untouched,
        })
    }

    fn write_entry(
        &self,
        changes: &[FileChange],
        origin: &str,
        label: &str,
        undo_of: Option<&str>,
    ) -> Result<String, CommitError> {
        let mut sorted: Vec<&FileChange> = changes.iter().collect();
        sorted.sort_by(|a, b| a.path.cmp(&b.path));

        let mut planned = Vec::with_capacity(sorted.len());
        let mut files = Vec::with_capacity(sorted.len());
        for change in sorted {
            let target = self.project.resolve(&change.path)?;
            let previous = read_if_present(&target)?;
            let pre_hash = previous.as_deref().map(content_hash);
            if pre_hash != change.expected_hash {
                return Err(CommitError::Conflict {
                    path: change.path.clone(),
                });
            }
            if let (Some(bytes), Some(hash)) = (&previous, &pre_hash) {
                self.store_blob(hash, bytes)?;
            }
            files.push(FileRecord {
                path: change.path.clone(),
                pre_hash: hash_text(pre_hash.as_ref()),
                post_hash: hash_text(change.content.as_deref().map(content_hash).as_ref()),
            });
            planned.push(Planned {
                target,
                previous,
                content: change.content.clone(),
            });
        }

        let at_ms = now_ms();
        let id = new_id(at_ms)?;
        self.append(&Record::Begin {
            id: id.clone(),
            at_ms,
            origin: origin.to_owned(),
            label: label.to_owned(),
            undo_of: undo_of.map(str::to_owned),
            files,
        })?;
        if let Err(error) = write_all_or_none(&id, &planned) {
            self.append(&Record::Abort {
                id,
                at_ms: now_ms(),
                reason: error.to_string(),
            })?;
            return Err(error.into());
        }
        self.append(&Record::Commit {
            id: id.clone(),
            at_ms: now_ms(),
        })?;
        Ok(id)
    }

    fn store_blob(&self, hash: &ContentHash, bytes: &[u8]) -> io::Result<()> {
        let path = self.blobs.join(hash.as_str());
        if path.exists() {
            return Ok(());
        }
        let temp = write_temp(&path, bytes, "blob")?;
        fs::rename(temp, &path)
    }

    fn read_optional_blob(&self, hash: &str) -> Result<Option<Vec<u8>>, CommitError> {
        if hash == ABSENT {
            return Ok(None);
        }
        Ok(Some(fs::read(self.blobs.join(hash))?))
    }

    fn append(&self, record: &Record) -> io::Result<()> {
        let at_ms = match record {
            Record::Begin { at_ms, .. }
            | Record::Commit { at_ms, .. }
            | Record::Abort { at_ms, .. } => *at_ms,
        };
        let mut line = serde_json::to_string(record).map_err(io::Error::other)?;
        line.push('\n');
        let _guard = self
            .append_lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join(journal_file_name(at_ms)))?;
        file.write_all(line.as_bytes())?;
        file.sync_data()
    }

    fn records(&self) -> Result<Vec<Record>, CommitError> {
        let mut files: Vec<PathBuf> = fs::read_dir(&self.dir)?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "jsonl")
            })
            .collect();
        files.sort();
        let mut records = Vec::new();
        for path in files {
            for line in BufReader::new(File::open(&path)?).lines() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                let record = serde_json::from_str(&line).map_err(|error| {
                    CommitError::Corrupt(format!("{}: {error}", path.display()))
                })?;
                records.push(record);
            }
        }
        Ok(records)
    }
}

fn restore(target: &Path, content: Option<&[u8]>, id: &str) -> io::Result<()> {
    match content {
        Some(bytes) => {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let temp = write_temp(target, bytes, id)?;
            fs::rename(temp, target)
        }
        None => match fs::remove_file(target) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        },
    }
}

fn write_all_or_none(id: &str, planned: &[Planned]) -> io::Result<()> {
    let mut temps = Vec::with_capacity(planned.len());
    for plan in planned {
        let Some(content) = &plan.content else {
            temps.push(None);
            continue;
        };
        let written = plan
            .target
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| write_temp(&plan.target, content, id));
        match written {
            Ok(temp) => temps.push(Some(temp)),
            Err(error) => {
                for temp in temps.iter().flatten() {
                    remove_quietly(temp);
                }
                return Err(error);
            }
        }
    }
    for (index, (plan, temp)) in planned.iter().zip(&temps).enumerate() {
        let applied = match temp {
            Some(temp) => fs::rename(temp, &plan.target),
            None => restore(&plan.target, None, id),
        };
        if let Err(error) = applied {
            for temp in temps[index..].iter().flatten() {
                remove_quietly(temp);
            }
            for restored in &planned[..index] {
                let _ = restore(&restored.target, restored.previous.as_deref(), id);
            }
            return Err(error);
        }
    }
    sync_parents(planned.iter().map(|plan| plan.target.as_path()))
}

fn temp_path(target: &Path, id: &str) -> PathBuf {
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    target.with_file_name(format!(".{name}.{id}.guijam-tmp"))
}

fn write_temp(target: &Path, bytes: &[u8], id: &str) -> io::Result<PathBuf> {
    let temp = temp_path(target, id);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let written = file
        .write_all(bytes)
        .and_then(|()| match fs::metadata(target) {
            Ok(metadata) => file.set_permissions(metadata.permissions()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        })
        .and_then(|()| file.sync_all());
    if let Err(error) = written {
        remove_quietly(&temp);
        return Err(error);
    }
    Ok(temp)
}

fn sync_parents<'p>(targets: impl Iterator<Item = &'p Path>) -> io::Result<()> {
    if !cfg!(unix) {
        return Ok(());
    }
    let mut parents: Vec<&Path> = targets.filter_map(Path::parent).collect();
    parents.sort();
    parents.dedup();
    for parent in parents {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn remove_quietly(path: &Path) {
    let _ = fs::remove_file(path);
}

fn is_committed(records: &[Record], id: &str) -> bool {
    records
        .iter()
        .any(|record| matches!(record, Record::Commit { id: committed, .. } if committed == id))
}

fn is_closed(records: &[Record], id: &str) -> bool {
    records.iter().any(|record| {
        matches!(record, Record::Commit { id: closed, .. } | Record::Abort { id: closed, .. } if closed == id)
    })
}

fn committed_files<'r>(records: &'r [Record], id: &str) -> Option<&'r [FileRecord]> {
    if !is_committed(records, id) {
        return None;
    }
    records.iter().find_map(|record| match record {
        Record::Begin {
            id: begun, files, ..
        } if begun == id => Some(files.as_slice()),
        _ => None,
    })
}

fn parse_optional_hash(value: &str) -> Result<Option<ContentHash>, CommitError> {
    if value == ABSENT {
        return Ok(None);
    }
    parse_hash(value).map(Some)
}

fn parse_hash(value: &str) -> Result<ContentHash, CommitError> {
    ContentHash::try_from(value).map_err(|_| CommitError::Corrupt(format!("bad hash {value}")))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

fn new_id(at_ms: u64) -> io::Result<String> {
    let random = getrandom::u32().map_err(io::Error::other)?;
    Ok(format!("j{at_ms:x}{random:08x}"))
}

fn journal_file_name(at_ms: u64) -> String {
    let days = i64::try_from(at_ms / MS_PER_DAY).unwrap_or(i64::MAX);
    let (year, month) = year_month(days);
    format!("{year:04}-{month:02}.jsonl")
}

fn year_month(days: i64) -> (i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    (year_of_era + era * 400 + i64::from(month <= 2), month)
}

#[cfg(test)]
mod tests {
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use super::{
        CommitError, FileChange, FileRecord, Journal, Record, Recovery, now_ms, year_month,
    };
    use crate::content_hash;
    use crate::policy::ProjectRoot;

    const BUTTON: &str = "src/Button.tsx";
    const CARD: &str = "src/Card.tsx";

    fn project(files: &[(&str, &str)]) -> (tempfile::TempDir, Journal) {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::create_dir_all(dir.path().join("src")).expect("src dir");
        for (path, content) in files {
            fs::write(dir.path().join(path), content).expect("fixture file");
        }
        let journal = Journal::open(ProjectRoot::new(dir.path()).expect("root")).expect("journal");
        (dir, journal)
    }

    fn change(path: &str, from: &str, to: &str) -> FileChange {
        FileChange::edit(path, content_hash(from.as_bytes()), to)
    }

    fn read(dir: &tempfile::TempDir, path: &str) -> String {
        fs::read_to_string(dir.path().join(path)).expect("readable")
    }

    #[cfg(unix)]
    #[test]
    fn commits_every_file_and_keeps_permissions() {
        let (dir, journal) = project(&[(BUTTON, "a\n"), (CARD, "b\n")]);
        let button = dir.path().join(BUTTON);
        fs::set_permissions(&button, fs::Permissions::from_mode(0o640)).expect("chmod");

        journal
            .commit(
                &[change(CARD, "b\n", "B\n"), change(BUTTON, "a\n", "A\n")],
                "finetune",
                "fill",
            )
            .expect("committed");

        assert_eq!(read(&dir, BUTTON), "A\n");
        assert_eq!(read(&dir, CARD), "B\n");
        assert_eq!(
            fs::metadata(&button)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
        let leftovers: Vec<_> = fs::read_dir(dir.path().join("src"))
            .expect("listable")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".guijam-tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn refuses_to_write_when_a_file_changed_since_the_change_was_made() {
        let (dir, journal) = project(&[(BUTTON, "edited by the developer\n"), (CARD, "b\n")]);

        let result = journal.commit(
            &[change(BUTTON, "a\n", "A\n"), change(CARD, "b\n", "B\n")],
            "finetune",
            "fill",
        );

        assert!(matches!(result, Err(CommitError::Conflict { path }) if path == BUTTON));
        assert_eq!(read(&dir, BUTTON), "edited by the developer\n");
        assert_eq!(read(&dir, CARD), "b\n");
    }

    #[test]
    fn undo_restores_the_exact_previous_bytes_once() {
        let original = "export const A = () => (\r\n  <b>오늘</b>\r\n);\r\n";
        let (dir, journal) = project(&[(BUTTON, original)]);
        let id = journal
            .commit(&[change(BUTTON, original, "changed\n")], "finetune", "fill")
            .expect("committed");

        assert_eq!(journal.paths(&id).expect("paths"), [BUTTON]);
        journal.undo(&id).expect("undone");

        assert_eq!(read(&dir, BUTTON), original);
        assert!(
            matches!(journal.undo(&id), Err(CommitError::AlreadyUndone(undone)) if undone == id)
        );
    }

    #[test]
    fn undo_refuses_when_the_file_changed_after_the_commit() {
        let (dir, journal) = project(&[(BUTTON, "a\n")]);
        let id = journal
            .commit(&[change(BUTTON, "a\n", "A\n")], "finetune", "fill")
            .expect("committed");
        fs::write(dir.path().join(BUTTON), "A, then edited\n").expect("external edit");

        assert!(matches!(
            journal.undo(&id),
            Err(CommitError::Conflict { .. })
        ));
        assert_eq!(read(&dir, BUTTON), "A, then edited\n");
    }

    #[test]
    fn undo_rejects_unknown_entries() {
        let (_dir, journal) = project(&[(BUTTON, "a\n")]);

        assert!(matches!(
            journal.undo("j-missing"),
            Err(CommitError::UnknownEntry(_))
        ));
        assert!(matches!(
            journal.paths("j-missing"),
            Err(CommitError::UnknownEntry(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn writes_nothing_when_one_target_cannot_be_written() {
        let (dir, journal) = project(&[(BUTTON, "a\n")]);
        fs::create_dir_all(dir.path().join("locked")).expect("locked dir");
        fs::write(dir.path().join("locked/C.tsx"), "c\n").expect("file");
        fs::set_permissions(dir.path().join("locked"), fs::Permissions::from_mode(0o500))
            .expect("chmod");

        let result = journal.commit(
            &[
                change(BUTTON, "a\n", "A\n"),
                change("locked/C.tsx", "c\n", "C\n"),
            ],
            "finetune",
            "fill",
        );

        fs::set_permissions(dir.path().join("locked"), fs::Permissions::from_mode(0o700))
            .expect("chmod back");
        assert!(matches!(result, Err(CommitError::Io(_))));
        assert_eq!(read(&dir, BUTTON), "a\n");
        assert_eq!(read(&dir, "locked/C.tsx"), "c\n");
    }

    #[test]
    fn rejects_paths_outside_the_policy() {
        let (_dir, journal) = project(&[(BUTTON, "a\n")]);

        assert!(matches!(
            journal.commit(&[change("../escape.tsx", "a\n", "b\n")], "mcp", "x"),
            Err(CommitError::Policy(_))
        ));
    }

    fn begin_without_commit(journal: &Journal, id: &str, files: Vec<FileRecord>) {
        journal
            .append(&Record::Begin {
                id: id.to_owned(),
                at_ms: now_ms(),
                origin: "finetune".to_owned(),
                label: "crash".to_owned(),
                undo_of: None,
                files,
            })
            .expect("appended");
    }

    fn record(path: &str, pre: &str, post: &str) -> FileRecord {
        FileRecord {
            path: path.to_owned(),
            pre_hash: content_hash(pre.as_bytes()).as_str().to_owned(),
            post_hash: content_hash(post.as_bytes()).as_str().to_owned(),
        }
    }

    #[test]
    fn recovery_settles_entries_a_crash_left_open() {
        let (dir, journal) = project(&[
            (BUTTON, "new\n"),
            (CARD, "old\n"),
            ("src/Other.tsx", "edited\n"),
        ]);
        journal
            .store_blob(&content_hash(b"old\n"), b"old\n")
            .expect("blob");
        begin_without_commit(&journal, "j-done", vec![record(BUTTON, "old\n", "new\n")]);
        begin_without_commit(&journal, "j-none", vec![record(CARD, "old\n", "new\n")]);
        begin_without_commit(
            &journal,
            "j-mixed",
            vec![
                record(BUTTON, "old\n", "new\n"),
                record(CARD, "old\n", "new\n"),
                record("src/Other.tsx", "old\n", "new\n"),
            ],
        );

        let outcomes = journal.recover().expect("recovered");

        assert_eq!(
            outcomes,
            vec![
                Recovery::Completed("j-done".to_owned()),
                Recovery::NotApplied("j-none".to_owned()),
                Recovery::RolledBack {
                    id: "j-mixed".to_owned(),
                    untouched: vec!["src/Other.tsx".to_owned()],
                },
            ]
        );
        assert_eq!(read(&dir, BUTTON), "old\n");
        assert_eq!(read(&dir, "src/Other.tsx"), "edited\n");
        assert_eq!(
            journal.recover().expect("second pass"),
            Vec::<Recovery>::new()
        );
    }

    #[test]
    fn computes_calendar_months_from_day_counts() {
        assert_eq!(year_month(0), (1970, 1));
        assert_eq!(year_month(20_453), (2025, 12));
        assert_eq!(year_month(20_454), (2026, 1));
        assert_eq!(year_month(11_016), (2000, 2));
        assert_eq!(year_month(11_017), (2000, 3));
    }

    #[test]
    fn creates_new_files_in_new_folders_and_undo_removes_them() {
        let (dir, journal) = project(&[("src/App.tsx", "app\n")]);
        let icon = b"<svg/>".to_vec();
        let changes = [
            change("src/App.tsx", "app\n", "app with icon\n"),
            FileChange::create("src/assets/icons/cup.svg", icon.clone()),
        ];

        let id = journal.commit(&changes, "ai", "icon").expect("committed");

        assert_eq!(
            fs::read(dir.path().join("src/assets/icons/cup.svg")).expect("created"),
            icon
        );
        journal.undo(&id).expect("undone");
        assert!(!dir.path().join("src/assets/icons/cup.svg").exists());
        assert_eq!(read(&dir, "src/App.tsx"), "app\n");
    }

    #[test]
    fn refuses_to_create_a_file_that_appeared_meanwhile() {
        let (dir, journal) = project(&[("src/cup.svg", "mine")]);

        let error = journal
            .commit(
                &[FileChange::create("src/cup.svg", b"<svg/>".to_vec())],
                "ai",
                "icon",
            )
            .expect_err("conflict");

        assert!(matches!(error, CommitError::Conflict { .. }));
        assert_eq!(read(&dir, "src/cup.svg"), "mine");
    }

    #[test]
    fn keeps_binary_content_byte_for_byte() {
        let (dir, journal) = project(&[]);
        let webp = vec![
            0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0xfe, 0x57, 0x45, 0x42, 0x50,
        ];

        let id = journal
            .commit(
                &[FileChange::create("public/cup.webp", webp.clone())],
                "ai",
                "raster",
            )
            .expect("committed");

        assert_eq!(
            fs::read(dir.path().join("public/cup.webp")).expect("written"),
            webp
        );
        journal.undo(&id).expect("undone");
        assert!(!dir.path().join("public/cup.webp").exists());
    }
}
