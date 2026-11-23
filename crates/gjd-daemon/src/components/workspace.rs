use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

pub const MAX_PACKAGES: usize = 24;
const ENTRY_FIELDS: [&str; 5] = ["source", "module", "main", "types", "typings"];
const CONDITIONS: [&str; 5] = ["source", "import", "module", "default", "types"];
const SOURCE_ENTRIES: [&str; 6] = [
    "src/index.tsx",
    "src/index.ts",
    "src/index.jsx",
    "src/index.js",
    "index.tsx",
    "index.ts",
];
const BUILT_DIRS: [&str; 4] = ["dist", "build", "lib", "out"];
const SOURCE_EXTENSIONS: [&str; 6] = ["tsx", "ts", "jsx", "js", "mjs", "mts"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Package {
    pub name: String,
    pub dir: PathBuf,
    pub display: String,
    pub entry: String,
}

fn manifest(dir: &Path) -> Value {
    std::fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null)
}

fn pnpm_patterns(text: &str) -> Vec<String> {
    let mut patterns = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if !line.starts_with([' ', '\t', '-']) {
            inside = trimmed == "packages:";
            continue;
        }
        if inside && let Some(item) = trimmed.strip_prefix('-') {
            let item = item.trim().trim_matches(['\'', '"']);
            if !item.is_empty() {
                patterns.push(item.to_owned());
            }
        }
    }
    patterns
}

fn manifest_patterns(manifest: &Value) -> Option<Vec<String>> {
    let workspaces = manifest.get("workspaces")?;
    let list = workspaces
        .as_array()
        .or_else(|| workspaces.get("packages").and_then(Value::as_array))?;
    Some(
        list.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
    )
}

fn patterns(dir: &Path) -> Option<Vec<String>> {
    if let Ok(text) = std::fs::read_to_string(dir.join("pnpm-workspace.yaml")) {
        return Some(pnpm_patterns(&text));
    }
    manifest_patterns(&manifest(dir))
}

#[must_use]
pub fn workspace_root(project: &Path) -> Option<(PathBuf, Vec<String>)> {
    project
        .ancestors()
        .find_map(|dir| patterns(dir).map(|found| (dir.to_path_buf(), found)))
}

fn expand(root: &Path, pattern: &str) -> Vec<PathBuf> {
    if pattern.starts_with('!') {
        return Vec::new();
    }
    let trimmed = pattern.trim_start_matches("./");
    let Some(parent) = trimmed
        .strip_suffix("/**")
        .or_else(|| trimmed.strip_suffix("/*"))
    else {
        let dir = root.join(trimmed);
        return if dir.is_dir() { vec![dir] } else { Vec::new() };
    };
    if parent.contains('*') {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(root.join(parent)) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    dirs
}

fn condition_path(value: &Value) -> Option<String> {
    match value {
        Value::String(path) => Some(path.clone()),
        Value::Object(conditions) => CONDITIONS
            .iter()
            .find_map(|condition| conditions.get(*condition).and_then(condition_path)),
        _ => None,
    }
}

fn is_source(relative: &str) -> bool {
    let relative = relative.trim_start_matches("./");
    let built = relative
        .split('/')
        .next()
        .is_some_and(|first| BUILT_DIRS.contains(&first));
    let extension = relative
        .rsplit_once('.')
        .map_or("", |(_, extension)| extension);
    !built && !relative.ends_with(".d.ts") && SOURCE_EXTENSIONS.contains(&extension)
}

#[must_use]
pub fn entry(dir: &Path, manifest: &Value) -> Option<String> {
    let exports = manifest.get("exports");
    let from_exports = exports.and_then(|exports| match exports {
        Value::Object(map) if map.contains_key(".") => map.get(".").and_then(condition_path),
        other => condition_path(other),
    });
    let fields = ENTRY_FIELDS.iter().filter_map(|field| {
        manifest
            .get(*field)
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    from_exports
        .into_iter()
        .chain(fields)
        .chain(SOURCE_ENTRIES.iter().map(|entry| (*entry).to_owned()))
        .map(|relative| relative.trim_start_matches("./").to_owned())
        .find(|relative| is_source(relative) && dir.join(relative).is_file())
}

#[must_use]
pub fn packages(project: &Path, dependencies: &BTreeMap<String, String>) -> Vec<Package> {
    let Some((root, patterns)) = workspace_root(project) else {
        return Vec::new();
    };
    let Ok(root) = dunce::canonicalize(&root) else {
        return Vec::new();
    };
    let project = dunce::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    let mut found = Vec::new();
    for dir in patterns.iter().flat_map(|pattern| expand(&root, pattern)) {
        let Ok(dir) = dunce::canonicalize(&dir) else {
            continue;
        };
        if dir == project || !dir.starts_with(&root) {
            continue;
        }
        let manifest = manifest(&dir);
        let Some(name) = manifest.get("name").and_then(Value::as_str) else {
            continue;
        };
        if !dependencies.contains_key(name)
            || found.iter().any(|package: &Package| package.name == name)
        {
            continue;
        }
        let Some(entry) = entry(&dir, &manifest) else {
            continue;
        };
        let display = pathdiff(&dir, &root);
        found.push(Package {
            name: name.to_owned(),
            dir,
            display,
            entry,
        });
        if found.len() >= MAX_PACKAGES {
            break;
        }
    }
    found
}

fn pathdiff(dir: &Path, root: &Path) -> String {
    dir.strip_prefix(root)
        .unwrap_or(dir)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::Path;

    use serde_json::json;

    use super::{entry, packages, pnpm_patterns};

    fn write(root: &Path, file: &str, text: &str) {
        let path = root.join(file);
        fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        fs::write(path, text).expect("file");
    }

    fn depends_on(names: &[&str]) -> BTreeMap<String, String> {
        names
            .iter()
            .map(|name| ((*name).to_owned(), "workspace:*".to_owned()))
            .collect()
    }

    #[test]
    fn reads_the_package_list_of_a_pnpm_workspace() {
        let text = "# monorepo\npackages:\n  - 'apps/*'\n  - \"packages/**\"\n  - tools/cli\n  - '!**/test/**'\ncatalog:\n  react: 19.3.1\n";

        assert_eq!(
            pnpm_patterns(text),
            ["apps/*", "packages/**", "tools/cli", "!**/test/**"]
        );
    }

    #[test]
    fn picks_a_source_entry_and_skips_built_output() {
        let root = tempfile::tempdir().expect("temp dir");
        write(root.path(), "src/index.ts", "export {};");
        write(root.path(), "dist/index.js", "export {};");

        let cases = [
            json!({ "main": "dist/index.js" }),
            json!({ "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } } }),
            json!({ "exports": { ".": { "source": "./src/index.ts" } } }),
            json!({ "exports": "./src/index.ts" }),
        ];
        for manifest in cases {
            assert_eq!(
                entry(root.path(), &manifest).as_deref(),
                Some("src/index.ts"),
                "{manifest}"
            );
        }
        let empty = tempfile::tempdir().expect("temp dir");
        assert_eq!(entry(empty.path(), &json!({ "main": "index.js" })), None);
    }

    #[test]
    fn finds_the_workspace_packages_an_app_depends_on() {
        let root = tempfile::tempdir().expect("temp dir");
        write(
            root.path(),
            "pnpm-workspace.yaml",
            "packages:\n  - apps/*\n  - packages/*\n",
        );
        write(root.path(), "apps/web/package.json", r#"{ "name": "web" }"#);
        write(
            root.path(),
            "packages/ui/package.json",
            r#"{ "name": "@acme/ui", "main": "src/index.ts" }"#,
        );
        write(
            root.path(),
            "packages/ui/src/index.ts",
            "export * from './Alert';",
        );
        write(
            root.path(),
            "packages/utils/package.json",
            r#"{ "name": "@acme/utils" }"#,
        );
        write(root.path(), "packages/utils/src/index.ts", "export {};");
        write(
            root.path(),
            "packages/docs/package.json",
            r#"{ "name": "@acme/docs" }"#,
        );

        let found = packages(
            &root.path().join("apps/web"),
            &depends_on(&["@acme/ui", "react"]),
        );

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "@acme/ui");
        assert_eq!(found[0].display, "packages/ui");
        assert_eq!(found[0].entry, "src/index.ts");
    }

    #[test]
    fn reads_npm_and_yarn_workspaces_in_both_forms() {
        for workspaces in [json!(["packages/*"]), json!({ "packages": ["packages/*"] })] {
            let root = tempfile::tempdir().expect("temp dir");
            write(
                root.path(),
                "package.json",
                &json!({ "name": "root", "workspaces": workspaces }).to_string(),
            );
            write(
                root.path(),
                "packages/ui/package.json",
                r#"{ "name": "ui-kit" }"#,
            );
            write(root.path(), "packages/ui/src/index.tsx", "export {};");
            write(root.path(), "web/package.json", r#"{ "name": "web" }"#);

            let found = packages(&root.path().join("web"), &depends_on(&["ui-kit"]));

            assert_eq!(found.len(), 1, "{workspaces}");
            assert_eq!(found[0].entry, "src/index.tsx");
        }
    }

    #[test]
    fn finds_nothing_outside_a_workspace() {
        let root = tempfile::tempdir().expect("temp dir");
        write(root.path(), "app/package.json", r#"{ "name": "app" }"#);

        assert_eq!(
            packages(&root.path().join("app"), &depends_on(&["anything"])),
            Vec::new()
        );
    }
}
