//! 提取 Windows 原生图标（资源管理器/桌面同款），返回 PNG data URL。
//!
//! 用 `SHGetImageList(SHIL_JUMBO)` 拿系统「超大」图像列表，再按
//! `SHGetFileInfoW(SHGFI_SYSICONINDEX)` 得到的索引取图标。
//!
//! 为什么不用 `SHGFI_ICON | SHGFI_LARGEICON`：那只给 32×32，
//! 栅栏缩放（0.7×–1.6×）或高 DPI 下会被放大而发虚。
//! JUMBO 列表是「多尺寸」的：Windows 按当前 DPI 往里填充
//! 256 / 96 / 64 / 48 / 40 / 32 / 20 / 16 各档，索引一致，
//! 所以取到的是与当前缩放匹配的那一档，而不是硬塞 256 再缩。
//!
//! 不使用 `SHGFI_USEFILEATTRIBUTES`：按真实路径取图标，.exe 能拿到自身图标。

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;

/// 路径 → data URL 缓存（图标不会变，进程内复用）。
/// key 含目标尺寸：同一文件在不同显示尺寸下是两份图。
fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 单张图标。
///
/// `size` 为目标边长（物理像素，前端按 CSS 尺寸 × devicePixelRatio 传入）；
/// 传 0 或负数表示「用系统给的原始尺寸」（jumbo 档位，通常 256）。
#[tauri::command]
pub async fn native_icon(path: String, size: Option<i32>) -> Result<Option<String>, String> {
    let size = size.unwrap_or(0);
    tauri::async_runtime::spawn_blocking(move || Ok(extract_cached(&path, size)))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

/// 批量取图标（栅栏一屏多个条目，一次 IPC 拿全）
#[tauri::command]
pub async fn native_icons(
    paths: Vec<String>,
    size: Option<i32>,
) -> Result<Vec<Option<String>>, String> {
    let size = size.unwrap_or(0);
    tauri::async_runtime::spawn_blocking(move || {
        Ok(paths.iter().map(|p| extract_cached(p, size)).collect())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// 取图标并写缓存
#[cfg(windows)]
fn extract_cached(path: &str, size: i32) -> Option<String> {
    let key = format!("{path}\u{1}{size}");
    if let Some(hit) = cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        return hit;
    }
    let result = unsafe { extract(path, size) };
    if let Ok(mut c) = cache().lock() {
        c.insert(key, result.clone());
    }
    result
}

#[cfg(not(windows))]
fn extract_cached(_path: &str, _size: i32) -> Option<String> {
    None
}

#[cfg(windows)]
unsafe fn extract(path: &str, target: i32) -> Option<String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Controls::{IImageList, ILD_TRANSPARENT};
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHGetImageList, SHFILEINFOW, SHGFI_SYSICONINDEX, SHIL_EXTRALARGE,
        SHIL_JUMBO,
    };
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;

    let wide: Vec<u16> = OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // SHGetFileInfoW / SHGetImageList 要求调用线程已初始化 COM。
    // spawn_blocking 的线程池线程没初始化过。S_FALSE（已初始化）和
    // RPC_E_CHANGED_MODE（已被别的模式占用）都算「可继续使用」，
    // 但只有成功返回 S_OK 时才该配对调用 CoUninitialize。
    let mut need_uninit = false;

    let out = (|| -> Option<String> {
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        need_uninit = hr.is_ok();

        // 索引：SHGFI_SYSICONINDEX 让我们能用同一个索引去查 jumbo 列表
        let mut info = SHFILEINFOW::default();
        let ok = unsafe {
            SHGetFileInfoW(
                windows::core::PCWSTR(wide.as_ptr()),
                FILE_FLAGS_AND_ATTRIBUTES(0),
                Some(&mut info),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_SYSICONINDEX,
            )
        };
        if ok == 0 || info.iIcon < 0 {
            return None;
        }
        let index = info.iIcon;

        // 系统超大图标列表（多尺寸，按 DPI 填充）。
        // 某些精简/Server 环境没有 jumbo 列表，退到 SHIL_EXTRALARGE（48），
        // 仍比原来的 32 好，且不会因为拿不到 jumbo 就整个没有原生图标。
        let list: IImageList = unsafe { SHGetImageList(SHIL_JUMBO as i32) }
            .or_else(|_| unsafe { SHGetImageList(SHIL_EXTRALARGE as i32) })
            .ok()?;

        // ILD_TRANSPARENT 保留 alpha
        let hicon = unsafe { list.GetIcon(index, ILD_TRANSPARENT.0) }.ok()?;
        if hicon.is_invalid() {
            return None;
        }

        let png = unsafe { draw_to_png(hicon, target) };
        let _ = unsafe { DestroyIcon(hicon) };
        png
    })();

    if need_uninit {
        unsafe { CoUninitialize() };
    }
    out
}

#[cfg(not(windows))]
unsafe fn extract(_path: &str, _target: i32) -> Option<String> {
    None
}

/// 把 HICON 画进 32 位 DIB，按需缩放后编码 PNG。
///
/// 尺寸取自图标自身的颜色位图（`GetObjectW` + `BITMAP`），不用
/// `IImageList::GetIconSize`：后者返回列表槽位尺寸（固定 256），
/// 而图标内容可能是更小的档位，按槽位画会在四周留透明边，显示时显得偏小。
///
/// 缩小用自写的盒式滤波（见 `downsample`）而不是 GDI 的拉伸模式：
/// DrawIconEx 的缩放质量受 DC 拉伸模式影响、行为不易验证，
/// 而盒式滤波对 alpha 的处理是确定的（预乘平均，不会出现黑边）。
#[cfg(windows)]
unsafe fn draw_to_png(
    hicon: windows::Win32::UI::WindowsAndMessaging::HICON,
    target: i32,
) -> Option<String> {
    use windows::Win32::Graphics::Gdi::{
        BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CreateCompatibleDC, CreateDIBSection,
        DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetObjectW, HBITMAP, HDC, HGDIOBJ,
        ReleaseDC, SelectObject,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DI_NORMAL, DrawIconEx, GetIconInfo, ICONINFO,
    };

    // 图标自身的位图尺寸最可靠（jumbo 列表内容尺寸可能小于槽位）
    let mut w: i32 = 256;
    let mut h: i32 = 256;
    let mut ii = ICONINFO::default();
    if unsafe { GetIconInfo(hicon, &mut ii) }.is_ok() {
        if !ii.hbmColor.is_invalid() {
            let mut bm = BITMAP::default();
            let n = unsafe {
                GetObjectW(
                    HGDIOBJ(ii.hbmColor.0),
                    std::mem::size_of::<BITMAP>() as i32,
                    Some(&mut bm as *mut _ as *mut core::ffi::c_void),
                )
            };
            if n > 0 && bm.bmWidth > 0 && bm.bmHeight > 0 {
                w = bm.bmWidth;
                h = bm.bmHeight;
            }
        }
        // 掩码/颜色位图必须删除，否则句柄泄漏
        if !ii.hbmMask.is_invalid() {
            let _ = unsafe { DeleteObject(HGDIOBJ(ii.hbmMask.0)) };
        }
        if !ii.hbmColor.is_invalid() {
            let _ = unsafe { DeleteObject(HGDIOBJ(ii.hbmColor.0)) };
        }
    }
    let (w, h) = (w.clamp(1, 1024), h.clamp(1, 1024));

    let screen: HDC = unsafe { GetDC(None) };
    if screen.is_invalid() {
        return None;
    }
    let mem: HDC = unsafe { CreateCompatibleDC(Some(screen)) };
    if mem.is_invalid() {
        unsafe { ReleaseDC(None, screen) };
        return None;
    }

    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h, // 负数 = 自上而下，行序与 PNG 一致
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };

    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
    let dib: HBITMAP =
        match unsafe { CreateDIBSection(Some(mem), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) } {
            Ok(b) => b,
            Err(_) => {
                let _ = unsafe { DeleteDC(mem) };
                unsafe { ReleaseDC(None, screen) };
                return None;
            }
        };
    if bits.is_null() {
        let _ = unsafe { DeleteObject(HGDIOBJ(dib.0)) };
        let _ = unsafe { DeleteDC(mem) };
        unsafe { ReleaseDC(None, screen) };
        return None;
    }

    let old = unsafe { SelectObject(mem, HGDIOBJ(dib.0)) };
    let drawn = unsafe { DrawIconEx(mem, 0, 0, hicon, w, h, 0, None, DI_NORMAL) }.is_ok();
    unsafe { SelectObject(mem, old) };

    let png = if drawn {
        let bgra = unsafe {
            std::slice::from_raw_parts(bits as *const u8, (w as usize) * (h as usize) * 4)
        };
        let rgba = bgra_to_rgba(bgra);

        // 需要缩小且确实比目标大才缩；放大交给前端（放大只会更糊，没有收益）
        let t = target.clamp(0, 1024);
        if t > 0 && t < w.max(h) {
            let (tw, th) = (t, t);
            let small = downsample(&rgba, w as u32, h as u32, tw as u32, th as u32);
            encode_png(&small, tw as u32, th as u32)
        } else {
            encode_png(&rgba, w as u32, h as u32)
        }
    } else {
        None
    };

    let _ = unsafe { DeleteObject(HGDIOBJ(dib.0)) };
    let _ = unsafe { DeleteDC(mem) };
    unsafe { ReleaseDC(None, screen) };
    png
}

/// BGRA → RGBA。
///
/// DrawIconEx 在 32 位 DIB 上输出 BGRA；不带 alpha 通道的图标 alpha 全为 0，
/// 这类像素按不透明处理（否则整图透明不可见）。
/// 这个判断必须在缩小之前做：否则无 alpha 的图标缩小后全透明。
#[cfg(windows)]
fn bgra_to_rgba(bgra: &[u8]) -> Vec<u8> {
    let has_alpha = bgra.chunks_exact(4).any(|p| p[3] != 0);
    let mut rgba = Vec::with_capacity(bgra.len());
    for p in bgra.chunks_exact(4) {
        let a = if has_alpha { p[3] } else { 255 };
        rgba.extend_from_slice(&[p[2], p[1], p[0], a]);
    }
    rgba
}

/// 盒式滤波缩小 RGBA 图。
///
/// 按「预乘 alpha 平均、再反预乘」计算：直接平均非预乘的 RGB 会让
/// 透明像素（RGB 常为 0）把边缘拉暗，出现黑边。
#[cfg(windows)]
fn downsample(src: &[u8], sw: u32, sh: u32, tw: u32, th: u32) -> Vec<u8> {
    let mut out = vec![0u8; (tw as usize) * (th as usize) * 4];
    let xr = sw as f64 / tw as f64;
    let yr = sh as f64 / th as f64;

    for ty in 0..th {
        let y0 = (ty as f64 * yr).floor() as u32;
        let y1 = (((ty + 1) as f64 * yr).ceil() as u32).clamp(y0 + 1, sh);
        for tx in 0..tw {
            let x0 = (tx as f64 * xr).floor() as u32;
            let x1 = (((tx + 1) as f64 * xr).ceil() as u32).clamp(x0 + 1, sw);

            let (mut sr, mut sg, mut sb, mut sa, mut n) = (0.0f64, 0.0, 0.0, 0.0, 0.0);
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = ((y * sw + x) * 4) as usize;
                    let a = src[i + 3] as f64 / 255.0;
                    sr += src[i] as f64 * a;
                    sg += src[i + 1] as f64 * a;
                    sb += src[i + 2] as f64 * a;
                    sa += a;
                    n += 1.0;
                }
            }

            let o = ((ty * tw + tx) * 4) as usize;
            if n == 0.0 || sa == 0.0 {
                continue; // 全透明，保持 0
            }
            out[o] = (sr / sa).round().clamp(0.0, 255.0) as u8;
            out[o + 1] = (sg / sa).round().clamp(0.0, 255.0) as u8;
            out[o + 2] = (sb / sa).round().clamp(0.0, 255.0) as u8;
            out[o + 3] = ((sa / n) * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// 把 RGBA 像素编码为 PNG，返回 data URL。
#[cfg(windows)]
fn encode_png(rgba: &[u8], w: u32, h: u32) -> Option<String> {
    use base64::Engine;

    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&out);
    Some(format!("data:image/png;base64,{b64}"))
}

#[cfg(not(windows))]
fn encode_png(_rgba: &[u8], _w: u32, _h: u32) -> Option<String> {
    None
}
