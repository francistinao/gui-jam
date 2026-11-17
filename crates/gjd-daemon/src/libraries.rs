use std::fmt::Write as _;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::project::{Project, Ui};

pub const MIN_AGE_DAYS: i64 = 14;
const SECONDS_PER_DAY: u64 = 86_400;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Library {
    pub name: &'static str,
    pub react_only: bool,
    pub purpose: &'static str,
}

pub const LIBRARIES: [Library; 6] = [
    Library {
        name: "three",
        react_only: false,
        purpose: "3D scenes",
    },
    Library {
        name: "@react-three/fiber",
        react_only: true,
        purpose: "three.js as React components",
    },
    Library {
        name: "@react-three/drei",
        react_only: true,
        purpose: "ready-made helpers for @react-three/fiber",
    },
    Library {
        name: "motion",
        react_only: false,
        purpose: "spring, gesture and layout animation (Framer Motion)",
    },
    Library {
        name: "gsap",
        react_only: false,
        purpose: "timelines and choreographed page transitions",
    },
    Library {
        name: "@gsap/react",
        react_only: true,
        purpose: "the useGSAP hook for GSAP in React",
    },
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Need {
    pub name: String,
    pub version: String,
}

fn leading_number(text: &str) -> Option<u64> {
    let digits: String = text
        .trim_start_matches(|c: char| !c.is_ascii_digit())
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

#[must_use]
pub fn react_major(project: &Project) -> Option<u64> {
    project
        .dependencies
        .get("react")
        .and_then(|range| leading_number(range))
}

#[must_use]
pub fn major_for(name: &str, project: &Project) -> Option<Option<u64>> {
    match name {
        "@react-three/fiber" => match react_major(project)? {
            19 => Some(Some(9)),
            18 => Some(Some(8)),
            _ => None,
        },
        "@react-three/drei" => match react_major(project)? {
            19 => Some(Some(10)),
            18 => Some(Some(9)),
            _ => None,
        },
        _ => Some(None),
    }
}

#[must_use]
pub fn allowed(project: &Project) -> Vec<Library> {
    if project.dependencies.is_empty() {
        return Vec::new();
    }
    LIBRARIES
        .iter()
        .filter(|library| !library.react_only || project.ui == Ui::React)
        .filter(|library| major_for(library.name, project).is_some())
        .copied()
        .collect()
}

#[must_use]
pub fn package_of(specifier: &str) -> Option<&str> {
    let skipped = [
        "node:", "virtual:", "data:", "http:", "https:", "/", ".", "~", "#", "\0",
    ];
    if specifier.is_empty() || skipped.iter().any(|prefix| specifier.starts_with(prefix)) {
        return None;
    }
    let mut parts = specifier.splitn(3, '/');
    let first = parts.next()?;
    if let Some(scope) = first.strip_prefix('@') {
        let name = parts.next()?;
        if scope.is_empty() || name.is_empty() {
            return None;
        }
        return Some(&specifier[..first.len() + 1 + name.len()]);
    }
    Some(first)
}

fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    if text.contains(['-', '+']) {
        return None;
    }
    let mut parts = text.split('.').map(str::parse::<u64>);
    let version = (
        parts.next()?.ok()?,
        parts.next()?.ok()?,
        parts.next()?.ok()?,
    );
    parts.next().is_none().then_some(version)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[must_use]
pub fn day_of(timestamp: &str) -> Option<i64> {
    let date = timestamp.get(..10)?;
    let mut parts = date.split('-').map(str::parse::<i64>);
    let (year, month, day) = (
        parts.next()?.ok()?,
        parts.next()?.ok()?,
        parts.next()?.ok()?,
    );
    ((1..=12).contains(&month) && (1..=31).contains(&day))
        .then(|| days_from_civil(year, month, day))
}

#[must_use]
pub fn today() -> i64 {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    i64::try_from(seconds / SECONDS_PER_DAY).unwrap_or(i64::MAX)
}

#[must_use]
pub fn choose_version(times: &Value, major: Option<u64>, today: i64) -> Option<String> {
    times
        .as_object()?
        .iter()
        .filter_map(|(version, published)| {
            let parsed = parse_version(version)?;
            let day = day_of(published.as_str()?)?;
            let old_enough = today - day >= MIN_AGE_DAYS;
            let in_range = major.is_none_or(|major| parsed.0 == major);
            (old_enough && in_range).then_some((parsed, version))
        })
        .max_by_key(|(parsed, _)| *parsed)
        .map(|(_, version)| version.clone())
}

#[must_use]
pub fn prompt_section(project: &Project) -> String {
    let allowed = allowed(project);
    if allowed.is_empty() {
        return String::new();
    }
    let installed: Vec<String> = LIBRARIES
        .iter()
        .filter_map(|library| {
            project
                .dependencies
                .get(library.name)
                .map(|version| format!("{}@{version}", library.name))
        })
        .collect();
    let mut out = format!(
        "\n<libraries installed=\"{}\">\nUse these only when the request needs them: 3D, physics-like or gesture motion, \
or choreographed page transitions. Use CSS transitions and keyframes for simple hovers and fades. \
You may import one that isn't installed yet; GUIJam asks the developer to install it before \
previewing. Don't import any other package that isn't installed.\n",
        installed.join(", ")
    );
    for library in allowed {
        let _ = writeln!(out, "- {}: {}", library.name, library.purpose);
    }
    out.push_str("</libraries>\n");
    out
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::{
        allowed, choose_version, day_of, major_for, package_of, parse_version, prompt_section,
        react_major,
    };
    use crate::project::{PackageManager, Project, Ui};

    fn project(ui: Ui, dependencies: &[(&str, &str)]) -> Project {
        Project {
            ui,
            typescript: true,
            dependencies: dependencies
                .iter()
                .map(|(name, version)| ((*name).to_owned(), (*version).to_owned()))
                .collect::<BTreeMap<_, _>>(),
            package_manager: PackageManager::Pnpm,
            components: "src/components".to_owned(),
        }
    }

    fn names(project: &Project) -> Vec<&'static str> {
        allowed(project)
            .iter()
            .map(|library| library.name)
            .collect()
    }

    #[test]
    fn offers_react_bindings_only_to_react_projects_with_a_known_major() {
        let react19 = project(Ui::React, &[("react", "^19.3.1")]);
        assert_eq!(react_major(&react19), Some(19));
        assert_eq!(names(&react19).len(), 6);
        assert_eq!(major_for("@react-three/fiber", &react19), Some(Some(9)));
        assert_eq!(major_for("@react-three/drei", &react19), Some(Some(10)));
        assert_eq!(major_for("three", &react19), Some(None));

        let react18 = project(Ui::React, &[("react", "~18.2.0")]);
        assert_eq!(major_for("@react-three/fiber", &react18), Some(Some(8)));
        assert_eq!(major_for("@react-three/drei", &react18), Some(Some(9)));

        let react17 = project(Ui::React, &[("react", "17.0.2")]);
        assert_eq!(names(&react17), ["three", "motion", "gsap", "@gsap/react"]);

        let vanilla = project(Ui::None, &[("vite", "8.3.8")]);
        assert_eq!(names(&vanilla), ["three", "motion", "gsap"]);
        let vue = project(Ui::Vue, &[("vue", "3.5.0")]);
        assert_eq!(names(&vue), ["three", "motion", "gsap"]);
        assert_eq!(names(&project(Ui::None, &[])), Vec::<&str>::new());
    }

    #[test]
    fn reads_the_package_name_from_a_bare_import() {
        let cases = [
            ("three", Some("three")),
            (
                "three/examples/jsm/controls/OrbitControls.js",
                Some("three"),
            ),
            ("@react-three/fiber", Some("@react-three/fiber")),
            ("@react-three/drei/core/Text", Some("@react-three/drei")),
            ("motion/react", Some("motion")),
            ("./Button", None),
            ("../atoms/Price", None),
            ("/src/x", None),
            ("node:path", None),
            ("virtual:guijam/client", None),
            ("~icons/mdi/home", None),
            ("#internal", None),
            ("@/components/Button", None),
            ("@scope", None),
            ("", None),
        ];
        for (specifier, expected) in cases {
            assert_eq!(package_of(specifier), expected, "{specifier}");
        }
    }

    #[test]
    fn parses_stable_versions_and_dates() {
        assert_eq!(parse_version("0.187.0"), Some((0, 187, 0)));
        assert_eq!(parse_version("10.7.9"), Some((10, 7, 9)));
        for unstable in [
            "0.54.0-dev",
            "1.0.0-beta.1",
            "1.0.0+build",
            "1.0",
            "1.0.0.0",
            "x.y.z",
            "created",
        ] {
            assert_eq!(parse_version(unstable), None, "{unstable}");
        }
        assert_eq!(day_of("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(day_of("2026-11-17T08:09:24.667Z"), Some(20_774));
        assert_eq!(day_of("2024-02-29T00:00:00Z"), Some(19_782));
        assert_eq!(day_of("2026-13-01"), None);
        assert_eq!(day_of("soon"), None);
    }

    #[test]
    fn picks_the_newest_stable_version_at_least_two_weeks_old_in_range() {
        let times = json!({
            "created": "2012-12-07T19:51:25.349Z",
            "modified": "2026-11-13T08:09:24.667Z",
            "8.18.0": "2025-03-01T00:00:00.000Z",
            "9.8.0": "2026-09-22T00:00:00.000Z",
            "9.8.2": "2026-10-14T00:00:00.000Z",
            "9.9.0": "2026-11-10T00:00:00.000Z",
            "10.0.0-alpha.1": "2026-08-01T00:00:00.000Z",
            "10.0.0": "2026-11-15T00:00:00.000Z",
        });
        let today = day_of("2026-11-17").expect("today");

        assert_eq!(
            choose_version(&times, Some(9), today).as_deref(),
            Some("9.8.2")
        );
        assert_eq!(
            choose_version(&times, None, today).as_deref(),
            Some("9.8.2")
        );
        assert_eq!(
            choose_version(&times, Some(8), today).as_deref(),
            Some("8.18.0")
        );
        assert_eq!(choose_version(&times, Some(11), today), None);
        assert_eq!(
            choose_version(&times, None, day_of("2026-12-01").expect("later")).as_deref(),
            Some("10.0.0")
        );
        assert_eq!(choose_version(&json!("not an object"), None, today), None);
    }

    #[test]
    fn the_prompt_lists_what_is_installed_and_what_may_be_added() {
        let section = prompt_section(&project(
            Ui::React,
            &[("react", "19.3.1"), ("gsap", "3.15.0")],
        ));
        assert!(
            section.starts_with("\n<libraries installed=\"gsap@3.15.0\">\n"),
            "{section}"
        );
        assert!(
            section.contains("- @react-three/fiber: three.js as React components\n"),
            "{section}"
        );
        assert!(
            section.contains("Use CSS transitions and keyframes for simple hovers and fades."),
            "{section}"
        );
        assert_eq!(prompt_section(&project(Ui::None, &[])), "");
    }
}
