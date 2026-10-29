//! Requests to open files in a new tab: from the command line (`nuivim notes.md`,
//! also forwarded from a second launch), from Finder, and the shell command script.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Open these files in a new tab whose working directory is `cwd` (or the default one).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenRequest {
    pub cwd: Option<String>,
    pub files: Vec<String>,
}

/// Parses arguments after the program name: `[--cwd DIR] [--] FILE…`.
/// Returns None when there is nothing to open and no directory (a plain launch).
pub fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Option<OpenRequest> {
    let mut cwd = None;
    let mut files = Vec::new();
    let mut only_files = false;
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        if only_files {
            files.push(arg);
        } else if arg == "--" {
            only_files = true;
        } else if arg == "--cwd" {
            cwd = it.next();
        } else if let Some(dir) = arg.strip_prefix("--cwd=") {
            cwd = Some(dir.to_string());
        } else if arg.starts_with("-psn_") {
            // Process serial number added by older macOS launchers.
        } else {
            files.push(arg);
        }
    }
    (cwd.is_some() || !files.is_empty()).then_some(OpenRequest { cwd, files })
}

/// Expands a leading `~` to the home directory.
pub fn expand_home(path: &str, home: Option<&str>) -> String {
    match (path.strip_prefix('~'), home) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with('/') => format!("{home}{rest}"),
        _ => path.to_string(),
    }
}

/// The working directory for a new Neovim: `wanted` if it is an existing directory, else home.
pub fn working_dir(wanted: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    let candidate = wanted.filter(|w| !w.is_empty()).map(|w| PathBuf::from(expand_home(w, home)));
    match candidate {
        Some(p) if p.is_dir() => Some(p),
        _ => home.map(PathBuf::from),
    }
}

/// The `nuivim` shell command: a new tab in the running app (or a new app) for the
/// given files, with the caller's directory as the tab's working directory.
pub fn shell_script(app: &Path) -> String {
    let app = app.display().to_string().replace('\'', r"'\''");
    format!(
        "#!/bin/sh\n\
         # Installed by NuiVim. Opens files in a new NuiVim tab whose working\n\
         # directory is the current one; starts NuiVim if it is not running.\n\
         exec open -n -a '{app}' --args --cwd \"$PWD\" -- \"$@\"\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn plain_launch_has_no_request() {
        assert_eq!(parse_args(args(&[])), None);
        assert_eq!(parse_args(args(&["-psn_0_12345"])), None);
    }

    #[test]
    fn files_and_cwd() {
        assert_eq!(
            parse_args(args(&["--cwd", "/work", "--", "a.md", "-dash.txt"])),
            Some(OpenRequest { cwd: Some("/work".into()), files: args(&["a.md", "-dash.txt"]) })
        );
        assert_eq!(
            parse_args(args(&["--cwd=/w", "b.txt"])),
            Some(OpenRequest { cwd: Some("/w".into()), files: args(&["b.txt"]) })
        );
        assert_eq!(parse_args(args(&["x.md"])), Some(OpenRequest { cwd: None, files: args(&["x.md"]) }));
    }

    #[test]
    fn cwd_alone_opens_a_tab_there() {
        assert_eq!(parse_args(args(&["--cwd", "/w", "--"])), Some(OpenRequest { cwd: Some("/w".into()), files: vec![] }));
    }

    #[test]
    fn expands_home() {
        assert_eq!(expand_home("~/notes/a.md", Some("/Users/a")), "/Users/a/notes/a.md");
        assert_eq!(expand_home("~", Some("/Users/a")), "/Users/a");
        assert_eq!(expand_home("~bob/x", Some("/Users/a")), "~bob/x");
        assert_eq!(expand_home("/abs", Some("/Users/a")), "/abs");
        assert_eq!(expand_home("~/x", None), "~/x");
    }

    #[test]
    fn working_dir_falls_back_to_home() {
        let root = env!("CARGO_MANIFEST_DIR");
        assert_eq!(working_dir(Some(root), Some("/home")), Some(PathBuf::from(root)));
        assert_eq!(working_dir(Some("/nonexistent-dir"), Some("/home")), Some(PathBuf::from("/home")));
        assert_eq!(working_dir(Some(""), Some("/home")), Some(PathBuf::from("/home")));
        assert_eq!(working_dir(None, None), None);
    }

    #[test]
    fn shell_script_quotes_the_app_path() {
        let s = shell_script(Path::new("/Applications/It's NuiVim.app"));
        assert!(s.starts_with("#!/bin/sh\n"));
        assert!(s.contains(r"exec open -n -a '/Applications/It'\''s NuiVim.app' --args --cwd "));
        assert!(s.ends_with("-- \"$@\"\n"));
    }
}
