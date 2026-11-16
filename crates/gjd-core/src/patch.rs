use std::collections::BTreeMap;
use std::ops::Range;

use crate::content_hash;
use crate::contracts::{ContentHash, EditOp, EditOpAddItem, EditOpRemoveItem, ProjectPath};
use crate::jsx::{ClassSource, JsxError, check_syntax, find_element};

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

struct TextEdit {
    op: usize,
    range: Range<usize>,
    text: String,
}

pub fn apply(
    sources: &BTreeMap<String, String>,
    ops: &[EditOp],
) -> Result<BTreeMap<String, String>, PatchError> {
    let mut edits: BTreeMap<&str, Vec<TextEdit>> = BTreeMap::new();
    for (op, edit_op) in ops.iter().enumerate() {
        let (file, edit) = resolve(op, edit_op, sources)?;
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
                    TextEdit {
                        op,
                        range: element.insert_at..element.insert_at,
                        text: if classes.is_empty() {
                            String::new()
                        } else {
                            format!(" className=\"{classes}\"")
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
            let mut matches = source.match_indices(find.as_str());
            let (Some((start, _)), None) = (matches.next(), matches.next()) else {
                return Err(PatchError::SnippetNotUnique {
                    op,
                    file: path.to_owned(),
                    count: source.matches(find.as_str()).count(),
                });
            };
            Ok((
                path,
                TextEdit {
                    op,
                    range: start..start + find.len(),
                    text: replace.clone(),
                },
            ))
        }
        EditOp::JsxAttr { .. } => Err(PatchError::Unsupported {
            op,
            kind: "jsx_attr",
        }),
        EditOp::StyleProp { .. } => Err(PatchError::Unsupported {
            op,
            kind: "style_prop",
        }),
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
}
