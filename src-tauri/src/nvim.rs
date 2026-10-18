//! Owns the Neovim child process: finds it, spawns it, attaches as a UI and
//! forwards every notification to the frontend unchanged (as JSON).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use nvim_rs::compat::tokio::Compat;
use nvim_rs::{Handler, Neovim};
use rmpv::Value;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStdin, Command};

type Writer = Compat<ChildStdin>;

const BRIDGE: &str = include_str!("bridge.lua");
const MIN_VERSION: (u64, u64) = (0, 10);
const STDERR_LINES: usize = 50;

#[derive(Debug, Serialize, Clone)]
pub struct StartError {
    pub kind: &'static str,
    pub message: String,
}

#[derive(Serialize, Clone)]
struct ExitInfo {
    code: Option<i32>,
    stderr: Vec<String>,
}

#[derive(Serialize, Clone)]
struct Notify {
    method: String,
    args: serde_json::Value,
}

/// Shared state managed by Tauri.
pub struct NvimState {
    client: Mutex<Option<Neovim<Writer>>>,
    /// Files from Finder or the command line that arrived before the frontend was ready.
    pending_files: Mutex<Vec<String>>,
    started: Mutex<bool>,
}

impl NvimState {
    pub fn new(files: Vec<String>) -> Self {
        Self { client: Mutex::new(None), pending_files: Mutex::new(files), started: Mutex::new(false) }
    }

    pub fn client(&self) -> Option<Neovim<Writer>> {
        self.client.lock().unwrap().clone()
    }

    /// Hands paths to the frontend, or keeps them until Neovim is attached.
    pub fn open_files(&self, app: &AppHandle, paths: Vec<String>) {
        if paths.is_empty() {
            return;
        }
        if self.client().is_some() {
            let _ = app.emit("open-files", paths);
        } else {
            self.pending_files.lock().unwrap().extend(paths);
        }
    }

    /// Asks Neovim to quit; the app closes when the process exits.
    pub fn quit(&self, app: &AppHandle) {
        match self.client() {
            Some(nvim) => {
                tauri::async_runtime::spawn(async move {
                    let _ = nvim.command("confirm qa").await;
                });
            }
            None => app.exit(0),
        }
    }
}

#[derive(Clone)]
struct Forwarder {
    app: AppHandle,
}

#[async_trait]
impl Handler for Forwarder {
    type Writer = Writer;

    async fn handle_notify(&self, name: String, args: Vec<Value>, _nvim: Neovim<Writer>) {
        let json = serde_json::Value::Array(args.iter().map(to_json).collect());
        if name == "redraw" {
            let _ = self.app.emit("nvim-redraw", json);
        } else {
            let _ = self.app.emit("nvim-notify", Notify { method: name, args: json });
        }
    }
}

/// Finds, checks, spawns and attaches Neovim with a `cols` × `rows` grid.
pub async fn start(
    app: AppHandle,
    state: Arc<NvimState>,
    env: &HashMap<String, String>,
    cols: u64,
    rows: u64,
) -> Result<(), StartError> {
    {
        let mut started = state.started.lock().unwrap();
        if *started {
            return Err(StartError { kind: "already_started", message: "Neovim is already running".into() });
        }
        *started = true;
    }
    let bin = find_nvim(env)?;
    check_version(&bin, env).await?;

    let mut cmd = Command::new(&bin);
    cmd.arg("--embed");
    let files: Vec<String> = std::mem::take(&mut *state.pending_files.lock().unwrap());
    if !files.is_empty() {
        cmd.arg("--").args(&files);
    }
    cmd.env_clear().envs(env).stderr(Stdio::piped());
    // Apps opened from Finder start in "/"; the home folder is a better default.
    if std::env::current_dir().map(|d| d == Path::new("/")).unwrap_or(true) {
        if let Some(home) = env.get("HOME") {
            cmd.current_dir(home);
        }
    }

    let (nvim, io, mut child) = nvim_rs::create::tokio::new_child_cmd(&mut cmd, Forwarder { app: app.clone() })
        .await
        .map_err(|e| StartError { kind: "spawn", message: format!("Could not start {}: {e}", bin.display()) })?;

    let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
    let stderr_task = child.stderr.take().map(|stderr| {
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut tail = tail.lock().unwrap();
                if tail.len() == STDERR_LINES {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
        })
    });

    let exit_app = app.clone();
    tokio::spawn(async move {
        let status = child.wait().await;
        let _ = io.await;
        if let Some(task) = stderr_task {
            let _ = task.await;
        }
        match status {
            Ok(s) if s.success() => exit_app.exit(0),
            other => {
                let code = other.ok().and_then(|s| s.code());
                let stderr = stderr_tail.lock().unwrap().iter().cloned().collect();
                let _ = exit_app.emit("nvim-exit", ExitInfo { code, stderr });
            }
        }
    });

    let attach_err = |e: String| StartError { kind: "attach", message: e };
    let api = nvim.get_api_info().await.map_err(|e| attach_err(e.to_string()))?;
    let channel = api.first().and_then(Value::as_i64).unwrap_or(0);

    let opts = Value::Map(
        ["rgb", "ext_linegrid", "ext_multigrid", "ext_hlstate"]
            .iter()
            .map(|k| (Value::from(*k), Value::from(true)))
            .collect(),
    );
    nvim.call("nvim_ui_attach", vec![cols.into(), rows.into(), opts])
        .await
        .map_err(|e| attach_err(e.to_string()))?
        .map_err(|e| attach_err(e.to_string()))?;

    *state.client.lock().unwrap() = Some(nvim.clone());

    // The bridge may wait behind a startup prompt, so it must not block start().
    let state2 = state.clone();
    tokio::spawn(async move {
        if let Err(e) = nvim.exec_lua(BRIDGE, vec![Value::from(channel)]).await {
            eprintln!("propvim: bridge failed: {e}");
        }
        let pending: Vec<String> = std::mem::take(&mut *state2.pending_files.lock().unwrap());
        state2.open_files(&app, pending);
    });
    Ok(())
}

fn find_nvim(env: &HashMap<String, String>) -> Result<PathBuf, StartError> {
    if let Some(p) = env.get("PROPVIM_NVIM").filter(|p| !p.is_empty()) {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Ok(path);
        }
        return Err(StartError {
            kind: "not_found",
            message: format!("PROPVIM_NVIM is set to {p}, but no file exists there. propvim needs Neovim 0.10 or newer."),
        });
    }
    let path_var = env.get("PATH").cloned().unwrap_or_default();
    for dir in path_var.split(':').filter(|d| !d.is_empty()) {
        let candidate = Path::new(dir).join("nvim");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(StartError {
        kind: "not_found",
        message: format!("No nvim found on PATH ({path_var}). propvim needs Neovim 0.10 or newer, for example from `brew install neovim`."),
    })
}

async fn check_version(bin: &Path, env: &HashMap<String, String>) -> Result<(), StartError> {
    let out = Command::new(bin)
        .arg("--version")
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| StartError { kind: "not_found", message: format!("Could not run {}: {e}", bin.display()) })?;
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().next().unwrap_or("").to_string();
    match parse_version(&first) {
        Some((maj, min, _)) if (maj, min) >= MIN_VERSION => Ok(()),
        _ => Err(StartError {
            kind: "too_old",
            message: format!(
                "Found {} reporting \"{}\". propvim needs Neovim 0.10 or newer.",
                bin.display(),
                if first.is_empty() { "no version" } else { &first }
            ),
        }),
    }
}

/// Parses the first line of `nvim --version`, e.g. "NVIM v0.12.5" or "NVIM v0.11.0-dev-12+gabc".
pub fn parse_version(line: &str) -> Option<(u64, u64, u64)> {
    let rest = line.trim().strip_prefix("NVIM v")?;
    let core: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next().flatten().unwrap_or(0)))
}

/// Converts a msgpack value to JSON. Buffer/window/tabpage handles (ext types)
/// become plain integers, which the API accepts back in their place.
pub fn to_json(v: &Value) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        Value::Nil => J::Null,
        Value::Boolean(b) => J::Bool(*b),
        Value::Integer(i) => {
            if let Some(n) = i.as_i64() {
                J::from(n)
            } else {
                J::from(i.as_u64().unwrap_or(0))
            }
        }
        Value::F32(f) => serde_json::Number::from_f64(*f as f64).map(J::Number).unwrap_or(J::Null),
        Value::F64(f) => serde_json::Number::from_f64(*f).map(J::Number).unwrap_or(J::Null),
        Value::String(s) => J::String(s.as_str().map(str::to_string).unwrap_or_else(|| String::from_utf8_lossy(s.as_bytes()).into_owned())),
        Value::Binary(b) => J::String(String::from_utf8_lossy(b).into_owned()),
        Value::Array(a) => J::Array(a.iter().map(to_json).collect()),
        Value::Map(m) => J::Object(
            m.iter()
                .map(|(k, v)| {
                    let key = match k {
                        Value::String(s) => s.as_str().unwrap_or("").to_string(),
                        other => to_json(other).to_string(),
                    };
                    (key, to_json(v))
                })
                .collect(),
        ),
        Value::Ext(_, data) => rmpv::decode::read_value(&mut &data[..]).map(|inner| to_json(&inner)).unwrap_or(J::Null),
    }
}

pub fn from_json(v: &serde_json::Value) -> Value {
    use serde_json::Value as J;
    match v {
        J::Null => Value::Nil,
        J::Bool(b) => Value::from(*b),
        J::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::from(i)
            } else if let Some(u) = n.as_u64() {
                Value::from(u)
            } else {
                Value::from(n.as_f64().unwrap_or(0.0))
            }
        }
        J::String(s) => Value::from(s.as_str()),
        J::Array(a) => Value::Array(a.iter().map(from_json).collect()),
        J::Object(o) => Value::Map(o.iter().map(|(k, v)| (Value::from(k.as_str()), from_json(v))).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("NVIM v0.12.5"), Some((0, 12, 5)));
        assert_eq!(parse_version("NVIM v0.11.0-dev-1234+gabcdef"), Some((0, 11, 0)));
        assert_eq!(parse_version("NVIM v0.10"), Some((0, 10, 0)));
        assert_eq!(parse_version("VIM - Vi IMproved 9.0"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn ext_types_become_integers() {
        let mut data = Vec::new();
        rmpv::encode::write_value(&mut data, &Value::from(1000)).unwrap();
        let v = Value::Array(vec![Value::from("win_pos"), Value::Ext(1, data)]);
        assert_eq!(to_json(&v), json!(["win_pos", 1000]));
    }

    #[test]
    fn json_round_trip() {
        let j = json!({"a": [1, -2, 2.5, "x", null, true], "b": {}});
        assert_eq!(to_json(&from_json(&j)), j);
    }

    #[test]
    fn non_string_map_keys_are_stringified() {
        let v = Value::Map(vec![(Value::from(3), Value::from("x"))]);
        assert_eq!(to_json(&v), json!({"3": "x"}));
    }

    #[test]
    fn find_nvim_reports_missing_override() {
        let env = HashMap::from([("PROPVIM_NVIM".to_string(), "/nonexistent".to_string())]);
        let err = find_nvim(&env).unwrap_err();
        assert_eq!(err.kind, "not_found");
        assert!(err.message.contains("/nonexistent"));
    }

    #[test]
    fn find_nvim_searches_path() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("propvim-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("nvim"), "").unwrap();
        let env = HashMap::from([("PATH".to_string(), format!("/nonexistent-dir:{}", dir.display()))]);
        assert_eq!(find_nvim(&env).unwrap(), dir.join("nvim"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
