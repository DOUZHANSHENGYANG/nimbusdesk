//! Wake the main coordinator even when its WebView is hidden in the tray.
//! Preferences, local-time checks and once-per-day receipts stay in the frontend.

use std::time::Duration;
use tauri::{Emitter, EventTarget, Manager};

pub fn start(app: tauri::AppHandle) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("organization-clock".into())
        .spawn(move || {
            // Allow the frontend listener to mount. Startup also checks the schedule,
            // so a slow initial load cannot lose a due run.
            std::thread::sleep(Duration::from_secs(2));
            loop {
                if app.get_webview_window("main").is_none() {
                    break;
                }
                let _ = app.emit_to(
                    EventTarget::webview_window("main"),
                    "knowledge:organization-tick",
                    (),
                );
                std::thread::sleep(Duration::from_secs(20));
            }
        })
        .map(|_| ())
}
