mod launch;
mod nvim;
mod shellenv;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use launch::OpenRequest;
use nvim::{from_json, to_json, NvimState, StartError, StartOptions};
use rmpv::Value;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, RunEvent, State, WindowEvent};

struct Env(HashMap<String, String>);

/// Open requests that arrived before the frontend asked for them.
#[derive(Default)]
struct Launch {
    pending: Mutex<Vec<OpenRequest>>,
    ready: Mutex<bool>,
}

impl Launch {
    /// Sends a request to the frontend as a new tab, or keeps it until the frontend is ready.
    fn open(&self, app: &AppHandle, req: OpenRequest) {
        if *self.ready.lock().unwrap() {
            let _ = app.emit("open-request", req);
        } else {
            self.pending.lock().unwrap().push(req);
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn nvim_start(
    app: AppHandle,
    state: State<'_, Arc<NvimState>>,
    env: State<'_, Env>,
    tab: u32,
    cols: u64,
    rows: u64,
    cwd: Option<String>,
    files: Option<Vec<String>>,
) -> Result<(), StartError> {
    let opts = StartOptions { cols: cols.max(1), rows: rows.max(1), cwd, files: files.unwrap_or_default() };
    nvim::start(app, state.inner().clone(), &env.0, tab, opts).await
}

#[tauri::command]
async fn nvim_input(state: State<'_, Arc<NvimState>>, tab: u32, keys: String) -> Result<(), String> {
    let nvim = state.client(tab).ok_or("Neovim is not running")?;
    nvim.input(&keys).await.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn nvim_input_mouse(
    state: State<'_, Arc<NvimState>>,
    tab: u32,
    button: String,
    action: String,
    modifier: String,
    grid: i64,
    row: i64,
    col: i64,
) -> Result<(), String> {
    let nvim = state.client(tab).ok_or("Neovim is not running")?;
    nvim.input_mouse(&button, &action, &modifier, grid, row, col).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn nvim_call(
    state: State<'_, Arc<NvimState>>,
    tab: u32,
    method: String,
    params: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let nvim = state.client(tab).ok_or("Neovim is not running")?;
    let args: Vec<Value> = params.iter().map(from_json).collect();
    match nvim.call(&method, args).await {
        Ok(Ok(v)) => Ok(to_json(&v)),
        Ok(Err(e)) => Err(to_json(&e).to_string()),
        Err(e) => Err(e.to_string()),
    }
}

/// The open requests from launch (command line, Finder); later ones arrive as events.
#[tauri::command]
fn launch_requests(launch: State<'_, Launch>) -> Vec<OpenRequest> {
    *launch.ready.lock().unwrap() = true;
    std::mem::take(&mut *launch.pending.lock().unwrap())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("settings.json"))
}

/// NuiVim's own settings (validated by the frontend); `{}` when none were saved.
#[tauri::command]
fn settings_load(app: AppHandle) -> serde_json::Value {
    settings_path(&app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

#[tauri::command]
fn settings_save(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let path = settings_path(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, text + "\n").map_err(|e| e.to_string())
}

/// Writes the `nuivim` command to ~/.local/bin. Returns a message for the user.
#[tauri::command]
fn install_shell_command(env: State<'_, Env>) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let app = exe
        .ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .ok_or("The shell command can only be installed from the built NuiVim.app.")?;
    let home = env.0.get("HOME").ok_or("HOME is not set")?;
    let dir = PathBuf::from(home).join(".local/bin");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join("nuivim");
    std::fs::write(&target, launch::shell_script(app)).map_err(|e| e.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    let on_path = env.0.get("PATH").is_some_and(|p| p.split(':').any(|d| PathBuf::from(d) == dir));
    Ok(if on_path {
        format!("Installed {}. Run `nuivim FILE` in a terminal.", target.display())
    } else {
        format!(
            "Installed {}, but {} is not on your PATH. Add `export PATH=\"$HOME/.local/bin:$PATH\"` to your shell profile.",
            target.display(),
            dir.display()
        )
    })
}

/// Called by the frontend once every tab has closed.
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Dev builds only: prints frontend log lines to the terminal running `tauri dev`.
#[tauri::command]
fn frontend_log(message: String) {
    if cfg!(debug_assertions) {
        eprintln!("[frontend] {message}");
    }
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // No Edit menu: Cmd-C/V/A and friends must reach Neovim as <D-…> keys.
    let item = |id: &str, label: &str, key: Option<&str>| MenuItem::with_id(app, id, label, true, key);
    let app_menu = Submenu::with_items(
        app,
        "NuiVim",
        true,
        &[
            &item("settings", "Settings…", Some("CmdOrCtrl+,"))?,
            &item("install-shell-command", "Install Shell Command…", None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &item("quit", "Quit NuiVim", Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[&item("new-tab", "New Tab", Some("CmdOrCtrl+T"))?, &item("close-tab", "Close Tab", Some("CmdOrCtrl+W"))?],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &item("next-tab", "Show Next Tab", Some("CmdOrCtrl+Shift+]"))?,
            &item("previous-tab", "Show Previous Tab", Some("CmdOrCtrl+Shift+["))?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &file_menu, &window_menu])
}

/// Quit and the close button: the frontend closes every tab (each Neovim may ask to
/// save), then calls quit_app. Without tabs there is nothing to ask.
fn request_quit(app: &AppHandle) {
    if app.state::<Arc<NvimState>>().is_empty() {
        app.exit(0);
    } else {
        let _ = app.emit("menu", "quit");
    }
}

fn main() {
    let env = shellenv::resolve();
    let launch = Launch::default();
    // `nuivim FILE` run directly (not through `open`) starts in the caller's directory.
    if let Some(mut req) = launch::parse_args(std::env::args().skip(1)) {
        if req.cwd.is_none() {
            req.cwd = std::env::current_dir().ok().filter(|d| d.as_os_str() != "/").map(|d| d.display().to_string());
        }
        launch.pending.lock().unwrap().push(req);
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // A second launch (e.g. the `nuivim` command): open its files here instead.
            let mut req = launch::parse_args(args.into_iter().skip(1)).unwrap_or(OpenRequest { cwd: None, files: vec![] });
            if req.cwd.is_none() && cwd != "/" {
                req.cwd = Some(cwd);
            }
            app.state::<Launch>().open(app, req);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .manage(Arc::new(NvimState::default()))
        .manage(Env(env))
        .manage(launch)
        .setup(|app| {
            let handle = app.handle();
            app.set_menu(menu(handle)?)?;
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => request_quit(app),
            id => {
                let _ = app.emit("menu", id);
            }
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                request_quit(window.app_handle());
            }
            WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                let paths: Vec<String> = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                let _ = window.app_handle().emit("open-files", paths);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            nvim_start,
            nvim_input,
            nvim_input_mouse,
            nvim_call,
            launch_requests,
            settings_load,
            settings_save,
            install_shell_command,
            quit_app,
            frontend_log
        ])
        .build(tauri::generate_context!())
        .expect("error while building nuivim");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Opened { urls } = &event {
            // Finder "Open With" / `open -a NuiVim FILE`: a new tab in the default directory.
            let files: Vec<String> =
                urls.iter().filter_map(|u| u.to_file_path().ok()).map(|p| p.to_string_lossy().into_owned()).collect();
            if !files.is_empty() {
                app.state::<Launch>().open(app, OpenRequest { cwd: None, files });
            }
        }
        let _ = (app, event);
    });
}
