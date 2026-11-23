use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::ops::Range;

use gjd_core::content_hash;
use gjd_core::jsx;

use crate::references::is_test_or_story;

pub const MAX_FILES: usize = 5;
pub const MAX_RENDER_SITES: usize = 2;
const WHOLE_FILE_LINES: usize = 400;
const WINDOW: usize = 60;
const BUDGET: usize = 64 * 1024;
const IMPORT_SCAN_LINES: usize = 80;
const JSX_EXTENSIONS: [&str; 3] = ["tsx", "jsx", "js"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelatedFile {
    pub path: String,
    pub content: String,
    pub anchors: Vec<u64>,
    pub why: String,
    pub selected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderSite {
    pub path: String,
    pub content: String,
    pub lines: Vec<u64>,
}

#[must_use]
pub fn is_jsx_file(path: &str) -> bool {
    path.rsplit_once('.')
        .is_some_and(|(_, extension)| JSX_EXTENSIONS.contains(&extension))
}

#[must_use]
pub fn candidates(files: &[String]) -> Vec<&str> {
    files
        .iter()
        .map(String::as_str)
        .filter(|file| is_jsx_file(file) && !is_test_or_story(file))
        .collect()
}

#[must_use]
pub fn render_lines(path: &str, content: &str, name: &str) -> Vec<u64> {
    if !content.contains(&format!("<{name}")) {
        return Vec::new();
    }
    jsx::usages(path, content, name)
        .unwrap_or_default()
        .into_iter()
        .map(|(line, _)| line)
        .collect()
}

#[must_use]
pub fn ranked(
    mut sites: Vec<RenderSite>,
    on_page: &BTreeSet<String>,
    limit: usize,
) -> Vec<RenderSite> {
    sites.sort_by(|a, b| {
        on_page
            .contains(&b.path)
            .cmp(&on_page.contains(&a.path))
            .then_with(|| a.path.cmp(&b.path))
    });
    sites.truncate(limit);
    sites
}

#[must_use]
pub fn component_name(path: &str) -> Option<&str> {
    if !is_jsx_file(path) {
        return None;
    }
    let name = path.rsplit('/').next()?.split_once('.')?.0;
    let mut chars = name.chars();
    (chars.next()?.is_ascii_uppercase() && chars.all(|c| c.is_ascii_alphanumeric())).then_some(name)
}

pub fn add(related: &mut Vec<RelatedFile>, file: RelatedFile) {
    if let Some(existing) = related.iter_mut().find(|other| other.path == file.path) {
        existing.anchors.extend(file.anchors);
        existing.anchors.sort_unstable();
        existing.anchors.dedup();
        existing.selected |= file.selected;
        return;
    }
    if file.selected || related.iter().filter(|other| !other.selected).count() < MAX_FILES {
        related.push(file);
    }
}

fn imports_end(lines: &[&str]) -> Option<usize> {
    lines.iter().take(IMPORT_SCAN_LINES).rposition(|text| {
        let text = text.trim_start();
        text.starts_with("import ") || text.contains(" from '") || text.contains(" from \"")
    })
}

fn shown(lines: &[&str], anchors: &[u64]) -> Vec<Range<usize>> {
    let total = lines.len();
    if total <= WHOLE_FILE_LINES || anchors.is_empty() {
        let whole = 0..total.min(WHOLE_FILE_LINES);
        return vec![whole];
    }
    let mut ranges: Vec<Range<usize>> = imports_end(lines)
        .map(|end| 0..end + 1)
        .into_iter()
        .chain(anchors.iter().filter_map(|anchor| {
            let at = usize::try_from(*anchor).ok()?.checked_sub(1)?;
            Some(at.saturating_sub(WINDOW)..(at + WINDOW + 1).min(total))
        }))
        .collect();
    ranges.sort_by_key(|range| range.start);
    let mut merged: Vec<Range<usize>> = Vec::new();
    for range in ranges {
        match merged.last_mut() {
            Some(last) if range.start <= last.end => last.end = last.end.max(range.end),
            _ => merged.push(range),
        }
    }
    merged
}

#[must_use]
pub fn shows_whole(file: &RelatedFile) -> bool {
    file.content.split('\n').count() <= WHOLE_FILE_LINES
}

fn block(file: &RelatedFile) -> String {
    let lines: Vec<&str> = file
        .content
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let ranges = shown(&lines, &file.anchors);
    let label: Vec<String> = ranges
        .iter()
        .map(|range| format!("{}-{}", range.start + 1, range.end))
        .collect();
    let whole = if shows_whole(file) {
        " whole=\"true\""
    } else {
        ""
    };
    let mut out = format!(
        "\n<file path=\"{}\" base_hash=\"{}\" lines=\"{}\" why=\"{}\"{whole}>\n",
        file.path,
        content_hash(file.content.as_bytes()).as_str(),
        label.join(","),
        file.why
    );
    let mut previous_end = 0;
    for range in &ranges {
        if range.start > previous_end {
            let _ = writeln!(
                out,
                "     … lines {}-{} not shown",
                previous_end + 1,
                range.start
            );
        }
        for (number, text) in lines.iter().enumerate().take(range.end).skip(range.start) {
            let _ = writeln!(out, "{:>4} | {text}", number + 1);
        }
        previous_end = range.end;
    }
    out.push_str("</file>\n");
    out
}

fn rendered_blocks(related: &[RelatedFile]) -> Vec<(&RelatedFile, String)> {
    let mut shown: Vec<(&RelatedFile, String)> = Vec::new();
    let mut size = 0;
    for file in related.iter().filter(|file| file.selected) {
        let block = block(file);
        size += block.len();
        shown.push((file, block));
    }
    for file in related.iter().filter(|file| !file.selected) {
        let block = block(file);
        if size > 0 && size + block.len() > BUDGET {
            break;
        }
        size += block.len();
        shown.push((file, block));
    }
    shown
}

#[must_use]
pub fn render(related: &[RelatedFile]) -> String {
    rendered_blocks(related)
        .into_iter()
        .map(|(_, block)| block)
        .collect()
}

#[must_use]
pub fn shown_whole(related: &[RelatedFile]) -> Vec<&str> {
    rendered_blocks(related)
        .into_iter()
        .filter(|(file, _)| shows_whole(file))
        .map(|(file, _)| file.path.as_str())
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::fmt::Write as _;

    use gjd_core::content_hash;

    use super::{
        MAX_FILES, RelatedFile, RenderSite, add, candidates, component_name, ranked, render,
        render_lines,
    };

    fn related(path: &str, content: &str, anchors: &[u64], why: &str) -> RelatedFile {
        RelatedFile {
            path: path.to_owned(),
            content: content.to_owned(),
            anchors: anchors.to_vec(),
            why: why.to_owned(),
            selected: false,
        }
    }

    #[test]
    fn looks_for_render_sites_only_in_jsx_sources_outside_tests_and_stories() {
        let files: Vec<String> = [
            "src/App.tsx",
            "src/main.jsx",
            "src/legacy.js",
            "src/lib/cn.ts",
            "src/index.css",
            "src/components/__tests__/Card.tsx",
            "src/components/Card.test.tsx",
            "src/components/Card.stories.tsx",
            "src/components/Card.tsx",
        ]
        .map(str::to_owned)
        .to_vec();

        assert_eq!(
            candidates(&files),
            [
                "src/App.tsx",
                "src/main.jsx",
                "src/legacy.js",
                "src/components/Card.tsx"
            ]
        );
    }

    #[test]
    fn finds_the_lines_that_render_a_component_and_skips_lookalikes() {
        let app = "import { Card } from './Card';\nexport const App = () => (\n  <main>\n    <Card />\n    <CardList />\n  </main>\n);\n";

        assert_eq!(render_lines("src/App.tsx", app, "Card"), [4]);
        assert_eq!(render_lines("src/App.tsx", app, "Badge"), Vec::<u64>::new());
        assert_eq!(
            render_lines("src/App.tsx", "const a = <Card", "Card"),
            Vec::<u64>::new()
        );
    }

    #[test]
    fn ranks_render_sites_on_the_page_first_and_keeps_a_few() {
        let site = |path: &str| RenderSite {
            path: path.to_owned(),
            content: String::new(),
            lines: vec![1],
        };
        let on_page = BTreeSet::from(["src/layout/Shell.tsx".to_owned()]);

        let kept = ranked(
            vec![
                site("src/a/Other.tsx"),
                site("src/layout/Shell.tsx"),
                site("src/b/Third.tsx"),
            ],
            &on_page,
            2,
        );

        let paths: Vec<&str> = kept.iter().map(|site| site.path.as_str()).collect();
        assert_eq!(paths, ["src/layout/Shell.tsx", "src/a/Other.tsx"]);
    }

    #[test]
    fn names_components_by_their_pascal_case_file() {
        assert_eq!(
            component_name("src/features/EmployeeDashboard.tsx"),
            Some("EmployeeDashboard")
        );
        assert_eq!(component_name("src/routes/index.tsx"), None);
        assert_eq!(component_name("src/lib/Theme.ts"), None);
        assert_eq!(component_name("src/App.vue"), None);
    }

    #[test]
    fn merges_a_file_found_twice_and_stops_at_the_limit() {
        let mut found = Vec::new();
        add(
            &mut found,
            related("src/App.tsx", "a", &[12], "renders Card"),
        );
        add(
            &mut found,
            related("src/App.tsx", "a", &[4, 12], "named in the request"),
        );
        for index in 0..10 {
            add(
                &mut found,
                related(&format!("src/F{index}.tsx"), "x", &[], "named"),
            );
        }

        assert_eq!(found.len(), MAX_FILES);
        assert_eq!(found[0].anchors, [4, 12]);
        assert_eq!(found[0].why, "renders Card");
    }

    #[test]
    fn reports_which_files_were_shown_whole_within_the_budget() {
        let short = related(
            "src/App.tsx",
            "export const App = () => <main />;\n",
            &[1],
            "renders Card",
        );
        let long_text = "x\n".repeat(500);
        let long = related("src/Long.tsx", &long_text, &[250], "named in the request");
        let big_text = "y\n".repeat(390) + &"z".repeat(70 * 1024);
        let big = related("src/Big.tsx", &big_text, &[2], "named in the request");

        let files = [short, long, big];

        assert_eq!(super::shown_whole(&files), ["src/App.tsx"]);
    }

    #[test]
    fn shows_a_short_file_whole_with_its_hash_and_why() {
        let content = "import { Card } from './Card';\n\nexport const App = () => <Card />;\n";

        let text = render(&[related("src/App.tsx", content, &[3], "renders Card")]);

        assert!(text.starts_with(&format!(
            "\n<file path=\"src/App.tsx\" base_hash=\"{}\" lines=\"1-4\" why=\"renders Card\" whole=\"true\">\n",
            content_hash(content.as_bytes()).as_str()
        )));
        assert!(text.contains("   3 | export const App = () => <Card />;\n"));
        assert!(text.ends_with("   4 | \n</file>\n"));
    }

    #[test]
    fn shows_the_imports_and_a_window_around_each_anchor_of_a_long_file() {
        let mut content =
            String::from("import { Card } from './Card';\nimport { cn } from './cn';\n");
        for line in 3..=1000 {
            let _ = writeln!(content, "const line{line} = {line};");
        }

        let text = render(&[related(
            "src/Long.tsx",
            &content,
            &[500, 520, 900],
            "renders Card",
        )]);

        assert!(text.contains("lines=\"1-2,440-580,840-960\""), "{text}");
        assert!(
            text.contains(
                "   2 | import { cn } from './cn';\n     … lines 3-439 not shown\n 440 | "
            )
        );
        assert!(text.contains(" 580 | const line580 = 580;\n     … lines 581-839 not shown\n"));
        assert!(!text.contains("const line961"));
    }

    #[test]
    fn shows_the_first_lines_of_a_long_file_without_anchors() {
        let mut content = String::new();
        for line in 1..=900 {
            let _ = writeln!(content, "const line{line} = {line};");
        }

        let text = render(&[related(
            "src/Named.tsx",
            &content,
            &[],
            "named in the request",
        )]);

        assert!(text.contains("lines=\"1-400\""));
        assert!(!text.contains("const line401 "));
    }

    #[test]
    fn stops_adding_files_past_the_budget_but_always_shows_the_first() {
        let big = "x\n".repeat(399).replace('x', &"y".repeat(100));
        let files = [
            related("src/A.tsx", &big, &[], "renders Card"),
            related("src/B.tsx", &big, &[], "named in the request"),
        ];

        let text = render(&files);

        assert!(text.contains("path=\"src/A.tsx\""));
        assert!(!text.contains("path=\"src/B.tsx\""));
    }

    fn picked(path: &str, content: &str, line: u64) -> RelatedFile {
        RelatedFile {
            selected: true,
            ..related(path, content, &[line], "selected too")
        }
    }

    #[test]
    fn keeps_every_selected_file_on_top_of_the_limit() {
        let mut found = Vec::new();
        for index in 0..4 {
            add(&mut found, picked(&format!("src/S{index}.tsx"), "s", 3));
        }
        for index in 0..10 {
            add(
                &mut found,
                related(&format!("src/F{index}.tsx"), "x", &[], "named"),
            );
        }
        add(&mut found, related("src/S0.tsx", "s", &[9], "renders Card"));

        assert_eq!(found.len(), 4 + MAX_FILES);
        assert!(found[..4].iter().all(|file| file.selected));
        assert_eq!(found[0].anchors, [3, 9]);
        assert_eq!(found[0].why, "selected too");
    }

    #[test]
    fn shows_selected_files_first_and_whatever_the_budget() {
        let big = "x\n".repeat(399).replace('x', &"y".repeat(100));
        let files = [
            related("src/A.tsx", &big, &[], "renders Card"),
            picked("src/B.tsx", &big, 2),
            picked("src/C.tsx", &big, 2),
        ];

        let text = render(&files);

        let b = text.find("path=\"src/B.tsx\"");
        let c = text.find("path=\"src/C.tsx\"");
        assert!(b.is_some() && c.is_some());
        assert!(b < c);
        assert!(!text.contains("path=\"src/A.tsx\""));
    }
}
