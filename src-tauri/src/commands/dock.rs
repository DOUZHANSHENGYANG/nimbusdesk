//! 桌面 Dock：常驻贴边工具条窗口的原生窗口操作。
//!
//! 三个 Win32 技巧取自 NetSpeed-Dynamic（MIT）：无焦点显示、原子 bounds、
//! 弹簧动画。普通 `.show()` 会抢走当前应用焦点，dock 弹出时不能打断用户。

use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_SHOWNOACTIVATE, WS_EX_NOACTIVATE,
};

/// Dock 是全局单实例窗口；窗口操作按代数取消，新的弹簧动画会立即作废旧循环。
static DOCK_SPRING: AtomicU64 = AtomicU64::new(0);

fn hwnd_of(app: &AppHandle, label: &str) -> Result<HWND, String> {
    let win = app.get_webview_window(label).ok_or("窗口不存在")?;
    let raw = win.hwnd().map_err(|e| e.to_string())?.0;
    Ok(HWND(raw))
}

/// 显示窗口但不抢占当前应用焦点，并强制回到置顶层，
/// 避免被全屏应用或其他置顶窗口盖住。
#[tauri::command]
pub async fn window_show_no_activate(app: AppHandle, label: String) -> Result<(), String> {
    let hwnd = hwnd_of(&app, &label)?;
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        // SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 一次调用同时改位置和尺寸，不抢焦点、不打乱层级，
/// 消除「先 setSize 再 setPosition」两步之间的闪烁。
#[tauri::command]
pub async fn window_set_bounds(
    app: AppHandle,
    label: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    let hwnd = hwnd_of(&app, &label)?;
    unsafe {
        SetWindowPos(hwnd, None, x, y, width, height, SWP_NOACTIVATE | SWP_NOZORDER)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 切换窗口的 WS_EX_NOACTIVATE 扩展样式：开启后点击窗口不会激活它，
/// 前台应用保持不变（全屏悬停唤起场景使用）。
#[tauri::command]
pub async fn window_set_no_activate(
    app: AppHandle,
    label: String,
    enabled: bool,
) -> Result<(), String> {
    let hwnd = hwnd_of(&app, &label)?;
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let next = if enabled {
            style | WS_EX_NOACTIVATE.0 as isize
        } else {
            style & !(WS_EX_NOACTIVATE.0 as isize)
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
    }
    Ok(())
}

/// 弹簧动画：8ms 步进驱动窗口 x/宽度插值，锚点由调用方给定
/// （左缘 x 不变，右缘 x 随宽度外移）。y/高度全程固定。
/// 代数计数器保证新动画立即作废旧循环，结束时用同一套浮点逻辑定格，
/// 避免整数取整造成 0.5 像素漂移。
#[tauri::command]
pub async fn dock_spring(
    app: AppHandle,
    label: String,
    from_x: f64,
    to_x: f64,
    from_w: f64,
    to_w: f64,
    y: f64,
    h: f64,
    style: String,
) -> Result<(), String> {
    let id = DOCK_SPRING.fetch_add(1, Ordering::SeqCst) + 1;
    let scale = app
        .get_webview_window(&label)
        .and_then(|win| win.scale_factor().ok())
        .unwrap_or(1.0);
    // HWND 内部是裸指针（!Send），跨线程只传整数。
    let hwnd_raw = hwnd_of(&app, &label)?.0 as isize;
    let (freq, decay, duration_ms) = if style == "stiff" {
        (3.8, 22.0, 250.0)
    } else {
        (2.4, 12.0, 400.0)
    };
    std::thread::spawn(move || {
        let hwnd = HWND(hwnd_raw as *mut _);
        let started = std::time::Instant::now();
        let duration = std::time::Duration::from_millis(duration_ms as u64);
        let place = |x: f64, w: f64| unsafe {
            let _ = SetWindowPos(
                hwnd,
                None,
                (x * scale).round() as i32,
                (y * scale).round() as i32,
                (w * scale).round() as i32,
                (h * scale).round() as i32,
                SWP_NOACTIVATE | SWP_NOZORDER,
            );
        };
        while started.elapsed() < duration {
            std::thread::sleep(std::time::Duration::from_millis(8));
            if DOCK_SPRING.load(Ordering::SeqCst) != id {
                return;
            }
            let elapsed = started.elapsed().as_secs_f64();
            let progress = elapsed / (duration_ms / 1000.0);
            if progress >= 1.0 {
                break;
            }
            let spring =
                1.0 - (freq * elapsed * 2.0 * std::f64::consts::PI).cos() * (-decay * elapsed).exp();
            place(
                from_x + (to_x - from_x) * spring,
                from_w + (to_w - from_w) * spring,
            );
        }
        if DOCK_SPRING.load(Ordering::SeqCst) == id {
            place(to_x, to_w);
        }
    });
    Ok(())
}

/// 创建（或激活）dock 窗口。位置与显示由前端在算出工作区后
/// 通过 `window_set_bounds` + `window_show_no_activate` 完成。
#[tauri::command]
pub async fn dock_open(app: AppHandle) -> Result<(), String> {
    let label = "desktop-dock";
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App("index.html".into()))
        .title("云台 Dock")
        .inner_size(248.0, 520.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn dock_close(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("desktop-dock") {
        let _ = win.close();
    }
    Ok(())
}
