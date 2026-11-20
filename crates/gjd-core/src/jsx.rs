use std::ops::Range;

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{
    BindingPattern, Expression, JSXAttributeItem, JSXAttributeName, JSXAttributeValue, JSXChild,
    JSXElement, JSXElementName, JSXExpression, JSXOpeningElement, ObjectPropertyKind, PropertyKey,
    StringLiteral,
};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType, Span};

use crate::content::{self, ContentPart, Dialect};
use crate::srcloc::LineIndex;
use crate::template::{self, AttributeSlot};

const SOLID_IMPORT: [&str; 2] = ["from 'solid-js", "from \"solid-js"];

const CLASS_HELPERS: [&str; 5] = ["cn", "clsx", "classnames", "classNames", "cx"];
const PAGE_SLOTS: [&str; 1] = ["Outlet"];

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum JsxError {
    #[error("{0} is not a JavaScript or TypeScript file")]
    UnsupportedFile(String),
    #[error("the file does not parse: {0}")]
    Syntax(String),
    #[error("no JSX element starts at {line}:{column}")]
    ElementNotFound { line: u64, column: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassLiteral {
    pub value: String,
    pub range: Range<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClassSource {
    None,
    Static(ClassLiteral),
    Call {
        literal: ClassLiteral,
        conditional: Vec<String>,
    },
    Dynamic,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyleProp {
    pub key: String,
    pub value: Option<String>,
    pub range: Range<usize>,
    pub value_range: Range<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyleObject {
    pub props: Vec<StyleProp>,
    pub inner: Range<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StyleSource {
    None,
    Object(StyleObject),
    Css(ClassLiteral),
    Dynamic,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Component {
    pub name: String,
    pub root: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsxElement {
    pub tag: String,
    pub insert_at: usize,
    pub class: ClassSource,
    pub style: StyleSource,
    pub content: Option<Vec<ContentPart>>,
}

fn source_type(path: &str) -> Result<SourceType, JsxError> {
    SourceType::from_path(path).map_err(|_| JsxError::UnsupportedFile(path.to_owned()))
}

pub fn check_syntax(path: &str, source: &str) -> Result<(), JsxError> {
    if template::is_template(path) {
        return Ok(());
    }
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type(path)?).parse();
    first_error(&parsed.diagnostics, parsed.fatal_error)
}

pub fn imports(path: &str, source: &str) -> Result<Vec<String>, JsxError> {
    if template::is_template(path) {
        return Ok(Vec::new());
    }
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type(path)?).parse();
    first_error(&parsed.diagnostics, parsed.fatal_error)?;
    let record = &parsed.module_record;
    let mut found: Vec<String> = record
        .requested_modules
        .keys()
        .map(ToString::to_string)
        .collect();
    for dynamic in &record.dynamic_imports {
        let request =
            &source[dynamic.module_request.start as usize..dynamic.module_request.end as usize];
        let literal = request
            .trim()
            .strip_prefix(['"', '\''])
            .and_then(|rest| rest.strip_suffix(['"', '\'']));
        if let Some(specifier) = literal {
            found.push(specifier.to_owned());
        }
    }
    found.sort();
    found.dedup();
    Ok(found)
}

pub fn find_element(
    path: &str,
    source: &str,
    line: u64,
    column: u64,
) -> Result<JsxElement, JsxError> {
    if template::is_template(path) {
        return template::find_element(path, source, line, column);
    }
    let not_found = JsxError::ElementNotFound { line, column };
    let offset = LineIndex::new(source)
        .offset(line, column)
        .ok_or_else(|| not_found.clone())?;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type(path)?).parse();
    first_error(&parsed.diagnostics, parsed.fatal_error)?;

    let mut finder = ElementFinder {
        source,
        offset,
        found: None,
    };
    finder.visit_program(&parsed.program);
    finder.found.ok_or(not_found)
}

#[must_use]
pub fn enclosing_component(path: &str, source: &str, line: u64, column: u64) -> Option<Component> {
    if template::is_template(path) {
        return None;
    }
    let offset = LineIndex::new(source).offset(line, column)?;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type(path).ok()?).parse();
    first_error(&parsed.diagnostics, parsed.fatal_error).ok()?;
    let mut finder = ComponentFinder {
        offset,
        components: Vec::new(),
        functions: Vec::new(),
        wrappers: Vec::new(),
    };
    finder.visit_program(&parsed.program);
    let (name, own) = finder
        .components
        .into_iter()
        .min_by_key(|(_, range)| range.len())?;
    let inside =
        |range: &Range<usize>| *range != own && own.start <= range.start && range.end <= own.end;
    let root = !finder.wrappers.iter().any(inside) && !finder.functions.iter().any(inside);
    Some(Component { name, root })
}

pub fn usages(path: &str, source: &str, name: &str) -> Result<Vec<(u64, u64)>, JsxError> {
    if template::is_template(path) {
        return Ok(Vec::new());
    }
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type(path)?).parse();
    first_error(&parsed.diagnostics, parsed.fatal_error)?;
    let mut finder = UsageFinder {
        name,
        starts: Vec::new(),
    };
    finder.visit_program(&parsed.program);
    let index = LineIndex::new(source);
    Ok(finder
        .starts
        .into_iter()
        .map(|offset| index.position(offset))
        .collect())
}

pub fn renders_children(
    path: &str,
    source: &str,
    line: u64,
    column: u64,
) -> Result<bool, JsxError> {
    if template::is_template(path) {
        return Ok(false);
    }
    let not_found = JsxError::ElementNotFound { line, column };
    let offset = LineIndex::new(source)
        .offset(line, column)
        .ok_or_else(|| not_found.clone())?;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type(path)?).parse();
    first_error(&parsed.diagnostics, parsed.fatal_error)?;
    let mut finder = SlotFinder {
        offset,
        target: None,
        slots: Vec::new(),
    };
    finder.visit_program(&parsed.program);
    let target = finder.target.ok_or(not_found)?;
    Ok(finder
        .slots
        .iter()
        .any(|slot| *slot > target.start && *slot < target.end))
}

fn is_component_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|first| first.is_ascii_uppercase())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn names_element(name: &JSXElementName<'_>, wanted: &str) -> bool {
    match name {
        JSXElementName::IdentifierReference(identifier) => identifier.name == wanted,
        JSXElementName::Identifier(identifier) => identifier.name == wanted,
        _ => false,
    }
}

fn component_body(init: &Expression<'_>) -> Option<Span> {
    match init {
        Expression::ArrowFunctionExpression(arrow) => Some(arrow.span),
        Expression::FunctionExpression(function) => Some(function.span),
        Expression::ParenthesizedExpression(inner) => component_body(&inner.expression),
        Expression::CallExpression(call) => call
            .arguments
            .first()
            .and_then(|argument| argument.as_expression())
            .and_then(component_body),
        _ => None,
    }
}

struct ComponentFinder {
    offset: usize,
    components: Vec<(String, Range<usize>)>,
    functions: Vec<Range<usize>>,
    wrappers: Vec<Range<usize>>,
}

impl ComponentFinder {
    fn holds(&self, span: Span) -> bool {
        let range = span_range(span);
        range.start <= self.offset && self.offset < range.end
    }
}

impl<'a> Visit<'a> for ComponentFinder {
    fn enter_node(&mut self, kind: AstKind<'a>) {
        match kind {
            AstKind::Function(function) if self.holds(function.span) => {
                self.functions.push(span_range(function.span));
                if let Some(id) = &function.id
                    && is_component_name(&id.name)
                {
                    self.components
                        .push((id.name.to_string(), span_range(function.span)));
                }
            }
            AstKind::ArrowFunctionExpression(arrow) if self.holds(arrow.span) => {
                self.functions.push(span_range(arrow.span));
            }
            AstKind::VariableDeclarator(declarator) => {
                if let BindingPattern::BindingIdentifier(id) = &declarator.id
                    && is_component_name(&id.name)
                    && let Some(body) = declarator.init.as_ref().and_then(component_body)
                    && self.holds(body)
                {
                    self.components
                        .push((id.name.to_string(), span_range(body)));
                }
            }
            AstKind::JSXElement(element)
                if self.holds(element.span) && span_range(element.span).start < self.offset =>
            {
                self.wrappers.push(span_range(element.span));
            }
            AstKind::JSXFragment(fragment) if self.holds(fragment.span) => {
                self.wrappers.push(span_range(fragment.span));
            }
            _ => {}
        }
    }
}

struct UsageFinder<'n> {
    name: &'n str,
    starts: Vec<usize>,
}

impl<'a> Visit<'a> for UsageFinder<'_> {
    fn visit_jsx_opening_element(&mut self, it: &JSXOpeningElement<'a>) {
        if names_element(&it.name, self.name) {
            self.starts.push(span_range(it.span).start);
        }
        walk::walk_jsx_opening_element(self, it);
    }
}

struct SlotFinder {
    offset: usize,
    target: Option<Range<usize>>,
    slots: Vec<usize>,
}

impl<'a> Visit<'a> for SlotFinder {
    fn enter_node(&mut self, kind: AstKind<'a>) {
        match kind {
            AstKind::JSXElement(element)
                if self.target.is_none() && span_range(element.span).start == self.offset =>
            {
                self.target = Some(span_range(element.span));
            }
            AstKind::JSXOpeningElement(opening)
                if PAGE_SLOTS
                    .iter()
                    .any(|slot| names_element(&opening.name, slot)) =>
            {
                self.slots.push(span_range(opening.span).start);
            }
            AstKind::JSXExpressionContainer(container) => {
                let children = match container.expression.as_expression() {
                    Some(Expression::Identifier(identifier)) => identifier.name == "children",
                    Some(Expression::StaticMemberExpression(member)) => {
                        member.property.name == "children"
                    }
                    _ => false,
                };
                if children {
                    self.slots.push(span_range(container.span).start);
                }
            }
            _ => {}
        }
    }
}

pub fn attribute(
    path: &str,
    source: &str,
    line: u64,
    column: u64,
    name: &str,
) -> Result<AttributeSlot, JsxError> {
    if template::is_template(path) {
        return template::attribute(source, line, column, name);
    }
    let not_found = JsxError::ElementNotFound { line, column };
    let offset = LineIndex::new(source)
        .offset(line, column)
        .ok_or_else(|| not_found.clone())?;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type(path)?).parse();
    first_error(&parsed.diagnostics, parsed.fatal_error)?;

    let mut finder = AttributeFinder {
        source,
        offset,
        name,
        found: None,
    };
    finder.visit_program(&parsed.program);
    finder.found.ok_or(not_found)
}

struct AttributeFinder<'n> {
    source: &'n str,
    offset: usize,
    name: &'n str,
    found: Option<AttributeSlot>,
}

impl<'a> Visit<'a> for AttributeFinder<'_> {
    fn visit_jsx_opening_element(&mut self, it: &JSXOpeningElement<'a>) {
        if self.found.is_none() && span_range(it.span).start == self.offset {
            self.found = Some(attribute_slot(self.source, it, self.name));
        }
        walk::walk_jsx_opening_element(self, it);
    }
}

fn attribute_slot(source: &str, element: &JSXOpeningElement<'_>, name: &str) -> AttributeSlot {
    let mut found = None;
    let mut last_spread = None;
    for (index, item) in element.attributes.iter().enumerate() {
        match item {
            JSXAttributeItem::Attribute(attribute) if is_named(&attribute.name, name) => {
                found = Some((index, attribute));
            }
            JSXAttributeItem::SpreadAttribute(_) => last_spread = Some(index),
            JSXAttributeItem::Attribute(_) => {}
        }
    }
    if overridden(found.map(|(index, _)| index), last_spread) {
        return AttributeSlot::Bound;
    }
    let Some((_, attribute)) = found else {
        return AttributeSlot::Missing {
            insert_at: span_range(element.name.span()).end,
        };
    };
    match &attribute.value {
        Some(JSXAttributeValue::StringLiteral(literal)) => {
            let outer = span_range(literal.span);
            let value = outer.start + 1..outer.end - 1;
            AttributeSlot::Static {
                whole: span_range(attribute.span),
                text: source[value.clone()].to_owned(),
                value,
            }
        }
        _ => AttributeSlot::Bound,
    }
}

fn first_error(diagnostics: &oxc_diagnostics::Diagnostics, fatal: bool) -> Result<(), JsxError> {
    if let Some(error) = diagnostics.errors().next() {
        return Err(JsxError::Syntax(error.to_string()));
    }
    if fatal {
        return Err(JsxError::Syntax("unrecoverable parse error".to_owned()));
    }
    Ok(())
}

struct ElementFinder<'s> {
    source: &'s str,
    offset: usize,
    found: Option<JsxElement>,
}

impl<'a> Visit<'a> for ElementFinder<'_> {
    fn visit_jsx_element(&mut self, it: &JSXElement<'a>) {
        if self.found.is_none() && span_range(it.opening_element.span).start == self.offset {
            let mut element = describe(self.source, &it.opening_element);
            element.content = jsx_content(self.source, it);
            self.found = Some(element);
        }
        walk::walk_jsx_element(self, it);
    }
}

fn jsx_content(source: &str, element: &JSXElement<'_>) -> Option<Vec<ContentPart>> {
    element.closing_element.as_ref()?;
    let mut parts = Vec::new();
    for child in &element.children {
        match child {
            JSXChild::Text(text) => {
                parts.extend(content::text_part(
                    source,
                    span_range(text.span),
                    Dialect::Jsx,
                ));
            }
            JSXChild::Element(child) => parts.push(ContentPart::Element {
                tag: child.opening_element.name.to_string(),
            }),
            JSXChild::Fragment(_) => parts.push(ContentPart::Element { tag: String::new() }),
            JSXChild::ExpressionContainer(container) => {
                if !matches!(container.expression, JSXExpression::EmptyExpression(_)) {
                    parts.push(content::code(&source[span_range(container.span)]));
                }
            }
            JSXChild::Spread(spread) => parts.push(content::code(&source[span_range(spread.span)])),
        }
    }
    Some(content::finish(
        parts,
        span_range(element.opening_element.span).end,
    ))
}

fn span_range(span: Span) -> Range<usize> {
    span.start as usize..span.end as usize
}

fn overridden(at: Option<usize>, last_spread: Option<usize>) -> bool {
    match (at, last_spread) {
        (Some(at), Some(spread_at)) => spread_at > at,
        (None, Some(_)) => true,
        _ => false,
    }
}

fn describe(source: &str, element: &JSXOpeningElement<'_>) -> JsxElement {
    let mut class = ClassSource::None;
    let mut style = StyleSource::None;
    let mut class_index = None;
    let mut style_index = None;
    let mut last_spread = None;
    for (index, item) in element.attributes.iter().enumerate() {
        match item {
            JSXAttributeItem::Attribute(attribute) if is_class_name(&attribute.name) => {
                class = read_class(source, attribute.value.as_ref());
                class_index = Some(index);
            }
            JSXAttributeItem::Attribute(attribute) if is_named(&attribute.name, "style") => {
                style = read_style(source, attribute.value.as_ref());
                style_index = Some(index);
            }
            JSXAttributeItem::SpreadAttribute(_) => last_spread = Some(index),
            JSXAttributeItem::Attribute(_) => {}
        }
    }
    JsxElement {
        tag: element.name.to_string(),
        insert_at: span_range(element.name.span()).end,
        class: if overridden(class_index, last_spread) {
            ClassSource::Dynamic
        } else {
            class
        },
        style: if overridden(style_index, last_spread) {
            StyleSource::Dynamic
        } else {
            style
        },
        content: None,
    }
}

fn is_named(name: &JSXAttributeName<'_>, wanted: &str) -> bool {
    matches!(name, JSXAttributeName::Identifier(identifier) if identifier.name == wanted)
}

fn read_style(source: &str, value: Option<&JSXAttributeValue<'_>>) -> StyleSource {
    let Some(JSXAttributeValue::ExpressionContainer(container)) = value else {
        return StyleSource::Dynamic;
    };
    let Some(Expression::ObjectExpression(object)) = container.expression.as_expression() else {
        return StyleSource::Dynamic;
    };
    let mut props = Vec::new();
    for property in &object.properties {
        let ObjectPropertyKind::ObjectProperty(property) = property else {
            return StyleSource::Dynamic;
        };
        if property.computed || property.method {
            return StyleSource::Dynamic;
        }
        let key = match &property.key {
            PropertyKey::StaticIdentifier(identifier) => identifier.name.to_string(),
            PropertyKey::StringLiteral(literal) => match literal.value.as_str() {
                Some(value) => value.to_owned(),
                None => return StyleSource::Dynamic,
            },
            _ => return StyleSource::Dynamic,
        };
        let value = match &property.value {
            Expression::StringLiteral(literal) if !property.shorthand => {
                plain_js_string(source, literal).map(|inner| inner.value)
            }
            Expression::NumericLiteral(literal) if !property.shorthand => {
                Some(source[span_range(literal.span)].to_owned())
            }
            _ => None,
        };
        props.push(StyleProp {
            key,
            value,
            range: span_range(property.span),
            value_range: span_range(property.value.span()),
        });
    }
    let outer = span_range(object.span);
    StyleSource::Object(StyleObject {
        props,
        inner: outer.start + 1..outer.end - 1,
    })
}

fn is_class_name(name: &JSXAttributeName<'_>) -> bool {
    matches!(name, JSXAttributeName::Identifier(identifier) if identifier.name == "className" || identifier.name == "class")
}

#[must_use]
pub fn is_solid(source: &str) -> bool {
    SOLID_IMPORT.iter().any(|import| source.contains(import))
}

#[must_use]
pub fn class_attribute(path: &str, source: &str) -> &'static str {
    if template::is_template(path) || is_solid(source) {
        "class"
    } else {
        "className"
    }
}

fn read_class(source: &str, value: Option<&JSXAttributeValue<'_>>) -> ClassSource {
    match value {
        Some(JSXAttributeValue::StringLiteral(literal)) => {
            ClassSource::Static(between_delimiters(source, literal.span))
        }
        Some(JSXAttributeValue::ExpressionContainer(container)) => container
            .expression
            .as_expression()
            .map_or(ClassSource::Dynamic, |expression| {
                read_class_expression(source, expression)
            }),
        _ => ClassSource::Dynamic,
    }
}

fn read_class_expression(source: &str, expression: &Expression<'_>) -> ClassSource {
    match expression {
        Expression::StringLiteral(literal) => {
            plain_js_string(source, literal).map_or(ClassSource::Dynamic, ClassSource::Static)
        }
        Expression::TemplateLiteral(template) if template.expressions.is_empty() => {
            let literal = between_delimiters(source, template.span);
            if literal.value.contains('\\') {
                ClassSource::Dynamic
            } else {
                ClassSource::Static(literal)
            }
        }
        Expression::ParenthesizedExpression(inner) => {
            read_class_expression(source, &inner.expression)
        }
        Expression::CallExpression(call) if is_class_helper(&call.callee) => {
            let mut arguments = call.arguments.iter();
            let literal = arguments
                .next()
                .and_then(|first| match first.as_expression() {
                    Some(Expression::StringLiteral(literal)) => plain_js_string(source, literal),
                    _ => None,
                });
            let Some(literal) = literal else {
                return ClassSource::Dynamic;
            };
            let mut strings = StringCollector::default();
            for argument in arguments {
                if let Some(expression) = argument.as_expression() {
                    strings.visit_expression(expression);
                }
            }
            ClassSource::Call {
                literal,
                conditional: strings.values,
            }
        }
        _ => ClassSource::Dynamic,
    }
}

fn is_class_helper(callee: &Expression<'_>) -> bool {
    matches!(callee, Expression::Identifier(identifier) if CLASS_HELPERS.contains(&identifier.name.as_str()))
}

fn between_delimiters(source: &str, span: Span) -> ClassLiteral {
    let range = span_range(span);
    let inner = range.start + 1..range.end - 1;
    ClassLiteral {
        value: source[inner.clone()].to_owned(),
        range: inner,
    }
}

fn plain_js_string(source: &str, literal: &StringLiteral<'_>) -> Option<ClassLiteral> {
    let inner = between_delimiters(source, literal.span);
    (!inner.value.contains('\\')).then_some(inner)
}

#[derive(Default)]
struct StringCollector {
    values: Vec<String>,
}

impl<'a> Visit<'a> for StringCollector {
    fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
        if let Some(value) = it.value.as_str() {
            self.values.push(value.to_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ClassLiteral, ClassSource, Component, JsxError, check_syntax, enclosing_component,
        find_element, imports, renders_children, usages,
    };
    use crate::content::ContentPart;
    use crate::srcloc::LineIndex;

    fn content_at(source: &str, needle: &str) -> Option<Vec<String>> {
        let (line, column) = at(source, needle);
        let element = find_element(FILE, source, line, column).expect("element");
        element.content.map(|parts| {
            parts
                .iter()
                .map(|part| match part {
                    ContentPart::Text { value, range } => {
                        format!("text {value} @{}", &source[range.clone()])
                    }
                    ContentPart::Code { source } => format!("code {source}"),
                    ContentPart::Element { tag } => format!("element {tag}"),
                })
                .collect()
        })
    }

    #[test]
    fn reads_the_plain_text_runs_code_and_children_between_a_jsx_elements_tags() {
        let source = r#"export const A = ({ name, t, children }) => (
  <main>
    <h1 className="text-5xl">Slow-roasted, made for mornings</h1>
    <p>
      Order ahead and pick up
      at your nearest branch.
    </p>
    <span>Brew &amp; Co.</span>
    <b>Hello <strong>world</strong>!</b>
    <i>오늘의 추천 <span>Ube Latte</span></i>
    <em>Hi {name}, {t('greeting')} {/* note */}</em>
    <section>{children}</section>
    <u></u>
    <img alt="cup" />
    <s><>x</></s>
  </main>
);
"#;
        assert_eq!(
            content_at(source, "<h1"),
            Some(vec![
                "text Slow-roasted, made for mornings @Slow-roasted, made for mornings".to_owned()
            ])
        );
        assert_eq!(
            content_at(source, "<p>"),
            Some(vec![
                "text Order ahead and pick up at your nearest branch. @Order ahead and pick up\n      at your nearest branch.".to_owned()
            ])
        );
        assert_eq!(
            content_at(source, "<span>Brew"),
            Some(vec!["text Brew & Co. @Brew &amp; Co.".to_owned()])
        );
        assert_eq!(
            content_at(source, "<b>"),
            Some(vec![
                "text Hello @Hello".to_owned(),
                "element strong".to_owned(),
                "text ! @!".to_owned()
            ])
        );
        assert_eq!(
            content_at(source, "<i>"),
            Some(vec![
                "text 오늘의 추천 @오늘의 추천".to_owned(),
                "element span".to_owned()
            ])
        );
        assert_eq!(
            content_at(source, "<em>"),
            Some(vec![
                "text Hi @Hi".to_owned(),
                "code {name}".to_owned(),
                "text , @,".to_owned(),
                "code {t('greeting')}".to_owned()
            ])
        );
        assert_eq!(
            content_at(source, "<section>"),
            Some(vec!["code {children}".to_owned()])
        );
        assert_eq!(content_at(source, "<u>"), Some(vec!["text  @".to_owned()]));
        assert_eq!(content_at(source, "<img"), None);
        assert_eq!(content_at(source, "<s>"), Some(vec!["element ".to_owned()]));
    }

    const FILE: &str = "src/A.tsx";

    fn at(source: &str, needle: &str) -> (u64, u64) {
        LineIndex::new(source).position(source.find(needle).expect("needle present"))
    }

    fn component_at(source: &str, needle: &str) -> Option<Component> {
        let (line, column) = at(source, needle);
        enclosing_component(FILE, source, line, column)
    }

    fn component(name: &str, root: bool) -> Component {
        Component {
            name: name.to_owned(),
            root,
        }
    }

    #[test]
    fn finds_the_component_an_element_belongs_to_and_whether_it_is_the_root() {
        let source = r#"import { forwardRef, memo } from 'react';
export function Card({ items }: { items: string[] }) {
  if (items.length === 0) return <p>Empty</p>;
  return (
    <section className="p-4">
      <h2>Title</h2>
      {items.map((item) => <li key={item}>{item}</li>)}
    </section>
  );
}
export const Badge = () => <span>new</span>;
export const Price = memo(function Price() { return <b>9</b>; });
export const Field = forwardRef<HTMLInputElement, object>((props, ref) => <input ref={ref} {...props} />);
export default function Page() { return <><main /></>; }
const label = <i>x</i>;
"#;

        assert_eq!(
            component_at(source, "<section"),
            Some(component("Card", true))
        );
        assert_eq!(
            component_at(source, "<p>Empty"),
            Some(component("Card", true))
        );
        assert_eq!(component_at(source, "<h2>"), Some(component("Card", false)));
        assert_eq!(component_at(source, "<li "), Some(component("Card", false)));
        assert_eq!(
            component_at(source, "<span>"),
            Some(component("Badge", true))
        );
        assert_eq!(component_at(source, "<b>"), Some(component("Price", true)));
        assert_eq!(
            component_at(source, "<input"),
            Some(component("Field", true))
        );
        assert_eq!(
            component_at(source, "<main"),
            Some(component("Page", false))
        );
        assert_eq!(component_at(source, "<i>"), None);
        assert_eq!(enclosing_component("src/App.vue", source, 5, 5), None);
        assert_eq!(enclosing_component(FILE, "const a = <b>;", 1, 11), None);
    }

    #[test]
    fn lists_where_a_component_is_rendered() {
        let source = r#"import { Card } from './Card';
export function App() {
  return (
    <main>
      <Card title="a" />
      <Card>
        <CardHeader />
      </Card>
      {'<Card />'}
      {/* <Card /> */}
    </main>
  );
}
"#;

        assert_eq!(
            usages("src/App.tsx", source, "Card").expect("parses"),
            [(5, 7), (6, 7)]
        );
        assert_eq!(
            usages("src/App.tsx", source, "CardHeader").expect("parses"),
            [(7, 9)]
        );
        assert_eq!(
            usages("src/App.tsx", source, "Missing").expect("parses"),
            Vec::<(u64, u64)>::new()
        );
        assert!(usages("src/B.tsx", "const b = <b>;", "Card").is_err());
        assert_eq!(
            usages("src/App.vue", "<Card />", "Card").expect("templates are skipped"),
            Vec::<(u64, u64)>::new()
        );
    }

    #[test]
    fn tells_whether_an_element_renders_the_routed_page_or_its_children() {
        let layout = r#"export function Shell() {
  return (
    <div>
      <main className="p-6">
        <Outlet />
      </main>
      <aside><nav /></aside>
    </div>
  );
}
"#;
        let children = "export const L = ({ children }) => <main>{children}</main>;";
        let props = "export const L = (props) => <main>{props.children}</main>;";
        let neither = "export const L = () => <main>{title}</main>;";
        let check = |source: &str, needle: &str| {
            let (line, column) = at(source, needle);
            renders_children(FILE, source, line, column).expect("element found")
        };

        assert!(check(layout, "<main"));
        assert!(check(layout, "<div>"));
        assert!(!check(layout, "<aside>"));
        assert!(check(children, "<main>"));
        assert!(check(props, "<main>"));
        assert!(!check(neither, "<main>"));
        assert_eq!(
            renders_children(FILE, neither, 1, 2),
            Err(JsxError::ElementNotFound { line: 1, column: 2 })
        );
        assert_eq!(renders_children("src/App.vue", layout, 4, 7), Ok(false));
    }

    fn class_of(source: &str, line: u64, column: u64) -> ClassSource {
        find_element(FILE, source, line, column)
            .expect("element found")
            .class
    }

    fn literal(source: &str, value: &str) -> ClassLiteral {
        let start = source.find(value).expect("value present");
        ClassLiteral {
            value: value.to_owned(),
            range: start..start + value.len(),
        }
    }

    #[test]
    fn reads_a_plain_class_name_string() {
        let source = r#"const a = <button className="rounded-lg bg-brand">Go</button>;"#;

        assert_eq!(
            class_of(source, 1, 11),
            ClassSource::Static(literal(source, "rounded-lg bg-brand"))
        );
    }

    #[test]
    fn reads_braced_strings_and_plain_template_literals() {
        let braced = "const a = <i className={'p-2 bg-red-500'} />;";
        let template = "const a = <i className={`p-2 bg-red-500`} />;";

        assert_eq!(
            class_of(braced, 1, 11),
            ClassSource::Static(literal(braced, "p-2 bg-red-500"))
        );
        assert_eq!(
            class_of(template, 1, 11),
            ClassSource::Static(literal(template, "p-2 bg-red-500"))
        );
    }

    #[test]
    fn treats_the_first_cn_argument_as_editable_and_the_rest_as_conditional() {
        let source =
            "const a = <b className={cn('px-4 border', on && 'font-semibold', x ? 'a' : 'b')} />;";

        assert_eq!(
            class_of(source, 1, 11),
            ClassSource::Call {
                literal: literal(source, "px-4 border"),
                conditional: vec!["font-semibold".to_owned(), "a".to_owned(), "b".to_owned()],
            }
        );
    }

    #[test]
    fn treats_computed_class_names_as_dynamic() {
        for source in [
            "const a = <b className={styles.button} />;",
            "const a = <b className={`p-2 ${size}`} />;",
            "const a = <b className={cn(base, 'p-2')} />;",
            r#"const a = <b className={"p-2\n"} />;"#,
        ] {
            assert_eq!(class_of(source, 1, 11), ClassSource::Dynamic, "{source}");
        }
    }

    #[test]
    fn treats_a_class_that_spread_props_can_override_as_dynamic() {
        let after = r#"const a = <b className="p-2" {...rest} />;"#;
        let only_spread = "const a = <b {...rest} />;";
        let before = r#"const a = <b {...rest} className="p-2" />;"#;

        assert_eq!(class_of(after, 1, 11), ClassSource::Dynamic);
        assert_eq!(class_of(only_spread, 1, 11), ClassSource::Dynamic);
        assert_eq!(
            class_of(before, 1, 11),
            ClassSource::Static(literal(before, "p-2"))
        );
    }

    #[test]
    fn reports_where_a_class_name_can_be_inserted() {
        let source = r#"const a = <section id="x">hi</section>;"#;

        let element = find_element(FILE, source, 1, 11).expect("element found");

        assert_eq!(element.tag, "section");
        assert_eq!(element.class, ClassSource::None);
        assert_eq!(&source[element.insert_at..element.insert_at + 4], " id=");
    }

    #[test]
    fn finds_an_element_after_korean_text_on_the_same_line() {
        let source = "const p = <p>오늘의 추천 <span className=\"font-semibold\">x</span></p>;";

        let element = find_element(FILE, source, 1, 21).expect("element found");

        assert_eq!(element.tag, "span");
    }

    #[test]
    fn reports_a_missing_element_and_a_syntax_error() {
        assert_eq!(
            find_element(FILE, "const a = <b />;", 1, 2),
            Err(JsxError::ElementNotFound { line: 1, column: 2 })
        );
        assert!(matches!(
            find_element(FILE, "const a = <b>;", 1, 11),
            Err(JsxError::Syntax(_))
        ));
        assert!(check_syntax(FILE, "const a = <b />;").is_ok());
        assert!(matches!(
            check_syntax("styles.css", "a {}"),
            Err(JsxError::UnsupportedFile(_))
        ));
    }

    #[test]
    fn lists_static_re_exported_and_literal_dynamic_imports() {
        let source = r#"import { Canvas } from '@react-three/fiber';
import * as THREE from "three";
import './styles.css';
import type { Props } from './types';
export { motion } from 'motion/react';
export * from '../atoms';
const lazy = () => import('gsap');
const dynamic = (name: string) => import(name);
export const A = () => <Canvas />;
"#;

        let found = imports("src/A.tsx", source).expect("parses");

        assert_eq!(
            found,
            [
                "../atoms",
                "./styles.css",
                "./types",
                "@react-three/fiber",
                "gsap",
                "motion/react",
                "three"
            ]
        );
        assert!(imports("src/B.tsx", "export const B = () => <b>;").is_err());
        assert_eq!(
            imports("src/C.ts", "export const c = 1;").expect("no imports"),
            Vec::<String>::new()
        );
    }
}
