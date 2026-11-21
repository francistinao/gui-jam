use std::collections::BTreeSet;

use gjd_core::content::ContentPart;
use gjd_core::contracts::TextPlace;
use gjd_core::jsx;
use gjd_core::srcloc::LineIndex;
use gjd_core::template;
use gjd_core::text_source::{self, Key, Place};

use crate::references::is_test_or_story;

pub const MAX_FILES: usize = 24;
pub const MAX_LOCALES: usize = 40;
pub const MAX_RENDER_SITES: usize = 3;
pub const MAX_TEXT_CHARS: usize = 500;

const EXTENSIONS: [&str; 9] = [
    "ts", "tsx", "js", "jsx", "mjs", "vue", "svelte", "astro", "json",
];
const RENDER_EXTENSIONS: [&str; 6] = ["tsx", "jsx", "js", "vue", "svelte", "astro"];
const ALIASES: [(&str, &[&str]); 3] = [
    ("@/", &["src/", "app/", ""]),
    ("~/", &["src/", "app/", ""]),
    ("$lib/", &["src/lib/"]),
];
const LOCALE_DIRS: [&str; 6] = [
    "locales",
    "locale",
    "i18n",
    "lang",
    "messages",
    "translations",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lookup {
    pub key: Key,
    pub code: String,
    pub component: Option<String>,
}

fn extension(path: &str) -> Option<String> {
    let name = path.rsplit('/').next()?;
    name.rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
}

fn normalize(path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

fn bases(from: &str, specifier: &str) -> Vec<String> {
    if specifier.starts_with("./") || specifier.starts_with("../") {
        let directory = from.rsplit_once('/').map_or("", |(directory, _)| directory);
        return normalize(&format!("{directory}/{specifier}"))
            .into_iter()
            .collect();
    }
    ALIASES
        .iter()
        .find_map(|(prefix, roots)| {
            specifier.strip_prefix(prefix).map(|rest| {
                roots
                    .iter()
                    .filter_map(|root| normalize(&format!("{root}{rest}")))
                    .collect()
            })
        })
        .unwrap_or_default()
}

#[must_use]
pub fn resolve(from: &str, specifier: &str, files: &BTreeSet<&str>) -> Option<String> {
    let specifier = specifier.split('?').next().unwrap_or(specifier);
    for base in bases(from, specifier) {
        let mut tried = vec![base.clone()];
        if let Some(stem) = base
            .strip_suffix(".js")
            .or_else(|| base.strip_suffix(".mjs"))
        {
            tried.push(format!("{stem}.ts"));
            tried.push(format!("{stem}.tsx"));
        }
        tried.extend(
            EXTENSIONS
                .iter()
                .map(|extension| format!("{base}.{extension}")),
        );
        tried.extend(
            EXTENSIONS
                .iter()
                .map(|extension| format!("{base}/index.{extension}")),
        );
        if let Some(found) = tried.into_iter().find(|path| {
            files.contains(path.as_str())
                && extension(path).is_some_and(|found| EXTENSIONS.contains(&found.as_str()))
        }) {
            return Some(found);
        }
    }
    None
}

#[must_use]
pub fn imports(path: &str, source: &str) -> Vec<String> {
    if text_source::is_json(path) {
        return Vec::new();
    }
    if template::is_template(path) {
        return text_source::script_blocks(path, source)
            .into_iter()
            .flat_map(|block| jsx::imports(block.path, &source[block.range]).unwrap_or_default())
            .collect();
    }
    jsx::imports(path, source).unwrap_or_default()
}

#[must_use]
pub fn is_locale(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    let Some(stem) = lowered.strip_suffix(".json") else {
        return false;
    };
    let (directories, name) = stem.rsplit_once('/').unwrap_or(("", stem));
    if directories
        .split('/')
        .any(|directory| LOCALE_DIRS.contains(&directory))
    {
        return true;
    }
    let (language, region) = name
        .split_once(['-', '_'])
        .map_or((name, None), |(language, region)| (language, Some(region)));
    (2..=3).contains(&language.len())
        && language.bytes().all(|byte| byte.is_ascii_lowercase())
        && region.is_none_or(|region| {
            (2..=4).contains(&region.len())
                && region.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}

#[must_use]
pub fn renders_components(path: &str) -> bool {
    extension(path).is_some_and(|found| RENDER_EXTENSIONS.contains(&found.as_str()))
        && !is_test_or_story(path)
}

#[must_use]
pub fn renders(path: &str, content: &str, component: &str) -> bool {
    let marker = format!("<{component}");
    if !content.contains(&marker) {
        return false;
    }
    if template::is_template(path) {
        return content.match_indices(&marker).any(|(at, _)| {
            content
                .as_bytes()
                .get(at + marker.len())
                .is_some_and(|byte| byte.is_ascii_whitespace() || matches!(byte, b'>' | b'/'))
        });
    }
    jsx::usages(path, content, component).is_ok_and(|found| !found.is_empty())
}

fn component_of(file: &str, source: &str, line: u64, column: u64) -> Option<String> {
    if template::is_template(file) {
        let name = file.rsplit('/').next()?.split_once('.')?.0;
        let mut chars = name.chars();
        return (chars.next()?.is_ascii_uppercase() && chars.all(char::is_alphanumeric))
            .then(|| name.to_owned());
    }
    jsx::enclosing_component(file, source, line, column).map(|component| component.name)
}

#[must_use]
pub fn lookup(file: &str, source: &str, line: u64, column: u64) -> Option<Lookup> {
    let content = jsx::find_element(file, source, line, column)
        .ok()?
        .content?;
    let [ContentPart::Code { source: code }] = content.as_slice() else {
        return None;
    };
    let key = text_source::key_of(code)?;
    let component = match key {
        Key::Translation(_) => None,
        _ => component_of(file, source, line, column),
    };
    Some(Lookup {
        key,
        code: code.clone(),
        component,
    })
}

#[must_use]
pub fn shown_text(text: &str) -> Option<String> {
    let collapsed: String = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_TEXT_CHARS)
        .collect();
    (!collapsed.is_empty()).then_some(collapsed)
}

#[must_use]
pub fn could_contain(source: &str, text: &str) -> bool {
    text.split(|character: char| !character.is_alphanumeric())
        .max_by_key(|word| word.chars().count())
        .is_none_or(|word| word.is_empty() || source.contains(word))
}

#[must_use]
pub fn ranked_sites(mut sites: Vec<(String, String)>, text: &str) -> Vec<(String, String)> {
    sites.sort_by(|a, b| {
        could_contain(&b.1, text)
            .cmp(&could_contain(&a.1, text))
            .then_with(|| a.0.cmp(&b.0))
    });
    sites.truncate(MAX_RENDER_SITES);
    sites
}

#[must_use]
pub fn places_in(
    path: &str,
    source: &str,
    key: &Key,
    text: &str,
    component: Option<&str>,
) -> Vec<Place> {
    if text_source::is_json(path) {
        return text_source::json_places(source, key, text);
    }
    if template::is_template(path) {
        let mut places = text_source::in_script_blocks(path, source, key, text, None);
        if let Some(component) = component {
            places.extend(text_source::template_places(
                path, source, key, text, component,
            ));
        }
        return places;
    }
    text_source::js_places(path, source, key, text, component)
}

#[must_use]
pub fn text_places(path: &str, source: &str, places: Vec<Place>) -> Vec<TextPlace> {
    let index = LineIndex::new(source);
    places
        .into_iter()
        .filter_map(|place| {
            let (line, column) = index.position(place.start);
            Some(TextPlace {
                file: path.to_owned(),
                line: line.try_into().ok()?,
                column: column.try_into().ok()?,
                label: place.label,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use gjd_core::text_source::Key;

    use super::{
        could_contain, imports, is_locale, lookup, places_in, ranked_sites, resolve, shown_text,
        text_places,
    };

    const FILES: [&str; 10] = [
        "src/App.tsx",
        "src/data/tabs.ts",
        "src/components/Badge/index.tsx",
        "src/lib/nav.js",
        "src/i18n/en.json",
        "src/utils.ts",
        "app/composables/menu.ts",
        "src/lib/strings.ts",
        "src/pages/index.astro",
        "README.md",
    ];

    fn files() -> BTreeSet<&'static str> {
        FILES.into_iter().collect()
    }

    #[test]
    fn resolves_relative_index_alias_and_js_to_ts_specifiers() {
        let files = files();
        assert_eq!(
            resolve("src/App.tsx", "./data/tabs", &files).as_deref(),
            Some("src/data/tabs.ts")
        );
        assert_eq!(
            resolve("src/components/Badge/index.tsx", "../../utils.js", &files).as_deref(),
            Some("src/utils.ts")
        );
        assert_eq!(
            resolve("src/App.tsx", "./components/Badge", &files).as_deref(),
            Some("src/components/Badge/index.tsx")
        );
        assert_eq!(
            resolve("src/App.tsx", "@/lib/nav", &files).as_deref(),
            Some("src/lib/nav.js")
        );
        assert_eq!(
            resolve("app/app.vue", "~/composables/menu", &files).as_deref(),
            Some("app/composables/menu.ts")
        );
        assert_eq!(
            resolve("src/routes/+page.svelte", "$lib/strings", &files).as_deref(),
            Some("src/lib/strings.ts")
        );
        assert_eq!(
            resolve("src/App.tsx", "./i18n/en.json", &files).as_deref(),
            Some("src/i18n/en.json")
        );
        assert_eq!(resolve("src/App.tsx", "react", &files), None);
        assert_eq!(resolve("src/App.tsx", "../../../x", &files), None);
        assert_eq!(resolve("src/App.tsx", "../README.md", &files), None);
    }

    #[test]
    fn imports_come_from_modules_and_template_script_blocks() {
        assert_eq!(
            imports(
                "src/App.tsx",
                "import { TABS } from './data/tabs';\nexport const A = 1;\n"
            ),
            vec!["./data/tabs".to_owned()]
        );
        assert_eq!(
            imports(
                "src/A.vue",
                "<script setup lang=\"ts\">\nimport { MENU } from '@/data/menu';\n</script>\n<template><p /></template>\n"
            ),
            vec!["@/data/menu".to_owned()]
        );
        assert_eq!(
            imports(
                "src/pages/index.astro",
                "---\nimport Layout from '../layouts/Layout.astro';\n---\n<Layout />\n"
            ),
            vec!["../layouts/Layout.astro".to_owned()]
        );
        assert_eq!(imports("src/i18n/en.json", "{}"), Vec::<String>::new());
    }

    #[test]
    fn locale_files_are_in_locale_folders_or_named_for_a_language() {
        assert!(is_locale("src/i18n/en.json"));
        assert!(is_locale("public/locales/ko/common.json"));
        assert!(is_locale("messages/en-US.json"));
        assert!(is_locale("src/ko.json"));
        assert!(is_locale("lang/pt_BR.json"));
        assert!(!is_locale("package.json"));
        assert!(!is_locale("tsconfig.json"));
        assert!(!is_locale("src/data/tabs.json"));
        assert!(!is_locale("src/i18n/index.ts"));
    }

    #[test]
    fn looks_up_a_single_expression_and_its_component() {
        let source = "export function Dash({ activeTab }) {\n  return <h1 className=\"x\">{activeTab.title}</h1>;\n}\n";
        let found = lookup("src/Dash.tsx", source, 2, 10).expect("lookup");
        assert_eq!(found.key, Key::Prop("title".to_owned()));
        assert_eq!(found.code, "{activeTab.title}");
        assert_eq!(found.component.as_deref(), Some("Dash"));
        let mixed = "export const A = ({ n }) => <p>Hi {n}</p>;\n";
        assert_eq!(lookup("src/A.tsx", mixed, 1, 29), None);
        let vue = "<template>\n  <h1>{{ $t('nav.home') }}</h1>\n</template>\n";
        let found = lookup("src/components/NavBar.vue", vue, 2, 3).expect("lookup");
        assert_eq!(found.key, Key::Translation("nav.home".to_owned()));
        assert_eq!(found.component, None);
        let badge = "<template>\n  <span><slot /></span>\n  <b>{{ title }}</b>\n</template>\n";
        let found = lookup("src/components/Badge.vue", badge, 3, 3).expect("lookup");
        assert_eq!(found.component.as_deref(), Some("Badge"));
    }

    #[test]
    fn places_cover_modules_templates_and_json_with_positions() {
        let vue = "<script setup>\nconst tabs = [{ title: 'Home' }];\n</script>\n<template>\n  <Badge title=\"Home\" />\n</template>\n";
        let places = places_in(
            "src/App.vue",
            vue,
            &Key::Prop("title".to_owned()),
            "Home",
            Some("Badge"),
        );
        let positions = text_places("src/App.vue", vue, places);
        assert_eq!(
            positions
                .iter()
                .map(|place| (place.label.as_str(), place.line.get(), place.column.get()))
                .collect::<Vec<_>>(),
            vec![("tabs", 2, 24), ("<Badge title>", 5, 16)]
        );
        let json = "{\n  \"nav\": { \"home\": \"Home\" }\n}\n";
        let places = places_in(
            "src/i18n/en.json",
            json,
            &Key::Translation("nav.home".to_owned()),
            "Home",
            None,
        );
        assert_eq!(
            text_places("src/i18n/en.json", json, places)[0].line.get(),
            2
        );
    }

    #[test]
    fn shown_text_is_collapsed_and_prefilter_uses_the_longest_word() {
        assert_eq!(
            shown_text("  CBPLD\n   Overview ").as_deref(),
            Some("CBPLD Overview")
        );
        assert_eq!(shown_text(" \n "), None);
        assert!(could_contain("title: 'Today\\'s menu'", "Today's menu"));
        assert!(!could_contain("title: 'Home'", "Overview"));
        assert!(could_contain("anything", "!!"));
        assert!(could_contain("{ t: '오늘의 추천' }", "오늘의 추천"));
    }

    #[test]
    fn render_sites_that_contain_the_text_come_first() {
        let site = |path: &str, content: &str| (path.to_owned(), content.to_owned());
        let sites = vec![
            site("src/a.tsx", "<Button>Cancel</Button>"),
            site("src/b.tsx", "<Button>Close</Button>"),
            site("src/c.tsx", "<Button>Back</Button>"),
            site("src/z.tsx", "<Button>Save draft</Button>"),
            site("src/y.tsx", "<Button>Save</Button>"),
        ];
        let paths: Vec<String> = ranked_sites(sites, "Save")
            .into_iter()
            .map(|(path, _)| path)
            .collect();
        assert_eq!(paths, vec!["src/y.tsx", "src/z.tsx", "src/a.tsx"]);
    }
}
