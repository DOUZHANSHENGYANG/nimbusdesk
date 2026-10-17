use tauri::{AppHandle, Emitter, Manager};

fn hub_label(key: &str) -> Result<String, String> {
    if key.is_empty() || key.len() > 512 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Desktop hub key is invalid".into());
    }
    Ok(format!("edge-hub-{key}"))
}

fn allowed_route(route: &str) -> bool {
    matches!(route, "/" | "/plans" | "/files" | "/settings")
}

#[derive(Debug, PartialEq)]
enum DragOutcome {
    Pending,
    Released,
    Canceled,
    TimedOut,
}

fn drag_outcome(left_down: bool, escape: bool, elapsed: std::time::Duration) -> DragOutcome {
    if escape {
        DragOutcome::Canceled
    } else if !left_down {
        DragOutcome::Released
    } else if elapsed >= std::time::Duration::from_secs(120) {
        DragOutcome::TimedOut
    } else {
        DragOutcome::Pending
    }
}

/// Tauri's start_dragging resolves after posting WM_NCLBUTTONDOWN, not on release.
/// Wait off the UI thread so a capsule cannot snap back in the middle of an OS drag.
#[tauri::command]
pub async fn desktop_wait_drag_end(window: tauri::WebviewWindow) -> Result<bool, String> {
    if !["todo-", "fence-", "edge-hub-"]
        .iter()
        .any(|prefix| window.label().starts_with(prefix))
    {
        return Err("Only desktop windows can wait for a drag".into());
    }
    #[cfg(windows)]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON, VK_RBUTTON,
        };
        use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};
        tauri::async_runtime::spawn_blocking(move || {
            let started = std::time::Instant::now();
            let primary = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 {
                VK_RBUTTON
            } else {
                VK_LBUTTON
            };
            loop {
                // Only the initiating button and cancel key are sampled during this gesture.
                let left = unsafe { GetAsyncKeyState(i32::from(primary.0)) } < 0;
                let escape = unsafe { GetAsyncKeyState(i32::from(VK_ESCAPE.0)) } < 0;
                match drag_outcome(left, escape, started.elapsed()) {
                    DragOutcome::Pending => {
                        std::thread::sleep(std::time::Duration::from_millis(12))
                    }
                    DragOutcome::Released | DragOutcome::Canceled => {
                        // Let the native move loop apply its final/canceled rectangle first.
                        std::thread::sleep(std::time::Duration::from_millis(60));
                        return Ok(!escape);
                    }
                    DragOutcome::TimedOut => {
                        return Err("Desktop drag timed out; retry the gesture".into())
                    }
                }
            }
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        Ok(true)
    }
}

#[tauri::command]
pub async fn desktop_open_hub(app: AppHandle, key: String) -> Result<(), String> {
    let label = hub_label(&key)?;
    if let Some(window) = app.get_webview_window(&label) {
        return window.show().map_err(|error| error.to_string());
    }
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title("Desktop queue")
        .inner_size(28.0, 40.0)
        .visible(false)
        .focused(false)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .skip_taskbar(true)
        .resizable(false)
        // The frontend sets bottom/top as a pair after placement and hydration.
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn desktop_close_hub(app: AppHandle, key: String) -> Result<(), String> {
    let label = hub_label(&key)?;
    if let Some(window) = app.get_webview_window(&label) {
        window.destroy().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_open_main(app: AppHandle, route: String) -> Result<(), String> {
    if !allowed_route(&route) {
        return Err("Desktop destination is invalid".into());
    }
    let main = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    main.show().map_err(|error| error.to_string())?;
    main.set_focus().map_err(|error| error.to_string())?;
    if route != "/" {
        main.emit("search://navigate", route)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn drag_wait_ends_only_on_release_cancel_or_bounded_timeout() {
        use super::{drag_outcome, DragOutcome};
        use std::time::Duration;
        assert_eq!(
            drag_outcome(true, false, Duration::ZERO),
            DragOutcome::Pending
        );
        assert_eq!(
            drag_outcome(false, false, Duration::from_secs(1)),
            DragOutcome::Released
        );
        assert_eq!(
            drag_outcome(true, true, Duration::from_secs(1)),
            DragOutcome::Canceled
        );
        assert_eq!(
            drag_outcome(false, true, Duration::from_secs(1)),
            DragOutcome::Canceled
        );
        assert_eq!(
            drag_outcome(true, false, Duration::from_secs(120)),
            DragOutcome::TimedOut
        );
    }
    #[test]
    fn hub_labels_accept_only_nonempty_ascii_hex_keys_up_to_512_bytes() {
        for key in ["0", "0123456789abcdef", "ABCDEF", "aB01"] {
            assert_eq!(super::hub_label(key).unwrap(), format!("edge-hub-{key}"));
        }
        let maximum = "a".repeat(512);
        assert_eq!(
            super::hub_label(&maximum).unwrap(),
            format!("edge-hub-{maximum}")
        );
    }

    #[test]
    fn hub_labels_reject_paths_other_window_names_unicode_and_oversized_keys() {
        for key in [
            "",
            "/",
            "../main",
            "main",
            "edge-hub-a",
            "aa/bb",
            "aa\\bb",
            "aa.bb",
            "aa:bb",
            "aa bb",
            "a\nb",
            "a\0b",
            "１２",
            "é",
            "g",
            "%61",
        ] {
            assert!(super::hub_label(key).is_err(), "{key:?}");
        }
        assert!(super::hub_label(&"a".repeat(513)).is_err());
    }

    #[test]
    fn main_routes_allow_only_known_desktop_destinations() {
        for route in ["/", "/plans", "/files", "/settings"] {
            assert!(super::allowed_route(route), "{route}");
        }
        for route in [
            "",
            "/tools",
            "/plans?source=secret",
            "/files/../settings",
            "/settings#secret",
            "https://example.test",
            "/plans\n",
        ] {
            assert!(!super::allowed_route(route), "{route:?}");
        }
    }
}
