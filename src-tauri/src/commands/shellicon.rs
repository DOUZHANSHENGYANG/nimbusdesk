//! 提取 Windows 原生图标（资源管理器/桌面同款），返回 PNG data URL。
//!
//! 流程：SHGetFileInfoW 取 HICON → GetIconInfo 取掩码/颜色位图 →
//! 用 DrawIconEx 画到 32 位 DIB（保留 alpha）→ 手工编码 PNG。
//! 不使用 SHGFI_USEFILEATTRIBUTES：按真实路径取图标，.exe 等能拿到自身图标。

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;

/// 图标尺寸（像素）。大图标按 Windows 惯例为 32×32。
const ICON_SIZE: i32 = 32;

/// 路径 → data URL 缓存（图标不会变，进程内复用）
fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn native_icon(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(hit) = cache().lock().ok().and_then(|c| c.get(&path).cloned()) {
            return Ok(hit);
        }
        let result = unsafe { extract(&path) };
        if let Ok(mut c) = cache().lock() {
            c.insert(path.clone(), result.clone());
        }
        Ok(result)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// 批量取图标（栅栏一屏多个条目，一次 IPC 拿全）
#[tauri::command]
pub async fn native_icons(paths: Vec<String>) -> Result<Vec<Option<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(paths
            .iter()
            .map(|p| {
                if let Some(hit) = cache().lock().ok().and_then(|c| c.get(p).cloned()) {
                    return hit;
                }
                let r = unsafe { extract(p) };
                if let Ok(mut c) = cache().lock() {
                    c.insert(p.clone(), r.clone());
                }
                r
            })
            .collect())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[cfg(windows)]
unsafe fn extract(path: &str) -> Option<String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ,
    };
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyIcon, DrawIconEx, GetIconInfo, DI_NORMAL, ICONINFO,
    };

    let wide: Vec<u16> = OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut info = SHFILEINFOW::default();
    let ok = SHGetFileInfoW(
        windows::core::PCWSTR(wide.as_ptr()),
        FILE_FLAGS_AND_ATTRIBUTES(0),
        Some(&mut info),
        std::mem::size_of::<SHFILEINFOW>() as u32,
        SHGFI_ICON | SHGFI_LARGEICON,
    );
    if ok == 0 || info.hIcon.is_invalid() {
        return None;
    }
    let hicon = info.hIcon;

    let out = (|| -> Option<String> {
        // 用 32 位 DIB 承接，DrawIconEx 会写入 alpha 通道
        let screen: HDC = GetDC(None);
        if screen.is_invalid() {
            return None;
        }
        let mem: HDC = CreateCompatibleDC(Some(screen));
        if mem.is_invalid() {
            ReleaseDC(None, screen);
            return None;
        }

        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: ICON_SIZE,
            biHeight: -ICON_SIZE, // 负数 = 自上而下，行序与 PNG 一致
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };

        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let dib: HBITMAP = match CreateDIBSection(Some(mem), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
        {
            Ok(b) => b,
            Err(_) => {
                let _ = DeleteDC(mem);
                ReleaseDC(None, screen);
                return None;
            }
        };
        if bits.is_null() {
            let _ = DeleteObject(HGDIOBJ(dib.0));
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            return None;
        }

        let old = SelectObject(mem, HGDIOBJ(dib.0));
        let drawn = DrawIconEx(
            mem,
            0,
            0,
            hicon,
            ICON_SIZE,
            ICON_SIZE,
            0,
            None,
            DI_NORMAL,
        )
        .is_ok();
        SelectObject(mem, old);

        let png = if drawn {
            let px = std::slice::from_raw_parts(bits as *const u8, (ICON_SIZE * ICON_SIZE * 4) as usize);
            encode_png(px, ICON_SIZE as u32, ICON_SIZE as u32)
        } else {
            None
        };

        let _ = DeleteObject(HGDIOBJ(dib.0));
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);

        // 掩码位图必须删除，否则句柄泄漏
        let mut ii = ICONINFO::default();
        if GetIconInfo(hicon, &mut ii).is_ok() {
            if !ii.hbmMask.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0));
            }
            if !ii.hbmColor.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0));
            }
        }

        png
    })();

    let _ = DestroyIcon(hicon);
    out
}

#[cfg(not(windows))]
unsafe fn extract(_path: &str) -> Option<String> {
    None
}

/// 把 BGRA 像素编码为 PNG，返回 data URL。
#[cfg(windows)]
fn encode_png(bgra: &[u8], w: u32, h: u32) -> Option<String> {
    use base64::Engine;

    // DrawIconEx 在 32 位 DIB 上输出 BGRA；无 alpha 的图标 alpha 为 0，
    // 这类像素按不透明处理（否则整图透明不可见）。
    let has_alpha = bgra.chunks_exact(4).any(|p| p[3] != 0);
    let mut rgba = Vec::with_capacity(bgra.len());
    for p in bgra.chunks_exact(4) {
        let a = if has_alpha { p[3] } else { 255 };
        rgba.extend_from_slice(&[p[2], p[1], p[0], a]);
    }

    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(&rgba).ok()?;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&out);
    Some(format!("data:image/png;base64,{b64}"))
}

#[cfg(not(windows))]
fn encode_png(_bgra: &[u8], _w: u32, _h: u32) -> Option<String> {
    None
}
