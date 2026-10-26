//! 多屏解析层：全应用「窗口该在哪块屏」的**唯一**判定处。
//!
//! 规矩抄自 WinIsland 的 `DisplayResolver`：**任何地方都不许再回退到主屏** ——
//! 多屏机器上「拿不到就 primary」实际就是"永远赖在主屏"。语义三档：
//!
//! - `auto`（或不传）：跟随**鼠标所在屏** —— 用户在哪块屏干活，挂件就在哪块屏；
//! - 指定 id：固定那一块（即使光标在别的屏上，钉住的就是钉住的）；
//! - 找不到：**报错**交给调用方（谁掉链子谁处理），绝不静默换屏。
//!
//! id 规则与前端旧格式逐字兼容：`名字@整屏原点`（不是工作区原点）——
//! 用户设置里存着旧格式 id（fence/dock 的 `edgeMonitor`），换格式等于作废他们的选择。

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    /// 稳定主键：`名字@整屏原点`，与前端 `monitorArea()` 的旧格式一致
    pub id: String,
    pub name: Option<String>,
    /// 工作区（扣掉任务栏），单位物理像素
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub scale: f64,
}

pub fn display_id(name: Option<&str>, x: i32, y: i32) -> String {
    format!("{}@{},{}", name.unwrap_or("display"), x, y)
}

fn of_monitor(monitor: &tauri::Monitor) -> DisplayInfo {
    let pos = monitor.position();
    let area = monitor.work_area();
    DisplayInfo {
        id: display_id(monitor.name().map(|n| n.as_str()), pos.x, pos.y),
        name: monitor.name().cloned(),
        x: area.position.x,
        y: area.position.y,
        w: area.size.width as i32,
        h: area.size.height as i32,
        scale: monitor.scale_factor(),
    }
}

/// 枚举全部显示器（工作区口径）。
pub fn list(app: &AppHandle) -> Vec<DisplayInfo> {
    match app.available_monitors() {
        Ok(monitors) => monitors.iter().map(of_monitor).collect(),
        Err(_) => Vec::new(),
    }
}

/// 光标的物理坐标（拿不到就 (0,0)，即当作主屏左上角处理）。
pub fn cursor() -> (i32, i32) {
    let mut point = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut point);
    }
    (point.x, point.y)
}

/// 纯函数（可单测）：从候选里挑一块屏。
pub fn pick(list: &[DisplayInfo], pref: Option<&str>, cursor: (i32, i32)) -> Result<DisplayInfo, String> {
    if list.is_empty() {
        return Err("DISPLAYS_EMPTY".into());
    }
    if let Some(id) = pref.filter(|p| !p.is_empty() && *p != "auto") {
        return list
            .iter()
            .find(|d| d.id == id)
            .cloned()
            .ok_or_else(|| format!("DISPLAY_NOT_FOUND: {id}"));
    }
    let (cx, cy) = cursor;
    // 光标落在哪块的矩形里就用哪块；跨过缝隙（多屏分辨率不一）时取最近的
    let found = list
        .iter()
        .find(|d| cx >= d.x && cx < d.x + d.w && cy >= d.y && cy < d.y + d.h)
        .or_else(|| {
            list.iter().min_by_key(|d| {
                let dx = if cx < d.x { d.x - cx } else if cx >= d.x + d.w { cx - (d.x + d.w) } else { 0 };
                let dy = if cy < d.y { d.y - cy } else if cy >= d.y + d.h { cy - (d.y + d.h) } else { 0 };
                (dx * dx + dy * dy) as i64
            })
        });
    found.cloned().ok_or_else(|| "DISPLAYS_EMPTY".into())
}

/// 热插拔监听：每 3 秒比对一次签名，变了就广播 `display://changed`。
///
/// WinIsland 订阅的是 `DisplayContentsInvalidated`；Tauri 没有现成事件，
/// 轮询比对是最省事的可靠做法（空闲时只是几次数组比较，无窗口操作）。
pub fn start_watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = String::new();
        loop {
            let signature = list(&app)
                .iter()
                .map(|d| format!("{}|{}x{}", d.id, d.w, d.h))
                .collect::<Vec<_>>()
                .join(";");
            if !last.is_empty() && signature != last {
                let _ = app.emit("display://changed", list(&app));
            }
            last = signature;
            std::thread::sleep(std::time::Duration::from_secs(3));
        }
    });
}

#[tauri::command]
pub fn display_list(app: AppHandle) -> Vec<DisplayInfo> {
    list(&app)
}

/// 解析「这块挂件该在哪块屏」：`pref` 为 None/"auto" 跟随鼠标，否则按 id 固定。
#[tauri::command]
pub fn display_resolve(app: AppHandle, pref: Option<String>) -> Result<DisplayInfo, String> {
    let list = list(&app);
    pick(&list, pref.as_deref(), cursor())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(id: &str, x: i32, y: i32, w: i32, h: i32) -> DisplayInfo {
        DisplayInfo { id: id.into(), name: None, x, y, w, h, scale: 1.0 }
    }

    fn two() -> Vec<DisplayInfo> {
        vec![d("a@0,0", 0, 0, 1920, 1080), d("b@1920,0", 1920, 0, 1920, 1080)]
    }

    #[test]
    fn auto_follows_cursor() {
        assert_eq!(pick(&two(), None, (2500, 300)).unwrap().id, "b@1920,0");
        assert_eq!(pick(&two(), Some("auto"), (500, 300)).unwrap().id, "a@0,0");
    }

    #[test]
    fn explicit_id_beats_cursor() {
        // 光标在 a 上，但钉的是 b：钉住的就是钉住的
        assert_eq!(pick(&two(), Some("b@1920,0"), (10, 10)).unwrap().id, "b@1920,0");
    }

    #[test]
    fn unknown_pref_errors_never_falls_back_to_primary() {
        // 关键规矩：指定的屏不存在就报错，绝不静默换成主屏
        let err = pick(&two(), Some("nope"), (10, 10)).unwrap_err();
        assert!(err.starts_with("DISPLAY_NOT_FOUND"));
    }

    #[test]
    fn nearest_when_cursor_in_gap() {
        // 两块屏之间留了缝（分辨率不一的常见摆法）：取最近的
        let list = vec![d("a@0,0", 0, 0, 1000, 800), d("b@1200,0", 1200, 0, 1000, 800)];
        assert_eq!(pick(&list, None, (1150, 400)).unwrap().id, "b@1200,0");
    }

    #[test]
    fn empty_list_is_error() {
        assert_eq!(pick(&[], None, (0, 0)).unwrap_err(), "DISPLAYS_EMPTY");
    }

    #[test]
    fn id_format_matches_frontend() {
        // 与前端 monitorArea() 的旧格式逐字兼容，用户存的 edgeMonitor 才不会作废
        assert_eq!(display_id(Some("\\\\.\\DISPLAY1"), 0, 0), "\\\\.\\DISPLAY1@0,0");
        assert_eq!(display_id(None, 1920, 0), "display@1920,0");
    }
}
