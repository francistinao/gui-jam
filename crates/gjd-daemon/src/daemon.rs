use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use gjd_core::codemod::{CodemodError, finetune_ops};
use gjd_core::content;
use gjd_core::content_hash;
use gjd_core::contracts::{
    CodeChange, CommitDone, ContentHash, ContentPart, DependenciesInstall, DependenciesInstalled,
    DependencyNeeds, DomPatchTextItem, EditOp, EditOpValue, ElementInspect, ElementStyle,
    ErrorCode, ErrorPayload, FinetunePreview, FinetunePreviewed, FinetunePropsSource, GenerateDone,
    GenerateDoneDroppedItem, GenerateDoneNotesItem, GenerateRequest, GuijamMessage, HelloOk,
    JsxValue, OverlayClear, OverlaySet, Package, Route, RouteTier, RunRef, SrcLoc, TextPlace,
    UndoDone, UpdateResult, UpdateResultStatus, UpdateResultUpdateId, Variant,
    VariantAssetsItemFormat, VariantPreview, VariantSelect, VariantSelected, VariantSet,
};
use gjd_core::journal::{CommitError, FileChange, Journal};
use gjd_core::jsx::{self, Component, JsxError, check_syntax, imports};
use gjd_core::patch::{self, PatchError};
use gjd_core::policy::{PolicyError, ProjectRoot};
use gjd_core::style::{Styling, inspect_with};
use gjd_core::template;
use gjd_core::text_source::Key;
use gjd_core::theme::Theme;
use gjd_providers::{
    AuthStatus, Discovery, Effort, GenerationRequest, ImageInput, ProviderAdapter, ProviderError,
    ProviderEvent, ProviderId, ToolPolicy, adapter,
};
use tokio::sync::{Semaphore, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::assets::{self, AssetFile, Format};
use crate::config;
use crate::diff::code_changes;
use crate::found_text;
use crate::generate::{self, Progress, Step, TierConfig};
use crate::index::ProjectIndex;
use crate::install;
use crate::libraries::{self, Need};
use crate::links::{self, Found};
use crate::project::{self, PackageManager, Project};
use crate::r0;
use crate::references;
use crate::related::{self, RelatedFile, RenderSite};
use crate::route::{self, Tier};
use crate::run_dir::RunDir;
use crate::screenshot::{self, Browser};
use crate::timings;
use crate::tracker::{self, Snapshot, SnapshotFile, Tracker, TrackerError};

const UPDATE_TIMEOUT: Duration = Duration::from_secs(5);
const CLI_SLOTS: usize = 6;
const AUTH_CACHE: Duration = Duration::from_mins(5);
const DEFAULT_PROVIDER: ProviderId = ProviderId::ClaudeCode;
const VERSION_CACHE: Duration = Duration::from_hours(1);
const MAX_NEEDS: usize = 4;
const READ_CONCURRENCY: usize = 32;
const PAGE_WHY: &str = "holds the routed page next to the sketch";
const NAMED_WHY: &str = "named in the request";
const SELECTED_WHY: &str = "selected too";
const MAX_ALSO_SELECTED: usize = 4;
const SUMMARY_TEXT_CHARS: usize = 40;

type VersionCache = HashMap<(String, Option<u64>), (String, Instant)>;

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

impl From<TrackerError> for Failure {
    fn from(error: TrackerError) -> Self {
        let code = match error {
            TrackerError::NotPaired | TrackerError::UnknownSite(_) => ErrorCode::TrackerNotPaired,
            _ => ErrorCode::TrackerFailed,
        };
        let failure = Self::new(code, error.to_string());
        match error.action() {
            Some(action) => failure.with_action(action),
            None => failure,
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
            detail,
        } => not_authenticated(provider, login_command, detail.as_deref()),
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
        ProviderError::Crashed { stderr_tail, .. } => Failure::new(
            ErrorCode::ProviderCrashed,
            match said(&stderr_tail) {
                Some(line) => format!("{name} stopped before answering: {line}."),
                None => format!("{name} stopped before answering."),
            },
        )
        .with_action(retry),
        ProviderError::Failed(detail) => Failure::new(
            ErrorCode::ProviderFailed,
            match said(&detail) {
                Some(reason) => format!("{name} couldn't answer: {reason}."),
                None => format!("{name} couldn't answer."),
            },
        )
        .with_action(retry),
        ProviderError::Io(_) => {
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

const SAID_LIMIT: usize = 600;
const ACCOUNT_ID_PREFIXES: [&str; 3] = ["org_", "ses_", "acct_"];

fn without_account_ids(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut rest = text;
    while let Some((at, prefix)) = ACCOUNT_ID_PREFIXES
        .iter()
        .filter_map(|prefix| rest.find(prefix).map(|at| (at, *prefix)))
        .min_by_key(|(at, _)| *at)
    {
        plain.push_str(&rest[..at + prefix.len()]);
        let after = &rest[at + prefix.len()..];
        let id_len = after
            .find(|c: char| !c.is_ascii_alphanumeric())
            .unwrap_or(after.len());
        plain.push_str(if id_len > 0 { "redacted" } else { "" });
        rest = &after[id_len..];
    }
    plain.push_str(rest);
    plain
}

fn said(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).rfind(|line| {
        line.chars().any(char::is_alphabetic) && !line.starts_with("at ") && !line.starts_with('{')
    })?;
    let line = line.trim_end_matches('.');
    Some(match line.char_indices().nth(SAID_LIMIT) {
        Some((cut, _)) => format!("{}…", &line[..cut]),
        None => line.to_owned(),
    })
}

fn not_authenticated(provider: ProviderId, login_command: &str, detail: Option<&str>) -> Failure {
    let name = provider.display_name();
    let message = match detail.and_then(said) {
        Some(reason) => format!("{name} was refused: {reason}."),
        None => format!("{name} isn't logged in."),
    };
    let model_off = detail.is_some_and(|detail| detail.to_lowercase().contains("model access"));
    let api_key = detail.is_some_and(|detail| detail.contains("GEMINI_API_KEY"));
    let action = if api_key {
        "Set GEMINI_API_KEY where your dev server starts, choose it in Gemini CLI with /auth, restart the dev server, then retry."
            .to_owned()
    } else if model_off {
        "Turn this model on at that link, or pick another model with npx guijam init. Then retry."
            .to_owned()
    } else if provider == ProviderId::OpenCode {
        format!(
            "Run `{login_command}` and add a key for the provider of the chosen model, or pick another model with npx guijam init. Then retry."
        )
    } else {
        format!("Run `{login_command}` in a terminal, then retry.")
    };
    Failure::new(ErrorCode::ProviderNotAuthenticated, message).with_action(action)
}

fn invalid_output(detail: &str) -> Failure {
    Failure::new(
        ErrorCode::ProviderInvalidOutput,
        format!("The model's answer wasn't valid edits: {detail}"),
    )
    .with_action("Retry, or simplify the prompt.")
}

type Contents = BTreeMap<String, String>;

fn apply_variant(ops: &[EditOp], editable: &Contents) -> Result<Contents, Failure> {
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
        .find(|op_file| !editable.contains_key(*op_file))
    {
        return Err(invalid_output(&format!(
            "it edits {other}, which it was not shown"
        )));
    }
    let changed: Contents = patch::apply(editable, ops)
        .map_err(model_patch_failure)?
        .into_iter()
        .filter(|(file, content)| editable.get(file) != Some(content))
        .collect();
    if changed.is_empty() {
        return Err(invalid_output("it changed nothing"));
    }
    Ok(changed)
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
    Vec<(Variant, Contents, Vec<AssetFile>)>,
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

struct Checks<'a> {
    assets_dir: &'a str,
    existing: &'a [String],
    taken: &'a [String],
    project: &'a Project,
    root: &'a Path,
}

fn edits_of(ops: &[EditOp], editable: &Contents) -> Vec<EditOp> {
    let hashes: BTreeMap<&str, ContentHash> = editable
        .iter()
        .map(|(file, shown)| (file.as_str(), content_hash(shown.as_bytes())))
        .collect();
    ops.iter()
        .filter(|op| !matches!(op, EditOp::CreateFile { .. }))
        .cloned()
        .map(|mut op| {
            let Some(hash) = hashes.get(generate::op_file(&op)).cloned() else {
                return op;
            };
            match &mut op {
                EditOp::ReplaceSnippet { base_hash, .. }
                | EditOp::ClassTokens { base_hash, .. }
                | EditOp::JsxAttr { base_hash, .. }
                | EditOp::StyleProp { base_hash, .. }
                | EditOp::TextContent { base_hash, .. }
                | EditOp::TextAt { base_hash, .. }
                | EditOp::RewriteFile { base_hash, .. } => *base_hash = hash,
                EditOp::CreateFile { .. } => {}
            }
            op
        })
        .collect()
}

fn new_files_for(variant: &Variant, checks: &Checks<'_>) -> Result<Vec<AssetFile>, String> {
    let creates: Vec<(&str, &str)> = variant
        .ops
        .iter()
        .filter_map(|op| match op {
            EditOp::CreateFile { file, content } => Some((file.as_str(), content.as_str())),
            _ => None,
        })
        .collect();
    if creates.len() > project::MAX_NEW_FILES {
        return Err(format!(
            "It creates {} files; {} at most.",
            creates.len(),
            project::MAX_NEW_FILES
        ));
    }
    let mut files: Vec<AssetFile> = Vec::new();
    for (path, content) in creates {
        project::check_new_path(checks.project, path)?;
        if checks.existing.iter().any(|file| file == path) || checks.root.join(path).exists() {
            return Err(format!("{path} already exists."));
        }
        if checks.taken.iter().any(|file| file == path) {
            return Err(format!("{path} is already used by another drawing."));
        }
        if files.iter().any(|file| file.path == path) {
            return Err(format!("It creates {path} twice."));
        }
        if content.len() > project::MAX_NEW_FILE_BYTES {
            return Err(format!(
                "Its {path} is larger than {} KB.",
                project::MAX_NEW_FILE_BYTES / 1024
            ));
        }
        check_syntax(path, content)
            .map_err(|error| format!("Its {path} doesn't parse: {error}."))?;
        files.push(AssetFile {
            path: path.to_owned(),
            content: content.as_bytes().to_vec(),
            preview: content.to_owned(),
        });
    }
    Ok(files)
}

fn files_for(variant: &Variant, checks: &Checks<'_>) -> Result<Vec<AssetFile>, String> {
    let mut files = assets_for(variant, checks.assets_dir, checks.existing, checks.taken)?;
    for file in new_files_for(variant, checks)? {
        if files.iter().any(|other| other.path == file.path) {
            return Err(format!("It creates {} twice.", file.path));
        }
        files.push(file);
    }
    Ok(files)
}

fn validate_variants(
    variants: Vec<Variant>,
    editable: &Contents,
    file: &str,
    checks: &Checks<'_>,
) -> Result<Validated, Failure> {
    let mut valid: Vec<(Variant, Contents, Vec<AssetFile>)> = Vec::new();
    let mut dropped = Vec::new();
    for variant in variants.into_iter().take(generate::VARIANTS) {
        let label = String::from(variant.label.clone());
        let edits = edits_of(&variant.ops, editable);
        let creates = variant.ops.len() - edits.len();
        let reason = match apply_variant(&edits, editable) {
            Ok(content) if valid.iter().any(|(_, other, _)| *other == content) => {
                "It is the same as another variant.".to_owned()
            }
            Ok(content) => match files_for(&variant, checks) {
                Ok(files) => {
                    valid.push((variant, content, files));
                    continue;
                }
                Err(reason) => reason,
            },
            Err(_) if edits.is_empty() && creates > 0 => {
                format!("It creates components but doesn't place them in {file}.")
            }
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

fn changed_content(version: &Version) -> Option<String> {
    (version.content != version.base).then(|| version.content.clone())
}

fn other_overlays(
    file: &str,
    versions: &BTreeMap<String, Version>,
    previous: Vec<String>,
) -> Vec<(String, Option<String>)> {
    versions
        .iter()
        .filter(|(path, _)| path.as_str() != file)
        .map(|(path, version)| (path.clone(), changed_content(version)))
        .chain(
            previous
                .into_iter()
                .filter(|path| path != file && !versions.contains_key(path))
                .map(|path| (path, None)),
        )
        .collect()
}

fn preview_outcome(
    selected: Option<UpdateResult>,
    others: Vec<UpdateResult>,
) -> Option<UpdateResult> {
    let failed = |update: &UpdateResult| {
        matches!(
            update.status,
            UpdateResultStatus::CompileError | UpdateResultStatus::RuntimeError
        )
    };
    if let Some(update) = others.iter().find(|update| failed(update)) {
        return Some(update.clone());
    }
    selected.or_else(|| others.into_iter().next())
}

fn also_edits(selected: &str, contents: &Contents) -> String {
    let others: Vec<&str> = contents
        .keys()
        .filter(|path| *path != selected)
        .map(|path| path.rsplit('/').next().unwrap_or(path))
        .collect();
    if others.is_empty() {
        String::new()
    } else {
        format!(" · also {}", others.join(", "))
    }
}

fn full_prompt(job: &Job<'_>, tier: &TierConfig, references: &str, linked: &str) -> String {
    let element = generate::user_prompt(
        job.style,
        job.source,
        job.prompt,
        tier,
        job.related.component.as_ref(),
    );
    let group: Vec<(&ElementStyle, Option<&Component>)> = job
        .group
        .iter()
        .map(|picked| (&picked.style, picked.component.as_ref()))
        .collect();
    let also = generate::also_selected(&group);
    format!("{element}{also}{references}{linked}")
}

fn group_files(request: &GenerateRequest, group: &[Picked]) -> Vec<RelatedFile> {
    let window = u64::try_from(generate::R2.context_lines).unwrap_or(u64::MAX);
    let mut found = Vec::new();
    for picked in group {
        let line = picked.style.line.get();
        if picked.style.file == request.file && line.abs_diff(request.line.get()) <= window {
            continue;
        }
        related::add(
            &mut found,
            RelatedFile {
                path: picked.style.file.clone(),
                content: picked.source.clone(),
                anchors: vec![line],
                why: SELECTED_WHY.to_owned(),
                selected: true,
            },
        );
    }
    found
}

fn rendered_by(site: RenderSite, name: &str) -> RelatedFile {
    RelatedFile {
        path: site.path,
        content: site.content,
        anchors: site.lines,
        why: format!("renders {name}"),
        selected: false,
    }
}

fn sketch_count(request: &GenerateRequest) -> usize {
    request
        .sketch
        .as_ref()
        .map_or(0, |sketch| sketch.images.len())
}

fn sketch_kind(request: &GenerateRequest) -> &'static str {
    match &request.sketch {
        Some(sketch) if sketch.element_box.is_some() => "element",
        Some(_) => "space",
        None => "none",
    }
}

fn inspiration_count(request: &GenerateRequest) -> usize {
    request
        .attachments
        .as_ref()
        .map_or(0, |attachments| attachments.images.len())
}

fn extras(request: &GenerateRequest, links: &Found, group: usize) -> generate::Extras {
    generate::Extras {
        sketch: request.sketch.is_some(),
        inspiration: inspiration_count(request),
        links: links.links.len(),
        group,
    }
}

fn notes(lines: Vec<String>) -> Vec<GenerateDoneNotesItem> {
    lines
        .into_iter()
        .take(links::MAX_NOTES)
        .filter_map(|line| GenerateDoneNotesItem::try_from(line).ok())
        .collect()
}

fn request_images(request: &GenerateRequest) -> Vec<ImageInput> {
    let sketch = request
        .sketch
        .iter()
        .flat_map(|sketch| &sketch.images)
        .map(|image| ImageInput {
            media_type: image.media_type.to_string(),
            base64: image.base64.to_string(),
        });
    let inspiration = request
        .attachments
        .iter()
        .flat_map(|attachments| &attachments.images)
        .map(|image| ImageInput {
            media_type: image.media_type.to_string(),
            base64: image.base64.to_string(),
        });
    sketch.chain(inspiration).collect()
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
    needs: Vec<Need>,
}

struct Run {
    cancel: CancellationToken,
}

struct Prepared {
    provider: Box<dyn ProviderAdapter>,
    discovery: Discovery,
    model: Option<String>,
    effort: Effort,
    progress: Progress,
}

enum Asked {
    Answer(String),
    Variants {
        variants: Vec<VariantPreview>,
        dropped: Vec<GenerateDoneDroppedItem>,
        update: Option<UpdateResult>,
        first_ms: Option<u64>,
    },
}

#[derive(Default)]
struct Collected {
    held: Vec<VariantPreview>,
    dropped: Vec<GenerateDoneDroppedItem>,
    failures: Vec<Failure>,
    update: Option<UpdateResult>,
    first_ms: Option<u64>,
}

enum Arrival {
    More,
    Answer(String),
    Settled,
}

struct VariantRun {
    file: String,
    changesets: Vec<String>,
    shown: Vec<String>,
}

#[derive(Default)]
struct Related {
    files: Vec<RelatedFile>,
    component: Option<Component>,
    page_near: Option<String>,
}

impl Related {
    fn place_file<'a>(&'a self, selected: &'a str) -> &'a str {
        self.page_near
            .as_deref()
            .and_then(|near| references::parse_src(near))
            .map_or(selected, |(file, _, _)| file)
    }
}

struct Picked {
    style: ElementStyle,
    source: String,
    component: Option<Component>,
}

struct Job<'a> {
    request: &'a GenerateRequest,
    prompt: &'a str,
    links: &'a Found,
    project: &'a Project,
    source: &'a str,
    style: &'a ElementStyle,
    group: &'a [Picked],
    related: &'a Related,
    editable: &'a Contents,
    started: Instant,
    cancel: &'a CancellationToken,
}

impl Job<'_> {
    fn elapsed_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

struct RunLabels {
    route: String,
    waits: PathBuf,
    key: String,
}

fn capture_ms(job: &Job<'_>) -> u64 {
    job.request
        .sketch
        .as_ref()
        .and_then(|sketch| sketch.capture_ms)
        .unwrap_or(0)
}

impl RunLabels {
    fn first_arrived(&self, job: &Job<'_>) -> u64 {
        let first = job.elapsed_ms();
        if let Err(error) = timings::record(&self.waits, &self.key, first + capture_ms(job)) {
            tracing::warn!(%error, "could not record how long the run took");
        }
        first
    }

    fn variants_ready(
        &self,
        job: &Job<'_>,
        effort: Effort,
        first_ms: Option<u64>,
        (variants, dropped): (usize, &[GenerateDoneDroppedItem]),
    ) {
        tracing::info!(
            run = %self.key,
            effort = %effort,
            sketch = sketch_kind(job.request),
            capture_ms = capture_ms(job),
            first_variant_ms = first_ms,
            all_ms = job.elapsed_ms(),
            variants,
            dropped = dropped.len(),
            targets = job.group.len() + 1,
            "variants ready"
        );
        for item in dropped {
            tracing::info!(
                run = %self.key,
                label = item.label.as_deref().unwrap_or("unnamed"),
                reason = %without_account_ids(&item.reason),
                "a variant was dropped"
            );
        }
    }
}

struct Held {
    label: String,
    system: String,
    style: String,
    rationale: String,
    assets: Vec<AssetFile>,
    needs: Vec<Need>,
}

impl Held {
    fn from_variant(variant: Variant, assets: Vec<AssetFile>, needs: Vec<Need>) -> Self {
        Self {
            label: variant.label.into(),
            system: variant.system,
            style: variant.style.into(),
            rationale: variant.rationale.into(),
            assets,
            needs,
        }
    }
}

fn libraries_needed(
    bases: &Contents,
    contents: &Contents,
    created: &[AssetFile],
    project: &Project,
    root: &Path,
) -> Result<Vec<String>, String> {
    let before: BTreeSet<String> = contents
        .keys()
        .filter_map(|file| Some((file, bases.get(file)?)))
        .flat_map(|(file, base)| imports(file, base).unwrap_or_default())
        .collect();
    let known: BTreeSet<&str> = before
        .iter()
        .filter(|specifier| !specifier.starts_with('.'))
        .filter_map(|specifier| specifier.split('/').next())
        .collect();
    let allowed = libraries::allowed(project);
    let sources = contents
        .iter()
        .map(|(file, content)| (file.as_str(), content.as_str()))
        .chain(
            created
                .iter()
                .filter(|asset| {
                    Path::new(&asset.path).extension().is_some_and(|extension| {
                        matches!(extension.to_str(), Some("tsx" | "jsx" | "ts" | "js"))
                    })
                })
                .map(|asset| (asset.path.as_str(), asset.preview.as_str())),
        );
    let mut needed: Vec<String> = Vec::new();
    for (path, source) in sources {
        let Ok(specifiers) = imports(path, source) else {
            continue;
        };
        for specifier in specifiers
            .iter()
            .filter(|specifier| !before.contains(specifier.as_str()))
        {
            let Some(package) = libraries::package_of(specifier) else {
                continue;
            };
            let installed = project.dependencies.contains_key(package)
                || root
                    .join("node_modules")
                    .join(package)
                    .join("package.json")
                    .is_file();
            if installed
                || specifier
                    .split('/')
                    .next()
                    .is_some_and(|first| known.contains(first))
            {
                continue;
            }
            if !allowed.iter().any(|library| library.name == package) {
                return Err(format!("It imports {package}, which isn't installed."));
            }
            if !needed.iter().any(|name| name == package) {
                needed.push(package.to_owned());
            }
        }
    }
    if needed.len() > MAX_NEEDS {
        return Err(format!(
            "It needs {} libraries; {MAX_NEEDS} at most.",
            needed.len()
        ));
    }
    Ok(needed)
}

fn package(need: &Need) -> Option<Package> {
    Some(Package {
        name: need.name.clone().try_into().ok()?,
        version: need.version.clone().try_into().ok()?,
    })
}

fn dependency_needs(needs: &[Need], manager: PackageManager) -> Option<DependencyNeeds> {
    if needs.is_empty() {
        return None;
    }
    Some(DependencyNeeds {
        command: install::command_line(manager, needs).try_into().ok()?,
        packages: needs.iter().filter_map(package).collect(),
    })
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
    versions: Mutex<VersionCache>,
    slots: Semaphore,
    next_id: AtomicU64,
    connections: AtomicUsize,
    last_disconnect: Mutex<Instant>,
    tracker: Tracker,
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
            versions: Mutex::default(),
            slots: Semaphore::new(CLI_SLOTS),
            next_id: AtomicU64::new(1),
            connections: AtomicUsize::new(0),
            last_disconnect: Mutex::new(Instant::now()),
            tracker: Tracker::default(),
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
                        daemon_version: crate::VERSION.to_owned(),
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
            message @ (GuijamMessage::TrackerStatus { .. }
            | GuijamMessage::TrackerSearch { .. }
            | GuijamMessage::TrackerTicket { .. }
            | GuijamMessage::TrackerStart { .. }
            | GuijamMessage::TrackerPost { .. }
            | GuijamMessage::TrackerReport { .. }) => self.handle_tracker_request(message).await,
            message @ (GuijamMessage::VariantSelect { .. }
            | GuijamMessage::DependenciesInstall { .. }
            | GuijamMessage::PreviewRelease { .. }
            | GuijamMessage::GenerateDiscard { .. }) => self.handle_run_request(message).await,
            GuijamMessage::PluginHello { id, .. }
            | GuijamMessage::TailwindRoots { id, .. }
            | GuijamMessage::UpdateResult { id, .. }
            | GuijamMessage::HelloOk { id, .. }
            | GuijamMessage::GenerateDone { id, .. }
            | GuijamMessage::GenerateProgress { id, .. }
            | GuijamMessage::VariantSelected { id, .. }
            | GuijamMessage::DependenciesInstalled { id, .. }
            | GuijamMessage::GenerateAttach { id, .. }
            | GuijamMessage::PreviewReleased { id, .. }
            | GuijamMessage::GenerateDiscarded { id, .. }
            | GuijamMessage::GenerateCancelled { id, .. }
            | GuijamMessage::OverlaySet { id, .. }
            | GuijamMessage::OverlayClear { id, .. }
            | GuijamMessage::ElementStyle { id, .. }
            | GuijamMessage::FinetunePreviewed { id, .. }
            | GuijamMessage::CommitDone { id, .. }
            | GuijamMessage::ChangesetDiscarded { id, .. }
            | GuijamMessage::UndoDone { id, .. }
            | GuijamMessage::TrackerStatusOk { id, .. }
            | GuijamMessage::TrackerTickets { id, .. }
            | GuijamMessage::TrackerTicketOk { id, .. }
            | GuijamMessage::TrackerStarted { id, .. }
            | GuijamMessage::TrackerPosted { id, .. }
            | GuijamMessage::TrackerReported { id, .. }
            | GuijamMessage::Error { id, .. } => Failure::new(
                ErrorCode::InvalidRequest,
                "the daemon does not accept this message",
            )
            .into_message(id),
        }
    }

    async fn handle_tracker_request(&self, message: GuijamMessage) -> GuijamMessage {
        let tracker = &self.tracker;
        match message {
            GuijamMessage::TrackerStatus { id, .. } => reply(
                id,
                tracker
                    .status()
                    .await
                    .map_err(Failure::from)
                    .map(|payload| GuijamMessage::TrackerStatusOk { id: None, payload }),
            ),
            GuijamMessage::TrackerSearch { id, payload } => reply(
                id,
                tracker
                    .search(&payload)
                    .await
                    .map_err(Failure::from)
                    .map(|payload| GuijamMessage::TrackerTickets { id: None, payload }),
            ),
            GuijamMessage::TrackerTicket { id, payload } => reply(
                id,
                tracker
                    .ticket(&payload.ref_)
                    .await
                    .map_err(Failure::from)
                    .map(|payload| GuijamMessage::TrackerTicketOk { id: None, payload }),
            ),
            GuijamMessage::TrackerStart { id, payload } => reply(
                id,
                tracker
                    .start(&payload)
                    .await
                    .map_err(Failure::from)
                    .map(|payload| GuijamMessage::TrackerStarted { id: None, payload }),
            ),
            GuijamMessage::TrackerPost { id, payload } => reply(
                id,
                tracker
                    .post(&payload)
                    .await
                    .map_err(Failure::from)
                    .map(|payload| GuijamMessage::TrackerPosted { id: None, payload }),
            ),
            GuijamMessage::TrackerReport { id, payload } => reply(
                id,
                tracker
                    .report(&payload)
                    .await
                    .map_err(Failure::from)
                    .map(|payload| GuijamMessage::TrackerReported { id: None, payload }),
            ),
            other => {
                Failure::invalid_request("not a tracker request").into_message(message_id(&other))
            }
        }
    }

    async fn handle_run_request(&self, message: GuijamMessage) -> GuijamMessage {
        match message {
            GuijamMessage::VariantSelect { id, payload } => reply(
                id,
                self.select_variant(payload)
                    .await
                    .map(|selected| GuijamMessage::VariantSelected {
                        id: None,
                        payload: selected,
                    }),
            ),
            GuijamMessage::DependenciesInstall { id, payload } => {
                reply(id, self.install_dependencies(payload).await.map(installed))
            }
            GuijamMessage::PreviewRelease { id, payload } => reply(
                id,
                self.release_preview(&payload.run_id)
                    .await
                    .map(|()| GuijamMessage::PreviewReleased { id: None, payload }),
            ),
            GuijamMessage::GenerateDiscard { id, payload } => reply(
                id,
                self.discard_run(&payload.run_id)
                    .await
                    .map(|()| GuijamMessage::GenerateDiscarded { id: None, payload }),
            ),
            other => Failure::new(
                ErrorCode::InvalidRequest,
                "the daemon does not accept this message",
            )
            .into_message(message_id(&other)),
        }
    }

    fn styling(&self, project: &Project) -> Styling {
        Styling {
            tailwind: !locked(&self.tailwind_roots).is_empty()
                || project
                    .dependencies
                    .keys()
                    .any(|name| name == "tailwindcss" || name.starts_with("@tailwindcss/")),
            vuetify: project.dependencies.contains_key("vuetify"),
        }
    }

    fn set_tailwind_roots(&self, files: &[String]) {
        let inside: Vec<PathBuf> = files
            .iter()
            .filter_map(|file| dunce::canonicalize(file).ok())
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

    async fn picked(
        &self,
        request: &GenerateRequest,
        theme: &Theme,
        project: &Project,
    ) -> Result<Vec<Picked>, Failure> {
        if request.also_selected.len() > MAX_ALSO_SELECTED {
            return Err(Failure::invalid_request(format!(
                "Up to {} components at a time.",
                MAX_ALSO_SELECTED + 1
            )));
        }
        let mut seen = BTreeSet::from([(request.file.clone(), request.line, request.column)]);
        let mut group = Vec::new();
        for target in &request.also_selected {
            if !seen.insert((target.file.clone(), target.line, target.column)) {
                continue;
            }
            let source = self.read_project_file(&target.file).await?;
            let style = inspect_with(
                &target.file,
                &source,
                target.line,
                target.column,
                theme,
                self.styling(project),
            )?;
            let component = jsx::enclosing_component(
                &target.file,
                &source,
                target.line.get(),
                target.column.get(),
            );
            group.push(Picked {
                style,
                source,
                component,
            });
        }
        Ok(group)
    }

    async fn read_project_file(&self, file: &str) -> Result<String, Failure> {
        let path = self.project.resolve(file)?;
        Ok(tokio::fs::read_to_string(path).await?)
    }

    async fn inspect(&self, request: &ElementInspect) -> Result<ElementStyle, Failure> {
        let source = self.read_project_file(&request.file).await?;
        let theme = self.theme().await;
        let project = project::detect(self.project.path(), &self.index.files().await);
        let mut style = inspect_with(
            &request.file,
            &source,
            request.line,
            request.column,
            &theme,
            self.styling(&project),
        )?;
        if let Some(text) = request
            .text
            .as_ref()
            .and_then(|text| found_text::shown_text(text))
            && let Some(lookup) = found_text::lookup(
                &request.file,
                &source,
                request.line.get(),
                request.column.get(),
            )
        {
            let places = self.find_text(&request.file, &source, &lookup, &text).await;
            if !places.is_empty() {
                style.content = vec![ContentPart::Found {
                    code: content::shortened(&lookup.code),
                    places,
                    value: text,
                }];
            }
        }
        Ok(style)
    }

    async fn render_site_files(
        &self,
        files: &[String],
        skip: &str,
        component: &str,
        text: &str,
    ) -> Vec<(String, String)> {
        let paths: Vec<String> = files
            .iter()
            .filter(|path| path.as_str() != skip && found_text::renders_components(path))
            .cloned()
            .collect();
        let mut reads = futures_util::stream::iter(paths)
            .map(|path| async move {
                let content = self.read_project_file(&path).await;
                (path, content)
            })
            .buffer_unordered(READ_CONCURRENCY);
        let mut sites = Vec::new();
        while let Some((path, content)) = reads.next().await {
            if let Ok(content) = content
                && found_text::renders(&path, &content, component)
            {
                sites.push((path, content));
            }
        }
        found_text::ranked_sites(sites, text)
    }

    async fn find_text(
        &self,
        file: &str,
        source: &str,
        lookup: &found_text::Lookup,
        text: &str,
    ) -> Vec<TextPlace> {
        let started = Instant::now();
        let files = self.index.files().await;
        let known: BTreeSet<&str> = files.iter().map(String::as_str).collect();
        let add_imports = |path: &str, content: &str, order: &mut Vec<String>| {
            for specifier in found_text::imports(path, content) {
                if let Some(resolved) = found_text::resolve(path, &specifier, &known)
                    && !order.contains(&resolved)
                {
                    order.push(resolved);
                }
            }
        };
        let mut order = vec![file.to_owned()];
        let mut contents = HashMap::from([(file.to_owned(), source.to_owned())]);
        add_imports(file, source, &mut order);
        if let Some(component) = &lookup.component {
            for (path, content) in self.render_site_files(&files, file, component, text).await {
                if !order.contains(&path) {
                    order.push(path.clone());
                }
                add_imports(&path, &content, &mut order);
                contents.insert(path, content);
            }
        }
        order.truncate(found_text::MAX_FILES);
        if matches!(lookup.key, Key::Translation(_)) {
            let locales: Vec<String> = files
                .iter()
                .filter(|path| found_text::is_locale(path) && !order.contains(path))
                .take(found_text::MAX_LOCALES)
                .cloned()
                .collect();
            order.extend(locales);
        }
        let mut places = Vec::new();
        for path in &order {
            let content = match contents.remove(path) {
                Some(content) => content,
                None => match self.read_project_file(path).await {
                    Ok(content) => content,
                    Err(_) => continue,
                },
            };
            if !found_text::could_contain(&content, text) {
                continue;
            }
            let found = found_text::places_in(
                path,
                &content,
                &lookup.key,
                text,
                lookup.component.as_deref(),
            );
            places.extend(found_text::text_places(path, &content, found));
        }
        tracing::info!(
            searched = order.len(),
            found = places.len(),
            ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            "traced the element's text to its source"
        );
        places
    }

    async fn with_source_text(
        &self,
        file: &str,
        source: &str,
        chosen: Option<&FinetunePropsSource>,
        ops: &mut Vec<EditOp>,
    ) -> Result<BTreeMap<String, String>, Failure> {
        let mut sources = BTreeMap::from([(file.to_owned(), source.to_owned())]);
        let Some(chosen) = chosen else {
            return Ok(sources);
        };
        let target = chosen.file.clone();
        let base = if target == file {
            source.to_owned()
        } else {
            self.read_project_file(&target).await?
        };
        ops.push(EditOp::TextAt {
            at: SrcLoc {
                line: chosen.line,
                column: chosen.column,
            },
            base_hash: content_hash(base.as_bytes()),
            file: target
                .clone()
                .try_into()
                .map_err(|_| Failure::invalid_request(format!("{target} is not a project path")))?,
            value: chosen.value.clone(),
        });
        sources.insert(target, base);
        Ok(sources)
    }

    async fn show_finetune(
        &self,
        file: &str,
        content: Option<&str>,
        others: Vec<(String, Option<String>)>,
        page_reload: Option<bool>,
    ) -> Result<UpdateResult, Failure> {
        let mut updates = Vec::new();
        for (path, other) in others {
            let overlaid = locked(&self.overlays).contains_key(&path);
            if other.is_some() || overlaid {
                updates.push(self.show_with(&path, other.as_deref(), page_reload).await?);
            }
        }
        let shown = self.show_with(file, content, page_reload).await?;
        let selected = (content.is_some() || updates.is_empty()).then(|| shown.clone());
        Ok(preview_outcome(selected, updates).unwrap_or(shown))
    }

    async fn preview_finetune(
        &self,
        request: FinetunePreview,
    ) -> Result<FinetunePreviewed, Failure> {
        let file = request.file;
        let source = self.read_project_file(&file).await?;
        let theme = self.theme().await;
        let project = project::detect(self.project.path(), &self.index.files().await);
        let style = inspect_with(
            &file,
            &source,
            request.line,
            request.column,
            &theme,
            self.styling(&project),
        )?;
        let mut ops = finetune_ops(&style, &request.props, &theme)?;
        let chosen = request.props.source.as_ref();
        let sources = self
            .with_source_text(&file, &source, chosen, &mut ops)
            .await?;
        let summary = summarize(&file, request.line, &ops);
        let mut patched = patch::apply_with(&sources, &ops, dialect(&project))?;
        let versions: BTreeMap<String, Version> = sources
            .into_iter()
            .map(|(path, base)| {
                let content = patched.remove(&path).unwrap_or_else(|| base.clone());
                (
                    path,
                    Version {
                        base,
                        content,
                        ops: Vec::new(),
                    },
                )
            })
            .collect();
        let changes: Vec<CodeChange> = versions
            .iter()
            .flat_map(|(path, version)| code_changes(path, &version.base, &version.content))
            .collect();
        let dom = template::is_server_rendered(&file)
            .then(|| {
                template::dom_patch(
                    &file,
                    &versions[&file].base,
                    &versions[&file].content,
                    request.line.get(),
                    request.column.get(),
                )
            })
            .flatten()
            .map(|mut dom| {
                if let Some(chosen) = chosen {
                    dom.text = vec![DomPatchTextItem {
                        run: 0,
                        value: chosen.value.clone(),
                    }];
                }
                dom
            });
        let page_reload = dom.is_some().then_some(false);
        let element = (file.clone(), request.line, request.column);
        let previous: Vec<String> = locked(&self.changesets)
            .values()
            .find(|changeset| changeset.element.as_ref() == Some(&element))
            .map_or_else(Vec::new, |changeset| {
                changeset.files.keys().cloned().collect()
            });
        let content = changed_content(&versions[&file]);
        let others = other_overlays(&file, &versions, previous);
        let changeset_id =
            self.store_changeset(Some(element), versions, summary, "finetune", Vec::new());
        let update = self
            .show_finetune(&file, content.as_deref(), others, page_reload)
            .await?;
        Ok(FinetunePreviewed {
            changeset_id,
            update,
            changes,
            dom,
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

    fn report(&self, progress: &mut Progress) {
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
        let held = slot
            .clone()
            .filter(|holder| locked(&self.variant_runs).contains_key(holder));
        if only_if_free && held.is_some() {
            return Ok(None);
        }
        let holder = held.filter(|holder| holder != run_id);
        let (file, versions, mut previews, waiting) = {
            let runs = locked(&self.variant_runs);
            let run = runs
                .get(run_id)
                .filter(|run| run.changesets.iter().any(|id| id == changeset_id))
                .ok_or_else(|| unknown_changeset(changeset_id))?;
            let changesets = locked(&self.changesets);
            let changeset = changesets
                .get(changeset_id)
                .ok_or_else(|| unknown_changeset(changeset_id))?;
            let waiting = !changeset.needs.is_empty();
            let previews: Vec<(String, String)> = changeset
                .created
                .iter()
                .filter(|_| !waiting)
                .map(|asset| (asset.path.clone(), asset.preview.clone()))
                .collect();
            (run.file.clone(), changeset.files.clone(), previews, waiting)
        };
        let mut main = None;
        if waiting {
            main = Some(self.read_project_file(&file).await?);
        } else {
            for (path, version) in &versions {
                let disk = self.read_project_file(path).await?;
                let content = materialize(path, version, &disk)?;
                if *path == file {
                    main = Some(content);
                } else {
                    previews.push((path.clone(), content));
                }
            }
        }
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
        let mut updates = Vec::new();
        for (path, preview) in &previews {
            updates.push(self.show(path, Some(preview)).await?);
        }
        let selected = match &main {
            Some(content) => Some(self.show(&file, Some(content)).await?),
            None => self.clear_shown(&file).await?,
        };
        for path in &cleared {
            self.clear_shown(path).await?;
        }
        *slot = Some(run_id.to_owned());
        Ok(preview_outcome(selected, updates))
    }

    async fn clear_shown(&self, file: &str) -> Result<Option<UpdateResult>, Failure> {
        if !locked(&self.overlays).contains_key(file) {
            return Ok(None);
        }
        self.show(file, None).await.map(Some)
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

    async fn release_preview(&self, run_id: &str) -> Result<(), Failure> {
        let mut slot = self.preview.lock().await;
        if slot.as_deref() != Some(run_id) {
            return Ok(());
        }
        *slot = None;
        let shown = locked(&self.variant_runs)
            .get_mut(run_id)
            .map(|run| (run.file.clone(), std::mem::take(&mut run.shown)));
        if let Some((file, shown)) = shown {
            self.clear_shown(&file).await?;
            for path in &shown {
                self.clear_shown(path).await?;
            }
        }
        Ok(())
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
        self.clear_shown(&run.file).await?;
        for path in &run.shown {
            self.clear_shown(path).await?;
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

    fn held_assets(&self, except_run: &str) -> Vec<String> {
        let runs = locked(&self.variant_runs);
        let changesets = locked(&self.changesets);
        runs.iter()
            .filter(|(run_id, _)| run_id.as_str() != except_run)
            .flat_map(|(_, run)| &run.changesets)
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
        let files = self.index.files().await;
        let project = project::detect(self.project.path(), &files);
        let style = inspect_with(
            &request.file,
            &source,
            request.line,
            request.column,
            &theme,
            self.styling(&project),
        )?;
        let group = self.picked(&request, &theme, &project).await?;
        let exact = r0::parse_property_edits(&prompt, &style)
            .filter(|_| group.is_empty())
            .and_then(|props| finetune_ops(&style, &props, &theme).ok())
            .filter(|ops| !ops.is_empty());
        let force_ai = request.force_ai.unwrap_or(false);
        let found = links::find(&prompt);
        let decision = route::classify(
            &prompt,
            exact.is_some(),
            force_ai,
            extras(&request, &found, group.len()).any(),
        );
        let related = if decision.tier == Tier::R0 && exact.is_some() {
            Related::default()
        } else {
            self.related(
                &request,
                &prompt,
                &source,
                &files,
                &group,
                decision.needs_usages,
            )
            .await
        };
        let mut editable = Contents::from([(request.file.clone(), source.clone())]);
        for file in &related.files {
            editable
                .entry(file.path.clone())
                .or_insert_with(|| file.content.clone());
        }
        let job = Job {
            request: &request,
            prompt: &prompt,
            links: &found,
            project: &project,
            source: &source,
            style: &style,
            group: &group,
            related: &related,
            editable: &editable,
            started,
            cancel,
        };
        match (decision.tier, exact) {
            (Tier::R0, Some(ops)) => self.exact_edit(&job, &ops).await,
            (Tier::R2, _) => {
                self.generate_with(&job, &generate::R2, decision.notice, decision.question)
                    .await
            }
            _ => {
                self.generate_with(&job, &generate::R1, decision.notice, decision.question)
                    .await
            }
        }
    }

    async fn exact_edit(&self, job: &Job<'_>, ops: &[EditOp]) -> Result<GenerateDone, Failure> {
        let file = job.request.file.as_str();
        let sources = BTreeMap::from([(file.to_owned(), job.source.to_owned())]);
        let content = patch::apply_with(&sources, ops, dialect(job.project))?
            .remove(file)
            .unwrap_or_else(|| job.source.to_owned());
        if content == job.source {
            return Err(Failure::new(
                ErrorCode::InvalidRequest,
                "The element already looks like that.",
            ));
        }
        let change = summarize(file, job.request.line, ops);
        let label = change
            .split_once(" · ")
            .map_or(change.as_str(), |(_, change)| change)
            .to_owned();
        let held = Held {
            label,
            system: "Your project".to_owned(),
            style: "Exact".to_owned(),
            rationale: "Made without a model call.".to_owned(),
            assets: Vec::new(),
            needs: Vec::new(),
        };
        let (variants, first) = self.hold_variants(
            job.request,
            job.editable,
            vec![(
                held,
                Contents::from([(file.to_owned(), content)]),
                ops.to_vec(),
            )],
            "R0",
            job.project.package_manager,
        );
        let update = match first {
            Some(first) => {
                self.preview_run(&job.request.run_id, &first, job.cancel)
                    .await?
            }
            None => None,
        };
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
            notes: Vec::new(),
            update,
        })
    }

    async fn generate_with(
        &self,
        job: &Job<'_>,
        tier: &TierConfig,
        notice: Option<&str>,
        question: bool,
    ) -> Result<GenerateDone, Failure> {
        let file = job.request.file.as_str();
        let Prepared {
            provider,
            discovery,
            model,
            effort,
            mut progress,
        } = self.prepare(job, tier).await?;
        let provider_name = provider.id().display_name();
        let model_label = model.as_deref().unwrap_or("default model");
        let linked = self.read_links(job, &*provider, &mut progress).await?;
        let references = self.references(job).await;
        let mut images = request_images(job.request);
        images.extend(linked.images);
        let timeout = generate::budget(tier, images.len(), job.links.links.len());
        let base = GenerationRequest {
            model: model.clone(),
            effort: Some(effort),
            system_prompt: generate::SYSTEM_PROMPT.to_owned(),
            user_prompt: full_prompt(job, tier, &references, &linked.section),
            images,
            tools: ToolPolicy::None,
            timeout,
            cwd: self.project.path().to_path_buf(),
            events: None,
        };
        let route = Route {
            tier: tier.tier,
            provider: Some(provider_name.to_owned()),
            model: model.clone(),
            notice: notice.map(str::to_owned),
        };
        let at = format!("<{}> {file}:{}", job.style.tag, job.request.line);
        let labels = RunLabels {
            route: format!("{} · {provider_name} {model_label}", tier.label),
            waits: RunDir::of(self.project.path()).timings_path(),
            key: timings::key(provider_name, model_label, tier.label),
        };
        if !question {
            progress.expect(timings::expected(&labels.waits, &labels.key));
        }
        let route_label = labels.route.as_str();
        let asked = self
            .ask_all(
                (&*provider, &discovery),
                &base,
                question,
                job,
                &mut progress,
                &labels,
            )
            .await?;
        let (variants, dropped, update) = match asked {
            Asked::Answer(answer) => {
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
                    notes: notes(linked.notes),
                    update: None,
                });
            }
            Asked::Variants {
                variants,
                dropped,
                update,
                first_ms,
            } => {
                labels.variants_ready(job, effort, first_ms, (variants.len(), &dropped));
                (variants, dropped, update)
            }
        };
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
            notes: notes(linked.notes),
            update,
        })
    }

    async fn ask_all(
        &self,
        (provider, discovery): (&dyn ProviderAdapter, &Discovery),
        base: &GenerationRequest,
        question: bool,
        job: &Job<'_>,
        progress: &mut Progress,
        labels: &RunLabels,
    ) -> Result<Asked, Failure> {
        let name = provider.id().display_name();
        let directions: Vec<Option<&str>> = if question {
            vec![None]
        } else {
            generate::DIRECTIONS.iter().copied().map(Some).collect()
        };
        let (events, mut received) = mpsc::unbounded_channel::<(usize, Option<ProviderEvent>)>();
        let tokens: Vec<CancellationToken> = directions
            .iter()
            .map(|_| job.cancel.child_token())
            .collect();
        let mut pending: FuturesUnordered<_> = directions
            .iter()
            .enumerate()
            .map(|(index, direction)| {
                let mut request = base.clone();
                if let Some(direction) = direction {
                    request.user_prompt = format!("{}\n{direction}\n", request.user_prompt);
                }
                let (run_events, mut run_received) = mpsc::unbounded_channel();
                request.events = Some(run_events);
                let forward = events.clone();
                let token = &tokens[index];
                async move {
                    let _slot = tokio::select! {
                        slot = self.slots.acquire() => slot.ok(),
                        () = token.cancelled() => return Err(ProviderError::Cancelled.into()),
                    };
                    let _ = forward.send((index, None));
                    let relay = async {
                        while let Some(event) = run_received.recv().await {
                            let _ = forward.send((index, Some(event)));
                        }
                    };
                    let (result, ()) =
                        tokio::join!(self.ask(provider, discovery, request, token), relay);
                    result
                }
            })
            .collect();
        drop(events);
        let mut latest: Vec<Option<ProviderEvent>> = vec![None; directions.len()];
        let mut collected = Collected::default();
        let mut remaining = directions.len();
        let mut started = 0;
        let free = self.slots.available_permits().min(directions.len());
        progress.start(Step::Ask);
        progress.detail(generate::runs_detail(&latest, free, 0, name));
        self.report(progress);
        while remaining > 0 {
            tokio::select! {
                Some(result) = pending.next() => {
                    remaining -= 1;
                    let arrival = self
                        .take_arrival(job, labels, result, &mut collected, progress)
                        .await?;
                    match arrival {
                        Arrival::More => {}
                        Arrival::Answer(answer) => {
                            tokens.iter().for_each(CancellationToken::cancel);
                            return Ok(Asked::Answer(answer));
                        }
                        Arrival::Settled => {
                            tokens.iter().for_each(CancellationToken::cancel);
                            return Err(ProviderError::Cancelled.into());
                        }
                    }
                    progress.arrived(&collected.held, remaining);
                    progress.detail(generate::runs_detail(&latest, started, collected.held.len(), name));
                    self.report(progress);
                }
                Some((index, event)) = received.recv() => {
                    match event {
                        Some(event) => latest[index] = Some(event),
                        None => started += 1,
                    }
                    progress.detail(generate::runs_detail(&latest, started, collected.held.len(), name));
                    self.report(progress);
                }
            }
        }
        self.finish_variants(job, collected, progress).await
    }

    async fn take_arrival(
        &self,
        job: &Job<'_>,
        labels: &RunLabels,
        result: Result<VariantSet, Failure>,
        collected: &mut Collected,
        progress: &mut Progress,
    ) -> Result<Arrival, Failure> {
        let run_id = job.request.run_id.as_str();
        let set = match result {
            Ok(set) => set,
            Err(failure) => {
                collected.dropped.push(GenerateDoneDroppedItem {
                    label: None,
                    reason: failure.message.clone(),
                });
                collected.failures.push(failure);
                return Ok(Arrival::More);
            }
        };
        if set.variants.is_empty() {
            if let Some(answer) = set.answer.filter(|_| collected.held.is_empty()) {
                return Ok(Arrival::Answer(String::from(answer)));
            }
            return Ok(Arrival::More);
        }
        let proposed = set.variants.into_iter().take(1).collect();
        match self.check_and_hold(job, proposed, &labels.route).await {
            Ok((variants, more, first)) => {
                if !variants.is_empty() && collected.first_ms.is_none() {
                    collected.first_ms = Some(labels.first_arrived(job));
                }
                collected.dropped.extend(more);
                collected.held.extend(variants);
                collected
                    .held
                    .sort_by_key(|variant| variant.needs.is_some());
                if collected.update.is_none()
                    && let Some(first) = first
                    && let Some(shown) = self.show_variant(run_id, &first, true).await?
                {
                    progress.previewed(shown.clone());
                    collected.update = Some(shown);
                }
            }
            Err(failure) => collected.dropped.push(GenerateDoneDroppedItem {
                label: None,
                reason: failure.message,
            }),
        }
        if !collected.held.is_empty() && !locked(&self.variant_runs).contains_key(run_id) {
            return Ok(Arrival::Settled);
        }
        Ok(Arrival::More)
    }

    async fn finish_variants(
        &self,
        job: &Job<'_>,
        collected: Collected,
        progress: &mut Progress,
    ) -> Result<Asked, Failure> {
        if job.cancel.is_cancelled() {
            self.discard_run(&job.request.run_id).await?;
            return Err(ProviderError::Cancelled.into());
        }
        if collected.held.is_empty() {
            let reasons: Vec<&str> = collected
                .dropped
                .iter()
                .map(|item| item.reason.as_str())
                .collect();
            let fallback = if reasons.is_empty() {
                invalid_output("it proposed no variant")
            } else {
                Failure::new(ErrorCode::ProviderInvalidOutput, reasons.join(" "))
                    .with_action("Retry, or simplify the prompt.")
            };
            return Err(collected.failures.into_iter().next().unwrap_or(fallback));
        }
        progress.start(Step::Preview);
        self.report(progress);
        Ok(Asked::Variants {
            variants: collected.held,
            dropped: collected.dropped,
            update: collected.update,
            first_ms: collected.first_ms,
        })
    }

    async fn read_links(
        &self,
        job: &Job<'_>,
        provider: &dyn ProviderAdapter,
        progress: &mut Progress,
    ) -> Result<links::Rendered, Failure> {
        if job.links.is_empty() {
            return Ok(links::Rendered::default());
        }
        let images = provider.capabilities().image_input;
        let mut lines = Vec::new();
        let browser = match screenshot::find_browser() {
            Browser::Path(path) => Some(path),
            Browser::Missing if images => {
                lines.push(format!(
                    "No Chrome, Brave, Edge or Chromium was found, so links were read without screenshots. Set {} to a browser to add them.",
                    screenshot::BROWSER_ENV
                ));
                None
            }
            Browser::Missing | Browser::Off => None,
        };
        if !images {
            lines.push(format!(
                "{} can't read images, so links were read without screenshots.",
                provider.id().display_name()
            ));
        }
        let options = links::Options {
            images,
            browser,
            limit: links::READ_LIMIT,
        };
        progress.start(Step::Links);
        self.report(progress);
        let (events, mut received) = mpsc::unbounded_channel();
        let reading = links::read_all(job.links, &options, &events, job.cancel);
        tokio::pin!(reading);
        let reports = loop {
            tokio::select! {
                reports = &mut reading => break reports,
                Some(detail) = received.recv() => {
                    progress.detail(detail);
                    self.report(progress);
                }
            }
        };
        let Some(reports) = reports else {
            return Err(ProviderError::Cancelled.into());
        };
        let mut rendered = links::render(
            reports,
            job.links.skipped,
            request_images(job.request).len() + 1,
        );
        lines.append(&mut rendered.notes);
        rendered.notes = lines;
        Ok(rendered)
    }

    async fn check_and_hold(
        &self,
        job: &Job<'_>,
        proposed: Vec<Variant>,
        route_label: &str,
    ) -> Result<
        (
            Vec<VariantPreview>,
            Vec<GenerateDoneDroppedItem>,
            Option<String>,
        ),
        Failure,
    > {
        let file = job.request.file.as_str();
        let existing = self.index.files().await;
        let assets_dir = assets::assets_dir(&existing);
        let taken = self.held_assets(&job.request.run_id);
        let checks = Checks {
            assets_dir: &assets_dir,
            existing: &existing,
            taken: &taken,
            project: job.project,
            root: self.project.path(),
        };
        let (valid, dropped) = validate_variants(proposed, job.editable, file, &checks)?;
        if job.cancel.is_cancelled() {
            return Err(ProviderError::Cancelled.into());
        }
        let mut dropped = dropped;
        let mut wanting = Vec::new();
        for (variant, contents, files) in valid {
            match libraries_needed(
                job.editable,
                &contents,
                &files,
                job.project,
                self.project.path(),
            ) {
                Ok(names) => wanting.push((variant, contents, files, names)),
                Err(reason) => dropped.push(GenerateDoneDroppedItem {
                    label: Some(String::from(variant.label.clone())),
                    reason,
                }),
            }
        }
        let names: BTreeSet<String> = wanting
            .iter()
            .flat_map(|(_, _, _, names)| names.iter().cloned())
            .collect();
        let versions = self.versions_for(&names, job.project).await;
        let mut held: Vec<(Held, Contents, Vec<EditOp>)> = Vec::new();
        for (variant, contents, files, names) in wanting {
            let found: Result<Vec<Need>, String> = names
                .iter()
                .map(|name| match versions.get(name) {
                    Some(Ok(version)) => Ok(Need {
                        name: name.clone(),
                        version: version.clone(),
                    }),
                    Some(Err(reason)) => Err(format!("Couldn't look up {name} on npm: {reason}.")),
                    None => Err(format!("Couldn't look up {name} on npm.")),
                })
                .collect();
            match found {
                Ok(needs) => {
                    let ops = edits_of(&variant.ops, job.editable);
                    held.push((Held::from_variant(variant, files, needs), contents, ops));
                }
                Err(reason) => dropped.push(GenerateDoneDroppedItem {
                    label: Some(String::from(variant.label.clone())),
                    reason,
                }),
            }
        }
        if held.is_empty() {
            let reasons: Vec<&str> = dropped.iter().map(|item| item.reason.as_str()).collect();
            return Err(
                Failure::new(ErrorCode::ProviderInvalidOutput, reasons.join(" "))
                    .with_action("Retry, or simplify the prompt."),
            );
        }
        held.sort_by_key(|(variant, _, _)| !variant.needs.is_empty());
        let (variants, first) = self.hold_variants(
            job.request,
            job.editable,
            held,
            route_label,
            job.project.package_manager,
        );
        Ok((variants, dropped, first))
    }

    async fn versions_for(
        &self,
        names: &BTreeSet<String>,
        project: &Project,
    ) -> BTreeMap<String, Result<String, String>> {
        let mut found = BTreeMap::new();
        if names.is_empty() {
            return found;
        }
        let Ok(npm) = which::which("npm") else {
            return names
                .iter()
                .map(|name| (name.clone(), Err("npm isn't installed".to_owned())))
                .collect();
        };
        let today = libraries::today();
        let lookups = names.iter().map(|name| {
            let npm = npm.clone();
            let major = libraries::major_for(name, project).flatten();
            async move {
                let cached = locked(&self.versions)
                    .get(&(name.clone(), major))
                    .filter(|(_, at)| at.elapsed() < VERSION_CACHE)
                    .map(|(version, _)| version.clone());
                let version = match cached {
                    Some(version) => Ok(version),
                    None => install::lookup(&npm, name, major, today, install::LOOKUP_TIMEOUT)
                        .await
                        .map_err(|error| error.to_string()),
                };
                if let Ok(version) = &version {
                    locked(&self.versions)
                        .insert((name.clone(), major), (version.clone(), Instant::now()));
                }
                (name.clone(), version)
            }
        });
        found.extend(futures_util::future::join_all(lookups).await);
        found
    }

    async fn install_dependencies(
        &self,
        request: DependenciesInstall,
    ) -> Result<DependenciesInstalled, Failure> {
        let needs = locked(&self.changesets)
            .get(&request.changeset_id)
            .map(|changeset| changeset.needs.clone())
            .ok_or_else(|| unknown_changeset(&request.changeset_id))?;
        if !needs.is_empty() {
            let files = self.index.files().await;
            let manager = project::detect(self.project.path(), &files).package_manager;
            let command = install::command_line(manager, &needs);
            let binary = which::which(manager.command()).map_err(|_| {
                Failure::new(
                    ErrorCode::Internal,
                    format!(
                        "{} isn't installed, so GUIJam can't run {command}.",
                        manager.command()
                    ),
                )
            })?;
            install::install(
                &binary,
                manager,
                &needs,
                self.project.path(),
                install::INSTALL_TIMEOUT,
            )
            .await
            .map_err(|error| {
                Failure::new(ErrorCode::Internal, format!("{command} failed: {error}"))
                    .with_action("Install it yourself, then pick the variant again.")
            })?;
            let installed: BTreeSet<&str> = needs.iter().map(|need| need.name.as_str()).collect();
            for changeset in locked(&self.changesets).values_mut() {
                changeset
                    .needs
                    .retain(|need| !installed.contains(need.name.as_str()));
            }
        }
        let update = self
            .show_variant(&request.run_id, &request.changeset_id, false)
            .await?
            .ok_or_else(|| unknown_changeset(&request.changeset_id))?;
        Ok(DependenciesInstalled {
            changeset_id: request.changeset_id,
            installed: needs.iter().filter_map(package).collect(),
            update,
        })
    }

    async fn references(&self, job: &Job<'_>) -> String {
        let files = self.index.files().await;
        let container = format!(
            "{}:{}:{}",
            job.request.file, job.request.line, job.request.column
        );
        let sketch = job
            .request
            .sketch
            .as_ref()
            .map_or_else(String::new, |sketch| {
                references::sketch_section(sketch, &container, job.related.page_near.as_deref())
            });
        let found = references::section(
            job.request.page.as_ref(),
            &files,
            &self.project.path().to_string_lossy(),
            job.prompt,
        );
        let shown = related::render(&job.related.files);
        let inspiration = references::inspiration_section(
            sketch_count(job.request) + 1,
            inspiration_count(job.request),
        );
        let place = job.related.place_file(&job.request.file);
        let folder = assets::prompt_note(place, &assets::assets_dir(&files));
        let new_ui = project::new_ui_section(job.project, &files, place);
        let libraries = libraries::prompt_section(job.project);
        format!("{sketch}{inspiration}{found}{shown}{folder}{new_ui}{libraries}")
    }

    async fn related(
        &self,
        request: &GenerateRequest,
        prompt: &str,
        source: &str,
        files: &[String],
        group: &[Picked],
        needs_usages: bool,
    ) -> Related {
        let started = Instant::now();
        let selected = request.file.as_str();
        let component =
            jsx::enclosing_component(selected, source, request.line.get(), request.column.get());
        let mut found = group_files(request, group);
        let on_page = references::page_files(request.page.as_ref());
        let mentioned: Vec<String> =
            references::mentioned_sources(files, prompt, selected, &on_page)
                .into_iter()
                .map(str::to_owned)
                .collect();
        let mut names: Vec<String> = Vec::new();
        if needs_usages {
            names.extend(component.iter().map(|component| component.name.clone()));
            names.extend(
                group
                    .iter()
                    .filter_map(|picked| picked.component.as_ref())
                    .map(|component| component.name.clone()),
            );
            names.extend(
                mentioned
                    .iter()
                    .filter_map(|path| related::component_name(path))
                    .map(str::to_owned),
            );
            names.sort();
            names.dedup();
        }
        let mut sites = self.render_sites(files, &names).await;
        let mut rendered = |name: &str, skip: &[&str], limit: usize| {
            let candidates: Vec<RenderSite> = sites
                .remove(name)
                .unwrap_or_default()
                .into_iter()
                .filter(|site| !skip.contains(&site.path.as_str()))
                .collect();
            related::ranked(candidates, &on_page, limit)
                .into_iter()
                .map(|site| rendered_by(site, name))
                .collect::<Vec<_>>()
        };
        if let Some(component) = component.as_ref().filter(|_| needs_usages) {
            for file in rendered(&component.name, &[selected], related::MAX_RENDER_SITES) {
                related::add(&mut found, file);
            }
        }
        for picked in group.iter().filter(|_| needs_usages) {
            if let Some(component) = picked.component.as_ref() {
                for file in rendered(&component.name, &[&picked.style.file], 1) {
                    related::add(&mut found, file);
                }
            }
        }
        let page_near = self.page_near(request, source).await;
        if let Some((_, file)) = &page_near {
            related::add(&mut found, file.clone());
        }
        for path in &mentioned {
            if let Ok(content) = self.read_project_file(path).await {
                related::add(
                    &mut found,
                    RelatedFile {
                        path: path.clone(),
                        content,
                        anchors: Vec::new(),
                        why: NAMED_WHY.to_owned(),
                        selected: false,
                    },
                );
            }
        }
        for path in &mentioned {
            if let Some(name) = related::component_name(path) {
                for file in rendered(name, &[selected, path], 1) {
                    related::add(&mut found, file);
                }
            }
        }
        tracing::info!(
            files = found.len(),
            searched = names.len(),
            ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            "gathered the files around the element"
        );
        Related {
            files: found,
            component,
            page_near: page_near.map(|(near, _)| near),
        }
    }

    async fn render_sites(
        &self,
        files: &[String],
        names: &[String],
    ) -> BTreeMap<String, Vec<RenderSite>> {
        let mut sites: BTreeMap<String, Vec<RenderSite>> = BTreeMap::new();
        if names.is_empty() {
            return sites;
        }
        let paths: Vec<String> = related::candidates(files)
            .into_iter()
            .map(str::to_owned)
            .collect();
        let mut reads = futures_util::stream::iter(paths)
            .map(|path| async move {
                let content = self.read_project_file(&path).await;
                (path, content)
            })
            .buffer_unordered(READ_CONCURRENCY);
        while let Some((path, content)) = reads.next().await {
            let Ok(content) = content else {
                continue;
            };
            for name in names {
                let lines = related::render_lines(&path, &content, name);
                if !lines.is_empty() {
                    sites.entry(name.clone()).or_default().push(RenderSite {
                        path: path.clone(),
                        content: content.clone(),
                        lines,
                    });
                }
            }
        }
        sites
    }

    async fn page_near(
        &self,
        request: &GenerateRequest,
        source: &str,
    ) -> Option<(String, RelatedFile)> {
        let sketch = request
            .sketch
            .as_ref()
            .filter(|sketch| sketch.element_box.is_none())?;
        let near = sketch.near.as_ref()?.to_string();
        let (file, line, _) = references::parse_src(&near)?;
        if file == request.file
            || !jsx::renders_children(
                &request.file,
                source,
                request.line.get(),
                request.column.get(),
            )
            .unwrap_or(false)
        {
            return None;
        }
        let content = self.read_project_file(file).await.ok()?;
        let page = RelatedFile {
            path: file.to_owned(),
            content,
            anchors: vec![line],
            why: PAGE_WHY.to_owned(),
            selected: false,
        };
        Some((near, page))
    }

    async fn prepare(&self, job: &Job<'_>, tier: &TierConfig) -> Result<Prepared, Failure> {
        let mut progress = Progress::new(
            &job.request.run_id,
            job.style,
            &self.stylesheet_names(),
            extras(job.request, job.links, job.group.len()),
            generate::budget(
                tier,
                request_images(job.request).len(),
                job.links.links.len(),
            ),
        );
        progress.start(Step::Read);
        progress.detail("Finding your AI tool…".to_owned());
        self.report(&mut progress);
        let (provider, discovery) = self.provider().await?;
        let provider_id = provider.id();
        let provider_name = provider_id.display_name();
        if !request_images(job.request).is_empty() && !provider.capabilities().image_input {
            return Err(Failure::new(
                ErrorCode::InvalidRequest,
                format!(
                    "{provider_name} can't read images, so sketches and attached images need an AI tool that can."
                ),
            )
            .with_action("Choose another with npx guijam provider use <id>."));
        }
        let saved = config::provider_model(provider_id);
        if let Some(saved) = saved.as_deref()
            && let Ok(models) = provider.models(&discovery).await
            && !models.is_empty()
            && !models.iter().any(|info| info.id == saved)
        {
            return Err(Failure::new(
                ErrorCode::ProviderNotAuthenticated,
                format!("{provider_name} can't reach {saved} with the keys it has."),
            )
            .with_action(
                "Add a key for that model's provider (for OpenCode: opencode auth login), or pick another model with npx guijam init.",
            ));
        }
        let model = saved.or_else(|| tier.model_for(provider_id).map(str::to_owned));
        let effort = config::provider_effort(provider_id).unwrap_or(tier.effort);
        let model_label = model.as_deref().unwrap_or("default model");
        progress.relabel(Step::Ask, generate::ask_label(provider_name, model_label));
        progress.detail("Gathering the page, assets and files it needs…".to_owned());
        self.report(&mut progress);
        Ok(Prepared {
            provider,
            discovery,
            model,
            effort,
            progress,
        })
    }

    async fn ask(
        &self,
        provider: &dyn ProviderAdapter,
        discovery: &Discovery,
        request: GenerationRequest,
        cancel: &CancellationToken,
    ) -> Result<VariantSet, Failure> {
        let model = request.model.clone();
        let effort = request.effort;
        let prompt_chars = request.system_prompt.len() + request.user_prompt.len();
        let images = request.images.len();
        let result = provider.generate(discovery, request, cancel.clone()).await;
        if let Ok(output) = &result {
            let answer_bytes =
                serde_json::to_string(&output.variant_set).map_or(0, |text| text.len());
            tracing::info!(
                provider = %provider.id(),
                version = %discovery.version,
                model = model.as_deref().unwrap_or("default"),
                effort = effort.map_or("default", Effort::as_str),
                prompt_chars,
                images,
                ready_ms = output.timings.ready.map(|ready| ready.as_millis()),
                answer_ms = output.timings.answer.as_millis(),
                answer_bytes,
                cost_usd = output.cost_usd,
                "the AI tool answered"
            );
        }
        if let Err(error) = &result
            && !matches!(error, ProviderError::Cancelled)
        {
            tracing::warn!(
                provider = %provider.id(),
                version = %discovery.version,
                model = model.as_deref().unwrap_or("default"),
                error = %without_account_ids(&error.to_string()),
                "the AI tool run failed"
            );
        }
        match result {
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
        bases: &Contents,
        held: Vec<(Held, Contents, Vec<EditOp>)>,
        route_label: &str,
        manager: PackageManager,
    ) -> (Vec<VariantPreview>, Option<String>) {
        let file = &request.file;
        let variants: Vec<VariantPreview> = held
            .into_iter()
            .map(|(variant, contents, ops)| {
                let summary = format!(
                    "{file}:{} · {}{} ({route_label})",
                    request.line,
                    variant.label,
                    also_edits(file, &contents)
                );
                let order =
                    std::iter::once(file).chain(contents.keys().filter(|path| *path != file));
                let mut changes: Vec<CodeChange> = order
                    .filter_map(|path| {
                        let content = contents.get(path)?;
                        let base = bases.get(path).map_or("", String::as_str);
                        Some(code_changes(path, base, content))
                    })
                    .flatten()
                    .collect();
                for created in variant.assets.iter().filter(|asset| {
                    std::path::Path::new(&asset.path)
                        .extension()
                        .is_some_and(|extension| extension == "tsx" || extension == "jsx")
                }) {
                    changes.extend(code_changes(&created.path, "", &created.preview));
                }
                let created = variant
                    .assets
                    .iter()
                    .map(|asset| asset.path.clone())
                    .collect();
                let versions: BTreeMap<String, Version> = contents
                    .into_iter()
                    .map(|(path, content)| {
                        let version = Version {
                            base: bases.get(&path).cloned().unwrap_or_default(),
                            content,
                            ops: ops
                                .iter()
                                .filter(|op| generate::op_file(op) == path)
                                .cloned()
                                .collect(),
                        };
                        (path, version)
                    })
                    .collect();
                let changeset_id =
                    self.store_changeset(None, versions, summary, "ai", variant.assets);
                if let Some(changeset) = locked(&self.changesets).get_mut(&changeset_id) {
                    changeset.needs.clone_from(&variant.needs);
                }
                VariantPreview {
                    needs: dependency_needs(&variant.needs, manager),
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
        locked(&self.variant_runs)
            .entry(request.run_id.clone())
            .or_insert_with(|| VariantRun {
                file: file.clone(),
                changesets: Vec::new(),
                shown: Vec::new(),
            })
            .changesets
            .extend(variants.iter().map(|variant| variant.changeset_id.clone()));
        let first = variants
            .first()
            .filter(|variant| variant.needs.is_none())
            .map(|variant| variant.changeset_id.clone());
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
            AuthStatus::LoggedIn => {}
            AuthStatus::NotLoggedIn { login_command } => {
                return Err(not_authenticated(provider.id(), login_command, None));
            }
            AuthStatus::Unknown { reason } => {
                tracing::warn!(%reason, "could not read the provider's login status");
            }
        }
        *ready = Some((id, discovery.clone(), Instant::now()));
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
                needs: Vec::new(),
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
        let edited: Vec<String> = changeset
            .files
            .iter()
            .filter(|(_, version)| !version.ops.is_empty() || version.base != version.content)
            .map(|(path, _)| path.clone())
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
        let (journal_id, snapshot) = written?;
        self.tracker.remember(
            &journal_id,
            Snapshot {
                files: snapshot,
                summary: changeset.summary.clone(),
                agent: agent_of(changeset.origin),
                committed_at: Instant::now(),
            },
        );
        Ok(CommitDone {
            journal_id,
            files: edited,
            summary: changeset.summary,
        })
    }

    async fn write_changeset(
        &self,
        changeset: &Changeset,
    ) -> Result<(String, Vec<SnapshotFile>), Failure> {
        let _write = self.write_lock.lock().await;
        let mut changes = Vec::new();
        let mut snapshot = Vec::new();
        for (path, version) in &changeset.files {
            if version.ops.is_empty() {
                if version.base != version.content {
                    changes.push(FileChange::edit(
                        path.clone(),
                        content_hash(version.base.as_bytes()),
                        version.content.clone(),
                    ));
                    snapshot.push(SnapshotFile {
                        path: path.clone(),
                        before: version.base.clone(),
                        after: version.content.clone(),
                    });
                }
                continue;
            }
            let disk = self.read_project_file(path).await?;
            let content = materialize(path, version, &disk)?;
            if content != disk {
                snapshot.push(SnapshotFile {
                    path: path.clone(),
                    before: disk.clone(),
                    after: content.clone(),
                });
                changes.push(FileChange::edit(
                    path.clone(),
                    content_hash(disk.as_bytes()),
                    content,
                ));
            }
        }
        snapshot.extend(changeset.created.iter().filter_map(|asset| {
            Some(SnapshotFile {
                path: asset.path.clone(),
                before: String::new(),
                after: String::from_utf8(asset.content.clone()).ok()?,
            })
        }));
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
        let journal_id =
            tokio::task::spawn_blocking(move || journal.commit(&changes, origin, &summary))
                .await
                .map_err(|error| Failure::new(ErrorCode::Internal, error.to_string()))?
                .map_err(Failure::from)?;
        Ok((journal_id, snapshot))
    }

    async fn discard(&self, changeset_id: &str) -> Result<(), Failure> {
        let changeset = locked(&self.changesets)
            .remove(changeset_id)
            .ok_or_else(|| unknown_changeset(changeset_id))?;
        let in_place = changeset.origin == "finetune";
        for file in changeset.files.keys() {
            let page_reload = (in_place && template::is_server_rendered(file)).then_some(false);
            self.show_with(file, None, page_reload).await?;
        }
        Ok(())
    }

    async fn undo(&self, journal_id: String) -> Result<UndoDone, Failure> {
        let write = self.write_lock.lock().await;
        let journal = Arc::clone(&self.journal);
        let target = journal_id.clone();
        let (undo_id, paths) = tokio::task::spawn_blocking(move || {
            let paths = journal.paths(&target)?;
            Ok::<_, CommitError>((journal.undo(&target)?, paths))
        })
        .await
        .map_err(|error| Failure::new(ErrorCode::Internal, error.to_string()))??;
        drop(write);
        for path in &paths {
            self.refresh(path);
        }
        if let Some((site, key)) = self.tracker.undone(&journal_id) {
            let reverted = journal_id.clone();
            tokio::spawn(async move {
                if let Err(error) = tracker::revert(site, key, reverted).await {
                    tracing::warn!(%error, "couldn't mark the ticket as reverted");
                }
            });
        }
        Ok(UndoDone {
            journal_id: undo_id,
            undo_of: journal_id,
        })
    }

    fn refresh(&self, file: &str) {
        if locked(&self.overlays).contains_key(file) {
            return;
        }
        if let Some(link) = locked(&self.plugin).clone() {
            let _ = link.send(overlay_message(None, file, None, None));
        }
    }

    async fn show(&self, file: &str, content: Option<&str>) -> Result<UpdateResult, Failure> {
        self.show_with(file, content, None).await
    }

    async fn show_with(
        &self,
        file: &str,
        content: Option<&str>,
        page_reload: Option<bool>,
    ) -> Result<UpdateResult, Failure> {
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
        let message = overlay_message(Some(id.clone()), file, content, page_reload);
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
            let _ = link.send(overlay_message(
                Some(id),
                &file,
                Some(&content),
                Some(false),
            ));
        }
    }
}

fn overlay_message(
    id: Option<String>,
    file: &str,
    content: Option<&str>,
    page_reload: Option<bool>,
) -> GuijamMessage {
    match content {
        Some(content) => GuijamMessage::OverlaySet {
            id,
            payload: OverlaySet {
                file: file.to_owned(),
                content: content.to_owned(),
                page_reload,
            },
        },
        None => GuijamMessage::OverlayClear {
            id,
            payload: OverlayClear {
                file: file.to_owned(),
                page_reload,
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

fn agent_of(origin: &str) -> String {
    if origin == "finetune" {
        return "Direct edit, no AI".to_owned();
    }
    let provider = config::active_provider().unwrap_or(DEFAULT_PROVIDER);
    match config::provider_model(provider) {
        Some(model) => format!("{provider} · {model}"),
        None => provider.to_string(),
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
        | GuijamMessage::DependenciesInstall { id, .. }
        | GuijamMessage::DependenciesInstalled { id, .. }
        | GuijamMessage::GenerateDiscard { id, .. }
        | GuijamMessage::GenerateDiscarded { id, .. }
        | GuijamMessage::GenerateAttach { id, .. }
        | GuijamMessage::PreviewRelease { id, .. }
        | GuijamMessage::PreviewReleased { id, .. }
        | GuijamMessage::TrackerStatus { id, .. }
        | GuijamMessage::TrackerStatusOk { id, .. }
        | GuijamMessage::TrackerSearch { id, .. }
        | GuijamMessage::TrackerTickets { id, .. }
        | GuijamMessage::TrackerTicket { id, .. }
        | GuijamMessage::TrackerTicketOk { id, .. }
        | GuijamMessage::TrackerStart { id, .. }
        | GuijamMessage::TrackerStarted { id, .. }
        | GuijamMessage::TrackerPost { id, .. }
        | GuijamMessage::TrackerPosted { id, .. }
        | GuijamMessage::TrackerReport { id, .. }
        | GuijamMessage::TrackerReported { id, .. }
        | GuijamMessage::Error { id, .. } => *id = reply_to,
    }
    message
}

fn message_id(message: &GuijamMessage) -> Option<String> {
    serde_json::to_value(message).ok().and_then(|value| {
        value
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    })
}

fn dialect(project: &Project) -> patch::Dialect {
    patch::Dialect {
        solid: project.ui == project::Ui::Solid,
    }
}

fn installed(payload: DependenciesInstalled) -> GuijamMessage {
    GuijamMessage::DependenciesInstalled { id: None, payload }
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

fn style_change(ops: &[EditOp]) -> Option<String> {
    let parts: Vec<String> = ops
        .iter()
        .filter_map(|op| match op {
            EditOp::StyleProp { prop, value, .. } => Some(match value {
                EditOpValue::String(text) => format!("{} {text}", prop.as_str()),
                EditOpValue::Number(number) => format!("{} {number}", prop.as_str()),
                EditOpValue::Null => format!("- {}", prop.as_str()),
            }),
            EditOp::JsxAttr { name, value, .. } => Some(match value {
                Some(JsxValue::String(text) | JsxValue::Expression(text)) => {
                    format!("{}=\"{text}\"", name.as_str())
                }
                None => format!("- {}", name.as_str()),
            }),
            EditOp::TextContent { value, .. } | EditOp::TextAt { value, .. } => {
                let shown: String = value.chars().take(SUMMARY_TEXT_CHARS).collect();
                let cut = if value.chars().count() > SUMMARY_TEXT_CHARS {
                    "\u{2026}"
                } else {
                    ""
                };
                Some(format!("text \"{shown}{cut}\""))
            }
            _ => None,
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

fn summarize(file: &str, line: NonZeroU64, ops: &[EditOp]) -> String {
    if let Some(change) = style_change(ops) {
        return format!("{file}:{line} · {change}");
    }
    let Some(EditOp::ClassTokens { add, remove, .. }) = ops.first() else {
        return format!("{file}:{line}");
    };
    let join = |tokens: Vec<&str>| tokens.join(" ");
    let added = join(add.iter().map(|token| token.as_str()).collect());
    let removed = join(remove.iter().map(|token| token.as_str()).collect());
    let change = match (removed.is_empty(), added.is_empty()) {
        (false, false) => format!("{removed} → {added}"),
        (true, false) => format!("+ {added}"),
        (false, true) => format!("- {removed}"),
        (true, true) => "no change".to_owned(),
    };
    format!("{file}:{line} · {change}")
}

#[cfg(test)]
mod tests {
    use gjd_core::content_hash;
    use gjd_core::contracts::{EditOp, ErrorCode};
    use serde_json::json;

    use std::path::Path;

    use super::{
        Checks, Contents, Picked, Version, apply_variant, edits_of, group_files, materialize,
        provider_failure, summarize, validate_variants, without_account_ids,
    };

    #[test]
    fn a_text_edit_reads_as_its_new_text_cut_to_forty_characters() {
        let text = |value: &str| -> EditOp {
            serde_json::from_value(json!({
                "kind": "text_content", "file": "src/App.tsx", "base_hash": "0".repeat(64),
                "at": { "line": 31, "column": 11 }, "run": 0, "value": value,
            }))
            .expect("op")
        };
        let line = std::num::NonZeroU64::new(31).expect("line");
        assert_eq!(
            summarize("src/App.tsx", line, &[text("Freshly roasted")]),
            "src/App.tsx:31 · text \"Freshly roasted\""
        );
        assert_eq!(
            summarize("src/App.tsx", line, &[text(&"a".repeat(45))]),
            format!("src/App.tsx:31 · text \"{}\u{2026}\"", "a".repeat(40))
        );
        let found: EditOp = serde_json::from_value(json!({
            "kind": "text_at", "file": "src/i18n/en.json", "base_hash": "0".repeat(64),
            "at": { "line": 3, "column": 14 }, "value": "Open daily",
        }))
        .expect("op");
        assert_eq!(
            summarize("src/App.tsx", line, &[found]),
            "src/App.tsx:31 · text \"Open daily\""
        );
    }
    use crate::project::{PackageManager, Project, Ui};

    #[test]
    fn shows_each_other_selected_file_once_unless_the_source_window_already_has_it() {
        use std::num::NonZeroU64;

        use gjd_core::contracts::GenerateRequest;
        use gjd_core::theme::Theme;

        let lines = |count: usize| format!("<>\n{}</>\n", "<p />\n".repeat(count));
        let picked = |file: &str, source: &str, line: u64| {
            let at = |value| NonZeroU64::new(value).expect("1-based");
            Picked {
                style: gjd_core::style::inspect(file, source, at(line), at(1), &Theme::default())
                    .expect("element"),
                source: source.to_owned(),
                component: None,
            }
        };
        let app = lines(400);
        let card = lines(20);
        let request: GenerateRequest = serde_json::from_value(json!({
            "runId": "r1",
            "file": "src/App.tsx",
            "line": 10,
            "column": 1,
            "prompt": "make these bigger",
        }))
        .expect("request");
        let group = [
            picked("src/App.tsx", &app, 130),
            picked("src/App.tsx", &app, 131),
            picked("src/Card.tsx", &card, 4),
            picked("src/Card.tsx", &card, 12),
        ];

        let found = group_files(&request, &group);

        let shown: Vec<(&str, &[u64], &str, bool)> = found
            .iter()
            .map(|file| {
                (
                    file.path.as_str(),
                    file.anchors.as_slice(),
                    file.why.as_str(),
                    file.selected,
                )
            })
            .collect();
        assert_eq!(
            shown,
            [
                ("src/App.tsx", &[131][..], "selected too", true),
                ("src/Card.tsx", &[4, 12][..], "selected too", true),
            ]
        );
    }

    #[test]
    fn provider_failures_repeat_what_the_ai_tool_said() {
        use gjd_providers::{ProviderError, ProviderId};

        let refused = provider_failure(
            ProviderError::NotAuthenticated {
                provider: ProviderId::OpenCode,
                login_command: "opencode auth login",
                detail: Some("Invalid API key.\n".to_owned()),
            },
            Some(ProviderId::OpenCode),
        );
        let silent = provider_failure(
            ProviderError::NotAuthenticated {
                provider: ProviderId::Codex,
                login_command: "codex login",
                detail: None,
            },
            Some(ProviderId::Codex),
        );
        let crashed = provider_failure(
            ProviderError::Crashed {
                exit_code: Some(1),
                stderr_tail: "booting\nError: model not found: x/y\n    at run (cli.js:1:2)\n}\n\n"
                    .to_owned(),
            },
            Some(ProviderId::GeminiCli),
        );

        assert_eq!(refused.message, "OpenCode was refused: Invalid API key.");
        assert!(
            refused
                .action
                .as_deref()
                .is_some_and(|action| action.contains("npx guijam init"))
        );
        let model_off = provider_failure(
            ProviderError::NotAuthenticated {
                provider: ProviderId::OpenCode,
                login_command: "opencode auth login",
                detail: Some(
                    "Model access is disabled. Change model access at https://opencode.ai/console/org_ABC123/models."
                        .to_owned(),
                ),
            },
            Some(ProviderId::OpenCode),
        );
        assert!(
            model_off
                .action
                .as_deref()
                .is_some_and(|action| action.starts_with("Turn this model on"))
        );
        assert_eq!(
            without_account_ids(
                "see https://opencode.ai/console/org_ABC123/models in ses_9x, org_"
            ),
            "see https://opencode.ai/console/org_redacted/models in ses_redacted, org_"
        );
        let no_plan = provider_failure(
            ProviderError::Failed(
                "[API Error: membership required: upgrade to plus or pro (request_id: x)]"
                    .to_owned(),
            ),
            Some(ProviderId::QwenCode),
        );
        assert_eq!(
            no_plan.message,
            "Qwen Code couldn't answer: [API Error: membership required: upgrade to plus or pro (request_id: x)]."
        );
        assert_eq!(silent.message, "Codex isn't logged in.");
        assert_eq!(
            silent.action.as_deref(),
            Some("Run `codex login` in a terminal, then retry.")
        );
        assert_eq!(
            crashed.message,
            "Gemini CLI stopped before answering: Error: model not found: x/y."
        );
    }

    fn react() -> Project {
        Project {
            ui: Ui::React,
            typescript: true,
            dependencies: std::collections::BTreeMap::new(),
            package_manager: PackageManager::Pnpm,
            components: "src/components".to_owned(),
        }
    }

    fn checks<'a>(project: &'a Project, existing: &'a [String], taken: &'a [String]) -> Checks<'a> {
        Checks {
            assets_dir: "src/assets/icons",
            existing,
            taken,
            project,
            root: Path::new("/nonexistent-project"),
        }
    }

    fn variant(label: &str, ops: &[EditOp]) -> gjd_core::contracts::Variant {
        serde_json::from_value(json!({
            "label": label, "system": "Your project", "style": label, "rationale": "r",
            "missing": [], "ops": ops,
        }))
        .expect("valid variant")
    }

    #[test]
    fn a_miscopied_base_hash_still_applies_to_the_source_the_model_was_shown() {
        let other = SOURCE.replace("p-2", "p-4");
        let proposed = vec![variant(
            "Sea",
            &[snippet(FILE, &other, "bg-brand", "bg-sea")],
        )];

        let (valid, dropped) =
            validate_variants(proposed, &only(), FILE, &checks(&react(), &[], &[]))
                .expect("the variant applies");

        assert!(dropped.is_empty(), "{dropped:?}");
        assert_eq!(valid[0].1[FILE], SOURCE.replace("bg-brand", "bg-sea"));
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
            validate_variants(proposed, &only(), FILE, &checks(&react(), &[], &[]))
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

    fn create(path: &str, content: &str) -> EditOp {
        serde_json::from_value(json!({ "kind": "create_file", "file": path, "content": content }))
            .expect("create op")
    }

    const ORGANISM: &str = "export function Pricing() {\n  return <section>Plans</section>;\n}\n";

    #[test]
    fn new_component_files_ride_along_when_they_follow_the_rules() {
        let proposed = vec![
            variant(
                "Split",
                &[
                    snippet(FILE, SOURCE, "bg-brand", "bg-sea"),
                    create("src/components/organisms/Pricing.tsx", ORGANISM),
                    create(
                        "src/components/atoms/Price.tsx",
                        "export function Price() {\n  return <b>$9</b>;\n}\n",
                    ),
                ],
            ),
            variant(
                "Outside",
                &[
                    snippet(FILE, SOURCE, "p-2", "p-3"),
                    create("src/pages/Pricing.tsx", ORGANISM),
                ],
            ),
            variant(
                "Broken",
                &[
                    snippet(FILE, SOURCE, "p-2", "p-4"),
                    create(
                        "src/components/atoms/Bad.tsx",
                        "export function Bad() { return <b>; }",
                    ),
                ],
            ),
        ];
        let project = react();

        let (valid, dropped) =
            validate_variants(proposed, &only(), FILE, &checks(&project, &[], &[]))
                .expect("one survives");

        assert_eq!(valid.len(), 1);
        let (_, contents, files) = &valid[0];
        assert!(contents[FILE].contains("bg-sea"));
        let paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "src/components/organisms/Pricing.tsx",
                "src/components/atoms/Price.tsx"
            ]
        );
        assert_eq!(files[0].preview, ORGANISM);
        assert_eq!(files[0].content, ORGANISM.as_bytes());
        assert!(
            dropped[0].reason.contains("outside src/components/"),
            "{}",
            dropped[0].reason
        );
        assert!(
            dropped[1].reason.contains("doesn't parse"),
            "{}",
            dropped[1].reason
        );
    }

    #[test]
    fn refuses_new_files_that_break_the_rules() {
        let place = || snippet(FILE, SOURCE, "bg-brand", "bg-sea");
        let path = "src/components/organisms/Pricing.tsx";
        let existing = vec![path.to_owned()];
        let many: Vec<EditOp> = std::iter::once(place())
            .chain((0..9).map(|n| create(&format!("src/components/atoms/A{n}.tsx"), ORGANISM)))
            .collect();
        let huge = format!(
            "export const Big = () => <p>{}</p>;\n",
            "x".repeat(61 * 1024)
        );
        let plain = Project {
            ui: crate::project::Ui::None,
            ..react()
        };
        let project = react();
        let cases: Vec<(Vec<EditOp>, Checks<'_>, &str)> = vec![
            (
                vec![create(path, ORGANISM)],
                checks(&project, &[], &[]),
                "It creates components but doesn't place them in src/B.tsx.",
            ),
            (
                vec![place(), create(path, ORGANISM)],
                checks(&project, &existing, &[]),
                "already exists.",
            ),
            (
                vec![place(), create(path, ORGANISM)],
                checks(&project, &[], &existing),
                "already used by another drawing.",
            ),
            (
                many,
                checks(&project, &[], &[]),
                "It creates 9 files; 8 at most.",
            ),
            (
                vec![place(), create(path, ORGANISM), create(path, ORGANISM)],
                checks(&project, &[], &[]),
                "twice",
            ),
            (
                vec![place(), create("src/components/atoms/Big.tsx", &huge)],
                checks(&project, &[], &[]),
                "larger than 60 KB",
            ),
            (
                vec![place(), create(path, ORGANISM)],
                checks(&plain, &[], &[]),
                "only creates component files in React, Preact or Solid",
            ),
        ];
        for (ops, checks, reason) in cases {
            let failure = validate_variants(vec![variant("Only", &ops)], &only(), FILE, &checks)
                .expect_err(reason);
            assert!(
                failure.message.contains(reason),
                "{reason}: {}",
                failure.message
            );
        }
    }

    #[test]
    fn new_imports_become_needs_installed_ones_pass_and_unknown_ones_drop() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("node_modules/gsap")).expect("gsap dir");
        std::fs::write(dir.path().join("node_modules/gsap/package.json"), "{}").expect("gsap");
        let mut project = react();
        project.dependencies.extend([
            ("react".to_owned(), "19.3.1".to_owned()),
            ("motion".to_owned(), "14.0.0".to_owned()),
        ]);
        let current = "import { Card } from '@components/Card';\nimport { useState } from 'react';\nexport const B = () => <b />;\n";
        let with = |imports: &str| format!("{imports}\n{current}");
        let organism = crate::assets::AssetFile {
            path: "src/components/organisms/Scene.tsx".to_owned(),
            content: Vec::new(),
            preview: "import { Canvas } from '@react-three/fiber';\nexport function Scene() { return <Canvas />; }\n".to_owned(),
        };
        let bases = Contents::from([(FILE.to_owned(), current.to_owned())]);
        let needed = |content: &str, created: &[crate::assets::AssetFile]| {
            let contents = Contents::from([(FILE.to_owned(), content.to_owned())]);
            super::libraries_needed(&bases, &contents, created, &project, dir.path())
        };

        assert_eq!(needed(current, &[]), Ok(Vec::new()));
        assert_eq!(
            needed(
                &with(
                    "import * as THREE from 'three';\nimport 'three/examples/jsm/controls/OrbitControls.js';"
                ),
                &[]
            ),
            Ok(vec!["three".to_owned()])
        );
        assert_eq!(
            needed(
                &with("import { motion } from 'motion/react';\nimport gsap from 'gsap';"),
                &[]
            ),
            Ok(Vec::new())
        );
        assert_eq!(
            needed(&with("import { Button } from '@components/Button';"), &[]),
            Ok(Vec::new())
        );
        assert_eq!(
            needed(
                &with("import { Scene } from './organisms/Scene';"),
                std::slice::from_ref(&organism)
            ),
            Ok(vec!["@react-three/fiber".to_owned()])
        );
        assert_eq!(
            needed(&with("import debounce from 'lodash';"), &[]),
            Err("It imports lodash, which isn't installed.".to_owned())
        );
        let five = "import 'three';\nimport '@react-three/fiber';\nimport '@react-three/drei';\nimport '@gsap/react';\nimport 'three/addons';";
        assert_eq!(needed(&with(five), &[]).map(|names| names.len()), Ok(4));
    }

    #[test]
    fn fails_when_no_variant_applies() {
        let lost = vec![variant(
            "Lost",
            &[snippet(FILE, SOURCE, "bg-nowhere", "bg-sky")],
        )];
        let failure = validate_variants(lost, &only(), FILE, &checks(&react(), &[], &[]))
            .expect_err("none survive");
        assert_eq!(failure.code, ErrorCode::ProviderInvalidOutput);
    }

    const FILE: &str = "src/B.tsx";
    const SOURCE: &str = "export const B = () => <b className=\"bg-brand p-2\" />;\n";
    const APP: &str = "src/App.tsx";
    const APP_SOURCE: &str = "import { B } from './B';\nimport { C } from './C';\n\nexport function App() {\n  return (\n    <main>\n      <B />\n      <C />\n    </main>\n  );\n}\n";
    const CARD: &str = "src/C.tsx";
    const CARD_SOURCE: &str =
        "export function C() {\n  return <section className=\"p-4\">Menu</section>;\n}\n";

    fn only() -> Contents {
        Contents::from([(FILE.to_owned(), SOURCE.to_owned())])
    }

    fn shown() -> Contents {
        Contents::from([
            (FILE.to_owned(), SOURCE.to_owned()),
            (APP.to_owned(), APP_SOURCE.to_owned()),
            (CARD.to_owned(), CARD_SOURCE.to_owned()),
        ])
    }

    #[test]
    fn a_removal_may_edit_only_the_file_that_renders_the_component() {
        let proposed = vec![variant(
            "Remove",
            &[
                snippet(APP, APP_SOURCE, "import { B } from './B';\n", ""),
                snippet(APP, APP_SOURCE, "      <B />\n", ""),
            ],
        )];

        let (valid, dropped) =
            validate_variants(proposed, &shown(), FILE, &checks(&react(), &[], &[]))
                .expect("the removal applies");

        assert!(dropped.is_empty(), "{dropped:?}");
        let contents = &valid[0].1;
        assert_eq!(contents.keys().collect::<Vec<_>>(), [APP]);
        assert!(!contents[APP].contains("<B />"));
        assert!(!contents[APP].contains("from './B'"));
    }

    #[test]
    fn a_move_edits_both_files_in_one_variant() {
        let proposed = vec![variant(
            "Into the card",
            &[
                snippet(APP, APP_SOURCE, "      <B />\n", ""),
                snippet(APP, APP_SOURCE, "import { B } from './B';\n", ""),
                snippet(
                    CARD,
                    CARD_SOURCE,
                    "export function C() {",
                    "import { B } from './B';\n\nexport function C() {",
                ),
                snippet(CARD, CARD_SOURCE, ">Menu</section>", ">Menu<B /></section>"),
            ],
        )];

        let (valid, _) = validate_variants(proposed, &shown(), FILE, &checks(&react(), &[], &[]))
            .expect("the move applies");

        let contents = &valid[0].1;
        assert_eq!(contents.keys().collect::<Vec<_>>(), [APP, CARD]);
        let tags = contents
            .values()
            .map(|content| content.matches("<B />").count())
            .sum::<usize>();
        assert_eq!(tags, 1);
        assert!(contents[CARD].contains("<B /></section>"));
    }

    #[test]
    fn edits_to_a_file_that_was_not_shown_are_dropped_with_the_reason() {
        let proposed = vec![variant(
            "Elsewhere",
            &[snippet("src/Hidden.tsx", SOURCE, "bg-brand", "bg-sea")],
        )];

        let failure = validate_variants(proposed, &shown(), FILE, &checks(&react(), &[], &[]))
            .expect_err("dropped");

        assert_eq!(
            failure.message,
            "The model's answer wasn't valid edits: it edits src/Hidden.tsx, which it was not shown"
        );
    }

    #[test]
    fn each_op_gets_the_hash_of_the_file_it_edits() {
        let wrong = content_hash(b"anything else");
        let op: EditOp = serde_json::from_value(json!({
            "kind": "replace_snippet", "file": APP, "base_hash": wrong.as_str(),
            "find": "      <B />\n", "replace": "",
        }))
        .expect("op");

        let stamped = edits_of(&[op, snippet(FILE, "other", "p-2", "p-3")], &shown());

        let hashes: Vec<String> = stamped
            .iter()
            .map(|op| {
                serde_json::to_value(op).expect("json")["base_hash"]
                    .as_str()
                    .expect("hash")
                    .to_owned()
            })
            .collect();
        assert_eq!(
            hashes,
            [
                content_hash(APP_SOURCE.as_bytes()).as_str().to_owned(),
                content_hash(SOURCE.as_bytes()).as_str().to_owned()
            ]
        );
    }

    #[test]
    fn variants_that_end_in_the_same_files_are_duplicates() {
        let remove = || snippet(APP, APP_SOURCE, "      <B />\n", "");
        let proposed = vec![
            variant("Remove", &[remove()]),
            variant("Remove again", &[remove()]),
            variant("Blue", &[snippet(FILE, SOURCE, "bg-brand", "bg-sea")]),
        ];

        let (valid, dropped) =
            validate_variants(proposed, &shown(), FILE, &checks(&react(), &[], &[]))
                .expect("two survive");

        assert_eq!(valid.len(), 2);
        assert_eq!(dropped[0].reason, "It is the same as another variant.");
    }

    #[test]
    fn a_comment_that_breaks_on_a_nested_comment_is_dropped() {
        let nested = APP_SOURCE.replace("      <C />\n", "      {/* menu */}\n      <C />\n");
        let editable = Contents::from([
            (FILE.to_owned(), SOURCE.to_owned()),
            (APP.to_owned(), nested.clone()),
        ]);
        let proposed = vec![variant(
            "Comment out",
            &[snippet(
                APP,
                &nested,
                "      <B />\n      {/* menu */}\n      <C />\n",
                "      {/* <B />\n      {/* menu */}\n      <C /> */}\n",
            )],
        )];

        let failure = validate_variants(proposed, &editable, FILE, &checks(&react(), &[], &[]))
            .expect_err("dropped");

        assert!(
            failure.message.contains("would no longer parse"),
            "{}",
            failure.message
        );
    }

    #[test]
    fn new_imports_in_any_changed_file_are_checked() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bases = shown();
        let contents = Contents::from([
            (APP.to_owned(), APP_SOURCE.replace("      <B />\n", "")),
            (
                CARD.to_owned(),
                format!("import debounce from 'lodash';\n{CARD_SOURCE}"),
            ),
        ]);

        let needed = super::libraries_needed(&bases, &contents, &[], &react(), dir.path());

        assert_eq!(
            needed,
            Err("It imports lodash, which isn't installed.".to_owned())
        );
    }

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

        let contents = apply_variant(&ops, &only()).expect("applied");

        assert_eq!(
            contents,
            Contents::from([(FILE.to_owned(), SOURCE.replace("bg-brand", "bg-sea"))])
        );
    }

    #[test]
    fn rejects_edits_to_other_files_no_edits_and_no_change() {
        let elsewhere = [snippet("src/Other.tsx", SOURCE, "bg-brand", "bg-sea")];
        let unchanged = [snippet(FILE, SOURCE, "bg-brand", "bg-brand")];

        for ops in [&elsewhere[..], &[], &unchanged[..]] {
            let failure = apply_variant(ops, &only()).expect_err("rejected");
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

        let failure =
            apply_variant(&ops, &Contents::from([(FILE.to_owned(), saved)])).expect_err("stale");

        assert_eq!(failure.code, ErrorCode::StaleBase);
        assert_eq!(failure.message, "src/B.tsx changed since the AI read it.");
    }

    fn assert_live_result(request: &str, contents: &Contents, original: &dyn Fn(&str) -> String) {
        let (app, card) = ("src/App.tsx", "src/components/MenuCard.tsx");
        assert!(
            !contents.contains_key("src/components/OrderButton.tsx"),
            "{request}: it edited the component's own file"
        );
        let renders = |file: &str| {
            let content = contents
                .get(file)
                .cloned()
                .unwrap_or_else(|| original(file));
            gjd_core::jsx::usages(file, &content, "OrderButton")
                .expect("parses")
                .len()
        };
        let imports = |file: &str| {
            contents.get(file).is_some_and(|content| {
                content
                    .lines()
                    .any(|line| line.starts_with("import { OrderButton }"))
            })
        };
        assert_eq!(renders(app), 0, "{request}: {}", contents[app]);
        assert!(!imports(app), "{request}: {}", contents[app]);
        if request == "comment this out" {
            assert!(contents[app].contains("{/*"), "{}", contents[app]);
        }
        if request.starts_with("move") {
            assert_eq!(renders(card), 1, "{}", contents[card]);
            assert!(imports(card), "{}", contents[card]);
        }
    }

    #[tokio::test]
    #[ignore = "runs the real Claude Code CLI and spends tokens"]
    async fn live_cross_file_requests_edit_where_the_component_is_rendered() {
        use std::num::NonZeroU64;
        use std::time::{Duration, Instant};

        use gjd_core::jsx;
        use gjd_core::theme::Theme;
        use gjd_providers::{Effort, GenerationRequest, ProviderId, ToolPolicy, adapter};
        use tokio_util::sync::CancellationToken;

        use crate::generate;
        use crate::related::{self, RelatedFile};

        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/small-react-tailwind4");
        let read = |path: &str| std::fs::read_to_string(fixture.join(path)).expect("fixture file");
        let button = "src/components/OrderButton.tsx";
        let app = "src/App.tsx";
        let card = "src/components/MenuCard.tsx";
        let source = read(button);
        let theme = Theme::from_css([read("src/index.css").as_str()]);
        let at = |value| NonZeroU64::new(value).expect("positions are 1-based");
        let style =
            gjd_core::style::inspect(button, &source, at(3), at(5), &theme).expect("element");
        let component = jsx::enclosing_component(button, &source, 3, 5);
        let provider = adapter(ProviderId::ClaudeCode).expect("adapter");
        let discovery = provider.discover().await.expect("Claude Code is installed");
        let model = std::env::var("GUIJAM_LIVE_MODEL").unwrap_or_else(|_| "sonnet".to_owned());
        let cwd = tempfile::tempdir().expect("tempdir");
        let cases: [(&str, &[(&str, &str)]); 3] = [
            ("remove this", &[(app, "renders OrderButton")]),
            (
                "move this into the menu card, next to the price",
                &[(app, "renders OrderButton"), (card, "named in the request")],
            ),
            ("comment this out", &[(app, "renders OrderButton")]),
        ];
        for (request, files) in cases {
            let shown: Vec<RelatedFile> = files
                .iter()
                .map(|(path, why)| RelatedFile {
                    path: (*path).to_owned(),
                    content: read(path),
                    anchors: Vec::new(),
                    why: (*why).to_owned(),
                    selected: false,
                })
                .collect();
            let mut editable = Contents::from([(button.to_owned(), source.clone())]);
            for file in &shown {
                editable.insert(file.path.clone(), file.content.clone());
            }
            let user_prompt = format!(
                "{}{}\n{}\n",
                generate::user_prompt(&style, &source, request, &generate::R2, component.as_ref()),
                related::render(&shown),
                generate::DIRECTIONS[0]
            );
            let started = Instant::now();
            let output = provider
                .generate(
                    &discovery,
                    GenerationRequest {
                        model: Some(model.clone()),
                        effort: Some(Effort::Medium),
                        system_prompt: generate::SYSTEM_PROMPT.to_owned(),
                        user_prompt,
                        images: Vec::new(),
                        tools: ToolPolicy::None,
                        timeout: Duration::from_mins(3),
                        cwd: cwd.path().to_path_buf(),
                        events: None,
                    },
                    CancellationToken::new(),
                )
                .await
                .unwrap_or_else(|error| panic!("{request}: {error}"));
            let (valid, _) = validate_variants(
                output.variant_set.variants,
                &editable,
                button,
                &checks(&react(), &[], &[]),
            )
            .unwrap_or_else(|failure| panic!("{request}: {}", failure.message));
            let (variant, contents, _) = &valid[0];
            println!(
                "{request} ({model}, {} ms, ${:.3}): {} | {} | edits {:?}",
                started.elapsed().as_millis(),
                output.cost_usd.unwrap_or_default(),
                String::from(variant.label.clone()),
                String::from(variant.rationale.clone()),
                contents.keys().collect::<Vec<_>>()
            );
            assert_live_result(request, contents, &read);
        }
    }
}
