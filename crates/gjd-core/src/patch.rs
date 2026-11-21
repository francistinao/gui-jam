use std::collections::BTreeMap;
use std::ops::Range;

use crate::content;
use crate::content_hash;
use crate::contracts::{
    ContentHash, EditOp, EditOpAddItem, EditOpRemoveItem, EditOpValue, JsxValue, ProjectPath,
    SrcLoc,
};
use crate::jsx::{
    ClassSource, JsxError, StyleObject, StyleSource, check_syntax, class_attribute, find_element,
    is_solid,
};
use crate::srcloc::LineIndex;
use crate::template::{self, AttributeSlot};
use crate::text_source;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PatchError {
    #[error("op {op}: {file} is not loaded for this change")]
    UnknownFile { op: usize, file: String },
    #[error("op {op}: {file} changed since the edit was proposed")]
    StaleBase { op: usize, file: String },
    #[error("op {op}: {source}")]
    Element { op: usize, source: JsxError },
    #[error("op {op}: className is computed at runtime and can't be edited directly")]
    NotEditable { op: usize },
    #[error("op {op}: the style is computed at runtime and can't be edited directly")]
    StyleNotEditable { op: usize },
    #[error("op {op}: {name} is bound at runtime and can't be edited directly")]
    AttributeNotEditable { op: usize, name: String },
    #[error("op {op}: the element has no plain text run {run}")]
    TextNotEditable { op: usize, run: u64 },
    #[error("op {op}: no string or text starts at {line}:{column} in {file}")]
    NoTextAt {
        op: usize,
        file: String,
        line: u64,
        column: u64,
    },
    #[error("op {op}: the snippet occurs {count} times in {file}; it must occur exactly once")]
    SnippetNotUnique {
        op: usize,
        file: String,
        count: usize,
    },
    #[error("op {op}: {kind} edits are not supported yet")]
    Unsupported { op: usize, kind: &'static str },
    #[error("ops {first} and {second} change overlapping text in {file}")]
    Overlap {
        first: usize,
        second: usize,
        file: String,
    },
    #[error("{file} would no longer parse: {source}")]
    Syntax { file: String, source: JsxError },
}

type StyleKey<'a> = (&'a str, u64, u64);

struct TextEdit {
    op: usize,
    range: Range<usize>,
    text: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Dialect {
    pub solid: bool,
}

pub fn apply(
    sources: &BTreeMap<String, String>,
    ops: &[EditOp],
) -> Result<BTreeMap<String, String>, PatchError> {
    apply_with(sources, ops, Dialect::default())
}

pub fn apply_with(
    sources: &BTreeMap<String, String>,
    ops: &[EditOp],
    dialect: Dialect,
) -> Result<BTreeMap<String, String>, PatchError> {
    let mut edits: BTreeMap<&str, Vec<TextEdit>> = BTreeMap::new();
    let mut styles: Vec<(StyleKey<'_>, Vec<usize>)> = Vec::new();
    for (op, edit_op) in ops.iter().enumerate() {
        if let EditOp::StyleProp { file, at, .. } = edit_op {
            let key = (file.as_str(), at.line.get(), at.column.get());
            match styles.iter_mut().find(|(seen, _)| *seen == key) {
                Some((_, members)) => members.push(op),
                None => styles.push((key, vec![op])),
            }
            continue;
        }
        let (file, edit) = resolve(op, edit_op, sources, dialect)?;
        edits.entry(file).or_default().push(edit);
    }
    for (_, members) in styles {
        let (file, edit) = resolve_style(&members, ops, sources, dialect)?;
        edits.entry(file).or_default().push(edit);
    }

    let mut changed = BTreeMap::new();
    for (file, mut file_edits) in edits {
        file_edits.sort_by_key(|edit| (edit.range.start, edit.range.end));
        if let Some(pair) = file_edits
            .windows(2)
            .find(|pair| pair[0].range.end > pair[1].range.start)
        {
            return Err(PatchError::Overlap {
                first: pair[0].op,
                second: pair[1].op,
                file: file.to_owned(),
            });
        }
        let mut text = sources[file].clone();
        for edit in file_edits.iter().rev() {
            text.replace_range(edit.range.clone(), &edit.text);
        }
        check_syntax(file, &text).map_err(|source| PatchError::Syntax {
            file: file.to_owned(),
            source,
        })?;
        changed.insert(file.to_owned(), text);
    }
    Ok(changed)
}

pub fn rebase(file: &str, current: &str, ops: &[EditOp]) -> Result<String, PatchError> {
    let base_hash = content_hash(current.as_bytes());
    let mut restamped = Vec::with_capacity(ops.len());
    for (op, edit_op) in ops.iter().enumerate() {
        let EditOp::ReplaceSnippet {
            file: op_file,
            find,
            replace,
            ..
        } = edit_op
        else {
            return Err(PatchError::StaleBase {
                op,
                file: file.to_owned(),
            });
        };
        restamped.push(EditOp::ReplaceSnippet {
            file: op_file.clone(),
            base_hash: base_hash.clone(),
            find: find.clone(),
            replace: replace.clone(),
        });
    }
    let sources = BTreeMap::from([(file.to_owned(), current.to_owned())]);
    Ok(apply(&sources, &restamped)?
        .remove(file)
        .unwrap_or_else(|| current.to_owned()))
}

fn resolve<'s>(
    op: usize,
    edit_op: &EditOp,
    sources: &'s BTreeMap<String, String>,
    dialect: Dialect,
) -> Result<(&'s str, TextEdit), PatchError> {
    match edit_op {
        EditOp::ClassTokens {
            file,
            base_hash,
            at,
            add,
            remove,
        } => {
            let (path, source) = current(op, file, base_hash, sources)?;
            let element = find_element(path, source, at.line.get(), at.column.get())
                .map_err(|source| PatchError::Element { op, source })?;
            let edit = match &element.class {
                ClassSource::Static(literal) | ClassSource::Call { literal, .. } => TextEdit {
                    op,
                    range: literal.range.clone(),
                    text: merge_tokens(&literal.value, add, remove),
                },
                ClassSource::None => {
                    let classes = merge_tokens("", add, remove);
                    let attribute = if dialect.solid {
                        "class"
                    } else {
                        class_attribute(path, source)
                    };
                    TextEdit {
                        op,
                        range: element.insert_at..element.insert_at,
                        text: if classes.is_empty() {
                            String::new()
                        } else {
                            format!(" {attribute}=\"{classes}\"")
                        },
                    }
                }
                ClassSource::Dynamic => return Err(PatchError::NotEditable { op }),
            };
            Ok((path, edit))
        }
        EditOp::ReplaceSnippet {
            file,
            base_hash,
            find,
            replace,
        } => {
            let (path, source) = current(op, file, base_hash, sources)?;
            resolve_snippet(op, path, source, find, replace).map(|edit| (path, edit))
        }
        EditOp::JsxAttr {
            file,
            base_hash,
            at,
            name,
            value,
        } => {
            let (path, source) = current(op, file, base_hash, sources)?;
            resolve_attribute(op, path, source, at, name.as_str(), value.as_ref())
                .map(|edit| (path, edit))
        }
        EditOp::TextContent {
            file,
            base_hash,
            at,
            run,
            value,
        } => {
            let (path, source) = current(op, file, base_hash, sources)?;
            resolve_text(op, path, source, at, *run, value).map(|edit| (path, edit))
        }
        EditOp::TextAt {
            file,
            base_hash,
            at,
            value,
        } => {
            let (path, source) = current(op, file, base_hash, sources)?;
            let missing = || PatchError::NoTextAt {
                op,
                file: path.to_owned(),
                line: at.line.get(),
                column: at.column.get(),
            };
            let offset = LineIndex::new(source)
                .offset(at.line.get(), at.column.get())
                .ok_or_else(missing)?;
            let (range, text) =
                text_source::rewrite_at(path, source, offset, value).ok_or_else(missing)?;
            Ok((path, TextEdit { op, range, text }))
        }
        EditOp::StyleProp { .. } => unreachable!("style_prop ops are grouped by element"),
        EditOp::CreateFile { .. } => Err(PatchError::Unsupported {
            op,
            kind: "create_file",
        }),
        EditOp::RewriteFile { .. } => Err(PatchError::Unsupported {
            op,
            kind: "rewrite_file",
        }),
    }
}

fn resolve_snippet(
    op: usize,
    path: &str,
    source: &str,
    find: &str,
    replace: &str,
) -> Result<TextEdit, PatchError> {
    let crlf = uses_crlf(source);
    let find = if crlf && !source.contains(find) {
        to_crlf(find)
    } else {
        find.to_owned()
    };
    let mut matches = source.match_indices(find.as_str());
    let (Some((start, _)), None) = (matches.next(), matches.next()) else {
        return Err(PatchError::SnippetNotUnique {
            op,
            file: path.to_owned(),
            count: source.matches(find.as_str()).count(),
        });
    };
    Ok(TextEdit {
        op,
        range: start..start + find.len(),
        text: if crlf {
            to_crlf(replace)
        } else {
            replace.to_owned()
        },
    })
}

fn resolve_text(
    op: usize,
    path: &str,
    source: &str,
    at: &SrcLoc,
    run: u64,
    value: &str,
) -> Result<TextEdit, PatchError> {
    let element = find_element(path, source, at.line.get(), at.column.get())
        .map_err(|source| PatchError::Element { op, source })?;
    let range = usize::try_from(run)
        .ok()
        .and_then(|index| content::run_range(element.content.as_deref()?, index))
        .ok_or(PatchError::TextNotEditable { op, run })?;
    Ok(TextEdit {
        op,
        range,
        text: content::encode(value),
    })
}

fn uses_crlf(source: &str) -> bool {
    source
        .find('\n')
        .is_some_and(|end| source[..end].ends_with('\r'))
}

fn to_crlf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\n', "\r\n")
}

fn resolve_attribute(
    op: usize,
    path: &str,
    source: &str,
    at: &SrcLoc,
    name: &str,
    value: Option<&JsxValue>,
) -> Result<TextEdit, PatchError> {
    let slot = crate::jsx::attribute(path, source, at.line.get(), at.column.get(), name)
        .map_err(|source| PatchError::Element { op, source })?;
    let text = match value {
        None => None,
        Some(JsxValue::String(text)) => Some(text.replace('&', "&amp;").replace('"', "&quot;")),
        Some(JsxValue::Expression(_)) => {
            return Err(PatchError::Unsupported {
                op,
                kind: "jsx_attr with an expression",
            });
        }
    };
    Ok(match (slot, text) {
        (AttributeSlot::Bound, _) => {
            return Err(PatchError::AttributeNotEditable {
                op,
                name: name.to_owned(),
            });
        }
        (AttributeSlot::Static { value, .. }, Some(text)) => TextEdit {
            op,
            range: value,
            text,
        },
        (AttributeSlot::Static { whole, .. }, None) => TextEdit {
            op,
            range: source[..whole.start].trim_end().len()..whole.end,
            text: String::new(),
        },
        (AttributeSlot::Missing { insert_at }, text) => TextEdit {
            op,
            range: insert_at..insert_at,
            text: text.map_or_else(String::new, |text| format!(" {name}=\"{text}\"")),
        },
    })
}

fn style_key(key: &str) -> String {
    let mut chars = key.chars();
    let identifier = chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_' || first == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$');
    if identifier {
        key.to_owned()
    } else {
        format!("'{}'", key.replace('\\', "\\\\").replace('\'', "\\'"))
    }
}

fn style_value(value: &EditOpValue) -> Option<String> {
    match value {
        EditOpValue::String(text) => Some(format!(
            "'{}'",
            text.replace('\\', "\\\\").replace('\'', "\\'")
        )),
        EditOpValue::Number(number) if number.fract() == 0.0 && number.abs() < 1e15 => {
            Some(format!("{number:.0}"))
        }
        EditOpValue::Number(number) => Some(number.to_string()),
        EditOpValue::Null => None,
    }
}

fn css_value(property: &str, value: &EditOpValue) -> Option<String> {
    match value {
        EditOpValue::String(text) => Some(text.clone()),
        EditOpValue::Number(number) => Some(template::css_number(property, *number)),
        EditOpValue::Null => None,
    }
}

fn merged_style(
    source: &str,
    object: &StyleObject,
    changes: &[(String, Option<String>)],
) -> String {
    let change_for = |key: &str| changes.iter().find(|(name, _)| name == key);
    let mut parts: Vec<String> = Vec::new();
    for prop in &object.props {
        match change_for(&prop.key) {
            Some((_, None)) => {}
            Some((_, Some(value))) => parts.push(format!(
                "{}{value}{}",
                &source[prop.range.start..prop.value_range.start],
                &source[prop.value_range.end..prop.range.end]
            )),
            None => parts.push(source[prop.range.clone()].to_owned()),
        }
    }
    for (key, value) in changes {
        if let Some(value) = value
            && !object.props.iter().any(|prop| &prop.key == key)
        {
            parts.push(format!("{}: {value}", style_key(key)));
        }
    }
    if parts.is_empty() {
        return String::new();
    }
    let (Some(first), Some(last)) = (object.props.first(), object.props.last()) else {
        return format!(" {} ", parts.join(", "));
    };
    let leading = &source[object.inner.start..first.range.start];
    let trailing = &source[last.range.end..object.inner.end];
    let separator = if leading.contains('\n') {
        format!(",{leading}")
    } else {
        ", ".to_owned()
    };
    format!("{leading}{}{trailing}", parts.join(&separator))
}

fn resolve_style<'s>(
    members: &[usize],
    ops: &[EditOp],
    sources: &'s BTreeMap<String, String>,
    dialect: Dialect,
) -> Result<(&'s str, TextEdit), PatchError> {
    let op = members[0];
    let EditOp::StyleProp {
        file,
        base_hash,
        at,
        ..
    } = &ops[op]
    else {
        unreachable!("only style_prop ops are grouped");
    };
    let (path, source) = current(op, file, base_hash, sources)?;
    let element = find_element(path, source, at.line.get(), at.column.get())
        .map_err(|source| PatchError::Element { op, source })?;
    let css = template::is_template(path);
    let kebab_keys = matches!(&element.style, StyleSource::Object(object) if object.props.iter().any(|prop| prop.key.contains('-') && !prop.key.starts_with("--")));
    let solid = dialect.solid || kebab_keys || is_solid(source);
    let mut changes: Vec<(String, Option<String>)> = Vec::new();
    for member in members {
        if let EditOp::StyleProp { prop, value, .. } = &ops[*member] {
            let (name, value) = if css {
                let property = template::kebab(prop.as_str());
                let value = css_value(&property, value);
                (property, value)
            } else if solid {
                let property = template::kebab(prop.as_str());
                let value = css_value(&property, value)
                    .map(|text| format!("'{}'", text.replace('\\', "\\\\").replace('\'', "\\'")));
                (property, value)
            } else {
                (prop.to_string(), style_value(value))
            };
            match changes.iter_mut().find(|(seen, _)| *seen == name) {
                Some(entry) => entry.1 = value,
                None => changes.push((name, value)),
            }
        }
    }
    if css {
        let edit = match &element.style {
            StyleSource::Css(literal) => TextEdit {
                op,
                range: literal.range.clone(),
                text: template::merged_css(&literal.value, &changes),
            },
            StyleSource::None => {
                let text = template::merged_css("", &changes);
                TextEdit {
                    op,
                    range: element.insert_at..element.insert_at,
                    text: if text.is_empty() {
                        String::new()
                    } else {
                        format!(" style=\"{text}\"")
                    },
                }
            }
            StyleSource::Object(_) | StyleSource::Dynamic => {
                return Err(PatchError::StyleNotEditable { op });
            }
        };
        return Ok((path, edit));
    }
    let edit = match &element.style {
        StyleSource::Object(object) => TextEdit {
            op,
            range: object.inner.clone(),
            text: merged_style(source, object, &changes),
        },
        StyleSource::None => {
            let empty = StyleObject {
                props: Vec::new(),
                inner: 0..0,
            };
            let inner = merged_style(source, &empty, &changes);
            TextEdit {
                op,
                range: element.insert_at..element.insert_at,
                text: if inner.is_empty() {
                    String::new()
                } else {
                    format!(" style={{{{{inner}}}}}")
                },
            }
        }
        StyleSource::Css(_) | StyleSource::Dynamic => {
            return Err(PatchError::StyleNotEditable { op });
        }
    };
    Ok((path, edit))
}

fn current<'s>(
    op: usize,
    file: &ProjectPath,
    base_hash: &ContentHash,
    sources: &'s BTreeMap<String, String>,
) -> Result<(&'s str, &'s str), PatchError> {
    let (path, source) =
        sources
            .get_key_value(file.as_str())
            .ok_or_else(|| PatchError::UnknownFile {
                op,
                file: file.to_string(),
            })?;
    if content_hash(source.as_bytes()) != *base_hash {
        return Err(PatchError::StaleBase {
            op,
            file: path.clone(),
        });
    }
    Ok((path, source))
}

fn merge_tokens(existing: &str, add: &[EditOpAddItem], remove: &[EditOpRemoveItem]) -> String {
    let mut tokens = Vec::new();
    let mut insert_at = None;
    for token in existing.split_whitespace() {
        if remove.iter().any(|removed| removed.as_str() == token) {
            insert_at.get_or_insert(tokens.len());
        } else {
            tokens.push(token);
        }
    }
    let mut fresh: Vec<&str> = Vec::new();
    for token in add {
        if !tokens.contains(&token.as_str()) && !fresh.contains(&token.as_str()) {
            fresh.push(token.as_str());
        }
    }
    let at = insert_at.unwrap_or(tokens.len());
    tokens.splice(at..at, fresh);
    tokens.join(" ")
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::{PatchError, apply, rebase};
    use crate::content_hash;
    use crate::contracts::EditOp;

    const FILE: &str = "src/B.tsx";

    fn sources(content: &str) -> BTreeMap<String, String> {
        BTreeMap::from([(FILE.to_owned(), content.to_owned())])
    }

    fn op(value: serde_json::Value) -> EditOp {
        serde_json::from_value(value).expect("valid op")
    }

    fn class_tokens(
        content: &str,
        line: u64,
        column: u64,
        add: &[&str],
        remove: &[&str],
    ) -> EditOp {
        op(json!({
            "kind": "class_tokens", "file": FILE, "base_hash": content_hash(content.as_bytes()).as_str(),
            "at": { "line": line, "column": column }, "add": add, "remove": remove,
        }))
    }

    fn snippet(content: &str, find: &str, replace: &str) -> EditOp {
        op(json!({
            "kind": "replace_snippet", "file": FILE, "base_hash": content_hash(content.as_bytes()).as_str(),
            "find": find, "replace": replace,
        }))
    }

    const CARD: &str = "export const B = () => (\n  <div>\n    <b />\n  </div>\n);\n";

    fn text_op(file: &str, content: &str, needle: &str, run: u64, value: &str) -> EditOp {
        let (line, column) = crate::srcloc::LineIndex::new(content)
            .position(content.find(needle).expect("needle present"));
        op(json!({
            "kind": "text_content", "file": file, "base_hash": content_hash(content.as_bytes()).as_str(),
            "at": { "line": line, "column": column }, "run": run, "value": value,
        }))
    }

    #[test]
    fn rewrites_one_text_run_escaped_and_keeps_the_whitespace_and_children_around_it() {
        let content = "export const B = () => (\n  <p className=\"x\">\n    Hello <strong>world</strong>!\n  </p>\n);\n";
        let next = apply(
            &sources(content),
            &[text_op(FILE, content, "<p", 0, "Brew & Co. <Café> {x}")],
        )
        .expect("applies")
        .remove(FILE)
        .expect("file");
        assert_eq!(
            next,
            "export const B = () => (\n  <p className=\"x\">\n    Brew &amp; Co. &lt;Café&gt; &#123;x&#125; <strong>world</strong>!\n  </p>\n);\n"
        );
        let second = apply(&sources(content), &[text_op(FILE, content, "<p", 1, "?")])
            .expect("applies")
            .remove(FILE)
            .expect("file");
        assert!(second.contains("<strong>world</strong>?\n"));
    }

    fn text_at(file: &str, content: &str, needle: &str, value: &str) -> EditOp {
        let (line, column) = crate::srcloc::LineIndex::new(content)
            .position(content.find(needle).expect("needle present"));
        op(json!({
            "kind": "text_at", "file": file, "base_hash": content_hash(content.as_bytes()).as_str(),
            "at": { "line": line, "column": column }, "value": value,
        }))
    }

    #[test]
    fn text_at_rewrites_the_string_in_data_and_a_json_file_together() {
        let data = "const TABS = [\n  { id: 'a', title: \"CBPLD Overview\" },\n];\n";
        let json = "{\n  \"footer\": { \"hours\": \"Open\" }\n}\n";
        let files = BTreeMap::from([
            ("src/Dash.tsx".to_owned(), data.to_owned()),
            ("src/i18n/en.json".to_owned(), json.to_owned()),
        ]);
        let next = apply(
            &files,
            &[
                text_at("src/Dash.tsx", data, "\"CBPLD", "Say \"오늘\""),
                text_at("src/i18n/en.json", json, "\"Open", "7 \\ 7"),
            ],
        )
        .expect("applies");
        assert_eq!(
            next["src/Dash.tsx"],
            "const TABS = [\n  { id: 'a', title: \"Say \\\"오늘\\\"\" },\n];\n"
        );
        assert_eq!(
            next["src/i18n/en.json"],
            "{\n  \"footer\": { \"hours\": \"7 \\\\ 7\" }\n}\n"
        );
    }

    #[test]
    fn text_at_fails_when_no_string_starts_there() {
        let data = "const TABS = [{ title: 'Home' }];\n";
        let error = apply(&sources(data), &[text_at(FILE, data, "title", "x")]).expect_err("fails");
        assert!(matches!(error, PatchError::NoTextAt { op: 0, line: 1, .. }));
    }

    #[test]
    fn writes_text_into_an_empty_element_and_a_template() {
        let content = "export const B = () => <p className=\"x\"></p>;\n";
        let next = apply(&sources(content), &[text_op(FILE, content, "<p", 0, "New")])
            .expect("applies")
            .remove(FILE)
            .expect("file");
        assert_eq!(next, "export const B = () => <p className=\"x\">New</p>;\n");

        let vue = "<template>\n  <h1 class=\"a\">{{ greeting }} Old title</h1>\n</template>\n";
        let files = BTreeMap::from([("src/A.vue".to_owned(), vue.to_owned())]);
        let next = apply(
            &files,
            &[text_op("src/A.vue", vue, "<h1", 0, "{{ x }} & new")],
        )
        .expect("applies")
        .remove("src/A.vue")
        .expect("file");
        assert_eq!(
            next,
            "<template>\n  <h1 class=\"a\">{{ greeting }} &#123;&#123; x &#125;&#125; &amp; new</h1>\n</template>\n"
        );
    }

    #[test]
    fn refuses_a_text_run_the_element_does_not_have() {
        let content = "export const B = ({ name }) => <p>{name}</p>;\n";
        let error = apply(&sources(content), &[text_op(FILE, content, "<p", 0, "x")])
            .expect_err("no plain run");
        assert!(matches!(
            error,
            PatchError::TextNotEditable { op: 0, run: 0 }
        ));
    }

    fn style(
        content: &str,
        line: u64,
        column: u64,
        prop: &str,
        value: &serde_json::Value,
    ) -> EditOp {
        op(json!({
            "kind": "style_prop", "file": FILE, "base_hash": content_hash(content.as_bytes()).as_str(),
            "at": { "line": line, "column": column }, "prop": prop, "value": value,
        }))
    }

    fn styled(content: &str, changes: &[(&str, serde_json::Value)]) -> Result<String, PatchError> {
        let column = u64::try_from(content.find("<b").expect("an element") + 1).expect("column");
        let ops: Vec<EditOp> = changes
            .iter()
            .map(|(prop, value)| style(content, 1, column, prop, value))
            .collect();
        Ok(apply(&sources(content), &ops)?
            .remove(FILE)
            .expect("changed"))
    }

    #[test]
    fn edits_an_inline_style_object_keeping_its_layout() {
        let one_line = "export const B = () => <b style={{ backgroundColor: '#fde68a', borderRadius: 8, padding: 16 }} />;\n";
        assert_eq!(
            styled(
                one_line,
                &[
                    ("backgroundColor", json!("#1D4ED8")),
                    ("borderRadius", json!(12))
                ]
            )
            .expect("edits"),
            "export const B = () => <b style={{ backgroundColor: '#1D4ED8', borderRadius: 12, padding: 16 }} />;\n"
        );
        assert_eq!(
            styled(
                one_line,
                &[("borderRadius", json!(null)), ("color", json!("white"))]
            )
            .expect("edits"),
            "export const B = () => <b style={{ backgroundColor: '#fde68a', padding: 16, color: 'white' }} />;\n"
        );
        let multi = "export const B = () => <b\n  style={{\n    backgroundColor: '#fde68a',\n    borderRadius: 8,\n  }}\n/>;\n";
        let ops = [
            style(multi, 1, 24, "borderRadius", &json!(4.5)),
            style(multi, 1, 24, "opacity", &json!(0.5)),
        ];
        assert_eq!(
            apply(&sources(multi), &ops)
                .expect("edits")
                .remove(FILE)
                .expect("changed"),
            "export const B = () => <b\n  style={{\n    backgroundColor: '#fde68a',\n    borderRadius: 4.5,\n    opacity: 0.5,\n  }}\n/>;\n"
        );
    }

    #[test]
    fn adds_a_style_attribute_or_props_when_there_are_none() {
        let bare = "export const B = () => <b className=\"x\" />;\n";
        assert_eq!(
            styled(
                bare,
                &[
                    ("backgroundColor", json!("#fff")),
                    ("--brand", json!("it's"))
                ]
            )
            .expect("adds"),
            "export const B = () => <b style={{ backgroundColor: '#fff', '--brand': 'it\\'s' }} className=\"x\" />;\n"
        );
        let empty = "export const B = () => <b style={{}} />;\n";
        assert_eq!(
            styled(empty, &[("borderRadius", json!(999))]).expect("adds"),
            "export const B = () => <b style={{ borderRadius: 999 }} />;\n"
        );
        assert_eq!(
            styled(bare, &[("borderRadius", json!(null))]).expect("no-op"),
            bare
        );
        let repeated = "export const B = () => <b style={{ color: 'red' }} />;\n";
        assert_eq!(
            styled(
                repeated,
                &[("color", json!("blue")), ("color", json!("green"))]
            )
            .expect("last wins"),
            "export const B = () => <b style={{ color: 'green' }} />;\n"
        );
        assert_eq!(
            styled(repeated, &[("color", json!(null))]).expect("emptied"),
            "export const B = () => <b style={{}} />;\n"
        );
    }

    #[test]
    fn refuses_styles_computed_at_runtime() {
        for source in [
            "export const B = (p) => <b style={p.style} />;\n",
            "export const B = (p) => <b style={{ ...p.style, color: 'red' }} />;\n",
            "export const B = (p) => <b style={{ [p.key]: 'red' }} />;\n",
            "export const B = (p) => <b style={{ color: 'red' }} {...p} />;\n",
        ] {
            let error = styled(source, &[("color", json!("blue"))]).expect_err(source);
            assert!(
                matches!(error, PatchError::StyleNotEditable { op: 0 }),
                "{source}: {error}"
            );
        }
        let variable = "export const B = (p) => <b style={{ color: p.color, padding: 4 }} />;\n";
        assert_eq!(
            styled(variable, &[("padding", json!(8))]).expect("literal props stay editable"),
            "export const B = (p) => <b style={{ color: p.color, padding: 8 }} />;\n"
        );
    }

    fn attr(content: &str, name: &str, value: &serde_json::Value) -> EditOp {
        let column = u64::try_from(content.find("<button").expect("a button") + 1).expect("column");
        op(json!({
            "kind": "jsx_attr", "file": FILE, "base_hash": content_hash(content.as_bytes()).as_str(),
            "at": { "line": 1, "column": column }, "name": name, "value": value,
        }))
    }

    #[test]
    fn edits_plain_string_attributes_on_a_jsx_element() {
        let content = "export const B = () => <button type=\"button\" aria-label=\"Order\" className=\"p-2\">Go</button>;\n";

        let changed = apply(
            &sources(content),
            &[
                attr(content, "type", &json!({ "string": "submit" })),
                attr(
                    content,
                    "title",
                    &json!({ "string": "Order \"now\" & pay" }),
                ),
                attr(content, "aria-label", &json!(null)),
            ],
        )
        .expect("applies");

        assert_eq!(
            changed[FILE],
            "export const B = () => <button title=\"Order &quot;now&quot; &amp; pay\" type=\"submit\" className=\"p-2\">Go</button>;\n"
        );
    }

    #[test]
    fn refuses_jsx_attributes_that_are_expressions_or_may_come_from_a_spread() {
        let bound = "export const B = (p) => <button onClick={p.go} {...p}>Go</button>;\n";

        for (name, value) in [
            ("onClick", json!({ "string": "x" })),
            ("title", json!({ "string": "x" })),
        ] {
            assert!(
                matches!(
                    apply(&sources(bound), &[attr(bound, name, &value)]),
                    Err(PatchError::AttributeNotEditable { .. })
                ),
                "{name}"
            );
        }
    }

    #[test]
    fn snippet_edits_keep_a_crlf_file_in_crlf() {
        let lf = "export const A = () => (\n  <div>\n    <b>old</b>\n  </div>\n);\n";
        let crlf = lf.replace('\n', "\r\n");
        let edit = snippet(
            &crlf,
            "<div>\n    <b>old</b>",
            "<div>\n    <b>new</b>\n    <i>more</i>",
        );

        let changed = apply(&sources(&crlf), &[edit]).expect("applies");

        assert_eq!(
            changed[FILE],
            "export const A = () => (\r\n  <div>\r\n    <b>new</b>\r\n    <i>more</i>\r\n  </div>\r\n);\r\n"
        );
        let unchanged_lf = apply(
            &sources(lf),
            &[snippet(lf, "<b>old</b>", "<b>a</b>\n<b>b</b>")],
        )
        .expect("applies");
        assert!(!unchanged_lf[FILE].contains('\r'));
    }

    #[test]
    fn rebases_snippet_edits_onto_content_that_moved() {
        let ops = [snippet(CARD, "<b />", "<b />\n    <i />")];
        let current = format!("import x from './x';\n{CARD}");

        let rebased = rebase(FILE, &current, &ops).expect("rebased");

        assert_eq!(
            rebased,
            "import x from './x';\nexport const B = () => (\n  <div>\n    <b />\n    <i />\n  </div>\n);\n"
        );
    }

    #[test]
    fn rebase_fails_when_the_snippet_is_gone_or_repeated_or_not_a_snippet() {
        let ops = [snippet(CARD, "<b />", "<i />")];
        let gone = CARD.replace("<b />", "<u />");
        let repeated = CARD.replace("<b />", "<b />\n    <b />");

        assert!(matches!(
            rebase(FILE, &gone, &ops),
            Err(PatchError::SnippetNotUnique { count: 0, .. })
        ));
        assert!(matches!(
            rebase(FILE, &repeated, &ops),
            Err(PatchError::SnippetNotUnique { count: 2, .. })
        ));
        let tokens = [class_tokens(CARD, 2, 3, &["p-2"], &[])];
        assert!(matches!(
            rebase(FILE, CARD, &tokens),
            Err(PatchError::StaleBase { op: 0, .. })
        ));
    }

    #[test]
    fn rewrites_only_the_class_literal_and_keeps_the_rest_of_the_file() {
        let content = "export const B = () => (\r\n  <button className=\"rounded-lg bg-brand px-6\">\r\n    오늘\r\n  </button>\r\n);\r\n";
        let ops = [class_tokens(
            content,
            2,
            3,
            &["bg-[#2563EB]"],
            &["bg-brand"],
        )];

        let changed = apply(&sources(content), &ops).expect("applied");

        assert_eq!(
            changed[FILE],
            "export const B = () => (\r\n  <button className=\"rounded-lg bg-[#2563EB] px-6\">\r\n    오늘\r\n  </button>\r\n);\r\n"
        );
    }

    #[test]
    fn puts_added_tokens_where_the_first_removed_token_was() {
        let content = "const b = <b className=\"p-2 rounded-t-xl shadow rounded-lg\" />;";
        let ops = [class_tokens(
            content,
            1,
            11,
            &["rounded-[12px]", "shadow"],
            &["rounded-t-xl", "rounded-lg"],
        )];

        let changed = apply(&sources(content), &ops).expect("applied");

        assert_eq!(
            changed[FILE],
            "const b = <b className=\"p-2 rounded-[12px] shadow\" />;"
        );
    }

    #[test]
    fn edits_the_first_literal_of_a_cn_call() {
        let content = "const b = <b className={cn('px-4 bg-brand', on && 'font-bold')} />;";
        let ops = [class_tokens(content, 1, 11, &["bg-sea"], &["bg-brand"])];

        let changed = apply(&sources(content), &ops).expect("applied");

        assert_eq!(
            changed[FILE],
            "const b = <b className={cn('px-4 bg-sea', on && 'font-bold')} />;"
        );
    }

    #[test]
    fn inserts_a_class_name_when_the_element_has_none() {
        let content = "const b = <section id=\"x\" />;";
        let ops = [class_tokens(content, 1, 11, &["bg-sea"], &[])];

        let changed = apply(&sources(content), &ops).expect("applied");

        assert_eq!(
            changed[FILE],
            "const b = <section className=\"bg-sea\" id=\"x\" />;"
        );
    }

    #[test]
    fn replaces_a_snippet_that_occurs_exactly_once() {
        let content = "const b = <b className=\"bg-brand\" />;";

        let changed =
            apply(&sources(content), &[snippet(content, "bg-brand", "bg-sea")]).expect("applied");

        assert_eq!(changed[FILE], "const b = <b className=\"bg-sea\" />;");
    }

    #[test]
    fn rejects_snippets_that_are_missing_or_repeated() {
        let content = "const a = 'x'; const b = 'x';";

        assert_eq!(
            apply(&sources(content), &[snippet(content, "'x'", "'y'")]),
            Err(PatchError::SnippetNotUnique {
                op: 0,
                file: FILE.to_owned(),
                count: 2
            })
        );
        assert_eq!(
            apply(&sources(content), &[snippet(content, "'z'", "'y'")]),
            Err(PatchError::SnippetNotUnique {
                op: 0,
                file: FILE.to_owned(),
                count: 0
            })
        );
    }

    #[test]
    fn rejects_ops_proposed_against_older_content() {
        let proposed_for = "const b = <b className=\"bg-brand\" />;";
        let on_disk = "const b = <b className=\"bg-brand p-2\" />;";

        assert_eq!(
            apply(
                &sources(on_disk),
                &[snippet(proposed_for, "bg-brand", "bg-sea")]
            ),
            Err(PatchError::StaleBase {
                op: 0,
                file: FILE.to_owned()
            })
        );
    }

    #[test]
    fn rejects_overlapping_ops() {
        let content = "const b = <b className=\"bg-brand p-2\" />;";
        let ops = [
            snippet(content, "bg-brand p-2", "bg-sea"),
            snippet(content, "brand p", "x"),
        ];

        assert_eq!(
            apply(&sources(content), &ops),
            Err(PatchError::Overlap {
                first: 0,
                second: 1,
                file: FILE.to_owned()
            })
        );
    }

    #[test]
    fn rejects_a_result_that_does_not_parse() {
        let content = "const b = <b className=\"bg-brand\" />;";

        assert!(matches!(
            apply(&sources(content), &[snippet(content, "/>", ">")]),
            Err(PatchError::Syntax { .. })
        ));
    }

    #[test]
    fn rejects_unknown_files_and_dynamic_class_names() {
        let content = "const b = (p) => <b className={p.c} />;";
        let mut other = class_tokens(content, 1, 18, &["bg-sea"], &[]);
        if let EditOp::ClassTokens { file, .. } = &mut other {
            *file = "src/Other.tsx".try_into().expect("valid path");
        }

        assert_eq!(
            apply(&sources(content), &[other]),
            Err(PatchError::UnknownFile {
                op: 0,
                file: "src/Other.tsx".to_owned()
            })
        );
        assert_eq!(
            apply(
                &sources(content),
                &[class_tokens(content, 1, 18, &["bg-sea"], &[])]
            ),
            Err(PatchError::NotEditable { op: 0 })
        );
    }

    #[test]
    fn solid_components_use_class_rather_than_class_name() {
        let solid = "import { createSignal } from 'solid-js';\nexport const B = () => <b class=\"bg-brand p-2\" />;\n";
        let edit = class_tokens(solid, 2, 24, &["bg-sea"], &["bg-brand"]);
        assert_eq!(
            apply(&sources(solid), &[edit])
                .expect("edits")
                .remove(FILE)
                .expect("changed"),
            "import { createSignal } from 'solid-js';\nexport const B = () => <b class=\"bg-sea p-2\" />;\n"
        );
        let bare = "import { For } from \"solid-js\";\nexport const B = () => <b />;\n";
        let added = class_tokens(bare, 2, 24, &["bg-sea"], &[]);
        assert_eq!(
            apply(&sources(bare), &[added])
                .expect("adds")
                .remove(FILE)
                .expect("changed"),
            "import { For } from \"solid-js\";\nexport const B = () => <b class=\"bg-sea\" />;\n"
        );
        let react = "export const B = () => <b />;\n";
        let react_added = class_tokens(react, 1, 24, &["bg-sea"], &[]);
        assert_eq!(
            apply(&sources(react), &[react_added])
                .expect("adds")
                .remove(FILE)
                .expect("changed"),
            "export const B = () => <b className=\"bg-sea\" />;\n"
        );
    }

    #[test]
    fn solid_style_objects_get_css_names_and_string_values() {
        let solid = "import { For } from 'solid-js';\nexport const B = () => <b style={{ 'background-color': '#fde68a', 'border-radius': '8px', padding: '16px' }} />;\n";
        let column = 24;
        let ops = [
            style(solid, 2, column, "backgroundColor", &json!("#1D4ED8")),
            style(solid, 2, column, "borderRadius", &json!(12)),
            style(solid, 2, column, "opacity", &json!(0.5)),
        ];
        assert_eq!(
            apply(&sources(solid), &ops)
                .expect("edits")
                .remove(FILE)
                .expect("changed"),
            "import { For } from 'solid-js';\nexport const B = () => <b style={{ 'background-color': '#1D4ED8', 'border-radius': '12px', padding: '16px', opacity: '0.5' }} />;\n"
        );
    }

    #[test]
    fn kebab_keys_or_the_solid_dialect_choose_css_names_without_an_import() {
        let kebab = "export const B = () => <b style={{ 'background-color': '#fde68a' }} />;\n";
        let ops = [style(kebab, 1, 24, "borderRadius", &json!(4))];
        assert_eq!(
            apply(&sources(kebab), &ops)
                .expect("edits")
                .remove(FILE)
                .expect("changed"),
            "export const B = () => <b style={{ 'background-color': '#fde68a', 'border-radius': '4px' }} />;\n"
        );
        let bare = "export const B = () => <b />;\n";
        let ops = [
            style(bare, 1, 24, "backgroundColor", &json!("#fff")),
            class_tokens(bare, 1, 24, &["p-2"], &[]),
        ];
        assert_eq!(
            super::apply_with(&sources(bare), &ops, super::Dialect { solid: true })
                .expect("edits")
                .remove(FILE)
                .expect("changed"),
            "export const B = () => <b class=\"p-2\" style={{ 'background-color': '#fff' }} />;\n"
        );
    }
}
