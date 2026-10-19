//! Login-shell environment. Apps opened from Finder get a bare PATH, so we ask
//! the user's login shell for its environment once and give that to Neovim.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MARKER: &str = "__NUIVIM_ENV__";
const TIMEOUT: Duration = Duration::from_secs(5);

/// The login shell's environment, or the app's own environment if the shell
/// fails, prints nothing usable or takes longer than five seconds.
pub fn resolve() -> HashMap<String, String> {
    match from_login_shell() {
        Some(env) if env.contains_key("PATH") => env,
        _ => std::env::vars().collect(),
    }
}

fn from_login_shell() -> Option<HashMap<String, String>> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // The marker separates anything a profile script prints from env's output.
    let script = format!("printf '{MARKER}'; env -0");
    let mut child = Command::new(shell)
        .args(["-l", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < TIMEOUT => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let out = reader.join().ok()?;
    Some(parse(&String::from_utf8_lossy(&out)))
}

/// Parses `env -0` output that follows the marker.
pub fn parse(output: &str) -> HashMap<String, String> {
    let body = match output.find(MARKER) {
        Some(i) => &output[i + MARKER.len()..],
        None => output,
    };
    body.split('\0')
        .filter_map(|entry| {
            let (key, value) = entry.split_once('=')?;
            if key.is_empty() || key.contains('\n') {
                return None;
            }
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nul_separated_entries() {
        let env = parse("__NUIVIM_ENV__PATH=/usr/bin:/opt/homebrew/bin\0HOME=/Users/a\0");
        assert_eq!(env["PATH"], "/usr/bin:/opt/homebrew/bin");
        assert_eq!(env["HOME"], "/Users/a");
        assert_eq!(env.len(), 2);
    }

    #[test]
    fn ignores_profile_noise_before_marker() {
        let env = parse("Welcome!\nFOO=bar\n__NUIVIM_ENV__A=1\0");
        assert_eq!(env.len(), 1);
        assert_eq!(env["A"], "1");
    }

    #[test]
    fn keeps_newlines_and_equals_in_values() {
        let env = parse("__NUIVIM_ENV__X=a=b\nc\0Y=\0");
        assert_eq!(env["X"], "a=b\nc");
        assert_eq!(env["Y"], "");
    }

    #[test]
    fn skips_malformed_entries() {
        let env = parse("__NUIVIM_ENV__novalue\0=x\0OK=1\0");
        assert_eq!(env.len(), 1);
        assert_eq!(env["OK"], "1");
    }

    #[test]
    fn works_without_marker() {
        let env = parse("A=1\0B=2\0");
        assert_eq!(env["B"], "2");
    }
}
