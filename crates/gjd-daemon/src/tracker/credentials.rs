use std::fmt;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::config;

const FILE_NAME: &str = "trackers.toml";

#[derive(Clone, PartialEq, Eq)]
pub struct Site {
    pub host: String,
    pub url: String,
    pub token: String,
    pub account: String,
}

impl fmt::Debug for Site {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Site")
            .field("host", &self.host)
            .field("account", &self.account)
            .finish_non_exhaustive()
    }
}

#[must_use]
pub fn path() -> Option<PathBuf> {
    config::config_path().map(|config| config.with_file_name(FILE_NAME))
}

fn read_table(path: &Path) -> io::Result<toml::Table> {
    match fs::read_to_string(path) {
        Ok(text) => text.parse::<toml::Table>().map_err(io::Error::other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(toml::Table::new()),
        Err(error) => Err(error),
    }
}

pub fn sites_in(path: &Path) -> io::Result<Vec<Site>> {
    let table = read_table(path)?;
    let Some(jira) = table.get("jira").and_then(toml::Value::as_table) else {
        return Ok(Vec::new());
    };
    Ok(jira
        .iter()
        .filter_map(|(host, value)| {
            let entry = value.as_table()?;
            let text = |key: &str| entry.get(key).and_then(toml::Value::as_str);
            Some(Site {
                host: host.clone(),
                url: text("url")?.to_owned(),
                token: text("token")?.to_owned(),
                account: text("account").unwrap_or_default().to_owned(),
            })
        })
        .collect())
}

pub fn save_in(path: &Path, site: &Site) -> io::Result<()> {
    let mut table = read_table(path)?;
    let jira = table
        .entry("jira")
        .or_insert_with(|| toml::Value::Table(toml::Table::new()))
        .as_table_mut()
        .ok_or_else(|| io::Error::other("[jira] in trackers.toml is not a table"))?;
    let mut entry = toml::Table::new();
    entry.insert("url".to_owned(), site.url.clone().into());
    entry.insert("token".to_owned(), site.token.clone().into());
    entry.insert("account".to_owned(), site.account.clone().into());
    jira.insert(site.host.clone(), toml::Value::Table(entry));
    write_private(path, &toml::to_string(&table).map_err(io::Error::other)?)
}

pub fn remove_in(path: &Path, host: Option<&str>) -> io::Result<Vec<Site>> {
    let removed: Vec<Site> = sites_in(path)?
        .into_iter()
        .filter(|site| host.is_none_or(|host| site.host == host))
        .collect();
    if removed.is_empty() {
        return Ok(removed);
    }
    let mut table = read_table(path)?;
    if let Some(jira) = table.get_mut("jira").and_then(toml::Value::as_table_mut) {
        for site in &removed {
            jira.remove(&site.host);
        }
    }
    write_private(path, &toml::to_string(&table).map_err(io::Error::other)?)?;
    Ok(removed)
}

fn write_private(path: &Path, text: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        let mut builder = DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(dir)?;
    }
    let temp = path.with_file_name(format!("{FILE_NAME}.{}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    fs::rename(temp, path)
}

#[cfg(test)]
mod tests {
    use super::{Site, remove_in, save_in, sites_in};

    fn site(host: &str) -> Site {
        Site {
            host: host.to_owned(),
            url: format!("https://{host}.webtrigger.example/public/x"),
            token: "secret-token-value".to_owned(),
            account: "Francis".to_owned(),
        }
    }

    #[test]
    fn saves_sites_privately_and_keeps_other_settings() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("guijam").join("trackers.toml");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(&path, "[github]\nuser = \"me\"\n").expect("seed");

        save_in(&path, &site("acme.atlassian.net")).expect("save");
        save_in(&path, &site("beta.atlassian.net")).expect("save");

        assert_eq!(
            sites_in(&path).expect("read"),
            vec![site("acme.atlassian.net"), site("beta.atlassian.net")]
        );
        let text = std::fs::read_to_string(&path).expect("text");
        assert!(text.contains("[github]") && text.contains("user = \"me\""));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).expect("meta").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn removes_one_site_or_every_site() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("trackers.toml");
        save_in(&path, &site("acme.atlassian.net")).expect("save");
        save_in(&path, &site("beta.atlassian.net")).expect("save");

        let removed = remove_in(&path, Some("acme.atlassian.net")).expect("remove");
        assert_eq!(removed, vec![site("acme.atlassian.net")]);
        assert_eq!(
            sites_in(&path).expect("read"),
            vec![site("beta.atlassian.net")]
        );
        assert_eq!(remove_in(&path, Some("nope")).expect("remove"), Vec::new());
        assert_eq!(remove_in(&path, None).expect("remove").len(), 1);
        assert_eq!(sites_in(&path).expect("read"), Vec::new());
    }

    #[test]
    fn a_missing_file_has_no_sites_and_debug_hides_the_token() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            sites_in(&dir.path().join("none.toml")).expect("read"),
            Vec::new()
        );
        assert!(!format!("{:?}", site("acme.atlassian.net")).contains("secret-token-value"));
    }
}
