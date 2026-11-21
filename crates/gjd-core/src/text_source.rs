use std::ops::Range;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, ArrayExpression, BindingPattern, CallExpression, ChainElement, Expression,
    JSXAttributeItem, JSXAttributeName, JSXAttributeValue, JSXChild, JSXElement, JSXText,
    ObjectProperty, PropertyKey, StringLiteral, TemplateLiteral, VariableDeclarator,
};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::Parser;
use oxc_span::SourceType;

use crate::content::{self, ContentPart, Dialect};
use crate::jsx::{first_error, names_element, span_range};
use crate::srcloc::LineIndex;
use crate::template::{self, AttributeSlot};

const TRANSLATORS: [&str; 4] = ["t", "$t", "_", "$_"];
const MAX_JSON_DEPTH: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    Prop(String),
    Value(String),
    Children,
    Translation(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    pub start: usize,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptBlock {
    pub range: Range<usize>,
    pub path: &'static str,
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn same(found: &str, shown: &str) -> bool {
    collapse(found) == collapse(shown)
}

fn prop(name: &str) -> Key {
    if name == "children" {
        Key::Children
    } else {
        Key::Prop(name.to_owned())
    }
}

fn bare(name: &str) -> Key {
    if name == "children" {
        Key::Children
    } else {
        Key::Value(name.to_owned())
    }
}

fn unwrap(code: &str) -> Option<&str> {
    let code = code.trim();
    let inner = if let Some(rest) = code.strip_prefix("{{") {
        rest.strip_suffix("}}")?
    } else if let Some(rest) = code.strip_prefix('{') {
        rest.strip_suffix('}')?
    } else {
        code
    };
    let inner = inner.trim();
    (!inner.is_empty() && !inner.starts_with(['#', '/', ':', '@'])).then_some(inner)
}

fn translation(call: &CallExpression<'_>) -> Option<Key> {
    let callee = match &call.callee {
        Expression::Identifier(identifier) => identifier.name.as_str(),
        Expression::StaticMemberExpression(member) => member.property.name.as_str(),
        _ => return None,
    };
    if !TRANSLATORS.contains(&callee) {
        return None;
    }
    let Some(Argument::StringLiteral(literal)) = call.arguments.first() else {
        return None;
    };
    let key = literal.value.as_str()?;
    let key = key.rsplit_once(':').map_or(key, |(_, rest)| rest);
    (!key.is_empty()).then(|| Key::Translation(key.to_owned()))
}

fn key_of_expression(expression: &Expression<'_>) -> Option<Key> {
    match expression {
        Expression::Identifier(identifier) => Some(bare(identifier.name.as_str())),
        Expression::StaticMemberExpression(member) => Some(prop(member.property.name.as_str())),
        Expression::ComputedMemberExpression(member) => match &member.expression {
            Expression::StringLiteral(literal) => literal.value.as_str().map(prop),
            _ => None,
        },
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::StaticMemberExpression(member) => {
                Some(prop(member.property.name.as_str()))
            }
            ChainElement::CallExpression(call) => translation(call),
            _ => None,
        },
        Expression::CallExpression(call) => translation(call),
        Expression::ParenthesizedExpression(inner) => key_of_expression(&inner.expression),
        Expression::TSNonNullExpression(inner) => key_of_expression(&inner.expression),
        Expression::TSAsExpression(inner) => key_of_expression(&inner.expression),
        _ => None,
    }
}

#[must_use]
pub fn key_of(code: &str) -> Option<Key> {
    let expression = unwrap(code)?;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, expression, SourceType::tsx())
        .parse_expression()
        .ok()?;
    key_of_expression(&parsed)
}

fn key_name(key: &PropertyKey<'_>) -> Option<String> {
    match key {
        PropertyKey::StaticIdentifier(identifier) => Some(identifier.name.to_string()),
        PropertyKey::StringLiteral(literal) => literal.value.as_str().map(str::to_owned),
        _ => None,
    }
}

fn string_value(expression: &Expression<'_>) -> Option<(usize, String)> {
    match expression {
        Expression::StringLiteral(literal) => literal
            .value
            .as_str()
            .map(|value| (span_range(literal.span).start, value.to_owned())),
        Expression::TemplateLiteral(literal) if literal.expressions.is_empty() => literal
            .quasis
            .first()
            .and_then(|quasi| quasi.value.cooked.as_ref())
            .and_then(|cooked| cooked.as_str())
            .map(|cooked| (span_range(literal.span).start, cooked.to_owned())),
        _ => None,
    }
}

struct PlaceFinder<'s> {
    source: &'s str,
    key: &'s Key,
    text: &'s str,
    component: Option<&'s str>,
    names: Vec<String>,
    places: Vec<Place>,
}

impl PlaceFinder<'_> {
    fn names_key(&self, name: &str) -> bool {
        match self.key {
            Key::Prop(wanted) | Key::Value(wanted) => wanted == name,
            Key::Translation(path) => path.rsplit('.').next() == Some(name),
            Key::Children => false,
        }
    }

    fn nearest_name(&self) -> Option<String> {
        self.names
            .iter()
            .rev()
            .find(|known| !known.is_empty())
            .cloned()
    }

    fn found(&mut self, start: usize, label: String) {
        if !self.places.iter().any(|place| place.start == start) {
            self.places.push(Place { start, label });
        }
    }

    fn render_site(&mut self, element: &JSXElement<'_>, component: &str) {
        match self.key {
            Key::Prop(wanted) | Key::Value(wanted) => {
                for item in &element.opening_element.attributes {
                    let JSXAttributeItem::Attribute(attribute) = item else {
                        continue;
                    };
                    let JSXAttributeName::Identifier(name) = &attribute.name else {
                        continue;
                    };
                    if name.name != wanted.as_str() {
                        continue;
                    }
                    let value = match &attribute.value {
                        Some(JSXAttributeValue::StringLiteral(literal)) => {
                            let range = span_range(literal.span);
                            content::decode(&self.source[range.start + 1..range.end - 1])
                                .map(|value| (range.start, value))
                        }
                        Some(JSXAttributeValue::ExpressionContainer(container)) => {
                            container.expression.as_expression().and_then(string_value)
                        }
                        _ => None,
                    };
                    if let Some((start, value)) = value
                        && same(&value, self.text)
                    {
                        self.found(start, format!("<{component} {wanted}>"));
                    }
                }
            }
            Key::Children => {
                let mut texts = Vec::new();
                for child in &element.children {
                    match child {
                        JSXChild::Text(text) => {
                            texts.extend(content::text_part(
                                self.source,
                                span_range(text.span),
                                Dialect::Jsx,
                            ));
                        }
                        _ => return,
                    }
                }
                if let [ContentPart::Text { value, range }] = texts.as_slice()
                    && same(value, self.text)
                {
                    self.found(range.start, format!("<{component}>"));
                }
            }
            Key::Translation(_) => {}
        }
    }
}

impl<'a> Visit<'a> for PlaceFinder<'_> {
    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        let name = match &it.id {
            BindingPattern::BindingIdentifier(identifier) => Some(identifier.name.to_string()),
            _ => None,
        };
        if let (Some(name), Some(init)) = (&name, &it.init)
            && self.names_key(name)
            && let Some((start, value)) = string_value(init)
            && same(&value, self.text)
        {
            self.found(start, name.clone());
        }
        self.names.push(name.unwrap_or_default());
        walk::walk_variable_declarator(self, it);
        self.names.pop();
    }

    fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
        if !it.computed
            && let Some(name) = key_name(&it.key)
            && self.names_key(&name)
            && let Some((start, value)) = string_value(&it.value)
            && same(&value, self.text)
        {
            let label = self.nearest_name().unwrap_or(name);
            self.found(start, label);
        }
        walk::walk_object_property(self, it);
    }

    fn visit_array_expression(&mut self, it: &ArrayExpression<'a>) {
        if matches!(self.key, Key::Value(_)) {
            for element in &it.elements {
                if let Some((start, value)) = element.as_expression().and_then(string_value)
                    && same(&value, self.text)
                {
                    let label = self.nearest_name().unwrap_or_else(|| "array".to_owned());
                    self.found(start, label);
                }
            }
        }
        walk::walk_array_expression(self, it);
    }

    fn visit_jsx_element(&mut self, it: &JSXElement<'a>) {
        if let Some(component) = self.component
            && names_element(&it.opening_element.name, component)
        {
            self.render_site(it, component);
        }
        walk::walk_jsx_element(self, it);
    }
}

#[must_use]
pub fn js_places(
    path: &str,
    source: &str,
    key: &Key,
    text: &str,
    component: Option<&str>,
) -> Vec<Place> {
    let Ok(source_type) = SourceType::from_path(path) else {
        return Vec::new();
    };
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if first_error(&parsed.diagnostics, parsed.fatal_error).is_err() {
        return Vec::new();
    }
    let mut finder = PlaceFinder {
        source,
        key,
        text,
        component,
        names: Vec::new(),
        places: Vec::new(),
    };
    finder.visit_program(&parsed.program);
    finder.places
}

fn string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut at = start + 1;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' => at += 2,
            b'"' => return Some(at),
            _ => at += 1,
        }
    }
    None
}

struct JsonScanner<'s> {
    source: &'s str,
    at: usize,
    path: Vec<String>,
    key: &'s Key,
    text: &'s str,
    places: Vec<Place>,
}

impl JsonScanner<'_> {
    fn skip_space(&mut self) {
        while self
            .source
            .as_bytes()
            .get(self.at)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.at += 1;
        }
    }

    fn string(&mut self) -> Option<(usize, String)> {
        let start = self.at;
        let end = string_end(self.source.as_bytes(), start)?;
        self.at = end + 1;
        serde_json::from_str::<String>(&self.source[start..=end])
            .ok()
            .map(|value| (start, value))
    }

    fn matches(&self) -> bool {
        match self.key {
            Key::Translation(wanted) => {
                let path = self.path.join(".");
                path == *wanted || path.ends_with(&format!(".{wanted}"))
            }
            Key::Prop(wanted) => self.path.last() == Some(wanted),
            Key::Value(wanted) => self.path.last().is_some_and(|last| {
                last == wanted || last.bytes().all(|byte| byte.is_ascii_digit())
            }),
            Key::Children => false,
        }
    }

    fn value(&mut self, depth: usize) -> Option<()> {
        if depth > MAX_JSON_DEPTH {
            return None;
        }
        self.skip_space();
        match *self.source.as_bytes().get(self.at)? {
            b'{' => {
                self.at += 1;
                loop {
                    self.skip_space();
                    match *self.source.as_bytes().get(self.at)? {
                        b'}' => {
                            self.at += 1;
                            return Some(());
                        }
                        b',' => self.at += 1,
                        b'"' => {
                            let (_, name) = self.string()?;
                            self.skip_space();
                            if self.source.as_bytes().get(self.at) != Some(&b':') {
                                return None;
                            }
                            self.at += 1;
                            self.path.push(name);
                            self.value(depth + 1)?;
                            self.path.pop();
                        }
                        _ => return None,
                    }
                }
            }
            b'[' => {
                self.at += 1;
                let mut index = 0usize;
                loop {
                    self.skip_space();
                    match *self.source.as_bytes().get(self.at)? {
                        b']' => {
                            self.at += 1;
                            return Some(());
                        }
                        b',' => self.at += 1,
                        _ => {
                            self.path.push(index.to_string());
                            self.value(depth + 1)?;
                            self.path.pop();
                            index += 1;
                        }
                    }
                }
            }
            b'"' => {
                let (start, value) = self.string()?;
                if self.matches() && same(&value, self.text) {
                    self.places.push(Place {
                        start,
                        label: self.path.join("."),
                    });
                }
                Some(())
            }
            _ => {
                while self
                    .source
                    .as_bytes()
                    .get(self.at)
                    .is_some_and(|byte| !matches!(byte, b',' | b'}' | b']'))
                {
                    self.at += 1;
                }
                Some(())
            }
        }
    }
}

#[must_use]
pub fn json_places(source: &str, key: &Key, text: &str) -> Vec<Place> {
    let mut scanner = JsonScanner {
        source,
        at: 0,
        path: Vec::new(),
        key,
        text,
        places: Vec::new(),
    };
    if scanner.value(0).is_none() {
        return Vec::new();
    }
    scanner.places
}

fn script_lang(tag: &str) -> &'static str {
    let lowered = tag.to_ascii_lowercase();
    if lowered.contains("lang=\"ts\"")
        || lowered.contains("lang='ts'")
        || lowered.contains("lang=ts")
        || lowered.contains("lang=\"typescript\"")
    {
        "script.ts"
    } else {
        "script.js"
    }
}

#[must_use]
pub fn script_blocks(path: &str, source: &str) -> Vec<ScriptBlock> {
    let mut blocks = Vec::new();
    if path.to_ascii_lowercase().ends_with(".astro") {
        let trimmed = source.trim_start();
        let lead = source.len() - trimmed.len();
        if trimmed.starts_with("---")
            && let Some(newline) = source[lead..].find('\n')
        {
            let body = lead + newline + 1;
            if let Some(close) = source[body..].find("\n---") {
                blocks.push(ScriptBlock {
                    range: body..body + close + 1,
                    path: "script.ts",
                });
            }
        }
    }
    let lowered = source.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lowered[from..].find("<script") {
        let at = from + found;
        let Some((inner, closed)) = content::start_tag_end(source, at + 7, Dialect::Html) else {
            break;
        };
        if closed {
            from = inner;
            continue;
        }
        let Some(close) = lowered[inner..].find("</script") else {
            break;
        };
        blocks.push(ScriptBlock {
            range: inner..inner + close,
            path: script_lang(&source[at..inner]),
        });
        from = inner + close;
    }
    blocks
}

#[must_use]
pub fn template_places(
    path: &str,
    source: &str,
    key: &Key,
    text: &str,
    component: &str,
) -> Vec<Place> {
    let index = LineIndex::new(source);
    let mut places = Vec::new();
    let opener = format!("<{component}");
    for (at, _) in source.match_indices(&opener) {
        let follows = source.as_bytes().get(at + opener.len());
        if !follows.is_some_and(|byte| byte.is_ascii_whitespace() || matches!(byte, b'>' | b'/')) {
            continue;
        }
        let (line, column) = index.position(at);
        match key {
            Key::Prop(wanted) | Key::Value(wanted) => {
                if let Ok(AttributeSlot::Static {
                    value, text: raw, ..
                }) = template::attribute(source, line, column, wanted)
                    && content::decode(&raw).is_some_and(|decoded| same(&decoded, text))
                {
                    places.push(Place {
                        start: value.start - 1,
                        label: format!("<{component} {wanted}>"),
                    });
                }
            }
            Key::Children => {
                let parts = template::find_element(path, source, line, column)
                    .ok()
                    .and_then(|element| element.content);
                if let Some([ContentPart::Text { value, range }]) = parts.as_deref()
                    && same(value, text)
                {
                    places.push(Place {
                        start: range.start,
                        label: format!("<{component}>"),
                    });
                }
            }
            Key::Translation(_) => {}
        }
    }
    places
}

#[must_use]
pub fn in_script_blocks(
    path: &str,
    source: &str,
    key: &Key,
    text: &str,
    component: Option<&str>,
) -> Vec<Place> {
    script_blocks(path, source)
        .into_iter()
        .flat_map(|block| {
            js_places(
                block.path,
                &source[block.range.clone()],
                key,
                text,
                component,
            )
            .into_iter()
            .map(move |place| Place {
                start: place.start + block.range.start,
                label: place.label,
            })
        })
        .collect()
}

fn js_escape(value: &str, quote: char) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            other if other == quote => {
                out.push('\\');
                out.push(other);
            }
            other => out.push(other),
        }
    }
    out
}

fn template_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('`', "\\`")
        .replace("${", "\\${")
}

fn attribute_escape(value: &str, quote: char) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '"' if quote == '"' => out.push_str("&quot;"),
            '\'' if quote == '\'' => out.push_str("&apos;"),
            '\r' => {}
            '\n' => out.push(' '),
            other => out.push(other),
        }
    }
    out
}

struct Rewriter<'s> {
    source: &'s str,
    offset: usize,
    value: &'s str,
    found: Option<(Range<usize>, String)>,
}

impl Rewriter<'_> {
    fn quote_at(&self, start: usize) -> char {
        char::from(self.source.as_bytes()[start])
    }
}

impl<'a> Visit<'a> for Rewriter<'_> {
    fn visit_jsx_attribute_item(&mut self, it: &JSXAttributeItem<'a>) {
        if let JSXAttributeItem::Attribute(attribute) = it
            && let Some(JSXAttributeValue::StringLiteral(literal)) = &attribute.value
            && span_range(literal.span).start == self.offset
        {
            let range = span_range(literal.span);
            let quote = self.quote_at(range.start);
            self.found = Some((
                range.start + 1..range.end - 1,
                attribute_escape(self.value, quote),
            ));
            return;
        }
        walk::walk_jsx_attribute_item(self, it);
    }

    fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
        let range = span_range(it.span);
        if self.found.is_none() && range.start == self.offset {
            let quote = self.quote_at(range.start);
            self.found = Some((range.start + 1..range.end - 1, js_escape(self.value, quote)));
        }
    }

    fn visit_template_literal(&mut self, it: &TemplateLiteral<'a>) {
        let range = span_range(it.span);
        if self.found.is_none() && range.start == self.offset && it.expressions.is_empty() {
            self.found = Some((range.start + 1..range.end - 1, template_escape(self.value)));
            return;
        }
        walk::walk_template_literal(self, it);
    }

    fn visit_jsx_text(&mut self, it: &JSXText<'a>) {
        if self.found.is_none()
            && let Some(ContentPart::Text { range, .. }) =
                content::text_part(self.source, span_range(it.span), Dialect::Jsx)
            && range.start == self.offset
        {
            self.found = Some((range, content::encode(self.value)));
        }
    }
}

fn js_rewrite(
    path: &str,
    source: &str,
    offset: usize,
    value: &str,
) -> Option<(Range<usize>, String)> {
    let source_type = SourceType::from_path(path).ok()?;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    first_error(&parsed.diagnostics, parsed.fatal_error).ok()?;
    let mut rewriter = Rewriter {
        source,
        offset,
        value,
        found: None,
    };
    rewriter.visit_program(&parsed.program);
    rewriter.found
}

fn markup_rewrite(
    path: &str,
    source: &str,
    offset: usize,
    value: &str,
) -> Option<(Range<usize>, String)> {
    let bytes = source.as_bytes();
    let first = *bytes.get(offset)?;
    if matches!(first, b'"' | b'\'') {
        let close = source[offset + 1..].find(char::from(first))? + offset + 1;
        return Some((
            offset + 1..close,
            attribute_escape(value, char::from(first)),
        ));
    }
    if first.is_ascii_whitespace() || first == b'<' {
        return None;
    }
    let stops: &[char] = match Dialect::of(path) {
        Dialect::Html => &['<'],
        _ => &['<', '{'],
    };
    let end = source[offset..]
        .find(stops)
        .map_or(source.len(), |end| offset + end);
    let trimmed = offset + source[offset..end].trim_end().len();
    Some((offset..trimmed, content::encode(value)))
}

fn json_rewrite(source: &str, offset: usize, value: &str) -> Option<(Range<usize>, String)> {
    if source.as_bytes().get(offset) != Some(&b'"') {
        return None;
    }
    let end = string_end(source.as_bytes(), offset)?;
    Some((offset..end + 1, serde_json::to_string(value).ok()?))
}

#[must_use]
pub fn is_json(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".json")
}

#[must_use]
pub fn rewrite_at(
    path: &str,
    source: &str,
    offset: usize,
    value: &str,
) -> Option<(Range<usize>, String)> {
    if is_json(path) {
        return json_rewrite(source, offset, value);
    }
    if template::is_template(path) {
        if let Some(block) = script_blocks(path, source)
            .into_iter()
            .find(|block| block.range.contains(&offset))
        {
            let base = block.range.start;
            let (range, text) = js_rewrite(block.path, &source[block.range], offset - base, value)?;
            return Some((range.start + base..range.end + base, text));
        }
        return markup_rewrite(path, source, offset, value);
    }
    js_rewrite(path, source, offset, value)
}

#[cfg(test)]
mod tests {
    use super::{
        Key, Place, in_script_blocks, js_places, json_places, key_of, rewrite_at, script_blocks,
        template_places,
    };

    fn found(places: &[Place], source: &str) -> Vec<(String, String)> {
        places
            .iter()
            .map(|place| {
                let rest = &source[place.start..];
                let end = match rest.chars().next() {
                    Some(quote @ ('"' | '\'' | '`')) => {
                        rest[1..].find(quote).map_or(rest.len(), |end| end + 2)
                    }
                    _ => rest.find(['<', '\n']).unwrap_or(rest.len()),
                };
                (place.label.clone(), rest[..end].to_owned())
            })
            .collect()
    }

    fn rewrite(path: &str, source: &str, needle: &str, value: &str) -> String {
        let offset = source.find(needle).expect("needle present");
        let (range, text) = rewrite_at(path, source, offset, value).expect("rewrites");
        let mut next = source.to_owned();
        next.replace_range(range, &text);
        next
    }

    #[test]
    fn keys_come_from_member_names_children_and_translation_calls() {
        assert_eq!(
            key_of("{activeTab.title}"),
            Some(Key::Prop("title".to_owned()))
        );
        assert_eq!(
            key_of("{ tab?.title }"),
            Some(Key::Prop("title".to_owned()))
        );
        assert_eq!(
            key_of("{item['label']}"),
            Some(Key::Prop("label".to_owned()))
        );
        assert_eq!(key_of("{name}"), Some(Key::Value("name".to_owned())));
        assert_eq!(key_of("{{ link }}"), Some(Key::Value("link".to_owned())));
        assert_eq!(
            key_of("{(tab.title)!}"),
            Some(Key::Prop("title".to_owned()))
        );
        assert_eq!(
            key_of("{tab.title as string}"),
            Some(Key::Prop("title".to_owned()))
        );
        assert_eq!(key_of("{children}"), Some(Key::Children));
        assert_eq!(key_of("{props.children}"), Some(Key::Children));
        assert_eq!(
            key_of("{t('dash.title')}"),
            Some(Key::Translation("dash.title".to_owned()))
        );
        assert_eq!(
            key_of("{i18n.t(\"common:footer.hours\")}"),
            Some(Key::Translation("footer.hours".to_owned()))
        );
        assert_eq!(
            key_of("{{ $t('nav.home') }}"),
            Some(Key::Translation("nav.home".to_owned()))
        );
        assert_eq!(
            key_of("{$_('nav.home')}"),
            Some(Key::Translation("nav.home".to_owned()))
        );
        assert_eq!(
            key_of("{{ tab.title }}"),
            Some(Key::Prop("title".to_owned()))
        );
        assert_eq!(key_of("{count + 1}"), None);
        assert_eq!(key_of("{format(name)}"), None);
        assert_eq!(key_of("{t(key)}"), None);
        assert_eq!(key_of("{#if open}"), None);
        assert_eq!(key_of("{@html body}"), None);
        assert_eq!(key_of("{}"), None);
    }

    #[test]
    fn finds_data_properties_and_labels_them_with_the_nearest_variable() {
        let source = "const TABS = [\n  { id: 'a', title: \"CBPLD Overview\" },\n  { id: 'b', title: `Reports` },\n];\nexport const nav = { home: { title: 'CBPLD  Overview' } };\nconst title = 'CBPLD Overview';\n";
        let places = js_places(
            "src/Dash.tsx",
            source,
            &Key::Prop("title".to_owned()),
            "CBPLD Overview",
            None,
        );
        assert_eq!(
            found(&places, source),
            vec![
                ("TABS".to_owned(), "\"CBPLD Overview\"".to_owned()),
                ("nav".to_owned(), "'CBPLD  Overview'".to_owned()),
                ("title".to_owned(), "'CBPLD Overview'".to_owned()),
            ]
        );
        let template = js_places(
            "src/Dash.tsx",
            source,
            &Key::Prop("title".to_owned()),
            "Reports",
            None,
        );
        assert_eq!(found(&template, source)[0].1, "`Reports`");
        assert_eq!(
            js_places(
                "src/Dash.tsx",
                "const T = [{ title: `Hi ${name}` }];\n",
                &Key::Prop("title".to_owned()),
                "Hi ${name}",
                None
            ),
            Vec::new()
        );
    }

    #[test]
    fn a_bare_name_also_finds_strings_in_arrays_and_json_lists() {
        let source = "const links = ['Menu', \"Branches\", `Rewards`];\nconst other = { link: 'Menu' };\nconst count = [1, 'Menus'];\n";
        let places = js_places(
            "src/nav.ts",
            source,
            &Key::Value("link".to_owned()),
            "Menu",
            None,
        );
        assert_eq!(
            found(&places, source),
            vec![
                ("links".to_owned(), "'Menu'".to_owned()),
                ("other".to_owned(), "'Menu'".to_owned()),
            ]
        );
        assert_eq!(
            js_places(
                "src/nav.ts",
                source,
                &Key::Prop("link".to_owned()),
                "Branches",
                None
            ),
            Vec::new()
        );
        let json = "{ \"nav\": [\"Menu\", \"Rewards\"], \"link\": \"Menu\" }";
        let labels: Vec<String> = json_places(json, &Key::Value("link".to_owned()), "Menu")
            .into_iter()
            .map(|place| place.label)
            .collect();
        assert_eq!(labels, vec!["nav.0".to_owned(), "link".to_owned()]);
    }

    #[test]
    fn finds_props_and_children_where_a_component_is_rendered() {
        let source = "export const Page = () => (\n  <main>\n    <Note title=\"Open &amp; daily\" />\n    <Note title={'Open & daily'} />\n    <Other title=\"Open & daily\" />\n    <Badge>\n      Fresh   today\n    </Badge>\n    <Badge>Fresh today <b>!</b></Badge>\n  </main>\n);\n";
        let titles = js_places(
            "src/Page.tsx",
            source,
            &Key::Prop("title".to_owned()),
            "Open & daily",
            Some("Note"),
        );
        assert_eq!(
            found(&titles, source),
            vec![
                ("<Note title>".to_owned(), "\"Open &amp; daily\"".to_owned()),
                ("<Note title>".to_owned(), "'Open & daily'".to_owned()),
            ]
        );
        let children = js_places(
            "src/Page.tsx",
            source,
            &Key::Children,
            "Fresh today",
            Some("Badge"),
        );
        assert_eq!(
            found(&children, source),
            vec![("<Badge>".to_owned(), "Fresh   today".to_owned())]
        );
    }

    #[test]
    fn json_matches_translation_paths_and_property_names() {
        let source = "{\n  \"footer\": { \"hours\": \"Open 7 \\\"to\\\" 7\", \"other\": \"x\" },\n  \"list\": [{ \"hours\": \"Open 7 \\\"to\\\" 7\" }],\n  \"n\": 1, \"b\": true\n}\n";
        let translation = json_places(
            source,
            &Key::Translation("footer.hours".to_owned()),
            "Open 7 \"to\" 7",
        );
        assert_eq!(translation.len(), 1);
        assert_eq!(translation[0].label, "footer.hours");
        assert!(source[translation[0].start..].starts_with("\"Open 7"));
        let named = json_places(source, &Key::Prop("hours".to_owned()), "Open 7 \"to\" 7");
        assert_eq!(
            named
                .iter()
                .map(|place| place.label.as_str())
                .collect::<Vec<_>>(),
            vec!["footer.hours", "list.0.hours"]
        );
        let nested = json_places(
            "{\"app\":{\"footer\":{\"hours\":\"Open\"}}}",
            &Key::Translation("footer.hours".to_owned()),
            "Open",
        );
        assert_eq!(nested[0].label, "app.footer.hours");
        assert_eq!(
            json_places("{\"a\": ", &Key::Prop("a".to_owned()), "x"),
            Vec::new()
        );
    }

    #[test]
    fn script_blocks_cover_vue_svelte_and_astro_frontmatter() {
        let vue = "<script setup lang=\"ts\">\nconst TABS = [{ title: 'Home' }];\n</script>\n<template><h1>{{ tab.title }}</h1></template>\n";
        let blocks = script_blocks("src/A.vue", vue);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].path, "script.ts");
        assert!(vue[blocks[0].range.clone()].contains("const TABS"));
        let svelte = "<script context=\"module\">\nexport const A = 1;\n</script>\n<script>\nconst B = { title: 'Home' };\n</script>\n<h1>{B.title}</h1>\n";
        let blocks = script_blocks("src/A.svelte", svelte);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[1].path, "script.js");
        let astro = "---\nconst TABS = [{ title: 'Home' }];\n---\n<h1>{TABS[0].title}</h1>\n";
        let blocks = script_blocks("src/pages/index.astro", astro);
        assert_eq!(blocks.len(), 1);
        assert_eq!(
            &astro[blocks[0].range.clone()],
            "const TABS = [{ title: 'Home' }];\n"
        );
        let places = in_script_blocks(
            "src/pages/index.astro",
            astro,
            &Key::Prop("title".to_owned()),
            "Home",
            None,
        );
        assert_eq!(
            found(&places, astro),
            vec![("TABS".to_owned(), "'Home'".to_owned())]
        );
    }

    #[test]
    fn template_render_sites_give_static_attributes_and_plain_children() {
        let source = "<template>\n  <Note title=\"Open &amp; daily\" />\n  <Note :title=\"x\" />\n  <Notes title=\"Open & daily\" />\n  <Badge>\n    Fresh today\n  </Badge>\n</template>\n";
        let titles = template_places(
            "src/App.vue",
            source,
            &Key::Prop("title".to_owned()),
            "Open & daily",
            "Note",
        );
        assert_eq!(
            found(&titles, source),
            vec![("<Note title>".to_owned(), "\"Open &amp; daily\"".to_owned())]
        );
        let children = template_places(
            "src/App.vue",
            source,
            &Key::Children,
            "Fresh today",
            "Badge",
        );
        assert_eq!(
            found(&children, source),
            vec![("<Badge>".to_owned(), "Fresh today".to_owned())]
        );
    }

    #[test]
    fn rewrites_js_strings_keeping_their_quote() {
        let source = "const A = [{ t: \"Say \\\"hi\\\"\" }, { t: 'It\\'s' }, { t: `Tick` }];\n";
        assert_eq!(
            rewrite("src/a.ts", source, "\"Say", "A \"quote\" and \\ back\nline"),
            "const A = [{ t: \"A \\\"quote\\\" and \\\\ back\\nline\" }, { t: 'It\\'s' }, { t: `Tick` }];\n"
        );
        assert_eq!(
            rewrite("src/a.ts", source, "'It", "Don't"),
            "const A = [{ t: \"Say \\\"hi\\\"\" }, { t: 'Don\\'t' }, { t: `Tick` }];\n"
        );
        assert_eq!(
            rewrite("src/a.ts", source, "`Tick", "a ` b ${x} 오늘"),
            "const A = [{ t: \"Say \\\"hi\\\"\" }, { t: 'It\\'s' }, { t: `a \\` b \\${x} 오늘` }];\n"
        );
        assert!(rewrite_at("src/a.ts", source, source.find("t:").expect("t"), "x").is_none());
    }

    #[test]
    fn rewrites_jsx_attributes_and_children_with_entities() {
        let source = "export const P = () => (\n  <>\n    <Note title=\"Open\" />\n    <Badge>\n      Fresh today\n    </Badge>\n  </>\n);\n";
        assert_eq!(
            rewrite("src/P.tsx", source, "\"Open\"", "A & \"B\""),
            source.replace("\"Open\"", "\"A &amp; &quot;B&quot;\"")
        );
        assert_eq!(
            rewrite("src/P.tsx", source, "Fresh", "New <b> {x}"),
            source.replace("Fresh today", "New &lt;b&gt; &#123;x&#125;")
        );
    }

    #[test]
    fn rewrites_templates_json_and_script_blocks() {
        let vue = "<script setup>\nconst T = [{ title: 'Home' }];\n</script>\n<template>\n  <Note title='Open' />\n  <Badge>Fresh today</Badge>\n</template>\n";
        assert_eq!(
            rewrite("src/A.vue", vue, "'Home'", "It's"),
            vue.replace("'Home'", "'It\\'s'")
        );
        assert_eq!(
            rewrite("src/A.vue", vue, "'Open'", "Bob's & co"),
            vue.replace("'Open'", "'Bob&apos;s &amp; co'")
        );
        assert_eq!(
            rewrite("src/A.vue", vue, "Fresh", "Hot {now}"),
            vue.replace("Fresh today", "Hot &#123;now&#125;")
        );
        let json = "{\n  \"footer\": { \"hours\": \"Open\" }\n}\n";
        assert_eq!(
            rewrite("src/i18n/en.json", json, "\"Open\"", "Say \"hi\"\n오늘"),
            json.replace("\"Open\"", "\"Say \\\"hi\\\"\\n오늘\"")
        );
        assert!(rewrite_at("src/i18n/en.json", json, 0, "x").is_none());
    }
}
