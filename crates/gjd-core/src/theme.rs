//! Design tokens from Tailwind v4 `@theme { --color-*: …; --radius-*: … }` blocks,
//! used to label classes in the fine-tune panel and to prefer token utilities over
//! arbitrary values when a chosen value matches a token (FR-067).

use crate::contracts::{ThemeColor, ThemeRadius, ThemeTokens};

/// Tailwind v4's built-in `--radius-*` scale, in px (`tailwindcss/theme.css`).
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
const REM_PX: f64 = 16.0;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Theme {
    colors: Vec<(String, String)>,
    radii: Vec<(String, f64)>,
    fonts: Vec<String>,
}

impl Theme {
    /// Reads every `@theme` block in the given stylesheets; later declarations win.
    #[must_use]
    pub fn from_css<'c>(stylesheets: impl IntoIterator<Item = &'c str>) -> Self {
        let mut theme = Self::default();
        for css in stylesheets {
            for block in theme_blocks(&strip_comments(css)) {
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
            && !self.fonts.iter().any(|known| known == font)
        {
            self.fonts.push(font.to_owned());
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
        self.fonts.iter().any(|font| font == name)
    }

    /// The project colour token whose value is exactly `hex` (`#RRGGBB`, any case).
    #[must_use]
    pub fn color_named(&self, hex: &str) -> Option<&str> {
        let hex = normalize_color(hex)?;
        self.colors
            .iter()
            .find(|(_, value)| *value == hex)
            .map(|(name, _)| name.as_str())
    }

    /// The radius token worth exactly `px` in this project.
    #[must_use]
    pub fn radius_named(&self, px: f64) -> Option<String> {
        self.radius_scale()
            .find(|(_, value)| (value - px).abs() < f64::EPSILON)
            .map(|(name, _)| name.to_owned())
    }

    /// Project radii first, then Tailwind's defaults that the project does not override.
    fn radius_scale(&self) -> impl Iterator<Item = (&str, f64)> {
        let custom = self.radii.iter().map(|(name, px)| (name.as_str(), *px));
        let defaults = DEFAULT_RADII
            .into_iter()
            .filter(|(name, _)| !self.radii.iter().any(|(custom, _)| custom == name));
        custom.chain(defaults)
    }

    /// Presets for the panel: project colours and every radius token.
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
        }
    }
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

/// `#rgb`, `#rrggbb` and `rgb(r g b)` / `rgb(r, g, b)` as uppercase `#RRGGBB`.
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
