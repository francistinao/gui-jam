pub mod rank;
pub mod registered;
pub mod scope;
pub mod section;
pub mod workspace;

use std::collections::{BTreeSet, HashMap};
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError, RwLock};
use std::time::{Duration, SystemTime};

use gjd_core::components::{
    ComponentDecl, Export, Imported, Markup, ModuleSummary, Prop, Reexport, summarize,
};

use crate::found_text;
use crate::references::is_test_or_story;
use registered::Rules;
use scope::Scope;
use workspace::Package;

pub const WAIT: Duration = Duration::from_millis(300);
const MAX_FILE_BYTES: u64 = 200 * 1024;
const MAX_ENTRIES: usize = 20_000;
const MAX_PACKAGE_FILES: usize = 2_000;
const MAX_OUTSIDE_FILES: usize = 10_000;
const MAX_HOPS: usize = 4;
const MAX_CANDIDATES: usize = 200;
const NAMED_HITS: usize = 10;
const SOURCE_EXTENSIONS: [&str; 9] = [
    "tsx", "jsx", "ts", "js", "mjs", "mts", "vue", "svelte", "astro",
];
const GENERIC_FOLDERS: [&str; 14] = [
    "src",
    "app",
    "components",
    "ui",
    "lib",
    "shared",
    "common",
    "packages",
    "atoms",
    "molecules",
    "organisms",
    "features",
    "modules",
    "elements",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Origin {
    Project,
    Package(String),
    Registered,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub file: String,
    pub path: PathBuf,
    pub line: u64,
    pub export: Export,
    pub props: Vec<Prop>,
    pub root: Option<Markup>,
    pub origin: Origin,
    key: String,
    tag: Option<String>,
    tokens: Vec<String>,
    folders: Vec<String>,
    features: BTreeSet<String>,
}

pub struct Place {
    pub name: String,
    pub file: String,
    pub path: PathBuf,
    pub origin: Origin,
}

impl Entry {
    #[must_use]
    pub fn new(place: Place, component: &ComponentDecl, export: Export) -> Self {
        let root = component.root.clone();
        Self {
            key: rank::squashed(&place.name),
            tag: root.as_ref().map(|root| root.tag.to_lowercase()),
            tokens: rank::name_tokens(&place.name),
            folders: folder_tokens(&place.file),
            features: root
                .as_ref()
                .map_or_else(BTreeSet::new, |root| rank::class_features(&root.classes)),
            name: place.name,
            file: place.file,
            path: place.path,
            line: component.line,
            export,
            props: component.props.clone(),
            root,
            origin: place.origin,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportStyle {
    pub specifier: String,
    pub imported: Imported,
}

#[derive(Clone)]
struct Parsed {
    stamp: (Option<SystemTime>, u64),
    summary: Arc<ModuleSummary>,
}

#[derive(Default)]
pub struct Snapshot {
    parsed: HashMap<PathBuf, Parsed>,
    entries: Vec<Entry>,
    used_by: Vec<u32>,
    styles: Vec<Option<ImportStyle>>,
    by_name: HashMap<String, Vec<usize>>,
    by_token: HashMap<String, Vec<usize>>,
    by_class: HashMap<String, Vec<usize>>,
    parsed_last: usize,
}

#[derive(Clone)]
pub struct Inputs {
    pub root: PathBuf,
    pub files: Arc<Vec<String>>,
    pub packages: Vec<Package>,
    pub rules: Rules,
}

pub struct Query<'q> {
    pub selected: &'q str,
    pub signature: &'q rank::Signature,
    pub prompt: &'q str,
    pub enclosing: Option<&'q str>,
    pub limit: usize,
}

pub struct Match<'s> {
    pub entry: &'s Entry,
    pub scope: Scope,
    pub scored: rank::Scored,
    pub used_by: u32,
    pub style: Option<&'s ImportStyle>,
}

struct Source {
    key: String,
    path: PathBuf,
    package: Option<usize>,
}

fn is_source(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, extension)| {
        SOURCE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
    }) && !path.ends_with(".d.ts")
        && !is_test_or_story(path)
}

fn sources(inputs: &Inputs) -> Vec<Source> {
    let mut found: Vec<Source> = inputs
        .files
        .iter()
        .filter(|file| is_source(file))
        .map(|file| Source {
            key: file.clone(),
            path: inputs.root.join(file),
            package: None,
        })
        .filter(|source| {
            !inputs
                .packages
                .iter()
                .any(|package| source.path.starts_with(&package.dir))
        })
        .collect();
    let mut outside = 0;
    for (index, package) in inputs.packages.iter().enumerate() {
        let files = crate::index::walk(&package.dir);
        for relative in files
            .into_iter()
            .filter(|file| is_source(file))
            .take(MAX_PACKAGE_FILES)
        {
            if outside >= MAX_OUTSIDE_FILES {
                return found;
            }
            outside += 1;
            found.push(Source {
                key: format!("{}/{relative}", package.display),
                path: package.dir.join(&relative),
                package: Some(index),
            });
        }
    }
    found
}

fn stamp(path: &Path) -> Option<(Option<SystemTime>, u64)> {
    let metadata = std::fs::metadata(path).ok()?;
    metadata
        .is_file()
        .then(|| (metadata.modified().ok(), metadata.len()))
}

fn read_summary(path: &Path, key: &str) -> ModuleSummary {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|source| summarize(key, &source).ok())
        .unwrap_or_default()
}

type Stale = (PathBuf, String, (Option<SystemTime>, u64));

fn parse_all(stale: &[Stale]) -> Vec<(PathBuf, Parsed)> {
    if stale.is_empty() {
        return Vec::new();
    }
    let threads = std::thread::available_parallelism()
        .map_or(1, NonZeroUsize::get)
        .min(stale.len());
    let chunk = stale.len().div_ceil(threads);
    std::thread::scope(|scope| {
        let handles: Vec<_> = stale
            .chunks(chunk)
            .map(|part| {
                scope.spawn(move || {
                    part.iter()
                        .map(|(path, key, stamp)| {
                            let parsed = Parsed {
                                stamp: *stamp,
                                summary: Arc::new(read_summary(path, key)),
                            };
                            (path.clone(), parsed)
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap_or_default())
            .collect()
    })
}

fn folder_tokens(file: &str) -> Vec<String> {
    let mut segments: Vec<&str> = file.split('/').collect();
    segments.pop();
    let mut tokens: Vec<String> = segments
        .iter()
        .filter(|segment| !GENERIC_FOLDERS.contains(segment))
        .flat_map(|segment| rank::name_tokens(segment))
        .collect();
    tokens.sort();
    tokens.dedup();
    tokens
}

fn decl_for(summary: &ModuleSummary, imported: &Imported) -> Option<usize> {
    summary
        .components
        .iter()
        .position(|component| match (imported, &component.export) {
            (Imported::Default, Export::Default) => true,
            (Imported::Named(name), Export::Named(exported)) => name == exported,
            _ => false,
        })
}

struct Lookup<'l> {
    summaries: HashMap<&'l str, &'l ModuleSummary>,
    paths: HashMap<&'l str, &'l Path>,
    project: BTreeSet<&'l str>,
    packages: Vec<BTreeSet<&'l str>>,
    package_of: HashMap<&'l str, usize>,
    inputs: &'l Inputs,
}

impl Lookup<'_> {
    fn package_entry(&self, specifier: &str) -> Option<String> {
        self.inputs
            .packages
            .iter()
            .find(|package| package.name == specifier)
            .map(|package| format!("{}/{}", package.display, package.entry))
    }

    fn resolve(&self, from: &str, specifier: &str) -> Option<String> {
        if let Some(package) = self.package_of.get(from) {
            return found_text::resolve(from, specifier, self.packages.get(*package)?);
        }
        if let Some(entry) = self.package_entry(specifier) {
            return Some(entry);
        }
        found_text::resolve(from, specifier, &self.project)
    }

    fn find(&self, key: &str, imported: &Imported, hops: usize) -> Option<(String, usize)> {
        if hops > MAX_HOPS {
            return None;
        }
        let summary = self.summaries.get(key)?;
        if let Some(index) = decl_for(summary, imported) {
            return Some((key.to_owned(), index));
        }
        let Imported::Named(wanted) = imported else {
            return None;
        };
        summary
            .reexports
            .iter()
            .find_map(|reexport| match reexport {
                Reexport::Named {
                    exported,
                    imported,
                    from,
                } if exported == wanted => {
                    let target = self.resolve(key, from)?;
                    self.find(&target, imported, hops + 1)
                }
                Reexport::All { from } => {
                    let target = self.resolve(key, from)?;
                    self.find(&target, &Imported::Named(wanted.clone()), hops + 1)
                }
                Reexport::Named { .. } => None,
            })
    }

    fn listing(&self, key: &str, hops: usize, out: &mut Vec<(String, String, usize)>) {
        if hops > MAX_HOPS {
            return;
        }
        let Some(summary) = self.summaries.get(key) else {
            return;
        };
        for (index, component) in summary.components.iter().enumerate() {
            if let Export::Named(name) = &component.export {
                out.push((name.clone(), key.to_owned(), index));
            }
        }
        for reexport in &summary.reexports {
            match reexport {
                Reexport::Named {
                    exported,
                    imported,
                    from,
                } => {
                    if let Some((file, index)) = self
                        .resolve(key, from)
                        .and_then(|target| self.find(&target, imported, hops + 1))
                    {
                        out.push((exported.clone(), file, index));
                    }
                }
                Reexport::All { from } => {
                    if let Some(target) = self.resolve(key, from) {
                        self.listing(&target, hops + 1, out);
                    }
                }
            }
        }
    }
}

fn registered_tags(lookup: &Lookup<'_>, inputs: &Inputs) -> HashMap<String, String> {
    let mut tags = HashMap::new();
    for file in inputs
        .files
        .iter()
        .filter(|file| registered::is_registration_file(file))
    {
        let Ok(source) = std::fs::read_to_string(inputs.root.join(file)) else {
            continue;
        };
        let Some(summary) = lookup.summaries.get(file.as_str()) else {
            continue;
        };
        for (tag, local) in registered::registrations(&source) {
            let target = summary
                .imports
                .iter()
                .find(|binding| binding.local == local)
                .and_then(|binding| lookup.resolve(file, &binding.from));
            if let Some(target) = target {
                tags.insert(target, tag);
            }
        }
    }
    tags
}

fn reparse(previous: &Snapshot, all: &[Source]) -> (HashMap<PathBuf, Parsed>, usize) {
    let mut parsed: HashMap<PathBuf, Parsed> = HashMap::new();
    let mut stale: Vec<Stale> = Vec::new();
    for source in all {
        let Some(stamp) = stamp(&source.path) else {
            continue;
        };
        if stamp.1 > MAX_FILE_BYTES {
            continue;
        }
        match previous.parsed.get(&source.path) {
            Some(old) if old.stamp == stamp => {
                parsed.insert(source.path.clone(), old.clone());
            }
            _ => stale.push((source.path.clone(), source.key.clone(), stamp)),
        }
    }
    let count = stale.len();
    parsed.extend(parse_all(&stale));
    (parsed, count)
}

fn lookup<'l>(
    all: &'l [Source],
    parsed: &'l HashMap<PathBuf, Parsed>,
    inputs: &'l Inputs,
) -> Lookup<'l> {
    Lookup {
        paths: all
            .iter()
            .map(|source| (source.key.as_str(), source.path.as_path()))
            .collect(),
        summaries: all
            .iter()
            .filter_map(|source| {
                parsed
                    .get(&source.path)
                    .map(|found| (source.key.as_str(), found.summary.as_ref()))
            })
            .collect(),
        project: all
            .iter()
            .filter(|source| source.package.is_none())
            .map(|source| source.key.as_str())
            .collect(),
        packages: (0..inputs.packages.len())
            .map(|index| {
                all.iter()
                    .filter(|source| source.package == Some(index))
                    .map(|source| source.key.as_str())
                    .collect()
            })
            .collect(),
        package_of: all
            .iter()
            .filter_map(|source| source.package.map(|index| (source.key.as_str(), index)))
            .collect(),
        inputs,
    }
}

#[derive(Default)]
struct Entries {
    list: Vec<Entry>,
    at: HashMap<(String, usize), usize>,
}

impl Entries {
    fn push(&mut self, file: &str, index: usize, entry: Entry) {
        if self.list.len() < MAX_ENTRIES {
            self.at
                .entry((file.to_owned(), index))
                .or_insert(self.list.len());
            self.list.push(entry);
        }
    }
}

fn project_entries(all: &[Source], lookup: &Lookup<'_>, inputs: &Inputs, entries: &mut Entries) {
    let tags = registered_tags(lookup, inputs);
    for source in all.iter().filter(|source| source.package.is_none()) {
        if scope::is_route_entry(&source.key) {
            continue;
        }
        let Some(summary) = lookup.summaries.get(source.key.as_str()) else {
            continue;
        };
        for (index, component) in summary.components.iter().enumerate() {
            let registered = tags
                .get(&source.key)
                .cloned()
                .or_else(|| inputs.rules.auto_name(&source.key));
            let (name, origin) = match (registered, &component.export) {
                (Some(tag), _) => (tag, Origin::Registered),
                (None, Export::None) => continue,
                (None, Export::Named(exported)) => (exported.clone(), Origin::Project),
                (None, Export::Default) => (component.name.clone(), Origin::Project),
            };
            let place = Place {
                name,
                file: source.key.clone(),
                path: source.path.clone(),
                origin,
            };
            let entry = Entry::new(place, component, component.export.clone());
            entries.push(&source.key, index, entry);
        }
    }
}

fn package_entries(lookup: &Lookup<'_>, inputs: &Inputs, entries: &mut Entries) {
    for package in &inputs.packages {
        let mut listed = Vec::new();
        lookup.listing(
            &format!("{}/{}", package.display, package.entry),
            0,
            &mut listed,
        );
        for (exported, file, index) in listed {
            let Some(component) = lookup
                .summaries
                .get(file.as_str())
                .and_then(|summary| summary.components.get(index))
            else {
                continue;
            };
            let Some(path) = lookup.paths.get(file.as_str()) else {
                continue;
            };
            let place = Place {
                name: exported.clone(),
                file: file.clone(),
                path: (*path).to_path_buf(),
                origin: Origin::Package(package.name.clone()),
            };
            let entry = Entry::new(place, component, Export::Named(exported));
            entries.push(&file, index, entry);
        }
    }
}

fn usage(
    all: &[Source],
    lookup: &Lookup<'_>,
    entries: &Entries,
) -> (Vec<u32>, Vec<Option<ImportStyle>>) {
    let mut importers: Vec<BTreeSet<&str>> = vec![BTreeSet::new(); entries.list.len()];
    let mut styles: Vec<Option<ImportStyle>> = vec![None; entries.list.len()];
    for source in all.iter().filter(|source| source.package.is_none()) {
        let Some(summary) = lookup.summaries.get(source.key.as_str()) else {
            continue;
        };
        for binding in &summary.imports {
            if binding.imported == Imported::Namespace {
                continue;
            }
            let Some(id) = lookup
                .resolve(&source.key, &binding.from)
                .and_then(|target| lookup.find(&target, &binding.imported, 0))
                .and_then(|found| entries.at.get(&found).copied())
            else {
                continue;
            };
            importers[id].insert(source.key.as_str());
            if !binding.from.starts_with('.') && styles[id].is_none() {
                styles[id] = Some(ImportStyle {
                    specifier: binding.from.clone(),
                    imported: binding.imported.clone(),
                });
            }
        }
    }
    let used_by = importers
        .iter()
        .map(|set| u32::try_from(set.len()).unwrap_or(u32::MAX))
        .collect();
    (used_by, styles)
}

fn build(previous: &Snapshot, inputs: &Inputs) -> Snapshot {
    let all = sources(inputs);
    let (parsed, parsed_last) = reparse(previous, &all);
    let mut entries = Entries::default();
    let (used_by, styles) = {
        let lookup = lookup(&all, &parsed, inputs);
        project_entries(&all, &lookup, inputs, &mut entries);
        package_entries(&lookup, inputs, &mut entries);
        usage(&all, &lookup, &entries)
    };
    let mut snapshot = Snapshot {
        used_by,
        styles,
        parsed_last,
        ..Snapshot::default()
    };
    for (id, entry) in entries.list.iter().enumerate() {
        snapshot
            .by_name
            .entry(entry.key.clone())
            .or_default()
            .push(id);
        for token in entry.tokens.iter().chain(&entry.folders) {
            snapshot.by_token.entry(token.clone()).or_default().push(id);
        }
        for feature in &entry.features {
            snapshot
                .by_class
                .entry(feature.clone())
                .or_default()
                .push(id);
        }
    }
    snapshot.entries = entries.list;
    snapshot.parsed = parsed;
    snapshot
}

impl Snapshot {
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    #[must_use]
    pub fn parsed_last(&self) -> usize {
        self.parsed_last
    }

    #[must_use]
    pub fn matches(&self, query: &Query<'_>) -> Vec<Match<'_>> {
        let request = rank::request(query.prompt, query.signature);
        let mut hits: HashMap<usize, usize> = HashMap::new();
        let mut add = |ids: Option<&Vec<usize>>, weight: usize| {
            for id in ids.into_iter().flatten() {
                *hits.entry(*id).or_default() += weight;
            }
        };
        for named in &request.named {
            add(self.by_name.get(named), NAMED_HITS);
        }
        for word in &request.words {
            add(self.by_token.get(word), 1);
        }
        for feature in &request.features {
            add(self.by_class.get(feature), 1);
        }
        let mut candidates: Vec<(usize, usize)> = hits.into_iter().collect();
        candidates.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        candidates.truncate(MAX_CANDIDATES);
        let mut found: Vec<Match<'_>> = candidates
            .into_iter()
            .filter_map(|(id, _)| {
                let entry = self.entries.get(id)?;
                if entry.file == query.selected && query.enclosing == Some(entry.name.as_str()) {
                    return None;
                }
                let scope =
                    scope::scope_of(&entry.file, entry.origin != Origin::Project, query.selected);
                let used_by = self.used_by.get(id).copied().unwrap_or(0);
                let scored = rank::score(
                    &request,
                    &rank::Candidate {
                        key: &entry.key,
                        tokens: &entry.tokens,
                        tag: entry.tag.as_deref(),
                        features: &entry.features,
                        used_by,
                        scope,
                    },
                );
                rank::kept(&scored).then(|| Match {
                    entry,
                    scope,
                    scored,
                    used_by,
                    style: self.styles.get(id).and_then(Option::as_ref),
                })
            })
            .collect();
        found.sort_by(|a, b| {
            b.scored
                .score
                .total_cmp(&a.scored.score)
                .then(a.scope.cmp(&b.scope))
                .then(a.entry.name.cmp(&b.entry.name))
        });
        found.truncate(query.limit);
        found
    }

    #[must_use]
    pub fn reusable(&self, selected: &str, limit: usize) -> Vec<&Entry> {
        let mut ranked: Vec<(Scope, u32, &Entry)> = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| entry.file != selected)
            .map(|(id, entry)| {
                let scope = scope::scope_of(&entry.file, entry.origin != Origin::Project, selected);
                (scope, self.used_by.get(id).copied().unwrap_or(0), entry)
            })
            .filter(|(scope, _, _)| *scope != Scope::OtherFeature)
            .collect();
        ranked.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then(b.1.cmp(&a.1))
                .then(a.2.name.cmp(&b.2.name))
        });
        ranked
            .into_iter()
            .take(limit)
            .map(|(_, _, entry)| entry)
            .collect()
    }
}

#[derive(Default)]
pub struct ComponentIndex {
    snapshot: RwLock<Arc<Snapshot>>,
    building: tokio::sync::Mutex<()>,
}

impl ComponentIndex {
    #[must_use]
    pub fn snapshot(&self) -> Arc<Snapshot> {
        Arc::clone(&self.snapshot.read().unwrap_or_else(PoisonError::into_inner))
    }

    pub async fn refresh(&self, inputs: Inputs) -> Arc<Snapshot> {
        let _building = self.building.lock().await;
        let previous = self.snapshot();
        let started = std::time::Instant::now();
        let Ok(next) =
            tokio::task::spawn_blocking(move || Arc::new(build(&previous, &inputs))).await
        else {
            return self.snapshot();
        };
        tracing::info!(
            components = next.len(),
            parsed = next.parsed_last(),
            ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            "indexed the project's components"
        );
        *self
            .snapshot
            .write()
            .unwrap_or_else(PoisonError::into_inner) = Arc::clone(&next);
        next
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use gjd_core::components::{Export, Imported};

    use super::rank::Signature;
    use super::registered::Rules;
    use super::scope::Scope;
    use super::workspace::Package;
    use super::{ImportStyle, Inputs, Origin, Query, Snapshot, build};

    const ERROR_MESSAGE: &str = "interface ErrorMessageProps {\n  message: string;\n}\n\nexport function ErrorMessage({ message }: ErrorMessageProps) {\n  return <p className=\"mt-1 text-sm text-red-700\">{message}</p>;\n}\n";
    const FIELD_HINT: &str = "export function FieldHint({ children }: { children: string }) {\n  return <p className=\"mt-1 text-xs text-espresso/70\">{children}</p>;\n}\n";
    const SIGNUP: &str = "import { ErrorMessage } from '../../components/ErrorMessage';\n\nexport function RewardsSignup() {\n  return (\n    <form>\n      <ErrorMessage message=\"Enter your name.\" />\n      <p className=\"mt-2 text-xs text-red-500\">Enter a valid email address.</p>\n    </form>\n  );\n}\n";

    fn write(root: &Path, file: &str, text: &str) {
        let path = root.join(file);
        fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        fs::write(path, text).expect("file");
    }

    fn listed(root: &Path) -> Vec<String> {
        let mut files = crate::index::walk(root);
        files.sort();
        files
    }

    fn inputs(root: &Path) -> Inputs {
        Inputs {
            root: root.to_path_buf(),
            files: Arc::new(listed(root)),
            packages: Vec::new(),
            rules: Rules::default(),
        }
    }

    fn inline_error() -> Signature {
        Signature {
            tag: "p".to_owned(),
            classes: vec!["mt-2".into(), "text-xs".into(), "text-red-500".into()],
            role: None,
            text: "Enter a valid email address.".to_owned(),
        }
    }

    fn names(
        snapshot: &Snapshot,
        selected: &str,
        prompt: &str,
        signature: &Signature,
    ) -> Vec<String> {
        snapshot
            .matches(&Query {
                selected,
                signature,
                prompt,
                enclosing: Some("RewardsSignup"),
                limit: 8,
            })
            .into_iter()
            .map(|found| found.entry.name.clone())
            .collect()
    }

    fn brew(root: &Path) {
        write(root, "src/components/ErrorMessage.tsx", ERROR_MESSAGE);
        write(root, "src/components/FieldHint.tsx", FIELD_HINT);
        write(root, "src/features/rewards/RewardsSignup.tsx", SIGNUP);
    }

    #[test]
    fn finds_the_shared_error_component_for_the_inconsistent_inline_copy() {
        let root = tempfile::tempdir().expect("temp dir");
        brew(root.path());
        let snapshot = build(&Snapshot::default(), &inputs(root.path()));
        let selected = "src/features/rewards/RewardsSignup.tsx";

        let found = snapshot.matches(&Query {
            selected,
            signature: &inline_error(),
            prompt: "I think there's already an existing component, I want you to search it across the codebase",
            enclosing: Some("RewardsSignup"),
            limit: 3,
        });

        let first = found.first().expect("a match");
        assert_eq!(first.entry.name, "ErrorMessage");
        assert_eq!(first.scope, Scope::Shared);
        assert_eq!(first.used_by, 1);
        assert_eq!(first.entry.file, "src/components/ErrorMessage.tsx");
        assert_eq!(first.entry.props[0].name, "message");
        assert!(
            found
                .iter()
                .all(|found| found.entry.name != "RewardsSignup")
        );
    }

    #[test]
    fn parses_again_only_the_files_that_changed_and_forgets_deleted_ones() {
        let root = tempfile::tempdir().expect("temp dir");
        brew(root.path());
        let first = build(&Snapshot::default(), &inputs(root.path()));
        assert_eq!(first.parsed_last(), 3);
        assert_eq!(first.len(), 3);

        let same = build(&first, &inputs(root.path()));
        assert_eq!(same.parsed_last(), 0);

        std::thread::sleep(Duration::from_millis(20));
        write(
            root.path(),
            "src/components/FieldHint.tsx",
            &FIELD_HINT.replace("FieldHint", "FormHint"),
        );
        fs::remove_file(root.path().join("src/components/ErrorMessage.tsx")).expect("remove");
        let changed = build(&same, &inputs(root.path()));

        assert_eq!(changed.parsed_last(), 1);
        let mut all: Vec<&str> = changed
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        all.sort_unstable();
        assert_eq!(all, ["FormHint", "RewardsSignup"]);
        assert!(!changed.by_name.contains_key("errormessage"));
        assert!(changed.by_name.contains_key("formhint"));
        assert!(!changed.by_name.contains_key("fieldhint"));
    }

    #[test]
    fn skips_tests_stories_route_entries_big_files_and_components_nobody_can_import() {
        let root = tempfile::tempdir().expect("temp dir");
        brew(root.path());
        write(
            root.path(),
            "src/components/ErrorMessage.test.tsx",
            "export function Fake() { return <p />; }",
        );
        write(
            root.path(),
            "src/components/ErrorMessage.stories.tsx",
            "export function Story() { return <p />; }",
        );
        write(
            root.path(),
            "app/checkout/page.tsx",
            "export default function Page() { return <main />; }",
        );
        write(
            root.path(),
            "src/components/Local.tsx",
            "function Local() { return <p />; }\n",
        );
        write(
            root.path(),
            "src/components/Huge.tsx",
            &format!(
                "export function Huge() {{ return <p />; }}\n{}",
                "// x\n".repeat(60_000)
            ),
        );

        let snapshot = build(&Snapshot::default(), &inputs(root.path()));

        let mut all: Vec<&str> = snapshot
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        all.sort_unstable();
        assert_eq!(all, ["ErrorMessage", "FieldHint", "RewardsSignup"]);
    }

    #[test]
    fn follows_barrels_and_remembers_how_the_project_imports_a_component() {
        let root = tempfile::tempdir().expect("temp dir");
        write(
            root.path(),
            "src/components/ErrorMessage.tsx",
            ERROR_MESSAGE,
        );
        write(
            root.path(),
            "src/components/index.ts",
            "export * from './ErrorMessage';\n",
        );
        write(
            root.path(),
            "src/pages/Login.tsx",
            "import { ErrorMessage } from '@/components';\nexport function Login() { return <ErrorMessage message=\"x\" />; }\n",
        );
        write(
            root.path(),
            "src/pages/Signup.tsx",
            "import { ErrorMessage } from '../components/ErrorMessage';\nexport function Signup() { return <ErrorMessage message=\"y\" />; }\n",
        );

        let snapshot = build(&Snapshot::default(), &inputs(root.path()));

        let id = snapshot
            .entries
            .iter()
            .position(|entry| entry.name == "ErrorMessage")
            .expect("indexed");
        assert_eq!(snapshot.used_by[id], 2);
        assert_eq!(
            snapshot.styles[id],
            Some(ImportStyle {
                specifier: "@/components".to_owned(),
                imported: Imported::Named("ErrorMessage".to_owned()),
            })
        );
    }

    #[test]
    fn indexes_what_a_workspace_package_exports_as_global() {
        let root = tempfile::tempdir().expect("temp dir");
        write(
            root.path(),
            "packages/ui/src/index.ts",
            "export { Alert } from './Alert';\nexport * from './forms';\n",
        );
        write(
            root.path(),
            "packages/ui/src/Alert.tsx",
            "export function Alert({ text }: { text: string }) { return <div role=\"alert\" className=\"rounded-lg bg-red-50 text-red-700\">{text}</div>; }\n",
        );
        write(
            root.path(),
            "packages/ui/src/forms/index.ts",
            "export { FieldError } from './FieldError';\n",
        );
        write(
            root.path(),
            "packages/ui/src/forms/FieldError.tsx",
            "export const FieldError = ({ message }: { message: string }) => <p className=\"text-sm text-red-700\">{message}</p>;\n",
        );
        write(
            root.path(),
            "packages/ui/src/Internal.tsx",
            "export function Internal() { return <i />; }\n",
        );
        write(
            root.path(),
            "apps/web/src/Form.tsx",
            "import { Alert } from '@acme/ui';\nexport function Form() { return <Alert text=\"x\" />; }\n",
        );
        let web = root.path().join("apps/web");
        let packages = vec![Package {
            name: "@acme/ui".to_owned(),
            dir: root.path().join("packages/ui"),
            display: "packages/ui".to_owned(),
            entry: "src/index.ts".to_owned(),
        }];

        let snapshot = build(
            &Snapshot::default(),
            &Inputs {
                root: web.clone(),
                files: Arc::new(listed(&web)),
                packages,
                rules: Rules::default(),
            },
        );

        let package: Vec<(&str, &str)> = snapshot
            .entries
            .iter()
            .filter(|entry| entry.origin == Origin::Package("@acme/ui".to_owned()))
            .map(|entry| (entry.name.as_str(), entry.file.as_str()))
            .collect();
        assert_eq!(
            package,
            [
                ("Alert", "packages/ui/src/Alert.tsx"),
                ("FieldError", "packages/ui/src/forms/FieldError.tsx"),
            ]
        );
        let alert = snapshot
            .entries
            .iter()
            .position(|entry| entry.name == "Alert")
            .expect("alert");
        assert_eq!(snapshot.used_by[alert], 1);
        let found = names(
            &snapshot,
            "src/Form.tsx",
            "use the field error",
            &inline_error(),
        );
        assert_eq!(found.first().map(String::as_str), Some("FieldError"));
    }

    #[test]
    fn names_nuxt_and_registered_vue_components_by_the_tag_they_are_used_with() {
        let root = tempfile::tempdir().expect("temp dir");
        write(
            root.path(),
            "components/base/Alert.vue",
            "<script setup lang=\"ts\">\ndefineProps<{ text: string }>();\n</script>\n<template><div class=\"rounded-lg\">{{ text }}</div></template>\n",
        );
        let mut nuxt = inputs(root.path());
        nuxt.rules = Rules {
            nuxt: true,
            unplugin: false,
        };
        let vue = tempfile::tempdir().expect("temp dir");
        write(
            vue.path(),
            "src/components/BaseButton.vue",
            "<template><button class=\"btn\"><slot /></button></template>\n",
        );
        write(
            vue.path(),
            "src/main.ts",
            "import { createApp } from 'vue';\nimport BaseButton from './components/BaseButton.vue';\ncreateApp({}).component('AppButton', BaseButton).mount('#app');\n",
        );

        let nuxt = build(&Snapshot::default(), &nuxt);
        let vue = build(&Snapshot::default(), &inputs(vue.path()));

        assert_eq!(nuxt.entries[0].name, "BaseAlert");
        assert_eq!(nuxt.entries[0].origin, Origin::Registered);
        assert_eq!(nuxt.entries[0].export, Export::Default);
        let button = vue
            .entries
            .iter()
            .find(|entry| entry.file == "src/components/BaseButton.vue")
            .expect("button");
        assert_eq!(
            (button.name.as_str(), &button.origin),
            ("AppButton", &Origin::Registered)
        );
    }

    #[test]
    fn builds_two_thousand_components_and_looks_them_up_fast() {
        let root = tempfile::tempdir().expect("temp dir");
        for index in 0..2_000 {
            let tone = ["red", "blue", "green", "amber"][index % 4];
            write(
                root.path(),
                &format!("src/features/f{}/components/Thing{index}.tsx", index % 50),
                &format!(
                    "export function Thing{index}({{ label }}: {{ label: string }}) {{\n  return <p className=\"mt-1 text-sm text-{tone}-700 p-{}\">{{label}}</p>;\n}}\n",
                    index % 7
                ),
            );
        }
        brew(root.path());
        let inputs = inputs(root.path());

        let started = Instant::now();
        let snapshot = build(&Snapshot::default(), &inputs);
        let cold = started.elapsed();
        let started = Instant::now();
        let warm = build(&snapshot, &inputs);
        let refresh = started.elapsed();

        assert_eq!(snapshot.len(), 2_003);
        assert_eq!(warm.parsed_last(), 0);
        assert!(cold < Duration::from_secs(30), "cold build took {cold:?}");
        assert!(
            refresh < Duration::from_secs(5),
            "warm refresh took {refresh:?}"
        );
        let mut timings: Vec<Duration> = Vec::with_capacity(1_000);
        for _ in 0..1_000 {
            let started = Instant::now();
            let found = names(
                &warm,
                "src/features/rewards/RewardsSignup.tsx",
                "use the existing error component",
                &inline_error(),
            );
            timings.push(started.elapsed());
            assert_eq!(found.first().map(String::as_str), Some("ErrorMessage"));
        }
        timings.sort();
        let p95 = timings[949];
        assert!(
            p95 < Duration::from_millis(20),
            "95% of lookups took up to {p95:?}"
        );
    }
}
