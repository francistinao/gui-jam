use std::io;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use gjd_providers::ProviderId;

#[must_use]
pub fn config_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
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

pub fn set_active_provider_in(path: &Path, id: ProviderId) -> io::Result<()> {
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
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, toml::to_string(&table).map_err(io::Error::other)?)
}

#[must_use]
pub fn active_provider() -> Option<ProviderId> {
    config_path().and_then(|path| active_provider_in(&path))
}

pub fn set_active_provider(id: ProviderId) -> io::Result<PathBuf> {
    let path =
        config_path().ok_or_else(|| io::Error::other("neither XDG_CONFIG_HOME nor HOME is set"))?;
    set_active_provider_in(&path, id)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use gjd_providers::ProviderId;

    use super::{active_provider_in, set_active_provider_in};

    #[test]
    fn saves_the_active_provider_and_keeps_other_settings() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("guijam/config.toml");
        assert_eq!(active_provider_in(&path), None);

        fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        fs::write(&path, "[widget]\nshortcut = \"Alt+Shift+G\"\n").expect("seed");
        set_active_provider_in(&path, ProviderId::Codex).expect("saved");

        assert_eq!(active_provider_in(&path), Some(ProviderId::Codex));
        let text = fs::read_to_string(&path).expect("read");
        assert!(text.contains("shortcut = \"Alt+Shift+G\""), "{text}");
        assert!(text.contains("active = \"codex\""), "{text}");
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
