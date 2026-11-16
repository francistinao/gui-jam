use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::num::NonZeroU64;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use gjd_core::codemod::{CodemodError, finetune_op};
use gjd_core::content_hash;
use gjd_core::contracts::{
    CodeChange, CommitDone, EditOp, ElementStyle, ErrorCode, ErrorPayload, FinetunePreview,
    FinetunePreviewed, GenerateDone, GenerateDoneDroppedItem, GenerateRequest, GuijamMessage,
    HelloOk, OverlayClear, OverlaySet, Route, RouteTier, RunRef, SourceRef, UndoDone, UpdateResult,
    UpdateResultStatus, UpdateResultUpdateId, Variant, VariantAssetsItemFormat, VariantPreview,
    VariantSelect, VariantSelected, VariantSet,
};
use gjd_core::journal::{CommitError, FileChange, Journal};
use gjd_core::jsx::JsxError;
use gjd_core::patch::{self, PatchError};
use gjd_core::policy::{PolicyError, ProjectRoot};
use gjd_core::style::inspect;
use gjd_core::theme::Theme;
use gjd_providers::{
    AuthStatus, Discovery, GenerationRequest, ImageInput, ProviderAdapter, ProviderError,
    ProviderId, ToolPolicy, adapter,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::assets::{self, AssetFile, Format};
use crate::config;
use crate::diff::code_changes;
use crate::generate::{self, Progress, Step, TierConfig};
use crate::index::ProjectIndex;
use crate::r0;
use crate::references;
use crate::route::{self, Tier};

const UPDATE_TIMEOUT: Duration = Duration::from_secs(5);
const AUTH_CACHE: Duration = Duration::from_mins(5);
const DEFAULT_PROVIDER: ProviderId = ProviderId::ClaudeCode;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Debug)]
pub struct ConnectionClosed;

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
        provider_failure(error, None)
    }
}

fn provider_failure(error: ProviderError, provider: Option<ProviderId>) -> Failure {
    let name = provider.map_or("The AI tool", ProviderId::display_name);
    let retry = "Retry, or simplify the prompt.";
    match error {
        ProviderError::NotInstalled(provider) => Failure::new(
            ErrorCode::ProviderNotInstalled,
            format!("{} is not installed.", provider.display_name()),
        )
        .with_action(format!("Install with: {}", provider.install_command())),
        ProviderError::NotAuthenticated {
            provider,
            login_command,
        } => not_authenticated(provider, login_command),
        ProviderError::RateLimited => Failure::new(
            ErrorCode::ProviderRateLimited,
            format!("{name} is rate limited."),
        )
        .with_action("Retry in a minute."),
        ProviderError::Overloaded => {
            Failure::new(ErrorCode::ProviderFailed, format!("{name} is overloaded."))
                .with_action("Retry in a minute.")
        }
        ProviderError::Timeout(limit) => Failure::new(
            ErrorCode::ProviderTimeout,
            format!("No answer within {} s.", limit.as_secs()),
        )
        .with_action(retry),
        ProviderError::Cancelled => Failure::new(ErrorCode::Cancelled, "Generation cancelled."),
        ProviderError::InvalidOutput(detail) => invalid_output(&detail),
        ProviderError::Crashed { .. } => Failure::new(
            ErrorCode::ProviderCrashed,
            format!("{name} stopped before answering."),
        )
        .with_action(retry),
        ProviderError::Failed(_) | ProviderError::Io(_) => {
            Failure::new(ErrorCode::ProviderFailed, error.to_string()).with_action(retry)
        }
    }
}

async fn first_logged_in() -> Option<ProviderId> {
    for id in ProviderId::ALL {
        let Some(provider) = adapter(id) else {
            continue;
        };
        let Ok(discovery) = provider.discover().await else {
            continue;
        };
        if matches!(provider.check_auth(&discovery).await, AuthStatus::LoggedIn) {
            return Some(id);
        }
    }
    None
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

type Validated = (
    Vec<(Variant, String, Vec<AssetFile>)>,
    Vec<GenerateDoneDroppedItem>,
);

fn assets_for(
    variant: &Variant,
    dir: &str,
    existing: &[String],
    taken: &[String],
) -> Result<Vec<AssetFile>, String> {
    let mut files: Vec<AssetFile> = Vec::new();
    for asset in &variant.assets {
        let format = match asset.format {
            VariantAssetsItemFormat::Svg => Format::Svg,
            VariantAssetsItemFormat::Webp => Format::Webp,
        };
        let width = asset.width.and_then(|width| u16::try_from(width).ok());
        let file = assets::prepare(&asset.name, format, &asset.svg, width, dir, existing)?;
        if taken.contains(&file.path) {
            return Err(format!("{} is already used by another drawing.", file.path));
        }
        if files.iter().any(|other| other.path == file.path) {
            return Err(format!("It adds {} twice.", file.path));
        }
        files.push(file);
    }
    Ok(files)
}

fn validate_variants(
    variants: Vec<Variant>,
    file: &str,
    current: &str,
    assets_dir: &str,
    existing: &[String],
    taken: &[String],
) -> Result<Validated, Failure> {
    let mut valid: Vec<(Variant, String, Vec<AssetFile>)> = Vec::new();
    let mut dropped = Vec::new();
    for variant in variants.into_iter().take(generate::VARIANTS) {
        let label = String::from(variant.label.clone());
        let reason = match apply_variant(&variant.ops, file, current) {
            Ok(content) if valid.iter().any(|(_, other, _)| *other == content) => {
                "It is the same as another variant.".to_owned()
            }
            Ok(content) => match assets_for(&variant, assets_dir, existing, taken) {
                Ok(files) => {
                    valid.push((variant, content, files));
                    continue;
                }
                Err(reason) => reason,
            },
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

fn sketch_images(request: &GenerateRequest) -> Vec<ImageInput> {
    request
        .sketch
        .iter()
        .flat_map(|sketch| &sketch.images)
        .map(|image| ImageInput {
            media_type: image.media_type.to_string(),
            base64: image.base64.to_string(),
        })
        .collect()
}

fn variants_phrase(count: usize) -> String {
    if count == 1 {
        "1 variant".to_owned()
    } else {
        format!("{count} variants")
    }
}

fn quoted(prompt: &str, limit: usize) -> String {
    let mut chars = prompt.chars();
    let head: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        format!("\"{head}…\"")
    } else {
        format!("\"{head}\"")
    }
}

#[derive(Clone)]
struct Version {
    base: String,
    content: String,
    ops: Vec<EditOp>,
}

struct Changeset {
    element: Option<(String, NonZeroU64, NonZeroU64)>,
    files: BTreeMap<String, Version>,
    summary: String,
    origin: &'static str,
    created: Vec<AssetFile>,
}

struct Run {
    cancel: CancellationToken,
}

struct VariantRun {
    file: String,
    changesets: Vec<String>,
    shown: Vec<String>,
}

struct Job<'a> {
    request: &'a GenerateRequest,
    prompt: &'a str,
    source: &'a str,
    style: &'a ElementStyle,
    started: Instant,
    cancel: &'a CancellationToken,
}

impl Job<'_> {
    fn elapsed_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

struct Held {
    label: String,
    system: String,
    style: String,
    rationale: String,
    assets: Vec<AssetFile>,
}

impl Held {
    fn from_variant(variant: Variant, assets: Vec<AssetFile>) -> Self {
        Self {
            label: variant.label.into(),
            system: variant.system,
            style: variant.style.into(),
            rationale: variant.rationale.into(),
            assets,
        }
    }
}

pub struct Daemon {
    project: ProjectRoot,
    index: ProjectIndex,
    journal: Arc<Journal>,
    write_lock: tokio::sync::Mutex<()>,
    tailwind_roots: Mutex<Vec<PathBuf>>,
    changesets: Mutex<HashMap<String, Changeset>>,
    overlays: Mutex<BTreeMap<String, String>>,
    plugin: Mutex<Option<PluginLink>>,
    runs: Mutex<HashMap<String, Run>>,
    variant_runs: Mutex<HashMap<String, VariantRun>>,
    preview: tokio::sync::Mutex<Option<String>>,
    provider: tokio::sync::Mutex<Option<(ProviderId, Discovery, Instant)>>,
    next_id: AtomicU64,
    connections: AtomicUsize,
    last_disconnect: Mutex<Instant>,
}

impl Daemon {
    #[must_use]
    pub fn new(project: ProjectRoot, journal: Journal) -> Self {
        Self {
            index: ProjectIndex::new(project.path()),
            project,
            journal: Arc::new(journal),
            write_lock: tokio::sync::Mutex::new(()),
            tailwind_roots: Mutex::default(),
            changesets: Mutex::default(),
            overlays: Mutex::default(),
            plugin: Mutex::default(),
            runs: Mutex::default(),
            variant_runs: Mutex::default(),
            preview: tokio::sync::Mutex::default(),
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

    #[must_use]
    pub fn idle_for(&self) -> Option<Duration> {
        (self.connections.load(Ordering::SeqCst) == 0)
            .then(|| locked(&self.last_disconnect).elapsed())
    }

    fn new_id(&self, prefix: &str) -> String {
        format!("{prefix}{}", self.next_id.fetch_add(1, Ordering::SeqCst))
    }

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
                    let _ = waiter.send(payload);
                }
                None
            }
            request => Some(self.handle_request(request).await),
        }
    }

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
                    ops: Vec::new(),
                },
            )]),
            summary,
            "finetune",
            Vec::new(),
        );
        let shown = (content != source).then_some(content.as_str());
        let update = self.show(&file, shown).await?;
        Ok(FinetunePreviewed {
            changeset_id,
            update,
            changes,
        })
    }

    fn cancel_run(&self, id: Option<String>, run: RunRef) -> GuijamMessage {
        if let Some(running) = locked(&self.runs).get(&run.run_id) {
            running.cancel.cancel();
        }
        GuijamMessage::GenerateCancelled { id, payload: run }
    }

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
            if runs.len() >= generate::MAX_RUNS {
                return Err(
                    Failure::invalid_request("Three drawings are already generating.")
                        .with_action("Wait for one to finish, or cancel one."),
                );
            }
            runs.insert(
                run_id.clone(),
                Run {
                    cancel: cancel.clone(),
                },
            );
        }
        let result = self.run_generation(request, &cancel).await;
        locked(&self.runs).remove(&run_id);
        result
    }

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

    async fn show_variant(
        &self,
        run_id: &str,
        changeset_id: &str,
        only_if_free: bool,
    ) -> Result<Option<UpdateResult>, Failure> {
        let mut slot = self.preview.lock().await;
        let holder = slot
            .clone()
            .filter(|holder| holder != run_id && locked(&self.variant_runs).contains_key(holder));
        if only_if_free && holder.is_some() {
            return Ok(None);
        }
        let (file, version, previews) = {
            let runs = locked(&self.variant_runs);
            let run = runs
                .get(run_id)
                .filter(|run| run.changesets.iter().any(|id| id == changeset_id))
                .ok_or_else(|| unknown_changeset(changeset_id))?;
            let changesets = locked(&self.changesets);
            let changeset = changesets
                .get(changeset_id)
                .ok_or_else(|| unknown_changeset(changeset_id))?;
            let version = changeset
                .files
                .get(&run.file)
                .cloned()
                .ok_or_else(|| unknown_changeset(changeset_id))?;
            let previews: Vec<(String, String)> = changeset
                .created
                .iter()
                .map(|asset| (asset.path.clone(), asset.preview.clone()))
                .collect();
            (run.file.clone(), version, previews)
        };
        let disk = self.read_project_file(&file).await?;
        let content = materialize(&file, &version, &disk)?;
        let cleared: BTreeSet<String> = {
            let mut runs = locked(&self.variant_runs);
            let mut cleared = BTreeSet::new();
            if let Some(other) = holder.as_ref().and_then(|holder| runs.get_mut(holder)) {
                cleared.extend(std::mem::take(&mut other.shown));
                cleared.insert(other.file.clone());
            }
            let run = runs
                .get_mut(run_id)
                .ok_or_else(|| unknown_changeset(changeset_id))?;
            cleared.extend(std::mem::take(&mut run.shown));
            run.shown = previews.iter().map(|(path, _)| path.clone()).collect();
            cleared.remove(&file);
            for (path, _) in &previews {
                cleared.remove(path);
            }
            cleared
        };
        for (path, preview) in &previews {
            self.show(path, Some(preview)).await?;
        }
        let update = self.show(&file, Some(&content)).await?;
        for path in &cleared {
            self.show(path, None).await?;
        }
        *slot = Some(run_id.to_owned());
        Ok(Some(update))
    }

    async fn select_variant(&self, request: VariantSelect) -> Result<VariantSelected, Failure> {
        let update = self
            .show_variant(&request.run_id, &request.changeset_id, false)
            .await?
            .ok_or_else(|| unknown_changeset(&request.changeset_id))?;
        Ok(VariantSelected {
            changeset_id: request.changeset_id,
            update,
        })
    }

    async fn discard_run(&self, run_id: &str) -> Result<(), Failure> {
        let mut slot = self.preview.lock().await;
        let Some(run) = locked(&self.variant_runs).remove(run_id) else {
            return Ok(());
        };
        {
            let mut changesets = locked(&self.changesets);
            for id in &run.changesets {
                changesets.remove(id);
            }
        }
        if slot.as_deref() != Some(run_id) {
            return Ok(());
        }
        *slot = None;
        self.show(&run.file, None).await?;
        for path in &run.shown {
            self.show(path, None).await?;
        }
        Ok(())
    }

    fn settle_variant_run(&self, changeset_id: &str) -> Option<(String, Vec<String>)> {
        let (run_id, run) = {
            let mut runs = locked(&self.variant_runs);
            let run_id = runs
                .iter()
                .find(|(_, run)| run.changesets.iter().any(|id| id == changeset_id))
                .map(|(id, _)| id.clone())?;
            let run = runs.remove(&run_id)?;
            (run_id, run)
        };
        let mut changesets = locked(&self.changesets);
        for id in &run.changesets {
            if id != changeset_id {
                changesets.remove(id);
            }
        }
        Some((run_id, run.shown))
    }

    fn held_assets(&self) -> Vec<String> {
        let runs = locked(&self.variant_runs);
        let changesets = locked(&self.changesets);
        runs.values()
            .flat_map(|run| &run.changesets)
            .filter_map(|id| changesets.get(id))
            .flat_map(|changeset| changeset.created.iter().map(|asset| asset.path.clone()))
            .collect()
    }

    async fn run_generation(
        &self,
        request: GenerateRequest,
        cancel: &CancellationToken,
    ) -> Result<GenerateDone, Failure> {
        let started = Instant::now();
        let prompt = request.prompt.trim().to_owned();
        if prompt.is_empty() {
            return Err(Failure::invalid_request("describe the change first"));
        }
        let source = self.read_project_file(&request.file).await?;
        let theme = self.theme().await;
        let style = inspect(&request.file, &source, request.line, request.column, &theme)?;
        let exact = r0::parse_property_edits(&prompt, &style)
            .and_then(|props| finetune_op(&style, &props, &theme).ok());
        let force_ai = request.force_ai.unwrap_or(false);
        let decision =
            route::classify(&prompt, exact.is_some(), force_ai, request.sketch.is_some());
        let job = Job {
            request: &request,
            prompt: &prompt,
            source: &source,
            style: &style,
            started,
            cancel,
        };
        match (decision.tier, exact) {
            (Tier::R0, Some(op)) => self.exact_edit(&job, &op).await,
            (Tier::R2, _) => {
                self.generate_with(&job, &generate::R2, decision.notice)
                    .await
            }
            _ => {
                self.generate_with(&job, &generate::R1, decision.notice)
                    .await
            }
        }
    }

    async fn exact_edit(&self, job: &Job<'_>, op: &EditOp) -> Result<GenerateDone, Failure> {
        let file = job.request.file.as_str();
        let sources = BTreeMap::from([(file.to_owned(), job.source.to_owned())]);
        let content = patch::apply(&sources, std::slice::from_ref(op))?
            .remove(file)
            .unwrap_or_else(|| job.source.to_owned());
        if content == job.source {
            return Err(Failure::new(
                ErrorCode::InvalidRequest,
                "The element already looks like that.",
            ));
        }
        let change = summarize(file, job.request.line, op);
        let label = change
            .split_once(" — ")
            .map_or(change.as_str(), |(_, change)| change)
            .to_owned();
        let held = Held {
            label,
            system: "Your project".to_owned(),
            style: "Exact".to_owned(),
            rationale: "Made without a model call.".to_owned(),
            assets: Vec::new(),
        };
        let (variants, first) = self.hold_variants(
            job.request,
            job.source,
            vec![(held, content, vec![op.clone()])],
            "R0",
        );
        let update = self
            .preview_run(&job.request.run_id, &first, job.cancel)
            .await?;
        Ok(GenerateDone {
            run_id: job.request.run_id.clone(),
            route: Route {
                tier: RouteTier::R0,
                provider: None,
                model: None,
                notice: Some(route::EXACT_NOTICE.to_owned()),
            },
            summary: format!(
                "{} → exact edit for <{}> {file}:{} (R0)",
                quoted(job.prompt, 60),
                job.style.tag,
                job.request.line,
            ),
            elapsed_ms: job.elapsed_ms(),
            answer: None,
            variants,
            dropped: Vec::new(),
            update,
        })
    }

    async fn generate_with(
        &self,
        job: &Job<'_>,
        tier: &TierConfig,
        notice: Option<&str>,
    ) -> Result<GenerateDone, Failure> {
        let file = job.request.file.as_str();
        let (provider, discovery) = self.provider().await?;
        let provider_id = provider.id();
        let provider_name = provider_id.display_name();
        let model = tier.model_for(provider_id);
        let model_label = model.unwrap_or("default model");
        let mut progress = Progress::new(
            &job.request.run_id,
            job.style,
            &self.stylesheet_names(),
            job.request.sketch.is_some(),
            provider_name,
            model_label,
        );
        progress.start(Step::Ask);
        self.report(&progress);
        let generation = GenerationRequest {
            model: model.map(str::to_owned),
            system_prompt: generate::SYSTEM_PROMPT.to_owned(),
            user_prompt: format!(
                "{}{}",
                generate::user_prompt(job.style, job.source, job.prompt, tier),
                self.references(job).await
            ),
            images: sketch_images(job.request),
            tools: ToolPolicy::None,
            timeout: tier.timeout,
            cwd: self.project.path().to_path_buf(),
        };
        let reply = self
            .ask(&*provider, &discovery, generation, job.cancel)
            .await?;
        let route_label = format!("{} · {provider_name} {model_label}", tier.label);
        let route = Route {
            tier: tier.tier,
            provider: Some(provider_name.to_owned()),
            model: model.map(str::to_owned),
            notice: notice.map(str::to_owned),
        };
        let at = format!("<{}> {file}:{}", job.style.tag, job.request.line);
        if reply.variants.is_empty() {
            let answer = reply
                .answer
                .map(String::from)
                .ok_or_else(|| invalid_output("it proposed no variant"))?;
            return Ok(GenerateDone {
                run_id: job.request.run_id.clone(),
                route,
                summary: format!(
                    "{} → answered for {at} ({route_label})",
                    quoted(job.prompt, 60)
                ),
                elapsed_ms: job.elapsed_ms(),
                answer: Some(answer),
                variants: Vec::new(),
                dropped: Vec::new(),
                update: None,
            });
        }

        let proposed = reply.variants;
        let checked = variants_phrase(proposed.len().min(generate::VARIANTS));
        progress.relabel(Step::Check, format!("Checking {checked}"));
        progress.start(Step::Check);
        self.report(&progress);
        let (variants, dropped, first) = self.check_and_hold(job, proposed, &route_label).await?;
        progress.start(Step::Preview);
        self.report(&progress);
        let update = self
            .preview_run(&job.request.run_id, &first, job.cancel)
            .await?;
        Ok(GenerateDone {
            run_id: job.request.run_id.clone(),
            route,
            summary: format!(
                "{} → {} for {at} ({route_label})",
                quoted(job.prompt, 60),
                variants_phrase(variants.len()),
            ),
            elapsed_ms: job.elapsed_ms(),
            answer: None,
            variants,
            dropped,
            update,
        })
    }

    async fn check_and_hold(
        &self,
        job: &Job<'_>,
        proposed: Vec<Variant>,
        route_label: &str,
    ) -> Result<(Vec<VariantPreview>, Vec<GenerateDoneDroppedItem>, String), Failure> {
        let file = job.request.file.as_str();
        let existing = self.index.files().await;
        let assets_dir = assets::assets_dir(&existing);
        let taken = self.held_assets();
        let (valid, dropped) =
            validate_variants(proposed, file, job.source, &assets_dir, &existing, &taken)?;
        if job.cancel.is_cancelled() {
            return Err(ProviderError::Cancelled.into());
        }
        let held = valid
            .into_iter()
            .map(|(variant, content, files)| {
                let ops = variant.ops.clone();
                (Held::from_variant(variant, files), content, ops)
            })
            .collect();
        let (variants, first) = self.hold_variants(job.request, job.source, held, route_label);
        Ok((variants, dropped, first))
    }

    async fn references(&self, job: &Job<'_>) -> String {
        let files = self.index.files().await;
        let mut mentioned = Vec::new();
        for path in references::mentioned_sources(&files, job.prompt, &job.request.file) {
            if let Ok(content) = self.read_project_file(path).await {
                mentioned.push((path.to_owned(), content));
            }
        }
        let container = format!(
            "{}:{}:{}",
            job.request.file, job.request.line, job.request.column
        );
        let sketch = job
            .request
            .sketch
            .as_ref()
            .map_or_else(String::new, |sketch| {
                references::sketch_section(sketch, &container)
            });
        let found = references::section(
            job.request.page.as_ref(),
            &files,
            &self.project.path().to_string_lossy(),
            job.prompt,
            &mentioned,
        );
        let folder = assets::prompt_note(&job.request.file, &assets::assets_dir(&files));
        format!("{sketch}{found}{folder}")
    }

    async fn ask(
        &self,
        provider: &dyn ProviderAdapter,
        discovery: &Discovery,
        request: GenerationRequest,
        cancel: &CancellationToken,
    ) -> Result<VariantSet, Failure> {
        match provider.generate(discovery, request, cancel.clone()).await {
            Ok(output) => Ok(output.variant_set),
            Err(error @ ProviderError::NotAuthenticated { .. }) => {
                *self.provider.lock().await = None;
                Err(provider_failure(error, Some(provider.id())))
            }
            Err(error) => Err(provider_failure(error, Some(provider.id()))),
        }
    }

    fn hold_variants(
        &self,
        request: &GenerateRequest,
        current: &str,
        held: Vec<(Held, String, Vec<EditOp>)>,
        route_label: &str,
    ) -> (Vec<VariantPreview>, String) {
        let file = &request.file;
        let variants: Vec<VariantPreview> = held
            .into_iter()
            .map(|(variant, content, ops)| {
                let summary = format!(
                    "{file}:{} — {} ({route_label})",
                    request.line, variant.label
                );
                let changes = code_changes(file, current, &content);
                let created = variant
                    .assets
                    .iter()
                    .map(|asset| asset.path.clone())
                    .collect();
                let changeset_id = self.store_changeset(
                    None,
                    BTreeMap::from([(
                        file.clone(),
                        Version {
                            base: current.to_owned(),
                            content,
                            ops,
                        },
                    )]),
                    summary,
                    "ai",
                    variant.assets,
                );
                VariantPreview {
                    changes,
                    changeset_id,
                    created,
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
                shown: Vec::new(),
            },
        );
        let first = variants
            .first()
            .map_or_else(String::new, |variant| variant.changeset_id.clone());
        (variants, first)
    }

    async fn preview_run(
        &self,
        run_id: &str,
        changeset_id: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<UpdateResult>, Failure> {
        let update = self.show_variant(run_id, changeset_id, true).await;
        if update.is_err() || cancel.is_cancelled() {
            self.discard_run(run_id).await?;
        }
        let update = update?;
        if cancel.is_cancelled() {
            return Err(ProviderError::Cancelled.into());
        }
        Ok(update)
    }

    async fn provider(&self) -> Result<(Box<dyn ProviderAdapter>, Discovery), Failure> {
        let mut ready = self.provider.lock().await;
        let configured = config::active_provider();
        if let Some((id, discovery, checked)) = ready.as_ref()
            && configured.is_none_or(|configured| configured == *id)
            && checked.elapsed() < AUTH_CACHE
            && let Some(provider) = adapter(*id)
        {
            return Ok((provider, discovery.clone()));
        }
        let id = match configured {
            Some(id) => id,
            None => first_logged_in().await.unwrap_or(DEFAULT_PROVIDER),
        };
        let provider = adapter(id).ok_or_else(|| {
            Failure::new(
                ErrorCode::ProviderNotInstalled,
                format!("{} is not supported yet.", id.display_name()),
            )
        })?;
        let discovery = provider
            .discover()
            .await
            .map_err(|error| provider_failure(error, Some(id)))?;
        match provider.check_auth(&discovery).await {
            AuthStatus::LoggedIn => *ready = Some((id, discovery.clone(), Instant::now())),
            AuthStatus::NotLoggedIn { login_command } => {
                return Err(not_authenticated(provider.id(), login_command));
            }
            AuthStatus::Unknown { reason } => {
                tracing::warn!(%reason, "could not read the provider's login status");
            }
        }
        Ok((provider, discovery))
    }

    fn store_changeset(
        &self,
        element: Option<(String, NonZeroU64, NonZeroU64)>,
        files: BTreeMap<String, Version>,
        summary: String,
        origin: &'static str,
        created: Vec<AssetFile>,
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
                created,
            },
        );
        id
    }

    async fn commit(&self, changeset_id: &str) -> Result<CommitDone, Failure> {
        let mut slot = self.preview.lock().await;
        let settled = self.settle_variant_run(changeset_id);
        let changeset = locked(&self.changesets)
            .remove(changeset_id)
            .ok_or_else(|| unknown_changeset(changeset_id))?;
        let files: Vec<String> = changeset
            .files
            .keys()
            .cloned()
            .chain(changeset.created.iter().map(|asset| asset.path.clone()))
            .collect();
        let written = self.write_changeset(&changeset).await;
        let shown = match settled {
            Some((run_id, shown)) if slot.as_deref() == Some(run_id.as_str()) => {
                *slot = None;
                Some(shown)
            }
            Some(_) => None,
            None => Some(Vec::new()),
        };
        if let Some(shown) = shown {
            let cleared: BTreeSet<&String> = files.iter().chain(&shown).collect();
            for file in cleared {
                self.show(file, None).await?;
            }
        }
        Ok(CommitDone {
            journal_id: written?,
            files,
            summary: changeset.summary,
        })
    }

    async fn write_changeset(&self, changeset: &Changeset) -> Result<String, Failure> {
        let _write = self.write_lock.lock().await;
        let mut changes = Vec::new();
        for (path, version) in &changeset.files {
            if version.ops.is_empty() {
                if version.base != version.content {
                    changes.push(FileChange::edit(
                        path.clone(),
                        content_hash(version.base.as_bytes()),
                        version.content.clone(),
                    ));
                }
                continue;
            }
            let disk = self.read_project_file(path).await?;
            let content = materialize(path, version, &disk)?;
            if content != disk {
                changes.push(FileChange::edit(
                    path.clone(),
                    content_hash(disk.as_bytes()),
                    content,
                ));
            }
        }
        changes.extend(
            changeset
                .created
                .iter()
                .map(|asset| FileChange::create(asset.path.clone(), asset.content.clone())),
        );
        if changes.is_empty() {
            return Err(Failure::new(
                ErrorCode::InvalidRequest,
                "this change has nothing to apply",
            ));
        }
        let journal = Arc::clone(&self.journal);
        let summary = changeset.summary.clone();
        let origin = changeset.origin;
        tokio::task::spawn_blocking(move || journal.commit(&changes, origin, &summary))
            .await
            .map_err(|error| Failure::new(ErrorCode::Internal, error.to_string()))?
            .map_err(Failure::from)
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

    fn resend_overlays(&self, link: &PluginLink) {
        let overlays = locked(&self.overlays).clone();
        for (file, content) in overlays {
            let id = self.new_id("d");
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

fn no_longer_fits(path: &str) -> Failure {
    Failure::new(
        ErrorCode::Conflict,
        format!("This variant no longer fits {path}: it changed after the drawing was made."),
    )
    .with_action("Generate again.")
}

fn materialize(path: &str, version: &Version, disk: &str) -> Result<String, Failure> {
    if disk == version.base {
        return Ok(version.content.clone());
    }
    patch::rebase(path, disk, &version.ops).map_err(|_| no_longer_fits(path))
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

    use super::{Version, apply_variant, materialize, validate_variants};

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

        let (valid, dropped) =
            validate_variants(proposed, FILE, SOURCE, "src/assets/icons", &[], &[])
                .expect("one survives");

        let kept: Vec<String> = valid
            .iter()
            .map(|(variant, _, _)| String::from(variant.label.clone()))
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
        let failure = validate_variants(lost, FILE, SOURCE, "src/assets/icons", &[], &[])
            .expect_err("none survive");
        assert_eq!(failure.code, ErrorCode::ProviderInvalidOutput);

        let saved = SOURCE.replace("p-2", "p-4");
        let stale = vec![variant(
            "Sea",
            &[snippet(FILE, SOURCE, "bg-brand", "bg-sea")],
        )];
        let failure = validate_variants(stale, FILE, &saved, "src/assets/icons", &[], &[])
            .expect_err("stale");
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

    fn sea_version() -> Version {
        Version {
            base: SOURCE.to_owned(),
            content: SOURCE.replace("bg-brand", "bg-sea"),
            ops: vec![snippet(FILE, SOURCE, "bg-brand", "bg-sea")],
        }
    }

    #[test]
    fn rebases_a_variant_onto_a_file_saved_after_it_was_made() {
        let version = sea_version();
        let saved = SOURCE.replace("p-2", "p-4");

        assert_eq!(
            materialize(FILE, &version, SOURCE).expect("unchanged"),
            version.content
        );
        assert_eq!(
            materialize(FILE, &version, &saved).expect("rebased"),
            saved.replace("bg-brand", "bg-sea")
        );
    }

    #[test]
    fn reports_a_variant_that_no_longer_fits_the_file() {
        let rewritten = SOURCE.replace("bg-brand", "bg-ink");

        let failure = materialize(FILE, &sea_version(), &rewritten).expect_err("conflict");

        assert_eq!(failure.code, ErrorCode::Conflict);
        assert_eq!(failure.action.as_deref(), Some("Generate again."));
    }

    #[test]
    fn apply_variant_refuses_content_the_model_did_not_see() {
        let ops = [snippet(FILE, SOURCE, "bg-brand", "bg-sea")];
        let saved = SOURCE.replace("p-2", "p-4");

        let failure = apply_variant(&ops, FILE, &saved).expect_err("stale");

        assert_eq!(failure.code, ErrorCode::StaleBase);
        assert_eq!(failure.message, "src/B.tsx changed since the AI read it.");
    }
}
