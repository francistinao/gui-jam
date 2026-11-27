use std::borrow::Cow;

pub const TEXT_CHARS: usize = 6000;
pub const HEADINGS: usize = 12;
const HEADING_CHARS: usize = 120;
const TITLE_CHARS: usize = 200;
const DESCRIPTION_CHARS: usize = 300;
const CSS_BYTES: usize = 1_500_000;
pub const COLORS: usize = 8;
pub const VARIABLES: usize = 12;
pub const FONTS: usize = 4;
const VARIABLE_VALUE_CHARS: usize = 60;
const STYLESHEETS: usize = 4;
pub const CODE_BLOCKS: usize = 4;
pub const CODE_CHARS: usize = 2500;
const ANCHORS: usize = 80;
const CHROME: [&str; 4] = ["nav", "header", "footer", "aside"];

const SKIPPED: [&str; 7] = [
    "script", "noscript", "template", "svg", "iframe", "object", "textarea",
];
const BLOCKS: [&str; 34] = [
    "address",
    "article",
    "aside",
    "blockquote",
    "br",
    "button",
    "dd",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "label",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "section",
    "table",
    "td",
    "th",
    "tr",
    "ul",
];
const GENERIC_FONTS: [&str; 18] = [
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-sans-serif",
    "ui-serif",
    "ui-monospace",
    "ui-rounded",
    "-apple-system",
    "blinkmacsystemfont",
    "inherit",
    "initial",
    "unset",
    "revert",
    "emoji",
    "math",
];
const COLOR_FUNCTIONS: [&str; 9] = [
    "rgb(", "rgba(", "hsl(", "hsla(", "oklch(", "oklab(", "lab(", "lch(", "hwb(",
];
const ENTITIES: [(&str, &str); 26] = [
    ("amp", "&"),
    ("lt", "<"),
    ("gt", ">"),
    ("quot", "\""),
    ("apos", "'"),
    ("nbsp", " "),
    ("copy", "©"),
    ("reg", "®"),
    ("trade", "™"),
    ("hellip", "…"),
    ("mdash", "—"),
    ("ndash", "–"),
    ("lsquo", "‘"),
    ("rsquo", "’"),
    ("ldquo", "“"),
    ("rdquo", "”"),
    ("laquo", "«"),
    ("raquo", "»"),
    ("middot", "·"),
    ("bull", "•"),
    ("times", "×"),
    ("deg", "°"),
    ("euro", "€"),
    ("pound", "£"),
    ("yen", "¥"),
    ("cent", "¢"),
];

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Page {
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub theme_color: Option<String>,
    pub headings: Vec<String>,
    pub text: String,
    pub stylesheets: Vec<String>,
    pub base: Option<String>,
    pub css: String,
    pub google_fonts: Vec<String>,
    pub code: Vec<Code>,
    pub anchors: Vec<Anchor>,
    pub nofollow: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Code {
    pub language: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
    pub href: String,
    pub content: bool,
}

fn language(tag: &Tag) -> Option<String> {
    if let Some(language) = tag.attr("data-language").or_else(|| tag.attr("data-lang")) {
        return Some(language.trim().to_ascii_lowercase()).filter(|language| !language.is_empty());
    }
    tag.attr("class")?.split_whitespace().find_map(|class| {
        class
            .strip_prefix("language-")
            .or_else(|| class.strip_prefix("lang-"))
            .map(str::to_ascii_lowercase)
    })
}

fn code_block(html: &str, lower: &str, pre: &Tag, from: usize) -> (Code, usize) {
    let (start, end) = closing_tag(lower, from, "pre");
    let inner = &html[from..start];
    let mut language = language(pre);
    let mut text = String::new();
    let mut pos = 0;
    while pos < inner.len() {
        let Some(offset) = inner[pos..].find('<') else {
            text.push_str(&decode_entities(&inner[pos..]));
            break;
        };
        text.push_str(&decode_entities(&inner[pos..pos + offset]));
        let at = pos + offset;
        if let Some(tag) = parse_tag(inner, at) {
            if tag.name == "code" && !tag.closing && language.is_none() {
                language = self::language(&tag);
            }
            if tag.name == "br" {
                text.push('\n');
            }
            pos = tag.end;
        } else {
            text.push('<');
            pos = at + 1;
        }
    }
    let trimmed = text.trim_matches('\n');
    let mut text: String = trimmed.chars().take(CODE_CHARS).collect();
    if trimmed.chars().count() > CODE_CHARS {
        text.push('…');
    }
    (Code { language, text }, end)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Styles {
    pub colors: Vec<(String, usize)>,
    pub variables: Vec<String>,
    pub fonts: Vec<String>,
    pub spacing: Vec<String>,
}

struct Tag {
    name: String,
    closing: bool,
    attrs: Vec<(String, String)>,
    end: usize,
}

impl Tag {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

struct Text {
    out: String,
    chars: usize,
    limit: usize,
    space: bool,
    newline: bool,
    truncated: bool,
}

impl Text {
    fn new(limit: usize) -> Self {
        Self {
            out: String::new(),
            chars: 0,
            limit,
            space: false,
            newline: false,
            truncated: false,
        }
    }

    fn push(&mut self, text: &str) {
        for c in text.chars() {
            if self.truncated {
                return;
            }
            if c.is_whitespace() {
                self.space = !self.out.is_empty();
                continue;
            }
            let separator = if self.newline {
                Some('\n')
            } else if self.space {
                Some(' ')
            } else {
                None
            };
            let needed = 1 + usize::from(separator.is_some());
            if self.chars + needed > self.limit {
                self.truncated = true;
                return;
            }
            if let Some(separator) = separator {
                self.out.push(separator);
            }
            self.out.push(c);
            self.chars += needed;
            self.space = false;
            self.newline = false;
        }
    }

    fn block(&mut self) {
        self.newline = !self.out.is_empty();
    }

    fn finish(self) -> String {
        if self.truncated {
            format!("{}…", self.out)
        } else {
            self.out
        }
    }
}

fn collapse(text: &str, limit: usize) -> String {
    let mut collector = Text::new(limit);
    collector.push(text);
    collector.finish()
}

#[must_use]
pub fn decode_entities(text: &str) -> Cow<'_, str> {
    if !text.contains('&') {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let entity = rest[1..]
            .find(';')
            .filter(|end| *end <= 10)
            .map(|end| (&rest[1..=end], end + 2));
        if let Some((value, len)) =
            entity.and_then(|(name, len)| entity_value(name).map(|value| (value, len)))
        {
            out.push_str(&value);
            rest = &rest[len..];
        } else {
            out.push('&');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

fn entity_value(name: &str) -> Option<String> {
    if let Some(number) = name.strip_prefix('#') {
        let code = match number.strip_prefix(['x', 'X']) {
            Some(hex) => u32::from_str_radix(hex, 16).ok()?,
            None => number.parse().ok()?,
        };
        let c = char::from_u32(code)
            .filter(|c| *c != '\0')
            .unwrap_or('\u{FFFD}');
        return Some(c.to_string());
    }
    ENTITIES
        .iter()
        .find(|(entity, _)| *entity == name)
        .map(|(_, value)| (*value).to_owned())
}

fn parse_tag(html: &str, start: usize) -> Option<Tag> {
    let bytes = html.as_bytes();
    let mut at = start + 1;
    let closing = bytes.get(at) == Some(&b'/');
    if closing {
        at += 1;
    }
    let name_start = at;
    if !bytes.get(at).is_some_and(u8::is_ascii_alphabetic) {
        return None;
    }
    while bytes
        .get(at)
        .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b':')
    {
        at += 1;
    }
    let name = html[name_start..at].to_ascii_lowercase();
    let mut attrs = Vec::new();
    loop {
        while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
        }
        match bytes.get(at) {
            None => {
                return Some(Tag {
                    name,
                    closing,
                    attrs,
                    end: html.len(),
                });
            }
            Some(b'>') => {
                return Some(Tag {
                    name,
                    closing,
                    attrs,
                    end: at + 1,
                });
            }
            Some(b'/') => {
                at += 1;
                continue;
            }
            Some(_) => {}
        }
        let key_start = at;
        while bytes
            .get(at)
            .is_some_and(|b| !b.is_ascii_whitespace() && !matches!(b, b'=' | b'>' | b'/'))
        {
            at += 1;
        }
        let key = html[key_start..at].to_ascii_lowercase();
        while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
        }
        let mut value = String::new();
        if bytes.get(at) == Some(&b'=') {
            at += 1;
            while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
                at += 1;
            }
            if let Some(quote @ (b'"' | b'\'')) = bytes.get(at) {
                let quote = char::from(*quote);
                let value_start = at + 1;
                let value_end = html[value_start..]
                    .find(quote)
                    .map_or(html.len(), |end| value_start + end);
                value = decode_entities(&html[value_start..value_end]).into_owned();
                at = (value_end + 1).min(html.len());
            } else {
                let value_start = at;
                while bytes
                    .get(at)
                    .is_some_and(|b| !b.is_ascii_whitespace() && *b != b'>')
                {
                    at += 1;
                }
                value = decode_entities(&html[value_start..at]).into_owned();
            }
        }
        if !key.is_empty() {
            attrs.push((key, value));
        }
    }
}

fn closing_tag(lower: &str, from: usize, name: &str) -> (usize, usize) {
    let needle = format!("</{name}");
    match lower[from..].find(&needle) {
        Some(offset) => {
            let start = from + offset;
            let end = lower[start..]
                .find('>')
                .map_or(lower.len(), |end| start + end + 1);
            (start, end)
        }
        None => (lower.len(), lower.len()),
    }
}

fn push_css(page: &mut Page, css: &str) {
    if page.css.len() + css.len() <= CSS_BYTES {
        page.css.push_str(css);
        page.css.push('\n');
    }
}

fn read_meta(tag: &Tag, page: &mut Page) {
    let key = tag
        .attr("name")
        .or_else(|| tag.attr("property"))
        .unwrap_or("")
        .to_ascii_lowercase();
    let Some(content) = tag
        .attr("content")
        .map(str::trim)
        .filter(|content| !content.is_empty())
    else {
        return;
    };
    match key.as_str() {
        "description" => page.description = Some(collapse(content, DESCRIPTION_CHARS)),
        "og:description" | "twitter:description" => {
            page.description
                .get_or_insert_with(|| collapse(content, DESCRIPTION_CHARS));
        }
        "og:title" | "twitter:title" => {
            page.title
                .get_or_insert_with(|| collapse(content, TITLE_CHARS));
        }
        "og:image" | "og:image:url" | "og:image:secure_url" | "twitter:image" => {
            page.image.get_or_insert_with(|| content.to_owned());
        }
        "theme-color" => {
            page.theme_color.get_or_insert_with(|| content.to_owned());
        }
        "robots" if content.to_ascii_lowercase().contains("nofollow") => page.nofollow = true,
        _ => {}
    }
}

fn read_link(tag: &Tag, page: &mut Page) {
    let Some(href) = tag
        .attr("href")
        .map(str::trim)
        .filter(|href| !href.is_empty())
    else {
        return;
    };
    let rel = tag.attr("rel").unwrap_or("").to_ascii_lowercase();
    if href.contains("fonts.googleapis.com") {
        for family in google_font_families(href) {
            if !page.google_fonts.contains(&family) {
                page.google_fonts.push(family);
            }
        }
    }
    if rel.split_whitespace().any(|part| part == "stylesheet")
        && page.stylesheets.len() < STYLESHEETS
        && !href.contains("fonts.googleapis.com")
    {
        page.stylesheets.push(href.to_owned());
    }
}

fn read_pre(
    html: &str,
    lower: &str,
    tag: &Tag,
    from: usize,
    page: &mut Page,
    text: &mut Text,
) -> usize {
    let (code, end) = code_block(html, lower, tag, from);
    if page.code.len() < CODE_BLOCKS && !code.text.trim().is_empty() {
        page.code.push(code);
        text.block();
        text.push(&format!("[code {}]", page.code.len()));
        text.block();
    }
    end
}

fn read_anchor(tag: &Tag, content: bool, page: &mut Page) {
    if let Some(href) = tag
        .attr("href")
        .map(str::trim)
        .filter(|href| !href.is_empty())
        && page.anchors.len() < ANCHORS
        && !tag
            .attr("rel")
            .is_some_and(|rel| rel.to_ascii_lowercase().contains("nofollow"))
    {
        page.anchors.push(Anchor {
            href: href.to_owned(),
            content,
        });
    }
}

#[must_use]
pub fn scan(html: &str) -> Page {
    let lower = html.to_ascii_lowercase();
    let mut page = Page::default();
    let mut text = Text::new(TEXT_CHARS);
    let mut heading: Option<Text> = None;
    let mut chrome = 0usize;
    let mut pos = 0;
    while pos < html.len() {
        let Some(offset) = html[pos..].find('<') else {
            let rest = decode_entities(&html[pos..]);
            text.push(&rest);
            if let Some(heading) = heading.as_mut() {
                heading.push(&rest);
            }
            break;
        };
        let lt = pos + offset;
        if lt > pos {
            let segment = decode_entities(&html[pos..lt]);
            text.push(&segment);
            if let Some(heading) = heading.as_mut() {
                heading.push(&segment);
            }
        }
        if lower[lt..].starts_with("<!--") {
            pos = lower[lt..]
                .find("-->")
                .map_or(html.len(), |end| lt + end + 3);
            continue;
        }
        if lower[lt..].starts_with("<!") || lower[lt..].starts_with("<?") {
            pos = lower[lt..].find('>').map_or(html.len(), |end| lt + end + 1);
            continue;
        }
        let Some(tag) = parse_tag(html, lt) else {
            text.push("<");
            pos = lt + 1;
            continue;
        };
        pos = tag.end;
        if let Some(style) = tag.attr("style").filter(|style| !style.trim().is_empty()) {
            push_css(&mut page, &format!("x{{{style}}}"));
        }
        if BLOCKS.contains(&tag.name.as_str()) {
            text.block();
        }
        if CHROME.contains(&tag.name.as_str()) {
            chrome = if tag.closing {
                chrome.saturating_sub(1)
            } else {
                chrome + 1
            };
        }
        if tag.closing {
            if matches!(tag.name.as_str(), "h1" | "h2" | "h3")
                && let Some(done) = heading.take().map(Text::finish).filter(|h| !h.is_empty())
                && page.headings.len() < HEADINGS
            {
                page.headings.push(done);
            }
            continue;
        }
        match tag.name.as_str() {
            name if SKIPPED.contains(&name) => {
                pos = closing_tag(&lower, pos, name).1;
            }
            "style" => {
                let (start, end) = closing_tag(&lower, pos, "style");
                push_css(&mut page, &html[pos..start]);
                pos = end;
            }
            "title" => {
                let (start, end) = closing_tag(&lower, pos, "title");
                let title = collapse(&decode_entities(&html[pos..start]), TITLE_CHARS);
                if !title.is_empty() {
                    page.title = Some(title);
                }
                pos = end;
            }
            "pre" => pos = read_pre(html, &lower, &tag, pos, &mut page, &mut text),
            "a" => read_anchor(&tag, chrome == 0, &mut page),
            "meta" => read_meta(&tag, &mut page),
            "link" => read_link(&tag, &mut page),
            "base" => {
                if let Some(href) = tag.attr("href") {
                    page.base.get_or_insert_with(|| href.trim().to_owned());
                }
            }
            "h1" | "h2" | "h3" => heading = Some(Text::new(HEADING_CHARS)),
            _ => {}
        }
    }
    page.text = text.finish();
    page
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let decoded = (bytes[at] == b'%')
            .then(|| text.get(at + 1..at + 3))
            .flatten()
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        if let Some(byte) = decoded {
            out.push(byte);
            at += 3;
        } else {
            out.push(if bytes[at] == b'+' { b' ' } else { bytes[at] });
            at += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[must_use]
pub fn google_font_families(href: &str) -> Vec<String> {
    let query = href.split_once('?').map_or("", |(_, query)| query);
    let mut families: Vec<String> = Vec::new();
    for pair in query.split('&') {
        let Some(value) = pair.strip_prefix("family=") else {
            continue;
        };
        for family in value.replace("%7C", "|").replace("%7c", "|").split('|') {
            let name = percent_decode(family.split(':').next().unwrap_or(""))
                .trim()
                .to_owned();
            if !name.is_empty() && !families.contains(&name) {
                families.push(name);
            }
        }
    }
    families
}

fn strip_comments(css: &str) -> Cow<'_, str> {
    if !css.contains("/*") {
        return Cow::Borrowed(css);
    }
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        rest = rest[start + 2..]
            .find("*/")
            .map_or("", |end| &rest[start + 2 + end + 2..]);
    }
    out.push_str(rest);
    Cow::Owned(out)
}

fn is_property(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && !name.as_bytes()[0].is_ascii_digit()
}

fn declarations(css: &str) -> impl Iterator<Item = (String, &str)> {
    css.split(['{', '}', ';']).filter_map(|segment| {
        let (name, value) = segment.split_once(':')?;
        let name = name.trim();
        if !is_property(name) {
            return None;
        }
        let value = value.trim();
        let value = value.strip_suffix("!important").unwrap_or(value).trim();
        (!value.is_empty()).then(|| (name.to_ascii_lowercase(), value))
    })
}

fn hex_color(digits: &str) -> Option<String> {
    let lower = digits.to_ascii_lowercase();
    match lower.len() {
        3 | 4 => Some(format!(
            "#{}",
            lower.chars().flat_map(|c| [c, c]).collect::<String>()
        )),
        6 | 8 => Some(format!("#{lower}")),
        _ => None,
    }
}

#[must_use]
pub fn colors_in(value: &str) -> Vec<String> {
    let lower = value.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'#' {
            let start = at + 1;
            let mut end = start;
            while end < bytes.len() && bytes[end].is_ascii_hexdigit() {
                end += 1;
            }
            let bounded = bytes
                .get(end)
                .is_none_or(|b| !b.is_ascii_alphanumeric() && *b != b'-' && *b != b'_');
            if bounded && let Some(color) = hex_color(&lower[start..end]) {
                found.push(color);
            }
            at = end.max(start);
            continue;
        }
        let preceded = at == 0 || !(bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'-');
        let function = preceded
            .then(|| {
                COLOR_FUNCTIONS
                    .iter()
                    .find(|name| lower[at..].starts_with(*name))
            })
            .flatten();
        if let Some(name) = function {
            let open = at + name.len();
            match lower[open..].find(')') {
                Some(close) => {
                    let inner = &lower[open..open + close];
                    if !inner.contains("var(") && !inner.contains('(') {
                        let args = inner.split_whitespace().collect::<Vec<_>>().join(" ");
                        found.push(format!("{name}{args})"));
                    }
                    at = open + close + 1;
                }
                None => break,
            }
            continue;
        }
        at += 1;
    }
    found
}

fn first_family(value: &str) -> Option<String> {
    value
        .split(',')
        .map(|family| family.trim().trim_matches(['"', '\'']).trim())
        .find(|family| {
            !family.is_empty()
                && !family.starts_with("var(")
                && !GENERIC_FONTS.contains(&family.to_ascii_lowercase().as_str())
        })
        .map(str::to_owned)
}

fn count(list: &mut Vec<(String, usize)>, value: String) {
    match list.iter_mut().find(|(seen, _)| *seen == value) {
        Some(entry) => entry.1 += 1,
        None => list.push((value, 1)),
    }
}

fn ranked(mut list: Vec<(String, usize)>, limit: usize) -> Vec<(String, usize)> {
    list.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    list.truncate(limit);
    list
}

#[must_use]
pub fn styles(css: &str) -> Styles {
    let css = strip_comments(css);
    let mut colors = Vec::new();
    let mut fonts = Vec::new();
    let mut variables: Vec<String> = Vec::new();
    for (name, value) in declarations(&css) {
        let found = colors_in(value);
        if name.starts_with("--") && !found.is_empty() && variables.len() < VARIABLES {
            let shown: String = value.chars().take(VARIABLE_VALUE_CHARS).collect();
            if !variables
                .iter()
                .any(|seen| seen.split(':').next() == Some(name.as_str()))
            {
                variables.push(format!("{name}: {shown}"));
            }
        }
        for color in found {
            count(&mut colors, color);
        }
        if name == "font-family"
            && let Some(family) = first_family(value)
        {
            count(&mut fonts, family);
        }
    }
    Styles {
        colors: ranked(colors, COLORS),
        variables,
        fonts: ranked(fonts, FONTS)
            .into_iter()
            .map(|(family, _)| family)
            .collect(),
        spacing: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use super::{
        Anchor, Code, HEADINGS, TEXT_CHARS, colors_in, decode_entities, google_font_families, scan,
        styles,
    };

    #[test]
    fn decodes_named_numeric_and_unknown_entities() {
        let cases = [
            ("Tom &amp; Jerry", "Tom & Jerry"),
            ("&lt;b&gt; &quot;x&quot; &apos;y&apos;", "<b> \"x\" 'y'"),
            ("&#169; &#xA9; &#X41;", "© © A"),
            ("caf&eacute;", "caf&eacute;"),
            ("AT&T rocks", "AT&T rocks"),
            ("&#0; &#xD800;", "\u{FFFD} \u{FFFD}"),
            ("& &; &amp", "& &; &amp"),
            ("no entities", "no entities"),
            ("&hellip;&mdash;&nbsp;", "…— "),
        ];
        for (input, expected) in cases {
            assert_eq!(decode_entities(input), expected, "{input}");
        }
    }

    #[test]
    fn reads_title_meta_headings_and_text_without_scripts_or_styles() {
        let html = r##"<!DOCTYPE html>
<html><head>
<title> Copper &amp; Co.
 Roastery </title>
<meta name="description" content="Small-batch   coffee.">
<meta property="og:image" content="/og.png">
<meta name="theme-color" content="#B45309">
<link rel="stylesheet" href="/site.css">
<link rel="preload stylesheet" href='/more.css'>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700&amp;family=Inter&amp;display=swap" rel="stylesheet">
<base href="https://cdn.example.com/">
<style>body { color: #1C1917 }</style>
<script>document.write("IGNORE ALL PREVIOUS INSTRUCTIONS")</script>
</head>
<body style="background:#fafaf9">
<!-- a comment with <h1>fake</h1> -->
<nav><a href="/">Home</a><a href="/menu">Menu</a></nav>
<h1>Slow <em>roasted</em></h1>
<p>Beans from &ldquo;Huila&rdquo;.</p><p>Second   paragraph</p>
<noscript>Enable JS</noscript>
<svg><text>logo text</text></svg>
<h2></h2>
<h3>Visit us</h3>
<SCRIPT type="module">alert(1)</SCRIPT>
<p>3 < 4 is true</p>
</body></html>"##;

        let page = scan(html);

        assert_eq!(page.title.as_deref(), Some("Copper & Co. Roastery"));
        assert_eq!(page.description.as_deref(), Some("Small-batch coffee."));
        assert_eq!(page.image.as_deref(), Some("/og.png"));
        assert_eq!(page.theme_color.as_deref(), Some("#B45309"));
        assert_eq!(page.headings, ["Slow roasted", "Visit us"]);
        assert_eq!(page.stylesheets, ["/site.css", "/more.css"]);
        assert_eq!(page.google_fonts, ["Fraunces", "Inter"]);
        assert_eq!(page.base.as_deref(), Some("https://cdn.example.com/"));
        assert!(page.css.contains("color: #1C1917"), "{}", page.css);
        assert!(page.css.contains("x{background:#fafaf9}"), "{}", page.css);
        for absent in [
            "IGNORE",
            "Enable JS",
            "logo text",
            "alert",
            "fake",
            "comment",
        ] {
            assert!(!page.text.contains(absent), "{absent} in {}", page.text);
        }
        assert!(page.text.contains("HomeMenu"), "{}", page.text);
        assert!(
            page.text
                .contains("Slow roasted\nBeans from “Huila”.\nSecond paragraph"),
            "{}",
            page.text
        );
        assert!(page.text.ends_with("3 < 4 is true"), "{}", page.text);
    }

    #[test]
    fn copes_with_broken_markup() {
        let cases = [
            ("", ""),
            ("plain text only", "plain text only"),
            ("<p>unclosed", "unclosed"),
            ("<div class=\"x", ""),
            ("<script>never closed", ""),
            ("a <!-- never closed", "a"),
            ("<p title='a>b'>quoted</p>", "quoted"),
            ("<p data-x=unquoted>v</p>", "v"),
            ("<<p>>double", "<\n>double"),
            ("<1>not a tag", "<1>not a tag"),
            ("<p>ünïcödé ✓</p>", "ünïcödé ✓"),
        ];
        for (html, expected) in cases {
            assert_eq!(scan(html).text, expected, "{html}");
        }
    }

    #[test]
    fn caps_text_and_headings() {
        let long = format!("<p>{}</p>", "word ".repeat(5000));
        let text = scan(&long).text;
        let count = text.chars().count();
        assert!(
            (TEXT_CHARS - 5..=TEXT_CHARS + 1).contains(&count),
            "{count}"
        );
        assert!(text.ends_with("word…"), "{}", &text[text.len() - 12..]);

        let many = (0..30).fold(String::new(), |mut html, n| {
            let _ = write!(html, "<h2>Heading {n}</h2>");
            html
        });
        let headings = scan(&many).headings;
        assert_eq!(headings.len(), HEADINGS);
        assert_eq!(headings[0], "Heading 0");
    }

    #[test]
    fn falls_back_to_open_graph_title_and_description() {
        let page = scan(
            r#"<meta property="og:title" content="OG title"><meta property="og:description" content="OG text"><meta name="twitter:image" content="/t.png">"#,
        );
        assert_eq!(page.title.as_deref(), Some("OG title"));
        assert_eq!(page.description.as_deref(), Some("OG text"));
        assert_eq!(page.image.as_deref(), Some("/t.png"));
    }

    #[test]
    fn finds_colors_in_declaration_values() {
        let cases: [(&str, &[&str]); 9] = [
            ("#ABC", &["#aabbcc"]),
            ("#aabbccdd", &["#aabbccdd"]),
            ("1px solid #fff", &["#ffffff"]),
            ("#12345", &[]),
            ("url(#gradient)", &[]),
            ("rgb( 10 , 20,30 )", &["rgb(10 , 20,30)"]),
            (
                "linear-gradient(90deg, #000 0%, hsl(200 50% 40%) 100%)",
                &["#000000", "hsl(200 50% 40%)"],
            ),
            ("rgb(var(--x))", &[]),
            (
                "oklch(0.7 0.1 250) #f0f",
                &["oklch(0.7 0.1 250)", "#ff00ff"],
            ),
        ];
        for (value, expected) in cases {
            assert_eq!(colors_in(value), expected, "{value}");
        }
    }

    #[test]
    fn ranks_colors_fonts_and_color_variables() {
        let css = r#"
/* #ff0000 in a comment */
:root { --brand: #B45309; --space: 4px; --ink: rgb(28 25 23); --brand: #000; }
#bad:hover { color: #b45309 }
body { color: #1c1917; background: #fafaf9; font-family: "Fraunces", Georgia, serif }
.btn { background: #b45309 !important; font-family: var(--font), Inter, sans-serif }
h1 { font-family: 'Fraunces' }
@media (min-width: 600px) { .card { border-color: #E7E5E4 } }
code { font-family: ui-monospace, monospace }
"#;

        let found = styles(css);

        assert_eq!(found.colors[0], ("#b45309".to_owned(), 3));
        assert!(!found.colors.iter().any(|(color, _)| color == "#ff0000"));
        assert!(found.colors.iter().any(|(color, _)| color == "#e7e5e4"));
        assert_eq!(
            found.variables,
            ["--brand: #B45309", "--ink: rgb(28 25 23)"]
        );
        assert_eq!(found.fonts, ["Fraunces", "Inter"]);
    }

    #[test]
    fn empty_css_has_no_styles() {
        assert_eq!(styles(""), super::Styles::default());
        assert_eq!(styles("a:hover{}").colors, Vec::new());
    }

    #[test]
    fn reads_google_font_families_from_both_api_versions() {
        assert_eq!(
            google_font_families(
                "https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;1,700&family=Inter&display=swap"
            ),
            ["Playfair Display", "Inter"]
        );
        assert_eq!(
            google_font_families(
                "https://fonts.googleapis.com/css?family=Open+Sans:400,700|Roboto%20Slab"
            ),
            ["Open Sans", "Roboto Slab"]
        );
        assert_eq!(
            google_font_families("https://fonts.googleapis.com/css2"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn keeps_code_blocks_with_their_language_and_marks_where_they_were() {
        let page = scan(
            "<p>Install it:</p><pre class=\"x\"><code class=\"language-tsx\">&lt;Button&gt;\n  <span class=\"k\">Go</span>\n&lt;/Button&gt;</code></pre><p>Done.</p>",
        );

        assert_eq!(
            page.code,
            [Code {
                language: Some("tsx".to_owned()),
                text: "<Button>\n  Go\n</Button>".to_owned()
            }]
        );
        assert_eq!(page.text, "Install it:\n[code 1]\nDone.");
    }

    #[test]
    fn lists_links_by_where_they_sit_and_honours_nofollow() {
        let page = scan(
            "<nav><a href=\"/pricing\">Pricing</a></nav><main><a href=\"/docs/button\">Button</a><a rel=\"nofollow\" href=\"/x\">x</a></main>",
        );
        assert_eq!(
            page.anchors,
            [
                Anchor {
                    href: "/pricing".to_owned(),
                    content: false
                },
                Anchor {
                    href: "/docs/button".to_owned(),
                    content: true
                }
            ]
        );
        assert!(!page.nofollow);
        assert!(scan("<meta name=\"robots\" content=\"index, nofollow\">").nofollow);
    }
}
