//! Request handling: element inspection for the fine-tune panel, previews served as
//! in-memory overlays through the Vite plugin, and journaled commits and undos.

use std::collections::{BTreeMap, HashMap};
use std::num::NonZeroU64;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use gjd_core::codemod::{CodemodError, finetune_op};
use gjd_core::content_hash;
use gjd_core::contracts::{
    CodeChange, CommitDone, EditOp, ErrorCode, ErrorPayload, FinetunePreview, FinetunePreviewed,
    GuijamMessage, HelloOk, OverlayClear, OverlaySet, SourceRef, UndoDone, UpdateResult,
    UpdateResultStatus, UpdateResultUpdateId,
};
use gjd_core::journal::{CommitError, FileChange, Journal};
use gjd_core::jsx::JsxError;
use gjd_core::patch::{self, PatchError};
use gjd_core::policy::{PolicyError, ProjectRoot};
use gjd_core::style::inspect;
use gjd_core::theme::Theme;
use tokio::sync::{mpsc, oneshot};

use crate::diff::code_changes;

const UPDATE_TIMEOUT: Duration = Duration::from_secs(5);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // Every critical section only swaps plain data, so a panic elsewhere cannot leave
    // the value half-updated.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Debug)]
pub struct ConnectionClosed;

/// One Vite plugin connection: messages to send it, and overlay requests awaiting
/// the plugin's `update.result`.
#[derive(Clone)]
pub struct PluginLink {
    outbox: mpsc::UnboundedSender<GuijamMessage>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<UpdateResult>>>>,
}

impl PluginLink {
    #[must_use]
    pub fn new(outbox: mpsc::UnboundedSender<GuijamMessage>) -> Self {
        Self {
            outbox,
            pending: Arc::default(),
        }
    }

    /// Fails only when the plugin has disconnected.
    pub fn send(&self, message: GuijamMessage) -> Result<(), ConnectionClosed> {
        self.outbox.send(message).map_err(|_| ConnectionClosed)
    }

    fn same(&self, other: &Self) -> bool {
        self.outbox.same_channel(&other.outbox)
    }
}

#[derive(Debug)]
pub struct Failure {
    code: ErrorCode,
    message: String,
    action: Option<String>,
}

impl Failure {
    fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            action: None,
        }
    }

    fn with_action(mut self, action: impl Into<String>) -> Self {
        self.action = Some(action.into());
        self
    }

    #[must_use]
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidRequest, message)
    }

    fn plugin_unavailable() -> Self {
        Self::new(
            ErrorCode::PluginUnavailable,
            "The Vite dev server is not connected to the GUIJam daemon.",
        )
        .with_action("Restart the dev server, then try again.")
    }

    #[must_use]
    pub fn into_message(self, id: Option<String>) -> GuijamMessage {
        GuijamMessage::Error {
            id,
            payload: ErrorPayload {
                code: self.code,
                message: self.message,
                action: self.action,
            },
        }
    }
}

impl From<JsxError> for Failure {
    fn from(error: JsxError) -> Self {
        Self::new(ErrorCode::InvalidRequest, error.to_string())
    }
}

impl From<CodemodError> for Failure {
    fn from(error: CodemodError) -> Self {
        match error {
            CodemodError::NotEditable => Self::new(ErrorCode::NotEditable, error.to_string())
                .with_action("Use Ask AI to change this element."),
            other => Self::new(ErrorCode::InvalidRequest, other.to_string()),
        }
    }
}

impl From<PatchError> for Failure {
    fn from(error: PatchError) -> Self {
        let code = match error {
            PatchError::StaleBase { .. } => ErrorCode::StaleBase,
            PatchError::NotEditable { .. } => ErrorCode::NotEditable,
            _ => ErrorCode::InvalidRequest,
        };
        Self::new(code, error.to_string())
    }
}

impl From<PolicyError> for Failure {
    fn from(error: PolicyError) -> Self {
        Self::new(ErrorCode::PathDenied, error.to_string())
    }
}

impl From<CommitError> for Failure {
    fn from(error: CommitError) -> Self {
        match error {
            CommitError::Conflict { ref path } => {
                let action = format!(
                    "Your edits to {path} conflict with this change. Review them, then preview again."
                );
                Self::new(ErrorCode::Conflict, error.to_string()).with_action(action)
            }
            CommitError::Policy(policy) => policy.into(),
            CommitError::UnknownEntry(_) => Self::new(ErrorCode::UnknownEntry, error.to_string()),
            CommitError::AlreadyUndone(_) => Self::new(ErrorCode::AlreadyUndone, error.to_string()),
            CommitError::Corrupt(_) | CommitError::Io(_) => {
                Self::new(ErrorCode::Internal, error.to_string())
            }
        }
    }
}

impl From<std::io::Error> for Failure {
    fn from(error: std::io::Error) -> Self {
        Self::new(ErrorCode::Internal, error.to_string())
    }
}

struct Version {
    base: String,
    content: String,
}

struct Changeset {
    element: Option<(String, NonZeroU64, NonZeroU64)>,
    files: BTreeMap<String, Version>,
    summary: String,
}

pub struct Daemon {
    project: ProjectRoot,
    journal: Arc<Journal>,
    write_lock: tokio::sync::Mutex<()>,
    tailwind_roots: Mutex<Vec<PathBuf>>,
    changesets: Mutex<HashMap<String, Changeset>>,
    overlays: Mutex<BTreeMap<String, String>>,
    plugin: Mutex<Option<PluginLink>>,
    next_id: AtomicU64,
    connections: AtomicUsize,
    last_disconnect: Mutex<Instant>,
}

impl Daemon {
    #[must_use]
    pub fn new(project: ProjectRoot, journal: Journal) -> Self {
        Self {
            project,
            journal: Arc::new(journal),
            write_lock: tokio::sync::Mutex::new(()),
            tailwind_roots: Mutex::default(),
            changesets: Mutex::default(),
            overlays: Mutex::default(),
            plugin: Mutex::default(),
            next_id: AtomicU64::new(1),
            connections: AtomicUsize::new(0),
            last_disconnect: Mutex::new(Instant::now()),
        }
    }

    pub fn connected(&self) {
        self.connections.fetch_add(1, Ordering::SeqCst);
    }

    pub fn disconnected(&self, link: &PluginLink) {
        self.connections.fetch_sub(1, Ordering::SeqCst);
        *locked(&self.last_disconnect) = Instant::now();
        let mut plugin = locked(&self.plugin);
        if plugin.as_ref().is_some_and(|current| current.same(link)) {
            *plugin = None;
        }
    }

    /// How long the daemon has had no client, or `None` while one is connected.
    #[must_use]
    pub fn idle_for(&self) -> Option<Duration> {
        (self.connections.load(Ordering::SeqCst) == 0)
            .then(|| locked(&self.last_disconnect).elapsed())
    }

    fn new_id(&self, prefix: &str) -> String {
        format!("{prefix}{}", self.next_id.fetch_add(1, Ordering::SeqCst))
    }

    /// Handles one message from a plugin connection and returns the reply, if any.
    pub async fn handle(&self, message: GuijamMessage, link: &PluginLink) -> Option<GuijamMessage> {
        match message {
            GuijamMessage::PluginHello { id, payload } => {
                self.set_tailwind_roots(&payload.tailwind_roots);
                *locked(&self.plugin) = Some(link.clone());
                self.resend_overlays(link);
                Some(GuijamMessage::HelloOk {
                    id,
                    payload: HelloOk {
                        daemon_version: env!("CARGO_PKG_VERSION").to_owned(),
                    },
                })
            }
            GuijamMessage::TailwindRoots { payload, .. } => {
                self.set_tailwind_roots(&payload.files);
                None
            }
            GuijamMessage::UpdateResult { id, payload } => {
                let waiter = id.and_then(|id| locked(&link.pending).remove(&id));
                if let Some(waiter) = waiter {
                    // The requester may have timed out already; then the result is moot.
                    let _ = waiter.send(payload);
                }
                None
            }
            GuijamMessage::ElementInspect { id, payload } => Some(reply(
                id,
                self.inspect(&payload)
                    .await
                    .map(|style| GuijamMessage::ElementStyle {
                        id: None,
                        payload: style,
                    }),
            )),
            GuijamMessage::FinetunePreview { id, payload } => Some(reply(
                id,
                self.preview_finetune(payload).await.map(|previewed| {
                    GuijamMessage::FinetunePreviewed {
                        id: None,
                        payload: previewed,
                    }
                }),
            )),
            GuijamMessage::ChangesetCommit { id, payload } => Some(reply(
                id,
                self.commit(&payload.changeset_id)
                    .await
                    .map(|done| GuijamMessage::CommitDone {
                        id: None,
                        payload: done,
                    }),
            )),
            GuijamMessage::ChangesetDiscard { id, payload } => Some(reply(
                id,
                self.discard(&payload.changeset_id).await.map(|()| {
                    GuijamMessage::ChangesetDiscarded {
                        id: None,
                        payload: payload.clone(),
                    }
                }),
            )),
            GuijamMessage::JournalUndo { id, payload } => Some(reply(
                id,
                self.undo(payload.journal_id)
                    .await
                    .map(|done| GuijamMessage::UndoDone {
                        id: None,
                        payload: done,
                    }),
            )),
            GuijamMessage::HelloOk { id, .. }
            | GuijamMessage::OverlaySet { id, .. }
            | GuijamMessage::OverlayClear { id, .. }
            | GuijamMessage::ElementStyle { id, .. }
            | GuijamMessage::FinetunePreviewed { id, .. }
            | GuijamMessage::CommitDone { id, .. }
            | GuijamMessage::ChangesetDiscarded { id, .. }
            | GuijamMessage::UndoDone { id, .. }
            | GuijamMessage::Error { id, .. } => Some(
                Failure::new(
                    ErrorCode::InvalidRequest,
                    "the daemon does not accept this message",
                )
                .into_message(id),
            ),
        }
    }

    fn set_tailwind_roots(&self, files: &[String]) {
        let inside: Vec<PathBuf> = files
            .iter()
            .map(PathBuf::from)
            .filter(|path| path.starts_with(self.project.path()))
            .collect();
        *locked(&self.tailwind_roots) = inside;
    }

    async fn theme(&self) -> Theme {
        let roots = locked(&self.tailwind_roots).clone();
        let mut stylesheets = Vec::with_capacity(roots.len());
        for root in roots {
            // A stylesheet that disappeared only costs token labels, not correctness.
            if let Ok(css) = tokio::fs::read_to_string(&root).await {
                stylesheets.push(css);
            }
        }
        Theme::from_css(stylesheets.iter().map(String::as_str))
    }

    async fn read_project_file(&self, file: &str) -> Result<String, Failure> {
        let path = self.project.resolve(file)?;
        Ok(tokio::fs::read_to_string(path).await?)
    }

    async fn inspect(
        &self,
        source_ref: &SourceRef,
    ) -> Result<gjd_core::contracts::ElementStyle, Failure> {
        let source = self.read_project_file(&source_ref.file).await?;
        let theme = self.theme().await;
        Ok(inspect(
            &source_ref.file,
            &source,
            source_ref.line,
            source_ref.column,
            &theme,
        )?)
    }

    async fn preview_finetune(
        &self,
        request: FinetunePreview,
    ) -> Result<FinetunePreviewed, Failure> {
        let file = request.file;
        let source = self.read_project_file(&file).await?;
        let theme = self.theme().await;
        let style = inspect(&file, &source, request.line, request.column, &theme)?;
        let op = finetune_op(&style, &request.props, &theme)?;
        let summary = summarize(&file, request.line, &op);
        let sources = BTreeMap::from([(file.clone(), source.clone())]);
        let content = patch::apply(&sources, std::slice::from_ref(&op))?
            .remove(&file)
            .unwrap_or_else(|| source.clone());

        let changes: Vec<CodeChange> = code_changes(&file, &source, &content);
        let element = (file.clone(), request.line, request.column);
        let changeset_id = self.store_changeset(
            Some(element),
            BTreeMap::from([(
                file.clone(),
                Version {
                    base: source.clone(),
                    content: content.clone(),
                },
            )]),
            summary,
        );
        let shown = (content != source).then_some(content.as_str());
        let update = self.show(&file, shown).await?;
        Ok(FinetunePreviewed {
            changeset_id,
            update,
            changes,
        })
    }

    /// Keeps one fine-tune changeset per element, so each preview replaces the last.
    fn store_changeset(
        &self,
        element: Option<(String, NonZeroU64, NonZeroU64)>,
        files: BTreeMap<String, Version>,
        summary: String,
    ) -> String {
        let mut changesets = locked(&self.changesets);
        let existing = element.as_ref().and_then(|element| {
            changesets
                .iter()
                .find(|(_, changeset)| changeset.element.as_ref() == Some(element))
                .map(|(id, _)| id.clone())
        });
        let id = existing.unwrap_or_else(|| self.new_id("c"));
        changesets.insert(
            id.clone(),
            Changeset {
                element,
                files,
                summary,
            },
        );
        id
    }

    async fn commit(&self, changeset_id: &str) -> Result<CommitDone, Failure> {
        let changeset = locked(&self.changesets)
            .remove(changeset_id)
            .ok_or_else(|| unknown_changeset(changeset_id))?;
        let files: Vec<String> = changeset.files.keys().cloned().collect();
        let changes: Vec<FileChange> = changeset
            .files
            .iter()
            .filter(|(_, version)| version.base != version.content)
            .map(|(path, version)| FileChange {
                path: path.clone(),
                expected_hash: content_hash(version.base.as_bytes()),
                content: version.content.clone(),
            })
            .collect();
        if changes.is_empty() {
            return Err(Failure::new(
                ErrorCode::InvalidRequest,
                "this change has nothing to apply",
            ));
        }

        let result = {
            let _write = self.write_lock.lock().await;
            let journal = Arc::clone(&self.journal);
            let summary = changeset.summary.clone();
            tokio::task::spawn_blocking(move || journal.commit(&changes, "finetune", &summary))
                .await
        };
        // Cleared after the rename, so Vite's reload from disk shows the same content.
        // On a conflict this reveals the developer's version on disk.
        for file in &files {
            self.show(file, None).await?;
        }
        let journal_id =
            result.map_err(|error| Failure::new(ErrorCode::Internal, error.to_string()))??;
        Ok(CommitDone {
            journal_id,
            files,
            summary: changeset.summary,
        })
    }

    async fn discard(&self, changeset_id: &str) -> Result<(), Failure> {
        let changeset = locked(&self.changesets)
            .remove(changeset_id)
            .ok_or_else(|| unknown_changeset(changeset_id))?;
        for file in changeset.files.keys() {
            self.show(file, None).await?;
        }
        Ok(())
    }

    async fn undo(&self, journal_id: String) -> Result<UndoDone, Failure> {
        let _write = self.write_lock.lock().await;
        let journal = Arc::clone(&self.journal);
        let target = journal_id.clone();
        let undo_id = tokio::task::spawn_blocking(move || journal.undo(&target))
            .await
            .map_err(|error| Failure::new(ErrorCode::Internal, error.to_string()))??;
        Ok(UndoDone {
            journal_id: undo_id,
            undo_of: journal_id,
        })
    }

    /// Shows `content` in place of `file` in the running app, or the file on disk
    /// again when `content` is `None`, and waits for the plugin's HMR result.
    async fn show(&self, file: &str, content: Option<&str>) -> Result<UpdateResult, Failure> {
        let link = locked(&self.plugin)
            .clone()
            .ok_or_else(Failure::plugin_unavailable)?;
        {
            let mut overlays = locked(&self.overlays);
            match content {
                Some(content) => overlays.insert(file.to_owned(), content.to_owned()),
                None => overlays.remove(file),
            };
        }
        let id = self.new_id("d");
        let (waiter, result) = oneshot::channel();
        locked(&link.pending).insert(id.clone(), waiter);
        let message = overlay_message(Some(id.clone()), file, content);
        if link.send(message).is_err() {
            locked(&link.pending).remove(&id);
            return Err(Failure::plugin_unavailable());
        }
        if let Ok(Ok(update)) = tokio::time::timeout(UPDATE_TIMEOUT, result).await {
            return Ok(update);
        }
        locked(&link.pending).remove(&id);
        Ok(UpdateResult {
            update_id: UpdateResultUpdateId::try_from(id.as_str())
                .unwrap_or_else(|_| unreachable!("request ids are non-empty")),
            status: UpdateResultStatus::Timeout,
            latency_ms: duration_ms(UPDATE_TIMEOUT),
            errors: Vec::new(),
        })
    }

    /// A reconnecting plugin starts with no overlays; send the current ones again.
    fn resend_overlays(&self, link: &PluginLink) {
        let overlays = locked(&self.overlays).clone();
        for (file, content) in overlays {
            let id = self.new_id("d");
            // A closed link gets every overlay again on its next hello.
            let _ = link.send(overlay_message(Some(id), &file, Some(&content)));
        }
    }
}

fn overlay_message(id: Option<String>, file: &str, content: Option<&str>) -> GuijamMessage {
    match content {
        Some(content) => GuijamMessage::OverlaySet {
            id,
            payload: OverlaySet {
                file: file.to_owned(),
                content: content.to_owned(),
            },
        },
        None => GuijamMessage::OverlayClear {
            id,
            payload: OverlayClear {
                file: file.to_owned(),
            },
        },
    }
}

fn reply(id: Option<String>, result: Result<GuijamMessage, Failure>) -> GuijamMessage {
    match result {
        Ok(message) => with_id(message, id),
        Err(failure) => failure.into_message(id),
    }
}

fn with_id(mut message: GuijamMessage, reply_to: Option<String>) -> GuijamMessage {
    match &mut message {
        GuijamMessage::PluginHello { id, .. }
        | GuijamMessage::HelloOk { id, .. }
        | GuijamMessage::TailwindRoots { id, .. }
        | GuijamMessage::OverlaySet { id, .. }
        | GuijamMessage::OverlayClear { id, .. }
        | GuijamMessage::UpdateResult { id, .. }
        | GuijamMessage::ElementInspect { id, .. }
        | GuijamMessage::ElementStyle { id, .. }
        | GuijamMessage::FinetunePreview { id, .. }
        | GuijamMessage::FinetunePreviewed { id, .. }
        | GuijamMessage::ChangesetCommit { id, .. }
        | GuijamMessage::CommitDone { id, .. }
        | GuijamMessage::ChangesetDiscard { id, .. }
        | GuijamMessage::ChangesetDiscarded { id, .. }
        | GuijamMessage::JournalUndo { id, .. }
        | GuijamMessage::UndoDone { id, .. }
        | GuijamMessage::Error { id, .. } => *id = reply_to,
    }
    message
}

fn unknown_changeset(id: &str) -> Failure {
    Failure::new(
        ErrorCode::UnknownChangeset,
        format!("change {id} is no longer pending"),
    )
    .with_action("Preview the change again.")
}

fn duration_ms(duration: Duration) -> f64 {
    f64::from(u32::try_from(duration.as_millis()).unwrap_or(u32::MAX))
}

/// One line for the terminal and the journal: `src/A.tsx:3 — bg-brand → bg-[#1D4ED8]`.
fn summarize(file: &str, line: NonZeroU64, op: &EditOp) -> String {
    let EditOp::ClassTokens { add, remove, .. } = op else {
        return format!("{file}:{line}");
    };
    let join = |tokens: Vec<&str>| tokens.join(" ");
    let added = join(add.iter().map(|token| token.as_str()).collect());
    let removed = join(remove.iter().map(|token| token.as_str()).collect());
    let change = match (removed.is_empty(), added.is_empty()) {
        (false, false) => format!("{removed} → {added}"),
        (true, false) => format!("+ {added}"),
        (false, true) => format!("− {removed}"),
        (true, true) => "no change".to_owned(),
    };
    format!("{file}:{line} — {change}")
}
