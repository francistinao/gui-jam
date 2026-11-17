use crate::contracts::{
    EditOp, EditOpAddItem, EditOpProp, EditOpRemoveItem, EditOpValue, ElementStyle,
    ElementStyleAdapter, ElementStyleClassSource, ElementStyleStyleSource, FillValue,
    FinetuneProps, ProjectPath, RadiusValue, SrcLoc, StyleGroup,
};
use crate::tailwind::classify;
use crate::theme::Theme;

const MAX_RADIUS_PX: i64 = 999;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CodemodError {
    #[error("className is computed at runtime; use Ask AI to change it")]
    NotEditable,
    #[error("the style is computed at runtime; use Ask AI to change it")]
    StyleNotEditable,
    #[error("opacity must be between 0 and 100, got {0}")]
    OpacityOutOfRange(i64),
    #[error("radius must be between 0 and {MAX_RADIUS_PX} px, got {0}")]
    RadiusOutOfRange(i64),
    #[error("`{0}` is not a colour in this project")]
    UnknownColor(String),
    #[error("`{0}` is not a radius token in this project")]
    UnknownRadius(String),
    #[error("`{0}` is not a valid project path")]
    InvalidPath(String),
}

const FULL_RADIUS: f64 = 9999.0;

pub fn finetune_ops(
    style: &ElementStyle,
    props: &FinetuneProps,
    theme: &Theme,
) -> Result<Vec<EditOp>, CodemodError> {
    if style.adapter == ElementStyleAdapter::Tailwind {
        return finetune_op(style, props, theme).map(|op| vec![op]);
    }
    if style.style_source == ElementStyleStyleSource::Dynamic {
        return Err(CodemodError::StyleNotEditable);
    }
    let mut ops = Vec::new();
    if let Some(fill) = &props.fill {
        ops.push(style_op(
            style,
            "backgroundColor",
            fill_style(fill, theme)?,
        )?);
    }
    if let Some(radius) = &props.radius {
        ops.push(style_op(
            style,
            "borderRadius",
            radius_style(radius, theme)?,
        )?);
    }
    Ok(ops)
}

fn style_op(style: &ElementStyle, prop: &str, value: EditOpValue) -> Result<EditOp, CodemodError> {
    Ok(EditOp::StyleProp {
        file: ProjectPath::try_from(style.file.as_str())
            .map_err(|_| CodemodError::InvalidPath(style.file.clone()))?,
        base_hash: style.base_hash.clone(),
        at: SrcLoc {
            line: style.line,
            column: style.column,
        },
        prop: EditOpProp::try_from(prop.to_owned())
            .unwrap_or_else(|_| unreachable!("style property names are non-empty")),
        value,
    })
}

fn fill_style(fill: &FillValue, theme: &Theme) -> Result<EditOpValue, CodemodError> {
    match fill {
        FillValue::None => Ok(EditOpValue::Null),
        FillValue::Token { name } => theme
            .color(name)
            .map(|_| EditOpValue::String(format!("var(--color-{})", name.as_str())))
            .ok_or_else(|| CodemodError::UnknownColor(name.to_string())),
        FillValue::Hex { hex, opacity } => {
            if !(0..=100).contains(opacity) {
                return Err(CodemodError::OpacityOutOfRange(*opacity));
            }
            let hex = hex.to_ascii_uppercase();
            if *opacity == 100 {
                return Ok(EditOpValue::String(hex));
            }
            let channel = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).unwrap_or(0);
            let alpha = f64::from(u8::try_from(*opacity).unwrap_or(100)) / 100.0;
            Ok(EditOpValue::String(format!(
                "rgba({}, {}, {}, {alpha})",
                channel(1),
                channel(3),
                channel(5)
            )))
        }
    }
}

fn radius_style(radius: &RadiusValue, theme: &Theme) -> Result<EditOpValue, CodemodError> {
    match radius {
        RadiusValue::Full => Ok(EditOpValue::Number(FULL_RADIUS)),
        RadiusValue::Token { name } => match name.as_str() {
            "none" => Ok(EditOpValue::Number(0.0)),
            "full" => Ok(EditOpValue::Number(FULL_RADIUS)),
            other if theme.radius_px(other).is_some() => {
                Ok(EditOpValue::String(format!("var(--radius-{other})")))
            }
            other => Err(CodemodError::UnknownRadius(other.to_owned())),
        },
        RadiusValue::Px { px } => {
            if !(0..=MAX_RADIUS_PX).contains(px) {
                return Err(CodemodError::RadiusOutOfRange(*px));
            }
            Ok(EditOpValue::Number(f64::from(
                u16::try_from(*px).unwrap_or_else(|_| unreachable!("checked 0..=999")),
            )))
        }
    }
}

pub fn finetune_op(
    style: &ElementStyle,
    props: &FinetuneProps,
    theme: &Theme,
) -> Result<EditOp, CodemodError> {
    if style.class_source == ElementStyleClassSource::Dynamic {
        return Err(CodemodError::NotEditable);
    }
    let mut add = Vec::new();
    let mut replaced = Vec::new();
    if let Some(fill) = &props.fill {
        replaced.push(StyleGroup::Fill);
        add.extend(fill_token(fill, theme)?);
    }
    if let Some(radius) = &props.radius {
        replaced.push(StyleGroup::Radius);
        add.push(radius_token(radius, theme)?);
    }
    let remove = style
        .tokens
        .iter()
        .filter(|token| {
            token.editable && replaced.contains(&token.group) && !add.contains(&token.token)
        })
        .map(|token| class_item::<EditOpRemoveItem>(&token.token))
        .collect();
    Ok(EditOp::ClassTokens {
        file: ProjectPath::try_from(style.file.as_str())
            .map_err(|_| CodemodError::InvalidPath(style.file.clone()))?,
        base_hash: style.base_hash.clone(),
        at: SrcLoc {
            line: style.line,
            column: style.column,
        },
        add: add
            .iter()
            .map(|token| class_item::<EditOpAddItem>(token))
            .collect(),
        remove,
    })
}

fn class_item<T: TryFrom<String>>(token: &str) -> T {
    T::try_from(token.to_owned())
        .unwrap_or_else(|_| unreachable!("class tokens are non-empty, whitespace-free strings"))
}

fn fill_token(fill: &FillValue, theme: &Theme) -> Result<Option<String>, CodemodError> {
    match fill {
        FillValue::None => Ok(None),
        FillValue::Token { name } => {
            let token = format!("bg-{}", name.as_str());
            classify(&token, theme)
                .map(|_| Some(token))
                .ok_or_else(|| CodemodError::UnknownColor(name.to_string()))
        }
        FillValue::Hex { hex, opacity } => {
            if !(0..=100).contains(opacity) {
                return Err(CodemodError::OpacityOutOfRange(*opacity));
            }
            let hex = hex.to_ascii_uppercase();
            let color = theme
                .color_named(&hex)
                .map_or_else(|| format!("[{hex}]"), str::to_owned);
            Ok(Some(if *opacity == 100 {
                format!("bg-{color}")
            } else {
                format!("bg-{color}/{opacity}")
            }))
        }
    }
}

fn radius_token(radius: &RadiusValue, theme: &Theme) -> Result<String, CodemodError> {
    match radius {
        RadiusValue::Full => Ok("rounded-full".to_owned()),
        RadiusValue::Token { name } => {
            let name = name.as_str();
            if matches!(name, "none" | "full") || theme.radius_px(name).is_some() {
                Ok(format!("rounded-{name}"))
            } else {
                Err(CodemodError::UnknownRadius(name.to_owned()))
            }
        }
        RadiusValue::Px { px } => {
            if !(0..=MAX_RADIUS_PX).contains(px) {
                return Err(CodemodError::RadiusOutOfRange(*px));
            }
            if *px == 0 {
                return Ok("rounded-none".to_owned());
            }
            let px_value =
                f64::from(u16::try_from(*px).unwrap_or_else(|_| unreachable!("checked 1..=999")));
            Ok(theme.radius_named(px_value).map_or_else(
                || format!("rounded-[{px}px]"),
                |name| format!("rounded-{name}"),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU64;

    use std::collections::BTreeMap;

    use super::{CodemodError, finetune_op, finetune_ops};
    use crate::contracts::{EditOp, ElementStyleAdapter, FillValue, FinetuneProps, RadiusValue};
    use crate::style::{inspect, inspect_with};
    use crate::theme::Theme;

    const BUTTON: &str = r#"export const B = () => <button className="rounded-lg bg-brand px-6 hover:bg-red-500">Go</button>;"#;

    fn theme() -> Theme {
        Theme::from_css([
            "@theme { --color-brand: #be123c; --color-sea: #1d4ed8; --radius-card: 10px; }",
        ])
    }

    fn op_for(
        source: &str,
        column: u64,
        props: &FinetuneProps,
    ) -> Result<(Vec<String>, Vec<String>), CodemodError> {
        let at = |value| NonZeroU64::new(value).expect("1-based");
        let style = inspect("src/B.tsx", source, at(1), at(column), &theme()).expect("inspected");
        match finetune_op(&style, props, &theme())? {
            EditOp::ClassTokens { add, remove, .. } => Ok((
                add.iter().map(|item| item.as_str().to_owned()).collect(),
                remove.iter().map(|item| item.as_str().to_owned()).collect(),
            )),
            other => panic!("expected class_tokens, got {other:?}"),
        }
    }

    fn fill(value: serde_json::Value) -> FillValue {
        serde_json::from_value(value).expect("valid fill")
    }

    fn radius(value: serde_json::Value) -> RadiusValue {
        serde_json::from_value(value).expect("valid radius")
    }

    #[test]
    fn writes_an_arbitrary_colour_and_removes_only_base_fill_tokens() {
        let props = FinetuneProps {
            fill: Some(fill(
                serde_json::json!({ "kind": "hex", "hex": "#2563eb", "opacity": 100 }),
            )),
            radius: None,
        };

        assert_eq!(
            op_for(BUTTON, 24, &props),
            Ok((vec!["bg-[#2563EB]".to_owned()], vec!["bg-brand".to_owned()]))
        );
    }

    #[test]
    fn prefers_the_theme_token_when_the_colour_matches_one() {
        let props = FinetuneProps {
            fill: Some(fill(
                serde_json::json!({ "kind": "hex", "hex": "#1D4ED8", "opacity": 80 }),
            )),
            radius: None,
        };

        assert_eq!(
            op_for(BUTTON, 24, &props),
            Ok((vec!["bg-sea/80".to_owned()], vec!["bg-brand".to_owned()]))
        );
    }

    #[test]
    fn maps_radius_pixels_to_tokens_or_arbitrary_values() {
        let to = |px: i64| FinetuneProps {
            fill: None,
            radius: Some(radius(serde_json::json!({ "kind": "px", "px": px }))),
        };

        assert_eq!(
            op_for(BUTTON, 24, &to(10)).map(|op| op.0),
            Ok(vec!["rounded-card".to_owned()])
        );
        assert_eq!(
            op_for(BUTTON, 24, &to(16)).map(|op| op.0),
            Ok(vec!["rounded-2xl".to_owned()])
        );
        assert_eq!(
            op_for(BUTTON, 24, &to(13)).map(|op| op.0),
            Ok(vec!["rounded-[13px]".to_owned()])
        );
        assert_eq!(
            op_for(BUTTON, 24, &to(0)).map(|op| op.0),
            Ok(vec!["rounded-none".to_owned()])
        );
        assert_eq!(
            op_for(BUTTON, 24, &to(8)),
            Ok((vec!["rounded-lg".to_owned()], vec![]))
        );
    }

    #[test]
    fn removing_a_fill_adds_nothing() {
        let props = FinetuneProps {
            fill: Some(fill(serde_json::json!({ "kind": "none" }))),
            radius: None,
        };

        assert_eq!(
            op_for(BUTTON, 24, &props),
            Ok((vec![], vec!["bg-brand".to_owned()]))
        );
    }

    #[test]
    fn rejects_out_of_range_values_and_unknown_tokens() {
        let opacity = FinetuneProps {
            fill: Some(fill(
                serde_json::json!({ "kind": "hex", "hex": "#2563EB", "opacity": 101 }),
            )),
            radius: None,
        };
        let too_round = FinetuneProps {
            fill: None,
            radius: Some(radius(serde_json::json!({ "kind": "px", "px": 1000 }))),
        };
        let unknown = FinetuneProps {
            fill: Some(fill(
                serde_json::json!({ "kind": "token", "name": "chartreuse" }),
            )),
            radius: None,
        };

        assert_eq!(
            op_for(BUTTON, 24, &opacity),
            Err(CodemodError::OpacityOutOfRange(101))
        );
        assert_eq!(
            op_for(BUTTON, 24, &too_round),
            Err(CodemodError::RadiusOutOfRange(1000))
        );
        assert_eq!(
            op_for(BUTTON, 24, &unknown),
            Err(CodemodError::UnknownColor("chartreuse".to_owned()))
        );
    }

    #[test]
    fn refuses_dynamic_class_names() {
        let source = "export const B = (p) => <b className={p.className} />;";
        let props = FinetuneProps {
            fill: Some(fill(
                serde_json::json!({ "kind": "token", "name": "brand" }),
            )),
            radius: None,
        };

        assert_eq!(op_for(source, 25, &props), Err(CodemodError::NotEditable));
    }

    fn inline_result(
        source: &str,
        tailwind: bool,
        props: &FinetuneProps,
    ) -> Result<String, CodemodError> {
        let at = |value| NonZeroU64::new(value).expect("1-based");
        let column = u64::try_from(source.find("<b").expect("element") + 1).expect("column");
        let style = inspect_with("src/B.tsx", source, at(1), at(column), &theme(), tailwind)
            .expect("inspected");
        let ops = finetune_ops(&style, props, &theme())?;
        let sources = BTreeMap::from([("src/B.tsx".to_owned(), source.to_owned())]);
        Ok(crate::patch::apply(&sources, &ops)
            .expect("applies")
            .remove("src/B.tsx")
            .unwrap_or_else(|| source.to_owned()))
    }

    #[test]
    fn elements_with_inline_styles_are_edited_in_their_style_object() {
        let source = "export const B = () => <b className=\"p-4\" style={{ backgroundColor: '#fde68a', borderRadius: 8 }}>Gift</b>;";
        let props = FinetuneProps {
            fill: Some(fill(
                serde_json::json!({ "kind": "hex", "hex": "#1d4ed8", "opacity": 100 }),
            )),
            radius: Some(radius(serde_json::json!({ "kind": "px", "px": 12 }))),
        };
        assert_eq!(
            inline_result(source, true, &props).expect("edits"),
            "export const B = () => <b className=\"p-4\" style={{ backgroundColor: '#1D4ED8', borderRadius: 12 }}>Gift</b>;"
        );
        let faded = FinetuneProps {
            fill: Some(fill(
                serde_json::json!({ "kind": "hex", "hex": "#1d4ed8", "opacity": 50 }),
            )),
            radius: Some(radius(serde_json::json!({ "kind": "full" }))),
        };
        assert_eq!(
            inline_result(source, true, &faded).expect("edits"),
            "export const B = () => <b className=\"p-4\" style={{ backgroundColor: 'rgba(29, 78, 216, 0.5)', borderRadius: 9999 }}>Gift</b>;"
        );
        let tokens = FinetuneProps {
            fill: Some(fill(
                serde_json::json!({ "kind": "token", "name": "brand" }),
            )),
            radius: Some(radius(
                serde_json::json!({ "kind": "token", "name": "card" }),
            )),
        };
        assert_eq!(
            inline_result(source, true, &tokens).expect("edits"),
            "export const B = () => <b className=\"p-4\" style={{ backgroundColor: 'var(--color-brand)', borderRadius: 'var(--radius-card)' }}>Gift</b>;"
        );
        let cleared = FinetuneProps {
            fill: Some(fill(serde_json::json!({ "kind": "none" }))),
            radius: None,
        };
        assert_eq!(
            inline_result(source, true, &cleared).expect("edits"),
            "export const B = () => <b className=\"p-4\" style={{ borderRadius: 8 }}>Gift</b>;"
        );
    }

    #[test]
    fn projects_without_tailwind_get_inline_styles_even_with_a_class_name() {
        let source = "export const B = () => <b className=\"card\">Gift</b>;";
        let at = |value| NonZeroU64::new(value).expect("1-based");
        let style =
            inspect_with("src/B.tsx", source, at(1), at(24), &theme(), false).expect("inspected");
        assert_eq!(style.adapter, ElementStyleAdapter::Inline);
        let props = FinetuneProps {
            fill: Some(fill(
                serde_json::json!({ "kind": "hex", "hex": "#123456", "opacity": 100 }),
            )),
            radius: None,
        };
        assert_eq!(
            inline_result(source, false, &props).expect("edits"),
            "export const B = () => <b style={{ backgroundColor: '#123456' }} className=\"card\">Gift</b>;"
        );
        let tailwind =
            inspect_with("src/B.tsx", source, at(1), at(24), &theme(), true).expect("inspected");
        assert_eq!(tailwind.adapter, ElementStyleAdapter::Tailwind);
    }

    #[test]
    fn inline_edits_refuse_computed_styles_and_unknown_tokens() {
        let dynamic = "export const B = (p) => <b style={{ ...p.style }}>Gift</b>;";
        let props = FinetuneProps {
            fill: Some(fill(
                serde_json::json!({ "kind": "hex", "hex": "#123456", "opacity": 100 }),
            )),
            radius: None,
        };
        assert_eq!(
            inline_result(dynamic, false, &props),
            Err(CodemodError::StyleNotEditable)
        );
        let plain = "export const B = () => <b style={{ color: 'red' }}>Gift</b>;";
        let unknown = FinetuneProps {
            fill: Some(fill(serde_json::json!({ "kind": "token", "name": "nope" }))),
            radius: None,
        };
        assert_eq!(
            inline_result(plain, true, &unknown),
            Err(CodemodError::UnknownColor("nope".to_owned()))
        );
        let too_round = FinetuneProps {
            fill: None,
            radius: Some(radius(serde_json::json!({ "kind": "px", "px": 1000 }))),
        };
        assert!(matches!(
            inline_result(plain, true, &too_round),
            Err(CodemodError::RadiusOutOfRange(1000))
        ));
    }

    #[test]
    fn inline_style_tokens_feed_the_panel() {
        let source = "export const B = () => <b style={{ backgroundColor: '#fde68a', borderRadius: 8, opacity: 0.5, padding: 4, color: c }}>Gift</b>;";
        let at = |value| NonZeroU64::new(value).expect("1-based");
        let style = inspect("src/B.tsx", source, at(1), at(24), &theme()).expect("inspected");
        let summary: Vec<(String, Option<String>, bool)> = style
            .tokens
            .iter()
            .map(|token| (token.token.clone(), token.value.clone(), token.editable))
            .collect();
        assert_eq!(
            summary,
            [
                (
                    "backgroundColor: #fde68a".to_owned(),
                    Some("#fde68a".to_owned()),
                    true
                ),
                ("borderRadius: 8px".to_owned(), Some("8px".to_owned()), true),
                ("opacity: 0.5".to_owned(), Some("0.5".to_owned()), true),
                ("color: …".to_owned(), None, false),
            ]
        );
    }
}
