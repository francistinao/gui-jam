use std::ops::Range;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Expression, JSXAttributeItem, JSXAttributeName, JSXAttributeValue, JSXOpeningElement,
    ObjectPropertyKind, PropertyKey, StringLiteral,
};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType, Span};

use crate::srcloc::LineIndex;
use crate::template;

const CLASS_HELPERS: [&str; 5] = ["cn", "clsx", "classnames", "classNames", "cx"];

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
pub struct JsxElement {
    pub tag: String,
    pub insert_at: usize,
    pub class: ClassSource,
    pub style: StyleSource,
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
        return template::find_element(source, line, column);
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
    fn visit_jsx_opening_element(&mut self, it: &JSXOpeningElement<'a>) {
        if self.found.is_none() && span_range(it.span).start == self.offset {
            self.found = Some(describe(self.source, it));
        }
        walk::walk_jsx_opening_element(self, it);
    }
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
    matches!(name, JSXAttributeName::Identifier(identifier) if identifier.name == "className")
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
    use super::{ClassLiteral, ClassSource, JsxError, check_syntax, find_element, imports};

    const FILE: &str = "src/A.tsx";

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
