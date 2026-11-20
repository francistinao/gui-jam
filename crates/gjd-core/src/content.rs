use std::ops::Range;

const CODE_CHARS: usize = 80;
const VOID: [&str; 14] = [
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];
const CODE_ATTRIBUTES: [&str; 6] = [
    "v-text",
    "v-html",
    "set:text",
    "set:html",
    "innerHTML",
    "textContent",
];
const ENTITIES: [(&str, char); 28] = [
    ("amp", '&'),
    ("lt", '<'),
    ("gt", '>'),
    ("quot", '"'),
    ("apos", '\''),
    ("nbsp", '\u{a0}'),
    ("copy", '\u{a9}'),
    ("reg", '\u{ae}'),
    ("trade", '\u{2122}'),
    ("hellip", '\u{2026}'),
    ("mdash", '\u{2014}'),
    ("ndash", '\u{2013}'),
    ("lsquo", '\u{2018}'),
    ("rsquo", '\u{2019}'),
    ("ldquo", '\u{201c}'),
    ("rdquo", '\u{201d}'),
    ("bull", '\u{2022}'),
    ("middot", '\u{b7}'),
    ("times", '\u{d7}'),
    ("deg", '\u{b0}'),
    ("euro", '\u{20ac}'),
    ("pound", '\u{a3}'),
    ("yen", '\u{a5}'),
    ("cent", '\u{a2}'),
    ("laquo", '\u{ab}'),
    ("raquo", '\u{bb}'),
    ("rarr", '\u{2192}'),
    ("larr", '\u{2190}'),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContentPart {
    Text { value: String, range: Range<usize> },
    Code { source: String },
    Element { tag: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Jsx,
    Vue,
    Brace,
    Html,
}

impl Dialect {
    #[must_use]
    pub fn of(path: &str) -> Self {
        match path
            .rsplit_once('.')
            .map(|(_, extension)| extension.to_ascii_lowercase())
        {
            Some(extension) if extension == "vue" => Self::Vue,
            Some(extension) if extension == "svelte" || extension == "astro" => Self::Brace,
            Some(extension) if extension == "html" => Self::Html,
            _ => Self::Jsx,
        }
    }
}

#[must_use]
pub fn is_void(tag: &str) -> bool {
    VOID.contains(&tag.to_ascii_lowercase().as_str())
}

#[must_use]
pub fn is_code_attribute(name: &str) -> bool {
    CODE_ATTRIBUTES.contains(&name)
}

#[must_use]
pub fn code(source: &str) -> ContentPart {
    let trimmed = source.trim();
    let mut cut: String = trimmed.chars().take(CODE_CHARS).collect();
    if trimmed.chars().count() > CODE_CHARS {
        cut.push('\u{2026}');
    }
    ContentPart::Code { source: cut }
}

pub fn runs(parts: &[ContentPart]) -> impl Iterator<Item = (&str, &Range<usize>)> {
    parts.iter().filter_map(|part| match part {
        ContentPart::Text { value, range } => Some((value.as_str(), range)),
        _ => None,
    })
}

#[must_use]
pub fn run_range(parts: &[ContentPart], run: usize) -> Option<Range<usize>> {
    runs(parts).nth(run).map(|(_, range)| range.clone())
}

#[must_use]
pub fn finish(parts: Vec<ContentPart>, inner: usize) -> Vec<ContentPart> {
    if parts.is_empty() {
        vec![ContentPart::Text {
            value: String::new(),
            range: inner..inner,
        }]
    } else {
        parts
    }
}

fn jsx_whitespace(raw: &str) -> String {
    let lines: Vec<&str> = raw
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .collect();
    let last_filled = lines
        .iter()
        .rposition(|line| !line.trim().is_empty())
        .unwrap_or(0);
    let mut out = String::new();
    for (index, line) in lines.iter().enumerate() {
        let mut kept = line.replace('\t', " ");
        if index > 0 {
            kept = kept.trim_start_matches(' ').to_owned();
        }
        if index + 1 < lines.len() {
            kept = kept.trim_end_matches(' ').to_owned();
        }
        if !kept.is_empty() {
            out.push_str(&kept);
            if index != last_filled {
                out.push(' ');
            }
        }
    }
    out
}

fn html_whitespace(raw: &str) -> String {
    raw.split_ascii_whitespace().collect::<Vec<_>>().join(" ")
}

fn entity(name: &str) -> Option<char> {
    if let Some(number) = name.strip_prefix('#') {
        let code = match number.strip_prefix(['x', 'X']) {
            Some(hex) => u32::from_str_radix(hex, 16).ok()?,
            None => number.parse().ok()?,
        };
        return char::from_u32(code);
    }
    ENTITIES
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, character)| *character)
}

#[must_use]
pub fn decode(text: &str) -> Option<String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let name_end = after
            .char_indices()
            .take(12)
            .find(|(_, character)| !(character.is_ascii_alphanumeric() || *character == '#'))
            .map(|(index, _)| index);
        match name_end {
            Some(end) if end > 0 && after[end..].starts_with(';') => {
                out.push(entity(&after[..end])?);
                rest = &after[end + 1..];
            }
            _ => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    Some(out)
}

#[must_use]
pub fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '{' => out.push_str("&#123;"),
            '}' => out.push_str("&#125;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            '\r' => {}
            '\n' => out.push(' '),
            other => out.push(other),
        }
    }
    out
}

#[must_use]
pub fn text_part(source: &str, range: Range<usize>, dialect: Dialect) -> Option<ContentPart> {
    let raw = &source[range.clone()];
    let collapsed = match dialect {
        Dialect::Jsx => jsx_whitespace(raw),
        _ => html_whitespace(raw),
    };
    let shown = collapsed.trim_matches(' ');
    if shown.is_empty() {
        return None;
    }
    let start = range.start + (raw.len() - raw.trim_start().len());
    let end = range.start + raw.trim_end().len();
    Some(match decode(shown) {
        Some(value) => ContentPart::Text {
            value,
            range: start..end,
        },
        None => code(&source[start..end]),
    })
}

fn skip_braces(bytes: &[u8], mut at: usize) -> usize {
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    while at < bytes.len() {
        let byte = bytes[at];
        match quote {
            Some(_) if byte == b'\\' => at += 1,
            Some(open) if byte == open => quote = None,
            Some(_) => {}
            None => match byte {
                b'"' | b'\'' | b'`' => quote = Some(byte),
                b'{' => depth += 1,
                b'}' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        return at + 1;
                    }
                }
                _ => {}
            },
        }
        at += 1;
    }
    bytes.len()
}

fn tag_name(source: &str, at: usize) -> &str {
    let end = source[at..]
        .find(|character: char| {
            !(character.is_ascii_alphanumeric() || matches!(character, '-' | ':' | '.' | '_'))
        })
        .map_or(source.len(), |end| at + end);
    &source[at..end]
}

#[must_use]
pub fn start_tag_end(source: &str, at: usize, dialect: Dialect) -> Option<(usize, bool)> {
    let bytes = source.as_bytes();
    let mut index = at;
    let mut quote: Option<u8> = None;
    while index < bytes.len() {
        let byte = bytes[index];
        match quote {
            Some(open) if byte == open => quote = None,
            Some(_) => {}
            None => match byte {
                b'"' | b'\'' => quote = Some(byte),
                b'{' if dialect != Dialect::Html => {
                    index = skip_braces(bytes, index);
                    continue;
                }
                b'>' => return Some((index + 1, bytes[index - 1] == b'/')),
                _ => {}
            },
        }
        index += 1;
    }
    None
}

fn skip_code(source: &str, at: usize, dialect: Dialect) -> Option<usize> {
    match dialect {
        Dialect::Vue if source[at..].starts_with("{{") => Some(
            source[at + 2..]
                .find("}}")
                .map_or(source.len(), |end| at + 2 + end + 2),
        ),
        Dialect::Brace | Dialect::Jsx if source.as_bytes()[at] == b'{' => {
            Some(skip_braces(source.as_bytes(), at))
        }
        _ => None,
    }
}

fn skip_comment(source: &str, at: usize) -> Option<usize> {
    source[at..].starts_with("<!--").then(|| {
        source[at..]
            .find("-->")
            .map_or(source.len(), |end| at + end + 3)
    })
}

fn skip_element(source: &str, from: usize, tag: &str, dialect: Dialect) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut depth = 1usize;
    let mut at = from;
    while at < bytes.len() {
        if let Some(end) = skip_comment(source, at).or_else(|| skip_code(source, at, dialect)) {
            at = end;
            continue;
        }
        if source[at..].starts_with("</") && tag_name(source, at + 2) == tag {
            depth -= 1;
            let end = source[at..]
                .find('>')
                .map_or(source.len(), |end| at + end + 1);
            if depth == 0 {
                return Some(end);
            }
            at = end;
            continue;
        }
        if bytes[at] == b'<' && tag_name(source, at + 1) == tag {
            let (end, closed) = start_tag_end(source, at + 1, dialect)?;
            if !closed {
                depth += 1;
            }
            at = end;
            continue;
        }
        at += 1;
    }
    None
}

#[must_use]
pub fn template_children(
    source: &str,
    inner: usize,
    tag: &str,
    dialect: Dialect,
) -> Option<Vec<ContentPart>> {
    let bytes = source.as_bytes();
    let mut parts = Vec::new();
    let mut at = inner;
    let mut text_start = inner;
    while at < bytes.len() {
        if let Some(end) = skip_comment(source, at) {
            parts.extend(text_part(source, text_start..at, dialect));
            at = end;
            text_start = at;
        } else if let Some(end) = skip_code(source, at, dialect) {
            parts.extend(text_part(source, text_start..at, dialect));
            parts.push(code(&source[at..end]));
            at = end;
            text_start = at;
        } else if source[at..].starts_with("</") {
            parts.extend(text_part(source, text_start..at, dialect));
            return (tag_name(source, at + 2) == tag).then(|| finish(parts, inner));
        } else if bytes[at] == b'<' && bytes.get(at + 1).is_some_and(u8::is_ascii_alphabetic) {
            parts.extend(text_part(source, text_start..at, dialect));
            let name = tag_name(source, at + 1).to_owned();
            let (end, closed) = start_tag_end(source, at + 1, dialect)?;
            at = if closed || is_void(&name) {
                end
            } else {
                skip_element(source, end, &name, dialect)?
            };
            parts.push(ContentPart::Element { tag: name });
            text_start = at;
        } else {
            at += source[at..].chars().next().map_or(1, char::len_utf8);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{ContentPart, Dialect, decode, encode, run_range, template_children, text_part};

    fn text(value: &str) -> String {
        value.to_owned()
    }

    fn shown(parts: &[ContentPart]) -> Vec<String> {
        parts
            .iter()
            .map(|part| match part {
                ContentPart::Text { value, .. } => format!("text {value}"),
                ContentPart::Code { source } => format!("code {source}"),
                ContentPart::Element { tag } => format!("element {tag}"),
            })
            .collect()
    }

    fn children(source: &str, tag: &str, dialect: Dialect) -> Vec<ContentPart> {
        let inner = source.find('>').expect("start tag") + 1;
        template_children(source, inner, tag, dialect).expect("closes")
    }

    #[test]
    fn decodes_named_and_numeric_entities_and_keeps_a_bare_ampersand() {
        assert_eq!(decode("Brew &amp; Co."), Some(text("Brew & Co.")));
        assert_eq!(decode("&#123;x&#x7D; &lt;b&gt;"), Some(text("{x} <b>")));
        assert_eq!(decode("Tom & Jerry"), Some(text("Tom & Jerry")));
        assert_eq!(decode("a&b;c"), None);
    }

    #[test]
    fn escapes_what_would_break_jsx_or_a_template_and_writes_line_breaks_as_spaces() {
        assert_eq!(
            encode("Brew & Co. <Café> {x}\r\nnext\u{a0}line"),
            "Brew &amp; Co. &lt;Café&gt; &#123;x&#125; next&nbsp;line"
        );
    }

    #[test]
    fn follows_jsx_whitespace_and_keeps_the_trimmed_source_range() {
        let source = "<p>\n    Order ahead and pick up\n    at your nearest branch.\n  </p>";
        let range = 3..source.find("</p>").expect("close");
        let Some(ContentPart::Text { value, range }) = text_part(source, range, Dialect::Jsx)
        else {
            panic!("text");
        };
        assert_eq!(value, "Order ahead and pick up at your nearest branch.");
        assert_eq!(
            &source[range],
            "Order ahead and pick up\n    at your nearest branch."
        );
    }

    #[test]
    fn a_run_with_an_unknown_entity_is_code_so_it_is_never_rewritten() {
        let source = "<p>Hi &zwj; there</p>";
        assert_eq!(
            text_part(source, 3..17, Dialect::Jsx),
            Some(ContentPart::Code {
                source: text("Hi &zwj; there")
            })
        );
    }

    #[test]
    fn reads_vue_mustaches_children_and_comments() {
        let source = "<p>Hello <!-- note --> {{ name }}, see <a href=\"/x\">more <b>now</b></a> &amp; bye</p>";
        let parts = children(source, "p", Dialect::Vue);
        assert_eq!(
            shown(&parts),
            [
                "text Hello",
                "code {{ name }}",
                "text , see",
                "element a",
                "text & bye"
            ]
        );
        assert_eq!(&source[run_range(&parts, 2).expect("run")], "&amp; bye");
    }

    #[test]
    fn reads_svelte_blocks_and_nested_tags_with_the_same_name() {
        let source = "<div>{#if open}Open <div>inner <div>deep</div></div>{/if} done</div>";
        let parts = children(source, "div", Dialect::Brace);
        assert_eq!(
            shown(&parts),
            [
                "code {#if open}",
                "text Open",
                "element div",
                "code {/if}",
                "text done"
            ]
        );
    }

    #[test]
    fn keeps_korean_text_next_to_an_element() {
        let source = "<p class=\"mt-2\">\n  오늘의 추천 <span>Ube Latte</span>\n</p>";
        let parts = children(source, "p", Dialect::Brace);
        assert_eq!(shown(&parts), ["text 오늘의 추천", "element span"]);
        assert_eq!(&source[run_range(&parts, 0).expect("run")], "오늘의 추천");
    }

    #[test]
    fn an_empty_element_has_one_empty_run_where_text_would_go() {
        let source = "<p class=\"x\">\n</p>";
        let parts = children(source, "p", Dialect::Html);
        let inner = source.find('>').expect("start tag") + 1;
        assert_eq!(
            parts,
            [ContentPart::Text {
                value: String::new(),
                range: inner..inner
            }]
        );
    }

    #[test]
    fn braces_are_plain_text_in_html_and_an_unclosed_element_reads_as_nothing() {
        let source = "<p>a {b} c</p>";
        assert_eq!(
            shown(&children(source, "p", Dialect::Html)),
            ["text a {b} c"]
        );
        assert_eq!(
            shown(&children("<p>1 < 2 is true</p>", "p", Dialect::Html)),
            ["text 1 < 2 is true"]
        );
        assert_eq!(
            template_children("<p>open <b>bold", 3, "p", Dialect::Html),
            None
        );
    }
}
