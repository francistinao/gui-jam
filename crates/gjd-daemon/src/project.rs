use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::Path;

use serde_json::Value;

pub const DEFAULT_COMPONENTS: &str = "src/components";
const COMPONENT_DIRS: [&str; 4] = [
    "src/components",
    "components",
    "app/components",
    "src/lib/components",
];
pub const LEVELS: [&str; 3] = ["atoms", "molecules", "organisms"];
pub const MAX_NEW_FILES: usize = 8;
pub const MAX_NEW_FILE_BYTES: usize = 60 * 1024;
const EXISTING_SHOWN: usize = 40;
const LOCKFILES: [(&str, PackageManager); 5] = [
    ("pnpm-lock.yaml", PackageManager::Pnpm),
    ("yarn.lock", PackageManager::Yarn),
    ("bun.lock", PackageManager::Bun),
    ("bun.lockb", PackageManager::Bun),
    ("package-lock.json", PackageManager::Npm),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ui {
    React,
    Preact,
    Solid,
    Vue,
    Svelte,
    None,
}

impl Ui {
    #[must_use]
    pub fn jsx(self) -> bool {
        matches!(self, Self::React | Self::Preact | Self::Solid)
    }

    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::React => "React",
            Self::Preact => "Preact",
            Self::Solid => "Solid",
            Self::Vue => "Vue",
            Self::Svelte => "Svelte",
            Self::None => "plain HTML",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PackageManager {
    Npm,
    Pnpm,
    Yarn,
    Bun,
}

impl PackageManager {
    #[must_use]
    pub fn command(self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Pnpm => "pnpm",
            Self::Yarn => "yarn",
            Self::Bun => "bun",
        }
    }

    fn parse(name: &str) -> Option<Self> {
        match name {
            "npm" => Some(Self::Npm),
            "pnpm" => Some(Self::Pnpm),
            "yarn" => Some(Self::Yarn),
            "bun" => Some(Self::Bun),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Project {
    pub ui: Ui,
    pub typescript: bool,
    pub dependencies: BTreeMap<String, String>,
    pub package_manager: PackageManager,
    pub components: String,
}

impl Project {
    #[must_use]
    pub fn extension(&self) -> &'static str {
        if self.typescript { "tsx" } else { "jsx" }
    }
}

fn manifest(root: &Path) -> Value {
    std::fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null)
}

fn dependencies(manifest: &Value) -> BTreeMap<String, String> {
    ["dependencies", "devDependencies"]
        .iter()
        .filter_map(|key| manifest.get(key).and_then(Value::as_object))
        .flatten()
        .map(|(name, version)| (name.clone(), version.as_str().unwrap_or("").to_owned()))
        .collect()
}

fn ui_of(dependencies: &BTreeMap<String, String>) -> Ui {
    let has = |name: &str| dependencies.contains_key(name);
    if has("react") || has("react-dom") {
        Ui::React
    } else if has("preact") {
        Ui::Preact
    } else if has("solid-js") {
        Ui::Solid
    } else if has("vue") {
        Ui::Vue
    } else if has("svelte") {
        Ui::Svelte
    } else {
        Ui::None
    }
}

fn package_manager(root: &Path, manifest: &Value) -> PackageManager {
    if let Some(manager) = manifest
        .get("packageManager")
        .and_then(Value::as_str)
        .and_then(|field| PackageManager::parse(field.split('@').next().unwrap_or("")))
    {
        return manager;
    }
    root.ancestors()
        .find_map(|dir| {
            LOCKFILES
                .iter()
                .find(|(file, _)| dir.join(file).is_file())
                .map(|(_, manager)| *manager)
        })
        .unwrap_or(PackageManager::Npm)
}

fn components_dir(files: &[String]) -> String {
    COMPONENT_DIRS
        .iter()
        .find(|dir| {
            files
                .iter()
                .any(|file| file.starts_with(&format!("{dir}/")))
        })
        .map_or_else(|| DEFAULT_COMPONENTS.to_owned(), |dir| (*dir).to_owned())
}

#[must_use]
pub fn detect(root: &Path, files: &[String]) -> Project {
    let manifest = manifest(root);
    let dependencies = dependencies(&manifest);
    Project {
        ui: ui_of(&dependencies),
        typescript: dependencies.contains_key("typescript")
            || files.iter().any(|file| file == "tsconfig.json"),
        package_manager: package_manager(root, &manifest),
        components: components_dir(files),
        dependencies,
    }
}

#[must_use]
pub fn existing_components(project: &Project, files: &[String]) -> Vec<String> {
    let prefix = format!("{}/", project.components);
    files
        .iter()
        .filter_map(|file| file.strip_prefix(&prefix))
        .filter(|rest| {
            Path::new(rest)
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| matches!(extension, "tsx" | "jsx"))
        })
        .take(EXISTING_SHOWN)
        .map(str::to_owned)
        .collect()
}

fn import_without_extension(from_file: &str, target: &str) -> String {
    let path = crate::assets::import_path(from_file, target);
    path.rsplit_once('.')
        .map_or(path.clone(), |(stem, _)| stem.to_owned())
}

#[must_use]
pub fn new_ui_section(project: &Project, files: &[String], file: &str) -> String {
    if !project.ui.jsx() {
        return String::new();
    }
    let dir = &project.components;
    let extension = project.extension();
    let props = if project.typescript {
        " with a typed props interface,"
    } else {
        ""
    };
    let organism =
        import_without_extension(file, &format!("{dir}/organisms/PricingSection.{extension}"));
    let existing = existing_components(project, files);
    let mut out = format!(
        "\n<new-ui components=\"{dir}\" extension=\"{extension}\" library=\"{library}\">\n\
When the request adds UI that isn't on the page yet (what a sketch shows, or a section, card, form \
or list the prompt asks for), put it in new component files instead of inline markup:\n\
- a self-contained piece (one effect, widget, card or section) is a single organism file in {dir}/organisms/\n\
- split out atoms (the smallest reusable pieces, such as a button, badge or input) in {dir}/atoms/ and \
molecules (small groups of atoms, such as a plan card) in {dir}/molecules/ only when a part repeats \
inside the piece or other UI would reuse it\n\
Add each new component with a create_file op: one exported function component per file, named like \
its PascalCase file ({dir}/atoms/PriceTag.{extension} exports PriceTag),{props} styled with the \
project's theme tokens. Import components with relative paths and no extension. Reuse the existing \
components below instead of creating similar ones. In {file}, import only the organism (an organism \
named PricingSection is imported from \"{organism}\") and render it where the sketch sits. Create at \
most {MAX_NEW_FILES} files. When the request changes elements that already exist, edit them in place \
and create no files.\n",
        library = project.ui.name(),
    );
    if existing.is_empty() {
        out.push_str("Existing components: none yet.\n");
    } else {
        let _ = writeln!(out, "Existing components: {}", existing.join(", "));
    }
    out.push_str("</new-ui>\n");
    out
}

fn pascal_case(stem: &str) -> bool {
    let mut chars = stem.chars();
    chars.next().is_some_and(|first| first.is_ascii_uppercase())
        && chars.all(|c| c.is_ascii_alphanumeric())
}

pub fn check_new_path(project: &Project, path: &str) -> Result<(), String> {
    if !project.ui.jsx() {
        return Err(format!(
            "It creates {path}, but GUIJam only creates component files in React, Preact or Solid projects."
        ));
    }
    let components = &project.components;
    let segments: Vec<&str> = path.split('/').collect();
    let unsafe_path = path.starts_with('/')
        || path.contains('\\')
        || segments
            .iter()
            .any(|segment| segment.is_empty() || *segment == "." || *segment == "..");
    let Some(rest) = path
        .strip_prefix(components.as_str())
        .and_then(|rest| rest.strip_prefix('/'))
        .filter(|_| !unsafe_path)
    else {
        return Err(format!("It creates {path}, outside {components}/."));
    };
    let (level, name) = match rest.split('/').collect::<Vec<_>>().as_slice() {
        [level, name] if LEVELS.contains(level) => (*level, *name),
        _ => {
            return Err(format!(
                "It creates {path}; new components go in {components}/atoms, molecules or organisms."
            ));
        }
    };
    let extension = project.extension();
    let Some(stem) = name.strip_suffix(&format!(".{extension}")) else {
        return Err(format!(
            "It creates {path}; this project's components are .{extension} files."
        ));
    };
    if !pascal_case(stem) {
        return Err(format!(
            "It creates {level}/{name}; component files are named in PascalCase, like PriceTag.{extension}."
        ));
    }
    if !gjd_core::policy::portable_name(name.as_ref()) {
        return Err(format!(
            "It creates {level}/{name}, a name Windows reserves; components need another name."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        PackageManager, Project, Ui, check_new_path, detect, existing_components, new_ui_section,
    };

    fn files(list: &[&str]) -> Vec<String> {
        list.iter().map(|file| (*file).to_owned()).collect()
    }

    fn project_with(
        manifest: &str,
        lockfile: Option<&str>,
        list: &[&str],
    ) -> (tempfile::TempDir, Project) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("app");
        std::fs::create_dir_all(&root).expect("root");
        std::fs::write(root.join("package.json"), manifest).expect("manifest");
        if let Some(lockfile) = lockfile {
            std::fs::write(dir.path().join(lockfile), "").expect("lockfile");
        }
        let project = detect(&root, &files(list));
        (dir, project)
    }

    #[test]
    fn detects_the_ui_library_typescript_and_package_manager() {
        let cases = [
            (
                r#"{"dependencies":{"react":"19.2.0","react-dom":"19.2.0"},"devDependencies":{"typescript":"5.9.3"}}"#,
                Ui::React,
                true,
            ),
            (
                r#"{"dependencies":{"preact":"10.27.0"}}"#,
                Ui::Preact,
                false,
            ),
            (r#"{"dependencies":{"solid-js":"1.9.9"}}"#, Ui::Solid, false),
            (r#"{"dependencies":{"vue":"3.5.0"}}"#, Ui::Vue, false),
            (
                r#"{"devDependencies":{"svelte":"5.0.0"}}"#,
                Ui::Svelte,
                false,
            ),
            (r#"{"devDependencies":{"vite":"8.0.0"}}"#, Ui::None, false),
            ("not json", Ui::None, false),
        ];
        for (manifest, ui, typescript) in cases {
            let (_dir, project) = project_with(manifest, None, &[]);
            assert_eq!(
                (project.ui, project.typescript),
                (ui, typescript),
                "{manifest}"
            );
        }
        let (_dir, with_tsconfig) = project_with(
            r#"{"dependencies":{"react":"19.2.0"}}"#,
            None,
            &["tsconfig.json"],
        );
        assert!(with_tsconfig.typescript);
        assert_eq!(
            with_tsconfig.dependencies.get("react").map(String::as_str),
            Some("19.2.0")
        );
    }

    #[test]
    fn finds_the_package_manager_from_the_field_or_a_lockfile_above() {
        let (_dir, field) = project_with(
            r#"{"packageManager":"yarn@4.9.0"}"#,
            Some("pnpm-lock.yaml"),
            &[],
        );
        assert_eq!(field.package_manager, PackageManager::Yarn);
        for (lockfile, manager) in [
            ("pnpm-lock.yaml", PackageManager::Pnpm),
            ("yarn.lock", PackageManager::Yarn),
            ("bun.lock", PackageManager::Bun),
            ("package-lock.json", PackageManager::Npm),
        ] {
            let (_dir, project) = project_with("{}", Some(lockfile), &[]);
            assert_eq!(project.package_manager, manager, "{lockfile}");
        }
        let (_dir, none) = project_with("{}", None, &[]);
        assert_eq!(none.package_manager.command(), "npm");
    }

    #[test]
    fn picks_the_components_folder_the_project_already_uses() {
        let detect_in = |list: &[&str]| detect(Path::new("/nonexistent"), &files(list)).components;
        assert_eq!(detect_in(&["src/App.tsx"]), "src/components");
        assert_eq!(
            detect_in(&["components/Nav.tsx", "pages/index.tsx"]),
            "components"
        );
        assert_eq!(detect_in(&["app/components/Nav.tsx"]), "app/components");
        assert_eq!(
            detect_in(&["src/lib/components/Nav.tsx"]),
            "src/lib/components"
        );
        assert_eq!(
            detect_in(&["src/components/Nav.tsx", "components/Old.jsx"]),
            "src/components"
        );
    }

    fn react(typescript: bool) -> Project {
        Project {
            ui: Ui::React,
            typescript,
            dependencies: std::collections::BTreeMap::new(),
            package_manager: PackageManager::Pnpm,
            components: "src/components".to_owned(),
        }
    }

    #[test]
    fn accepts_only_pascal_case_files_in_an_atomic_folder() {
        let project = react(true);
        for path in [
            "src/components/atoms/Price.tsx",
            "src/components/molecules/PlanCard.tsx",
            "src/components/organisms/PricingSection2.tsx",
        ] {
            assert_eq!(check_new_path(&project, path), Ok(()), "{path}");
        }
        let refused = [
            ("src/pages/Pricing.tsx", "outside src/components/"),
            ("/src/components/atoms/A.tsx", "outside src/components/"),
            (
                "src/components/atoms/../../../etc/Passwd.tsx",
                "outside src/components/",
            ),
            ("src/components//atoms/A.tsx", "outside src/components/"),
            ("src/components\\atoms\\A.tsx", "outside src/components/"),
            ("src/componentsX/atoms/A.tsx", "outside src/components/"),
            (
                "src/components/Pricing.tsx",
                "atoms, molecules or organisms",
            ),
            (
                "src/components/widgets/Pricing.tsx",
                "atoms, molecules or organisms",
            ),
            (
                "src/components/organisms/parts/Pricing.tsx",
                "atoms, molecules or organisms",
            ),
            ("src/components/atoms/Price.jsx", "are .tsx files"),
            ("src/components/atoms/Price.css", "are .tsx files"),
            ("src/components/atoms/price.tsx", "PascalCase"),
            ("src/components/atoms/Price-Tag.tsx", "PascalCase"),
            ("src/components/atoms/.tsx", "PascalCase"),
            ("src/components/atoms/Aux.tsx", "Windows reserves"),
            ("src/components/molecules/Com1.tsx", "Windows reserves"),
        ];
        for (path, reason) in refused {
            let error = check_new_path(&project, path).expect_err(path);
            assert!(error.contains(reason), "{path}: {error}");
        }
        assert_eq!(
            check_new_path(&react(false), "src/components/atoms/Price.jsx"),
            Ok(())
        );
        let plain = Project {
            ui: Ui::None,
            ..react(true)
        };
        assert!(
            check_new_path(&plain, "src/components/atoms/Price.tsx")
                .expect_err("plain")
                .contains("only creates component files in React, Preact or Solid")
        );
    }

    #[test]
    fn lists_the_components_already_there() {
        let list = files(&[
            "src/App.tsx",
            "src/components/Navbar.tsx",
            "src/components/atoms/Button.tsx",
            "src/components/atoms/button.css",
            "src/components/index.ts",
        ]);
        assert_eq!(
            existing_components(&react(true), &list),
            ["Navbar.tsx", "atoms/Button.tsx"]
        );
    }

    #[test]
    fn the_new_ui_section_names_folders_imports_and_existing_components() {
        let list = files(&[
            "src/components/atoms/Button.tsx",
            "src/components/Navbar.tsx",
        ]);

        let section = new_ui_section(&react(true), &list, "src/components/OrderButton.tsx");

        assert!(
            section.starts_with(
                "\n<new-ui components=\"src/components\" extension=\"tsx\" library=\"React\">\n"
            ),
            "{section}"
        );
        assert!(
            section.contains("in src/components/organisms/"),
            "{section}"
        );
        assert!(
            section.contains("is a single organism file in src/components/organisms/"),
            "{section}"
        );
        assert!(
            section.contains("only when a part repeats inside the piece"),
            "{section}"
        );
        assert!(
            section.contains("with a typed props interface,"),
            "{section}"
        );
        assert!(
            section.contains("is imported from \"./organisms/PricingSection\""),
            "{section}"
        );
        assert!(
            section.contains("Existing components: atoms/Button.tsx, Navbar.tsx\n</new-ui>\n"),
            "{section}"
        );

        let from_app = new_ui_section(&react(false), &[], "src/App.jsx");
        assert!(from_app.contains("extension=\"jsx\""), "{from_app}");
        assert!(!from_app.contains("typed props"), "{from_app}");
        assert!(
            from_app.contains("\"./components/organisms/PricingSection\""),
            "{from_app}"
        );
        assert!(
            from_app.contains("Existing components: none yet."),
            "{from_app}"
        );

        let plain = Project {
            ui: Ui::None,
            ..react(true)
        };
        assert_eq!(new_ui_section(&plain, &list, "index.html"), "");
    }
}
