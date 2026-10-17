use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Default)]
pub struct FenceShortcut(pub Mutex<Option<Shortcut>>);
pub(crate) static SHORTCUT_CHANGES: Mutex<()> = Mutex::new(());

#[tauri::command]
pub async fn set_fence_shortcut(
    app: AppHandle,
    state: State<'_, FenceShortcut>,
    shortcut: String,
) -> Result<(), String> {
    let next = if shortcut.trim().is_empty() {
        None
    } else {
        Some(super::capture::parse_shortcut(&shortcut)?)
    };
    let _change = SHORTCUT_CHANGES.lock().map_err(|_| "快捷键状态不可用")?;
    let mut current = state.0.lock().map_err(|_| "栅格快捷键状态不可用")?;
    if *current == next {
        return Ok(());
    }
    if let Some(next) = next {
        if app.global_shortcut().is_registered(next) {
            return Err("快捷键与快捷收集冲突，请更换组合键".into());
        }
        app.global_shortcut()
            .on_shortcut(next, |app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = app.emit("desktop://toggle-fences", ());
                }
            })
            .map_err(|_| "快捷键被占用或与快捷收集冲突，请更换组合键".to_string())?;
    }
    if let Some(previous) = *current {
        if let Err(error) = app.global_shortcut().unregister(previous) {
            if let Some(next) = next {
                let _ = app.global_shortcut().unregister(next);
            }
            return Err(format!("无法更换栅格快捷键：{error}"));
        }
    }
    *current = next;
    Ok(())
}
