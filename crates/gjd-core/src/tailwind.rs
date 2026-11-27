use crate::contracts::StyleGroup;
use crate::theme::{Theme, normalize_color};

pub const PALETTE: [&str; 26] = [
    "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue",
    "indigo", "violet", "purple", "fuchsia", "pink", "rose", "slate", "gray", "zinc", "neutral",
    "stone", "mauve", "olive", "mist", "taupe",
];
const SHADES: [&str; 11] = [
    "50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950",
];
const SPECIAL_COLORS: [(&str, Option<&str>); 5] = [
    ("transparent", None),
    ("black", Some("#000000")),
    ("white", Some("#FFFFFF")),
    ("current", None),
    ("inherit", None),
];
const CSS_COLOR_FUNCTIONS: [&str; 12] = [
    "rgb(",
    "rgba(",
    "hsl(",
    "hsla(",
    "hwb(",
    "lab(",
    "lch(",
    "oklab(",
    "oklch(",
    "color(",
    "color-mix(",
    "var(--color-",
];
const CORNERS: [(&str, &str); 14] = [
    ("t", "radius-t"),
    ("r", "radius-r"),
    ("b", "radius-b"),
    ("l", "radius-l"),
    ("tl", "radius-tl"),
    ("tr", "radius-tr"),
    ("br", "radius-br"),
    ("bl", "radius-bl"),
    ("s", "radius-s"),
    ("e", "radius-e"),
    ("ss", "radius-ss"),
    ("se", "radius-se"),
    ("es", "radius-es"),
    ("ee", "radius-ee"),
];
const BORDER_SIDES: [&str; 8] = ["x", "y", "t", "r", "b", "l", "s", "e"];
const BORDER_STYLES: [&str; 6] = ["solid", "dashed", "dotted", "double", "hidden", "none"];
const BORDER_TABLE_UTILITIES: [&str; 3] = ["spacing", "collapse", "separate"];
pub const FONT_WEIGHTS: [(&str, i64); 9] = [
    ("thin", 100),
    ("extralight", 200),
    ("light", 300),
    ("normal", 400),
    ("medium", 500),
    ("semibold", 600),
    ("bold", 700),
    ("extrabold", 800),
    ("black", 900),
];
const FONT_FAMILIES: [&str; 3] = ["sans", "serif", "mono"];
const SHADOW_SIZES: [&str; 8] = ["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "none"];
const INSET_SHADOW_SIZES: [&str; 4] = ["2xs", "xs", "sm", "none"];
const TEXT_ALIGNS: [&str; 6] = ["left", "center", "right", "justify", "start", "end"];
const LEADING: [(&str, &str); 6] = [
    ("none", "1"),
    ("tight", "1.25"),
    ("snug", "1.375"),
    ("normal", "1.5"),
    ("relaxed", "1.625"),
    ("loose", "2"),
];
const PADDING: [(&str, &str); 9] = [
    ("p", "padding"),
    ("px", "padding-x"),
    ("py", "padding-y"),
    ("pt", "padding-top"),
    ("pr", "padding-right"),
    ("pb", "padding-bottom"),
    ("pl", "padding-left"),
    ("ps", "padding-start"),
    ("pe", "padding-end"),
];
const GAPS: [(&str, &str); 3] = [
    ("gap-x-", "column-gap"),
    ("gap-y-", "row-gap"),
    ("gap-", "gap"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedToken<'t> {
    pub variants: Vec<&'t str>,
    pub utility: &'t str,
}

#[must_use]
pub fn parse_token(token: &str) -> ParsedToken<'_> {
    let mut variants = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    for (index, ch) in token.char_indices() {
        match ch {
            '[' | '(' => depth += 1,
            ']' | ')' => depth -= 1,
            ':' if depth == 0 => {
                variants.push(&token[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    ParsedToken {
        variants,
        utility: token[start..].trim_start_matches('!').trim_end_matches('!'),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Classified {
    pub group: StyleGroup,
    pub property: &'static str,
    pub theme_token: Option<String>,
    pub value: Option<String>,
}

fn classified(
    group: StyleGroup,
    property: &'static str,
    theme_token: Option<&str>,
    value: Option<String>,
) -> Classified {
    Classified {
        group,
        property,
        theme_token: theme_token.map(str::to_owned),
        value,
    }
}

#[must_use]
pub fn classify(utility: &str, theme: &Theme) -> Option<Classified> {
    if let Some(value) = utility.strip_prefix("bg-") {
        return color(value, theme).map(|found| found.into_classified(StyleGroup::Fill, "color"));
    }
    if let Some(rest) = utility.strip_prefix("rounded") {
        return radius(rest, theme);
    }
    if let Some(rest) = utility.strip_prefix("border") {
        return stroke(rest, theme);
    }
    if let Some(value) = utility.strip_prefix("text-") {
        return text(value, theme);
    }
    if let Some(value) = utility.strip_prefix("font-") {
        return font(value, theme);
    }
    if let Some(rest) = utility.strip_prefix("shadow") {
        return shadow(rest, theme);
    }
    if let Some(rest) = utility.strip_prefix("inset-shadow") {
        return match rest.strip_prefix('-') {
            Some(value) => shadow_value(value, theme, true),
            None => Some(classified(StyleGroup::Effects, "inset-shadow", None, None)),
        };
    }
    if utility.starts_with("drop-shadow") {
        return Some(classified(StyleGroup::Effects, "drop-shadow", None, None));
    }
    if let Some(rest) = utility.strip_prefix("ring") {
        return ring(rest, theme);
    }
    if let Some(value) = utility.strip_prefix("opacity-") {
        return opacity(value);
    }
    if let Some(value) = utility.strip_prefix("leading-") {
        return leading(value, theme);
    }
    if let Some(value) = utility.strip_prefix("tracking-") {
        return tracking(value, theme);
    }
    if let Some((prefix, property)) = GAPS.iter().find(|(prefix, _)| utility.starts_with(prefix)) {
        return Some(spacing(property, &utility[prefix.len()..], theme));
    }
    let (prefix, value) = utility.split_once('-')?;
    let (_, property) = PADDING.iter().find(|(known, _)| *known == prefix)?;
    Some(spacing(property, value, theme))
}

fn spacing(property: &'static str, value: &str, theme: &Theme) -> Classified {
    let px = match value {
        "px" => Some("1px".to_owned()),
        _ => match arbitrary(value) {
            Some(inner) => Some(inner.to_owned()),
            None => value
                .parse::<f64>()
                .ok()
                .filter(|steps| *steps >= 0.0)
                .map(|steps| format!("{}px", trimmed(steps * theme.spacing()))),
        },
    };
    classified(StyleGroup::Layout, property, None, px)
}

#[must_use]
pub fn trimmed(value: f64) -> String {
    let rounded = (value * 1000.0).round() / 1000.0;
    if rounded.fract() == 0.0 {
        format!("{rounded:.0}")
    } else {
        rounded.to_string()
    }
}

fn leading(value: &str, theme: &Theme) -> Option<Classified> {
    let found = if let Some((_, ratio)) = LEADING.iter().find(|(name, _)| *name == value) {
        Some((*ratio).to_owned())
    } else if let Some(inner) = arbitrary(value) {
        Some(inner.to_owned())
    } else {
        let steps = value.parse::<f64>().ok()?;
        Some(format!("{}px", trimmed(steps * theme.spacing())))
    };
    Some(classified(StyleGroup::Text, "line-height", None, found))
}

fn tracking(value: &str, theme: &Theme) -> Option<Classified> {
    if let Some(em) = theme.tracking_em(value) {
        return Some(classified(
            StyleGroup::Text,
            "letter-spacing",
            Some(value),
            Some(format!("{}em", trimmed(em))),
        ));
    }
    arbitrary(value).map(|inner| {
        classified(
            StyleGroup::Text,
            "letter-spacing",
            None,
            Some(inner.to_owned()),
        )
    })
}

struct ColorRef {
    theme_token: Option<String>,
    value: Option<String>,
}

impl ColorRef {
    fn into_classified(self, group: StyleGroup, property: &'static str) -> Classified {
        Classified {
            group,
            property,
            theme_token: self.theme_token,
            value: self.value,
        }
    }
}

fn color(value: &str, theme: &Theme) -> Option<ColorRef> {
    let base = without_modifier(value);
    if let Some(inner) = arbitrary(base) {
        let inner = inner.strip_prefix("color:").unwrap_or(inner);
        return is_css_color(inner).then(|| ColorRef {
            theme_token: None,
            value: Some(normalize_color(inner).unwrap_or_else(|| inner.to_owned())),
        });
    }
    if let Some(found) = theme.color(base) {
        return Some(ColorRef {
            theme_token: Some(base.to_owned()),
            value: Some(found.to_owned()),
        });
    }
    if let Some((_, hex)) = SPECIAL_COLORS.iter().find(|(name, _)| *name == base) {
        return Some(ColorRef {
            theme_token: Some(base.to_owned()),
            value: hex.map(str::to_owned),
        });
    }
    let (name, shade) = base.rsplit_once('-')?;
    (PALETTE.contains(&name) && SHADES.contains(&shade)).then(|| ColorRef {
        theme_token: Some(base.to_owned()),
        value: None,
    })
}

fn without_modifier(value: &str) -> &str {
    let mut depth = 0i32;
    let mut cut = value.len();
    for (index, ch) in value.char_indices() {
        match ch {
            '[' | '(' => depth += 1,
            ']' | ')' => depth -= 1,
            '/' if depth == 0 => cut = index,
            _ => {}
        }
    }
    &value[..cut]
}

fn arbitrary(value: &str) -> Option<&str> {
    value.strip_prefix('[')?.strip_suffix(']')
}

fn is_css_color(value: &str) -> bool {
    if let Some(hex) = value.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    CSS_COLOR_FUNCTIONS
        .iter()
        .any(|prefix| value.starts_with(prefix))
}

fn is_length(value: &str) -> bool {
    let number = ["px", "rem", "em"]
        .iter()
        .find_map(|unit| value.strip_suffix(unit))
        .unwrap_or(value);
    !number.is_empty() && number.parse::<f64>().is_ok()
}

fn is_integer(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_digit())
}

fn radius(rest: &str, theme: &Theme) -> Option<Classified> {
    if rest.is_empty() {
        return Some(classified(StyleGroup::Radius, "radius", None, None));
    }
    let rest = rest.strip_prefix('-')?;
    let corner = |key: &str| {
        CORNERS
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, property)| *property)
    };
    let (property, size) = match rest.split_once('-') {
        Some((key, size)) if corner(key).is_some() => (corner(key)?, Some(size)),
        _ => match corner(rest) {
            Some(property) => (property, None),
            None => ("radius", Some(rest)),
        },
    };
    let Some(size) = size else {
        return Some(classified(StyleGroup::Radius, property, None, None));
    };
    let found = match size {
        "none" => classified(
            StyleGroup::Radius,
            property,
            Some("none"),
            Some("0px".to_owned()),
        ),
        "full" => classified(StyleGroup::Radius, property, Some("full"), None),
        _ => match arbitrary(size) {
            Some(inner) => classified(StyleGroup::Radius, property, None, Some(inner.to_owned())),
            None => classified(
                StyleGroup::Radius,
                property,
                Some(size),
                theme.radius_px(size).map(|px| format!("{px}px")),
            ),
        },
    };
    Some(found)
}

fn stroke(rest: &str, theme: &Theme) -> Option<Classified> {
    let width = |value: Option<String>| Some(classified(StyleGroup::Stroke, "width", None, value));
    if rest.is_empty() {
        return width(Some("1px".to_owned()));
    }
    let rest = rest.strip_prefix('-')?;
    if BORDER_TABLE_UTILITIES
        .iter()
        .any(|table| rest.starts_with(table))
    {
        return None;
    }
    let value = match rest.split_once('-') {
        Some((side, value)) if BORDER_SIDES.contains(&side) => value,
        None if BORDER_SIDES.contains(&rest) => return width(Some("1px".to_owned())),
        _ => rest,
    };
    if BORDER_STYLES.contains(&value) {
        return Some(classified(StyleGroup::Stroke, "style", Some(value), None));
    }
    if is_integer(value) {
        return width(Some(format!("{value}px")));
    }
    if let Some(inner) = arbitrary(value)
        && is_length(inner)
    {
        return width(Some(inner.to_owned()));
    }
    color(value, theme).map(|found| found.into_classified(StyleGroup::Stroke, "color"))
}

fn text(value: &str, theme: &Theme) -> Option<Classified> {
    if TEXT_ALIGNS.contains(&value) {
        return Some(classified(
            StyleGroup::Text,
            "align",
            Some(value),
            Some(value.to_owned()),
        ));
    }
    let base = without_modifier(value);
    if let Some(px) = theme.text_px(base) {
        return Some(classified(
            StyleGroup::Text,
            "size",
            Some(base),
            Some(format!("{}px", trimmed(px))),
        ));
    }
    if let Some(inner) = arbitrary(base)
        && is_length(inner)
    {
        return Some(classified(
            StyleGroup::Text,
            "size",
            None,
            Some(inner.to_owned()),
        ));
    }
    color(value, theme).map(|found| found.into_classified(StyleGroup::Text, "color"))
}

fn font(value: &str, theme: &Theme) -> Option<Classified> {
    if let Some((_, weight)) = FONT_WEIGHTS.iter().find(|(name, _)| *name == value) {
        return Some(classified(
            StyleGroup::Text,
            "weight",
            Some(value),
            Some(weight.to_string()),
        ));
    }
    if let Some(inner) = arbitrary(value)
        && is_integer(inner)
    {
        return Some(classified(
            StyleGroup::Text,
            "weight",
            None,
            Some(inner.to_owned()),
        ));
    }
    (FONT_FAMILIES.contains(&value) || theme.has_font(value))
        .then(|| classified(StyleGroup::Text, "family", Some(value), None))
}

fn shadow(rest: &str, theme: &Theme) -> Option<Classified> {
    if rest.is_empty() {
        return Some(classified(StyleGroup::Effects, "shadow", None, None));
    }
    let value = rest.strip_prefix('-')?;
    shadow_value(value, theme, false)
}

fn shadow_value(value: &str, theme: &Theme, inset: bool) -> Option<Classified> {
    let (property, color_property, sizes) = if inset {
        (
            "inset-shadow",
            "inset-shadow-color",
            &INSET_SHADOW_SIZES[..],
        )
    } else {
        ("shadow", "shadow-color", &SHADOW_SIZES[..])
    };
    if sizes.contains(&value) {
        let found = if value == "none" {
            Some("none".to_owned())
        } else {
            theme.shadow(value, inset).map(str::to_owned)
        };
        return Some(classified(
            StyleGroup::Effects,
            property,
            Some(value),
            found,
        ));
    }
    if let Some(found) = color(value, theme) {
        return Some(found.into_classified(StyleGroup::Effects, color_property));
    }
    arbitrary(value)
        .map(|inner| classified(StyleGroup::Effects, property, None, Some(inner.to_owned())))
}

fn ring(rest: &str, theme: &Theme) -> Option<Classified> {
    if rest.is_empty() {
        return Some(classified(
            StyleGroup::Effects,
            "ring",
            None,
            Some("1px".to_owned()),
        ));
    }
    let value = rest.strip_prefix('-')?;
    if value.starts_with("offset") {
        return None;
    }
    if value == "inset" {
        return Some(classified(StyleGroup::Effects, "ring", Some(value), None));
    }
    if is_integer(value) {
        return Some(classified(
            StyleGroup::Effects,
            "ring",
            None,
            Some(format!("{value}px")),
        ));
    }
    if let Some(inner) = arbitrary(value)
        && is_length(inner)
    {
        return Some(classified(
            StyleGroup::Effects,
            "ring",
            None,
            Some(inner.to_owned()),
        ));
    }
    color(value, theme).map(|found| found.into_classified(StyleGroup::Effects, "ring-color"))
}

fn opacity(value: &str) -> Option<Classified> {
    if is_integer(value) {
        return Some(classified(
            StyleGroup::Opacity,
            "opacity",
            None,
            Some(format!("{value}%")),
        ));
    }
    arbitrary(value)
        .map(|inner| classified(StyleGroup::Opacity, "opacity", None, Some(inner.to_owned())))
}

#[cfg(test)]
mod tests {
    use super::{ParsedToken, classify, parse_token};
    use crate::contracts::StyleGroup;
    use crate::theme::Theme;

    fn theme() -> Theme {
        Theme::from_css([
            "@theme { --color-brand: #be123c; --radius-card: 10px; --font-display: x; }",
        ])
    }

    fn summary(
        utility: &str,
    ) -> Option<(StyleGroup, &'static str, Option<String>, Option<String>)> {
        classify(utility, &theme()).map(|c| (c.group, c.property, c.theme_token, c.value))
    }

    #[test]
    fn splits_variants_outside_brackets_and_drops_important_marks() {
        assert_eq!(
            parse_token("hover:md:bg-[color:var(--x)]"),
            ParsedToken {
                variants: vec!["hover", "md"],
                utility: "bg-[color:var(--x)]"
            }
        );
        assert_eq!(parse_token("!bg-red-500").utility, "bg-red-500");
        assert_eq!(parse_token("bg-red-500!").utility, "bg-red-500");
    }

    #[test]
    fn classifies_background_colours_as_fill_and_nothing_else() {
        assert_eq!(
            summary("bg-brand"),
            Some((
                StyleGroup::Fill,
                "color",
                Some("brand".to_owned()),
                Some("#BE123C".to_owned())
            ))
        );
        assert_eq!(
            summary("bg-[#1d4ed8]/80"),
            Some((StyleGroup::Fill, "color", None, Some("#1D4ED8".to_owned())))
        );
        assert_eq!(
            summary("bg-red-500/50"),
            Some((StyleGroup::Fill, "color", Some("red-500".to_owned()), None))
        );
        assert_eq!(
            summary("bg-white"),
            Some((
                StyleGroup::Fill,
                "color",
                Some("white".to_owned()),
                Some("#FFFFFF".to_owned())
            ))
        );
        for not_fill in [
            "bg-cover",
            "bg-center",
            "bg-linear-to-r",
            "bg-[url(/a.png)]",
            "bg-red",
        ] {
            assert_eq!(summary(not_fill), None, "{not_fill}");
        }
    }

    #[test]
    fn classifies_radius_tokens_with_their_size() {
        assert_eq!(
            summary("rounded-lg"),
            Some((
                StyleGroup::Radius,
                "radius",
                Some("lg".to_owned()),
                Some("8px".to_owned())
            ))
        );
        assert_eq!(
            summary("rounded-card"),
            Some((
                StyleGroup::Radius,
                "radius",
                Some("card".to_owned()),
                Some("10px".to_owned())
            ))
        );
        assert_eq!(
            summary("rounded-tl-lg"),
            Some((
                StyleGroup::Radius,
                "radius-tl",
                Some("lg".to_owned()),
                Some("8px".to_owned())
            ))
        );
        assert_eq!(
            summary("rounded-[12px]"),
            Some((StyleGroup::Radius, "radius", None, Some("12px".to_owned())))
        );
        assert_eq!(
            summary("rounded-none"),
            Some((
                StyleGroup::Radius,
                "radius",
                Some("none".to_owned()),
                Some("0px".to_owned())
            ))
        );
        assert_eq!(summary("rounded").map(|s| s.1), Some("radius"));
        assert_eq!(summary("rounded-t").map(|s| s.1), Some("radius-t"));
    }

    #[test]
    fn classifies_border_width_colour_and_style_as_stroke() {
        assert_eq!(
            summary("border"),
            Some((StyleGroup::Stroke, "width", None, Some("1px".to_owned())))
        );
        assert_eq!(
            summary("border-2"),
            Some((StyleGroup::Stroke, "width", None, Some("2px".to_owned())))
        );
        assert_eq!(
            summary("border-x-[3px]"),
            Some((StyleGroup::Stroke, "width", None, Some("3px".to_owned())))
        );
        assert_eq!(
            summary("border-brand"),
            Some((
                StyleGroup::Stroke,
                "color",
                Some("brand".to_owned()),
                Some("#BE123C".to_owned())
            ))
        );
        assert_eq!(
            summary("border-t-red-500"),
            Some((
                StyleGroup::Stroke,
                "color",
                Some("red-500".to_owned()),
                None
            ))
        );
        assert_eq!(
            summary("border-dashed"),
            Some((StyleGroup::Stroke, "style", Some("dashed".to_owned()), None))
        );
        assert_eq!(summary("border-collapse"), None);
    }

    #[test]
    fn separates_text_colour_from_size_weight_and_family() {
        assert_eq!(
            summary("text-white"),
            Some((
                StyleGroup::Text,
                "color",
                Some("white".to_owned()),
                Some("#FFFFFF".to_owned())
            ))
        );
        assert_eq!(
            summary("text-sm/6"),
            Some((
                StyleGroup::Text,
                "size",
                Some("sm".to_owned()),
                Some("14px".to_owned())
            ))
        );
        assert_eq!(
            summary("text-[15px]"),
            Some((StyleGroup::Text, "size", None, Some("15px".to_owned())))
        );
        assert_eq!(
            summary("font-semibold"),
            Some((
                StyleGroup::Text,
                "weight",
                Some("semibold".to_owned()),
                Some("600".to_owned())
            ))
        );
        assert_eq!(
            summary("font-display"),
            Some((StyleGroup::Text, "family", Some("display".to_owned()), None))
        );
        assert_eq!(summary("font-unknown"), None);
        for unclassified in ["text-[length:var(--x)]", "text-(--x)", "text-[var(--x)]"] {
            assert_eq!(summary(unclassified), None, "{unclassified}");
        }
    }

    #[test]
    fn reads_alignment_line_height_and_letter_spacing_as_text() {
        assert_eq!(
            summary("text-center"),
            Some((
                StyleGroup::Text,
                "align",
                Some("center".to_owned()),
                Some("center".to_owned())
            ))
        );
        assert_eq!(
            summary("leading-6").map(|s| (s.1, s.3)),
            Some(("line-height", Some("24px".to_owned())))
        );
        assert_eq!(
            summary("leading-tight").map(|s| s.3),
            Some(Some("1.25".to_owned()))
        );
        assert_eq!(
            summary("leading-[22px]").map(|s| s.3),
            Some(Some("22px".to_owned()))
        );
        assert_eq!(
            summary("tracking-wide"),
            Some((
                StyleGroup::Text,
                "letter-spacing",
                Some("wide".to_owned()),
                Some("0.025em".to_owned())
            ))
        );
        assert_eq!(
            summary("tracking-[0.02em]").map(|s| s.3),
            Some(Some("0.02em".to_owned()))
        );
    }

    #[test]
    fn reads_padding_and_gap_in_pixels_from_the_spacing_scale() {
        let layout = |utility: &str| summary(utility).map(|s| (s.0, s.1, s.3));
        assert_eq!(
            layout("px-6"),
            Some((StyleGroup::Layout, "padding-x", Some("24px".to_owned())))
        );
        assert_eq!(
            layout("p-3.5"),
            Some((StyleGroup::Layout, "padding", Some("14px".to_owned())))
        );
        assert_eq!(
            layout("pt-px"),
            Some((StyleGroup::Layout, "padding-top", Some("1px".to_owned())))
        );
        assert_eq!(
            layout("pb-[13px]"),
            Some((
                StyleGroup::Layout,
                "padding-bottom",
                Some("13px".to_owned())
            ))
        );
        assert_eq!(
            layout("ps-4"),
            Some((StyleGroup::Layout, "padding-start", Some("16px".to_owned())))
        );
        assert_eq!(
            layout("p-(--gutter)"),
            Some((StyleGroup::Layout, "padding", None))
        );
        assert_eq!(
            layout("gap-3"),
            Some((StyleGroup::Layout, "gap", Some("12px".to_owned())))
        );
        assert_eq!(
            layout("gap-x-2"),
            Some((StyleGroup::Layout, "column-gap", Some("8px".to_owned())))
        );
        assert_eq!(
            layout("gap-y-[10px]"),
            Some((StyleGroup::Layout, "row-gap", Some("10px".to_owned())))
        );
        let custom = Theme::from_css(["@theme { --spacing: 0.5rem; }"]);
        assert_eq!(
            classify("p-2", &custom).and_then(|c| c.value),
            Some("16px".to_owned())
        );
    }

    #[test]
    fn classifies_shadows_rings_and_opacity() {
        assert_eq!(
            summary("shadow-sm").map(|s| (s.1, s.2)),
            Some(("shadow", Some("sm".to_owned())))
        );
        assert_eq!(
            summary("shadow-sm").and_then(|s| s.3).as_deref(),
            Some("0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)")
        );
        assert_eq!(
            summary("inset-shadow-sm").map(|s| (s.1, s.3)),
            Some((
                "inset-shadow",
                Some("inset 0 2px 4px rgb(0 0 0 / 0.05)".to_owned())
            ))
        );
        assert_eq!(
            summary("inset-shadow-black/20").map(|s| s.1),
            Some("inset-shadow-color")
        );
        assert_eq!(
            summary("shadow-black/20"),
            Some((
                StyleGroup::Effects,
                "shadow-color",
                Some("black".to_owned()),
                Some("#000000".to_owned())
            ))
        );
        assert_eq!(
            summary("ring-2"),
            Some((StyleGroup::Effects, "ring", None, Some("2px".to_owned())))
        );
        assert_eq!(summary("ring-offset-2"), None);
        assert_eq!(
            summary("opacity-50"),
            Some((StyleGroup::Opacity, "opacity", None, Some("50%".to_owned())))
        );
    }

    #[test]
    fn leaves_layout_utilities_other_than_padding_and_gap_unclassified() {
        for utility in [
            "flex",
            "mt-auto",
            "inset-0",
            "place-items-center",
            "pointer-events-none",
            "perspective-near",
        ] {
            assert_eq!(summary(utility), None, "{utility}");
        }
    }
}
