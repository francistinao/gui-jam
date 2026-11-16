use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gjd_core::policy::is_denied;
use tokio::sync::Mutex;

const FRESH_FOR: Duration = Duration::from_secs(10);
const MAX_FILES: usize = 50_000;
const MAX_DEPTH: usize = 12;
const SKIPPED_DIRS: [&str; 9] = [
    ".git",
    "node_modules",
    "dist",
    "build",
    ".guijam",
    "target",
    "coverage",
    ".next",
    ".turbo",
];

pub struct ProjectIndex {
    root: PathBuf,
    cached: Mutex<Option<(Instant, Arc<Vec<String>>)>>,
}

impl ProjectIndex {
    #[must_use]
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            cached: Mutex::default(),
        }
    }

    pub async fn files(&self) -> Arc<Vec<String>> {
        let mut cached = self.cached.lock().await;
        if let Some((listed_at, files)) = cached.as_ref()
            && listed_at.elapsed() < FRESH_FOR
        {
            return Arc::clone(files);
        }
        let files = Arc::new(list(&self.root).await);
        *cached = Some((Instant::now(), Arc::clone(&files)));
        files
    }
}

async fn list(root: &Path) -> Vec<String> {
    let listed = if let Some(files) = git_files(root).await {
        files
    } else {
        let root = root.to_path_buf();
        tokio::task::spawn_blocking(move || walk(&root))
            .await
            .unwrap_or_default()
    };
    let mut files: Vec<String> = listed
        .into_iter()
        .filter(|file| !is_denied(Path::new(file)))
        .take(MAX_FILES)
        .collect();
    files.sort();
    files.dedup();
    files
}

async fn git_files(root: &Path) -> Option<Vec<String>> {
    let output = tokio::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(
        output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty())
            .filter_map(|entry| std::str::from_utf8(entry).ok())
            .filter(|entry| root.join(entry).is_file())
            .map(str::to_owned)
            .collect(),
    )
}

fn walk(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0)];
    while let Some((directory, depth)) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if depth < MAX_DEPTH && !SKIPPED_DIRS.contains(&name.as_ref()) {
                    pending.push((path, depth + 1));
                }
            } else if kind.is_file()
                && let Ok(relative) = path.strip_prefix(root)
            {
                files.push(relative.to_string_lossy().replace('\\', "/"));
                if files.len() >= MAX_FILES {
                    return files;
                }
            }
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{list, walk};

    #[tokio::test]
    async fn lists_project_files_without_dependencies_build_output_or_secrets() {
        let root = tempfile::tempdir().expect("temp dir");
        for file in [
            "src/App.tsx",
            "src/assets/logo.png",
            "public/cup.svg",
            "node_modules/react/index.js",
            "dist/index.js",
            ".env",
        ] {
            let path = root.path().join(file);
            fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
            fs::write(&path, "x").expect("file");
        }

        let walked = list(root.path()).await;

        assert_eq!(
            walked,
            ["public/cup.svg", "src/App.tsx", "src/assets/logo.png"]
        );
        assert!(walk(root.path()).iter().any(|file| file == ".env"));
    }
}
