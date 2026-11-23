use std::fmt::Write as _;

use gjd_core::components::{Export, Imported, Markup, Prop};

use super::{Entry, ImportStyle, Match, Origin};

pub const ALWAYS_LIMIT: usize = 3;
pub const HINTED_LIMIT: usize = 8;
pub const SOURCES: usize = 2;
const WHOLE_FILE_LINES: usize = 80;
const SOURCE_WINDOW: usize = 40;
const MAX_ALWAYS_BYTES: usize = 1_536;
const MAX_HINTED_BYTES: usize = 8_192;
const MAX_PROPS: usize = 8;
const SIMILAR_CLASSES: f64 = 0.2;
const SCRIPT_EXTENSIONS: [&str; 6] = ["tsx", "ts", "jsx", "js", "mjs", "mts"];

#[must_use]
pub fn limit(hinted: bool) -> usize {
    if hinted { HINTED_LIMIT } else { ALWAYS_LIMIT }
}

#[must_use]
pub fn relative_specifier(selected: &str, target: &str) -> String {
    let path = crate::assets::import_path(selected, target);
    let bare = match path.rsplit_once('.') {
        Some((stem, extension)) if SCRIPT_EXTENSIONS.contains(&extension) => stem.to_owned(),
        _ => path,
    };
    bare.strip_suffix("/index")
        .map_or(bare.clone(), str::to_owned)
}

fn imported_of(export: &Export) -> Option<Imported> {
    match export {
        Export::Default => Some(Imported::Default),
        Export::Named(name) => Some(Imported::Named(name.clone())),
        Export::None => None,
    }
}

#[must_use]
pub fn import_line(entry: &Entry, style: Option<&ImportStyle>, selected: &str) -> Option<String> {
    let (specifier, imported) = match &entry.origin {
        Origin::Registered => return None,
        Origin::Package(package) => (package.clone(), Imported::Named(entry.name.clone())),
        Origin::Project => match style {
            Some(style) => (style.specifier.clone(), style.imported.clone()),
            None => (
                relative_specifier(selected, &entry.file),
                imported_of(&entry.export)?,
            ),
        },
    };
    match imported {
        Imported::Default => Some(format!("import {} from \"{specifier}\";", entry.name)),
        Imported::Named(name) if name == entry.name => {
            Some(format!("import {{ {name} }} from \"{specifier}\";"))
        }
        Imported::Named(name) => Some(format!(
            "import {{ {name} as {} }} from \"{specifier}\";",
            entry.name
        )),
        Imported::Namespace => None,
    }
}

fn props_line(props: &[Prop]) -> String {
    if props.is_empty() {
        return "none".to_owned();
    }
    let mut shown: Vec<String> = props
        .iter()
        .take(MAX_PROPS)
        .map(|prop| {
            let mark = if prop.optional { "?" } else { "" };
            match &prop.ty {
                Some(ty) => format!("{}{mark}: {ty}", prop.name),
                None => format!("{}{mark}", prop.name),
            }
        })
        .collect();
    if props.len() > MAX_PROPS {
        shown.push("…".to_owned());
    }
    shown.join(", ")
}

fn root_line(root: &Markup) -> String {
    let mut line = format!("<{}", root.tag);
    if !root.classes.is_empty() {
        let _ = write!(line, " class=\"{}\"", root.classes.join(" "));
    }
    if let Some(role) = &root.role {
        let _ = write!(line, " role=\"{role}\"");
    }
    line.push('>');
    line
}

fn reasons(found: &Match<'_>) -> String {
    let mut why: Vec<String> = Vec::new();
    if found.scored.named {
        why.push("named in the request".to_owned());
    }
    if found.scored.tag {
        why.push("same tag".to_owned());
    }
    if found.scored.class >= SIMILAR_CLASSES {
        why.push(format!("similar classes ({:.2})", found.scored.class));
    }
    if found.scored.name > 0.0 && !found.scored.named {
        why.push("its name fits".to_owned());
    }
    why.join(", ")
}

fn used(count: u32) -> String {
    match count {
        0 => "not used yet".to_owned(),
        1 => "used in 1 file".to_owned(),
        count => format!("used in {count} files"),
    }
}

fn describe(found: &Match<'_>, selected: &str) -> String {
    let entry = found.entry;
    let mut text = format!(
        "- {} · {} · {}:{} · {}\n",
        entry.name,
        found.scope.label(),
        entry.file,
        entry.line,
        used(found.used_by)
    );
    match import_line(entry, found.style, selected) {
        Some(import) => {
            let _ = writeln!(text, "  {import}");
        }
        None => text.push_str("  no import needed: it is registered globally\n"),
    }
    let _ = writeln!(text, "  props: {}", props_line(&entry.props));
    if let Some(root) = &entry.root {
        let _ = writeln!(text, "  renders: {}", root_line(root));
    }
    let why = reasons(found);
    if !why.is_empty() {
        let _ = writeln!(text, "  why: {why}");
    }
    text
}

#[must_use]
pub fn excerpt(content: &str, line: u64) -> (usize, usize, String) {
    let lines: Vec<&str> = content.lines().collect();
    if lines.len() <= WHOLE_FILE_LINES {
        return (1, lines.len(), lines.join("\n"));
    }
    let at = usize::try_from(line).unwrap_or(1).max(1);
    let first = at.saturating_sub(SOURCE_WINDOW).max(1);
    let last = (at + SOURCE_WINDOW).min(lines.len());
    (first, last, lines[first - 1..last].join("\n"))
}

#[must_use]
pub fn render(
    selected: &str,
    matches: &[Match<'_>],
    sources: &[(String, String)],
    hinted: bool,
) -> String {
    if matches.is_empty() {
        return String::new();
    }
    let budget = if hinted {
        MAX_HINTED_BYTES
    } else {
        MAX_ALWAYS_BYTES
    };
    let mut out = format!(
        "\n<components for=\"{selected}\">\nExisting components that look like the selected element or match the request, best first. When one fits what the selected element is, use it instead of writing the markup again: replace the selected markup with it in {selected}, add its import exactly as shown (skip it when none is needed), and pass the text and values as its props. Never edit these components' own files.\n"
    );
    for found in matches {
        let text = describe(found, selected);
        if out.len() + text.len() > budget {
            break;
        }
        out.push_str(&text);
    }
    out.push_str("</components>\n");
    for (path, content) in sources {
        let Some(found) = matches.iter().find(|found| &found.entry.file == path) else {
            continue;
        };
        let (first, last, text) = excerpt(content, found.entry.line);
        let block = format!(
            "\n<component-source path=\"{path}\" lines=\"{first}-{last}\">\n{text}\n</component-source>\n"
        );
        if out.len() + block.len() > budget {
            break;
        }
        out.push_str(&block);
    }
    out
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use gjd_core::components::{ComponentDecl, Export, Imported, Markup, Prop};

    use super::{excerpt, import_line, relative_specifier, render};
    use crate::components::rank::Scored;
    use crate::components::scope::Scope;
    use crate::components::{Entry, ImportStyle, Match, Origin, Place};

    fn entry(name: &str, file: &str, export: Export, origin: Origin) -> Entry {
        let component = ComponentDecl {
            name: name.to_owned(),
            export: export.clone(),
            props: vec![Prop {
                name: "message".to_owned(),
                optional: false,
                ty: Some("string".to_owned()),
            }],
            root: Some(Markup {
                tag: "p".to_owned(),
                classes: vec!["mt-1".to_owned(), "text-sm".to_owned()],
                role: Some("alert".to_owned()),
            }),
            line: 5,
        };
        let place = Place {
            name: name.to_owned(),
            file: file.to_owned(),
            path: std::path::PathBuf::from(file),
            origin,
        };
        Entry::new(place, &component, export)
    }

    fn scored() -> Scored {
        Scored {
            score: 0.5,
            class: 0.33,
            name: 0.5,
            tag: true,
            named: false,
        }
    }

    #[test]
    fn writes_paths_without_script_extensions_or_index() {
        let from = "src/features/rewards/RewardsSignup.tsx";

        assert_eq!(
            relative_specifier(from, "src/components/ErrorMessage.tsx"),
            "../../components/ErrorMessage"
        );
        assert_eq!(
            relative_specifier(from, "src/components/alert/index.tsx"),
            "../../components/alert"
        );
        assert_eq!(
            relative_specifier("src/views/Home.vue", "src/components/ErrorMessage.vue"),
            "../components/ErrorMessage.vue"
        );
    }

    #[test]
    fn imports_the_way_the_project_already_does() {
        let selected = "src/features/rewards/RewardsSignup.tsx";
        let named = entry(
            "ErrorMessage",
            "src/components/ErrorMessage.tsx",
            Export::Named("ErrorMessage".into()),
            Origin::Project,
        );
        let default = entry(
            "Card",
            "src/components/Card.tsx",
            Export::Default,
            Origin::Project,
        );
        let aliased = ImportStyle {
            specifier: "@/components".to_owned(),
            imported: Imported::Named("ErrorMessage".to_owned()),
        };
        let package = entry(
            "Alert",
            "packages/ui/src/Alert.tsx",
            Export::Named("Alert".into()),
            Origin::Package("@acme/ui".into()),
        );
        let registered = entry(
            "BaseButton",
            "components/base/Button.vue",
            Export::Default,
            Origin::Registered,
        );
        let hidden = entry(
            "Inner",
            "src/components/Inner.tsx",
            Export::None,
            Origin::Project,
        );

        assert_eq!(
            import_line(&named, None, selected).as_deref(),
            Some("import { ErrorMessage } from \"../../components/ErrorMessage\";")
        );
        assert_eq!(
            import_line(&named, Some(&aliased), selected).as_deref(),
            Some("import { ErrorMessage } from \"@/components\";")
        );
        assert_eq!(
            import_line(&default, None, selected).as_deref(),
            Some("import Card from \"../../components/Card\";")
        );
        assert_eq!(
            import_line(&package, None, selected).as_deref(),
            Some("import { Alert } from \"@acme/ui\";")
        );
        assert_eq!(import_line(&registered, None, selected), None);
        assert_eq!(import_line(&hidden, None, selected), None);
    }

    #[test]
    fn lists_matches_with_their_import_props_markup_and_reasons() {
        let error = entry(
            "ErrorMessage",
            "src/components/ErrorMessage.tsx",
            Export::Named("ErrorMessage".into()),
            Origin::Project,
        );
        let registered = entry(
            "BaseAlert",
            "components/base/Alert.vue",
            Export::Default,
            Origin::Registered,
        );
        let matches = [
            Match {
                entry: &error,
                scope: Scope::Shared,
                scored: scored(),
                used_by: 1,
                style: None,
            },
            Match {
                entry: &registered,
                scope: Scope::Global,
                scored: scored(),
                used_by: 0,
                style: None,
            },
        ];

        let text = render(
            "src/features/rewards/RewardsSignup.tsx",
            &matches,
            &[],
            false,
        );

        assert!(
            text.starts_with("\n<components for=\"src/features/rewards/RewardsSignup.tsx\">\n")
        );
        assert!(text.contains("- ErrorMessage · shared · src/components/ErrorMessage.tsx:5 · used in 1 file\n  import { ErrorMessage } from \"../../components/ErrorMessage\";\n  props: message: string\n  renders: <p class=\"mt-1 text-sm\" role=\"alert\">\n  why: same tag, similar classes (0.33), its name fits\n"));
        assert!(text.contains("- BaseAlert · global · components/base/Alert.vue:5 · not used yet\n  no import needed: it is registered globally\n"));
        assert!(text.ends_with("</components>\n"));
        assert!(text.len() <= 1_536);
        assert_eq!(render("src/A.tsx", &[], &[], true), "");
    }

    #[test]
    fn adds_component_sources_only_within_the_budget() {
        let error = entry(
            "ErrorMessage",
            "src/components/ErrorMessage.tsx",
            Export::Named("ErrorMessage".into()),
            Origin::Project,
        );
        let matches = [Match {
            entry: &error,
            scope: Scope::Shared,
            scored: scored(),
            used_by: 1,
            style: None,
        }];
        let small = "export function ErrorMessage() {\n  return <p />;\n}".to_owned();
        let huge = "x\n".repeat(20_000);

        let with_source = render("src/A.tsx", &matches, &[(error.file.clone(), small)], true);
        let too_big = render("src/A.tsx", &matches, &[(error.file.clone(), huge)], true);

        assert!(with_source.contains("<component-source path=\"src/components/ErrorMessage.tsx\" lines=\"1-3\">\nexport function ErrorMessage() {"));
        assert!(too_big.contains("<component-source"));
        assert!(too_big.len() <= 8_192);
    }

    #[test]
    fn shows_a_long_file_around_the_component() {
        let content = (1..=300).fold(String::new(), |mut text, line| {
            let _ = writeln!(text, "line {line}");
            text
        });

        let (first, last, text) = excerpt(&content, 150);

        assert_eq!((first, last), (110, 190));
        assert!(text.starts_with("line 110\n"));
        assert!(text.ends_with("line 190"));
        assert_eq!(excerpt("a\nb", 1), (1, 2, "a\nb".to_owned()));
    }
}
