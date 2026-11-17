use std::ops::Range;

use crate::contracts::{DomPatch, DomPatchSetStylesItem};
use crate::jsx::{ClassLiteral, ClassSource, JsxElement, JsxError, StyleSource};
use crate::srcloc::LineIndex;

const EXTENSIONS: [&str; 4] = ["vue", "svelte", "astro", "html"];
const UNITLESS: [&str; 6] = [
    "opacity",
    "font-weight",
    "z-index",
    "line-height",
    "flex-grow",
    "flex-shrink",
];

const SERVER_RENDERED: [&str; 1] = ["astro"];

#[must_use]
pub fn is_server_rendered(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, extension)| {
        SERVER_RENDERED.contains(&extension.to_ascii_lowercase().as_str())
    })
}

#[must_use]
pub fn is_template(path: &str) -> bool {
    path.rsplit_once('.')
        .is_some_and(|(_, extension)| EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
}

struct Attribute {
    name: String,
    value: Option<Value>,
    range: Range<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttributeSlot {
    Missing {
        insert_at: usize,
    },
    Static {
        whole: Range<usize>,
        value: Range<usize>,
        text: String,
    },
    Bound,
}

enum Value {
    Quoted(Range<usize>),
    Expression,
    Bare,
}

fn skip_braces(bytes: &[u8], mut at: usize) -> usize {
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    while at < bytes.len() {
        let byte = bytes[at];
        match quote {
            Some(_) if byte == b'\\' => at += 1,
            Some(open) if byte == open => quote = None,
            Some(_) => {}
            None => match byte {
                b'"' | b'\'' | b'`' => quote = Some(byte),
                b'{' => depth += 1,
                b'}' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        return at + 1;
                    }
                }
                _ => {}
            },
        }
        at += 1;
    }
    bytes.len()
}

fn attributes(source: &str, mut at: usize) -> (Vec<Attribute>, bool) {
    let bytes = source.as_bytes();
    let mut found = Vec::new();
    loop {
        while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
        }
        match bytes.get(at) {
            None => return (found, false),
            Some(b'>') => return (found, true),
            Some(b'/') if bytes.get(at + 1) == Some(&b'>') => return (found, true),
            Some(b'{') => {
                let end = skip_braces(bytes, at);
                let inner = source[at + 1..end.saturating_sub(1).max(at + 1)].trim();
                let name = inner
                    .strip_prefix("...")
                    .map_or_else(|| inner.to_owned(), |_| "{...}".to_owned());
                found.push(Attribute {
                    name,
                    value: Some(Value::Expression),
                    range: at..end,
                });
                at = end;
                continue;
            }
            Some(_) => {}
        }
        let start = at;
        while bytes
            .get(at)
            .is_some_and(|b| !b.is_ascii_whitespace() && !matches!(b, b'=' | b'>'))
            && !(bytes[at] == b'/' && bytes.get(at + 1) == Some(&b'>'))
        {
            at += 1;
        }
        let name = source[start..at].to_owned();
        while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
        }
        if bytes.get(at) != Some(&b'=') {
            found.push(Attribute {
                name,
                value: None,
                range: start..at,
            });
            if at == start {
                at += 1;
            }
            continue;
        }
        at += 1;
        while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
        }
        let value = match bytes.get(at) {
            Some(quote @ (b'"' | b'\'')) => {
                let inner = at + 1;
                let end = source[inner..]
                    .find(char::from(*quote))
                    .map_or(source.len(), |end| inner + end);
                at = (end + 1).min(source.len());
                Value::Quoted(inner..end)
            }
            Some(b'{') => {
                at = skip_braces(bytes, at);
                Value::Expression
            }
            _ => {
                while bytes
                    .get(at)
                    .is_some_and(|b| !b.is_ascii_whitespace() && *b != b'>')
                {
                    at += 1;
                }
                Value::Bare
            }
        };
        found.push(Attribute {
            name,
            value: Some(value),
            range: start..at,
        });
    }
}

fn interpolated(text: &str) -> bool {
    text.contains('{')
}

fn read(source: &str, attribute: &Attribute) -> Option<ClassLiteral> {
    match &attribute.value {
        Some(Value::Quoted(range)) if !interpolated(&source[range.clone()]) => Some(ClassLiteral {
            value: source[range.clone()].to_owned(),
            range: range.clone(),
        }),
        _ => None,
    }
}

fn start_tag(
    source: &str,
    line: u64,
    column: u64,
) -> Result<(usize, usize, Vec<Attribute>), JsxError> {
    let not_found = JsxError::ElementNotFound { line, column };
    let offset = LineIndex::new(source)
        .offset(line, column)
        .ok_or_else(|| not_found.clone())?;
    let bytes = source.as_bytes();
    if bytes.get(offset) != Some(&b'<')
        || !bytes.get(offset + 1).is_some_and(u8::is_ascii_alphabetic)
    {
        return Err(not_found);
    }
    let mut name_end = offset + 1;
    while bytes
        .get(name_end)
        .is_some_and(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b':' | b'.' | b'_'))
    {
        name_end += 1;
    }
    let (found, closed) = attributes(source, name_end);
    if !closed {
        return Err(JsxError::Syntax(format!(
            "the <{}> tag at {line}:{column} never closes",
            &source[offset + 1..name_end]
        )));
    }
    Ok((offset + 1, name_end, found))
}

fn spreads(attribute: &Attribute) -> bool {
    attribute.name == "v-bind" || attribute.name.starts_with("{...")
}

pub fn attribute(
    source: &str,
    line: u64,
    column: u64,
    name: &str,
) -> Result<AttributeSlot, JsxError> {
    let (_, name_end, found) = start_tag(source, line, column)?;
    let bound = [
        format!(":{name}"),
        format!("v-bind:{name}"),
        format!(".{name}"),
    ];
    let last_spread = found.iter().rposition(spreads);
    let at = found.iter().rposition(|attribute| attribute.name == name);
    let bound_at = found
        .iter()
        .rposition(|attribute| bound.contains(&attribute.name));
    if bound_at.is_some() || last_spread.is_some_and(|spread| at.is_none_or(|at| spread > at)) {
        return Ok(AttributeSlot::Bound);
    }
    let Some(attribute) = at.map(|at| &found[at]) else {
        return Ok(AttributeSlot::Missing {
            insert_at: name_end,
        });
    };
    match &attribute.value {
        Some(Value::Quoted(range)) if !interpolated(&source[range.clone()]) => {
            Ok(AttributeSlot::Static {
                whole: attribute.range.clone(),
                value: range.clone(),
                text: source[range.clone()].to_owned(),
            })
        }
        _ => Ok(AttributeSlot::Bound),
    }
}

pub fn find_element(source: &str, line: u64, column: u64) -> Result<JsxElement, JsxError> {
    let (name_start, name_end, found) = start_tag(source, line, column)?;
    let position = |name: &str| found.iter().rposition(|attribute| attribute.name == name);
    let last_spread = found.iter().rposition(spreads);
    let after_spread = |at: Option<usize>| match (at, last_spread) {
        (Some(at), Some(spread)) => spread > at,
        (None, Some(_)) => true,
        _ => false,
    };
    let class_at = position("class");
    let class = match class_at.map(|at| &found[at]) {
        _ if after_spread(class_at) => ClassSource::Dynamic,
        None => ClassSource::None,
        Some(attribute) => {
            read(source, attribute).map_or(ClassSource::Dynamic, ClassSource::Static)
        }
    };
    let style_at = position("style");
    let style = match style_at.map(|at| &found[at]) {
        _ if after_spread(style_at) => StyleSource::Dynamic,
        None => StyleSource::None,
        Some(attribute) => read(source, attribute).map_or(StyleSource::Dynamic, StyleSource::Css),
    };
    Ok(JsxElement {
        tag: source[name_start..name_end].to_owned(),
        insert_at: name_end,
        class,
        style,
    })
}

#[must_use]
pub fn kebab(prop: &str) -> String {
    if prop.starts_with("--") {
        return prop.to_owned();
    }
    let mut out = String::with_capacity(prop.len() + 4);
    for c in prop.chars() {
        if c.is_ascii_uppercase() {
            out.push('-');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

#[must_use]
pub fn camel(property: &str) -> String {
    if property.starts_with("--") {
        return property.to_owned();
    }
    let mut out = String::with_capacity(property.len());
    let mut upper = false;
    for c in property.chars() {
        if c == '-' {
            upper = true;
        } else if upper {
            out.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

#[must_use]
pub fn css_number(property: &str, number: f64) -> String {
    let text = if number.fract() == 0.0 && number.abs() < 1e15 {
        format!("{number:.0}")
    } else {
        number.to_string()
    };
    if UNITLESS.contains(&property) || property.starts_with("--") || number == 0.0 {
        text
    } else {
        format!("{text}px")
    }
}

#[must_use]
pub fn declarations(text: &str) -> Vec<(String, String)> {
    text.split(';')
        .filter_map(|declaration| {
            let (property, value) = declaration.split_once(':')?;
            let property = property.trim();
            let value = value.trim();
            (!property.is_empty() && !value.is_empty())
                .then(|| (property.to_ascii_lowercase(), value.to_owned()))
        })
        .collect()
}

#[must_use]
pub fn merged_css(text: &str, changes: &[(String, Option<String>)]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for (property, value) in declarations(text) {
        match changes.iter().find(|(name, _)| *name == property) {
            Some((_, None)) => {}
            Some((_, Some(next))) => parts.push(format!("{property}: {next}")),
            None => parts.push(format!("{property}: {value}")),
        }
    }
    let existing = declarations(text);
    for (property, value) in changes {
        if let Some(value) = value
            && !existing.iter().any(|(name, _)| name == property)
        {
            parts.push(format!("{property}: {value}"));
        }
    }
    parts.join("; ")
}

enum Seen {
    Text(String),
    Bound,
}

fn seen(source: &str, line: u64, column: u64, name: &str) -> Option<Seen> {
    match attribute(source, line, column, name).ok()? {
        AttributeSlot::Missing { .. } => Some(Seen::Text(String::new())),
        AttributeSlot::Static { text, .. } => Some(Seen::Text(text)),
        AttributeSlot::Bound => Some(Seen::Bound),
    }
}

fn texts(base: &str, next: &str, line: u64, column: u64, name: &str) -> Option<(String, String)> {
    match (
        seen(base, line, column, name)?,
        seen(next, line, column, name)?,
    ) {
        (Seen::Text(from), Seen::Text(to)) => Some((from, to)),
        (Seen::Bound, Seen::Bound) => Some((String::new(), String::new())),
        _ => None,
    }
}

fn missing_from(tokens: &[&str], other: &[&str]) -> Vec<String> {
    tokens
        .iter()
        .filter(|token| !other.contains(token))
        .map(|token| (*token).to_owned())
        .collect()
}

#[must_use]
pub fn dom_patch(path: &str, base: &str, next: &str, line: u64, column: u64) -> Option<DomPatch> {
    let (class_from, class_to) = texts(base, next, line, column, "class")?;
    let (style_from, style_to) = texts(base, next, line, column, "style")?;
    let from_tokens: Vec<&str> = class_from.split_whitespace().collect();
    let to_tokens: Vec<&str> = class_to.split_whitespace().collect();
    let from_css = declarations(&style_from);
    let to_css = declarations(&style_to);
    let set_styles = to_css
        .iter()
        .filter(|(property, value)| {
            from_css
                .iter()
                .find(|(known, _)| known == property)
                .is_none_or(|(_, before)| before != value)
        })
        .map(|(property, value)| DomPatchSetStylesItem {
            property: property.clone(),
            value: value.clone(),
        })
        .collect();
    let remove_styles = from_css
        .iter()
        .filter(|(property, _)| !to_css.iter().any(|(known, _)| known == property))
        .map(|(property, _)| property.clone())
        .collect();
    Some(DomPatch {
        src: format!("{path}:{line}:{column}").parse().ok()?,
        add_classes: missing_from(&to_tokens, &from_tokens),
        remove_classes: missing_from(&from_tokens, &to_tokens),
        set_styles,
        remove_styles,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        AttributeSlot, attribute, camel, css_number, declarations, dom_patch, find_element,
        is_server_rendered, is_template, kebab, merged_css,
    };
    use crate::jsx::{ClassSource, StyleSource};

    fn at(source: &str, needle: &str) -> (u64, u64) {
        let offset = source.find(needle).expect("needle");
        let line = source[..offset].matches('\n').count() + 1;
        let column = offset
            - source[..offset]
                .rfind('\n')
                .map_or(0, |newline| newline + 1)
            + 1;
        (
            u64::try_from(line).expect("line"),
            u64::try_from(column).expect("column"),
        )
    }

    fn element(source: &str, needle: &str) -> crate::jsx::JsxElement {
        let (line, column) = at(source, needle);
        find_element(source, line, column).expect("element")
    }

    #[test]
    fn knows_template_files() {
        for path in [
            "src/App.vue",
            "src/routes/+page.svelte",
            "src/pages/index.astro",
            "index.html",
            "A.VUE",
        ] {
            assert!(is_template(path), "{path}");
        }
        for path in ["src/App.tsx", "src/main.ts", "vue", "README.md"] {
            assert!(!is_template(path), "{path}");
        }
    }

    #[test]
    fn reads_static_class_and_style_from_vue_and_svelte_tags() {
        let vue = "<template>\n  <div>\n    <button\n      type=\"button\"\n      class=\"rounded-lg bg-brand px-6\"\n      :class=\"{ active }\"\n      @click=\"order(a > b)\"\n      style=\"background-color: #fde68a; border-radius: 8px\"\n    >Order</button>\n  </div>\n</template>\n";
        let button = element(vue, "<button");
        assert_eq!(button.tag, "button");
        let ClassSource::Static(class) = &button.class else {
            panic!("static class expected, got {:?}", button.class);
        };
        assert_eq!(class.value, "rounded-lg bg-brand px-6");
        assert_eq!(&vue[class.range.clone()], "rounded-lg bg-brand px-6");
        let StyleSource::Css(style) = &button.style else {
            panic!("css style expected");
        };
        assert_eq!(style.value, "background-color: #fde68a; border-radius: 8px");
        assert_eq!(vue.as_bytes()[button.insert_at], b'\n');

        let svelte = "<script>let open = false;</script>\n<a href=\"/\" class=\"text-sm\" on:click={() => (open = !open && 1 > 0)}>Home</a>\n";
        let link = element(svelte, "<a ");
        assert!(matches!(link.class, ClassSource::Static(ref class) if class.value == "text-sm"));
        assert_eq!(link.style, StyleSource::None);
    }

    #[test]
    fn interpolation_bindings_and_later_spreads_make_class_or_style_dynamic() {
        let cases = [
            ("<b class=\"a {b}\">x</b>", true, false),
            ("<b class={cls}>x</b>", true, false),
            ("<b {...props} class=\"a\">x</b>", false, true),
            ("<b class=\"a\" {...props}>x</b>", true, true),
            ("<b class=\"a\" v-bind=\"attrs\">x</b>", true, true),
            ("<b style={`color: ${c}`}>x</b>", false, true),
            ("<b style=\"color: {c}\">x</b>", false, true),
            ("<b {class}>x</b>", true, false),
        ];
        for (source, class_dynamic, style_dynamic) in cases {
            let found = element(source, "<b");
            assert_eq!(
                matches!(found.class, ClassSource::Dynamic),
                class_dynamic,
                "{source}: {:?}",
                found.class
            );
            assert_eq!(
                matches!(found.style, StyleSource::Dynamic),
                style_dynamic,
                "{source}: {:?}",
                found.style
            );
        }
    }

    #[test]
    fn refuses_positions_that_are_not_a_start_tag() {
        let source = "<template>\n  <p>Hi</p>\n</template>\n";
        assert!(find_element(source, 2, 4).is_err());
        assert!(find_element(source, 9, 1).is_err());
        assert!(find_element("<p class=\"a\"", 1, 1).is_err());
        assert!(find_element("</p>", 1, 1).is_err());
        assert!(find_element("< p>", 1, 1).is_err());
    }

    #[test]
    fn converts_property_names_and_numbers() {
        assert_eq!(kebab("backgroundColor"), "background-color");
        assert_eq!(kebab("--brand"), "--brand");
        assert_eq!(camel("border-top-left-radius"), "borderTopLeftRadius");
        assert_eq!(camel("--brand"), "--brand");
        assert_eq!(css_number("border-radius", 12.0), "12px");
        assert_eq!(css_number("border-radius", 0.0), "0");
        assert_eq!(css_number("opacity", 0.5), "0.5");
        assert_eq!(css_number("font-weight", 600.0), "600");
    }

    #[test]
    fn merges_css_declarations() {
        assert_eq!(
            declarations(" background-color: #fde68a ; border-radius:8px;; padding: 16px; broken "),
            [
                ("background-color".to_owned(), "#fde68a".to_owned()),
                ("border-radius".to_owned(), "8px".to_owned()),
                ("padding".to_owned(), "16px".to_owned()),
            ]
        );
        let text = "background-color: #fde68a; border-radius: 8px; padding: 16px";
        assert_eq!(
            merged_css(
                text,
                &[
                    ("background-color".to_owned(), Some("#1D4ED8".to_owned())),
                    ("border-radius".to_owned(), None),
                    ("opacity".to_owned(), Some("0.5".to_owned())),
                ]
            ),
            "background-color: #1D4ED8; padding: 16px; opacity: 0.5"
        );
        assert_eq!(
            merged_css("", &[("color".to_owned(), Some("red".to_owned()))]),
            "color: red"
        );
    }

    #[test]
    fn looks_up_one_attribute_on_a_start_tag() {
        let source = "<VBtn color=\"primary\" :rounded=\"r\" block>Go</VBtn>";
        assert_eq!(
            attribute(source, 1, 1, "color").expect("tag"),
            AttributeSlot::Static {
                whole: 6..21,
                value: 13..20,
                text: "primary".to_owned()
            }
        );
        assert_eq!(
            attribute(source, 1, 1, "rounded").expect("tag"),
            AttributeSlot::Bound
        );
        assert_eq!(
            attribute(source, 1, 1, "size").expect("tag"),
            AttributeSlot::Missing { insert_at: 5 }
        );
        assert_eq!(
            attribute("<VBtn v-bind=\"a\">x</VBtn>", 1, 1, "color").expect("tag"),
            AttributeSlot::Bound
        );
        assert_eq!(
            attribute("<VBtn {...a} color=\"red\">x</VBtn>", 1, 1, "color").expect("tag"),
            AttributeSlot::Static {
                whole: 13..24,
                value: 20..23,
                text: "red".to_owned()
            }
        );
        assert_eq!(
            attribute("<VBtn color=\"{c}\">x</VBtn>", 1, 1, "color").expect("tag"),
            AttributeSlot::Bound
        );
        assert!(attribute("<VBtn", 1, 1, "color").is_err());
    }

    #[test]
    fn only_astro_templates_are_server_rendered() {
        assert!(is_server_rendered("src/pages/index.astro"));
        assert!(is_server_rendered("src/Card.ASTRO"));
        assert!(!is_server_rendered("src/App.vue"));
        assert!(!is_server_rendered("src/App.tsx"));
        assert!(!is_server_rendered("astro"));
    }

    #[test]
    fn a_dom_patch_lists_the_class_and_style_changes_of_one_element() {
        let base = "<div>\n  <p class=\"mt-6 bg-brand\" style=\"padding: 16px; color: red\">Gift</p>\n</div>\n";
        let next = "<div>\n  <p class=\"mt-6 bg-[#1D4ED8] rounded-full\" style=\"padding: 16px; background-color: #1D4ED8\">Gift</p>\n</div>\n";

        let patch = dom_patch("src/pages/index.astro", base, next, 2, 3).expect("both static");

        assert_eq!(patch.src.as_str(), "src/pages/index.astro:2:3");
        assert_eq!(patch.add_classes, ["bg-[#1D4ED8]", "rounded-full"]);
        assert_eq!(patch.remove_classes, ["bg-brand"]);
        let set: Vec<(&str, &str)> = patch
            .set_styles
            .iter()
            .map(|item| (item.property.as_str(), item.value.as_str()))
            .collect();
        assert_eq!(set, [("background-color", "#1D4ED8")]);
        assert_eq!(patch.remove_styles, ["color"]);
    }

    #[test]
    fn added_and_removed_attributes_count_as_empty() {
        let base = "<button type=\"button\">Order</button>\n";
        let next =
            "<button type=\"button\" class=\"rounded-lg\" style=\"color: red\">Order</button>\n";

        let added = dom_patch("a.astro", base, next, 1, 1).expect("static");
        let removed = dom_patch("a.astro", next, base, 1, 1).expect("static");

        assert_eq!(added.add_classes, ["rounded-lg"]);
        assert_eq!(added.set_styles.len(), 1);
        assert_eq!(removed.remove_classes, ["rounded-lg"]);
        assert_eq!(removed.remove_styles, ["color"]);
    }

    #[test]
    fn a_bound_attribute_that_changes_cannot_be_patched_in_place() {
        let bound = "<p class={tone} style=\"color: red\">x</p>\n";
        let restyled = "<p class={tone} style=\"color: blue\">x</p>\n";
        let unbound = "<p class=\"mt-6\" style=\"color: red\">x</p>\n";

        let kept = dom_patch("a.astro", bound, restyled, 1, 1).expect("class unchanged");
        assert!(kept.add_classes.is_empty() && kept.remove_classes.is_empty());
        assert_eq!(kept.set_styles[0].value, "blue");
        assert!(dom_patch("a.astro", bound, unbound, 1, 1).is_none());
        assert!(dom_patch("a.astro", bound, bound, 9, 1).is_none());
    }
}
