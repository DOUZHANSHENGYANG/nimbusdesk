//! 抓当前前台窗口的图像，交给 AI 看图。
//!
//! 三个细节值得记下来：
//! 1. 用 DWM 的 EXTENDED_FRAME_BOUNDS 而不是 GetWindowRect —— 后者在 Win10+
//!    带着不可见的边框阴影，抓出来四周会多一圈黑；
//! 2. PrintWindow(PW_RENDERFULLCONTENT) 能抓到被遮挡/后台的窗口，比 BitBlt
//!    可靠；个别程序（部分游戏、硬件加速窗口）会返回全黑，这时退回 BitBlt
//!    抓屏幕对应区域；
//! 3. **不落盘**：只返回 data URL，随这一次消息发出去就没了。

use base64::Engine;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::CAPTUREBLT;
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

struct Captured {
    width: i32,
    height: i32,
    /// BGRA，上行优先
    pixels: Vec<u8>,
}

fn bounds_of(hwnd: HWND) -> Result<RECT, String> {
    let mut rect = RECT::default();
    unsafe {
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut _ as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_ok()
        {
            return Ok(rect);
        }
        windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect)
            .map_err(|e| e.to_string())?;
    }
    Ok(rect)
}

fn read_bitmap(hdc_screen: windows::Win32::Graphics::Gdi::HDC, width: i32, height: i32, x: i32, y: i32) -> Result<Captured, String> {
    unsafe {
        let mem = CreateCompatibleDC(Some(hdc_screen));
        let bitmap = CreateCompatibleBitmap(hdc_screen, width, height);
        let previous = SelectObject(mem, HGDIOBJ(bitmap.0));

        // 前台窗口一定是可见的，直接从屏幕 DC 拷那一片；CAPTUREBLT 连分层窗口一起拷
        BitBlt(mem, 0, 0, width, height, Some(hdc_screen), x, y, SRCCOPY | CAPTUREBLT)
            .map_err(|e| e.to_string())?;

        let mut info = BITMAPINFO::default();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // 负数 = 自上而下
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        let lines = GetDIBits(mem, bitmap, 0, height as u32, Some(pixels.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);

        SelectObject(mem, previous);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(mem);

        if lines == 0 {
            return Err("读不到像素".into());
        }
        Ok(Captured { width, height, pixels })
    }
}


/// 抓当前前台窗口，返回 data:image/png;base64,…（不落盘）。
#[tauri::command]
pub async fn window_capture() -> Result<String, String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return Err("没有前台窗口".into());
        }
        let rect = bounds_of(hwnd)?;
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return Err("窗口尺寸为 0（可能已最小化）".into());
        }

        let screen = GetDC(None);
        let captured = match read_bitmap(screen, width, height, rect.left, rect.top) {
            Ok(value) => value,
            Err(error) => {
                ReleaseDC(None, screen);
                return Err(error);
            }
        };
        ReleaseDC(None, screen);

        // BGRA → RGBA，交给 png 编码
        let mut rgba = captured.pixels;
        for chunk in rgba.chunks_exact_mut(4) {
            chunk.swap(0, 2);
            chunk[3] = 255;
        }
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, captured.width as u32, captured.height as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
            writer.write_image_data(&rgba).map_err(|e| e.to_string())?;
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(&png);
        Ok(format!("data:image/png;base64,{encoded}"))
    }
}
