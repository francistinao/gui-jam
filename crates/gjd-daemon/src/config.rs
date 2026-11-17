use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use gjd_providers::ProviderId;

const NO_CONFIG_DIR: &str = if cfg!(windows) {
    "neither XDG_CONFIG_HOME nor APPDATA is set"
} else {
    "neither XDG_CONFIG_HOME nor HOME is set"
};

#[must_use]
pub fn config_path() -> Option<PathBuf> {
    config_path_from(|name| std::env::var_os(name), cfg!(windows))
}

fn config_path_from(var: impl Fn(&str) -> Option<OsString>, windows: bool) -> Option<PathBuf> {
    let dir = |name| var(name).filter(|dir| !dir.is_empty()).map(PathBuf::from);
    let base = dir("XDG_CONFIG_HOME").or_else(|| {
        if windows {
            dir("APPDATA")
        } else {
            dir("HOME").map(|home| home.join(".config"))
        }
    })?;
    Some(base.join("guijam").join("config.toml"))
}

fn read_table(path: &Path) -> io::Result<toml::Table> {
    match std::fs::read_to_string(path) {
        Ok(text) => text.parse::<toml::Table>().map_err(io::Error::other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(toml::Table::new()),
        Err(error) => Err(error),
    }
}

#[must_use]
pub fn active_provider_in(path: &Path) -> Option<ProviderId> {
    let table = read_table(path).ok()?;
    let active = table.get("providers")?.get("active")?.as_str()?;
    ProviderId::from_str(active).ok()
}

#[must_use]
pub fn provider_model_in(path: &Path, id: ProviderId) -> Option<String> {
    let table = read_table(path).ok()?;
    let model = table
        .get("providers")?
        .get(id.as_str())?
        .get("model")?
        .as_str()?;
    (!model.trim().is_empty()).then(|| model.to_owned())
}

pub fn set_active_provider_in(path: &Path, id: ProviderId, model: Option<&str>) -> io::Result<()> {
    let mut table = read_table(path)?;
    let providers = table
        .entry("providers")
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    let toml::Value::Table(providers) = providers else {
        return Err(io::Error::other(format!(
            "{}: [providers] is not a table",
            path.display()
        )));
    };
    providers.insert(
        "active".to_owned(),
        toml::Value::String(id.as_str().to_owned()),
    );
    if let Some(model) = model {
        let entry = providers
            .entry(id.as_str())
            .or_insert_with(|| toml::Value::Table(toml::Table::new()));
        let toml::Value::Table(entry) = entry else {
            return Err(io::Error::other(format!(
                "{}: [providers.{}] is not a table",
                path.display(),
                id.as_str()
            )));
        };
        entry.insert("model".to_owned(), toml::Value::String(model.to_owned()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, toml::to_string(&table).map_err(io::Error::other)?)
}

#[must_use]
pub fn active_provider() -> Option<ProviderId> {
    config_path().and_then(|path| active_provider_in(&path))
}

#[must_use]
pub fn provider_model(id: ProviderId) -> Option<String> {
    config_path().and_then(|path| provider_model_in(&path, id))
}

pub fn set_active_provider(id: ProviderId, model: Option<&str>) -> io::Result<PathBuf> {
    let path = config_path().ok_or_else(|| io::Error::other(NO_CONFIG_DIR))?;
    set_active_provider_in(&path, id, model)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use gjd_providers::ProviderId;

    use std::ffi::OsString;
    use std::path::PathBuf;

    use super::{active_provider_in, config_path_from, provider_model_in, set_active_provider_in};

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let pairs: Vec<(String, OsString)> = pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), OsString::from(value)))
            .collect();
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        }
    }

    #[test]
    fn the_config_lives_under_xdg_then_the_platform_default() {
        let file = |base: &str| Some(PathBuf::from(base).join("guijam").join("config.toml"));
        let everything = env(&[
            ("XDG_CONFIG_HOME", "/xdg"),
            ("HOME", "/home/me"),
            ("APPDATA", "/roaming"),
        ]);
        assert_eq!(config_path_from(&everything, false), file("/xdg"));
        assert_eq!(config_path_from(&everything, true), file("/xdg"));

        let defaults = env(&[
            ("XDG_CONFIG_HOME", ""),
            ("HOME", "/home/me"),
            ("APPDATA", "/roaming"),
        ]);
        assert_eq!(config_path_from(&defaults, false), file("/home/me/.config"));
        assert_eq!(config_path_from(&defaults, true), file("/roaming"));

        let bare = env(&[("HOME", "/home/me")]);
        assert_eq!(config_path_from(&bare, true), None);
        assert_eq!(config_path_from(env(&[]), false), None);
    }

    #[test]
    fn saves_the_active_provider_and_keeps_other_settings() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("guijam/config.toml");
        assert_eq!(active_provider_in(&path), None);

        fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        fs::write(&path, "[widget]\nshortcut = \"Alt+Shift+G\"\n").expect("seed");
        set_active_provider_in(&path, ProviderId::Codex, None).expect("saved");

        assert_eq!(active_provider_in(&path), Some(ProviderId::Codex));
        let text = fs::read_to_string(&path).expect("read");
        assert!(text.contains("shortcut = \"Alt+Shift+G\""), "{text}");
        assert!(text.contains("active = \"codex\""), "{text}");
        assert_eq!(provider_model_in(&path, ProviderId::Codex), None);

        set_active_provider_in(&path, ProviderId::OpenCode, Some("deepseek/deepseek-chat"))
            .expect("saved with a model");

        assert_eq!(active_provider_in(&path), Some(ProviderId::OpenCode));
        assert_eq!(
            provider_model_in(&path, ProviderId::OpenCode).as_deref(),
            Some("deepseek/deepseek-chat")
        );
        let text = fs::read_to_string(&path).expect("read");
        assert!(text.contains("shortcut = \"Alt+Shift+G\""), "{text}");
    }

    #[test]
    fn ignores_unknown_providers_and_broken_files() {
        let dir = tempfile::tempdir().expect("temp dir");
        let unknown = dir.path().join("unknown.toml");
        fs::write(&unknown, "[providers]\nactive = \"nobody\"\n").expect("write");
        let broken = dir.path().join("broken.toml");
        fs::write(&broken, "[providers\n").expect("write");

        assert_eq!(active_provider_in(&unknown), None);
        assert_eq!(active_provider_in(&broken), None);
    }
}
