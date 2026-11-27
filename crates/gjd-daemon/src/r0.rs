use std::num::NonZeroU64;

use gjd_core::contracts::{
    ElementStyle, FillValue, FillValueHex, FillValueName, FinetuneProps, LayoutValue, PaddingValue,
    RadiusValue, RadiusValueName, TextValue,
};
use gjd_core::tailwind::{FONT_WEIGHTS, PALETTE};

const FILLER: [&str; 30] = [
    "make",
    "it",
    "its",
    "this",
    "that",
    "the",
    "a",
    "an",
    "and",
    "with",
    "to",
    "be",
    "please",
    "set",
    "change",
    "turn",
    "into",
    "color",
    "colour",
    "background",
    "bg",
    "fill",
    "shape",
    "shaped",
    "corners",
    "corner",
    "edges",
    "button",
    "element",
    "now",
];
const FULL_RADIUS: [&str; 7] = [
    "pill",
    "pill-shaped",
    "pillshaped",
    "round",
    "circle",
    "circular",
    "rounded-full",
];
const NO_RADIUS: [&str; 4] = ["square", "squared", "sharp", "sharp-cornered"];
const RADIUS_WORDS: [&str; 3] = ["radius", "corners", "corner"];
const PADDING_WORDS: [&str; 1] = ["padding"];
const WEIGHT_WORDS: [&str; 3] = ["weight", "font-weight", "font"];

fn weight_word(word: &str) -> Option<i64> {
    let word = word.strip_prefix("font-").unwrap_or(word);
    FONT_WEIGHTS
        .iter()
        .find(|(name, _)| *name == word && *name != "black")
        .map(|(_, weight)| *weight)
}

fn weight(value: i64) -> Option<TextValue> {
    let weight = NonZeroU64::new(u64::try_from(value).ok()?)?;
    Some(TextValue {
        weight: Some(weight),
        ..TextValue::default()
    })
}

fn words(prompt: &str) -> Vec<String> {
    prompt
        .to_lowercase()
        .split(|c: char| !(c.is_alphanumeric() || c == '#' || c == '-'))
        .map(|word| word.trim_matches('-').to_owned())
        .filter(|word| !word.is_empty())
        .collect()
}

fn token(name: String) -> Option<FillValue> {
    FillValueName::try_from(name)
        .ok()
        .map(|name| FillValue::Token { name })
}

fn color(word: &str, style: &ElementStyle) -> Option<FillValue> {
    if let Some(hex) = word.strip_prefix('#') {
        let hex = match hex.len() {
            3 => hex.chars().flat_map(|c| [c, c]).collect(),
            6 => hex.to_owned(),
            _ => return None,
        };
        let hex = FillValueHex::try_from(format!("#{}", hex.to_uppercase())).ok()?;
        return Some(FillValue::Hex { hex, opacity: 100 });
    }
    if let Some(theme) = style
        .theme
        .colors
        .iter()
        .find(|color| color.name.eq_ignore_ascii_case(word))
    {
        return token(theme.name.clone());
    }
    match word {
        "white" | "black" | "transparent" => token(word.to_owned()),
        "grey" => token("gray-600".to_owned()),
        palette if PALETTE.contains(&palette) => token(format!("{palette}-600")),
        _ => None,
    }
}

fn pixels(word: &str) -> Option<i64> {
    let number = word.strip_suffix("px").unwrap_or(word);
    number
        .parse::<i64>()
        .ok()
        .filter(|px| (0..=999).contains(px))
}

fn radius_of(px: i64, style: &ElementStyle) -> Option<RadiusValue> {
    let exact = f64::from(u16::try_from(px).ok()?);
    let named = style
        .theme
        .radii
        .iter()
        .find(|radius| (radius.px - exact).abs() < f64::EPSILON);
    match named {
        Some(radius) => RadiusValueName::try_from(radius.name.clone())
            .ok()
            .map(|name| RadiusValue::Token { name }),
        None => Some(RadiusValue::Px { px }),
    }
}

fn set<T>(slot: &mut Option<T>, value: T) -> Option<()> {
    slot.replace(value).is_none().then_some(())
}

pub fn parse_property_edits(prompt: &str, style: &ElementStyle) -> Option<FinetuneProps> {
    let words = words(prompt);
    let mut fill = None;
    let mut radius = None;
    let mut text = None;
    let mut padding = None;
    let mut index = 0;
    while let Some(word) = words.get(index).map(String::as_str) {
        let next = words.get(index + 1).map(String::as_str);
        let previous = index
            .checked_sub(1)
            .and_then(|at| words.get(at))
            .map(String::as_str);
        let near = |list: &[&str]| {
            next.is_some_and(|next| list.contains(&next))
                || previous.is_some_and(|previous| list.contains(&previous))
        };
        if let Some(px) = pixels(word) {
            if near(&RADIUS_WORDS) {
                set(&mut radius, radius_of(px, style)?)?;
            } else if near(&PADDING_WORDS) {
                set(&mut padding, f64::from(u16::try_from(px).ok()?))?;
            } else if near(&WEIGHT_WORDS) && px % 100 == 0 && (100..=900).contains(&px) {
                set(&mut text, weight(px)?)?;
            } else {
                return None;
            }
        } else if let Some(value) = weight_word(word) {
            set(&mut text, weight(value)?)?;
        } else if let Some(value) = color(word, style) {
            set(&mut fill, value)?;
        } else if FULL_RADIUS.contains(&word) {
            set(&mut radius, RadiusValue::Full)?;
        } else if NO_RADIUS.contains(&word) {
            set(
                &mut radius,
                RadiusValue::Token {
                    name: RadiusValueName::try_from("none".to_owned()).ok()?,
                },
            )?;
        } else if !FILLER.contains(&word)
            && !RADIUS_WORDS.contains(&word)
            && !PADDING_WORDS.contains(&word)
            && !WEIGHT_WORDS.contains(&word)
        {
            return None;
        }
        index += 1;
    }
    let layout = padding.map(|px| LayoutValue {
        padding: Some(PaddingValue {
            top: Some(px),
            right: Some(px),
            bottom: Some(px),
            left: Some(px),
        }),
        gap: None,
    });
    (fill.is_some() || radius.is_some() || text.is_some() || layout.is_some()).then_some(
        FinetuneProps {
            fill,
            radius,
            text,
            layout,
            ..Default::default()
        },
    )
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU64;

    use gjd_core::contracts::{ElementStyle, FillValue, RadiusValue};
    use gjd_core::theme::Theme;
    use serde_json::json;

    use super::parse_property_edits;

    const BUTTON: &str =
        "export const B = () => <button className=\"rounded-lg bg-brand px-6\">Go</button>;\n";

    fn style() -> ElementStyle {
        let theme = Theme::from_css(["@theme { --color-brand: #be123c; --radius-card: 14px; }"]);
        let at = |value| NonZeroU64::new(value).expect("1-based");
        gjd_core::style::inspect("src/B.tsx", BUTTON, at(1), at(24), &theme).expect("element")
    }

    fn parsed(prompt: &str) -> Option<serde_json::Value> {
        parse_property_edits(prompt, &style())
            .map(|props| serde_json::to_value(props).expect("json"))
    }

    #[test]
    fn reads_colors_and_shapes_it_can_write_exactly() {
        assert_eq!(
            parsed("make it blue and pill-shaped"),
            Some(
                json!({ "fill": { "kind": "token", "name": "blue-600" }, "radius": { "kind": "full" } })
            )
        );
        assert_eq!(
            parsed("Brand background"),
            Some(json!({ "fill": { "kind": "token", "name": "brand" } }))
        );
        assert_eq!(
            parsed("#1d4ed8, square corners"),
            Some(json!({
                "fill": { "kind": "hex", "hex": "#1D4ED8", "opacity": 100 },
                "radius": { "kind": "token", "name": "none" }
            }))
        );
        assert_eq!(
            parsed("radius 14px"),
            Some(json!({ "radius": { "kind": "token", "name": "card" } }))
        );
        assert_eq!(
            parsed("5px corners"),
            Some(json!({ "radius": { "kind": "px", "px": 5 } }))
        );
    }

    #[test]
    fn reads_weights_and_padding_it_can_write_exactly() {
        assert_eq!(
            parsed("make it bold"),
            Some(json!({ "text": { "weight": 700 } }))
        );
        assert_eq!(
            parsed("font-semibold"),
            Some(json!({ "text": { "weight": 600 } }))
        );
        assert_eq!(
            parsed("font weight 300"),
            Some(json!({ "text": { "weight": 300 } }))
        );
        assert_eq!(
            parsed("padding 16px"),
            Some(
                json!({ "layout": { "padding": { "top": 16.0, "right": 16.0, "bottom": 16.0, "left": 16.0 } } })
            )
        );
        assert_eq!(
            parsed("black"),
            Some(json!({ "fill": { "kind": "token", "name": "black" } }))
        );
    }

    #[test]
    fn leaves_anything_else_to_the_model() {
        for prompt in [
            "make it blue with a soft shadow",
            "make it feel premium",
            "blue or red",
            "more padding",
            "padding 8px and a shadow",
            "bolder",
            "what color is this?",
            "",
        ] {
            assert_eq!(parsed(prompt), None, "{prompt}");
        }
    }

    #[test]
    fn writes_values_the_codemod_accepts() {
        let style = style();
        let theme = Theme::from_css(["@theme { --color-brand: #be123c; --radius-card: 14px; }"]);
        let props = parse_property_edits("make it blue and pill-shaped", &style).expect("exact");

        let op = gjd_core::codemod::finetune_op(&style, &props, &theme).expect("op");

        let op = serde_json::to_value(op).expect("json");
        assert_eq!(op["add"], json!(["bg-blue-600", "rounded-full"]));
        assert!(matches!(props.fill, Some(FillValue::Token { .. })));
        assert!(matches!(props.radius, Some(RadiusValue::Full)));
    }
}
