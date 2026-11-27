use std::collections::{HashMap, HashSet};
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::content_hash;
use crate::contracts::ContentHash;
use crate::merge::{changed_lines, map_line, revert};
use crate::policy::{PolicyError, ProjectRoot};

const BUSY_RETRIES: u32 = 5;
const ERROR_ACCESS_DENIED: i32 = 5;
const ERROR_SHARING_VIOLATION: i32 = 32;
const ERROR_LOCK_VIOLATION: i32 = 33;

const MS_PER_DAY: u64 = 86_400_000;

const ABSENT: &str = "absent";
const UNDO: &str = "undo";
const REDO: &str = "redo";
const MAX_BLOCKERS: usize = 3;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntryMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Flipped {
    pub id: String,
    pub of: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub id: String,
    pub at_ms: u64,
    pub origin: String,
    pub title: String,
    pub meta: EntryMeta,
    pub files: Vec<String>,
    pub applied: bool,
    pub line: Option<usize>,
}

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
    #[error("journal entry {0} is already applied")]
    NotUndone(String),
    #[error("{path} shares lines with a later change")]
    Overlap {
        path: String,
        lines: Vec<(usize, usize)>,
        blockers: Vec<String>,
    },
    #[error("{path} changed since this change, which was made before History")]
    Stale { path: String },
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<EntryMeta>,
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
        self.write_entry(changes, origin, label, None, None)
    }

    pub fn commit_with(
        &self,
        changes: &[FileChange],
        origin: &str,
        label: &str,
        meta: EntryMeta,
    ) -> Result<String, CommitError> {
        self.write_entry(changes, origin, label, None, Some(meta))
    }

    pub fn undo(&self, id: &str) -> Result<String, CommitError> {
        self.flip(id, false).map(|flipped| flipped.id)
    }

    pub fn flip(&self, id: &str, want_applied: bool) -> Result<Flipped, CommitError> {
        let records = self.records()?;
        let index = Index::new(&records);
        let root = index
            .root(id)
            .ok_or_else(|| CommitError::UnknownEntry(id.to_owned()))?;
        let chain = index.chain(root);
        let tip = *chain.last().unwrap_or(&root);
        let applied = chain.len() % 2 == 1;
        if applied == want_applied {
            return Err(if want_applied {
                CommitError::NotUndone(root.to_owned())
            } else {
                CommitError::AlreadyUndone(root.to_owned())
            });
        }
        let files = index.files(tip);
        let mut changes = Vec::with_capacity(files.len());
        for file in files {
            let target = self.project.resolve(&file.path)?;
            let current = read_if_present(&target)?;
            let current_hash = current.as_deref().map(content_hash);
            let current_text = hash_text(current_hash.as_ref());
            if current_text == file.pre_hash {
                continue;
            }
            let content = if current_text == file.post_hash {
                self.read_optional_blob(&file.pre_hash)?
            } else {
                Some(self.merged(&index, &chain, file, current.as_deref())?)
            };
            changes.push(FileChange {
                path: file.path.clone(),
                expected_hash: current_hash,
                content,
            });
        }
        let (origin, label) = if want_applied {
            (REDO, format!("redo {root}"))
        } else {
            (UNDO, format!("undo {root}"))
        };
        let paths = files.iter().map(|file| file.path.clone()).collect();
        let id = self.write_entry(&changes, origin, &label, Some(tip), None)?;
        Ok(Flipped {
            id,
            of: root.to_owned(),
            paths,
        })
    }

    fn merged(
        &self,
        index: &Index<'_>,
        chain: &[&str],
        file: &FileRecord,
        current: Option<&[u8]>,
    ) -> Result<Vec<u8>, CommitError> {
        let conflict = || CommitError::Conflict {
            path: file.path.clone(),
        };
        let Some(current) = current else {
            return Err(conflict());
        };
        if file.pre_hash == ABSENT || file.post_hash == ABSENT {
            return Err(conflict());
        }
        let ancestor = self
            .blob_text(&file.post_hash)?
            .ok_or_else(|| CommitError::Stale {
                path: file.path.clone(),
            })?;
        let target = self.blob_text(&file.pre_hash)?.ok_or_else(conflict)?;
        let current = std::str::from_utf8(current).map_err(|_| conflict())?;
        match revert(&ancestor, current, &target) {
            Ok(merged) => Ok(merged.into_bytes()),
            Err(clashes) => Err(CommitError::Overlap {
                path: file.path.clone(),
                blockers: self.blockers(index, chain, &file.path, current, &clashes),
                lines: clashes
                    .iter()
                    .map(|range| (range.start + 1, range.end.max(range.start + 1)))
                    .collect(),
            }),
        }
    }

    fn blockers(
        &self,
        index: &Index<'_>,
        chain: &[&str],
        path: &str,
        current: &str,
        clashes: &[std::ops::Range<usize>],
    ) -> Vec<String> {
        let first = index.position(chain.first().copied().unwrap_or_default());
        let mut names = Vec::new();
        for (position, record) in index.begins.iter().rev() {
            if *position <= first || names.len() >= MAX_BLOCKERS {
                continue;
            }
            let Record::Begin {
                id,
                undo_of: None,
                files,
                ..
            } = record
            else {
                continue;
            };
            if chain.contains(&id.as_str()) || !index.applied(id) {
                continue;
            }
            let Some(file) = files.iter().find(|file| file.path == path) else {
                continue;
            };
            let touches = match (
                self.blob_text(&file.pre_hash).ok().flatten(),
                self.blob_text(&file.post_hash).ok().flatten(),
            ) {
                (Some(before), Some(after)) => changed_lines(&before, &after).iter().any(|range| {
                    let start = map_line(&after, current, range.start);
                    let end = map_line(&after, current, range.end.max(range.start + 1) - 1) + 1;
                    clashes
                        .iter()
                        .any(|clash| start < clash.end.max(clash.start + 1) && clash.start < end)
                }),
                _ => true,
            };
            let name = title(record);
            if touches && !names.contains(&name) {
                names.push(name);
            }
        }
        names
    }

    pub fn history(
        &self,
        page_url: Option<&str>,
        before: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<Row>, bool), CommitError> {
        let records = self.records()?;
        let index = Index::new(&records);
        let mut rows: Vec<&Record> = index
            .begins
            .iter()
            .map(|(_, record)| *record)
            .filter(|record| matches!(record, Record::Begin { undo_of: None, .. }))
            .filter(|record| {
                let Record::Begin { id, meta, .. } = record else {
                    return false;
                };
                let on_page = page_url.is_none_or(|page| {
                    meta.as_ref().and_then(|meta| meta.page_url.as_deref()) == Some(page)
                });
                on_page && before.is_none_or(|before| id.as_str() < before)
            })
            .collect();
        rows.sort_by(|a, b| sort_key(b).cmp(&sort_key(a)));
        let more = rows.len() > limit;
        let rows = rows
            .into_iter()
            .take(limit)
            .filter_map(|record| {
                let Record::Begin {
                    id,
                    at_ms,
                    origin,
                    files,
                    meta,
                    ..
                } = record
                else {
                    return None;
                };
                let meta = meta.clone().unwrap_or_default();
                Some(Row {
                    line: self.current_line(&meta, files),
                    id: id.clone(),
                    at_ms: *at_ms,
                    origin: origin.clone(),
                    title: title(record),
                    files: files.iter().map(|file| file.path.clone()).collect(),
                    applied: index.applied(id),
                    meta,
                })
            })
            .collect();
        Ok((rows, more))
    }

    fn current_line(&self, meta: &EntryMeta, files: &[FileRecord]) -> Option<usize> {
        let src = meta.src.as_deref()?;
        let (rest, _column) = src.rsplit_once(':')?;
        let (path, line) = rest.rsplit_once(':')?;
        let line: usize = line.parse().ok()?;
        let file = files.iter().find(|file| file.path == path)?;
        let before = self.blob_text(&file.pre_hash).ok().flatten()?;
        let current = fs::read_to_string(self.project.resolve(path).ok()?).ok()?;
        Some(map_line(&before, &current, line.checked_sub(1)?) + 1)
    }

    fn blob_text(&self, hash: &str) -> Result<Option<String>, CommitError> {
        if hash == ABSENT {
            return Ok(None);
        }
        match fs::read(self.blobs.join(hash)) {
            Ok(bytes) => Ok(String::from_utf8(bytes).ok()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
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
        meta: Option<EntryMeta>,
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
            if let Some(bytes) = &change.content {
                self.store_blob(&content_hash(bytes), bytes)?;
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
            meta,
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
        replace(&temp, &path)
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
            let text = fs::read_to_string(&path)?;
            for line in text.split_inclusive('\n') {
                let Some(line) = line.strip_suffix('\n') else {
                    continue;
                };
                if line.trim().is_empty() {
                    continue;
                }
                let record = serde_json::from_str(line).map_err(|error| {
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
            replace(&temp, target)
        }
        None => match retrying(|| fs::remove_file(target)) {
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
            Some(temp) => replace(temp, &plan.target),
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
        .and_then(|()| keep_permissions(&file, target))
        .and_then(|()| file.sync_all());
    if let Err(error) = written {
        remove_quietly(&temp);
        return Err(error);
    }
    Ok(temp)
}

fn keep_permissions(file: &File, target: &Path) -> io::Result<()> {
    if !cfg!(unix) {
        return Ok(());
    }
    match fs::metadata(target) {
        Ok(metadata) => file.set_permissions(metadata.permissions()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn replace(temp: &Path, target: &Path) -> io::Result<()> {
    retrying(|| fs::rename(temp, target))
}

fn retrying(mut action: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    let mut wait = Duration::from_millis(10);
    for _ in 0..BUSY_RETRIES {
        match action() {
            Err(error) if held_by_another_process(&error) => {
                std::thread::sleep(wait);
                wait *= 2;
            }
            done => return done,
        }
    }
    action()
}

fn held_by_another_process(error: &io::Error) -> bool {
    cfg!(windows)
        && matches!(
            error.raw_os_error(),
            Some(ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)
        )
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

struct Index<'r> {
    begins: Vec<(usize, &'r Record)>,
    by_id: HashMap<&'r str, (usize, &'r Record)>,
    child: HashMap<&'r str, &'r str>,
}

impl<'r> Index<'r> {
    fn new(records: &'r [Record]) -> Self {
        let committed: HashSet<&str> = records
            .iter()
            .filter_map(|record| match record {
                Record::Commit { id, .. } => Some(id.as_str()),
                _ => None,
            })
            .collect();
        let mut begins = Vec::new();
        let mut by_id = HashMap::new();
        let mut child = HashMap::new();
        for (position, record) in records.iter().enumerate() {
            let Record::Begin { id, undo_of, .. } = record else {
                continue;
            };
            if !committed.contains(id.as_str()) {
                continue;
            }
            begins.push((position, record));
            by_id.insert(id.as_str(), (position, record));
            if let Some(of) = undo_of {
                child.insert(of.as_str(), id.as_str());
            }
        }
        Self {
            begins,
            by_id,
            child,
        }
    }

    fn root(&self, id: &str) -> Option<&'r str> {
        let (_, mut record) = *self.by_id.get(id)?;
        loop {
            match record {
                Record::Begin {
                    undo_of: Some(of), ..
                } => record = self.by_id.get(of.as_str())?.1,
                Record::Begin { id, .. } => return Some(id.as_str()),
                _ => return None,
            }
        }
    }

    fn chain(&self, root: &'r str) -> Vec<&'r str> {
        let mut chain = vec![root];
        let mut at = root;
        while let Some(next) = self.child.get(at) {
            chain.push(next);
            at = next;
        }
        chain
    }

    fn applied(&self, root: &str) -> bool {
        self.by_id
            .get_key_value(root)
            .is_some_and(|(root, _)| self.chain(root).len() % 2 == 1)
    }

    fn files(&self, id: &str) -> &'r [FileRecord] {
        match self.by_id.get(id) {
            Some((_, Record::Begin { files, .. })) => files.as_slice(),
            _ => &[],
        }
    }

    fn position(&self, id: &str) -> usize {
        self.by_id.get(id).map_or(0, |(position, _)| *position)
    }
}

fn sort_key(record: &Record) -> (u64, &str) {
    match record {
        Record::Begin { at_ms, id, .. } => (*at_ms, id.as_str()),
        _ => (0, ""),
    }
}

fn title(record: &Record) -> String {
    let Record::Begin { label, meta, .. } = record else {
        return String::new();
    };
    if let Some(EntryMeta {
        component: Some(component),
        detail: Some(detail),
        ..
    }) = meta
    {
        return format!("{component} · {detail}");
    }
    let summary = label
        .split_once(" · ")
        .map_or(label.as_str(), |(_, rest)| rest);
    summary
        .rsplit_once(" (")
        .filter(|(_, route)| route.ends_with(')') && route.contains(" · "))
        .map_or(summary, |(text, _)| text)
        .to_owned()
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
        CommitError, EntryMeta, FileChange, FileRecord, Journal, Record, Recovery, now_ms,
        year_month,
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
            Err(CommitError::Overlap { blockers, .. }) if blockers.is_empty()
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
                meta: None,
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

    const LINES: &str = "a\nb\nc\nd\n";

    fn meta(component: &str, detail: &str, page: &str) -> EntryMeta {
        EntryMeta {
            component: Some(component.to_owned()),
            detail: Some(detail.to_owned()),
            page_url: Some(page.to_owned()),
            src: Some(format!("{BUTTON}:4:3")),
            prompt: None,
        }
    }

    fn commit_as(
        journal: &Journal,
        path: &str,
        from: &str,
        to: &str,
        name: (&str, &str),
    ) -> String {
        journal
            .commit_with(
                &[change(path, from, to)],
                "finetune",
                &format!("{path}:1 · {}", name.1),
                meta(name.0, name.1, "http://localhost:5173/"),
            )
            .expect("committed")
    }

    #[test]
    fn undoes_an_older_change_and_keeps_a_later_one_in_the_same_file() {
        let (dir, journal) = project(&[(BUTTON, LINES)]);
        let header = commit_as(&journal, BUTTON, LINES, "a\nB\nc\nd\n", ("Header", "Fill"));
        commit_as(
            &journal,
            BUTTON,
            "a\nB\nc\nd\n",
            "a\nB\nc\nD\n",
            ("Footer", "Text"),
        );

        journal.undo(&header).expect("undone");

        assert_eq!(read(&dir, BUTTON), "a\nb\nc\nD\n");
        let (rows, more) = journal.history(None, None, 10).expect("history");
        assert!(!more);
        let states: Vec<(&str, bool)> = rows
            .iter()
            .map(|row| (row.title.as_str(), row.applied))
            .collect();
        assert_eq!(states, [("Footer · Text", true), ("Header · Fill", false)]);
    }

    #[test]
    fn an_edit_elsewhere_in_the_file_does_not_block_undo() {
        let (dir, journal) = project(&[(BUTTON, LINES)]);
        let id = commit_as(&journal, BUTTON, LINES, "a\nB\nc\nd\n", ("Header", "Fill"));
        fs::write(dir.path().join(BUTTON), "a\nB\nc\nmine\n").expect("ide edit");

        journal.undo(&id).expect("undone");

        assert_eq!(read(&dir, BUTTON), "a\nb\nc\nmine\n");
    }

    #[test]
    fn names_the_later_change_on_the_same_lines_and_writes_nothing() {
        let (dir, journal) = project(&[(BUTTON, LINES)]);
        let id = commit_as(&journal, BUTTON, LINES, "a\nB\nc\nd\n", ("Header", "Fill"));
        commit_as(
            &journal,
            BUTTON,
            "a\nB\nc\nd\n",
            "a\nBB\nc\nd\n",
            ("MenuCard", "V2 · soft card"),
        );

        let error = journal.undo(&id).expect_err("overlap");

        assert!(matches!(
            error,
            CommitError::Overlap { ref blockers, ref lines, .. }
                if blockers == &["MenuCard · V2 · soft card".to_owned()] && lines == &[(2, 2)]
        ));
        assert_eq!(read(&dir, BUTTON), "a\nBB\nc\nd\n");
    }

    #[test]
    fn a_change_across_two_files_is_undone_in_both_or_neither() {
        let (dir, journal) = project(&[(BUTTON, LINES), (CARD, LINES)]);
        let both = journal
            .commit_with(
                &[
                    change(BUTTON, LINES, "a\nB\nc\nd\n"),
                    change(CARD, LINES, "a\nB\nc\nd\n"),
                ],
                "ai",
                "both",
                EntryMeta::default(),
            )
            .expect("committed");
        commit_as(
            &journal,
            CARD,
            "a\nB\nc\nd\n",
            "a\nBee\nc\nd\n",
            ("Card", "Text"),
        );

        assert!(matches!(
            journal.undo(&both),
            Err(CommitError::Overlap { .. })
        ));
        assert_eq!(read(&dir, BUTTON), "a\nB\nc\nd\n");
        assert_eq!(read(&dir, CARD), "a\nBee\nc\nd\n");
    }

    #[test]
    fn undo_redo_undo_redo_follows_the_chain() {
        let (dir, journal) = project(&[(BUTTON, LINES)]);
        let id = commit_as(&journal, BUTTON, LINES, "a\nB\nc\nd\n", ("Header", "Fill"));

        journal.flip(&id, false).expect("undo");
        assert_eq!(read(&dir, BUTTON), LINES);
        assert!(matches!(
            journal.flip(&id, false),
            Err(CommitError::AlreadyUndone(_))
        ));
        let redone = journal.flip(&id, true).expect("redo");
        assert_eq!(redone.of, id);
        assert_eq!(read(&dir, BUTTON), "a\nB\nc\nd\n");
        assert!(matches!(
            journal.flip(&id, true),
            Err(CommitError::NotUndone(_))
        ));
        journal
            .flip(&redone.id, false)
            .expect("undo through a later link");
        assert_eq!(read(&dir, BUTTON), LINES);
        journal.flip(&id, true).expect("redo again");
        assert_eq!(read(&dir, BUTTON), "a\nB\nc\nd\n");
        let (rows, _) = journal.history(None, None, 10).expect("history");
        assert_eq!(rows.len(), 1);
        assert!(rows[0].applied);
    }

    #[test]
    fn never_deletes_a_created_file_that_was_edited_since() {
        let (dir, journal) = project(&[]);
        let new = "src/New.tsx";
        let id = journal
            .commit_with(
                &[FileChange::create(new, "made\n")],
                "ai",
                "new",
                EntryMeta::default(),
            )
            .expect("created");
        fs::write(dir.path().join(new), "made\nand mine\n").expect("edit");

        assert!(matches!(
            journal.undo(&id),
            Err(CommitError::Conflict { .. })
        ));
        assert_eq!(read(&dir, new), "made\nand mine\n");

        fs::write(dir.path().join(new), "made\n").expect("back");
        journal.undo(&id).expect("undone");
        assert!(!dir.path().join(new).exists());
        fs::write(dir.path().join(new), "someone else\n").expect("recreated");
        assert!(matches!(
            journal.flip(&id, true),
            Err(CommitError::Conflict { .. })
        ));
        assert_eq!(read(&dir, new), "someone else\n");
    }

    #[test]
    fn an_old_entry_without_its_after_version_only_undoes_while_unchanged() {
        let (dir, journal) = project(&[(BUTTON, LINES)]);
        let id = journal
            .commit(&[change(BUTTON, LINES, "a\nB\nc\nd\n")], "finetune", "old")
            .expect("committed");
        fs::remove_file(
            dir.path()
                .join(".guijam/journal/blobs")
                .join(content_hash(b"a\nB\nc\nd\n").as_str()),
        )
        .expect("old journals kept no after-version");
        fs::write(dir.path().join(BUTTON), "a\nB\nc\nmine\n").expect("edit");

        assert!(matches!(journal.undo(&id), Err(CommitError::Stale { .. })));
        fs::write(dir.path().join(BUTTON), "a\nB\nc\nd\n").expect("back");
        journal.undo(&id).expect("unchanged file undoes by hash");
        assert_eq!(read(&dir, BUTTON), LINES);
    }

    fn journal_file(dir: &tempfile::TempDir) -> std::path::PathBuf {
        fs::read_dir(dir.path().join(".guijam/journal"))
            .expect("journal dir")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "jsonl")
            })
            .expect("journal file")
    }

    #[test]
    fn history_pages_newest_first_filters_by_page_and_names_old_entries() {
        let (dir, journal) = project(&[(BUTTON, LINES)]);
        let old = journal
            .commit(
                &[change(BUTTON, LINES, "a\nB\nc\nd\n")],
                "ai",
                "src/Button.tsx:2 · Polished card (R2 · Claude Code opus)",
            )
            .expect("old entry");
        let newer = journal
            .commit_with(
                &[change(BUTTON, "a\nB\nc\nd\n", "x\na\nB\nc\nd\n")],
                "finetune",
                "added",
                meta("Header", "Text 'x'", "http://localhost:5173/menu"),
            )
            .expect("newer");
        let log = journal_file(&dir);
        let text = fs::read_to_string(&log).expect("journal text");
        fs::write(&log, format!("{text}{{\"event\":\"begin\"")).expect("half-written line");

        let (rows, more) = journal.history(None, None, 1).expect("history");
        assert!(more);
        assert_eq!(rows[0].id, newer);
        assert_eq!(rows[0].line, Some(5));
        let (rest, more) = journal.history(None, Some(&newer), 10).expect("page two");
        assert!(!more);
        assert_eq!(rest[0].id, old);
        assert_eq!(rest[0].title, "Polished card");
        let (menu, _) = journal
            .history(Some("http://localhost:5173/menu"), None, 10)
            .expect("filtered");
        assert_eq!(menu.len(), 1);
        assert_eq!(menu[0].title, "Header · Text 'x'");
    }
}
