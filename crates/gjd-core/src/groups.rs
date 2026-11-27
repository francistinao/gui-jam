use crate::codemod::{CodemodError, color_token, fill_style};
use crate::contracts::{
    EditOpValue, ElementStyle, FinetuneProps, GapValue, PaddingValue, ShadowValue, StrokeValue,
    StrokeValueStyle, StyleGroup, StyleToken, TextValue,
};
use crate::tailwind::{FONT_WEIGHTS, trimmed};
use crate::theme::Theme;

const MAX_PX: f64 = 999.0;
const FONT_FAMILIES: [&str; 3] = ["sans", "serif", "mono"];
const V3_SPACING: [f64; 34] = [
    0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 14.0,
    16.0, 20.0, 24.0, 28.0, 32.0, 36.0, 40.0, 44.0, 48.0, 52.0, 56.0, 60.0, 64.0, 72.0, 80.0, 96.0,
];
const V3_BORDER_WIDTHS: [i64; 3] = [2, 4, 8];
const PADDING_SIDES: [&str; 4] = ["top", "right", "bottom", "left"];

#[must_use]
pub fn has_group_change(props: &FinetuneProps) -> bool {
    props.text.is_some()
        || props.stroke.is_some()
        || props.effects.is_some()
        || props.opacity.is_some()
        || props.layout.is_some()
}

#[derive(Default)]
pub struct ClassChange {
    pub add: Vec<String>,
    pub remove: Vec<String>,
}

impl ClassChange {
    fn replace<'s>(&mut self, tokens: impl IntoIterator<Item = &'s StyleToken>) {
        for token in tokens {
            if !self.remove.contains(&token.token) {
                self.remove.push(token.token.clone());
            }
        }
    }
}

fn editable<'s, 'p>(
    style: &'s ElementStyle,
    group: StyleGroup,
    properties: &'p [&'p str],
) -> impl Iterator<Item = &'s StyleToken> + use<'s, 'p> {
    style.tokens.iter().filter(move |token| {
        token.editable
            && token.group == group
            && (properties.is_empty() || properties.contains(&token.property.as_str()))
    })
}

fn in_range(what: &'static str, value: f64, min: f64, max: f64) -> Result<f64, CodemodError> {
    if value.is_finite() && (min..=max).contains(&value) {
        Ok(value)
    } else {
        Err(CodemodError::OutOfRange {
            what,
            value: trimmed(value),
        })
    }
}

fn same(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.001
}

fn weight_px(value: u64) -> f64 {
    u32::try_from(value).map_or(f64::MAX, f64::from)
}

fn whole(value: i64) -> f64 {
    i32::try_from(value).map_or(f64::MAX, f64::from)
}

fn px(value: f64) -> String {
    if value == 0.0 {
        "0".to_owned()
    } else {
        format!("{}px", trimmed(value))
    }
}

fn token_px(token: &StyleToken) -> Option<f64> {
    token
        .value
        .as_deref()?
        .strip_suffix("px")?
        .trim()
        .parse()
        .ok()
}

pub fn class_change(
    style: &ElementStyle,
    props: &FinetuneProps,
    theme: &Theme,
) -> Result<ClassChange, CodemodError> {
    let mut change = ClassChange::default();
    if let Some(text) = &props.text {
        text_classes(style, text, theme, &mut change)?;
    }
    if let Some(stroke) = &props.stroke {
        stroke_classes(style, stroke, theme, &mut change)?;
    }
    if let Some(effects) = &props.effects {
        change.replace(editable(
            style,
            StyleGroup::Effects,
            &[
                "shadow",
                "shadow-color",
                "inset-shadow",
                "inset-shadow-color",
            ],
        ));
        let drop = effects
            .drop
            .as_ref()
            .map(|shadow| shadow_css(shadow, false, theme))
            .transpose()?;
        let inner = effects
            .inner
            .as_ref()
            .map(|shadow| shadow_css(shadow, true, theme))
            .transpose()?;
        if theme.legacy() {
            let layers: Vec<String> = drop.into_iter().chain(inner).collect();
            if !layers.is_empty() {
                change
                    .add
                    .push(format!("shadow-[{}]", layers.join(",").replace(' ', "_")));
            }
        } else {
            if let Some(drop) = &effects.drop {
                change.add.push(shadow_class(drop, false));
            }
            if let Some(inner) = &effects.inner {
                change.add.push(shadow_class(inner, true));
            }
        }
    }
    if let Some(opacity) = props.opacity {
        let percent = in_range("opacity", whole(opacity), 0.0, 100.0)?;
        change.replace(editable(style, StyleGroup::Opacity, &[]));
        if percent < 100.0 {
            change.add.push(if theme.legacy() && opacity % 5 != 0 {
                format!("opacity-[{}]", trimmed(percent / 100.0))
            } else {
                format!("opacity-{opacity}")
            });
        }
    }
    if let Some(layout) = &props.layout {
        if let Some(padding) = &layout.padding {
            padding_classes(style, padding, theme, &mut change)?;
        }
        if let Some(gap) = &layout.gap {
            gap_classes(style, gap, theme, &mut change)?;
        }
    }
    Ok(change)
}

fn text_classes(
    style: &ElementStyle,
    text: &TextValue,
    theme: &Theme,
    change: &mut ClassChange,
) -> Result<(), CodemodError> {
    if let Some(family) = &text.family {
        let name = family.as_str();
        if !FONT_FAMILIES.contains(&name) && !theme.has_font(name) {
            return Err(CodemodError::UnknownFont(name.to_owned()));
        }
        change.replace(editable(style, StyleGroup::Text, &["family"]));
        change.add.push(format!("font-{name}"));
    }
    if let Some(weight) = text.weight {
        let weight = weight.get();
        in_range("font weight", weight_px(weight), 1.0, 1000.0)?;
        change.replace(editable(style, StyleGroup::Text, &["weight"]));
        change.add.push(
            FONT_WEIGHTS
                .iter()
                .find(|(_, value)| u64::try_from(*value).ok() == Some(weight))
                .map_or_else(
                    || format!("font-[{weight}]"),
                    |(name, _)| format!("font-{name}"),
                ),
        );
    }
    let size_token = editable(style, StyleGroup::Text, &["size"]).next();
    let modifier = size_token.and_then(|token| token.token.rsplit_once('/').map(|(_, m)| m));
    if let Some(size) = text.size {
        let size = in_range("font size", size, 1.0, MAX_PX)?;
        change.replace(editable(style, StyleGroup::Text, &["size"]));
        let base = theme
            .text_named(size)
            .map_or_else(|| format!("[{}px]", trimmed(size)), str::to_owned);
        change.add.push(match modifier {
            Some(modifier) if text.line_height.is_none() => format!("text-{base}/{modifier}"),
            _ => format!("text-{base}"),
        });
    } else if text.line_height.is_some()
        && let (Some(token), Some(modifier)) = (size_token, modifier)
    {
        change.replace([token]);
        change.add.push(
            token
                .token
                .strip_suffix(&format!("/{modifier}"))
                .unwrap_or(&token.token)
                .to_owned(),
        );
    }
    if let Some(line_height) = text.line_height {
        let line_height = in_range("line height", line_height, 0.0, MAX_PX)?;
        change.replace(editable(style, StyleGroup::Text, &["line-height"]));
        change
            .add
            .push(spacing_class("leading", line_height, theme, false));
    }
    if let Some(spacing) = text.letter_spacing {
        let em = in_range("letter spacing", spacing, -1.0, 1.0)?;
        change.replace(editable(style, StyleGroup::Text, &["letter-spacing"]));
        change.add.push(theme.tracking_named(em).map_or_else(
            || format!("tracking-[{}em]", trimmed(em)),
            |name| format!("tracking-{name}"),
        ));
    }
    if let Some(align) = text.align {
        change.replace(editable(style, StyleGroup::Text, &["align"]));
        change.add.push(format!("text-{align}"));
    }
    if let Some(color) = &text.color {
        change.replace(editable(style, StyleGroup::Text, &["color"]));
        change.add.extend(color_token("text", color, theme)?);
    }
    Ok(())
}

fn stroke_classes(
    style: &ElementStyle,
    stroke: &StrokeValue,
    theme: &Theme,
    change: &mut ClassChange,
) -> Result<(), CodemodError> {
    let StrokeValue::Set {
        width,
        style: line,
        color,
    } = stroke
    else {
        change.replace(editable(style, StyleGroup::Stroke, &[]));
        return Ok(());
    };
    if let Some(width) = *width {
        in_range("border width", whole(width), 0.0, MAX_PX)?;
        change.replace(editable(style, StyleGroup::Stroke, &["width"]));
        change.add.push(match width {
            1 => "border".to_owned(),
            0 => "border-0".to_owned(),
            _ if theme.legacy() && !V3_BORDER_WIDTHS.contains(&width) => {
                format!("border-[{width}px]")
            }
            _ => format!("border-{width}"),
        });
    }
    if let Some(line) = line {
        change.replace(editable(style, StyleGroup::Stroke, &["style"]));
        if *line != StrokeValueStyle::Solid {
            change.add.push(format!("border-{line}"));
        }
    }
    if let Some(color) = color {
        change.replace(editable(style, StyleGroup::Stroke, &["color"]));
        change.add.extend(color_token("border", color, theme)?);
    }
    Ok(())
}

fn shadow_class(shadow: &ShadowValue, inset: bool) -> String {
    let prefix = if inset { "inset-shadow" } else { "shadow" };
    match shadow {
        ShadowValue::Token { name } => format!("{prefix}-{}", name.as_str()),
        ShadowValue::Custom { .. } => format!(
            "{prefix}-[{}]",
            custom_shadow(shadow).unwrap_or_default().replace(' ', "_")
        ),
    }
}

fn custom_shadow(shadow: &ShadowValue) -> Option<String> {
    let ShadowValue::Custom {
        x,
        y,
        blur,
        spread,
        hex,
        opacity,
    } = shadow
    else {
        return None;
    };
    let color = hex_color(hex, *opacity);
    Some(format!(
        "{} {} {} {} {color}",
        px(*x),
        px(*y),
        px(*blur),
        px(*spread)
    ))
}

fn hex_color(hex: &str, opacity: i64) -> String {
    let hex = hex.to_ascii_uppercase();
    if opacity >= 100 {
        return hex;
    }
    let channel = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).unwrap_or(0);
    format!(
        "rgba({},{},{},{})",
        channel(1),
        channel(3),
        channel(5),
        trimmed(whole(opacity) / 100.0)
    )
}

fn shadow_css(shadow: &ShadowValue, inset: bool, theme: &Theme) -> Result<String, CodemodError> {
    match shadow {
        ShadowValue::Token { name } => {
            let value = theme
                .shadow(name, inset)
                .ok_or_else(|| CodemodError::UnknownShadow(name.to_string()))?;
            Ok(value.to_owned())
        }
        ShadowValue::Custom {
            x,
            y,
            blur,
            spread,
            opacity,
            ..
        } => {
            for (what, value, min) in [
                ("shadow x", *x, -MAX_PX),
                ("shadow y", *y, -MAX_PX),
                ("shadow blur", *blur, 0.0),
                ("shadow spread", *spread, -MAX_PX),
            ] {
                in_range(what, value, min, MAX_PX)?;
            }
            in_range("shadow opacity", whole(*opacity), 0.0, 100.0)?;
            let css = custom_shadow(shadow).unwrap_or_default();
            Ok(if inset { format!("inset {css}") } else { css })
        }
    }
}

fn spacing_class(prefix: &str, value: f64, theme: &Theme, allow_px: bool) -> String {
    let steps = value / theme.spacing();
    let on_scale = if theme.legacy() {
        V3_SPACING.iter().any(|step| (step - steps).abs() < 0.001)
    } else {
        ((steps * 2.0).round() - steps * 2.0).abs() < 0.001
    };
    if allow_px && (value - 1.0).abs() < 0.001 {
        format!("{prefix}-px")
    } else if value == 0.0 {
        format!("{prefix}-0")
    } else if on_scale {
        format!("{prefix}-{}", trimmed(steps))
    } else {
        format!("{prefix}-[{}px]", trimmed(value))
    }
}

type Sides = [Option<f64>; 4];

fn padding_classes(
    style: &ElementStyle,
    padding: &PaddingValue,
    theme: &Theme,
    change: &mut ClassChange,
) -> Result<(), CodemodError> {
    let given = given_sides(padding)?;
    let logical = given[1].is_some() || given[3].is_some();
    let mut sides: Sides = [None; 4];
    let mut readable = Vec::new();
    for property in [
        "padding",
        "padding-x",
        "padding-y",
        "padding-start",
        "padding-end",
        "padding-top",
        "padding-right",
        "padding-bottom",
        "padding-left",
    ] {
        if !logical && matches!(property, "padding-start" | "padding-end") {
            continue;
        }
        for token in editable(style, StyleGroup::Layout, &[property]) {
            let Some(value) = token_px(token) else {
                continue;
            };
            let covers: &[usize] = match property {
                "padding" => &[0, 1, 2, 3],
                "padding-x" => &[1, 3],
                "padding-y" => &[0, 2],
                "padding-top" => &[0],
                "padding-right" | "padding-end" => &[1],
                "padding-bottom" => &[2],
                _ => &[3],
            };
            for side in covers {
                sides[*side] = Some(value);
            }
            readable.push(token);
        }
    }
    change.replace(readable);
    for (side, value) in given.iter().enumerate() {
        if value.is_some() {
            sides[side] = *value;
        }
    }
    let [top, right, bottom, left] = sides;
    let class = |prefix: &str, value: f64| spacing_class(prefix, value, theme, true);
    if sides.iter().all(Option::is_some) && sides.iter().all(|side| *side == top) {
        change.add.push(class("p", top.unwrap_or_default()));
        return Ok(());
    }
    pair(&mut change.add, ("py", "pt", "pb"), top, bottom, class);
    pair(&mut change.add, ("px", "pl", "pr"), left, right, class);
    Ok(())
}

fn pair(
    add: &mut Vec<String>,
    (both, first_prefix, second_prefix): (&str, &str, &str),
    first: Option<f64>,
    second: Option<f64>,
    class: impl Fn(&str, f64) -> String,
) {
    match (first, second) {
        (Some(a), Some(b)) if same(a, b) => add.push(class(both, a)),
        _ => {
            if let Some(a) = first {
                add.push(class(first_prefix, a));
            }
            if let Some(b) = second {
                add.push(class(second_prefix, b));
            }
        }
    }
}

fn given_sides(padding: &PaddingValue) -> Result<Sides, CodemodError> {
    let mut sides = [padding.top, padding.right, padding.bottom, padding.left];
    for (side, value) in sides.iter_mut().enumerate() {
        if let Some(px) = value {
            *px = in_range(PADDING_SIDES[side], *px, 0.0, MAX_PX)?;
        }
    }
    Ok(sides)
}

fn gap_axes(gap: &GapValue) -> Result<(Option<f64>, Option<f64>), CodemodError> {
    let check = |value: Option<f64>| value.map(|px| in_range("gap", px, 0.0, MAX_PX)).transpose();
    Ok((check(gap.row)?, check(gap.column)?))
}

fn gap_classes(
    style: &ElementStyle,
    gap: &GapValue,
    theme: &Theme,
    change: &mut ClassChange,
) -> Result<(), CodemodError> {
    let (given_row, given_column) = gap_axes(gap)?;
    let (mut row, mut column) = (None, None);
    let mut readable = Vec::new();
    for property in ["gap", "row-gap", "column-gap"] {
        for token in editable(style, StyleGroup::Layout, &[property]) {
            let Some(value) = token_px(token) else {
                continue;
            };
            if property != "column-gap" {
                row = Some(value);
            }
            if property != "row-gap" {
                column = Some(value);
            }
            readable.push(token);
        }
    }
    change.replace(readable);
    let row = given_row.or(row);
    let column = given_column.or(column);
    let class = |prefix: &str, value: f64| spacing_class(prefix, value, theme, true);
    pair(
        &mut change.add,
        ("gap", "gap-y", "gap-x"),
        row,
        column,
        class,
    );
    Ok(())
}

pub fn style_changes(
    style: &ElementStyle,
    props: &FinetuneProps,
    theme: &Theme,
) -> Result<Vec<(&'static str, EditOpValue)>, CodemodError> {
    let mut changes = Vec::new();
    if let Some(text) = &props.text {
        text_styles(text, theme, &mut changes)?;
    }
    if let Some(stroke) = &props.stroke {
        stroke_styles(style, stroke, theme, &mut changes)?;
    }
    if let Some(effects) = &props.effects {
        let layers: Vec<String> = [(&effects.drop, false), (&effects.inner, true)]
            .into_iter()
            .filter_map(|(shadow, inset)| shadow.as_ref().map(|shadow| (shadow, inset)))
            .map(|(shadow, inset)| shadow_css(shadow, inset, theme))
            .collect::<Result<_, _>>()?;
        changes.push((
            "boxShadow",
            if layers.is_empty() {
                EditOpValue::Null
            } else {
                EditOpValue::String(layers.join(", "))
            },
        ));
    }
    if let Some(opacity) = props.opacity {
        let percent = in_range("opacity", whole(opacity), 0.0, 100.0)?;
        changes.push((
            "opacity",
            if percent >= 100.0 {
                EditOpValue::Null
            } else {
                EditOpValue::Number(percent / 100.0)
            },
        ));
    }
    if let Some(layout) = &props.layout {
        if let Some(padding) = &layout.padding {
            padding_styles(style, padding, &mut changes)?;
        }
        if let Some(gap) = &layout.gap {
            gap_styles(style, gap, &mut changes)?;
        }
    }
    Ok(changes)
}

fn text_styles(
    text: &TextValue,
    theme: &Theme,
    changes: &mut Vec<(&'static str, EditOpValue)>,
) -> Result<(), CodemodError> {
    if let Some(family) = &text.family {
        let name = family.as_str();
        let value = theme
            .font_value(name)
            .ok_or_else(|| CodemodError::UnknownFont(name.to_owned()))?;
        changes.push((
            "fontFamily",
            EditOpValue::String(format!("var(--font-{name}, {})", value.replace('"', "'"))),
        ));
    }
    if let Some(weight) = text.weight {
        changes.push((
            "fontWeight",
            EditOpValue::Number(in_range(
                "font weight",
                weight_px(weight.get()),
                1.0,
                1000.0,
            )?),
        ));
    }
    if let Some(size) = text.size {
        changes.push((
            "fontSize",
            EditOpValue::Number(in_range("font size", size, 1.0, MAX_PX)?),
        ));
    }
    if let Some(line_height) = text.line_height {
        let line_height = in_range("line height", line_height, 0.0, MAX_PX)?;
        changes.push((
            "lineHeight",
            EditOpValue::String(format!("{}px", trimmed(line_height))),
        ));
    }
    if let Some(spacing) = text.letter_spacing {
        let em = in_range("letter spacing", spacing, -1.0, 1.0)?;
        changes.push((
            "letterSpacing",
            EditOpValue::String(format!("{}em", trimmed(em))),
        ));
    }
    if let Some(align) = text.align {
        changes.push(("textAlign", EditOpValue::String(align.to_string())));
    }
    if let Some(color) = &text.color {
        changes.push(("color", fill_style(color, theme)?));
    }
    Ok(())
}

fn inline_value<'s>(style: &'s ElementStyle, property: &str) -> Option<&'s str> {
    style
        .tokens
        .iter()
        .find(|token| token.property == property && token.editable)
        .and_then(|token| token.value.as_deref())
}

fn has_inline(style: &ElementStyle, property: &str) -> bool {
    style.tokens.iter().any(|token| token.property == property)
}

fn stroke_styles(
    style: &ElementStyle,
    stroke: &StrokeValue,
    theme: &Theme,
    changes: &mut Vec<(&'static str, EditOpValue)>,
) -> Result<(), CodemodError> {
    const LONGHANDS: [(&str, &str); 3] = [
        ("borderWidth", "border-width"),
        ("borderStyle", "border-style"),
        ("borderColor", "border-color"),
    ];
    let StrokeValue::Set {
        width,
        style: line,
        color,
    } = stroke
    else {
        changes.push(("border", EditOpValue::Null));
        changes.extend(LONGHANDS.map(|(key, _)| (key, EditOpValue::Null)));
        return Ok(());
    };
    if let Some(width) = *width {
        in_range("border width", whole(width), 0.0, MAX_PX)?;
    }
    let color = color
        .as_ref()
        .map(|color| fill_style(color, theme))
        .transpose()?;
    let color = color.and_then(|value| match value {
        EditOpValue::String(text) => Some(text),
        EditOpValue::Number(_) | EditOpValue::Null => None,
    });
    if let Some(shorthand) = inline_value(style, "border") {
        let (old_width, old_line, old_color) = border_parts(shorthand);
        let merged = [
            width.map_or(old_width, |width| Some(format!("{width}px"))),
            line.map(|line| line.to_string()).or(old_line),
            color.or(old_color),
        ];
        let text: Vec<String> = merged.into_iter().flatten().collect();
        changes.push(("border", EditOpValue::String(text.join(" "))));
        for (key, property) in LONGHANDS {
            if has_inline(style, property) {
                changes.push((key, EditOpValue::Null));
            }
        }
        return Ok(());
    }
    if let Some(width) = *width {
        changes.push(("borderWidth", EditOpValue::Number(whole(width))));
    }
    let line = line.map(|line| line.to_string()).or_else(|| {
        (width.is_some_and(|width| width > 0) && !has_inline(style, "border-style"))
            .then(|| "solid".to_owned())
    });
    if let Some(line) = line {
        changes.push(("borderStyle", EditOpValue::String(line)));
    }
    if let Some(color) = color {
        changes.push(("borderColor", EditOpValue::String(color)));
    }
    Ok(())
}

fn border_parts(shorthand: &str) -> (Option<String>, Option<String>, Option<String>) {
    let mut width = None;
    let mut line = None;
    let mut color = Vec::new();
    for part in css_words(shorthand) {
        if width.is_none() && part.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            width = Some(part);
        } else if line.is_none()
            && [
                "solid", "dashed", "dotted", "double", "none", "hidden", "groove", "ridge",
            ]
            .contains(&part.as_str())
        {
            line = Some(part);
        } else {
            color.push(part);
        }
    }
    let color = (!color.is_empty()).then(|| color.join(" "));
    (width, line, color)
}

fn css_words(value: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut depth = 0i32;
    let mut word = String::new();
    for ch in value.chars() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        if ch.is_whitespace() && depth == 0 {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
        } else {
            word.push(ch);
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

fn css_px(word: &str) -> Option<f64> {
    if word == "0" {
        return Some(0.0);
    }
    word.strip_suffix("px")
        .or_else(|| word.parse::<f64>().ok().map(|_| word))
        .and_then(|number| number.parse().ok())
}

fn spread_sides(words: &[f64]) -> Option<[f64; 4]> {
    match *words {
        [all] => Some([all; 4]),
        [vertical, horizontal] => Some([vertical, horizontal, vertical, horizontal]),
        [top, horizontal, bottom] => Some([top, horizontal, bottom, horizontal]),
        [top, right, bottom, left] => Some([top, right, bottom, left]),
        _ => None,
    }
}

fn shortest_sides([top, right, bottom, left]: [f64; 4]) -> EditOpValue {
    let px = |value: f64| format!("{}px", trimmed(value));
    if same(top, right) && same(right, bottom) && same(bottom, left) {
        return EditOpValue::Number(top);
    }
    let words = if same(right, left) && same(top, bottom) {
        vec![px(top), px(right)]
    } else if same(right, left) {
        vec![px(top), px(right), px(bottom)]
    } else {
        vec![px(top), px(right), px(bottom), px(left)]
    };
    EditOpValue::String(words.join(" "))
}

fn padding_styles(
    style: &ElementStyle,
    padding: &PaddingValue,
    changes: &mut Vec<(&'static str, EditOpValue)>,
) -> Result<(), CodemodError> {
    const LONGHANDS: [(&str, &str); 4] = [
        ("paddingTop", "padding-top"),
        ("paddingRight", "padding-right"),
        ("paddingBottom", "padding-bottom"),
        ("paddingLeft", "padding-left"),
    ];
    let given = given_sides(padding)?;
    let shorthand = inline_value(style, "padding").and_then(|value| {
        let words: Option<Vec<f64>> = css_words(value).iter().map(|word| css_px(word)).collect();
        spread_sides(&words?)
    });
    if let Some(mut sides) = shorthand {
        for (side, (_, property)) in LONGHANDS.iter().enumerate() {
            if let Some(value) = inline_value(style, property).and_then(css_px) {
                sides[side] = value;
            }
        }
        for (side, value) in given.iter().enumerate() {
            if let Some(value) = value {
                sides[side] = *value;
            }
        }
        changes.push(("padding", shortest_sides(sides)));
        for (key, property) in LONGHANDS {
            if has_inline(style, property) {
                changes.push((key, EditOpValue::Null));
            }
        }
        return Ok(());
    }
    for (side, value) in given.iter().enumerate() {
        if let Some(value) = value {
            changes.push((LONGHANDS[side].0, EditOpValue::Number(*value)));
        }
    }
    Ok(())
}

fn gap_styles(
    style: &ElementStyle,
    gap: &GapValue,
    changes: &mut Vec<(&'static str, EditOpValue)>,
) -> Result<(), CodemodError> {
    let (given_row, given_column) = gap_axes(gap)?;
    let shorthand = inline_value(style, "gap").and_then(|value| {
        let words: Option<Vec<f64>> = css_words(value).iter().map(|word| css_px(word)).collect();
        match words?.as_slice() {
            [both] => Some((*both, *both)),
            [row, column] => Some((*row, *column)),
            _ => None,
        }
    });
    let value = |row: f64, column: f64| {
        if same(row, column) {
            EditOpValue::Number(row)
        } else {
            EditOpValue::String(format!("{}px {}px", trimmed(row), trimmed(column)))
        }
    };
    if let Some((row, column)) = shorthand {
        let row = inline_value(style, "row-gap")
            .and_then(css_px)
            .unwrap_or(row);
        let column = inline_value(style, "column-gap")
            .and_then(css_px)
            .unwrap_or(column);
        changes.push((
            "gap",
            value(given_row.unwrap_or(row), given_column.unwrap_or(column)),
        ));
        for (key, property) in [("rowGap", "row-gap"), ("columnGap", "column-gap")] {
            if has_inline(style, property) {
                changes.push((key, EditOpValue::Null));
            }
        }
        return Ok(());
    }
    match (given_row, given_column) {
        (Some(row), Some(column)) if same(row, column) => {
            changes.push(("gap", value(row, column)));
        }
        _ => {
            if let Some(row) = given_row {
                changes.push(("rowGap", EditOpValue::Number(row)));
            }
            if let Some(column) = given_column {
                changes.push(("columnGap", EditOpValue::Number(column)));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::num::NonZeroU64;

    use crate::codemod::{CodemodError, finetune_op, finetune_ops};
    use crate::contracts::{EditOp, FinetuneProps};
    use crate::style::{Styling, inspect_with};
    use crate::theme::Theme;

    const V4: &str = "@import \"tailwindcss\";\n@theme { --color-brand: #be123c; --font-display: \"Fraunces\", serif; }";

    fn props(value: serde_json::Value) -> FinetuneProps {
        serde_json::from_value(value).expect("valid props")
    }

    fn located(source: &str, needle: &str) -> (u64, u64) {
        let offset = source.find(needle).expect("element");
        let line = source[..offset].matches('\n').count() + 1;
        let column = offset - source[..offset].rfind('\n').map_or(0, |at| at + 1) + 1;
        (
            u64::try_from(line).expect("line"),
            u64::try_from(column).expect("column"),
        )
    }

    fn classes(
        css: &str,
        source: &str,
        value: serde_json::Value,
    ) -> Result<(Vec<String>, Vec<String>), CodemodError> {
        let theme = Theme::from_css([css]);
        let (line, column) = located(source, "<p");
        let at = |value| NonZeroU64::new(value).expect("1-based");
        let style = inspect_with(
            "src/P.tsx",
            source,
            at(line),
            at(column),
            &theme,
            Styling::TAILWIND,
        )
        .expect("inspected");
        match finetune_op(&style, &props(value), &theme)? {
            EditOp::ClassTokens { add, remove, .. } => Ok((
                add.iter().map(|item| item.as_str().to_owned()).collect(),
                remove.iter().map(|item| item.as_str().to_owned()).collect(),
            )),
            other => panic!("expected class_tokens, got {other:?}"),
        }
    }

    fn tw(class: &str, value: serde_json::Value) -> (Vec<String>, Vec<String>) {
        classes(
            V4,
            &format!("export const P = () => <p className=\"{class}\">Hi</p>;"),
            value,
        )
        .expect("classes")
    }

    fn written(path: &str, source: &str, tailwind: bool, value: serde_json::Value) -> String {
        let theme = Theme::from_css([V4]);
        let (line, column) = located(source, "<p");
        let at = |value| NonZeroU64::new(value).expect("1-based");
        let style = inspect_with(
            path,
            source,
            at(line),
            at(column),
            &theme,
            Styling {
                tailwind,
                vuetify: false,
            },
        )
        .expect("inspected");
        let ops = finetune_ops(&style, &props(value), &theme).expect("ops");
        let sources = BTreeMap::from([(path.to_owned(), source.to_owned())]);
        crate::patch::apply(&sources, &ops)
            .expect("applies")
            .remove(path)
            .unwrap_or_else(|| source.to_owned())
    }

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn typography_writes_theme_names_first_and_replaces_only_the_property_it_changes() {
        let class = "text-sm/6 font-medium text-white tracking-wide text-[var(--x)]";
        assert_eq!(
            tw(class, serde_json::json!({ "text": { "size": 18 } })),
            (list(&["text-lg/6"]), list(&["text-sm/6"]))
        );
        assert_eq!(
            tw(class, serde_json::json!({ "text": { "size": 15 } })),
            (list(&["text-[15px]/6"]), list(&["text-sm/6"]))
        );
        assert_eq!(
            tw(class, serde_json::json!({ "text": { "lineHeight": 28 } })),
            (list(&["text-sm", "leading-7"]), list(&["text-sm/6"]))
        );
        assert_eq!(
            tw(class, serde_json::json!({ "text": { "lineHeight": 22 } })).0,
            list(&["text-sm", "leading-5.5"])
        );
        assert_eq!(
            tw(class, serde_json::json!({ "text": { "lineHeight": 23 } })).0,
            list(&["text-sm", "leading-[23px]"])
        );
        assert_eq!(
            tw(class, serde_json::json!({ "text": { "weight": 700 } })),
            (list(&["font-bold"]), list(&["font-medium"]))
        );
        assert_eq!(
            tw(class, serde_json::json!({ "text": { "weight": 650 } })).0,
            list(&["font-[650]"])
        );
        assert_eq!(
            tw(
                class,
                serde_json::json!({ "text": { "family": "display" } })
            ),
            (list(&["font-display"]), Vec::new())
        );
        assert_eq!(
            tw(
                class,
                serde_json::json!({ "text": { "letterSpacing": 0.02 } })
            ),
            (list(&["tracking-[0.02em]"]), list(&["tracking-wide"]))
        );
        assert_eq!(
            tw(
                class,
                serde_json::json!({ "text": { "letterSpacing": -0.025 } })
            )
            .0,
            list(&["tracking-tight"])
        );
        assert_eq!(
            tw(class, serde_json::json!({ "text": { "align": "center" } })),
            (list(&["text-center"]), Vec::new())
        );
        assert_eq!(
            tw(
                class,
                serde_json::json!({ "text": { "color": { "kind": "token", "name": "brand" } } })
            ),
            (list(&["text-brand"]), list(&["text-white"]))
        );
        assert_eq!(
            classes(
                V4,
                "export const P = () => <p className=\"x\">Hi</p>;",
                serde_json::json!({ "text": { "family": "comic" } })
            ),
            Err(CodemodError::UnknownFont("comic".to_owned()))
        );
    }

    #[test]
    fn stroke_sets_width_style_and_colour_or_removes_the_border() {
        let class = "border border-dashed border-brand ring-2";
        assert_eq!(
            tw(
                class,
                serde_json::json!({ "stroke": { "kind": "set", "width": 2 } })
            ),
            (list(&["border-2"]), list(&["border"]))
        );
        assert_eq!(
            tw(
                class,
                serde_json::json!({ "stroke": { "kind": "set", "width": 1 } })
            ),
            (list(&["border"]), Vec::new())
        );
        assert_eq!(
            tw(
                class,
                serde_json::json!({ "stroke": { "kind": "set", "style": "solid" } })
            ),
            (Vec::new(), list(&["border-dashed"]))
        );
        assert_eq!(
            tw(
                class,
                serde_json::json!({ "stroke": { "kind": "set", "style": "dotted" } })
            ),
            (list(&["border-dotted"]), list(&["border-dashed"]))
        );
        assert_eq!(
            tw(class, serde_json::json!({ "stroke": { "kind": "none" } })),
            (
                Vec::new(),
                list(&["border", "border-dashed", "border-brand"])
            )
        );
    }

    #[test]
    fn effects_replace_drop_and_inner_shadows_and_keep_rings() {
        let class = "shadow-sm shadow-black/20 ring-2";
        assert_eq!(
            tw(
                class,
                serde_json::json!({ "effects": {
                    "drop": { "kind": "custom", "x": 0, "y": 6, "blur": 16, "spread": -4, "hex": "#000000", "opacity": 22 },
                    "inner": { "kind": "token", "name": "sm" }
                } })
            ),
            (
                list(&[
                    "shadow-[0_6px_16px_-4px_rgba(0,0,0,0.22)]",
                    "inset-shadow-sm"
                ]),
                list(&["shadow-sm", "shadow-black/20"])
            )
        );
        assert_eq!(
            tw(class, serde_json::json!({ "effects": {} })),
            (Vec::new(), list(&["shadow-sm", "shadow-black/20"]))
        );
        assert_eq!(
            classes(
                V4,
                "export const P = () => <p>Hi</p>;",
                serde_json::json!({ "effects": { "drop": { "kind": "token", "name": "huge" } } })
            ),
            Err(CodemodError::UnknownShadow("huge".to_owned()))
        );
    }

    #[test]
    fn opacity_writes_a_percentage_and_full_opacity_removes_it() {
        assert_eq!(
            tw("opacity-50", serde_json::json!({ "opacity": 37 })),
            (list(&["opacity-37"]), list(&["opacity-50"]))
        );
        assert_eq!(
            tw("opacity-50", serde_json::json!({ "opacity": 100 })),
            (Vec::new(), list(&["opacity-50"]))
        );
    }

    #[test]
    fn padding_writes_the_shortest_form_on_the_spacing_scale() {
        let class = "px-6 py-3";
        let padding =
            |value: serde_json::Value| serde_json::json!({ "layout": { "padding": value } });
        assert_eq!(
            tw(class, padding(serde_json::json!({ "top": 16 }))),
            (list(&["pt-4", "pb-3", "px-6"]), list(&["py-3"]))
        );
        assert_eq!(
            tw(
                class,
                padding(serde_json::json!({ "top": 24, "bottom": 24 }))
            ),
            (list(&["p-6"]), list(&["px-6", "py-3"]))
        );
        assert_eq!(
            tw(class, padding(serde_json::json!({ "bottom": 13 }))).0,
            list(&["pt-3", "pb-[13px]", "px-6"])
        );
        assert_eq!(
            tw(
                class,
                padding(serde_json::json!({ "left": 14, "right": 14 }))
            )
            .0,
            list(&["py-3", "px-3.5"])
        );
        assert_eq!(
            tw("p-4", padding(serde_json::json!({ "top": 1 }))).0,
            list(&["pt-px", "pb-4", "px-4"])
        );
        assert_eq!(
            tw("ps-4 pt-2", padding(serde_json::json!({ "top": 4 }))),
            (list(&["pt-1"]), list(&["pt-2"]))
        );
        assert_eq!(
            tw("ps-4 pt-2", padding(serde_json::json!({ "left": 8 }))),
            (list(&["pt-2", "pl-2"]), list(&["ps-4"]))
        );
        assert_eq!(
            tw("p-(--gutter)", padding(serde_json::json!({ "top": 8 }))),
            (list(&["pt-2"]), Vec::new())
        );
        assert_eq!(
            tw(
                "md:px-8 px-2",
                padding(serde_json::json!({ "left": 8, "right": 8 }))
            ),
            (list(&["px-2"]), Vec::new())
        );
    }

    #[test]
    fn gap_writes_one_token_when_both_axes_match() {
        let gap = |value: serde_json::Value| serde_json::json!({ "layout": { "gap": value } });
        assert_eq!(
            tw("flex gap-3", gap(serde_json::json!({ "column": 16 }))),
            (list(&["gap-y-3", "gap-x-4"]), list(&["gap-3"]))
        );
        assert_eq!(
            tw(
                "grid gap-x-2 gap-y-4",
                gap(serde_json::json!({ "column": 16 }))
            ),
            (list(&["gap-4"]), list(&["gap-x-2", "gap-y-4"]))
        );
    }

    #[test]
    fn tailwind_v3_projects_get_arbitrary_values_off_its_scale() {
        let v3 = "@tailwind base;\n@tailwind utilities;";
        let source = "export const P = () => <p className=\"p-4 shadow-sm\">Hi</p>;";
        let run = |value| classes(v3, source, value).expect("classes").0;
        assert_eq!(
            run(serde_json::json!({ "layout": { "padding": { "top": 52 } } })),
            list(&["pt-[52px]", "pb-4", "px-4"])
        );
        assert_eq!(
            run(serde_json::json!({ "layout": { "padding": { "top": 56 } } })),
            list(&["pt-14", "pb-4", "px-4"])
        );
        assert_eq!(
            run(serde_json::json!({ "opacity": 37 })),
            list(&["opacity-[0.37]"])
        );
        assert_eq!(
            run(serde_json::json!({ "opacity": 35 })),
            list(&["opacity-35"])
        );
        assert_eq!(
            run(serde_json::json!({ "stroke": { "kind": "set", "width": 3 } })),
            list(&["border-[3px]"])
        );
        assert_eq!(
            run(serde_json::json!({ "effects": {
                "drop": { "kind": "custom", "x": 0, "y": 2, "blur": 4, "spread": 0, "hex": "#000000", "opacity": 100 },
                "inner": { "kind": "custom", "x": 0, "y": 1, "blur": 2, "spread": 0, "hex": "#FFFFFF", "opacity": 50 }
            } })),
            list(&["shadow-[0_2px_4px_0_#000000,inset_0_1px_2px_0_rgba(255,255,255,0.5)]"])
        );
    }

    #[test]
    fn inline_styles_merge_padding_into_an_existing_shorthand() {
        let source =
            "export const P = () => <p style={{ padding: 16, paddingLeft: 8, color: c }}>Hi</p>;";
        assert_eq!(
            written(
                "src/P.tsx",
                source,
                true,
                serde_json::json!({ "layout": { "padding": { "top": 20 } } })
            ),
            "export const P = () => <p style={{ padding: '20px 16px 16px 8px', color: c }}>Hi</p>;"
        );
        let bare = "export const P = () => <p style={{ color: c }}>Hi</p>;";
        assert_eq!(
            written(
                "src/P.tsx",
                bare,
                true,
                serde_json::json!({ "layout": { "padding": { "top": 20 }, "gap": { "row": 8, "column": 8 } } })
            ),
            "export const P = () => <p style={{ color: c, paddingTop: 20, gap: 8 }}>Hi</p>;"
        );
    }

    #[test]
    fn inline_styles_write_typography_stroke_effects_and_opacity() {
        let source =
            "export const P = () => <p style={{ border: '1px solid #ccc', color: c }}>Hi</p>;";
        assert_eq!(
            written(
                "src/P.tsx",
                source,
                true,
                serde_json::json!({
                    "text": { "family": "display", "size": 18, "lineHeight": 28, "letterSpacing": 0.02, "weight": 600 },
                    "stroke": { "kind": "set", "width": 2, "color": { "kind": "token", "name": "brand" } },
                    "effects": { "drop": { "kind": "token", "name": "xs" } },
                    "opacity": 80
                })
            ),
            "export const P = () => <p style={{ border: '2px solid var(--color-brand, #BE123C)', color: c, fontFamily: 'var(--font-display, \\'Fraunces\\', serif)', fontWeight: 600, fontSize: 18, lineHeight: '28px', letterSpacing: '0.02em', boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.05)', opacity: 0.8 }}>Hi</p>;"
        );
        let plain = "export const P = () => <p style={{ color: c }}>Hi</p>;";
        assert_eq!(
            written(
                "src/P.tsx",
                plain,
                true,
                serde_json::json!({ "stroke": { "kind": "set", "width": 1 } })
            ),
            "export const P = () => <p style={{ color: c, borderWidth: 1, borderStyle: 'solid' }}>Hi</p>;"
        );
    }

    #[test]
    fn templates_without_tailwind_write_css_declarations() {
        let source = "<template>\n  <p style=\"padding: 16px; color: red\">Hi</p>\n</template>\n";
        assert_eq!(
            written(
                "src/P.vue",
                source,
                false,
                serde_json::json!({ "layout": { "padding": { "right": 24, "left": 24 } }, "text": { "align": "center" } })
            ),
            "<template>\n  <p style=\"padding: 16px 24px; color: red; text-align: center\">Hi</p>\n</template>\n"
        );
    }

    #[test]
    fn values_outside_the_contract_ranges_are_refused() {
        assert_eq!(
            classes(
                V4,
                "export const P = () => <p>Hi</p>;",
                serde_json::json!({ "layout": { "padding": { "top": 1000 } } })
            ),
            Err(CodemodError::OutOfRange {
                what: "top",
                value: "1000".to_owned()
            })
        );
    }
}
