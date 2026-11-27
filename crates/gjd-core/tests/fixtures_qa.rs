use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::num::NonZeroU64;
use std::path::PathBuf;

use gjd_core::codemod::finetune_ops;
use gjd_core::content_hash;
use gjd_core::contracts::FinetuneProps;
use gjd_core::journal::{CommitError, EntryMeta, FileChange, Journal};
use gjd_core::patch::{self, Dialect};
use gjd_core::policy::ProjectRoot;
use gjd_core::style::{Styling, inspect_with};
use gjd_core::theme::Theme;

struct Fixture {
    name: &'static str,
    dir: &'static str,
    button: &'static str,
    css: &'static str,
    gift: Option<&'static str>,
    solid: bool,
}

const FIXTURES: &[Fixture] = &[
    Fixture {
        name: "react",
        dir: "small-react-tailwind4",
        button: "src/components/OrderButton.tsx",
        css: "src/index.css",
        gift: Some("src/App.tsx"),
        solid: false,
    },
    Fixture {
        name: "preact",
        dir: "small-preact-tailwind4",
        button: "src/components/OrderButton.tsx",
        css: "src/index.css",
        gift: Some("src/App.tsx"),
        solid: false,
    },
    Fixture {
        name: "solid",
        dir: "small-solid-tailwind4",
        button: "src/components/OrderButton.tsx",
        css: "src/index.css",
        gift: Some("src/App.tsx"),
        solid: true,
    },
    Fixture {
        name: "solidstart",
        dir: "node24/small-solidstart-tailwind4",
        button: "src/components/OrderButton.tsx",
        css: "src/app.css",
        gift: Some("src/routes/index.tsx"),
        solid: true,
    },
    Fixture {
        name: "next",
        dir: "small-next-tailwind4",
        button: "app/components/OrderButton.tsx",
        css: "app/globals.css",
        gift: Some("app/page.tsx"),
        solid: false,
    },
    Fixture {
        name: "react-router",
        dir: "small-react-router-tailwind4",
        button: "app/components/OrderButton.tsx",
        css: "app/app.css",
        gift: Some("app/routes/home.tsx"),
        solid: false,
    },
    Fixture {
        name: "vue",
        dir: "small-vue-tailwind4",
        button: "src/components/OrderButton.vue",
        css: "src/index.css",
        gift: Some("src/App.vue"),
        solid: false,
    },
    Fixture {
        name: "nuxt",
        dir: "small-nuxt-tailwind4",
        button: "app/components/OrderButton.vue",
        css: "app/assets/css/main.css",
        gift: None,
        solid: false,
    },
    Fixture {
        name: "sveltekit",
        dir: "small-sveltekit-tailwind4",
        button: "src/lib/OrderButton.svelte",
        css: "src/app.css",
        gift: Some("src/routes/+page.svelte"),
        solid: false,
    },
    Fixture {
        name: "astro",
        dir: "small-astro-tailwind4",
        button: "src/components/OrderButton.astro",
        css: "src/styles/global.css",
        gift: Some("src/pages/index.astro"),
        solid: false,
    },
];

const BUTTON: &str = "rounded-lg bg-brand px-6 py-3 font-medium text-white";

const GROUPS: &[(&str, &str, &str)] = &[
    (
        "one padding side",
        r#"{"layout":{"padding":{"top":16}}}"#,
        "rounded-lg bg-brand px-6 pt-4 pb-3 font-medium text-white",
    ),
    (
        "equal padding",
        r#"{"layout":{"padding":{"top":16,"right":16,"bottom":16,"left":16}}}"#,
        "rounded-lg bg-brand p-4 font-medium text-white",
    ),
    (
        "text size keeps the text colour",
        r#"{"text":{"size":18}}"#,
        "rounded-lg bg-brand px-6 py-3 font-medium text-white text-lg",
    ),
    (
        "weight",
        r#"{"text":{"weight":700}}"#,
        "rounded-lg bg-brand px-6 py-3 font-bold text-white",
    ),
    (
        "stroke",
        r#"{"stroke":{"kind":"set","width":2,"style":"dashed","color":{"kind":"token","name":"brand"}}}"#,
        "rounded-lg bg-brand px-6 py-3 font-medium text-white border-2 border-dashed border-brand",
    ),
    (
        "drop shadow preset",
        r#"{"effects":{"drop":{"kind":"token","name":"md"}}}"#,
        "rounded-lg bg-brand px-6 py-3 font-medium text-white shadow-md",
    ),
    (
        "opacity",
        r#"{"opacity":50}"#,
        "rounded-lg bg-brand px-6 py-3 font-medium text-white opacity-50",
    ),
];

fn root(fixture: &Fixture) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures")
        .join(fixture.dir)
}

fn read(fixture: &Fixture, path: &str) -> String {
    fs::read_to_string(root(fixture).join(path))
        .unwrap_or_else(|error| panic!("{}: {path}: {error}", fixture.name))
}

fn theme(fixture: &Fixture) -> Theme {
    Theme::from_css([read(fixture, fixture.css).as_str()])
}

fn position(source: &str, offset: usize) -> (NonZeroU64, NonZeroU64) {
    let line = source[..offset].matches('\n').count() + 1;
    let column = offset - source[..offset].rfind('\n').map_or(0, |at| at + 1) + 1;
    let at = |value: usize| NonZeroU64::new(u64::try_from(value).expect("fits")).expect("1-based");
    (at(line), at(column))
}

fn tuned(
    fixture: &Fixture,
    path: &str,
    source: &str,
    offset: usize,
    props: &str,
) -> Result<String, String> {
    let theme = theme(fixture);
    let (line, column) = position(source, offset);
    let style = inspect_with(path, source, line, column, &theme, Styling::TAILWIND)
        .map_err(|error| format!("inspect: {error}"))?;
    let props: FinetuneProps =
        serde_json::from_str(props).map_err(|error| format!("props: {error}"))?;
    let ops = finetune_ops(&style, &props, &theme).map_err(|error| format!("codemod: {error}"))?;
    let sources = BTreeMap::from([(path.to_owned(), source.to_owned())]);
    let mut written = patch::apply_with(
        &sources,
        &ops,
        Dialect {
            solid: fixture.solid,
        },
    )
    .map_err(|error| format!("patch: {error}"))?;
    written
        .remove(path)
        .ok_or_else(|| "file missing".to_owned())
}

fn button_at(source: &str) -> usize {
    source.find("<button").expect("a button")
}

fn gift_at(source: &str) -> usize {
    let color = source.find("fde68a").expect("the gift paragraph");
    source[..color].rfind("<p").expect("its <p")
}

fn classes_at(source: &str, offset: usize) -> BTreeSet<String> {
    let rest = &source[offset..];
    let start = ["className=\"", "class=\""]
        .iter()
        .filter_map(|attribute| rest.find(attribute).map(|at| at + attribute.len()))
        .min()
        .expect("a class attribute");
    let end = start + rest[start..].find('"').expect("closing quote");
    rest[start..end]
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

fn set(classes: &str) -> BTreeSet<String> {
    classes.split_whitespace().map(str::to_owned).collect()
}

#[test]
fn every_fixture_button_starts_from_the_same_classes() {
    for fixture in FIXTURES {
        let source = read(fixture, fixture.button);
        assert_eq!(
            classes_at(&source, button_at(&source)),
            set(BUTTON),
            "{}",
            fixture.name
        );
    }
}

#[test]
fn every_framework_writes_the_same_classes_for_each_new_group() {
    let mut failures = Vec::new();
    for fixture in FIXTURES {
        let source = read(fixture, fixture.button);
        for (name, props, expected) in GROUPS {
            match tuned(fixture, fixture.button, &source, button_at(&source), props) {
                Ok(written) => {
                    let got = classes_at(&written, button_at(&written));
                    if got != set(expected) {
                        failures.push(format!("{} / {name}: {got:?}", fixture.name));
                    }
                    let outside: Vec<&str> = written
                        .lines()
                        .zip(source.lines())
                        .filter(|(a, b)| a != b)
                        .map(|(a, _)| a)
                        .collect();
                    if outside.len() != 1 {
                        failures.push(format!(
                            "{} / {name}: {} lines changed",
                            fixture.name,
                            outside.len()
                        ));
                    }
                }
                Err(error) => failures.push(format!("{} / {name}: {error}", fixture.name)),
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn every_framework_with_a_flex_wrapper_writes_one_gap_axis() {
    let mut checked = 0;
    for fixture in FIXTURES {
        let source = read(fixture, fixture.button);
        let Some(wrapper) = source.find("<div class=\"flex items-center gap-4\"") else {
            continue;
        };
        checked += 1;
        let written = tuned(
            fixture,
            fixture.button,
            &source,
            wrapper,
            r#"{"layout":{"gap":{"column":8}}}"#,
        )
        .unwrap_or_else(|error| panic!("{}: {error}", fixture.name));
        assert_eq!(
            classes_at(&written, wrapper),
            set("flex items-center gap-x-2 gap-y-4"),
            "{}",
            fixture.name
        );
    }
    assert!(
        checked >= 3,
        "only {checked} fixtures have the flex wrapper"
    );
}

#[test]
fn every_framework_pastes_onto_an_inline_style_with_a_theme_fallback() {
    let paste = r#"{"fill":{"kind":"token","name":"brand"},"layout":{"padding":{"top":12,"right":24,"bottom":12,"left":24}}}"#;
    let mut failures = Vec::new();
    for fixture in FIXTURES {
        let Some(gift) = fixture.gift else { continue };
        let source = read(fixture, gift);
        match tuned(fixture, gift, &source, gift_at(&source), paste) {
            Ok(written) => {
                for expected in ["var(--color-brand, #BE123C)", "12px 24px"] {
                    if !written.contains(expected) {
                        failures.push(format!("{}: no {expected}", fixture.name));
                    }
                }
                if written.contains("fde68a") {
                    failures.push(format!("{}: the old fill is still there", fixture.name));
                }
                if written
                    .lines()
                    .zip(source.lines())
                    .filter(|(a, b)| a != b)
                    .count()
                    != 1
                {
                    failures.push(format!("{}: more than the gift line changed", fixture.name));
                }
            }
            Err(error) => failures.push(format!("{}: {error}", fixture.name)),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn every_framework_file_undoes_an_older_change_and_keeps_a_newer_one() {
    let mut failures = Vec::new();
    for fixture in FIXTURES {
        if let Err(error) = history_round_trip(fixture) {
            failures.push(format!("{}: {error}", fixture.name));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn history_round_trip(fixture: &Fixture) -> Result<(), String> {
    let original = read(fixture, fixture.button);
    let dir = tempfile::tempdir().map_err(|error| error.to_string())?;
    let file = dir.path().join(fixture.button);
    fs::create_dir_all(file.parent().expect("parent")).map_err(|error| error.to_string())?;
    fs::write(&file, &original).map_err(|error| error.to_string())?;
    let journal = Journal::open(ProjectRoot::new(dir.path()).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let commit = |from: &str, to: &str, name: &str| {
        journal
            .commit_with(
                &[FileChange::edit(
                    fixture.button,
                    content_hash(from.as_bytes()),
                    to,
                )],
                "finetune",
                name,
                EntryMeta::default(),
            )
            .map_err(|error| format!("commit {name}: {error}"))
    };
    let on_disk = || fs::read_to_string(&file).unwrap_or_default();

    let with_padding = tuned(
        fixture,
        fixture.button,
        &original,
        button_at(&original),
        r#"{"layout":{"padding":{"top":16}}}"#,
    )?;
    let padding_id = commit(&original, &with_padding, "padding")?;
    let with_text = with_padding.replacen("Order now", "Order today", 1);
    let text_id = commit(&with_padding, &with_text, "text")?;

    journal
        .flip(&padding_id, false)
        .map_err(|error| format!("undo padding: {error}"))?;
    if on_disk() != original.replacen("Order now", "Order today", 1) {
        return Err(format!(
            "undo of the older change lost the newer one:\n{}",
            on_disk()
        ));
    }
    journal
        .flip(&padding_id, true)
        .map_err(|error| format!("redo padding: {error}"))?;
    if on_disk() != with_text {
        return Err("redo did not bring the padding back".to_owned());
    }
    let with_fill = tuned(
        fixture,
        fixture.button,
        &with_text,
        button_at(&with_text),
        r##"{"fill":{"kind":"hex","hex":"#1D4ED8","opacity":100}}"##,
    )?;
    let fill_id = commit(&with_text, &with_fill, "fill")?;
    if !matches!(
        journal.flip(&padding_id, false),
        Err(CommitError::Overlap { .. })
    ) {
        return Err("a fill on the same line did not block undoing the padding".to_owned());
    }
    for id in [&fill_id, &text_id, &padding_id] {
        journal
            .flip(id, false)
            .map_err(|error| format!("undo {id}: {error}"))?;
    }
    if on_disk() != original {
        return Err("undoing everything did not restore the exact bytes".to_owned());
    }
    Ok(())
}
