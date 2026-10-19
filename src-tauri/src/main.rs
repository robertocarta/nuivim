mod nvim;
mod shellenv;

use std::collections::HashMap;
use std::sync::Arc;

use nvim::{from_json, to_json, NvimState, StartError};
use rmpv::Value;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, DragDropEvent, Manager, RunEvent, State, WindowEvent};

struct Env(HashMap<String, String>);

#[tauri::command]
async fn nvim_start(
    app: AppHandle,
    state: State<'_, Arc<NvimState>>,
    env: State<'_, Env>,
    cols: u64,
    rows: u64,
) -> Result<(), StartError> {
    nvim::start(app, state.inner().clone(), &env.0, cols.max(1), rows.max(1)).await
}

#[tauri::command]
async fn nvim_input(state: State<'_, Arc<NvimState>>, keys: String) -> Result<(), String> {
    let nvim = state.client().ok_or("Neovim is not running")?;
    nvim.input(&keys).await.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn nvim_input_mouse(
    state: State<'_, Arc<NvimState>>,
    button: String,
    action: String,
    modifier: String,
    grid: i64,
    row: i64,
    col: i64,
) -> Result<(), String> {
    let nvim = state.client().ok_or("Neovim is not running")?;
    nvim.input_mouse(&button, &action, &modifier, grid, row, col).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn nvim_call(
    state: State<'_, Arc<NvimState>>,
    method: String,
    params: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let nvim = state.client().ok_or("Neovim is not running")?;
    let args: Vec<Value> = params.iter().map(from_json).collect();
    match nvim.call(&method, args).await {
        Ok(Ok(v)) => Ok(to_json(&v)),
        Ok(Err(e)) => Err(to_json(&e).to_string()),
        Err(e) => Err(e.to_string()),
    }
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
    let quit = MenuItem::with_id(app, "quit", "Quit NuiVim", true, Some("CmdOrCtrl+Q"))?;
    let app_menu = Submenu::with_items(
        app,
        "NuiVim",
        true,
        &[
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    Menu::with_items(app, &[&app_menu, &window_menu])
}

fn main() {
    let env = shellenv::resolve();
    let files: Vec<String> = std::env::args().skip(1).filter(|a| !a.starts_with("-psn_")).collect();
    let state = Arc::new(NvimState::new(files));

    let app = tauri::Builder::default()
        .manage(state.clone())
        .manage(Env(env))
        .setup(|app| {
            let handle = app.handle();
            app.set_menu(menu(handle)?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == "quit" {
                app.state::<Arc<NvimState>>().quit(app);
            }
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                window.state::<Arc<NvimState>>().quit(window.app_handle());
            }
            WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                let paths = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                window.state::<Arc<NvimState>>().open_files(window.app_handle(), paths);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![nvim_start, nvim_input, nvim_input_mouse, nvim_call, frontend_log])
        .build(tauri::generate_context!())
        .expect("error while building nuivim");

    app.run(move |app, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Opened { urls } = &event {
            let paths = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            state.open_files(app, paths);
        }
        let _ = (app, event);
    });
}
