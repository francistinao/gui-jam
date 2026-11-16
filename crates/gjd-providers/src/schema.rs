use std::collections::BTreeSet;
use std::sync::LazyLock;

use gjd_core::VARIANT_SET_PROVIDER_SCHEMA;
use serde_json::{Map, Value, json};

pub(crate) struct StrictSchema {
    pub(crate) json: String,
    pub(crate) nullable: BTreeSet<String>,
}

pub(crate) static STRICT_SCHEMA: LazyLock<StrictSchema> =
    LazyLock::new(|| strict_schema(VARIANT_SET_PROVIDER_SCHEMA));

fn strict_schema(source: &str) -> StrictSchema {
    let mut schema: Value =
        serde_json::from_str(source).expect("the provider schema is valid JSON");
    let mut optional = BTreeSet::new();
    let mut required = BTreeSet::new();
    tighten(&mut schema, &mut optional, &mut required);
    StrictSchema {
        json: schema.to_string(),
        nullable: optional.difference(&required).cloned().collect(),
    }
}

fn tighten(node: &mut Value, optional: &mut BTreeSet<String>, required: &mut BTreeSet<String>) {
    match node {
        Value::Array(items) => {
            for item in items {
                tighten(item, optional, required);
            }
        }
        Value::Object(map) => {
            for child in map.values_mut() {
                tighten(child, optional, required);
            }
            if let Some(one_of) = map.remove("oneOf") {
                map.insert("anyOf".to_owned(), one_of);
            }
            require_every_property(map, optional, required);
        }
        _ => {}
    }
}

fn require_every_property(
    map: &mut Map<String, Value>,
    optional: &mut BTreeSet<String>,
    required: &mut BTreeSet<String>,
) {
    let listed: BTreeSet<String> = map
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let Some(Value::Object(properties)) = map.get_mut("properties") else {
        return;
    };
    let mut names = Vec::with_capacity(properties.len());
    for (name, property) in properties.iter_mut() {
        names.push(Value::String(name.clone()));
        if listed.contains(name) {
            required.insert(name.clone());
        } else {
            optional.insert(name.clone());
            let schema = property.take();
            *property = json!({ "anyOf": [schema, { "type": "null" }] });
        }
    }
    map.insert("required".to_owned(), Value::Array(names));
}

pub(crate) fn drop_null_optionals(value: &mut Value, nullable: &BTreeSet<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                drop_null_optionals(item, nullable);
            }
        }
        Value::Object(map) => {
            map.retain(|name, field| !(field.is_null() && nullable.contains(name)));
            for field in map.values_mut() {
                drop_null_optionals(field, nullable);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, Value, json};

    use super::{STRICT_SCHEMA, strict_schema};

    fn every_object(value: &Value, check: &mut impl FnMut(&Map<String, Value>)) {
        match value {
            Value::Array(items) => {
                for item in items {
                    every_object(item, check);
                }
            }
            Value::Object(map) => {
                check(map);
                for child in map.values() {
                    every_object(child, check);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn makes_every_property_required_and_optional_ones_nullable() {
        let strict = strict_schema(
            r#"{"type":"object","required":["a"],"additionalProperties":false,
                "properties":{"a":{"oneOf":[{"type":"string"}]},"b":{"type":"string"}}}"#,
        );
        let schema: Value = serde_json::from_str(&strict.json).expect("json");

        assert_eq!(schema["required"], json!(["a", "b"]));
        assert_eq!(
            schema["properties"]["a"],
            json!({ "anyOf": [{ "type": "string" }] })
        );
        assert_eq!(
            schema["properties"]["b"],
            json!({ "anyOf": [{ "type": "string" }, { "type": "null" }] })
        );
        assert_eq!(strict.nullable.iter().collect::<Vec<_>>(), ["b"]);
    }

    #[test]
    fn the_provider_schema_meets_strict_mode_everywhere() {
        let schema: Value = serde_json::from_str(&STRICT_SCHEMA.json).expect("json");
        every_object(&schema, &mut |map| {
            assert!(!map.contains_key("oneOf"));
            if let Some(Value::Object(properties)) = map.get("properties") {
                let required: Vec<&str> = map["required"]
                    .as_array()
                    .expect("required is listed")
                    .iter()
                    .filter_map(Value::as_str)
                    .collect();
                assert_eq!(
                    required,
                    properties.keys().map(String::as_str).collect::<Vec<_>>()
                );
            }
        });
        assert!(STRICT_SCHEMA.nullable.contains("answer"));
        assert!(!STRICT_SCHEMA.nullable.contains("value"));
    }
}
