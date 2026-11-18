use std::ffi::OsString;
use std::path::PathBuf;

use serde_json::{Map, Value};

const CONFIG_FILES: [&str; 3] = ["config.json", "opencode.json", "opencode.jsonc"];
const CARRIED: [&str; 3] = ["provider", "enabled_providers", "disabled_providers"];
const SECRET_WORDS: [&str; 5] = ["key", "token", "secret", "password", "authorization"];

pub(crate) fn user_settings() -> Map<String, Value> {
    carried_settings(&config_files(|name| std::env::var_os(name), cfg!(windows)))
}

pub(crate) fn config_files(var: impl Fn(&str) -> Option<OsString>, windows: bool) -> Vec<PathBuf> {
    let set = |name: &str| {
        var(name)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };
    let home = if windows { "USERPROFILE" } else { "HOME" };
    let base = set("XDG_CONFIG_HOME").or_else(|| set(home).map(|home| home.join(".config")));
    let mut files: Vec<PathBuf> = base.map_or_else(Vec::new, |base| {
        CONFIG_FILES
            .iter()
            .map(|file| base.join("opencode").join(file))
            .collect()
    });
    files.extend(set("OPENCODE_CONFIG"));
    files
}

pub(crate) fn carried_settings(files: &[PathBuf]) -> Map<String, Value> {
    let mut carried = Map::new();
    for file in files {
        let Ok(text) = std::fs::read_to_string(file) else {
            continue;
        };
        let Ok(Value::Object(config)) = serde_json::from_str::<Value>(&strip_jsonc(&text)) else {
            continue;
        };
        for key in CARRIED {
            let Some(value) = config.get(key) else {
                continue;
            };
            let value = without_secrets(value.clone());
            match (carried.get_mut(key), value) {
                (Some(Value::Object(existing)), Value::Object(more)) => existing.extend(more),
                (_, value) => {
                    carried.insert(key.to_owned(), value);
                }
            }
        }
    }
    carried
}

fn secret_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    SECRET_WORDS.iter().any(|word| lower.contains(word))
}

fn placeholder(value: &str) -> bool {
    value.starts_with("{env:") || value.starts_with("{file:")
}

fn without_secrets(value: Value) -> Value {
    match value {
        Value::Object(entries) => Value::Object(
            entries
                .into_iter()
                .filter(|(name, value)| {
                    !(secret_name(name) && value.as_str().is_some_and(|text| !placeholder(text)))
                })
                .map(|(name, value)| (name, without_secrets(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(without_secrets).collect()),
        other => other,
    }
}

pub(crate) fn strip_jsonc(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(ch) = chars.next() {
        if in_string {
            plain.push(ch);
            if ch == '\\' {
                plain.extend(chars.next());
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                plain.push(ch);
            }
            '/' if chars.peek() == Some(&'/') => {
                for skipped in chars.by_ref() {
                    if skipped == '\n' {
                        plain.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut previous = ' ';
                for skipped in chars.by_ref() {
                    if previous == '*' && skipped == '/' {
                        break;
                    }
                    previous = skipped;
                }
            }
            _ => plain.push(ch),
        }
    }
    without_trailing_commas(&plain)
}

fn without_trailing_commas(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut plain = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;
    for (index, &ch) in chars.iter().enumerate() {
        if in_string {
            plain.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
        }
        let closes = chars[index + 1..]
            .iter()
            .find(|next| !next.is_whitespace())
            .is_some_and(|next| *next == '}' || *next == ']');
        if ch == ',' && closes {
            continue;
        }
        plain.push(ch);
    }
    plain
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::PathBuf;

    use serde_json::json;

    use super::{carried_settings, config_files, strip_jsonc};

    #[test]
    fn reads_jsonc_with_comments_urls_and_trailing_commas() {
        let text = r#"{
  // a comment
  "provider": {
    "local": { "options": { "baseURL": "http://127.0.0.1:1234/v1", }, /* inline */ },
  },
  "note": "a // b /* c */",
}"#;

        let parsed: serde_json::Value = serde_json::from_str(&strip_jsonc(text)).expect("json");

        assert_eq!(
            parsed["provider"]["local"]["options"]["baseURL"],
            "http://127.0.0.1:1234/v1"
        );
        assert_eq!(parsed["note"], "a // b /* c */");
    }

    #[test]
    fn carries_only_provider_settings_and_never_literal_secrets() {
        let dir = tempfile::tempdir().expect("dir");
        let global = dir.path().join("opencode.json");
        let override_file = dir.path().join("override.jsonc");
        std::fs::write(
            &global,
            json!({
                "provider": {
                    "lmstudio": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "http://localhost:1234/v1" } },
                    "openrouter": { "options": { "apiKey": "sk-literal", "headers": { "Authorization": "Bearer x", "X-Title": "app" } } },
                    "deepseek": { "options": { "apiKey": "{env:DEEPSEEK_API_KEY}" } }
                },
                "mcp": { "files": { "type": "local", "command": ["x"] } },
                "plugin": ["opencode-anthropic-auth"],
                "agent": { "build": {} },
                "permission": { "*": "allow" },
                "instructions": ["AGENTS.md"]
            })
            .to_string(),
        )
        .expect("write");
        std::fs::write(
            &override_file,
            "{ // later wins per provider\n \"provider\": { \"lmstudio\": { \"options\": { \"baseURL\": \"http://box:1234/v1\" } } },\n \"disabled_providers\": [\"openai\"], }",
        )
        .expect("write");

        let carried = carried_settings(&[global, dir.path().join("missing.json"), override_file]);

        assert_eq!(
            carried.keys().collect::<Vec<_>>(),
            ["disabled_providers", "provider"]
        );
        let provider = &carried["provider"];
        assert_eq!(
            provider["lmstudio"]["options"]["baseURL"],
            "http://box:1234/v1"
        );
        assert_eq!(
            provider["deepseek"]["options"]["apiKey"],
            "{env:DEEPSEEK_API_KEY}"
        );
        assert!(provider["openrouter"]["options"].get("apiKey").is_none());
        assert_eq!(
            provider["openrouter"]["options"]["headers"],
            json!({ "X-Title": "app" })
        );
        assert_eq!(carried["disabled_providers"], json!(["openai"]));
    }

    #[test]
    fn finds_the_global_config_like_opencode_does() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| OsString::from(value))
            }
        };
        let unix = config_files(env(&[("HOME", "/home/me")]), false);
        let windows = config_files(
            env(&[
                ("USERPROFILE", "C:/Users/me"),
                ("HOME", "/c/Users/me"),
                ("OPENCODE_CONFIG", "D:/cfg/opencode.json"),
            ]),
            true,
        );
        let xdg = config_files(env(&[("XDG_CONFIG_HOME", "/xdg"), ("HOME", "/h")]), false);

        assert_eq!(
            unix,
            ["config.json", "opencode.json", "opencode.jsonc"]
                .map(|file| PathBuf::from("/home/me/.config/opencode").join(file))
        );
        assert_eq!(
            windows[1],
            PathBuf::from("C:/Users/me/.config/opencode/opencode.json")
        );
        assert_eq!(windows[3], PathBuf::from("D:/cfg/opencode.json"));
        assert_eq!(xdg[0], PathBuf::from("/xdg/opencode/config.json"));
    }
}
