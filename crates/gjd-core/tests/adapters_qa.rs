use std::collections::{BTreeMap, BTreeSet};
use std::num::NonZeroU64;

use gjd_core::codemod::finetune_ops;
use gjd_core::contracts::FinetuneProps;
use gjd_core::patch::{self, Dialect};
use gjd_core::style::{Styling, inspect_with};
use gjd_core::theme::Theme;

const V3: &str = "@tailwind base;\n@tailwind components;\n@tailwind utilities;";
const V4: &str = "@import \"tailwindcss\";\n@theme { --color-brand: #be123c; }";
const PLAIN: Styling = Styling {
    tailwind: false,
    vuetify: false,
};
const VUETIFY: Styling = Styling {
    tailwind: false,
    vuetify: true,
};
const EVERY_GROUP: &str = r##"{
    "layout": { "padding": { "top": 13, "left": 14 } },
    "text": { "size": 18, "weight": 650 },
    "stroke": { "kind": "set", "width": 3, "style": "dashed", "color": { "kind": "hex", "hex": "#1D4ED8", "opacity": 100 } },
    "effects": { "drop": { "kind": "custom", "x": 0, "y": 4, "blur": 8, "spread": -2, "hex": "#000000", "opacity": 20 } },
    "opacity": 37
}"##;
const CSS_DECLARATIONS: [&str; 9] = [
    "font-weight: 650",
    "font-size: 18px",
    "border-width: 3px",
    "border-style: dashed",
    "border-color: #1D4ED8",
    "box-shadow: 0 4px 8px -2px rgba(0,0,0,0.2)",
    "opacity: 0.37",
    "padding-top: 13px",
    "padding-left: 14px",
];

fn written(css: &str, path: &str, source: &str, needle: &str, styling: Styling) -> String {
    let theme = Theme::from_css([css]);
    let offset = source.find(needle).expect("element");
    let line = source[..offset].matches('\n').count() + 1;
    let column = offset - source[..offset].rfind('\n').map_or(0, |at| at + 1) + 1;
    let at = |value: usize| NonZeroU64::new(u64::try_from(value).expect("fits")).expect("1-based");
    let style =
        inspect_with(path, source, at(line), at(column), &theme, styling).expect("inspected");
    let props: FinetuneProps = serde_json::from_str(EVERY_GROUP).expect("props");
    let ops = finetune_ops(&style, &props, &theme).expect("ops");
    let sources = BTreeMap::from([(path.to_owned(), source.to_owned())]);
    patch::apply_with(&sources, &ops, Dialect::default())
        .expect("applied")
        .remove(path)
        .expect("same file")
}

fn quoted_after(text: &str, attribute: &str) -> String {
    let start = text.find(attribute).expect(attribute) + attribute.len();
    let end = start + text[start..].find('"').expect("closing quote");
    text[start..end].to_owned()
}

fn declarations(text: &str) -> BTreeSet<String> {
    quoted_after(text, "style=\"")
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

#[test]
fn tailwind_3_stays_on_its_own_scale_in_jsx_and_templates() {
    let expected: BTreeSet<String> = "font-[650] text-lg border-[3px] border-dashed border-[#1D4ED8] shadow-[0_4px_8px_-2px_rgba(0,0,0,0.2)] opacity-[0.37] pt-[13px] pb-3 pl-3.5 pr-6 text-white"
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    for (path, source, attribute) in [
        (
            "src/B.tsx",
            "export const B = () => <p className=\"px-6 py-3 text-white\">Hi</p>;\n",
            "className=\"",
        ),
        (
            "src/B.vue",
            "<template>\n  <p class=\"px-6 py-3 text-white\">Hi</p>\n</template>\n",
            "class=\"",
        ),
        (
            "src/B.svelte",
            "<p class=\"px-6 py-3 text-white\">Hi</p>\n",
            "class=\"",
        ),
        (
            "src/B.astro",
            "---\n---\n<p class=\"px-6 py-3 text-white\">Hi</p>\n",
            "class=\"",
        ),
    ] {
        let output = written(V3, path, source, "<p", Styling::TAILWIND);
        let got: BTreeSet<String> = quoted_after(&output, attribute)
            .split_whitespace()
            .map(str::to_owned)
            .collect();
        assert_eq!(got, expected, "{path}");
    }
}

#[test]
fn projects_without_tailwind_write_css_declarations_in_templates() {
    for (path, source, kept) in [
        ("src/B.svelte", "<p class=\"card\">Hi</p>\n", None),
        (
            "src/B.vue",
            "<template>\n  <p class=\"card\">Hi</p>\n</template>\n",
            None,
        ),
        (
            "src/B.astro",
            "---\n---\n<p class=\"card\" style=\"color: red\">Hi</p>\n",
            Some("color: red"),
        ),
    ] {
        let output = written(V4, path, source, "<p", PLAIN);
        let got = declarations(&output);
        for expected in CSS_DECLARATIONS.iter().chain(kept.iter()) {
            assert!(got.contains(*expected), "{path}: no {expected} in {got:?}");
        }
        assert!(output.contains("class=\"card\""), "{path}: {output}");
    }
}

#[test]
fn projects_without_tailwind_write_react_style_objects() {
    let output = written(
        V4,
        "src/B.tsx",
        "export const B = () => <p className=\"card\">Hi</p>;\n",
        "<p",
        PLAIN,
    );

    for expected in [
        "fontWeight: 650",
        "fontSize: 18",
        "borderWidth: 3",
        "borderStyle: 'dashed'",
        "borderColor: '#1D4ED8'",
        "boxShadow: '0 4px 8px -2px rgba(0,0,0,0.2)'",
        "opacity: 0.37",
        "paddingTop: 13",
        "paddingLeft: 14",
    ] {
        assert!(output.contains(expected), "no {expected} in {output}");
    }
    assert!(output.contains("className=\"card\""), "{output}");
}

#[test]
fn vuetify_components_take_a_style_and_keep_their_props() {
    let output = written(
        V4,
        "src/B.vue",
        "<template>\n  <v-btn color=\"primary\" rounded=\"lg\">Hi</v-btn>\n</template>\n",
        "<v-btn",
        VUETIFY,
    );

    let got = declarations(&output);
    for expected in CSS_DECLARATIONS {
        assert!(got.contains(expected), "no {expected} in {got:?}");
    }
    assert!(output.contains("color=\"primary\""), "{output}");
    assert!(output.contains("rounded=\"lg\""), "{output}");
}
