use crate::contracts::{ThemeColor, ThemeRadius, ThemeShadow, ThemeTokens};

const DEFAULT_RADII: [(&str, f64); 8] = [
    ("xs", 2.0),
    ("sm", 4.0),
    ("md", 6.0),
    ("lg", 8.0),
    ("xl", 12.0),
    ("2xl", 16.0),
    ("3xl", 24.0),
    ("4xl", 32.0),
];
const DEFAULT_TEXT_SIZES: [(&str, f64); 13] = [
    ("xs", 12.0),
    ("sm", 14.0),
    ("base", 16.0),
    ("lg", 18.0),
    ("xl", 20.0),
    ("2xl", 24.0),
    ("3xl", 30.0),
    ("4xl", 36.0),
    ("5xl", 48.0),
    ("6xl", 60.0),
    ("7xl", 72.0),
    ("8xl", 96.0),
    ("9xl", 128.0),
];
const DEFAULT_SHADOWS: [(&str, &str); 7] = [
    ("2xs", "0 1px rgb(0 0 0 / 0.05)"),
    ("xs", "0 1px 2px 0 rgb(0 0 0 / 0.05)"),
    (
        "sm",
        "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
    ),
    (
        "md",
        "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
    ),
    (
        "lg",
        "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    ),
    (
        "xl",
        "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
    ),
    ("2xl", "0 25px 50px -12px rgb(0 0 0 / 0.25)"),
];
const DEFAULT_INSET_SHADOWS: [(&str, &str); 3] = [
    ("2xs", "inset 0 1px rgb(0 0 0 / 0.05)"),
    ("xs", "inset 0 1px 1px rgb(0 0 0 / 0.05)"),
    ("sm", "inset 0 2px 4px rgb(0 0 0 / 0.05)"),
];
const DEFAULT_TRACKING: [(&str, f64); 6] = [
    ("tighter", -0.05),
    ("tight", -0.025),
    ("normal", 0.0),
    ("wide", 0.025),
    ("wider", 0.05),
    ("widest", 0.1),
];
const DEFAULT_FONTS: [(&str, &str); 3] = [
    (
        "sans",
        "ui-sans-serif, system-ui, sans-serif, \"Apple Color Emoji\", \"Segoe UI Emoji\", \"Segoe UI Symbol\", \"Noto Color Emoji\"",
    ),
    (
        "serif",
        "ui-serif, Georgia, Cambria, \"Times New Roman\", Times, serif",
    ),
    (
        "mono",
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace",
    ),
];
const DEFAULT_SPACING_PX: f64 = 4.0;
const REM_PX: f64 = 16.0;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Theme {
    colors: Vec<(String, String)>,
    radii: Vec<(String, f64)>,
    fonts: Vec<(String, String)>,
    text_sizes: Vec<(String, f64)>,
    shadows: Vec<(String, String)>,
    inset_shadows: Vec<(String, String)>,
    spacing: Option<f64>,
    legacy: bool,
}

impl Theme {
    #[must_use]
    pub fn from_css<'c>(stylesheets: impl IntoIterator<Item = &'c str>) -> Self {
        let mut theme = Self::default();
        for css in stylesheets {
            let css = strip_comments(css);
            if css.contains("@tailwind")
                && !css.contains("@import \"tailwindcss\"")
                && !css.contains("@import 'tailwindcss'")
            {
                theme.legacy = true;
            }
            for block in theme_blocks(&css) {
                for (name, value) in declarations(&block) {
                    theme.declare(name, value);
                }
            }
        }
        theme
    }

    fn declare(&mut self, name: &str, value: &str) {
        if let Some(color) = name.strip_prefix("--color-") {
            let value = normalize_color(value).unwrap_or_else(|| value.to_owned());
            upsert(&mut self.colors, color, value);
        } else if let Some(radius) = name.strip_prefix("--radius-") {
            if let Some(px) = length_px(value) {
                upsert(&mut self.radii, radius, px);
            }
        } else if let Some(font) = name.strip_prefix("--font-")
            && !font.contains("--")
            && !font.starts_with("weight-")
        {
            upsert(&mut self.fonts, font, value.to_owned());
        } else if let Some(size) = name.strip_prefix("--text-")
            && !size.contains("--")
            && !size.starts_with("shadow-")
        {
            if let Some(px) = length_px(value) {
                upsert(&mut self.text_sizes, size, px);
            }
        } else if let Some(shadow) = name.strip_prefix("--inset-shadow-") {
            upsert(&mut self.inset_shadows, shadow, value.to_owned());
        } else if let Some(shadow) = name.strip_prefix("--shadow-") {
            upsert(&mut self.shadows, shadow, value.to_owned());
        } else if name == "--spacing" {
            self.spacing = length_px(value);
        }
    }

    #[must_use]
    pub fn color(&self, name: &str) -> Option<&str> {
        self.colors
            .iter()
            .find(|(known, _)| known == name)
            .map(|(_, value)| value.as_str())
    }

    #[must_use]
    pub fn radius_px(&self, name: &str) -> Option<f64> {
        self.radii
            .iter()
            .find(|(known, _)| known == name)
            .map(|(_, px)| *px)
            .or_else(|| {
                DEFAULT_RADII
                    .iter()
                    .find(|(known, _)| *known == name)
                    .map(|(_, px)| *px)
            })
    }

    #[must_use]
    pub fn has_font(&self, name: &str) -> bool {
        self.fonts.iter().any(|(font, _)| font == name)
    }

    #[must_use]
    pub fn font_value(&self, name: &str) -> Option<&str> {
        named(&self.fonts, &DEFAULT_FONTS, name)
    }

    #[must_use]
    pub fn text_px(&self, name: &str) -> Option<f64> {
        scale(&self.text_sizes, &DEFAULT_TEXT_SIZES)
            .find(|(known, _)| *known == name)
            .map(|(_, px)| px)
    }

    #[must_use]
    pub fn text_named(&self, px: f64) -> Option<&str> {
        scale(&self.text_sizes, &DEFAULT_TEXT_SIZES)
            .find(|(_, value)| (value - px).abs() < 0.01)
            .map(|(name, _)| name)
    }

    #[must_use]
    pub fn shadow(&self, name: &str, inset: bool) -> Option<&str> {
        if inset {
            named(&self.inset_shadows, &DEFAULT_INSET_SHADOWS, name)
        } else {
            named(&self.shadows, &DEFAULT_SHADOWS, name)
        }
    }

    #[must_use]
    pub fn tracking_em(&self, name: &str) -> Option<f64> {
        DEFAULT_TRACKING
            .iter()
            .find(|(known, _)| *known == name)
            .map(|(_, em)| *em)
    }

    #[must_use]
    pub fn tracking_named(&self, em: f64) -> Option<&'static str> {
        DEFAULT_TRACKING
            .iter()
            .find(|(_, value)| (value - em).abs() < 0.0001)
            .map(|(name, _)| *name)
    }

    #[must_use]
    pub fn spacing(&self) -> f64 {
        self.spacing.unwrap_or(DEFAULT_SPACING_PX)
    }

    #[must_use]
    pub fn legacy(&self) -> bool {
        self.legacy
    }

    #[must_use]
    pub fn color_named(&self, hex: &str) -> Option<&str> {
        let hex = normalize_color(hex)?;
        self.colors
            .iter()
            .find(|(_, value)| *value == hex)
            .map(|(name, _)| name.as_str())
    }

    #[must_use]
    pub fn radius_named(&self, px: f64) -> Option<String> {
        self.radius_scale()
            .find(|(_, value)| (value - px).abs() < f64::EPSILON)
            .map(|(name, _)| name.to_owned())
    }

    fn radius_scale(&self) -> impl Iterator<Item = (&str, f64)> {
        let custom = self.radii.iter().map(|(name, px)| (name.as_str(), *px));
        let defaults = DEFAULT_RADII
            .into_iter()
            .filter(|(name, _)| !self.radii.iter().any(|(custom, _)| custom == name));
        custom.chain(defaults)
    }

    #[must_use]
    pub fn tokens(&self) -> ThemeTokens {
        ThemeTokens {
            colors: self
                .colors
                .iter()
                .map(|(name, value)| ThemeColor {
                    name: name.clone(),
                    value: value.clone(),
                })
                .collect(),
            radii: self
                .radius_scale()
                .map(|(name, px)| ThemeRadius {
                    name: name.to_owned(),
                    px,
                })
                .collect(),
            fonts: self
                .fonts
                .iter()
                .map(|(name, _)| name.as_str())
                .chain(
                    DEFAULT_FONTS
                        .iter()
                        .map(|(name, _)| *name)
                        .filter(|name| !self.has_font(name)),
                )
                .map(str::to_owned)
                .collect(),
            text_sizes: scale(&self.text_sizes, &DEFAULT_TEXT_SIZES)
                .map(|(name, px)| ThemeRadius {
                    name: name.to_owned(),
                    px,
                })
                .collect(),
            shadows: shadow_list(&self.shadows, &DEFAULT_SHADOWS, false)
                .chain(shadow_list(
                    &self.inset_shadows,
                    &DEFAULT_INSET_SHADOWS,
                    true,
                ))
                .collect(),
            spacing: self.spacing(),
        }
    }
}

fn named<'t>(
    custom: &'t [(String, String)],
    defaults: &[(&'static str, &'static str)],
    name: &str,
) -> Option<&'t str> {
    custom
        .iter()
        .find(|(known, _)| known == name)
        .map(|(_, value)| value.as_str())
        .or_else(|| {
            defaults
                .iter()
                .find(|(known, _)| *known == name)
                .map(|(_, value)| *value)
        })
}

fn scale<'t>(
    custom: &'t [(String, f64)],
    defaults: &'static [(&'static str, f64)],
) -> impl Iterator<Item = (&'t str, f64)> {
    custom.iter().map(|(name, px)| (name.as_str(), *px)).chain(
        defaults
            .iter()
            .filter(|(name, _)| !custom.iter().any(|(known, _)| known == name))
            .map(|(name, px)| (*name, *px)),
    )
}

fn shadow_list<'t>(
    custom: &'t [(String, String)],
    defaults: &'static [(&'static str, &'static str)],
    inset: bool,
) -> impl Iterator<Item = ThemeShadow> + 't {
    custom
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .chain(
            defaults
                .iter()
                .filter(|(name, _)| !custom.iter().any(|(known, _)| known == name))
                .map(|(name, value)| (*name, *value)),
        )
        .map(move |(name, value)| ThemeShadow {
            name: name.to_owned(),
            value: value.to_owned(),
            inset,
        })
}

fn upsert<T>(entries: &mut Vec<(String, T)>, name: &str, value: T) {
    match entries.iter_mut().find(|(known, _)| known == name) {
        Some(entry) => entry.1 = value,
        None => entries.push((name.to_owned(), value)),
    }
}

fn strip_comments(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        rest = rest[start + 2..]
            .find("*/")
            .map_or("", |end| &rest[start + 2 + end + 2..]);
    }
    out.push_str(rest);
    out
}

fn theme_blocks(css: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut rest = css;
    while let Some(at) = rest.find("@theme") {
        let after = &rest[at..];
        let Some(open) = after.find('{') else { break };
        let mut depth = 0usize;
        let mut close = None;
        for (index, ch) in after[open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(open + index);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(close) = close else { break };
        blocks.push(after[open + 1..close].to_owned());
        rest = &after[close + 1..];
    }
    blocks
}

fn declarations(block: &str) -> impl Iterator<Item = (&str, &str)> {
    block.split(';').filter_map(|declaration| {
        let (name, value) = declaration.split_once(':')?;
        let name = name.trim();
        name.starts_with("--").then(|| (name, value.trim()))
    })
}

fn length_px(value: &str) -> Option<f64> {
    if let Some(px) = value.strip_suffix("px") {
        return px.trim().parse().ok();
    }
    value
        .strip_suffix("rem")
        .and_then(|rem| rem.trim().parse::<f64>().ok())
        .map(|rem| rem * REM_PX)
}

#[must_use]
pub fn normalize_color(value: &str) -> Option<String> {
    let value = value.trim();
    if let Some(hex) = value.strip_prefix('#') {
        let digits: Vec<char> = hex.chars().collect();
        if !digits.iter().all(char::is_ascii_hexdigit) {
            return None;
        }
        let expanded: String = match digits.len() {
            3 => digits.iter().flat_map(|digit| [*digit, *digit]).collect(),
            6 => digits.iter().collect(),
            _ => return None,
        };
        return Some(format!("#{}", expanded.to_ascii_uppercase()));
    }
    let channels = value
        .strip_prefix("rgb(")
        .and_then(|rest| rest.strip_suffix(')'))?;
    let parts: Vec<u8> = channels
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|part| !part.is_empty())
        .map(|part| part.parse().ok())
        .collect::<Option<_>>()?;
    match parts.as_slice() {
        [r, g, b] => Some(format!("#{r:02X}{g:02X}{b:02X}")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{Theme, normalize_color};

    const CSS: &str = r#"
@import "tailwindcss";

@theme {
  --color-brand: #be123c;
  --color-crema: #F6EFE6; /* warm background */
  --color-ink: oklch(0.2 0 0);
  --font-display: "Fraunces", Georgia, serif;
  --radius-card: 10px;
  --radius-lg: 0.75rem;
}
"#;

    #[test]
    fn reads_colours_radii_and_fonts_from_theme_blocks() {
        let theme = Theme::from_css([CSS]);

        assert_eq!(theme.color("brand"), Some("#BE123C"));
        assert_eq!(theme.color("ink"), Some("oklch(0.2 0 0)"));
        assert_eq!(theme.radius_px("card"), Some(10.0));
        assert!(theme.has_font("display"));
    }

    #[test]
    fn project_radii_override_tailwind_defaults() {
        let theme = Theme::from_css([CSS]);

        assert_eq!(theme.radius_px("lg"), Some(12.0));
        assert_eq!(theme.radius_px("md"), Some(6.0));
        assert_eq!(theme.radius_named(12.0), Some("lg".to_owned()));
        assert_eq!(theme.radius_named(8.0), None);
    }

    #[test]
    fn finds_the_token_for_a_hex_value_in_any_case() {
        let theme = Theme::from_css([CSS]);

        assert_eq!(theme.color_named("#BE123C"), Some("brand"));
        assert_eq!(theme.color_named("#f6efe6"), Some("crema"));
        assert_eq!(theme.color_named("#123456"), None);
    }

    #[test]
    fn ignores_css_outside_theme_blocks() {
        let theme = Theme::from_css([":root { --color-brand: red; } .a { color: blue; }"]);

        assert_eq!(theme.color("brand"), None);
    }

    #[test]
    fn normalizes_short_hex_and_rgb() {
        assert_eq!(normalize_color("#abc"), Some("#AABBCC".to_owned()));
        assert_eq!(
            normalize_color("rgb(29 78 216)"),
            Some("#1D4ED8".to_owned())
        );
        assert_eq!(
            normalize_color("rgb(29, 78, 216)"),
            Some("#1D4ED8".to_owned())
        );
        assert_eq!(normalize_color("#12"), None);
        assert_eq!(normalize_color("oklch(0.5 0.1 20)"), None);
    }

    #[test]
    fn lists_presets_with_project_radii_first() {
        let tokens = Theme::from_css([CSS]).tokens();

        assert_eq!(tokens.colors.len(), 3);
        assert_eq!(tokens.radii[0].name, "card");
        assert_eq!(tokens.radii.iter().filter(|r| r.name == "lg").count(), 1);
    }
}
