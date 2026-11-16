//! What the fine-tune panel needs about one element, read from its source.

use std::num::NonZeroU64;

use crate::content_hash;
use crate::contracts::{ElementStyle, ElementStyleClassSource, StyleToken};
use crate::jsx::{ClassSource, JsxError, find_element};
use crate::tailwind::{classify, parse_token};
use crate::theme::Theme;

pub fn inspect(
    file: &str,
    source: &str,
    line: NonZeroU64,
    column: NonZeroU64,
    theme: &Theme,
) -> Result<ElementStyle, JsxError> {
    let element = find_element(file, source, line.get(), column.get())?;
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
    Ok(ElementStyle {
        file: file.to_owned(),
        line,
        column,
        tag: element.tag,
        base_hash: content_hash(source.as_bytes()),
        class_source,
        tokens,
        theme: theme.tokens(),
    })
}

/// Classified tokens of one class string. Tokens with variants (`hover:`) and tokens
/// outside the editable literal are reported but marked read-only.
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
