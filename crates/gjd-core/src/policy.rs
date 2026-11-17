use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Component, Path, PathBuf};

const DENIED_DIRS: [&str; 5] = [".git", "node_modules", "dist", "build", ".guijam"];
const DENIED_EXTENSIONS: [&str; 2] = ["pem", "key"];
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PolicyError {
    #[error("{0} is outside the project")]
    OutsideProject(String),
    #[error("{0} is on the deny-list")]
    Denied(String),
    #[error("{0} is not a regular file")]
    NotAFile(String),
    #[error("{0} can't be a file name on Windows")]
    NotPortable(String),
}

#[derive(Debug, Clone)]
pub struct ProjectRoot {
    root: PathBuf,
}

impl ProjectRoot {
    pub fn new(root: &Path) -> io::Result<Self> {
        Ok(Self {
            root: dunce::canonicalize(root)?,
        })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.root
    }

    pub fn resolve(&self, relative: &str) -> Result<PathBuf, PolicyError> {
        let outside = || PolicyError::OutsideProject(relative.to_owned());
        let candidate = Path::new(relative);
        let plain = !relative.is_empty()
            && candidate
                .components()
                .all(|component| matches!(component, Component::Normal(_) | Component::CurDir));
        if !plain {
            return Err(outside());
        }
        if is_denied(candidate) {
            return Err(PolicyError::Denied(relative.to_owned()));
        }

        let joined = self.root.join(candidate);
        let resolved = match dunce::canonicalize(&joined) {
            Ok(existing) => existing,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let mut existing = joined.as_path();
                let mut missing: Vec<OsString> = Vec::new();
                loop {
                    match dunce::canonicalize(existing) {
                        Ok(found) => {
                            if let Some(name) = missing.iter().find(|name| !portable_name(name)) {
                                return Err(PolicyError::NotPortable(
                                    name.to_string_lossy().into_owned(),
                                ));
                            }
                            break missing
                                .iter()
                                .rev()
                                .fold(found, |path: PathBuf, name| path.join(name));
                        }
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {
                            missing.push(existing.file_name().ok_or_else(outside)?.to_owned());
                            existing = existing.parent().ok_or_else(outside)?;
                        }
                        Err(_) => return Err(outside()),
                    }
                }
            }
            Err(_) => return Err(outside()),
        };
        let inside = resolved.strip_prefix(&self.root).map_err(|_| outside())?;
        if is_denied(inside) {
            return Err(PolicyError::Denied(relative.to_owned()));
        }
        if resolved.exists() && !resolved.is_file() {
            return Err(PolicyError::NotAFile(relative.to_owned()));
        }
        Ok(resolved)
    }
}

#[must_use]
pub fn portable_name(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let stem = name.split('.').next().unwrap_or_default();
    !name.is_empty()
        && !name.ends_with(['.', ' '])
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\'))
        && !RESERVED_NAMES
            .iter()
            .any(|reserved| reserved.eq_ignore_ascii_case(stem.trim_end()))
}

#[must_use]
pub fn is_denied(relative: &Path) -> bool {
    let directories: Vec<&str> = relative
        .parent()
        .into_iter()
        .flat_map(Path::components)
        .filter_map(|component| match component {
            Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .collect();
    let in_denied_dir = directories
        .iter()
        .any(|directory| DENIED_DIRS.contains(directory));
    let file_name = relative
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let secret_file = file_name.starts_with(".env")
        || relative
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| DENIED_EXTENSIONS.contains(&extension));
    in_denied_dir || secret_file
}

#[cfg(test)]
mod tests {
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    use super::{PolicyError, ProjectRoot, portable_name};

    fn project() -> (tempfile::TempDir, ProjectRoot) {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::create_dir_all(dir.path().join("src/components")).expect("src dirs");
        fs::write(dir.path().join("src/components/A.tsx"), "x").expect("file");
        let root = ProjectRoot::new(dir.path()).expect("root");
        (dir, root)
    }

    #[test]
    fn new_files_need_names_that_also_work_on_windows() {
        let (_dir, root) = project();

        for name in [
            "Aux.tsx",
            "con",
            "nul.tsx",
            "COM1.ts",
            "lpt9.js",
            "Card.",
            "Card ",
            "a:b.tsx",
            "what?.tsx",
            "pipe|.tsx",
        ] {
            assert_eq!(
                root.resolve(&format!("src/components/{name}")),
                Err(PolicyError::NotPortable(name.to_owned())),
                "{name}"
            );
        }
        assert_eq!(
            root.resolve("src/Lpt1/New.tsx"),
            Err(PolicyError::NotPortable("Lpt1".to_owned()))
        );
        for name in [
            "Auxiliary.tsx",
            "Console.tsx",
            "COM10.ts",
            "PriceTag.tsx",
            ".prettierrc",
        ] {
            assert!(portable_name(name.as_ref()), "{name}");
        }
    }

    #[test]
    fn resolves_existing_and_new_files_inside_the_project() {
        let (_dir, root) = project();

        assert!(root.resolve("src/components/A.tsx").is_ok());
        assert!(root.resolve("./src/components/New.tsx").is_ok());
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        let (_dir, root) = project();

        for path in ["../outside.tsx", "src/../../x.tsx", "/etc/passwd", ""] {
            assert_eq!(
                root.resolve(path),
                Err(PolicyError::OutsideProject(path.to_owned())),
                "{path}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_leave_the_project() {
        let (dir, root) = project();
        let elsewhere = tempfile::tempdir().expect("other dir");
        fs::write(elsewhere.path().join("secret.tsx"), "x").expect("file");
        symlink(
            elsewhere.path().join("secret.tsx"),
            dir.path().join("src/link.tsx"),
        )
        .expect("file symlink");
        symlink(elsewhere.path(), dir.path().join("src/linked-dir")).expect("dir symlink");

        assert_eq!(
            root.resolve("src/link.tsx"),
            Err(PolicyError::OutsideProject("src/link.tsx".to_owned()))
        );
        assert_eq!(
            root.resolve("src/linked-dir/new.tsx"),
            Err(PolicyError::OutsideProject(
                "src/linked-dir/new.tsx".to_owned()
            ))
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_denied_files_even_through_symlinks() {
        let (dir, root) = project();
        fs::create_dir_all(dir.path().join(".git")).expect("git dir");
        fs::write(dir.path().join(".git/config"), "x").expect("git config");
        symlink(
            dir.path().join(".git/config"),
            dir.path().join("src/config.tsx"),
        )
        .expect("symlink");

        for path in [
            ".env",
            ".env.local",
            "certs/server.pem",
            ".git/config",
            "node_modules/a/index.js",
            "src/config.tsx",
        ] {
            assert_eq!(
                root.resolve(path),
                Err(PolicyError::Denied(path.to_owned())),
                "{path}"
            );
        }
    }

    #[test]
    fn rejects_directories() {
        let (_dir, root) = project();

        assert_eq!(
            root.resolve("src/components"),
            Err(PolicyError::NotAFile("src/components".to_owned()))
        );
    }

    #[test]
    fn denies_nested_dependency_and_build_directories() {
        use std::path::Path;

        use super::is_denied;

        assert!(is_denied(Path::new("node_modules/react/index.js")));
        assert!(is_denied(Path::new("packages/app/node_modules/x/y.js")));
        assert!(is_denied(Path::new("apps/web/dist/main.js")));
        assert!(is_denied(Path::new("config/.env.local")));
        assert!(!is_denied(Path::new("src/components/Distance.tsx")));
        assert!(!is_denied(Path::new("node_modules")));
    }

    #[test]
    fn resolves_new_files_in_folders_that_do_not_exist_yet() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = ProjectRoot::new(dir.path()).expect("root");

        let resolved = root.resolve("src/assets/icons/cup.svg").expect("inside");

        assert_eq!(resolved, root.path().join("src/assets/icons/cup.svg"));
    }
}
