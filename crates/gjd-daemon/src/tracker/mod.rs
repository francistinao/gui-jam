pub mod bridge;
pub mod commands;
pub mod credentials;
pub mod pairing;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use gjd_core::contracts::{
    BridgeImageMediaType, CodeChange, TicketDetail, TicketImage, TicketImageMediaType, TicketList,
    TicketPost, TicketPosted, TicketPostedOutcome, TicketRef, TicketRefProvider, TicketReport,
    TicketReported, TicketSearch, TicketStart, TicketStarted, TicketSummary, TrackerSite,
    TrackerSiteProvider, TrackerStatus,
};
use serde_json::{Value, json};
use similar::TextDiff;
use tokio_util::sync::CancellationToken;

use crate::diff::code_changes;
use bridge::{Bridge, BridgeFailure};
use credentials::Site;

pub const UNDO_WINDOW: Duration = Duration::from_secs(10);
const SNAPSHOTS: usize = 20;
const INLINE_LINES: usize = 200;
const PATCH_BYTES: usize = 1_000_000;
const TICKET_IMAGES: usize = 4;
const IMAGE_BYTES: u64 = 3_000_000;
const DESCRIPTION_CHARS: usize = 8000;
const SUMMARY_CHARS: usize = 500;
const IMAGE_TYPES: [&str; 3] = ["image/png", "image/jpeg", "image/webp"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotFile {
    pub path: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub files: Vec<SnapshotFile>,
    pub summary: String,
    pub agent: String,
    pub committed_at: Instant,
}

#[derive(Debug, thiserror::Error)]
pub enum TrackerError {
    #[error("No Jira site is paired with GUIJam.")]
    NotPaired,
    #[error("{0} isn't paired with GUIJam.")]
    UnknownSite(String),
    #[error("{0}")]
    Bridge(#[from] BridgeFailure),
    #[error("{0}")]
    Invalid(String),
    #[error("Can't read the GUIJam tracker settings: {0}")]
    Settings(String),
}

impl TrackerError {
    #[must_use]
    pub fn action(&self) -> Option<&'static str> {
        match self {
            Self::NotPaired | Self::UnknownSite(_) => Some(
                "Open any ticket's GUIJam panel in Jira, choose Pair GUIJam, then run npx guijam jira pair <code>.",
            ),
            Self::Bridge(failure) => failure.action(),
            Self::Invalid(_) | Self::Settings(_) => None,
        }
    }
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[must_use]
pub fn ticket_url(host: &str, key: &str) -> String {
    format!("https://{host}/browse/{key}")
}

fn ticket_ref(host: &str, key: &str) -> Result<TicketRef, TrackerError> {
    Ok(TicketRef {
        key: key
            .to_owned()
            .try_into()
            .map_err(|_| TrackerError::Invalid(format!("{key} isn't a ticket key.")))?,
        provider: TicketRefProvider::Jira,
        site: host
            .to_owned()
            .try_into()
            .map_err(|_| TrackerError::Invalid(format!("{host} isn't a site.")))?,
    })
}

fn truncated(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, BridgeFailure> + Send + 'static,
) -> Result<T, TrackerError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| TrackerError::Invalid(error.to_string()))?
        .map_err(TrackerError::from)
}

#[must_use]
pub fn diff_of(snapshot: &Snapshot) -> (Vec<CodeChange>, Option<String>) {
    let mut changes = Vec::new();
    let mut lines = 0;
    let mut full = true;
    let mut patch = String::new();
    for file in &snapshot.files {
        for change in code_changes(&file.path, &file.before, &file.after) {
            let size = change.before.len() + change.after.len();
            if lines + size > INLINE_LINES {
                full = false;
                continue;
            }
            lines += size;
            changes.push(change);
        }
        let unified = TextDiff::from_lines(&file.before, &file.after)
            .unified_diff()
            .context_radius(3)
            .header(&format!("a/{}", file.path), &format!("b/{}", file.path))
            .to_string();
        patch.push_str(&unified);
    }
    let patch = (!patch.is_empty() && (!full || patch.len() <= PATCH_BYTES))
        .then(|| truncated(&patch, PATCH_BYTES));
    (changes, patch)
}

pub struct Tracker {
    path: Option<PathBuf>,
    snapshots: Mutex<VecDeque<(String, Snapshot)>>,
    pending: Mutex<HashMap<String, CancellationToken>>,
    undone: Mutex<HashSet<String>>,
    posted: Mutex<HashMap<String, (Site, String)>>,
}

impl Default for Tracker {
    fn default() -> Self {
        Self::with_path(credentials::path())
    }
}

impl Tracker {
    #[must_use]
    pub fn with_path(path: Option<PathBuf>) -> Self {
        Self {
            path,
            snapshots: Mutex::default(),
            pending: Mutex::default(),
            undone: Mutex::default(),
            posted: Mutex::default(),
        }
    }

    pub fn sites(&self) -> Result<Vec<Site>, TrackerError> {
        let Some(path) = &self.path else {
            return Ok(Vec::new());
        };
        credentials::sites_in(path).map_err(|error| TrackerError::Settings(error.to_string()))
    }

    fn site(&self, host: Option<&str>) -> Result<Site, TrackerError> {
        let sites = self.sites()?;
        match host.filter(|host| !host.is_empty()) {
            Some(host) => sites
                .into_iter()
                .find(|site| site.host == host)
                .ok_or_else(|| TrackerError::UnknownSite(host.to_owned())),
            None => sites.into_iter().next().ok_or(TrackerError::NotPaired),
        }
    }

    fn bridge(site: &Site) -> Result<Bridge, TrackerError> {
        Ok(Bridge::new(&site.url, site.token.clone())?)
    }

    pub async fn status(&self) -> Result<TrackerStatus, TrackerError> {
        let mut sites = Vec::new();
        for site in self.sites()? {
            let host = site.host.clone();
            let account = site.account.clone();
            let bridge = Self::bridge(&site)?;
            let entry = match blocking(move || bridge.whoami(bridge::QUICK)).await {
                Ok(whoami) => TrackerSite {
                    account: whoami.display_name,
                    error: None,
                    projects: whoami.projects,
                    provider: TrackerSiteProvider::Jira,
                    site: host,
                    url: whoami.url,
                },
                Err(error) => TrackerSite {
                    account,
                    error: Some(error.to_string()),
                    projects: Vec::new(),
                    provider: TrackerSiteProvider::Jira,
                    url: format!("https://{host}"),
                    site: host,
                },
            };
            sites.push(entry);
        }
        Ok(TrackerStatus { sites })
    }

    pub async fn search(&self, request: &TicketSearch) -> Result<TicketList, TrackerError> {
        let site = self.site(request.site.as_deref())?;
        let bridge = Self::bridge(&site)?;
        let preset = request.preset.to_string();
        let query = request
            .query
            .as_ref()
            .map_or_else(String::new, |query| query.as_str().to_owned());
        let page = blocking(move || bridge.search(&preset, &query)).await?;
        let tickets = page
            .tickets
            .into_iter()
            .filter_map(|ticket| {
                Some(TicketSummary {
                    ref_: ticket_ref(&site.host, &ticket.key).ok()?,
                    url: ticket_url(&site.host, &ticket.key),
                    status: ticket.status,
                    summary: ticket.summary,
                    type_: ticket.type_,
                })
            })
            .collect();
        Ok(TicketList { tickets })
    }

    pub async fn ticket(&self, reference: &TicketRef) -> Result<TicketDetail, TrackerError> {
        let site = self.site(Some(reference.site.as_str()))?;
        let bridge = Self::bridge(&site)?;
        let key = reference.key.to_string();
        let fetch = bridge.clone();
        let ticket = blocking(move || fetch.ticket(&key)).await?;
        let mut images = Vec::new();
        for attachment in ticket
            .attachments
            .iter()
            .filter(|attachment| {
                IMAGE_TYPES.contains(&attachment.mime_type.as_str())
                    && attachment.size <= IMAGE_BYTES
            })
            .take(TICKET_IMAGES)
        {
            let id = attachment.id.clone();
            let fetch = bridge.clone();
            let owner = ticket.key.clone();
            let Ok(image) = blocking(move || fetch.attachment(&owner, &id)).await else {
                continue;
            };
            let media_type = match image.media_type {
                BridgeImageMediaType::ImagePng => TicketImageMediaType::ImagePng,
                BridgeImageMediaType::ImageJpeg => TicketImageMediaType::ImageJpeg,
                BridgeImageMediaType::ImageWebp => TicketImageMediaType::ImageWebp,
            };
            if let Ok(base64) = image.base64.try_into() {
                images.push(TicketImage {
                    base64,
                    media_type,
                    name: attachment.filename.clone(),
                });
            }
        }
        Ok(TicketDetail {
            description: truncated(&ticket.description, DESCRIPTION_CHARS),
            images,
            ref_: reference.clone(),
            status: ticket.status,
            summary: ticket.summary,
            transitions: ticket.transitions,
            url: ticket_url(&site.host, &ticket.key),
        })
    }

    pub async fn start(&self, request: &TicketStart) -> Result<TicketStarted, TrackerError> {
        let site = self.site(Some(request.ref_.site.as_str()))?;
        let bridge = Self::bridge(&site)?;
        let key = request.ref_.key.to_string();
        let body = json!({ "pageUrl": request.page_url.as_str(), "src": request.src.as_str() });
        blocking(move || bridge.start(&key, &body)).await?;
        Ok(TicketStarted {
            ref_: request.ref_.clone(),
        })
    }

    pub fn remember(&self, journal_id: &str, snapshot: Snapshot) {
        let mut snapshots = locked(&self.snapshots);
        snapshots.retain(|(id, _)| id != journal_id);
        snapshots.push_back((journal_id.to_owned(), snapshot));
        while snapshots.len() > SNAPSHOTS {
            snapshots.pop_front();
        }
    }

    fn snapshot(&self, journal_id: &str) -> Option<Snapshot> {
        locked(&self.snapshots)
            .iter()
            .find(|(id, _)| id == journal_id)
            .map(|(_, snapshot)| snapshot.clone())
    }

    pub async fn post(&self, request: &TicketPost) -> Result<TicketPosted, TrackerError> {
        let site = self.site(Some(request.ref_.site.as_str()))?;
        let key = request.ref_.key.to_string();
        let journal_id = request.journal_id.to_string();
        let url = ticket_url(&site.host, &key);
        let snapshot = self.snapshot(&journal_id).ok_or_else(|| {
            TrackerError::Invalid(
                "GUIJam no longer has this change, so it can't be posted. Changes are posted right after they're applied.".to_owned(),
            )
        })?;
        let cancelled = |outcome| TicketPosted {
            journal_id: journal_id.clone(),
            outcome,
            ref_: request.ref_.clone(),
            url: url.clone(),
        };
        if locked(&self.undone).contains(&journal_id) {
            return Ok(cancelled(TicketPostedOutcome::Cancelled));
        }
        let token = CancellationToken::new();
        locked(&self.pending).insert(journal_id.clone(), token.clone());
        let wait = (snapshot.committed_at + UNDO_WINDOW).saturating_duration_since(Instant::now());
        let undone = tokio::select! {
            () = tokio::time::sleep(wait) => false,
            () = token.cancelled() => true,
        };
        locked(&self.pending).remove(&journal_id);
        if undone || locked(&self.undone).contains(&journal_id) {
            return Ok(cancelled(TicketPostedOutcome::Cancelled));
        }
        let body = result_body(request, &snapshot);
        let bridge = Self::bridge(&site)?;
        let posted_key = key.clone();
        let posted = blocking(move || bridge.result(&posted_key, &body)).await?;
        locked(&self.posted).insert(journal_id.clone(), (site, key));
        Ok(TicketPosted {
            url: posted.url,
            ..cancelled(TicketPostedOutcome::Posted)
        })
    }

    pub fn undone(&self, journal_id: &str) -> Option<(Site, String)> {
        locked(&self.undone).insert(journal_id.to_owned());
        if let Some(token) = locked(&self.pending).remove(journal_id) {
            token.cancel();
        }
        locked(&self.posted).remove(journal_id)
    }

    pub async fn report(&self, request: &TicketReport) -> Result<TicketReported, TrackerError> {
        let site = self.site(Some(&request.site))?;
        let bridge = Self::bridge(&site)?;
        let body = json!({
            "project": request.project.as_str(),
            "summary": request.summary.as_str(),
            "description": request.description.as_str(),
            "pageUrl": request.page_url.as_str(),
            "src": request.src.as_str(),
            "image": request.image,
        });
        let created = blocking(move || bridge.create(&body)).await?;
        Ok(TicketReported {
            ref_: ticket_ref(&site.host, &created.key)?,
            url: created.url,
        })
    }
}

pub async fn revert(site: Site, key: String, journal_id: String) -> Result<(), TrackerError> {
    let bridge = Tracker::bridge(&site)?;
    blocking(move || bridge.reverted(&key, &journal_id)).await?;
    Ok(())
}

fn result_body(request: &TicketPost, snapshot: &Snapshot) -> Value {
    let (changes, patch) = diff_of(snapshot);
    let files: Vec<&str> = snapshot
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    let mut body = json!({
        "journalId": request.journal_id.as_str(),
        "summary": truncated(&snapshot.summary, SUMMARY_CHARS),
        "files": files,
        "changes": changes,
        "pageUrl": request.page_url.as_str(),
        "src": request.src.as_str(),
        "agent": snapshot.agent,
        "before": request.before,
        "after": request.after,
    });
    if let Some(patch) = patch {
        body["patch"] = Value::String(patch);
    }
    if let Some(transition) = &request.transition_id {
        body["transitionId"] = Value::String(transition.to_string());
    }
    body
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::{Snapshot, SnapshotFile, Tracker, diff_of};

    fn snapshot(lines: usize) -> Snapshot {
        let text = |prefix: &str| -> String {
            (0..lines)
                .flat_map(|line| [prefix.to_owned(), line.to_string(), "\n".to_owned()])
                .collect()
        };
        let before = text("a");
        let after = text("b");
        Snapshot {
            files: vec![SnapshotFile {
                path: "src/App.tsx".to_owned(),
                before,
                after,
            }],
            summary: "src/App.tsx:3 · bg-brand".to_owned(),
            agent: "direct edit, no AI".to_owned(),
            committed_at: Instant::now(),
        }
    }

    #[test]
    fn small_changes_go_inline_with_a_patch() {
        let (changes, patch) = diff_of(&snapshot(3));
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].before, vec!["a0", "a1", "a2"]);
        let patch = patch.expect("patch");
        assert!(patch.starts_with("--- a/src/App.tsx\n+++ b/src/App.tsx\n@@"));
        assert!(patch.contains("-a1\n+b1\n") || patch.contains("-a1\n"));
    }

    #[test]
    fn long_changes_keep_inline_lines_under_the_limit_and_send_the_full_patch() {
        let (changes, patch) = diff_of(&snapshot(150));
        assert!(changes.is_empty());
        assert!(patch.expect("patch").lines().count() > 300);
    }

    #[test]
    fn keeps_the_last_twenty_snapshots_and_an_undo_marks_the_change() {
        let tracker = Tracker::with_path(None);
        for index in 0..25 {
            tracker.remember(&format!("j{index}"), snapshot(1));
        }
        assert!(tracker.snapshot("j4").is_none());
        assert!(tracker.snapshot("j5").is_some());
        assert!(tracker.undone("j5").is_none());
        assert!(tracker.undone.lock().expect("lock").contains("j5"));
    }
}
