#[cfg(windows)]
use std::ffi::OsStr;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Shim {
    pub(crate) program: PathBuf,
    pub(crate) args: Vec<OsString>,
    pub(crate) node_path: Option<String>,
}

#[cfg(windows)]
pub(crate) fn batch_shim(program: &Path) -> Option<Shim> {
    let batch = program
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        });
    if !batch {
        return None;
    }
    let text = std::fs::read_to_string(program).ok()?;
    parse_shim(&text, program.parent()?, Path::is_file, |name| {
        which::which(name).ok()
    })
}

fn parse_shim(
    text: &str,
    dir: &Path,
    is_file: impl Fn(&Path) -> bool,
    lookup: impl Fn(&str) -> Option<PathBuf>,
) -> Option<Shim> {
    let mut progs = Vec::new();
    let mut node_path = None;
    for line in text.lines() {
        let line = line.trim().trim_start_matches('@');
        let Some(assignment) = line
            .get(..4)
            .filter(|keyword| keyword.eq_ignore_ascii_case("set "))
            .map(|_| line[4..].trim().trim_matches('"'))
        else {
            continue;
        };
        let (name, value) = assignment.split_once('=')?;
        match name.to_ascii_uppercase().as_str() {
            "_PROG" => progs.push(value),
            "NODE_PATH" if !value.contains('%') => node_path = Some(value.to_owned()),
            "DP0" | "PATHEXT" | "NODE_PATH" => {}
            _ => return None,
        }
    }
    let expand = |token: &str| -> Option<OsString> {
        if token.eq_ignore_ascii_case("%_prog%") {
            return progs
                .iter()
                .find_map(|prog| shim_path(prog, dir, &is_file, &lookup));
        }
        if token.starts_with('-') && !token.contains('%') {
            return Some(OsString::from(token));
        }
        shim_path(token, dir, &is_file, &lookup)
    };
    text.lines()
        .filter_map(|line| line.split_once("%*").map(|(before, _)| before))
        .find_map(|before| {
            let segment = before.rsplit(['&', '|']).next()?;
            let mut tokens = shim_tokens(segment).into_iter().map(|token| expand(&token));
            let program = PathBuf::from(tokens.next()??);
            let args = tokens.collect::<Option<Vec<_>>>()?;
            Some(Shim {
                program,
                args,
                node_path: node_path.clone(),
            })
        })
}

fn shim_tokens(segment: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut rest = segment.trim().trim_start_matches('@');
    while let Some(start) = rest.find(|c: char| !c.is_whitespace()) {
        rest = &rest[start..];
        let (token, after) = match rest.strip_prefix('"') {
            Some(quoted) => quoted.split_once('"').unwrap_or((quoted, "")),
            None => rest.split_at(rest.find(char::is_whitespace).unwrap_or(rest.len())),
        };
        if token != "(" && token != ")" {
            tokens.push(token.to_owned());
        }
        rest = after;
    }
    tokens
}

fn shim_path(
    token: &str,
    dir: &Path,
    is_file: &impl Fn(&Path) -> bool,
    lookup: &impl Fn(&str) -> Option<PathBuf>,
) -> Option<OsString> {
    let relative = ["%~dp0", "%dp0%"].iter().find_map(|variable| {
        token
            .get(..variable.len())
            .filter(|start| start.eq_ignore_ascii_case(variable))
            .map(|_| &token[variable.len()..])
    });
    if let Some(relative) = relative {
        let mut path = dir.to_path_buf();
        for part in relative.split(['\\', '/']).filter(|part| !part.is_empty()) {
            if part == ".." {
                path.pop();
            } else {
                path.push(part);
            }
        }
        return is_file(&path).then(|| path.into_os_string());
    }
    if token.contains('%') {
        return None;
    }
    let absolute = token.starts_with("\\\\")
        || token.as_bytes().get(1..3) == Some(b":\\".as_slice())
        || token.as_bytes().get(1..3) == Some(b":/".as_slice());
    if absolute {
        let path = PathBuf::from(token);
        return is_file(&path).then(|| path.into_os_string());
    }
    if token.contains(['\\', '/']) {
        return None;
    }
    lookup(token).map(PathBuf::into_os_string)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    use super::{Shim, parse_shim};

    const NPM_NODE: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n";
    const NPM_EXE: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe\"   %*\r\n";
    const PNPM: &str = "@SETLOCAL\r\n@IF NOT DEFINED NODE_PATH (\r\n  @SET \"NODE_PATH=C:\\pnpm\\global\\5\\node_modules\"\r\n) ELSE (\r\n  @SET \"NODE_PATH=C:\\pnpm\\global\\5\\node_modules;%NODE_PATH%\"\r\n)\r\n@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\..\\global\\5\\node_modules\\@qwen-code\\qwen-code\\cli.js\" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  \"%~dp0\\..\\global\\5\\node_modules\\@qwen-code\\qwen-code\\cli.js\" %*\r\n)\r\n";

    fn bin() -> PathBuf {
        PathBuf::from("/npm")
    }

    fn files(paths: &[PathBuf]) -> impl Fn(&Path) -> bool + '_ {
        move |path| paths.iter().any(|known| known == path)
    }

    fn node(name: &str) -> Option<PathBuf> {
        (name == "node").then(|| PathBuf::from("/nodejs/node.exe"))
    }

    fn under(dir: &Path, parts: &[&str]) -> PathBuf {
        parts
            .iter()
            .fold(dir.to_path_buf(), |path, part| path.join(part))
    }

    #[test]
    fn an_npm_shim_runs_its_script_with_node() {
        let cli = under(
            &bin(),
            &["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
        );
        let local_node = bin().join("node.exe");

        let with_path_node = parse_shim(NPM_NODE, &bin(), files(std::slice::from_ref(&cli)), node);
        let with_local_node = parse_shim(
            NPM_NODE,
            &bin(),
            files(&[cli.clone(), local_node.clone()]),
            node,
        );

        assert_eq!(
            with_path_node,
            Some(Shim {
                program: PathBuf::from("/nodejs/node.exe"),
                args: vec![cli.clone().into_os_string()],
                node_path: None,
            })
        );
        assert_eq!(with_local_node.map(|shim| shim.program), Some(local_node));
    }

    #[test]
    fn an_npm_shim_for_a_native_binary_runs_it_directly() {
        let exe = under(
            &bin(),
            &["node_modules", "opencode-ai", "bin", "opencode.exe"],
        );

        assert_eq!(
            parse_shim(NPM_EXE, &bin(), files(std::slice::from_ref(&exe)), node),
            Some(Shim {
                program: exe,
                args: Vec::new(),
                node_path: None,
            })
        );
    }

    #[test]
    fn a_pnpm_shim_falls_back_to_node_on_the_path_and_keeps_node_path() {
        let dir = PathBuf::from("/pnpm/bin");
        let cli = under(
            Path::new("/pnpm"),
            &[
                "global",
                "5",
                "node_modules",
                "@qwen-code",
                "qwen-code",
                "cli.js",
            ],
        );

        assert_eq!(
            parse_shim(PNPM, &dir, files(std::slice::from_ref(&cli)), node),
            Some(Shim {
                program: PathBuf::from("/nodejs/node.exe"),
                args: vec![cli.into_os_string()],
                node_path: Some("C:\\pnpm\\global\\5\\node_modules".to_owned()),
            })
        );
    }

    #[test]
    fn keeps_interpreter_flags_and_absolute_programs() {
        let script = bin().join("cli.mjs");
        let shim = "@\"/opt/node/node.exe\" --no-warnings \"%~dp0\\cli.mjs\" %*\r\n";
        let known = [script.clone(), PathBuf::from("/opt/node/node.exe")];

        assert_eq!(
            parse_shim(shim, &bin(), files(&known), node),
            None,
            "a Unix path is not absolute on Windows"
        );
        let windows = "@\"C:\\node\\node.exe\" --no-warnings \"%~dp0\\cli.mjs\" %*\r\n";
        let known = [script.clone(), PathBuf::from("C:\\node\\node.exe")];
        assert_eq!(
            parse_shim(windows, &bin(), files(&known), node),
            Some(Shim {
                program: PathBuf::from("C:\\node\\node.exe"),
                args: vec![OsString::from("--no-warnings"), script.into_os_string()],
                node_path: None,
            })
        );
    }

    #[test]
    fn anything_it_cannot_follow_is_left_to_cmd() {
        let cli = bin().join("cli.js");
        let known = [cli];
        let extra_variable = "@SET \"PATH=C:\\tools;%PATH%\"\r\n@node \"%~dp0\\cli.js\" %*\r\n";
        let missing_script = "@node \"%~dp0\\gone.js\" %*\r\n";
        let unknown_variable = "@\"%TOOLS%\\node.exe\" \"%~dp0\\cli.js\" %*\r\n";
        let no_node = "@node \"%~dp0\\cli.js\" %*\r\n";

        for text in [extra_variable, missing_script, unknown_variable] {
            assert_eq!(
                parse_shim(text, &bin(), files(&known), node),
                None,
                "{text}"
            );
        }
        assert_eq!(parse_shim(no_node, &bin(), files(&known), |_| None), None);
        assert_eq!(
            parse_shim("@echo hello\r\n", &bin(), files(&known), node),
            None
        );
    }
}
