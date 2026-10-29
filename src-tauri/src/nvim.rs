//! Owns the Neovim child process: finds it, spawns it, attaches as a UI and
//! forwards every notification to the frontend unchanged (as JSON).

use std::collections::{HashMap, HashSet, VecDeque};
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

use crate::launch;

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
struct Redraw {
    tab: u32,
    events: serde_json::Value,
}

#[derive(Serialize, Clone)]
struct Notify {
    tab: u32,
    method: String,
    args: serde_json::Value,
}

#[derive(Serialize, Clone)]
struct ExitInfo {
    tab: u32,
    code: Option<i32>,
    stderr: Vec<String>,
}

/// One Neovim per tab, keyed by the frontend's tab id.
#[derive(Default)]
pub struct NvimState {
    clients: Mutex<HashMap<u32, Neovim<Writer>>>,
    starting: Mutex<HashSet<u32>>,
}

impl NvimState {
    pub fn client(&self, tab: u32) -> Option<Neovim<Writer>> {
        self.clients.lock().unwrap().get(&tab).cloned()
    }

    pub fn is_empty(&self) -> bool {
        self.clients.lock().unwrap().is_empty()
    }
}

#[derive(Clone)]
struct Forwarder {
    app: AppHandle,
    tab: u32,
}

#[async_trait]
impl Handler for Forwarder {
    type Writer = Writer;

    async fn handle_notify(&self, name: String, args: Vec<Value>, _nvim: Neovim<Writer>) {
        let json = serde_json::Value::Array(args.iter().map(to_json).collect());
        if name == "redraw" {
            let _ = self.app.emit("nvim-redraw", Redraw { tab: self.tab, events: json });
        } else {
            let _ = self.app.emit("nvim-notify", Notify { tab: self.tab, method: name, args: json });
        }
    }
}

pub struct StartOptions {
    pub cols: u64,
    pub rows: u64,
    /// Working directory; a missing or empty one means the home folder.
    pub cwd: Option<String>,
    pub files: Vec<String>,
}

/// Finds, checks, spawns and attaches the Neovim of tab `tab`.
pub async fn start(
    app: AppHandle,
    state: Arc<NvimState>,
    env: &HashMap<String, String>,
    tab: u32,
    opts: StartOptions,
) -> Result<(), StartError> {
    if state.client(tab).is_some() || !state.starting.lock().unwrap().insert(tab) {
        return Err(StartError { kind: "already_started", message: format!("Tab {tab} already has a Neovim") });
    }
    let result = spawn_and_attach(app, state.clone(), env, tab, opts).await;
    state.starting.lock().unwrap().remove(&tab);
    result
}

async fn spawn_and_attach(
    app: AppHandle,
    state: Arc<NvimState>,
    env: &HashMap<String, String>,
    tab: u32,
    opts: StartOptions,
) -> Result<(), StartError> {
    let bin = find_nvim(env)?;
    check_version(&bin, env).await?;

    let home = env.get("HOME").map(String::as_str);
    let mut cmd = Command::new(&bin);
    cmd.arg("--embed");
    if !opts.files.is_empty() {
        cmd.arg("--").args(opts.files.iter().map(|f| launch::expand_home(f, home)));
    }
    cmd.env_clear().envs(env).stderr(Stdio::piped());
    if let Some(dir) = launch::working_dir(opts.cwd.as_deref(), home) {
        cmd.current_dir(dir);
    }

    let (nvim, io, mut child) = nvim_rs::create::tokio::new_child_cmd(&mut cmd, Forwarder { app: app.clone(), tab })
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

    // When this Neovim exits, the frontend closes its tab (or shows why it crashed).
    let exit_app = app.clone();
    let exit_state = state.clone();
    tokio::spawn(async move {
        let status = child.wait().await;
        let _ = io.await;
        if let Some(task) = stderr_task {
            let _ = task.await;
        }
        exit_state.clients.lock().unwrap().remove(&tab);
        let code = status.ok().and_then(|s| s.code());
        let stderr = stderr_tail.lock().unwrap().iter().cloned().collect();
        let _ = exit_app.emit("nvim-exit", ExitInfo { tab, code, stderr });
    });

    let attach_err = |e: String| StartError { kind: "attach", message: e };
    let api = nvim.get_api_info().await.map_err(|e| attach_err(e.to_string()))?;
    let channel = api.first().and_then(Value::as_i64).unwrap_or(0);

    let ui_opts = Value::Map(
        ["rgb", "ext_linegrid", "ext_multigrid", "ext_hlstate"]
            .iter()
            .map(|k| (Value::from(*k), Value::from(true)))
            .collect(),
    );
    nvim.call("nvim_ui_attach", vec![opts.cols.into(), opts.rows.into(), ui_opts])
        .await
        .map_err(|e| attach_err(e.to_string()))?
        .map_err(|e| attach_err(e.to_string()))?;

    state.clients.lock().unwrap().insert(tab, nvim.clone());

    // The bridge may wait behind a startup prompt, so it must not block start().
    tokio::spawn(async move {
        if let Err(e) = nvim.exec_lua(BRIDGE, vec![Value::from(channel)]).await {
            eprintln!("nuivim: bridge failed: {e}");
        }
    });
    Ok(())
}

fn find_nvim(env: &HashMap<String, String>) -> Result<PathBuf, StartError> {
    if let Some(p) = env.get("NUIVIM_NVIM").filter(|p| !p.is_empty()) {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Ok(path);
        }
        return Err(StartError {
            kind: "not_found",
            message: format!("NUIVIM_NVIM is set to {p}, but no file exists there. nuivim needs Neovim 0.10 or newer."),
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
        message: format!("No nvim found on PATH ({path_var}). nuivim needs Neovim 0.10 or newer, for example from `brew install neovim`."),
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
                "Found {} reporting \"{}\". nuivim needs Neovim 0.10 or newer.",
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
        let env = HashMap::from([("NUIVIM_NVIM".to_string(), "/nonexistent".to_string())]);
        let err = find_nvim(&env).unwrap_err();
        assert_eq!(err.kind, "not_found");
        assert!(err.message.contains("/nonexistent"));
    }

    #[test]
    fn find_nvim_searches_path() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("nuivim-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("nvim"), "").unwrap();
        let env = HashMap::from([("PATH".to_string(), format!("/nonexistent-dir:{}", dir.display()))]);
        assert_eq!(find_nvim(&env).unwrap(), dir.join("nvim"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
