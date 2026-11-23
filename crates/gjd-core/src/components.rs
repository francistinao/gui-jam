use std::collections::HashMap;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    ArrayExpressionElement, ArrowFunctionExpression, BindingPattern, CallExpression, Declaration,
    ExportDefaultDeclarationKind, Expression, FormalParameter, Function, FunctionBody,
    JSXAttributeItem, JSXAttributeName, JSXAttributeValue, JSXChild, JSXOpeningElement,
    ObjectExpression, ObjectPropertyKind, Program, PropertyKey, ReturnStatement, Statement,
    TSSignature, TSType, TSTypeName, VariableDeclarator,
};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType, Span};
use oxc_syntax::module_record::{
    ExportExportName, ExportImportName, ImportImportName, ModuleRecord,
};
use oxc_syntax::scope::ScopeFlags;

use crate::jsx::{self, ClassSource, JsxError};
use crate::srcloc::LineIndex;
use crate::template::{self, AttributeSlot};

const MAX_TYPE_CHARS: usize = 48;
const MAX_TYPE_DEPTH: usize = 4;
const PASS_THROUGH: [&str; 5] = ["Readonly", "FC", "FunctionComponent", "VFC", "Component"];
const WITH_CHILDREN: &str = "PropsWithChildren";
const ALL_OPTIONAL: &str = "Partial";
const FORWARD_REF: &str = "forwardRef";
const SKIPPED_BLOCKS: [(&str, &str); 6] = [
    ("<script", "</script>"),
    ("<style", "</style>"),
    ("<svelte:head", "</svelte:head>"),
    ("<svelte:", ">"),
    ("<!--", "-->"),
    ("<template", ">"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Export {
    Named(String),
    Default,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prop {
    pub name: String,
    pub optional: bool,
    pub ty: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Markup {
    pub tag: String,
    pub classes: Vec<String>,
    pub role: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComponentDecl {
    pub name: String,
    pub export: Export,
    pub props: Vec<Prop>,
    pub root: Option<Markup>,
    pub line: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Imported {
    Default,
    Named(String),
    Namespace,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportBinding {
    pub from: String,
    pub imported: Imported,
    pub local: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reexport {
    Named {
        exported: String,
        imported: Imported,
        from: String,
    },
    All {
        from: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ModuleSummary {
    pub components: Vec<ComponentDecl>,
    pub imports: Vec<ImportBinding>,
    pub reexports: Vec<Reexport>,
}

pub fn summarize(path: &str, source: &str) -> Result<ModuleSummary, JsxError> {
    if let Some(kind) = template_kind(path) {
        return Ok(summarize_template(kind, path, source));
    }
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, jsx::source_type(path)?).parse();
    jsx::first_error(&parsed.diagnostics, parsed.fatal_error)?;
    let types = Types::collect(&parsed.program);
    let lines = LineIndex::new(source);
    let reader = Reader {
        source,
        types: &types,
    };
    let mut found = Found::default();
    for statement in &parsed.program.body {
        found.statement(statement, stem_name(path).as_deref());
    }
    let exports = local_exports(&parsed.module_record);
    let imports = import_bindings(&parsed.module_record);
    let mut components = Vec::new();
    for candidate in found.candidates {
        let Some(Rendered { root }) = reader.rendered(candidate.body) else {
            continue;
        };
        let export = match candidate.export {
            Export::None => exports
                .get(candidate.name.as_str())
                .cloned()
                .unwrap_or(Export::None),
            export => export,
        };
        components.push(ComponentDecl {
            props: reader.props(candidate.body, candidate.declared),
            line: lines.position(candidate.span.start as usize).0,
            name: candidate.name,
            export,
            root,
        });
    }
    let reexports = reexports(&parsed.module_record);
    Ok(ModuleSummary {
        components,
        imports,
        reexports,
    })
}

#[must_use]
pub fn pascal_name(stem: &str) -> Option<String> {
    let name: String = stem
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars.next().map_or_else(String::new, |first| {
                first.to_ascii_uppercase().to_string() + chars.as_str()
            })
        })
        .collect();
    name.chars()
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        .then_some(name)
}

fn stem_name(path: &str) -> Option<String> {
    let file = path.rsplit('/').next()?;
    let stem = file.split_once('.').map_or(file, |(stem, _)| stem);
    let stem = if stem == "index" {
        path.rsplit('/').nth(1)?
    } else {
        stem
    };
    pascal_name(stem)
}

fn type_text(source: &str, span: Span) -> String {
    let text = source[span.start as usize..span.end as usize]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.chars().count() <= MAX_TYPE_CHARS {
        return text;
    }
    let cut: String = text.chars().take(MAX_TYPE_CHARS - 1).collect();
    format!("{cut}…")
}

fn key_name(key: &PropertyKey<'_>) -> Option<String> {
    match key {
        PropertyKey::StaticIdentifier(identifier) => Some(identifier.name.to_string()),
        PropertyKey::StringLiteral(literal) => literal.value.as_str().map(str::to_owned),
        _ => None,
    }
}

fn callee_name(callee: &Expression<'_>) -> Option<String> {
    match callee {
        Expression::Identifier(identifier) => Some(identifier.name.to_string()),
        Expression::StaticMemberExpression(member) => Some(member.property.name.to_string()),
        _ => None,
    }
}

fn type_name(name: &TSTypeName<'_>) -> Option<String> {
    match name {
        TSTypeName::IdentifierReference(identifier) => Some(identifier.name.to_string()),
        TSTypeName::QualifiedName(qualified) => Some(qualified.right.name.to_string()),
        TSTypeName::ThisExpression(_) => None,
    }
}

#[derive(Clone, Copy)]
enum Body<'b, 'a> {
    Function(&'b Function<'a>),
    Arrow(&'b ArrowFunctionExpression<'a>),
}

impl<'b, 'a> Body<'b, 'a> {
    fn first_param(self) -> Option<&'b FormalParameter<'a>> {
        match self {
            Self::Function(function) => function.params.items.first(),
            Self::Arrow(arrow) => arrow.params.items.first(),
        }
    }
}

struct Candidate<'b, 'a> {
    name: String,
    body: Body<'b, 'a>,
    declared: Option<&'b TSType<'a>>,
    span: Span,
    export: Export,
}

#[derive(Default)]
struct Found<'b, 'a> {
    candidates: Vec<Candidate<'b, 'a>>,
}

impl<'b, 'a> Found<'b, 'a> {
    fn statement(&mut self, statement: &'b Statement<'a>, stem: Option<&str>) {
        match statement {
            Statement::FunctionDeclaration(function) => self.function(function, Export::None),
            Statement::VariableDeclaration(declaration) => {
                for declarator in &declaration.declarations {
                    self.declarator(declarator, Export::None);
                }
            }
            Statement::ExportDeclaration(export) => match &export.declaration {
                Declaration::FunctionDeclaration(function) => {
                    let name = function.id.as_ref().map(|id| id.name.to_string());
                    self.function(function, name.map_or(Export::None, Export::Named));
                }
                Declaration::VariableDeclaration(declaration) => {
                    for declarator in &declaration.declarations {
                        let export = match &declarator.id {
                            BindingPattern::BindingIdentifier(id) => {
                                Export::Named(id.name.to_string())
                            }
                            _ => Export::None,
                        };
                        self.declarator(declarator, export);
                    }
                }
                _ => {}
            },
            Statement::ExportDefaultDeclaration(export) => match &export.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                    let name = function
                        .id
                        .as_ref()
                        .map(|id| id.name.to_string())
                        .or_else(|| stem.map(str::to_owned));
                    if let Some(name) = name.filter(|name| jsx::is_component_name(name)) {
                        self.candidates.push(Candidate {
                            name,
                            body: Body::Function(function),
                            declared: None,
                            span: function.span,
                            export: Export::Default,
                        });
                    }
                }
                kind => {
                    if let (Some((body, declared)), Some(name)) = (
                        kind.as_expression().and_then(callable),
                        stem.filter(|name| jsx::is_component_name(name)),
                    ) {
                        self.candidates.push(Candidate {
                            name: name.to_owned(),
                            body,
                            declared,
                            span: export.span,
                            export: Export::Default,
                        });
                    }
                }
            },
            _ => {}
        }
    }

    fn function(&mut self, function: &'b Function<'a>, export: Export) {
        let Some(id) = function.id.as_ref() else {
            return;
        };
        if !jsx::is_component_name(&id.name) {
            return;
        }
        self.candidates.push(Candidate {
            name: id.name.to_string(),
            body: Body::Function(function),
            declared: None,
            span: function.span,
            export,
        });
    }

    fn declarator(&mut self, declarator: &'b VariableDeclarator<'a>, export: Export) {
        let BindingPattern::BindingIdentifier(id) = &declarator.id else {
            return;
        };
        if !jsx::is_component_name(&id.name) {
            return;
        }
        let Some((body, wrapped)) = declarator.init.as_ref().and_then(callable) else {
            return;
        };
        let annotated = declarator
            .type_annotation
            .as_ref()
            .map(|annotation| &annotation.type_annotation);
        self.candidates.push(Candidate {
            name: id.name.to_string(),
            body,
            declared: wrapped.or(annotated),
            span: declarator.span,
            export,
        });
    }
}

fn callable<'b, 'a>(
    expression: &'b Expression<'a>,
) -> Option<(Body<'b, 'a>, Option<&'b TSType<'a>>)> {
    match expression {
        Expression::ArrowFunctionExpression(arrow) => Some((Body::Arrow(arrow), None)),
        Expression::FunctionExpression(function) => Some((Body::Function(function), None)),
        Expression::ParenthesizedExpression(inner) => callable(&inner.expression),
        Expression::CallExpression(call) => {
            let (body, inner) = call
                .arguments
                .first()
                .and_then(|argument| argument.as_expression())
                .and_then(callable)?;
            Some((body, inner.or_else(|| wrapper_type(call))))
        }
        _ => None,
    }
}

fn wrapper_type<'b, 'a>(call: &'b CallExpression<'a>) -> Option<&'b TSType<'a>> {
    let params = &call.type_arguments.as_ref()?.params;
    if callee_name(&call.callee).as_deref() == Some(FORWARD_REF) {
        params.get(1)
    } else {
        params.first()
    }
}

enum TypeDef<'b, 'a> {
    Members(&'b [TSSignature<'a>]),
    Alias(&'b TSType<'a>),
}

#[derive(Default)]
struct Types<'b, 'a> {
    defs: HashMap<String, TypeDef<'b, 'a>>,
}

impl<'b, 'a> Types<'b, 'a> {
    fn collect(program: &'b Program<'a>) -> Self {
        let mut types = Self::default();
        for statement in &program.body {
            let declaration = match statement {
                Statement::ExportDeclaration(export) => Some(&export.declaration),
                _ => None,
            };
            match (statement, declaration) {
                (Statement::TSInterfaceDeclaration(interface), _)
                | (_, Some(Declaration::TSInterfaceDeclaration(interface))) => {
                    types.defs.insert(
                        interface.id.name.to_string(),
                        TypeDef::Members(&interface.body.body),
                    );
                }
                (Statement::TSTypeAliasDeclaration(alias), _)
                | (_, Some(Declaration::TSTypeAliasDeclaration(alias))) => {
                    types.defs.insert(
                        alias.id.name.to_string(),
                        TypeDef::Alias(&alias.type_annotation),
                    );
                }
                _ => {}
            }
        }
        types
    }
}

struct Reader<'s, 't, 'b, 'a> {
    source: &'s str,
    types: &'t Types<'b, 'a>,
}

impl<'b, 'a> Reader<'_, '_, 'b, 'a> {
    fn rendered(&self, body: Body<'b, 'a>) -> Option<Rendered> {
        let mut finder = RootFinder {
            source: self.source,
            root: None,
            has_jsx: false,
        };
        match body {
            Body::Arrow(arrow) => {
                if let Some(expression) = arrow.body.as_expression() {
                    finder.root = markup_of(self.source, expression);
                    finder.visit_expression(expression);
                } else if let oxc_ast::ast::ArrowFunctionBody::FunctionBody(block) = &arrow.body {
                    finder.visit_function_body(block);
                }
            }
            Body::Function(function) => {
                let block: &FunctionBody<'a> = function.body.as_ref()?;
                finder.visit_function_body(block);
            }
        }
        finder.has_jsx.then_some(Rendered { root: finder.root })
    }

    fn props(&self, body: Body<'b, 'a>, declared: Option<&'b TSType<'a>>) -> Vec<Prop> {
        let param = body.first_param();
        let annotated = param
            .and_then(|param| param.type_annotation.as_ref())
            .map(|annotation| &annotation.type_annotation);
        let typed = annotated
            .or(declared)
            .and_then(|ty| self.members(ty, 0))
            .unwrap_or_default();
        let destructured = param.map_or_else(Vec::new, |param| pattern_props(&param.pattern));
        merge(typed, destructured)
    }

    fn members(&self, ty: &TSType<'a>, depth: usize) -> Option<Vec<Prop>> {
        if depth > MAX_TYPE_DEPTH {
            return None;
        }
        match ty {
            TSType::TSTypeLiteral(literal) => Some(self.signatures(&literal.members)),
            TSType::TSParenthesizedType(inner) => self.members(&inner.type_annotation, depth + 1),
            TSType::TSIntersectionType(intersection) => {
                let parts: Vec<Vec<Prop>> = intersection
                    .types
                    .iter()
                    .filter_map(|part| self.members(part, depth + 1))
                    .collect();
                (!parts.is_empty()).then(|| parts.into_iter().fold(Vec::new(), merge))
            }
            TSType::TSTypeReference(reference) => {
                let name = type_name(&reference.type_name)?;
                let first = reference
                    .type_arguments
                    .as_ref()
                    .and_then(|arguments| arguments.params.first());
                if PASS_THROUGH.contains(&name.as_str()) {
                    return first.and_then(|inner| self.members(inner, depth + 1));
                }
                if name == WITH_CHILDREN {
                    let mut props = first
                        .and_then(|inner| self.members(inner, depth + 1))
                        .unwrap_or_default();
                    if !props.iter().any(|prop| prop.name == "children") {
                        props.push(Prop {
                            name: "children".to_owned(),
                            optional: true,
                            ty: Some("ReactNode".to_owned()),
                        });
                    }
                    return Some(props);
                }
                if name == ALL_OPTIONAL {
                    return first
                        .and_then(|inner| self.members(inner, depth + 1))
                        .map(|props| {
                            props
                                .into_iter()
                                .map(|prop| Prop {
                                    optional: true,
                                    ..prop
                                })
                                .collect()
                        });
                }
                match self.types.defs.get(&name)? {
                    TypeDef::Members(members) => Some(self.signatures(members)),
                    TypeDef::Alias(alias) => self.members(alias, depth + 1),
                }
            }
            _ => None,
        }
    }

    fn signatures(&self, members: &[TSSignature<'a>]) -> Vec<Prop> {
        members
            .iter()
            .filter_map(|member| match member {
                TSSignature::TSPropertySignature(property) if !property.computed => Some(Prop {
                    name: key_name(&property.key)?,
                    optional: property.optional,
                    ty: property.type_annotation.as_ref().map(|annotation| {
                        type_text(self.source, annotation.type_annotation.span())
                    }),
                }),
                TSSignature::TSMethodSignature(method) => Some(Prop {
                    name: key_name(&method.key)?,
                    optional: method.optional,
                    ty: Some("function".to_owned()),
                }),
                _ => None,
            })
            .collect()
    }
}

fn pattern_props(pattern: &BindingPattern<'_>) -> Vec<Prop> {
    let BindingPattern::ObjectPattern(object) = pattern else {
        return Vec::new();
    };
    object
        .properties
        .iter()
        .filter(|property| !property.computed)
        .filter_map(|property| {
            Some(Prop {
                name: key_name(&property.key)?,
                optional: matches!(property.value, BindingPattern::AssignmentPattern(_)),
                ty: None,
            })
        })
        .collect()
}

fn merge(mut typed: Vec<Prop>, other: Vec<Prop>) -> Vec<Prop> {
    for prop in other {
        if let Some(known) = typed.iter_mut().find(|known| known.name == prop.name) {
            known.optional |= prop.optional;
            if known.ty.is_none() {
                known.ty = prop.ty;
            }
        } else {
            typed.push(prop);
        }
    }
    typed
}

fn markup_of(source: &str, expression: &Expression<'_>) -> Option<Markup> {
    match expression {
        Expression::JSXElement(element) => Some(markup(source, &element.opening_element)),
        Expression::JSXFragment(fragment) => {
            fragment.children.iter().find_map(|child| match child {
                JSXChild::Element(element) => Some(markup(source, &element.opening_element)),
                _ => None,
            })
        }
        Expression::ParenthesizedExpression(inner) => markup_of(source, &inner.expression),
        Expression::ConditionalExpression(conditional) => {
            markup_of(source, &conditional.consequent)
                .or_else(|| markup_of(source, &conditional.alternate))
        }
        Expression::LogicalExpression(logical) => markup_of(source, &logical.right),
        _ => None,
    }
}

fn markup(source: &str, opening: &JSXOpeningElement<'_>) -> Markup {
    let element = jsx::describe(source, opening);
    let classes = match element.class {
        ClassSource::Static(literal) | ClassSource::Call { literal, .. } => literal
            .value
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
        ClassSource::None | ClassSource::Dynamic => Vec::new(),
    };
    let role = opening.attributes.iter().find_map(|item| match item {
        JSXAttributeItem::Attribute(attribute)
            if matches!(&attribute.name, JSXAttributeName::Identifier(name) if name.name == "role") =>
        {
            match &attribute.value {
                Some(JSXAttributeValue::StringLiteral(literal)) => {
                    literal.value.as_str().map(str::to_owned)
                }
                _ => None,
            }
        }
        _ => None,
    });
    Markup {
        tag: element.tag,
        classes,
        role,
    }
}

struct Rendered {
    root: Option<Markup>,
}

struct RootFinder<'s> {
    source: &'s str,
    root: Option<Markup>,
    has_jsx: bool,
}

impl<'a> Visit<'a> for RootFinder<'_> {
    fn visit_return_statement(&mut self, it: &ReturnStatement<'a>) {
        if self.root.is_none()
            && let Some(argument) = &it.argument
        {
            self.root = markup_of(self.source, argument);
        }
        walk::walk_return_statement(self, it);
    }

    fn visit_jsx_opening_element(&mut self, it: &JSXOpeningElement<'a>) {
        self.has_jsx = true;
        walk::walk_jsx_opening_element(self, it);
    }

    fn visit_function(&mut self, _it: &Function<'a>, _flags: ScopeFlags) {}

    fn visit_arrow_function_expression(&mut self, _it: &ArrowFunctionExpression<'a>) {}
}

fn imported_of(name: &ImportImportName<'_>) -> Imported {
    match name {
        ImportImportName::Name(name) => Imported::Named(name.name.to_string()),
        ImportImportName::Default(_) => Imported::Default,
        ImportImportName::NamespaceObject => Imported::Namespace,
    }
}

fn import_bindings(record: &ModuleRecord<'_>) -> Vec<ImportBinding> {
    record
        .import_entries
        .iter()
        .filter(|entry| !entry.is_type)
        .map(|entry| ImportBinding {
            from: entry.module_request.name.to_string(),
            imported: imported_of(&entry.import_name),
            local: entry.local_name.name.to_string(),
        })
        .collect()
}

fn local_exports(record: &ModuleRecord<'_>) -> HashMap<String, Export> {
    let mut exports = HashMap::new();
    for entry in record
        .local_export_entries
        .iter()
        .filter(|entry| !entry.is_type)
    {
        let Some(local) = entry.local_name.name() else {
            continue;
        };
        let export = match &entry.export_name {
            ExportExportName::Name(name) => Export::Named(name.name.to_string()),
            ExportExportName::Default(_) => Export::Default,
            ExportExportName::Null => continue,
        };
        let slot = exports.entry(local.to_string()).or_insert(Export::None);
        if matches!(slot, Export::None | Export::Default) {
            *slot = export;
        }
    }
    exports
}

fn reexports(record: &ModuleRecord<'_>) -> Vec<Reexport> {
    let mut found = Vec::new();
    for entry in record
        .indirect_export_entries
        .iter()
        .filter(|entry| !entry.is_type)
    {
        let (Some(from), ExportExportName::Name(exported)) =
            (&entry.module_request, &entry.export_name)
        else {
            continue;
        };
        let imported = match &entry.import_name {
            ExportImportName::Name(name) if name.name == "default" => Imported::Default,
            ExportImportName::Name(name) => Imported::Named(name.name.to_string()),
            ExportImportName::All | ExportImportName::AllButDefault | ExportImportName::Null => {
                continue;
            }
        };
        found.push(Reexport::Named {
            exported: exported.name.to_string(),
            imported,
            from: from.name.to_string(),
        });
    }
    for entry in record
        .star_export_entries
        .iter()
        .filter(|entry| !entry.is_type)
    {
        if let Some(from) = &entry.module_request {
            found.push(Reexport::All {
                from: from.name.to_string(),
            });
        }
    }
    found
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Template {
    Vue,
    Svelte,
    Astro,
    Html,
}

fn template_kind(path: &str) -> Option<Template> {
    let (_, extension) = path.rsplit_once('.')?;
    match extension.to_ascii_lowercase().as_str() {
        "vue" => Some(Template::Vue),
        "svelte" => Some(Template::Svelte),
        "astro" => Some(Template::Astro),
        "html" => Some(Template::Html),
        _ => None,
    }
}

struct Block<'s> {
    body: &'s str,
}

fn script_blocks(source: &str) -> Vec<Block<'_>> {
    let lower = source.to_ascii_lowercase();
    let mut blocks = Vec::new();
    let mut at = 0;
    while let Some(start) = lower[at..].find("<script").map(|found| at + found) {
        let Some(open_end) = lower[start..].find('>').map(|found| start + found) else {
            break;
        };
        let Some(close) = lower[open_end..]
            .find("</script")
            .map(|found| open_end + found)
        else {
            break;
        };
        blocks.push(Block {
            body: &source[open_end + 1..close],
        });
        at = close + "</script".len();
    }
    blocks
}

fn frontmatter(source: &str) -> Option<&str> {
    let trimmed = source.trim_start();
    let rest = trimmed.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    Some(&rest[..end])
}

fn script_sources(kind: Template, source: &str) -> Vec<&str> {
    if kind == Template::Astro {
        return frontmatter(source).into_iter().collect();
    }
    script_blocks(source)
        .into_iter()
        .map(|block| block.body)
        .collect()
}

fn template_root_at(kind: Template, source: &str) -> Option<usize> {
    let lower = source.to_ascii_lowercase();
    let start = if kind == Template::Vue {
        let template = lower.find("<template")?;
        template + lower[template..].find('>')? + 1
    } else if kind == Template::Astro {
        let trimmed = source.len() - source.trim_start().len();
        frontmatter(source).map_or(0, |matter| {
            trimmed + "---".len() + matter.len() + "\n---".len()
        })
    } else {
        0
    };
    let bytes = source.as_bytes();
    let mut at = start;
    while let Some(found) = source[at..].find('<').map(|found| at + found) {
        let next = bytes.get(found + 1).copied().unwrap_or(b' ');
        let rest = &lower[found..];
        let skipped = SKIPPED_BLOCKS
            .iter()
            .find(|(prefix, _)| rest.starts_with(*prefix));
        match skipped {
            Some((_, closing)) => {
                at = found
                    + rest
                        .find(closing)
                        .map_or(rest.len(), |end| end + closing.len());
            }
            None if next.is_ascii_alphabetic() => return Some(found),
            None => at = found + 1,
        }
    }
    None
}

fn template_root(kind: Template, path: &str, source: &str) -> Option<Markup> {
    let at = template_root_at(kind, source)?;
    let (line, column) = LineIndex::new(source).position(at);
    let element = template::find_element(path, source, line, column).ok()?;
    let classes = match element.class {
        ClassSource::Static(literal) | ClassSource::Call { literal, .. } => literal
            .value
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
        ClassSource::None | ClassSource::Dynamic => Vec::new(),
    };
    let role = match template::attribute(source, line, column, "role") {
        Ok(AttributeSlot::Static { text, .. }) => Some(text),
        _ => None,
    };
    Some(Markup {
        tag: element.tag,
        classes,
        role,
    })
}

fn summarize_template(kind: Template, path: &str, source: &str) -> ModuleSummary {
    let mut summary = ModuleSummary::default();
    let mut props = Vec::new();
    for script in script_sources(kind, source) {
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, script, SourceType::ts()).parse();
        if jsx::first_error(&parsed.diagnostics, parsed.fatal_error).is_err() {
            continue;
        }
        summary
            .imports
            .extend(import_bindings(&parsed.module_record));
        let types = Types::collect(&parsed.program);
        let reader = Reader {
            source: script,
            types: &types,
        };
        let mut finder = PropsFinder {
            reader: &reader,
            svelte: kind == Template::Svelte,
            astro: kind == Template::Astro,
            props: Vec::new(),
        };
        finder.visit_program(&parsed.program);
        let mut found = finder.props;
        if kind == Template::Astro {
            let declared = match types.defs.get("Props") {
                Some(TypeDef::Members(members)) => reader.signatures(members),
                Some(TypeDef::Alias(alias)) => reader.members(alias, 0).unwrap_or_default(),
                None => Vec::new(),
            };
            found = merge(declared, found);
        }
        props = merge(props, found);
    }
    let Some(name) = stem_name(path).filter(|_| kind != Template::Html) else {
        return summary;
    };
    if name.starts_with(|c: char| !c.is_ascii_uppercase()) {
        return summary;
    }
    summary.components.push(ComponentDecl {
        name,
        export: Export::Default,
        props,
        root: template_root(kind, path, source),
        line: 1,
    });
    summary
}

struct PropsFinder<'r, 's, 't, 'b, 'a> {
    reader: &'r Reader<'s, 't, 'b, 'a>,
    svelte: bool,
    astro: bool,
    props: Vec<Prop>,
}

fn object_keys(object: &ObjectExpression<'_>) -> Vec<Prop> {
    object
        .properties
        .iter()
        .filter_map(|property| match property {
            ObjectPropertyKind::ObjectProperty(property) if !property.computed => Some(Prop {
                name: key_name(&property.key)?,
                optional: !is_required(&property.value),
                ty: None,
            }),
            _ => None,
        })
        .collect()
}

fn vue_props(argument: Option<&Expression<'_>>) -> Vec<Prop> {
    match argument {
        Some(Expression::ObjectExpression(object)) => object_keys(object),
        Some(Expression::ArrayExpression(array)) => array
            .elements
            .iter()
            .filter_map(|element| match element {
                ArrayExpressionElement::StringLiteral(literal) => Some(Prop {
                    name: literal.value.as_str()?.to_owned(),
                    optional: true,
                    ty: None,
                }),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn is_required(value: &Expression<'_>) -> bool {
    let Expression::ObjectExpression(object) = value else {
        return false;
    };
    object.properties.iter().any(|property| match property {
        ObjectPropertyKind::ObjectProperty(property) => {
            key_name(&property.key).as_deref() == Some("required")
                && matches!(&property.value, Expression::BooleanLiteral(literal) if literal.value)
        }
        ObjectPropertyKind::SpreadProperty(_) => false,
    })
}

impl<'a> Visit<'a> for PropsFinder<'_, '_, '_, '_, 'a> {
    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        if callee_name(&it.callee).as_deref() == Some("defineProps") {
            let typed = it
                .type_arguments
                .as_ref()
                .and_then(|arguments| arguments.params.first())
                .and_then(|ty| self.reader.members(ty, 0));
            let found = typed.unwrap_or_else(|| {
                vue_props(
                    it.arguments
                        .first()
                        .and_then(|argument| argument.as_expression()),
                )
            });
            self.props = merge(std::mem::take(&mut self.props), found);
        } else if callee_name(&it.callee).as_deref() == Some("defineComponent")
            && let Some(Expression::ObjectExpression(object)) = it
                .arguments
                .first()
                .and_then(|argument| argument.as_expression())
        {
            let found = options_props(object);
            self.props = merge(std::mem::take(&mut self.props), found);
        }
        walk::walk_call_expression(self, it);
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        let from_props = match &it.init {
            Some(Expression::CallExpression(call)) => {
                self.svelte && callee_name(&call.callee).as_deref() == Some("$props")
            }
            Some(Expression::StaticMemberExpression(member)) => {
                self.astro
                    && member.property.name == "props"
                    && matches!(&member.object, Expression::Identifier(object) if object.name == "Astro")
            }
            _ => false,
        };
        if from_props {
            let typed = it
                .type_annotation
                .as_ref()
                .and_then(|annotation| self.reader.members(&annotation.type_annotation, 0))
                .unwrap_or_default();
            let found = merge(typed, pattern_props(&it.id));
            self.props = merge(std::mem::take(&mut self.props), found);
        }
        walk::walk_variable_declarator(self, it);
    }

    fn visit_statement(&mut self, it: &Statement<'a>) {
        match it {
            Statement::ExportDeclaration(export) if self.svelte => {
                if let Declaration::VariableDeclaration(declaration) = &export.declaration {
                    let found: Vec<Prop> = declaration
                        .declarations
                        .iter()
                        .filter_map(|declarator| match &declarator.id {
                            BindingPattern::BindingIdentifier(id) => Some(Prop {
                                name: id.name.to_string(),
                                optional: declarator.init.is_some(),
                                ty: None,
                            }),
                            _ => None,
                        })
                        .collect();
                    self.props = merge(std::mem::take(&mut self.props), found);
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                if let Some(Expression::ObjectExpression(object)) =
                    export.declaration.as_expression()
                {
                    let found = options_props(object);
                    self.props = merge(std::mem::take(&mut self.props), found);
                }
            }
            _ => {}
        }
        walk::walk_statement(self, it);
    }
}

fn options_props(object: &ObjectExpression<'_>) -> Vec<Prop> {
    object
        .properties
        .iter()
        .find_map(|property| match property {
            ObjectPropertyKind::ObjectProperty(property)
                if key_name(&property.key).as_deref() == Some("props") =>
            {
                Some(vue_props(Some(&property.value)))
            }
            _ => None,
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        ComponentDecl, Export, ImportBinding, Imported, Markup, Prop, Reexport, pascal_name,
        summarize, type_text,
    };

    fn prop(name: &str, optional: bool, ty: Option<&str>) -> Prop {
        Prop {
            name: name.to_owned(),
            optional,
            ty: ty.map(str::to_owned),
        }
    }

    fn markup(tag: &str, classes: &str, role: Option<&str>) -> Markup {
        Markup {
            tag: tag.to_owned(),
            classes: classes.split_whitespace().map(str::to_owned).collect(),
            role: role.map(str::to_owned),
        }
    }

    fn components(path: &str, source: &str) -> Vec<ComponentDecl> {
        summarize(path, source).expect("parses").components
    }

    fn only(path: &str, source: &str) -> ComponentDecl {
        let mut found = components(path, source);
        assert_eq!(found.len(), 1, "{found:?}");
        found.remove(0)
    }

    #[test]
    fn reads_an_exported_function_with_inline_props_and_its_root_markup() {
        let source = "export function ErrorMessage({ message, tone = 'red' }: { message: string; tone?: 'red' | 'amber' }) {\n  return (\n    <p role=\"alert\" className=\"mt-1 text-sm text-red-700\">{message}</p>\n  );\n}\n";

        assert_eq!(
            only("src/components/ErrorMessage.tsx", source),
            ComponentDecl {
                name: "ErrorMessage".to_owned(),
                export: Export::Named("ErrorMessage".to_owned()),
                props: vec![
                    prop("message", false, Some("string")),
                    prop("tone", true, Some("'red' | 'amber'")),
                ],
                root: Some(markup("p", "mt-1 text-sm text-red-700", Some("alert"))),
                line: 1,
            }
        );
    }

    #[test]
    fn reads_props_from_a_named_interface_or_type_and_defaults_make_them_optional() {
        let source = "interface BadgeProps {\n  label: string;\n  size?: 'sm' | 'md';\n  onClose(): void;\n}\n\ntype CardProps = { title: string };\n\nexport const Badge = ({ label, size = 'sm' }: BadgeProps) => <span className=\"rounded-full px-2\">{label}</span>;\n\nexport function Card(props: CardProps) {\n  return <article className=\"rounded-card\">{props.title}</article>;\n}\n";

        let found = components("src/ui.tsx", source);

        assert_eq!(found.len(), 2);
        assert_eq!(
            found[0].props,
            vec![
                prop("label", false, Some("string")),
                prop("size", true, Some("'sm' | 'md'")),
                prop("onClose", false, Some("function")),
            ]
        );
        assert_eq!(
            found[0].root,
            Some(markup("span", "rounded-full px-2", None))
        );
        assert_eq!(found[0].line, 9);
        assert_eq!(found[1].props, vec![prop("title", false, Some("string"))]);
        assert_eq!(found[1].export, Export::Named("Card".to_owned()));
    }

    #[test]
    fn names_an_anonymous_default_export_after_its_file_or_folder() {
        let file = only(
            "src/components/ErrorMessage.tsx",
            "export default function ({ message }: { message: string }) {\n  return <p>{message}</p>;\n}\n",
        );
        let folder = only(
            "src/components/alert-banner/index.tsx",
            "export default () => <div className=\"bg-red-50\" />;\n",
        );

        assert_eq!(
            (file.name.as_str(), file.export),
            ("ErrorMessage", Export::Default)
        );
        assert_eq!(
            (folder.name.as_str(), folder.export),
            ("AlertBanner", Export::Default)
        );
        assert_eq!(folder.root, Some(markup("div", "bg-red-50", None)));
    }

    #[test]
    fn sees_through_memo_forward_ref_and_component_type_annotations() {
        let source = "import { forwardRef, memo, type FC, type PropsWithChildren } from 'react';\n\ntype ButtonProps = { variant?: 'solid' | 'ghost' } & { label: string };\n\nexport const Button = forwardRef<HTMLButtonElement, ButtonProps>((props, ref) => <button ref={ref} className=\"btn\">{props.label}</button>);\n\nexport const Tag = memo(function Tag({ text }: { text: string }) {\n  return <span>{text}</span>;\n});\n\nexport const Panel: FC<PropsWithChildren<{ heading: string }>> = ({ heading, children }) => (\n  <section className=\"p-4\">{heading}{children}</section>\n);\n\nexport const Hint: FC<Partial<{ tone: string }>> = () => <small />;\n";

        let found = components("src/parts.tsx", source);

        let by_name = |name: &str| found.iter().find(|found| found.name == name).expect(name);
        assert_eq!(
            by_name("Button").props,
            vec![
                prop("variant", true, Some("'solid' | 'ghost'")),
                prop("label", false, Some("string")),
            ]
        );
        assert_eq!(
            by_name("Tag").props,
            vec![prop("text", false, Some("string"))]
        );
        assert_eq!(
            by_name("Panel").props,
            vec![
                prop("heading", false, Some("string")),
                prop("children", true, Some("ReactNode")),
            ]
        );
        assert_eq!(
            by_name("Hint").props,
            vec![prop("tone", true, Some("string"))]
        );
        assert_eq!(by_name("Panel").root, Some(markup("section", "p-4", None)));
    }

    #[test]
    fn skips_pascal_case_values_hooks_and_functions_that_render_nothing() {
        let source = "export const MENU = [{ name: 'Latte' }];\nexport function Total(items: number[]) { return items.length; }\nexport function useThing() { return <div />; }\nexport const Loader = () => null;\n";

        assert_eq!(components("src/data.tsx", source), Vec::new());
    }

    #[test]
    fn finds_the_returned_root_past_early_returns_conditions_fragments_and_class_helpers() {
        let source = "import { cn } from '../lib/cn';\nexport function Notice({ text, open }: { text?: string; open: boolean }) {\n  const close = () => <i />;\n  if (!text) return null;\n  return open ? (\n    <>\n      <div role=\"status\" className={cn('rounded-lg bg-amber-50 p-3', open && 'ring')}>{text}</div>\n    </>\n  ) : null;\n}\n\nexport function Wrapped() {\n  const content = <b />;\n  return content;\n}\n";

        let found = components("src/Notice.tsx", source);

        assert_eq!(
            found[0].root,
            Some(markup("div", "rounded-lg bg-amber-50 p-3", Some("status")))
        );
        assert_eq!(found[1].name, "Wrapped");
        assert_eq!(found[1].root, None);
    }

    #[test]
    fn applies_export_lists_and_a_default_export_of_a_local_component() {
        let source = "function Inner() { return <div />; }\nconst Other = () => <span />;\nfunction Main() { return <main />; }\nexport { Inner as Outer, Other };\nexport default Main;\n";

        let exports: Vec<(String, Export)> = components("src/Main.tsx", source)
            .into_iter()
            .map(|component| (component.name, component.export))
            .collect();

        assert_eq!(
            exports,
            vec![
                ("Inner".to_owned(), Export::Named("Outer".to_owned())),
                ("Other".to_owned(), Export::Named("Other".to_owned())),
                ("Main".to_owned(), Export::Default),
            ]
        );
    }

    #[test]
    fn lists_value_imports_and_skips_type_only_ones() {
        let source = "import React, * as All from 'react';\nimport { ErrorMessage as Err } from '@/components/ErrorMessage';\nimport type { Props } from './types';\nimport { type Theme, cn } from '../lib/cn';\nexport const A = () => <Err message=\"x\" />;\n";

        let imports = summarize("src/A.tsx", source).expect("parses").imports;

        let binding = |from: &str, imported: Imported, local: &str| ImportBinding {
            from: from.to_owned(),
            imported,
            local: local.to_owned(),
        };
        assert_eq!(
            imports,
            vec![
                binding("react", Imported::Default, "React"),
                binding("react", Imported::Namespace, "All"),
                binding(
                    "@/components/ErrorMessage",
                    Imported::Named("ErrorMessage".to_owned()),
                    "Err"
                ),
                binding("../lib/cn", Imported::Named("cn".to_owned()), "cn"),
            ]
        );
    }

    #[test]
    fn reads_what_a_barrel_file_re_exports() {
        let source = "export { Alert } from './Alert';\nexport { default as Card, CardBody as Body } from './Card';\nexport * from './buttons';\nexport type { AlertProps } from './Alert';\nimport Toast from './Toast';\nexport { Toast };\n";

        let reexports = summarize("packages/ui/src/index.ts", source)
            .expect("parses")
            .reexports;

        let named = |exported: &str, imported: Imported, from: &str| Reexport::Named {
            exported: exported.to_owned(),
            imported,
            from: from.to_owned(),
        };
        assert_eq!(
            reexports,
            vec![
                named("Alert", Imported::Named("Alert".to_owned()), "./Alert"),
                named("Card", Imported::Default, "./Card"),
                named("Body", Imported::Named("CardBody".to_owned()), "./Card"),
                named("Toast", Imported::Default, "./Toast"),
                Reexport::All {
                    from: "./buttons".to_owned()
                },
            ]
        );
    }

    #[test]
    fn reads_vue_props_from_every_define_props_form_and_the_template_root() {
        let typed = "<script setup lang=\"ts\">\nimport Icon from './Icon.vue';\nconst props = withDefaults(defineProps<{ message: string; tone?: 'red' | 'amber' }>(), { tone: 'red' });\n</script>\n\n<template>\n  <!-- shown under a field -->\n  <p class=\"mt-1 text-sm text-red-700\" role=\"alert\">{{ message }}</p>\n</template>\n";
        let runtime = "<script setup>\ndefineProps({ message: { type: String, required: true }, tone: String });\n</script>\n<template><span class=\"text-xs\">{{ message }}</span></template>\n";
        let listed = "<script>\nexport default { props: ['message', 'tone'] };\n</script>\n<template><div /></template>\n";

        let vue = summarize("src/components/error-message.vue", typed).expect("parses");
        let props_of = |source: &str| only("src/components/Hint.vue", source).props;

        assert_eq!(vue.components.len(), 1);
        let component = &vue.components[0];
        assert_eq!(component.name, "ErrorMessage");
        assert_eq!(component.export, Export::Default);
        assert_eq!(
            component.props,
            vec![
                prop("message", false, Some("string")),
                prop("tone", true, Some("'red' | 'amber'")),
            ]
        );
        assert_eq!(
            component.root,
            Some(markup("p", "mt-1 text-sm text-red-700", Some("alert")))
        );
        assert_eq!(vue.imports[0].from, "./Icon.vue");
        assert_eq!(
            props_of(runtime),
            vec![prop("message", false, None), prop("tone", true, None)]
        );
        assert_eq!(
            props_of(listed),
            vec![prop("message", true, None), prop("tone", true, None)]
        );
    }

    #[test]
    fn reads_svelte_props_in_both_syntaxes_and_astro_props() {
        let runes = "<script lang=\"ts\">\n  interface Props { message: string; tone?: string }\n  let { message, tone = 'red' }: Props = $props();\n</script>\n\n<p class=\"text-sm text-red-700\">{message}</p>\n<style>p { margin: 0 }</style>\n";
        let legacy = "<script>\n  export let message;\n  export let tone = 'red';\n</script>\n<svelte:head><title>x</title></svelte:head>\n<span class=\"text-xs\">{message}</span>\n";
        let astro = "---\ninterface Props { title: string; tone?: 'info' | 'warn' }\nconst { title } = Astro.props;\n---\n<aside class=\"rounded-lg p-4\">{title}</aside>\n";

        let svelte5 = only("src/lib/ErrorMessage.svelte", runes);
        let svelte4 = only("src/lib/Hint.svelte", legacy);
        let astro = only("src/components/Callout.astro", astro);

        assert_eq!(
            svelte5.props,
            vec![
                prop("message", false, Some("string")),
                prop("tone", true, Some("string"))
            ]
        );
        assert_eq!(
            svelte5.root,
            Some(markup("p", "text-sm text-red-700", None))
        );
        assert_eq!(
            svelte4.props,
            vec![prop("message", false, None), prop("tone", true, None)]
        );
        assert_eq!(svelte4.root, Some(markup("span", "text-xs", None)));
        assert_eq!(
            astro.props,
            vec![
                prop("title", false, Some("string")),
                prop("tone", true, Some("'info' | 'warn'")),
            ]
        );
        assert_eq!(astro.root, Some(markup("aside", "rounded-lg p-4", None)));
    }

    #[test]
    fn treats_plain_html_and_lowercase_templates_as_pages_not_components() {
        assert_eq!(
            components("index.html", "<div class=\"x\"></div>"),
            Vec::new()
        );
        assert_eq!(
            summarize("src/routes/+page.svelte", "<h1>Hi</h1>")
                .expect("parses")
                .components[0]
                .name,
            "Page"
        );
    }

    #[test]
    fn refuses_a_file_that_does_not_parse() {
        assert!(summarize("src/Broken.tsx", "export function Broken( { return <div> }").is_err());
    }

    #[test]
    fn shortens_long_types_and_names_files_in_pascal_case() {
        let long = format!("{{ {} }}", "a: string; ".repeat(10));
        let span = oxc_span::Span::new(0, u32::try_from(long.len()).expect("short"));

        assert!(type_text(&long, span).ends_with('…'));
        assert_eq!(type_text(&long, span).chars().count(), 48);
        assert_eq!(
            pascal_name("error-message").as_deref(),
            Some("ErrorMessage")
        );
        assert_eq!(pascal_name("ErrorMessage").as_deref(), Some("ErrorMessage"));
        assert_eq!(pascal_name("404"), None);
    }
}
