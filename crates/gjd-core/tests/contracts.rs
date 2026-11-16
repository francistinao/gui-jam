use gjd_core::content_hash;
use gjd_core::contracts::{EditOp, UpdateResult, UpdateResultStatus, VariantSet};
use serde_json::json;

const HASH: &str = "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262";

fn variant_with_ops(ops: &serde_json::Value) -> serde_json::Value {
    json!({
        "variants": [{
            "label": "Solid",
            "system": "project",
            "style": "solid",
            "rationale": "Uses the brand token.",
            "missing": [],
            "ops": ops
        }]
    })
}

#[test]
fn content_hash_is_blake3_hex_of_the_bytes() {
    assert_eq!(content_hash(b"").as_str(), HASH);
}

#[test]
fn variant_set_parses_every_edit_op_kind() {
    let doc = variant_with_ops(&json!([
        { "kind": "replace_snippet", "file": "src/A.tsx", "base_hash": HASH, "find": "bg-red-500", "replace": "bg-blue-600" },
        { "kind": "class_tokens", "file": "src/A.tsx", "base_hash": HASH, "at": { "line": 3, "column": 5 }, "add": ["rounded-full"], "remove": ["rounded-lg"] },
        { "kind": "jsx_attr", "file": "src/A.tsx", "base_hash": HASH, "at": { "line": 3, "column": 5 }, "name": "aria-label", "value": { "string": "Order" } },
        { "kind": "jsx_attr", "file": "src/A.tsx", "base_hash": HASH, "at": { "line": 3, "column": 5 }, "name": "title", "value": null },
        { "kind": "style_prop", "file": "src/A.tsx", "base_hash": HASH, "at": { "line": 3, "column": 5 }, "prop": "opacity", "value": 0.5 },
        { "kind": "create_file", "file": "src/B.tsx", "content": "export {}\n" },
        { "kind": "rewrite_file", "file": "src/A.tsx", "base_hash": HASH, "content": "export {}\n" }
    ]));

    let set: VariantSet = serde_json::from_value(doc).expect("valid variant set");
    let ops = &set.variants[0].ops;

    assert_eq!(ops.len(), 7);
    assert!(matches!(ops[0], EditOp::ReplaceSnippet { .. }));
    assert!(matches!(ops[3], EditOp::JsxAttr { value: None, .. }));
    assert!(matches!(ops[6], EditOp::RewriteFile { .. }));
}

#[test]
fn edit_op_with_unknown_kind_is_rejected() {
    let op =
        json!({ "kind": "delete_file", "file": "src/A.tsx", "base_hash": HASH, "content": "" });
    assert!(serde_json::from_value::<EditOp>(op).is_err());
}

#[test]
fn edit_op_with_fields_of_another_kind_is_rejected() {
    let op =
        json!({ "kind": "create_file", "file": "src/A.tsx", "base_hash": HASH, "content": "" });
    assert!(serde_json::from_value::<EditOp>(op).is_err());
}

#[test]
fn edit_op_with_malformed_base_hash_is_rejected() {
    let op = json!({ "kind": "replace_snippet", "file": "src/A.tsx", "base_hash": "ABC", "find": "a", "replace": "b" });
    assert!(serde_json::from_value::<EditOp>(op).is_err());
}

#[test]
fn edit_op_with_empty_find_is_rejected() {
    let op = json!({ "kind": "replace_snippet", "file": "src/A.tsx", "base_hash": HASH, "find": "", "replace": "b" });
    assert!(serde_json::from_value::<EditOp>(op).is_err());
}

#[test]
fn variant_label_over_40_chars_is_rejected() {
    let mut doc = variant_with_ops(&json!([
        { "kind": "create_file", "file": "src/B.tsx", "content": "" }
    ]));
    doc["variants"][0]["label"] = json!("x".repeat(41));
    assert!(serde_json::from_value::<VariantSet>(doc).is_err());
}

#[test]
fn variant_counts_are_not_enforced_by_deserialization() {
    let doc = json!({ "variants": [] });
    assert!(serde_json::from_value::<VariantSet>(doc).is_ok());
}

#[test]
fn update_result_round_trips_with_camel_case_fields() {
    let doc = json!({
        "updateId": "u-1",
        "status": "compile_error",
        "latencyMs": 42.5,
        "errors": [{ "message": "Unexpected token", "file": "src/A.tsx", "line": 3, "attributed": true }]
    });
    let result: UpdateResult = serde_json::from_value(doc.clone()).expect("valid update result");

    assert_eq!(result.status, UpdateResultStatus::CompileError);
    assert_eq!(serde_json::to_value(&result).expect("serializable"), doc);
}
