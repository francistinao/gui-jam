use std::num::NonZeroU64;

use gjd_core::contracts::{
    FillValue, FinetuneProps, HistoryEntry, HistoryEntryState, RadiusValue, ShadowValue,
    StrokeValue,
};
use gjd_core::journal::Row;
use gjd_core::jsx;
use gjd_core::tailwind::trimmed;

const MAX_DETAIL_CHARS: usize = 60;
const MAX_PAGE_URL: usize = 2048;

fn cut(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let kept: String = text.chars().take(limit).collect();
    format!("{kept}\u{2026}")
}

fn color(fill: &FillValue) -> String {
    match fill {
        FillValue::Token { name } => name.to_string(),
        FillValue::Hex { hex, opacity } if *opacity < 100 => {
            format!("{} {opacity}%", hex.to_ascii_uppercase())
        }
        FillValue::Hex { hex, .. } => hex.to_ascii_uppercase(),
        FillValue::None => "none".to_owned(),
    }
}

fn shadow(shadow: &ShadowValue) -> String {
    match shadow {
        ShadowValue::None => String::new(),
        ShadowValue::Token { name } => name.to_string(),
        ShadowValue::Custom { x, y, blur, .. } => {
            format!("{} {} {}", trimmed(*x), trimmed(*y), trimmed(*blur))
        }
    }
}

#[must_use]
pub fn described(props: &FinetuneProps) -> Option<String> {
    let mut parts = Vec::new();
    match &props.fill {
        Some(FillValue::None) => parts.push("No fill".to_owned()),
        Some(fill) => parts.push(format!("Fill {}", color(fill))),
        None => {}
    }
    match &props.radius {
        Some(RadiusValue::Token { name }) => parts.push(format!("Radius {}", name.as_str())),
        Some(RadiusValue::Px { px }) => parts.push(format!("Radius {px}")),
        Some(RadiusValue::Full) => parts.push("Radius full".to_owned()),
        None => {}
    }
    if let Some(text) = &props.text {
        if let Some(size) = text.size {
            parts.push(format!("Font size {}", trimmed(size)));
        }
        if let Some(weight) = text.weight {
            parts.push(format!("Weight {weight}"));
        }
        if let Some(family) = &text.family {
            parts.push(format!("Font {}", family.as_str()));
        }
        if let Some(line_height) = text.line_height {
            parts.push(format!("Line height {}", trimmed(line_height)));
        }
        if let Some(spacing) = text.letter_spacing {
            parts.push(format!("Letter spacing {}", trimmed(spacing)));
        }
        if let Some(align) = text.align {
            parts.push(format!("Align {align}"));
        }
        if let Some(fill) = &text.color {
            parts.push(format!("Text color {}", color(fill)));
        }
    }
    match &props.stroke {
        Some(StrokeValue::None) => parts.push("No stroke".to_owned()),
        Some(StrokeValue::Set {
            width,
            style,
            color: fill,
        }) => {
            let mut stroke = vec!["Stroke".to_owned()];
            stroke.extend(width.map(|width| format!("{width}px")));
            stroke.extend(style.map(|style| style.to_string()));
            stroke.extend(fill.as_ref().map(color));
            parts.push(stroke.join(" "));
        }
        None => {}
    }
    if let Some(effects) = &props.effects {
        let layers: Vec<String> = [("Shadow", &effects.drop), ("Inner shadow", &effects.inner)]
            .into_iter()
            .filter_map(|(name, value)| {
                value.as_ref().map(|value| match value {
                    ShadowValue::None => format!("No {}", name.to_lowercase()),
                    _ => format!("{name} {}", shadow(value)),
                })
            })
            .collect();
        if !layers.is_empty() {
            parts.push(layers.join(", "));
        }
    }
    if let Some(opacity) = props.opacity {
        parts.push(format!("Opacity {opacity}%"));
    }
    if let Some(layout) = &props.layout {
        if let Some(padding) = &layout.padding {
            let sides: Vec<String> = [
                ("top", padding.top),
                ("right", padding.right),
                ("bottom", padding.bottom),
                ("left", padding.left),
            ]
            .into_iter()
            .filter_map(|(side, value)| value.map(|px| format!("{side} {}", trimmed(px))))
            .collect();
            parts.push(format!("Padding {}", sides.join(", ")));
        }
        if let Some(gap) = &layout.gap {
            let axes: Vec<String> = [("rows", gap.row), ("columns", gap.column)]
                .into_iter()
                .filter_map(|(axis, value)| value.map(|px| format!("{axis} {}", trimmed(px))))
                .collect();
            parts.push(format!("Gap {}", axes.join(", ")));
        }
    }
    let text = props
        .content
        .first()
        .map(|edit| edit.value.as_str())
        .or_else(|| props.source.as_ref().map(|source| source.value.as_str()));
    if let Some(text) = text {
        parts.push(format!("Text '{}'", cut(text, 30)));
    }
    (!parts.is_empty()).then(|| cut(&parts.join(" · "), MAX_DETAIL_CHARS))
}

#[must_use]
pub fn component_name(path: &str, source: &str, line: NonZeroU64, column: NonZeroU64) -> String {
    jsx::enclosing_component(path, source, line.get(), column.get()).map_or_else(
        || {
            let name = path.rsplit('/').next().unwrap_or(path);
            name.split('.').next().unwrap_or(name).to_owned()
        },
        |component| component.name,
    )
}

#[must_use]
pub fn page_url(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let allowed = (raw.starts_with("http://") || raw.starts_with("https://"))
        && raw.len() <= MAX_PAGE_URL
        && !raw.chars().any(char::is_control);
    allowed.then(|| raw.to_owned())
}

#[must_use]
pub fn entry(row: Row) -> HistoryEntry {
    let src = row.meta.src.as_deref().and_then(|src| {
        let (rest, column) = src.rsplit_once(':')?;
        let (path, line) = rest.rsplit_once(':')?;
        Some(match row.line {
            Some(current) => format!("{path}:{current}:{column}"),
            None => format!("{path}:{line}:{column}"),
        })
    });
    HistoryEntry {
        at_ms: row.at_ms,
        files: row.files,
        id: row.id,
        origin: row.origin,
        page_url: row.meta.page_url,
        prompt: row.meta.prompt,
        src,
        state: if row.applied {
            HistoryEntryState::Applied
        } else {
            HistoryEntryState::Undone
        },
        title: row.title,
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU64;

    use gjd_core::contracts::FinetuneProps;

    use super::{component_name, described, page_url};

    fn props(value: serde_json::Value) -> FinetuneProps {
        serde_json::from_value(value).expect("props")
    }

    #[test]
    fn describes_what_a_fine_tune_changed_in_words() {
        assert_eq!(
            described(&props(serde_json::json!({
                "fill": { "kind": "hex", "hex": "#2563eb", "opacity": 100 },
                "layout": { "padding": { "top": 24 } }
            }))),
            Some("Fill #2563EB · Padding top 24".to_owned())
        );
        assert_eq!(
            described(&props(
                serde_json::json!({ "content": [{ "run": 0, "value": "Slow-roast" }] })
            )),
            Some("Text 'Slow-roast'".to_owned())
        );
        assert_eq!(
            described(&props(
                serde_json::json!({ "effects": { "drop": { "kind": "none" } }, "opacity": 50 })
            )),
            Some("No shadow · Opacity 50%".to_owned())
        );
        assert_eq!(described(&FinetuneProps::default()), None);
    }

    #[test]
    fn names_the_component_or_the_file() {
        let at = |value| NonZeroU64::new(value).expect("1-based");
        let source = "export function OrderButton() {\n  return <button>Go</button>;\n}\n";
        assert_eq!(
            component_name("src/OrderButton.tsx", source, at(2), at(10)),
            "OrderButton"
        );
        assert_eq!(
            component_name(
                "src/App.vue",
                "<template><p>x</p></template>",
                at(1),
                at(11)
            ),
            "App"
        );
    }

    #[test]
    fn keeps_only_web_page_addresses() {
        assert_eq!(
            page_url(Some("http://localhost:5173/menu?x=1")),
            Some("http://localhost:5173/menu?x=1".to_owned())
        );
        assert_eq!(page_url(Some("javascript:alert(1)")), None);
        assert_eq!(
            page_url(Some(&format!("http://a/{}", "x".repeat(3000)))),
            None
        );
        assert_eq!(page_url(None), None);
    }
}
