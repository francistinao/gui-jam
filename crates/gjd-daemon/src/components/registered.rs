use std::collections::BTreeMap;

use gjd_core::components::pascal_name;

const NUXT_DIRS: [&str; 2] = ["app/components/", "components/"];
const UNPLUGIN_DIR: &str = "src/components/";
const GLOBAL_DIR: &str = "global";
const REGISTRATION: &str = ".component(";
const ENTRY_FILES: [&str; 4] = ["src/main.ts", "src/main.js", "src/main.mts", "src/app.ts"];
const PLUGIN_DIR: &str = "src/plugins/";
const SFC_EXTENSIONS: [&str; 3] = ["vue", "svelte", "astro"];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rules {
    pub nuxt: bool,
    pub unplugin: bool,
}

impl Rules {
    #[must_use]
    pub fn from_dependencies(dependencies: &BTreeMap<String, String>) -> Self {
        Self {
            nuxt: dependencies.contains_key("nuxt"),
            unplugin: dependencies.contains_key("unplugin-vue-components"),
        }
    }

    #[must_use]
    pub fn auto_name(self, path: &str) -> Option<String> {
        if self.nuxt
            && let Some(name) = nuxt_name(path)
        {
            return Some(name);
        }
        if self.unplugin {
            return unplugin_name(path);
        }
        None
    }
}

fn is_sfc(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, extension)| {
        SFC_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
    })
}

fn stem(file: &str) -> &str {
    file.split_once('.').map_or(file, |(stem, _)| stem)
}

#[must_use]
pub fn nuxt_name(path: &str) -> Option<String> {
    if !is_sfc(path) {
        return None;
    }
    let rest = NUXT_DIRS.iter().find_map(|dir| path.strip_prefix(dir))?;
    let mut segments: Vec<&str> = rest.split('/').collect();
    let file = segments.pop()?;
    if segments.first() == Some(&GLOBAL_DIR) {
        segments.remove(0);
    }
    let prefix: String = segments
        .iter()
        .filter_map(|segment| pascal_name(segment))
        .collect();
    let own = stem(file);
    if own == "index" {
        return (!prefix.is_empty()).then_some(prefix);
    }
    let own = pascal_name(own)?;
    if own.starts_with(&prefix) {
        Some(own)
    } else {
        Some(format!("{prefix}{own}"))
    }
}

#[must_use]
pub fn unplugin_name(path: &str) -> Option<String> {
    if !is_sfc(path) {
        return None;
    }
    let rest = path.strip_prefix(UNPLUGIN_DIR)?;
    pascal_name(stem(rest.rsplit('/').next()?))
}

#[must_use]
pub fn is_registration_file(path: &str) -> bool {
    ENTRY_FILES.contains(&path) || path.starts_with(PLUGIN_DIR)
}

fn identifier(text: &str) -> &str {
    let end = text
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'))
        .unwrap_or(text.len());
    &text[..end]
}

#[must_use]
pub fn registrations(source: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    for (at, _) in source.match_indices(REGISTRATION) {
        let rest = source[at + REGISTRATION.len()..].trim_start();
        let Some(quote) = rest
            .chars()
            .next()
            .filter(|c| matches!(c, '\'' | '"' | '`'))
        else {
            continue;
        };
        let rest = &rest[1..];
        let Some(end) = rest.find(quote) else {
            continue;
        };
        let tag = &rest[..end];
        let Some(local) = rest[end + 1..].trim_start().strip_prefix(',') else {
            continue;
        };
        let local = identifier(local.trim_start());
        if !tag.is_empty() && !local.is_empty() {
            found.push((tag.to_owned(), local.to_owned()));
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{Rules, is_registration_file, nuxt_name, registrations, unplugin_name};

    #[test]
    fn names_nuxt_components_by_their_folders_like_nuxt_does() {
        let cases = [
            ("components/ErrorMessage.vue", Some("ErrorMessage")),
            ("components/base/foo/Button.vue", Some("BaseFooButton")),
            ("components/base/BaseButton.vue", Some("BaseButton")),
            ("components/form/error-text.vue", Some("FormErrorText")),
            ("components/global/Alert.vue", Some("Alert")),
            ("components/card/index.vue", Some("Card")),
            ("app/components/ui/Callout.vue", Some("UiCallout")),
            ("components/helpers.ts", None),
            ("pages/index.vue", None),
        ];
        for (path, name) in cases {
            assert_eq!(nuxt_name(path).as_deref(), name, "{path}");
        }
    }

    #[test]
    fn names_auto_imported_vue_components_by_their_file() {
        assert_eq!(
            unplugin_name("src/components/forms/ErrorMessage.vue").as_deref(),
            Some("ErrorMessage")
        );
        assert_eq!(unplugin_name("src/views/Home.vue"), None);
    }

    #[test]
    fn applies_only_the_rules_the_project_installs() {
        let nuxt: BTreeMap<String, String> = [("nuxt".to_owned(), "4.2.0".to_owned())].into();
        let none = BTreeMap::new();

        assert_eq!(
            Rules::from_dependencies(&nuxt)
                .auto_name("components/base/Button.vue")
                .as_deref(),
            Some("BaseButton")
        );
        assert_eq!(
            Rules::from_dependencies(&none).auto_name("components/base/Button.vue"),
            None
        );
    }

    #[test]
    fn reads_app_component_registrations() {
        let source = "import { createApp } from 'vue';\nimport BaseButton from './components/BaseButton.vue';\nimport ErrorText from './components/ErrorText.vue';\nconst app = createApp(App);\napp.component('BaseButton', BaseButton)\n  .component(\"ErrorText\", ErrorText);\napp.component(`Broken`);\n";

        assert_eq!(
            registrations(source),
            [
                ("BaseButton".to_owned(), "BaseButton".to_owned()),
                ("ErrorText".to_owned(), "ErrorText".to_owned()),
            ]
        );
        assert!(is_registration_file("src/main.ts"));
        assert!(is_registration_file("src/plugins/ui.ts"));
        assert!(!is_registration_file("src/App.vue"));
    }
}
