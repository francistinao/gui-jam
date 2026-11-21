use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};

use super::bridge::{self, Bridge};
use super::credentials::{self, Site};
use super::pairing;

const IMAGE_BYTES: u64 = 6 * 1024 * 1024;

fn settings() -> Result<PathBuf, String> {
    credentials::path().ok_or_else(|| "Can't find your home folder to save the pairing.".to_owned())
}

fn bridge_of(site: &Site) -> Result<Bridge, String> {
    Bridge::new(&site.url, site.token.clone()).map_err(|error| error.to_string())
}

fn chosen(path: &Path, host: Option<&str>) -> Result<Site, String> {
    let sites = credentials::sites_in(path).map_err(|error| error.to_string())?;
    match host {
        Some(host) => sites
            .into_iter()
            .find(|site| site.host == host)
            .ok_or_else(|| format!("{host} isn't paired with GUIJam.")),
        None => sites.into_iter().next().ok_or_else(|| {
            "No Jira site is paired with GUIJam. Run npx guijam jira pair <code>.".to_owned()
        }),
    }
}

pub fn pair(code: &str) -> Result<String, String> {
    pair_in(&settings()?, code)
}

pub fn pair_in(path: &Path, code: &str) -> Result<String, String> {
    let pairing = pairing::decode(code).map_err(|error| error.to_string())?;
    let bridge =
        Bridge::new(&pairing.url, pairing.token.clone()).map_err(|error| error.to_string())?;
    let whoami = bridge
        .whoami(bridge::NORMAL)
        .map_err(|error| format!("Jira didn't accept the pairing code: {error}"))?;
    credentials::save_in(
        path,
        &Site {
            host: whoami.site.clone(),
            url: pairing.url,
            token: pairing.token,
            account: whoami.display_name.clone(),
        },
    )
    .map_err(|error| format!("Couldn't save the pairing: {error}"))?;
    Ok(format!(
        "Paired with {} as {}. GUIJam can now link your changes to Jira tickets.",
        whoami.site, whoami.display_name
    ))
}

pub fn status(json_output: bool) -> Result<String, String> {
    status_in(&settings()?, json_output)
}

pub fn status_in(path: &Path, json_output: bool) -> Result<String, String> {
    let sites = credentials::sites_in(path).map_err(|error| error.to_string())?;
    let checked: Vec<(Site, Result<String, String>)> = sites
        .into_iter()
        .map(|site| {
            let answer = bridge_of(&site).and_then(|bridge| {
                bridge
                    .whoami(bridge::QUICK)
                    .map(|whoami| whoami.display_name)
                    .map_err(|error| error.to_string())
            });
            (site, answer)
        })
        .collect();
    if json_output {
        let rows: Vec<Value> = checked
            .iter()
            .map(|(site, answer)| match answer {
                Ok(account) => json!({ "site": site.host, "account": account, "ok": true }),
                Err(error) => {
                    json!({ "site": site.host, "account": site.account, "ok": false, "error": error })
                }
            })
            .collect();
        return Ok(Value::Array(rows).to_string());
    }
    if checked.is_empty() {
        return Ok("No Jira site is paired. Run npx guijam jira pair <code>.".to_owned());
    }
    Ok(checked
        .iter()
        .map(|(site, answer)| match answer {
            Ok(account) => format!("{}: paired as {account}", site.host),
            Err(error) => format!("{}: {error}", site.host),
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

pub fn unpair(host: Option<&str>) -> Result<String, String> {
    unpair_in(&settings()?, host)
}

pub fn unpair_in(path: &Path, host: Option<&str>) -> Result<String, String> {
    let sites: Vec<Site> = credentials::sites_in(path)
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|site| host.is_none_or(|host| site.host == host))
        .collect();
    if sites.is_empty() {
        return Err(match host {
            Some(host) => format!("{host} isn't paired with GUIJam."),
            None => "No Jira site is paired with GUIJam.".to_owned(),
        });
    }
    let mut lines = Vec::new();
    for site in &sites {
        let revoked =
            bridge_of(site).and_then(|bridge| bridge.unpair().map_err(|error| error.to_string()));
        lines.push(match revoked {
            Ok(_) => format!("Unpaired {} and revoked this device in Jira.", site.host),
            Err(error) => format!(
                "Unpaired {} here. Jira couldn't revoke it ({error}); revoke it from a ticket's GUIJam panel.",
                site.host
            ),
        });
        credentials::remove_in(path, Some(&site.host)).map_err(|error| error.to_string())?;
    }
    Ok(lines.join("\n"))
}

pub fn test(host: Option<&str>) -> Result<String, String> {
    let site = chosen(&settings()?, host)?;
    let bridge = bridge_of(&site)?;
    let whoami = bridge
        .whoami(bridge::NORMAL)
        .map_err(|error| error.to_string())?;
    let page = bridge
        .search("assigned", "")
        .map_err(|error| error.to_string())?;
    Ok(format!(
        "Connected to {} as {}. {} open tickets are assigned to you.",
        whoami.site,
        whoami.display_name,
        page.tickets.len()
    ))
}

pub struct NewTicket<'a> {
    pub site: Option<&'a str>,
    pub project: &'a str,
    pub summary: &'a str,
    pub description: &'a str,
    pub image: Option<&'a Path>,
    pub page_url: &'a str,
    pub src: &'a str,
}

pub fn create(ticket: &NewTicket<'_>) -> Result<String, String> {
    let site = chosen(&settings()?, ticket.site)?;
    let mut body = json!({
        "project": ticket.project,
        "summary": ticket.summary,
        "description": ticket.description,
        "pageUrl": ticket.page_url,
        "src": ticket.src,
    });
    if let Some(image) = ticket.image {
        body["image"] = screenshot(image)?;
    }
    let created = bridge_of(&site)?
        .create(&body)
        .map_err(|error| error.to_string())?;
    Ok(format!("Created {}: {}", created.key, created.url))
}

fn screenshot(path: &Path) -> Result<Value, String> {
    let media_type = match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        _ => return Err("The image must be a .png or .jpg file.".to_owned()),
    };
    let bytes_on_disk = std::fs::metadata(path)
        .map_err(|error| format!("Can't read {}: {error}", path.display()))?
        .len();
    if bytes_on_disk > IMAGE_BYTES {
        return Err(format!("{} is larger than 6 MB.", path.display()));
    }
    let bytes =
        std::fs::read(path).map_err(|error| format!("Can't read {}: {error}", path.display()))?;
    Ok(json!({ "mediaType": media_type, "base64": STANDARD.encode(bytes) }))
}
