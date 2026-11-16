//! Request handling: element inspection for the fine-tune panel, fine-tune and
//! generated previews served as in-memory overlays through the Vite plugin, and
//! journaled commits and undos.

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
    GenerateDone, GenerateDoneDroppedItem, GenerateRequest, GuijamMessage, HelloOk, OverlayClear,
    OverlaySet, Route, RouteTier, RunRef, SourceRef, UndoDone, UpdateResult, UpdateResultStatus,
    UpdateResultUpdateId, Variant, VariantPreview, VariantSelect, VariantSelected,
};
use gjd_core::journal::{CommitError, FileChange, Journal};
use gjd_core::jsx::JsxError;
use gjd_core::patch::{self, PatchError};
use gjd_core::policy::{PolicyError, ProjectRoot};
use gjd_core::style::inspect;
use gjd_core::theme::Theme;
use gjd_providers::{
    AuthStatus, Discovery, GenerationRequest, ProviderAdapter, ProviderError, ProviderId,
    ToolPolicy, adapter,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::diff::code_changes;
use crate::generate::{self, Progress, Step};

const UPDATE_TIMEOUT: Duration = Duration::from_secs(5);
/// PRD §8: a login seen within this window is not asked for again.
const AUTH_CACHE: Duration = Duration::from_mins(5);
/// Only Claude Code has an adapter so far; Codex follows its S-3 spike.
const PROVIDER: ProviderId = ProviderId::ClaudeCode;

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

impl From<ProviderError> for Failure {
    fn from(error: ProviderError) -> Self {
        let retry = "Retry, or simplify the prompt.";
        match error {
            ProviderError::NotInstalled(provider) => Self::new(
                ErrorCode::ProviderNotInstalled,
                format!("{} is not installed.", provider.display_name()),
            )
            .with_action(format!("Install with: {}", provider.install_command())),
            ProviderError::NotAuthenticated {
                provider,
                login_command,
            } => not_authenticated(provider, login_command),
            ProviderError::RateLimited => Self::new(
                ErrorCode::ProviderRateLimited,
                format!("{} is rate limited.", PROVIDER.display_name()),
            )
            .with_action("Retry in a minute."),
            ProviderError::Overloaded => Self::new(
                ErrorCode::ProviderFailed,
                format!("{} is overloaded.", PROVIDER.display_name()),
            )
            .with_action("Retry in a minute."),
            ProviderError::Timeout(limit) => Self::new(
                ErrorCode::ProviderTimeout,
                format!("No answer within {} s.", limit.as_secs()),
            )
            .with_action(retry),
            ProviderError::Cancelled => Self::new(ErrorCode::Cancelled, "Generation cancelled."),
            ProviderError::InvalidOutput(detail) => invalid_output(&detail),
            ProviderError::Crashed { .. } => Self::new(
                ErrorCode::ProviderCrashed,
                format!("{} stopped before answering.", PROVIDER.display_name()),
            )
            .with_action(retry),
            ProviderError::Failed(_) | ProviderError::Io(_) => {
                Self::new(ErrorCode::ProviderFailed, error.to_string()).with_action(retry)
            }
        }
    }
}

fn not_authenticated(provider: ProviderId, login_command: &str) -> Failure {
    Failure::new(
        ErrorCode::ProviderNotAuthenticated,
        format!("{} isn't logged in.", provider.display_name()),
    )
    .with_action(format!("Run `{login_command}` in a terminal, then retry."))
}

fn invalid_output(detail: &str) -> Failure {
    Failure::new(
        ErrorCode::ProviderInvalidOutput,
        format!("The model's answer wasn't valid edits: {detail}"),
    )
    .with_action("Retry, or simplify the prompt.")
}

/// The content of `file` after a variant's ops, which may only touch that file.
fn apply_variant(ops: &[EditOp], file: &str, current: &str) -> Result<String, Failure> {
    if ops.is_empty() || ops.len() > generate::MAX_OPS {
        return Err(invalid_output(&format!(
            "it proposed {} edits; 1 to {} are allowed",
            ops.len(),
            generate::MAX_OPS
        )));
    }
    if let Some(other) = ops
        .iter()
        .map(generate::op_file)
        .find(|op_file| *op_file != file)
    {
        return Err(invalid_output(&format!(
            "it edits {other}, which it was not shown"
        )));
    }
    let sources = BTreeMap::from([(file.to_owned(), current.to_owned())]);
    let content = patch::apply(&sources, ops)
        .map_err(model_patch_failure)?
        .remove(file)
        .unwrap_or_else(|| current.to_owned());
    if content == current {
        return Err(invalid_output("it changed nothing"));
    }
    Ok(content)
}

/// A patch error in edits the model proposed is the model's mistake, except that the
/// file may have changed while it was thinking.
fn model_patch_failure(error: PatchError) -> Failure {
    match error {
        PatchError::StaleBase { file, .. } => Failure::new(
            ErrorCode::StaleBase,
            format!("{file} changed since the AI read it."),
        )
        .with_action("Generate again."),
        other => invalid_output(&other.to_string()),
    }
}

type Validated = (Vec<(Variant, String)>, Vec<GenerateDoneDroppedItem>);

/// The variants whose edits apply to `current`, each with its new content, and why each
/// other one was dropped (FR-052). A file saved while the model worked makes every
/// variant stale, so that fails the whole run.
fn validate_variants(
    variants: Vec<Variant>,
    file: &str,
    current: &str,
) -> Result<Validated, Failure> {
    let mut valid: Vec<(Variant, String)> = Vec::new();
    let mut dropped = Vec::new();
    for variant in variants.into_iter().take(generate::VARIANTS) {
        let label = String::from(variant.label.clone());
        let reason = match apply_variant(&variant.ops, file, current) {
            Ok(content) if valid.iter().any(|(_, other)| *other == content) => {
                "It is the same as another variant.".to_owned()
            }
            Ok(content) => {
                valid.push((variant, content));
                continue;
            }
            Err(failure) if failure.code == ErrorCode::StaleBase => return Err(failure),
            Err(failure) => failure.message,
        };
        dropped.push(GenerateDoneDroppedItem {
            label: Some(label),
            reason,
        });
    }
    if valid.is_empty() {
        let reasons: Vec<&str> = dropped.iter().map(|item| item.reason.as_str()).collect();
        return Err(match reasons.as_slice() {
            [] => invalid_output("it proposed no variant"),
            _ => Failure::new(ErrorCode::ProviderInvalidOutput, reasons.join(" "))
                .with_action("Retry, or simplify the prompt."),
        });
    }
    Ok((valid, dropped))
}

fn variants_phrase(count: usize) -> String {
    if count == 1 {
        "1 variant".to_owned()
    } else {
        format!("{count} variants")
    }
}

/// The prompt as quoted in the terminal line, cut at `limit` characters.
fn quoted(prompt: &str, limit: usize) -> String {
    let mut chars = prompt.chars();
    let head: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        format!("\"{head}…\"")
    } else {
        format!("\"{head}\"")
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
    origin: &'static str,
}

/// A generation in progress, so `generate.cancel` and a newer run on the same file
/// can stop it.
struct Run {
    file: String,
    cancel: CancellationToken,
}

/// The variants a finished run left pending; at most one of them is shown.
struct VariantRun {
    file: String,
    changesets: Vec<String>,
}

/// How a variant is described to the developer, whichever route produced it.
struct Held {
    label: String,
    system: String,
    style: String,
    rationale: String,
}

impl From<Variant> for Held {
    fn from(variant: Variant) -> Self {
        Self {
            label: variant.label.into(),
            system: variant.system,
            style: variant.style.into(),
            rationale: variant.rationale.into(),
        }
    }
}

pub struct Daemon {
    project: ProjectRoot,
    journal: Arc<Journal>,
    write_lock: tokio::sync::Mutex<()>,
    tailwind_roots: Mutex<Vec<PathBuf>>,
    changesets: Mutex<HashMap<String, Changeset>>,
    overlays: Mutex<BTreeMap<String, String>>,
    plugin: Mutex<Option<PluginLink>>,
    runs: Mutex<HashMap<String, Run>>,
    variant_runs: Mutex<HashMap<String, VariantRun>>,
    provider: tokio::sync::Mutex<Option<(Discovery, Instant)>>,
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
            runs: Mutex::default(),
            variant_runs: Mutex::default(),
            provider: tokio::sync::Mutex::default(),
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
            request => Some(self.handle_request(request).await),
        }
    }

    /// Answers a request the widget sent through the plugin.
    async fn handle_request(&self, message: GuijamMessage) -> GuijamMessage {
        match message {
            GuijamMessage::ElementInspect { id, payload } => reply(
                id,
                self.inspect(&payload)
                    .await
                    .map(|style| GuijamMessage::ElementStyle {
                        id: None,
                        payload: style,
                    }),
            ),
            GuijamMessage::FinetunePreview { id, payload } => reply(
                id,
                self.preview_finetune(payload).await.map(|previewed| {
                    GuijamMessage::FinetunePreviewed {
                        id: None,
                        payload: previewed,
                    }
                }),
            ),
            GuijamMessage::ChangesetCommit { id, payload } => reply(
                id,
                self.commit(&payload.changeset_id)
                    .await
                    .map(|done| GuijamMessage::CommitDone {
                        id: None,
                        payload: done,
                    }),
            ),
            GuijamMessage::ChangesetDiscard { id, payload } => reply(
                id,
                self.discard(&payload.changeset_id).await.map(|()| {
                    GuijamMessage::ChangesetDiscarded {
                        id: None,
                        payload: payload.clone(),
                    }
                }),
            ),
            GuijamMessage::JournalUndo { id, payload } => reply(
                id,
                self.undo(payload.journal_id)
                    .await
                    .map(|done| GuijamMessage::UndoDone {
                        id: None,
                        payload: done,
                    }),
            ),
            GuijamMessage::GenerateRequest { id, payload } => reply(
                id,
                self.generate(payload)
                    .await
                    .map(|done| GuijamMessage::GenerateDone {
                        id: None,
                        payload: done,
                    }),
            ),
            GuijamMessage::GenerateCancel { id, payload } => self.cancel_run(id, payload),
            GuijamMessage::VariantSelect { id, payload } => reply(
                id,
                self.select_variant(payload)
                    .await
                    .map(|selected| GuijamMessage::VariantSelected {
                        id: None,
                        payload: selected,
                    }),
            ),
            GuijamMessage::GenerateDiscard { id, payload } => reply(
                id,
                self.discard_run(&payload.run_id)
                    .await
                    .map(|()| GuijamMessage::GenerateDiscarded { id: None, payload }),
            ),
            GuijamMessage::PluginHello { id, .. }
            | GuijamMessage::TailwindRoots { id, .. }
            | GuijamMessage::UpdateResult { id, .. }
            | GuijamMessage::HelloOk { id, .. }
            | GuijamMessage::GenerateDone { id, .. }
            | GuijamMessage::GenerateProgress { id, .. }
            | GuijamMessage::VariantSelected { id, .. }
            | GuijamMessage::GenerateDiscarded { id, .. }
            | GuijamMessage::GenerateCancelled { id, .. }
            | GuijamMessage::OverlaySet { id, .. }
            | GuijamMessage::OverlayClear { id, .. }
            | GuijamMessage::ElementStyle { id, .. }
            | GuijamMessage::FinetunePreviewed { id, .. }
            | GuijamMessage::CommitDone { id, .. }
            | GuijamMessage::ChangesetDiscarded { id, .. }
            | GuijamMessage::UndoDone { id, .. }
            | GuijamMessage::Error { id, .. } => Failure::new(
                ErrorCode::InvalidRequest,
                "the daemon does not accept this message",
            )
            .into_message(id),
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
            "finetune",
        );
        let shown = (content != source).then_some(content.as_str());
        let update = self.show(&file, shown).await?;
        Ok(FinetunePreviewed {
            changeset_id,
            update,
            changes,
        })
    }

    /// Stops a generation if it is still running; cancelling a finished run is a no-op.
    fn cancel_run(&self, id: Option<String>, run: RunRef) -> GuijamMessage {
        if let Some(running) = locked(&self.runs).get(&run.run_id) {
            running.cancel.cancel();
        }
        GuijamMessage::GenerateCancelled { id, payload: run }
    }

    /// Runs `request` under a cancellation token that `generate.cancel` can reach. A
    /// newer request on the same file replaces the older run and its variants
    /// (NFR-CON-02).
    async fn generate(&self, request: GenerateRequest) -> Result<GenerateDone, Failure> {
        let run_id = request.run_id.clone();
        let cancel = CancellationToken::new();
        {
            let mut runs = locked(&self.runs);
            if runs.contains_key(&run_id) {
                return Err(Failure::invalid_request(format!(
                    "run {run_id} is already in progress"
                )));
            }
            for older in runs.values().filter(|run| run.file == request.file) {
                older.cancel.cancel();
            }
            runs.insert(
                run_id.clone(),
                Run {
                    file: request.file.clone(),
                    cancel: cancel.clone(),
                },
            );
        }
        let superseded: Vec<String> = locked(&self.variant_runs)
            .iter()
            .filter(|(_, run)| run.file == request.file)
            .map(|(id, _)| id.clone())
            .collect();
        for older in superseded {
            self.discard_run(&older).await?;
        }
        let result = self.run_generation(request, &cancel).await;
        locked(&self.runs).remove(&run_id);
        result
    }

    /// Sends the run's step list to the page that asked; a missing plugin only costs
    /// the progress display.
    fn report(&self, progress: &Progress) {
        if let Some(link) = locked(&self.plugin).clone() {
            let _ = link.send(GuijamMessage::GenerateProgress {
                id: None,
                payload: progress.snapshot(),
            });
        }
    }

    fn stylesheet_names(&self) -> Vec<String> {
        locked(&self.tailwind_roots)
            .iter()
            .filter_map(|path| path.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .collect()
    }

    async fn select_variant(&self, request: VariantSelect) -> Result<VariantSelected, Failure> {
        let (file, content) = {
            let runs = locked(&self.variant_runs);
            let run = runs
                .get(&request.run_id)
                .filter(|run| run.changesets.contains(&request.changeset_id))
                .ok_or_else(|| unknown_changeset(&request.changeset_id))?;
            let changesets = locked(&self.changesets);
            let content = changesets
                .get(&request.changeset_id)
                .and_then(|changeset| changeset.files.get(&run.file))
                .map(|version| version.content.clone())
                .ok_or_else(|| unknown_changeset(&request.changeset_id))?;
            (run.file.clone(), content)
        };
        let update = self.show(&file, Some(&content)).await?;
        Ok(VariantSelected {
            changeset_id: request.changeset_id,
            update,
        })
    }

    /// Drops a run's variants and shows the file from disk again. A run that is gone
    /// already (used, discarded or replaced) is not an error.
    async fn discard_run(&self, run_id: &str) -> Result<(), Failure> {
        let Some(run) = locked(&self.variant_runs).remove(run_id) else {
            return Ok(());
        };
        {
            let mut changesets = locked(&self.changesets);
            for id in &run.changesets {
                changesets.remove(id);
            }
        }
        self.show(&run.file, None).await?;
        Ok(())
    }

    /// Ends the variant run `changeset_id` belongs to and drops its other variants.
    fn settle_variant_run(&self, changeset_id: &str) {
        let siblings = {
            let mut runs = locked(&self.variant_runs);
            let run_id = runs
                .iter()
                .find(|(_, run)| run.changesets.iter().any(|id| id == changeset_id))
                .map(|(id, _)| id.clone());
            run_id
                .and_then(|id| runs.remove(&id))
                .map(|run| run.changesets)
        };
        let mut changesets = locked(&self.changesets);
        for id in siblings.unwrap_or_default() {
            if id != changeset_id {
                changesets.remove(&id);
            }
        }
    }

    async fn run_generation(
        &self,
        request: GenerateRequest,
        cancel: &CancellationToken,
    ) -> Result<GenerateDone, Failure> {
        let started = Instant::now();
        let prompt = request.prompt.trim();
        if prompt.is_empty() {
            return Err(Failure::invalid_request("describe the change first"));
        }
        let file = request.file.as_str();
        let source = self.read_project_file(file).await?;
        let theme = self.theme().await;
        let style = inspect(file, &source, request.line, request.column, &theme)?;
        let (provider, discovery) = self.provider().await?;
        let provider_name = provider.id().display_name();
        let mut progress = Progress::new(
            &request.run_id,
            &style,
            &self.stylesheet_names(),
            provider_name,
            generate::MODEL,
        );
        progress.start(Step::Ask);
        self.report(&progress);

        let generation = GenerationRequest {
            model: Some(generate::MODEL.to_owned()),
            system_prompt: generate::SYSTEM_PROMPT.to_owned(),
            user_prompt: generate::user_prompt(&style, &source, prompt),
            images: Vec::new(),
            tools: ToolPolicy::None,
            timeout: generate::TIMEOUT,
            cwd: self.project.path().to_path_buf(),
        };
        let proposed = self.ask(&*provider, &discovery, generation, cancel).await?;
        let checked = variants_phrase(proposed.len().min(generate::VARIANTS));
        progress.relabel(Step::Check, format!("Checking {checked}"));
        progress.start(Step::Check);
        self.report(&progress);
        // Read again: the developer may have saved the file while the model was working.
        let current = self.read_project_file(file).await?;
        let (valid, dropped) = validate_variants(proposed, file, &current)?;
        if cancel.is_cancelled() {
            return Err(ProviderError::Cancelled.into());
        }

        let route_label = format!("R1 · {provider_name} {}", generate::MODEL);
        let held = valid
            .into_iter()
            .map(|(variant, content)| (Held::from(variant), content))
            .collect();
        let (variants, first) = self.hold_variants(&request, &current, held, &route_label);
        progress.start(Step::Preview);
        self.report(&progress);
        let update = self
            .preview_run(&request.run_id, file, &first, cancel)
            .await?;

        let summary = format!(
            "{} → {} for <{}> {file}:{} ({route_label})",
            quoted(prompt, 60),
            variants_phrase(variants.len()),
            style.tag,
            request.line,
        );
        Ok(GenerateDone {
            run_id: request.run_id,
            route: Route {
                tier: RouteTier::R1,
                provider: Some(provider_name.to_owned()),
                model: Some(generate::MODEL.to_owned()),
                notice: None,
            },
            summary,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            variants,
            dropped,
            update,
        })
    }

    /// Runs the provider and returns the variants it proposed. A login failure forgets
    /// the cached login, so the next request checks it again.
    async fn ask(
        &self,
        provider: &dyn ProviderAdapter,
        discovery: &Discovery,
        request: GenerationRequest,
        cancel: &CancellationToken,
    ) -> Result<Vec<Variant>, Failure> {
        match provider.generate(discovery, request, cancel.clone()).await {
            Ok(output) => Ok(output.variant_set.variants),
            Err(error @ ProviderError::NotAuthenticated { .. }) => {
                *self.provider.lock().await = None;
                Err(error.into())
            }
            Err(error) => Err(error.into()),
        }
    }

    /// Keeps each variant as a pending changeset and registers them as the run of
    /// `request`. Returns what the widget shows and the first variant's content.
    fn hold_variants(
        &self,
        request: &GenerateRequest,
        current: &str,
        held: Vec<(Held, String)>,
        route_label: &str,
    ) -> (Vec<VariantPreview>, String) {
        let file = &request.file;
        let first = held
            .first()
            .map_or_else(String::new, |(_, content)| content.clone());
        let variants: Vec<VariantPreview> = held
            .into_iter()
            .map(|(variant, content)| {
                let summary = format!(
                    "{file}:{} — {} ({route_label})",
                    request.line, variant.label
                );
                let changes = code_changes(file, current, &content);
                let changeset_id = self.store_changeset(
                    None,
                    BTreeMap::from([(
                        file.clone(),
                        Version {
                            base: current.to_owned(),
                            content,
                        },
                    )]),
                    summary,
                    "ai",
                );
                VariantPreview {
                    changes,
                    changeset_id,
                    file: file.clone(),
                    label: variant.label,
                    rationale: variant.rationale,
                    style: variant.style,
                    system: variant.system,
                }
            })
            .collect();
        locked(&self.variant_runs).insert(
            request.run_id.clone(),
            VariantRun {
                file: file.clone(),
                changesets: variants
                    .iter()
                    .map(|variant| variant.changeset_id.clone())
                    .collect(),
            },
        );
        (variants, first)
    }

    /// Shows the run's first variant. If that fails, or the run was cancelled
    /// meanwhile, the run's variants are dropped and the file shows from disk again.
    async fn preview_run(
        &self,
        run_id: &str,
        file: &str,
        content: &str,
        cancel: &CancellationToken,
    ) -> Result<UpdateResult, Failure> {
        let update = self.show(file, Some(content)).await;
        if update.is_err() || cancel.is_cancelled() {
            self.discard_run(run_id).await?;
        }
        let update = update?;
        if cancel.is_cancelled() {
            return Err(ProviderError::Cancelled.into());
        }
        Ok(update)
    }

    /// The provider CLI and its discovery, with the login checked at most every
    /// `AUTH_CACHE` (and again after any authentication failure).
    async fn provider(&self) -> Result<(Box<dyn ProviderAdapter>, Discovery), Failure> {
        let provider = adapter(PROVIDER).ok_or_else(|| {
            Failure::new(
                ErrorCode::ProviderNotInstalled,
                format!("{} is not supported yet.", PROVIDER.display_name()),
            )
        })?;
        let mut ready = self.provider.lock().await;
        if let Some((discovery, checked)) = ready.as_ref()
            && checked.elapsed() < AUTH_CACHE
        {
            return Ok((provider, discovery.clone()));
        }
        let discovery = provider.discover().await?;
        match provider.check_auth(&discovery).await {
            AuthStatus::LoggedIn => *ready = Some((discovery.clone(), Instant::now())),
            AuthStatus::NotLoggedIn { login_command } => {
                return Err(not_authenticated(provider.id(), login_command));
            }
            // A run that is not logged in still fails with a clear error of its own.
            AuthStatus::Unknown { reason } => {
                tracing::warn!(%reason, "could not read the provider's login status");
            }
        }
        Ok((provider, discovery))
    }

    /// Keeps one fine-tune changeset per element, so each preview replaces the last.
    fn store_changeset(
        &self,
        element: Option<(String, NonZeroU64, NonZeroU64)>,
        files: BTreeMap<String, Version>,
        summary: String,
        origin: &'static str,
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
                origin,
            },
        );
        id
    }

    async fn commit(&self, changeset_id: &str) -> Result<CommitDone, Failure> {
        self.settle_variant_run(changeset_id);
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
            let origin = changeset.origin;
            tokio::task::spawn_blocking(move || journal.commit(&changes, origin, &summary)).await
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
        | GuijamMessage::GenerateRequest { id, .. }
        | GuijamMessage::GenerateDone { id, .. }
        | GuijamMessage::GenerateCancel { id, .. }
        | GuijamMessage::GenerateCancelled { id, .. }
        | GuijamMessage::GenerateProgress { id, .. }
        | GuijamMessage::VariantSelect { id, .. }
        | GuijamMessage::VariantSelected { id, .. }
        | GuijamMessage::GenerateDiscard { id, .. }
        | GuijamMessage::GenerateDiscarded { id, .. }
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

#[cfg(test)]
mod tests {
    use gjd_core::content_hash;
    use gjd_core::contracts::{EditOp, ErrorCode};
    use serde_json::json;

    use super::{apply_variant, validate_variants};

    fn variant(label: &str, ops: &[EditOp]) -> gjd_core::contracts::Variant {
        serde_json::from_value(json!({
            "label": label, "system": "Your project", "style": label, "rationale": "r",
            "missing": [], "ops": ops,
        }))
        .expect("valid variant")
    }

    #[test]
    fn keeps_variants_that_apply_and_says_why_others_were_dropped() {
        let proposed = vec![
            variant("Sea", &[snippet(FILE, SOURCE, "bg-brand", "bg-sea")]),
            variant("Lost", &[snippet(FILE, SOURCE, "bg-nowhere", "bg-sky")]),
            variant("Sea again", &[snippet(FILE, SOURCE, "bg-brand", "bg-sea")]),
            variant("Fourth", &[snippet(FILE, SOURCE, "p-2", "p-4")]),
        ];

        let (valid, dropped) = validate_variants(proposed, FILE, SOURCE).expect("one survives");

        let kept: Vec<String> = valid
            .iter()
            .map(|(variant, _)| String::from(variant.label.clone()))
            .collect();
        assert_eq!(kept, ["Sea"]);
        let reasons: Vec<(Option<&str>, &str)> = dropped
            .iter()
            .map(|item| (item.label.as_deref(), item.reason.as_str()))
            .collect();
        assert_eq!(
            reasons.len(),
            2,
            "the fourth variant is past the limit: {reasons:?}"
        );
        assert_eq!(reasons[0].0, Some("Lost"));
        assert!(reasons[0].1.contains("occurs 0 times"), "{}", reasons[0].1);
        assert_eq!(
            reasons[1],
            (Some("Sea again"), "It is the same as another variant.")
        );
    }

    #[test]
    fn fails_when_no_variant_applies_or_the_file_changed() {
        let lost = vec![variant(
            "Lost",
            &[snippet(FILE, SOURCE, "bg-nowhere", "bg-sky")],
        )];
        let failure = validate_variants(lost, FILE, SOURCE).expect_err("none survive");
        assert_eq!(failure.code, ErrorCode::ProviderInvalidOutput);

        let saved = SOURCE.replace("p-2", "p-4");
        let stale = vec![variant(
            "Sea",
            &[snippet(FILE, SOURCE, "bg-brand", "bg-sea")],
        )];
        let failure = validate_variants(stale, FILE, &saved).expect_err("stale");
        assert_eq!(failure.code, ErrorCode::StaleBase);
    }

    const FILE: &str = "src/B.tsx";
    const SOURCE: &str = "export const B = () => <b className=\"bg-brand p-2\" />;\n";

    fn snippet(file: &str, base: &str, find: &str, replace: &str) -> EditOp {
        serde_json::from_value(json!({
            "kind": "replace_snippet", "file": file,
            "base_hash": content_hash(base.as_bytes()).as_str(), "find": find, "replace": replace,
        }))
        .expect("valid op")
    }

    #[test]
    fn applies_a_variant_to_the_file_it_was_shown() {
        let ops = [snippet(FILE, SOURCE, "bg-brand", "bg-sea")];

        let content = apply_variant(&ops, FILE, SOURCE).expect("applied");

        assert_eq!(content, SOURCE.replace("bg-brand", "bg-sea"));
    }

    #[test]
    fn rejects_edits_to_other_files_no_edits_and_no_change() {
        let elsewhere = [snippet("src/Other.tsx", SOURCE, "bg-brand", "bg-sea")];
        let unchanged = [snippet(FILE, SOURCE, "bg-brand", "bg-brand")];

        for ops in [&elsewhere[..], &[], &unchanged[..]] {
            let failure = apply_variant(ops, FILE, SOURCE).expect_err("rejected");
            assert_eq!(failure.code, ErrorCode::ProviderInvalidOutput);
        }
    }

    #[test]
    fn reports_a_file_saved_while_the_model_worked_as_stale() {
        let ops = [snippet(FILE, SOURCE, "bg-brand", "bg-sea")];
        let saved = SOURCE.replace("p-2", "p-4");

        let failure = apply_variant(&ops, FILE, &saved).expect_err("stale");

        assert_eq!(failure.code, ErrorCode::StaleBase);
        assert_eq!(failure.message, "src/B.tsx changed since the AI read it.");
    }
}
