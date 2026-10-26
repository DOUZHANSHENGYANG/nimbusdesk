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
    GetForegroundWindow, GetWindowLongPtrW, IsZoomed, WS_EX_LAYERED, WS_EX_TRANSPARENT, GetWindowRect, SetWindowLongPtrW, SetWindowPos,
    SetForegroundWindow, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
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

/// 上级窗口是否最大化（用于自动切成「指示条」形态）。
fn foreground_maximized() -> bool {
    unsafe {
        let hwnd = GetForegroundWindow();
        !hwnd.is_invalid() && IsZoomed(hwnd).as_bool()
    }
}

/// 上一次推给前端的形态，只在变化时发事件（200ms 一次轮询，不发就得每帧 setState）。
static LAST_FG: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

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

/// 输入会话 · 开始：清掉 WS_EX_NOACTIVATE 并把自己带到前台。
///
/// 抄 WinIsland 的 `InputSession`：岛体平时 NOACTIVATE（点它不抢前台），
/// 但文本框要打字就得有键盘焦点 —— 这里临时放行，让这一次点击的焦点落进输入框。
/// `end` 负责把样式还原，用户的写作/IDE 窗口不会被一块桌面挂件顶掉。
#[tauri::command]
pub async fn input_session_begin(app: AppHandle, label: String) -> Result<(), String> {
    let hwnd = hwnd_of(&app, &label)?;
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style & !(WS_EX_NOACTIVATE.0 as isize));
        let _ = SetForegroundWindow(hwnd);
    }
    Ok(())
}

/// 输入会话 · 结束：还原 NOACTIVATE。焦点交还给用户下一个点击的地方。
#[tauri::command]
pub async fn input_session_end(app: AppHandle, label: String) -> Result<(), String> {
    let hwnd = hwnd_of(&app, &label)?;
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_NOACTIVATE.0 as isize);
    }
    Ok(())
}

/// 在指定目录拉起一个终端窗口（Windows Terminal 优先，没有就退回 PowerShell）。
///
/// 这是「终端页」的第一版：**拉起系统终端**，不是把 PTY 嵌进卡片。
/// 嵌入式要 portable-pty + xterm.js + 会话生命周期，属于另一件事；
/// 这一版先解决「在云台里一键把终端叫到当前项目目录」，风险低、当场能用。
#[tauri::command]
pub async fn shell_launch(kind: String, cwd: Option<String>) -> Result<(), String> {
    let dir = cwd.unwrap_or_default();
    let mut command = std::process::Command::new("cmd");
    let args: Vec<String> = match kind.as_str() {
        "wt" => vec!["/C".into(), "start".into(), "".into(), "wt.exe".into(), "-d".into(), dir.clone()],
        "powershell" => vec!["/C".into(), "start".into(), "".into(), "powershell.exe".into(), "-NoExit".into(), "-Command".into(), format!("Set-Location -LiteralPath '{}'", dir.replace('\'', "''"))],
        "cmd" => vec!["/C".into(), "start".into(), "".into(), "cmd.exe".into(), "/K".into(), format!("cd /d \"{}\"", dir)],
        other => return Err(format!("未知的终端类型：{other}")),
    };
    command
        .args(args)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW：不要闪一个黑框
        .spawn()
        .map_err(|e| format!("拉起终端失败：{e}"))?;
    Ok(())
}

/// 整窗鼠标穿透：开启后点击穿过 Dock 落到后面的窗口。
///
/// 需要 WS_EX_LAYERED + WS_EX_TRANSPARENT 同时存在；只加 TRANSPARENT 在部分
/// Windows 版本上不生效。开着穿透时窗口收不到 hover，所以前端会在开启时
/// 同时禁用悬停展开 —— 这两件事必须一起开关，否则用户会遇到「岛再也点不到」。
#[tauri::command]
pub async fn dock_set_click_through(app: AppHandle, label: String, on: bool) -> Result<(), String> {
    let hwnd = hwnd_of(&app, &label)?;
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let flags = (WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0) as isize;
        let next = if on { style | flags } else { style & !flags };
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

/// 把 dock 窗口一次性摆到目标矩形（**不再逐帧插值**）。
///
/// 之前是 Rust 每 8ms SetWindowPos 一次做弹簧 —— 窗口本身在动，任何 1px
/// 起点误差都会被放大成「整窗先往左移一下」。读过 LuckyIsland（Tauri 2 +
/// React 的同栈实现）之后改成它的模型：
///
/// - 窗口只在状态切换时 set_size + set_position 各一次，人眼看不到这一帧；
/// - 位移与缩放动画交给前端 DOM，那才是「内容在撑开」的观感来源；
/// - 换宽度时以当前顶部中心为锚点重设 x，避免横向跳动。
#[tauri::command]
pub async fn dock_spring_to(
    app: AppHandle,
    label: String,
    to_x: f64,
    to_y: f64,
    to_w: f64,
    to_h: f64,
    _style: String,
) -> Result<(), String> {
    let window = app.get_webview_window(&label).ok_or("窗口不存在")?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let hwnd = hwnd_of(&app, &label)?;
    // 位置和尺寸必须一次 SetWindowPos 提交：先 set_size 再 set_position 会让
    // 窗口在一帧内停在错误 x 上，收起时看起来就是「闪一下/刷新一下」。
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            (to_x * scale).round() as i32,
            (to_y * scale).round() as i32,
            (to_w * scale).round().max(1.0) as i32,
            (to_h * scale).round().max(1.0) as i32,
            SWP_NOACTIVATE | SWP_NOZORDER,
        )
        .map_err(|e| e.to_string())?;
    }
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
use std::os::windows::process::CommandExt;

#[cfg(windows)]
fn foreground_covers_monitor(dock: HWND) -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_invalid() || fg == dock {
            return false;
        }
        let mut rect = RECT::default();
        let _ = GetWindowRect(fg, &mut rect);
        // 按**岛所在**显示器判定：多屏时主屏的全屏应用不该把副屏上的岛藏起来
        let monitor = MonitorFromWindow(dock, MONITOR_DEFAULTTONEAREST);
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
    if !AUTOHIDE_SPAWNED.swap(true, Ordering::Relaxed) {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            // 线程只起一次、常驻；真正的开关在循环里读，否则「关掉自动隐藏」
            // 与「关掉 Dock」之后这个线程还会继续把窗口藏起来/叫回来。
            if !DOCK_ENABLED.load(Ordering::SeqCst) {
                continue;
            }
            /*
             * 前台形态：0 普通 / 1 最大化 / 2 全屏。
             * 只在变化时 emit —— 200ms 一次的轮询要是每拍都发，前端就得每拍
             * 处理一次事件，纯属浪费。
             */
            #[cfg(windows)]
            {
                let dock_hwnd2 = hwnd_of(&handle, "desktop-dock").unwrap_or_default();
                let next = if !dock_hwnd2.is_invalid() && foreground_covers_monitor(dock_hwnd2) { 2u8 } else if foreground_maximized() { 1 } else { 0 };
                if LAST_FG.swap(next, Ordering::Relaxed) != next {
                    let _ = handle.emit("dock-foreground", next);
                }
            }
            if !DOCK_AUTOHIDE.load(Ordering::Relaxed) {
                continue;
            }
            #[cfg(windows)]
            {
                let dock_hwnd = hwnd_of(&handle, "desktop-dock").unwrap_or_default();
                let fullscreen = if dock_hwnd.is_invalid() { false } else { foreground_covers_monitor(dock_hwnd) };
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
