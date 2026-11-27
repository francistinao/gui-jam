use std::collections::{BTreeMap, BTreeSet};
use std::num::NonZeroU64;

use gjd_core::codemod::{CodemodError, finetune_ops};
use gjd_core::contracts::FinetuneProps;
use gjd_core::patch;
use gjd_core::style::inspect;
use gjd_core::theme::Theme;

const FILE: &str = "src/B.tsx";

fn theme() -> Theme {
    Theme::from_css([
        "@import \"tailwindcss\";\n@theme { --color-brand: #be123c; --font-display: \"Fraunces\", serif; }",
    ])
}

fn tuned(source: &str, props: &str) -> String {
    let at = |value: usize| NonZeroU64::new(value as u64).expect("1-based");
    let theme = theme();
    let column = source.find('<').expect("an element") + 1;
    let style = inspect(FILE, source, at(1), at(column), &theme).expect("inspected");
    let props: FinetuneProps = serde_json::from_str(props).expect("valid props");
    let ops = finetune_ops(&style, &props, &theme).expect("ops");
    let sources = BTreeMap::from([(FILE.to_owned(), source.to_owned())]);
    patch::apply(&sources, &ops)
        .expect("applied")
        .remove(FILE)
        .expect("same file")
}

fn element(classes: &str) -> String {
    format!(r#"export const B = () => <div className="{classes}">Go</div>;"#)
}

fn classes(source: &str) -> BTreeSet<String> {
    let start = source.find("className=\"").expect("className") + "className=\"".len();
    let end = start + source[start..].find('"').expect("closing quote");
    source[start..end]
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

fn set(classes: &str) -> BTreeSet<String> {
    classes.split_whitespace().map(str::to_owned).collect()
}

const CLASS_CASES: &[(&str, &str, &str, &str)] = &[
    (
        "padding one side keeps the other axis",
        "px-6 py-3",
        r#"{"layout":{"padding":{"top":16}}}"#,
        "px-6 pt-4 pb-3",
    ),
    (
        "padding all sides equal collapses to p",
        "px-6 py-3",
        r#"{"layout":{"padding":{"top":16,"right":16,"bottom":16,"left":16}}}"#,
        "p-4",
    ),
    (
        "padding equal vertical sides become py",
        "px-6 py-3",
        r#"{"layout":{"padding":{"top":16,"bottom":16}}}"#,
        "px-6 py-4",
    ),
    (
        "padding between scale steps is arbitrary",
        "px-6 py-3",
        r#"{"layout":{"padding":{"left":13}}}"#,
        "py-3 pr-6 pl-[13px]",
    ),
    (
        "padding off the quarter scale is arbitrary",
        "px-6 py-3",
        r#"{"layout":{"padding":{"top":12.5}}}"#,
        "px-6 pt-[12.5px] pb-3",
    ),
    (
        "padding zero is written",
        "px-6 py-3",
        r#"{"layout":{"padding":{"top":0}}}"#,
        "px-6 pt-0 pb-3",
    ),
    (
        "padding leaves responsive variants alone",
        "md:p-8 px-6 py-3",
        r#"{"layout":{"padding":{"top":16}}}"#,
        "md:p-8 px-6 pt-4 pb-3",
    ),
    (
        "padding keeps an unreadable token",
        "p-[var(--pad)]",
        r#"{"layout":{"padding":{"top":16}}}"#,
        "p-[var(--pad)] pt-4",
    ),
    (
        "gap one axis splits gap",
        "flex gap-4",
        r#"{"layout":{"gap":{"column":8}}}"#,
        "flex gap-x-2 gap-y-4",
    ),
    (
        "gap both axes equal collapse",
        "flex gap-4",
        r#"{"layout":{"gap":{"row":8,"column":8}}}"#,
        "flex gap-2",
    ),
    (
        "gap axes merge back into gap",
        "grid gap-x-2 gap-y-2",
        r#"{"layout":{"gap":{"row":16,"column":16}}}"#,
        "grid gap-4",
    ),
    (
        "text size uses the theme scale",
        "text-sm font-medium text-white",
        r#"{"text":{"size":18}}"#,
        "text-lg font-medium text-white",
    ),
    (
        "text size off the scale is arbitrary",
        "text-sm font-medium text-white",
        r#"{"text":{"size":15}}"#,
        "text-[15px] font-medium text-white",
    ),
    (
        "text color keeps the size",
        "text-sm font-medium text-white",
        r#"{"text":{"color":{"kind":"token","name":"brand"}}}"#,
        "text-sm font-medium text-brand",
    ),
    (
        "text align adds alignment only",
        "text-sm text-white",
        r#"{"text":{"align":"center"}}"#,
        "text-sm text-white text-center",
    ),
    (
        "text size keeps a line height modifier",
        "text-sm/6 text-white",
        r#"{"text":{"size":18}}"#,
        "text-lg/6 text-white",
    ),
    (
        "text size never removes an unclassifiable token",
        "text-[var(--fs)] text-sm",
        r#"{"text":{"size":18}}"#,
        "text-[var(--fs)] text-lg",
    ),
    (
        "text weight on the scale is named",
        "font-medium",
        r#"{"text":{"weight":600}}"#,
        "font-semibold",
    ),
    (
        "text weight off the scale is arbitrary",
        "font-medium",
        r#"{"text":{"weight":650}}"#,
        "font-[650]",
    ),
    (
        "letter spacing float noise is rounded",
        "text-sm",
        r#"{"text":{"letterSpacing":0.30000000000000004}}"#,
        "text-sm tracking-[0.3em]",
    ),
    (
        "line height on the spacing scale",
        "text-sm",
        r#"{"text":{"lineHeight":24}}"#,
        "text-sm leading-6",
    ),
    (
        "font family from the theme",
        "font-sans",
        r#"{"text":{"family":"display"}}"#,
        "font-display",
    ),
    (
        "stroke set writes width style and color",
        "rounded-lg",
        r#"{"stroke":{"kind":"set","width":2,"style":"dashed","color":{"kind":"token","name":"brand"}}}"#,
        "rounded-lg border-2 border-dashed border-brand",
    ),
    (
        "stroke width replaces bare border",
        "border border-white",
        r#"{"stroke":{"kind":"set","width":2}}"#,
        "border-2 border-white",
    ),
    (
        "stroke none removes every stroke token",
        "rounded-lg border-2 border-dashed border-brand",
        r#"{"stroke":{"kind":"none"}}"#,
        "rounded-lg",
    ),
    (
        "drop shadow preset",
        "rounded-lg",
        r#"{"effects":{"drop":{"kind":"token","name":"md"}}}"#,
        "rounded-lg shadow-md",
    ),
    (
        "effects without inner removes the inner shadow",
        "shadow-md inset-shadow-sm",
        r#"{"effects":{"drop":{"kind":"token","name":"lg"}}}"#,
        "shadow-lg",
    ),
    (
        "opacity on the scale",
        "rounded-lg",
        r#"{"opacity":37}"#,
        "rounded-lg opacity-37",
    ),
    (
        "opacity zero is written",
        "rounded-lg",
        r#"{"opacity":0}"#,
        "rounded-lg opacity-0",
    ),
    (
        "opacity 100 removes the utility",
        "rounded-lg opacity-50",
        r#"{"opacity":100}"#,
        "rounded-lg",
    ),
];

#[test]
fn writes_the_shortest_valid_classes_for_each_group() {
    let failures: Vec<String> = CLASS_CASES
        .iter()
        .filter_map(|(name, base, props, expected)| {
            let got = classes(&tuned(&element(base), props));
            (got != set(expected)).then(|| format!("{name}: expected {expected:?}, got {got:?}"))
        })
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn applying_the_same_tweak_twice_changes_nothing_the_second_time() {
    let failures: Vec<String> = CLASS_CASES
        .iter()
        .filter_map(|(name, base, props, _)| {
            let once = tuned(&element(base), props);
            let twice = tuned(&once, props);
            (once != twice).then(|| format!("{name}: {once} became {twice}"))
        })
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn a_custom_shadow_is_one_class_with_no_spaces() {
    let written = classes(&tuned(
        &element("rounded-lg"),
        r##"{"effects":{"drop":{"kind":"custom","x":0,"y":6,"blur":16,"spread":-4,"hex":"#000000","opacity":22}}}"##,
    ));
    let shadows: Vec<&String> = written
        .iter()
        .filter(|token| token.starts_with("shadow-["))
        .collect();
    assert_eq!(shadows.len(), 1, "{written:?}");
    assert!(
        shadows[0].contains("6px") && shadows[0].contains("16px") && shadows[0].contains("-4px")
    );
}

#[test]
fn padding_left_replaces_a_logical_start_token_instead_of_fighting_it() {
    let written = classes(&tuned(
        &element("ps-4 pe-4 py-3"),
        r#"{"layout":{"padding":{"left":8}}}"#,
    ));
    assert!(written.contains("pl-2"), "{written:?}");
    assert!(!written.contains("ps-4"), "{written:?}");
    assert!(
        written.contains("pe-4") || written.contains("pr-4"),
        "{written:?}"
    );
    assert!(written.contains("py-3"), "{written:?}");
}

#[test]
fn inline_padding_shorthand_takes_new_sides_in_the_shortest_form() {
    let source = r"export const B = () => <p style={{ padding: '12px 24px' }}>Go</p>;";
    let written = tuned(source, r#"{"layout":{"padding":{"top":16}}}"#);
    assert!(written.contains("padding: '16px 24px 12px'"), "{written}");
}

#[test]
fn inline_padding_merge_keeps_the_longhand_that_was_winning() {
    let source = r"export const B = () => <p style={{ padding: '12px', paddingTop: 4 }}>Go</p>;";
    let written = tuned(source, r#"{"layout":{"padding":{"left":8}}}"#);
    assert!(
        written.contains("padding: '4px 12px 12px 8px'"),
        "{written}"
    );
    assert!(!written.contains("paddingTop"), "{written}");
}

#[test]
fn out_of_range_values_never_reach_the_source() {
    let at = |value: u64| NonZeroU64::new(value).expect("1-based");
    let source = element("px-6 py-3 font-medium");
    let theme = theme();
    let style = inspect(FILE, &source, at(1), at(24), &theme).expect("inspected");
    for props in [
        r#"{"layout":{"padding":{"top":-1}}}"#,
        r#"{"layout":{"padding":{"top":5000}}}"#,
        r#"{"layout":{"padding":{"top":1e308}}}"#,
        r#"{"layout":{"gap":{"row":-8}}}"#,
        r#"{"opacity":101}"#,
        r#"{"opacity":-5}"#,
        r#"{"text":{"weight":0}}"#,
        r#"{"text":{"size":-3}}"#,
        r#"{"text":{"letterSpacing":5}}"#,
        r#"{"layout":{"margin":{"top":4}}}"#,
    ] {
        let refused = serde_json::from_str::<FinetuneProps>(props).map_or(true, |parsed| {
            matches!(
                finetune_ops(&style, &parsed, &theme),
                Err(CodemodError::OutOfRange { .. })
            )
        });
        assert!(refused, "{props} was not refused");
    }
}
