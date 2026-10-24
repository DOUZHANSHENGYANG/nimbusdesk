//! 桌面 Dock：常驻贴边工具条窗口的原生窗口操作。
//!
//! 三个 Win32 技巧取自 NetSpeed-Dynamic（MIT）：无焦点显示、原子 bounds、
//! 弹簧动画。普通 `.show()` 会抢走当前应用焦点，dock 弹出时不能打断用户。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITOR_DEFAULTTONEAREST, MONITORINFO,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, SetWindowLongPtrW, SetWindowPos,
    ShowWindow, GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    SW_SHOWNOACTIVATE, WS_EX_NOACTIVATE,
};

/// Dock 是全局单实例窗口；窗口操作按代数取消，新的弹簧动画会立即作废旧循环。
static DOCK_SPRING: AtomicU64 = AtomicU64::new(0);
/// 全屏自动隐藏开关；监视线程常驻，开关只读这个位。
static DOCK_AUTOHIDE: AtomicBool = AtomicBool::new(false);
/// Dock 总开关。默认**关**：用户没主动启用时，连窗口都不该被创建。
/// 所有会「让 Dock 冒出来」的入口（命令、全局快捷键、自动隐藏监视线程）
/// 都先读这一位 —— 只在其中一个入口上把关，别的入口就成了后门。
static DOCK_ENABLED: AtomicBool = AtomicBool::new(false);
/// Dock 停靠边（0=左 1=右 2=顶），贴边热区唤起据此判断。
static DOCK_EDGE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(1);
/// 自动隐藏监视线程只起一次；DOCK_HIDDEN 标记「当前是被自动隐藏收起的」。
static AUTOHIDE_SPAWNED: AtomicBool = AtomicBool::new(false);
static DOCK_HIDDEN: AtomicBool = AtomicBool::new(false);

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
    let progress_app = app.clone();
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

/// 四元组弹簧：胶囊 ⇄ 卡片用这一条。
///
/// 与 dock_spring 的区别：那个只插值 x/宽度（贴边侧栏只变宽），
/// 胶囊展开时四个量都要动 —— 居中、变宽、变高、往下长。曲线沿用同一条
/// （1 - cos·e^-decay），代数计数器共享，所以「展开到一半再点收起」
/// 会从中断处弹向新目标，而不是跳回起点。
#[tauri::command]
pub async fn dock_spring_box(
    app: AppHandle,
    label: String,
    from_x: f64,
    from_y: f64,
    from_w: f64,
    from_h: f64,
    to_x: f64,
    to_y: f64,
    to_w: f64,
    to_h: f64,
    style: String,
) -> Result<(), String> {
    let id = DOCK_SPRING.fetch_add(1, Ordering::SeqCst) + 1;
    let scale = app
        .get_webview_window(&label)
        .and_then(|win| win.scale_factor().ok())
        .unwrap_or(1.0);
    let hwnd_raw = hwnd_of(&app, &label)?.0 as isize;
    let progress_app = app.clone();
    /*
     * 曲线参数直接对应 iOS 的叫法：response 0.38s、damping 0.78。
     *   freq  = 1 / response            = 2.63 Hz
     *   decay = damping · 2π · freq     = 12.9
     *   duration ≈ 1.2 × response       = 460ms（走完一个完整的回弹）
     * stiff 是收起用：更快、几乎不回弹（response 0.24、damping 1.0）。
     */
    let (freq, decay, duration_ms) = if style == "stiff" {
        (4.17, 26.2, 300.0)
    } else {
        (2.63, 12.9, 460.0)
    };
    std::thread::spawn(move || {
        let hwnd = HWND(hwnd_raw as *mut _);
        let started = std::time::Instant::now();
        let duration = std::time::Duration::from_millis(duration_ms as u64);
        let place = |x: f64, y: f64, w: f64, h: f64| unsafe {
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
            if elapsed / (duration_ms / 1000.0) >= 1.0 {
                break;
            }
            let spring =
                1.0 - (freq * elapsed * 2.0 * std::f64::consts::PI).cos() * (-decay * elapsed).exp();
            let _ = progress_app.emit("dock-spring-progress", spring);
            place(
                from_x + (to_x - from_x) * spring,
                from_y + (to_y - from_y) * spring,
                from_w + (to_w - from_w) * spring,
                from_h + (to_h - from_h) * spring,
            );
        }
        if DOCK_SPRING.load(Ordering::SeqCst) == id {
            place(to_x, to_y, to_w, to_h);
            let _ = progress_app.emit("dock-spring-progress", 1.0_f64);
        }
    });
    Ok(())
}

/// 创建（或激活）dock 窗口。位置与显示由前端在算出工作区后
/// 通过 `window_set_bounds` + `window_show_no_activate` 完成。
#[tauri::command]
pub async fn dock_open(app: AppHandle) -> Result<(), String> {
    // 总开关关着就不建窗口：这是「关掉后桌面上不该出现任何东西」的第一道门。
    if !DOCK_ENABLED.load(Ordering::SeqCst) {
        return Ok(());
    }
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

/// 桌面 Dock 总开关（设置里的「启用桌面 Dock」，默认关）。
///
/// 关：销毁窗口 + 注销全局快捷键 + 停掉自动隐藏 —— 桌面上不留东西，
/// 也不留任何能把它叫回来的入口（快捷键处理器与贴边热区都另读了 DOCK_ENABLED）。
/// 开：这里**不**建窗口，位置尺寸得等前端问过显示器工作区才算得出来，
/// 由前端 applyDock 紧接着调 `dock_open`。
#[tauri::command]
pub async fn dock_set_enabled(
    app: AppHandle,
    state: tauri::State<'_, DockShortcut>,
    on: bool,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    DOCK_ENABLED.store(on, Ordering::SeqCst);
    if on {
        return Ok(());
    }
    // 先熄火再拆窗：热区/自动隐藏的监视线程若还在跑，销毁过程中会把它重新建起来。
    DOCK_AUTOHIDE.store(false, Ordering::Relaxed);
    DOCK_HIDDEN.store(false, Ordering::Relaxed);
    if let Some(win) = app.get_webview_window("desktop-dock") {
        let _ = win.destroy();
    }
    let mut current = state.0.lock().map_err(|_| "快捷键状态不可用")?;
    if let Some(previous) = current.take() {
        let _ = app.global_shortcut().unregister(previous);
    }
    Ok(())
}

/// Dock 显隐全局快捷键（复用收集快捷键的解析与占用检查）。
#[derive(Default)]
pub struct DockShortcut(pub std::sync::Mutex<Option<tauri_plugin_global_shortcut::Shortcut>>);

#[tauri::command]
pub async fn set_dock_shortcut(
    app: AppHandle,
    state: tauri::State<'_, DockShortcut>,
    shortcut: String,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    // 总开关关着就不注册：注册了等于给一个「不存在的 Dock」留了条快捷键后门。
    if !DOCK_ENABLED.load(Ordering::SeqCst) {
        let mut current = state.0.lock().map_err(|_| "快捷键状态不可用")?;
        if let Some(previous) = current.take() {
            let _ = app.global_shortcut().unregister(previous);
        }
        return Ok(());
    }
    let next = if shortcut.trim().is_empty() {
        None
    } else {
        Some(super::capture::parse_shortcut(&shortcut)?)
    };
    let mut current = state.0.lock().map_err(|_| "快捷键状态不可用")?;
    if current.as_ref() == next.as_ref() { return Ok(()); }
    if let Some(previous) = current.take() {
        let _ = app.global_shortcut().unregister(previous);
    }
    if let Some(next) = next {
        if app.global_shortcut().is_registered(next) {
            return Err("快捷键被占用或无法注册，请更换组合键".into());
        }
        app.global_shortcut().on_shortcut(next, |app, _, event| {
            if event.state() == ShortcutState::Pressed {
                // 关闭状态下的快捷键必须是死键：用户关掉 Dock 之后，
                // 按到旧组合键不该有任何东西冒出来。
                if !DOCK_ENABLED.load(Ordering::SeqCst) {
                    return;
                }
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    match app.get_webview_window("desktop-dock") {
                        // 已存在就显隐切换；被关闭过则重开
                        Some(win) => {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                            }
                        }
                        None => { let _ = dock_open(app).await; }
                    }
                });
            }
        }).map_err(|_| "快捷键被占用或无法注册，请更换组合键".to_string())?;
        *current = Some(next);
    }
    Ok(())
}

/// 全屏自动隐藏：前台窗口铺满所在显示器即视为全屏，Dock 收起；退出自动回来。
/// 收起后贴边热区仍可唤起（光标贴住停靠边 = 临时唤出，离开即回）。
/// 前台窗口是否铺满所在显示器（>95% 视为全屏应用）。
#[cfg(windows)]
fn foreground_covers_monitor() -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        let mut rect = RECT::default();
        let _ = GetWindowRect(fg, &mut rect);
        let monitor = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return false;
        }
        let m = info.rcMonitor;
        let w = (m.right - m.left) as f64;
        let h = (m.bottom - m.top) as f64;
        let fw = (rect.right - rect.left) as f64;
        let fh = (rect.bottom - rect.top) as f64;
        w > 0.0 && h > 0.0 && fw / w > 0.95 && fh / h > 0.95
    }
}

#[cfg(windows)]
fn cursor_near_dock_edge() -> bool {
    use windows::Win32::Foundation::POINT;
    let mut point = POINT::default();
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut point);
        let monitor = MonitorFromWindow(
            windows::Win32::UI::WindowsAndMessaging::WindowFromPoint(point),
            MONITOR_DEFAULTTONEAREST,
        );
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return false;
        }
        let m = info.rcMonitor;
        match DOCK_EDGE.load(Ordering::Relaxed) {
            0 => (point.x - m.left).abs() <= 4,
            2 => (point.y - m.top).abs() <= 4,
            _ => (m.right - point.x).abs() <= 4,
        }
    }
}

#[tauri::command]
pub async fn dock_set_autohide(app: AppHandle, on: bool, edge: Option<String>) -> Result<(), String> {
    match edge.as_deref() {
        Some("left") => DOCK_EDGE.store(0, Ordering::Relaxed),
        Some("top") => DOCK_EDGE.store(2, Ordering::Relaxed),
        _ => DOCK_EDGE.store(1, Ordering::Relaxed),
    }
    DOCK_AUTOHIDE.store(on, Ordering::Relaxed);
    if on && !AUTOHIDE_SPAWNED.swap(true, Ordering::Relaxed) {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            // 线程只起一次、常驻；真正的开关在循环里读，否则「关掉自动隐藏」
            // 与「关掉 Dock」之后这个线程还会继续把窗口藏起来/叫回来。
            if !DOCK_ENABLED.load(Ordering::SeqCst) || !DOCK_AUTOHIDE.load(Ordering::Relaxed) {
                continue;
            }
            #[cfg(windows)]
            {
                let fullscreen = foreground_covers_monitor();
                let near_edge = cursor_near_dock_edge();
                if let Some(win) = handle.get_webview_window("desktop-dock") {
                    let visible = win.is_visible().unwrap_or(false);
                    if fullscreen && !near_edge {
                        // 全屏且光标不在停靠边：收起（记住是自动隐藏收的）
                        if visible {
                            let _ = win.hide();
                            DOCK_HIDDEN.store(true, Ordering::Relaxed);
                        }
                    } else if DOCK_HIDDEN.load(Ordering::Relaxed) {
                        // 自动隐藏中的贴边唤出：非聚焦显示，回到全屏深处再收
                        if let Ok(hwnd) = win.hwnd() {
                            unsafe {
                                let _ = ShowWindow(HWND(hwnd.0), SW_SHOWNOACTIVATE);
                                let _ = SetWindowPos(HWND(hwnd.0), Some(HWND_TOPMOST), 0, 0, 0, 0,
                                    SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
                            }
                        }
                        if !fullscreen {
                            DOCK_HIDDEN.store(false, Ordering::Relaxed);
                        }
                    }
                }
            }
        });
    }
    Ok(())
}
