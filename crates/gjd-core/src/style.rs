use std::num::NonZeroU64;

use crate::content;
use crate::content_hash;
use crate::contracts::{
    ContentPart, ElementStyle, ElementStyleAdapter, ElementStyleClassSource,
    ElementStyleStyleSource, StyleGroup, StyleToken,
};
use crate::jsx::{ClassSource, JsxError, StyleObject, StyleSource, find_element};
use crate::tailwind::{classify, parse_token};
use crate::template;
use crate::theme::Theme;

pub fn inspect(
    file: &str,
    source: &str,
    line: NonZeroU64,
    column: NonZeroU64,
    theme: &Theme,
) -> Result<ElementStyle, JsxError> {
    inspect_with(file, source, line, column, theme, Styling::TAILWIND)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Styling {
    pub tailwind: bool,
    pub vuetify: bool,
}

impl Styling {
    pub const TAILWIND: Self = Self {
        tailwind: true,
        vuetify: false,
    };
}

fn vuetify_component(tag: &str) -> bool {
    let mut chars = tag.chars();
    match (chars.next(), chars.next()) {
        (Some('V'), Some(second)) => second.is_ascii_uppercase(),
        (Some('v'), Some('-')) => true,
        _ => false,
    }
}

fn vuetify_tokens(source: &str, line: u64, column: u64) -> Vec<StyleToken> {
    [("color", StyleGroup::Fill), ("rounded", StyleGroup::Radius)]
        .into_iter()
        .filter_map(|(name, group)| {
            let slot = template::attribute(source, line, column, name).ok()?;
            let (value, editable) = match slot {
                template::AttributeSlot::Missing { .. } => return None,
                template::AttributeSlot::Static { text, .. } => (Some(text), true),
                template::AttributeSlot::Bound => (None, false),
            };
            Some(StyleToken {
                token: format!("{name}=\"{}\"", value.as_deref().unwrap_or("…")),
                group,
                property: name.to_owned(),
                theme_token: None,
                value: value.map(|value| {
                    if value == "0" {
                        "0px".to_owned()
                    } else {
                        value
                    }
                }),
                editable,
                variants: Vec::new(),
            })
        })
        .collect()
}

const INLINE_GROUPS: [(&str, StyleGroup, &str); 24] = [
    ("backgroundColor", StyleGroup::Fill, "background-color"),
    ("background", StyleGroup::Fill, "background"),
    ("borderRadius", StyleGroup::Radius, "border-radius"),
    ("color", StyleGroup::Text, "color"),
    ("fontSize", StyleGroup::Text, "font-size"),
    ("fontWeight", StyleGroup::Text, "font-weight"),
    ("fontFamily", StyleGroup::Text, "font-family"),
    ("lineHeight", StyleGroup::Text, "line-height"),
    ("letterSpacing", StyleGroup::Text, "letter-spacing"),
    ("textAlign", StyleGroup::Text, "text-align"),
    ("border", StyleGroup::Stroke, "border"),
    ("borderColor", StyleGroup::Stroke, "border-color"),
    ("borderWidth", StyleGroup::Stroke, "border-width"),
    ("borderStyle", StyleGroup::Stroke, "border-style"),
    ("boxShadow", StyleGroup::Effects, "box-shadow"),
    ("opacity", StyleGroup::Opacity, "opacity"),
    ("padding", StyleGroup::Layout, "padding"),
    ("paddingTop", StyleGroup::Layout, "padding-top"),
    ("paddingRight", StyleGroup::Layout, "padding-right"),
    ("paddingBottom", StyleGroup::Layout, "padding-bottom"),
    ("paddingLeft", StyleGroup::Layout, "padding-left"),
    ("gap", StyleGroup::Layout, "gap"),
    ("rowGap", StyleGroup::Layout, "row-gap"),
    ("columnGap", StyleGroup::Layout, "column-gap"),
];
const UNITLESS: [&str; 3] = ["opacity", "fontWeight", "lineHeight"];

fn inline_group(key: &str) -> Option<&'static (&'static str, StyleGroup, &'static str)> {
    INLINE_GROUPS.iter().find(|(name, _, _)| *name == key)
}

fn inline_tokens(object: &StyleObject) -> Vec<StyleToken> {
    object
        .props
        .iter()
        .filter_map(|prop| {
            let key = template::camel(&prop.key);
            let (_, group, property) = inline_group(&key)?;
            let value = prop.value.as_ref().map(|value| {
                let numeric = value.parse::<f64>().is_ok();
                if numeric && !UNITLESS.contains(&prop.key.as_str()) {
                    format!("{value}px")
                } else {
                    value.clone()
                }
            });
            Some(StyleToken {
                token: format!(
                    "{}: {}",
                    prop.key,
                    value.clone().unwrap_or_else(|| "…".to_owned())
                ),
                group: *group,
                property: (*property).to_owned(),
                theme_token: None,
                editable: value.is_some(),
                value,
                variants: Vec::new(),
            })
        })
        .collect()
}

fn css_tokens(text: &str) -> Vec<StyleToken> {
    template::declarations(text)
        .into_iter()
        .filter_map(|(property, value)| {
            let key = template::camel(&property);
            let (_, group, _) = inline_group(&key)?;
            Some(StyleToken {
                token: format!("{property}: {value}"),
                group: *group,
                property,
                theme_token: None,
                editable: true,
                value: Some(value),
                variants: Vec::new(),
            })
        })
        .collect()
}

pub fn inspect_with(
    file: &str,
    source: &str,
    line: NonZeroU64,
    column: NonZeroU64,
    theme: &Theme,
    styling: Styling,
) -> Result<ElementStyle, JsxError> {
    let element = find_element(file, source, line.get(), column.get())?;
    let vuetify = styling.vuetify && template::is_template(file) && vuetify_component(&element.tag);
    let adapter = match (&element.style, styling.tailwind) {
        _ if vuetify => ElementStyleAdapter::Vuetify,
        (StyleSource::Object(_) | StyleSource::Css(_), _) | (_, false) => {
            ElementStyleAdapter::Inline
        }
        _ => ElementStyleAdapter::Tailwind,
    };
    let style_source = match &element.style {
        StyleSource::None => ElementStyleStyleSource::None,
        StyleSource::Object(_) | StyleSource::Css(_) => ElementStyleStyleSource::Object,
        StyleSource::Dynamic => ElementStyleStyleSource::Dynamic,
    };
    let (class_source, tokens) = match &element.class {
        ClassSource::None => (ElementStyleClassSource::None, Vec::new()),
        ClassSource::Static(literal) => (
            ElementStyleClassSource::Static,
            style_tokens(&literal.value, true, theme),
        ),
        ClassSource::Call {
            literal,
            conditional,
        } => {
            let mut tokens = style_tokens(&literal.value, true, theme);
            for value in conditional {
                tokens.extend(style_tokens(value, false, theme));
            }
            (ElementStyleClassSource::Call, tokens)
        }
        ClassSource::Dynamic => (ElementStyleClassSource::Dynamic, Vec::new()),
    };
    let mut tokens = tokens;
    match &element.style {
        StyleSource::Object(object) => tokens.extend(inline_tokens(object)),
        StyleSource::Css(literal) => tokens.extend(css_tokens(&literal.value)),
        StyleSource::None | StyleSource::Dynamic => {}
    }
    if vuetify {
        tokens.extend(vuetify_tokens(source, line.get(), column.get()));
    }
    Ok(ElementStyle {
        file: file.to_owned(),
        line,
        column,
        tag: element.tag,
        base_hash: content_hash(source.as_bytes()),
        class_source,
        adapter,
        style_source,
        tokens,
        theme: theme.tokens(),
        content: element
            .content
            .as_deref()
            .map_or_else(Vec::new, content_parts),
    })
}

fn content_parts(parts: &[content::ContentPart]) -> Vec<ContentPart> {
    let mut run = 0u64;
    parts
        .iter()
        .map(|part| match part {
            content::ContentPart::Text { value, .. } => {
                run += 1;
                ContentPart::Text {
                    run: run - 1,
                    value: value.clone(),
                }
            }
            content::ContentPart::Code { source } => ContentPart::Code {
                source: content::shortened(source),
            },
            content::ContentPart::Element { tag } => ContentPart::Element { tag: tag.clone() },
        })
        .collect()
}

fn style_tokens(classes: &str, in_editable_literal: bool, theme: &Theme) -> Vec<StyleToken> {
    classes
        .split_whitespace()
        .filter_map(|raw| {
            let parsed = parse_token(raw);
            let found = classify(parsed.utility, theme)?;
            Some(StyleToken {
                token: raw.to_owned(),
                group: found.group,
                property: found.property.to_owned(),
                theme_token: found.theme_token,
                value: found.value,
                editable: in_editable_literal && parsed.variants.is_empty(),
                variants: parsed.variants.into_iter().map(str::to_owned).collect(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU64;

    use super::inspect;
    use crate::contracts::{ElementStyleClassSource, StyleGroup};
    use crate::theme::Theme;

    fn at(value: u64) -> NonZeroU64 {
        NonZeroU64::new(value).expect("positions are 1-based")
    }

    fn theme() -> Theme {
        Theme::from_css(["@theme { --color-brand: #be123c; }"])
    }

    #[test]
    fn reports_editable_tokens_with_their_group_and_theme_value() {
        let source = r#"export const B = () => <button className="rounded-lg bg-brand px-6 hover:bg-red-500">Go</button>;"#;

        let style = inspect("src/B.tsx", source, at(1), at(24), &theme()).expect("inspected");

        assert_eq!(style.tag, "button");
        assert_eq!(style.class_source, ElementStyleClassSource::Static);
        let summary: Vec<_> = style
            .tokens
            .iter()
            .map(|t| {
                (
                    t.token.as_str(),
                    t.group,
                    t.editable,
                    t.theme_token.as_deref(),
                    t.value.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (
                    "rounded-lg",
                    StyleGroup::Radius,
                    true,
                    Some("lg"),
                    Some("8px")
                ),
                (
                    "bg-brand",
                    StyleGroup::Fill,
                    true,
                    Some("brand"),
                    Some("#BE123C")
                ),
                ("px-6", StyleGroup::Layout, true, None, Some("24px")),
                (
                    "hover:bg-red-500",
                    StyleGroup::Fill,
                    false,
                    Some("red-500"),
                    None
                ),
            ]
        );
    }

    #[test]
    fn marks_conditional_cn_tokens_as_read_only() {
        let source = "export const B = () => <b className={cn('rounded-lg border', on && 'border-brand')} />;";

        let style = inspect("src/B.tsx", source, at(1), at(24), &theme()).expect("inspected");

        assert_eq!(style.class_source, ElementStyleClassSource::Call);
        let editable: Vec<_> = style
            .tokens
            .iter()
            .map(|t| (t.token.as_str(), t.editable))
            .collect();
        assert_eq!(
            editable,
            vec![
                ("rounded-lg", true),
                ("border", true),
                ("border-brand", false)
            ]
        );
    }

    #[test]
    fn reports_no_tokens_for_dynamic_or_missing_class_names() {
        let dynamic = "export const B = (p) => <b className={p.className} />;";
        let missing = "export const B = () => <b />;";

        let dynamic_style =
            inspect("src/B.tsx", dynamic, at(1), at(25), &theme()).expect("inspected");
        let missing_style =
            inspect("src/B.tsx", missing, at(1), at(24), &theme()).expect("inspected");

        assert_eq!(dynamic_style.class_source, ElementStyleClassSource::Dynamic);
        assert!(dynamic_style.tokens.is_empty());
        assert_eq!(missing_style.class_source, ElementStyleClassSource::None);
    }
}
