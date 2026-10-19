//! 提取 Windows 原生图标（资源管理器/桌面同款），返回 PNG data URL。
//!
//! 按目标尺寸选择系统图像列表。JUMBO 的槽位固定为 256，旧图标可能
//! 只占其中 32 像素，不能直接把整个槽位缩小。保留 alpha 并处理这类空边。

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime};

/// Bounded successful-icon cache, invalidated by file metadata and a short TTL.
/// Failed/offline lookups must never become permanent negative entries.
struct CachedIcon {
    value: String,
    modified: Option<SystemTime>,
    len: u64,
    stored: Instant,
}

fn cache() -> &'static Mutex<HashMap<String, CachedIcon>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedIcon>>> = OnceLock::new();
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
    let size = size.clamp(0, 256);
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok();
    let key = format!("{path}\u{1}{size}");
    if let Some(hit) = cache().lock().ok().and_then(|c| {
        c.get(&key)
            .filter(|v| {
                v.modified == modified
                    && v.len == meta.len()
                    && v.stored.elapsed() < Duration::from_secs(300)
            })
            .map(|v| v.value.clone())
    }) {
        return Some(hit);
    }
    let result = unsafe { extract(path, size) };
    if let Ok(mut c) = cache().lock() {
        c.remove(&key);
        if let Some(value) = &result {
            if c.len() >= 512 {
                if let Some(oldest) = c
                    .iter()
                    .min_by_key(|(_, v)| v.stored)
                    .map(|(k, _)| k.clone())
                {
                    c.remove(&oldest);
                }
            }
            c.insert(
                key,
                CachedIcon {
                    value: value.clone(),
                    modified,
                    len: meta.len(),
                    stored: Instant::now(),
                },
            );
        }
    }
    result
}

#[cfg(not(windows))]
fn extract_cached(_path: &str, _size: i32) -> Option<String> {
    None
}

#[cfg(windows)]
unsafe fn shortcut_default_icon_target(path: &str) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    if !std::path::Path::new(path).extension()?.eq_ignore_ascii_case("lnk") {
        return None;
    }
    let link: IShellLinkW = unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }.ok()?;
    let file: IPersistFile = link.cast().ok()?;
    let wide: Vec<u16> = std::ffi::OsStr::new(path).encode_wide().chain(Some(0)).collect();
    unsafe { file.Load(PCWSTR(wide.as_ptr()), STGM_READ) }.ok()?;
    let mut icon = vec![0u16; 32768];
    let mut index = 0;
    unsafe { link.GetIconLocation(&mut icon, &mut index) }.ok()?;
    // Respect user-selected shortcut icons; only inherit when no override exists.
    if icon[0] != 0 { return None; }
    let mut target = vec![0u16; 32768];
    // Read the stored path only. Never Resolve/Save, launch, or modify the link.
    unsafe { link.GetPath(&mut target, std::ptr::null_mut(), 0) }.ok()?;
    let length = target.iter().position(|value| *value == 0)?;
    let target = String::from_utf16(&target[..length]).ok()?;
    if target.is_empty() || !std::path::Path::new(&target).exists() { return None; }
    Some(target)
}

#[cfg(windows)]
unsafe fn extract(path: &str, target: i32) -> Option<String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize};
    use windows::Win32::UI::Controls::{IImageList, ILD_TRANSPARENT};
    use windows::Win32::UI::Shell::{
        SHFILEINFOW, SHGFI_SYSICONINDEX, SHGetFileInfoW, SHGetImageList, SHDefExtractIconW, SHIL_EXTRALARGE,
        SHIL_JUMBO, SHIL_LARGE, SHIL_SMALL,
    };
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;

    // Shell APIs do not consistently accept canonicalized extended-length paths.
    let shell_path = if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
    };
    // SHGetFileInfoW / SHGetImageList 要求调用线程已初始化 COM。
    // spawn_blocking 的线程池线程没初始化过。S_FALSE（已初始化）和
    // RPC_E_CHANGED_MODE（已被别的模式占用）都算「可继续使用」，
    // 成功（包括 S_FALSE）时配对 CoUninitialize，模式冲突时不配对。
    let mut need_uninit = false;

    let out = (|| -> Option<String> {
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        need_uninit = hr.is_ok();

        let inherited = unsafe { shortcut_default_icon_target(&shell_path) };
        let icon_path = inherited.as_deref().unwrap_or(&shell_path).replace('/', "\\");
        let wide: Vec<u16> = OsStr::new(&icon_path).encode_wide().chain(Some(0)).collect();

        // The Shell image-list cache can retain a generic white-page icon for
        // portable executables. Read their actual resource instead of that cache.
        let resource = std::path::Path::new(&icon_path).extension().is_some_and(|ext|
            ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("ico"));
        if resource {
            let mut hicon = windows::Win32::UI::WindowsAndMessaging::HICON::default();
            let hr = unsafe { SHDefExtractIconW(windows::core::PCWSTR(wide.as_ptr()), 0, 0,
                Some(&mut hicon), None, if target > 0 { target as u32 } else { 256 }) };
            if !hicon.is_invalid() {
                let png = if hr.is_ok() { unsafe { draw_to_png(hicon, target) } } else { None };
                let _ = unsafe { DestroyIcon(hicon) };
                if png.is_some() { return png; }
            }
        }

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

        let list_size = match target {
            1..=16 => SHIL_SMALL,
            17..=32 => SHIL_LARGE,
            33..=48 => SHIL_EXTRALARGE,
            _ => SHIL_JUMBO,
        };
        let list: IImageList = unsafe { SHGetImageList(list_size as i32) }
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
/// Draw at the icon bitmap size, then normalize excessive transparent canvas.
/// Even GetIconInfo may expose the full padded jumbo slot for a legacy icon.
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
        BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection,
        DIB_RGB_COLORS, DeleteDC, DeleteObject, GdiFlush, GetDC, GetObjectW, HBITMAP, HDC, HGDIOBJ,
        ReleaseDC, SelectObject,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DI_MASK, DI_NORMAL, DrawIconEx, GetIconInfo, ICONINFO,
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

    // CreateDIBSection memory is not guaranteed to be initialized. Transparent pixels
    // must start at zero rather than inheriting stale heap contents.
    unsafe { std::ptr::write_bytes(bits as *mut u8, 0, (w * h * 4) as usize) };
    let old = unsafe { SelectObject(mem, HGDIOBJ(dib.0)) };
    let drawn = unsafe { DrawIconEx(mem, 0, 0, hicon, w, h, 0, None, DI_NORMAL) }.is_ok();
    let _ = unsafe { GdiFlush() };
    let png = if drawn {
        let bgra = unsafe {
            std::slice::from_raw_parts(bits as *const u8, (w as usize) * (h as usize) * 4)
        }
        .to_vec();
        // Old masked icons have no alpha. Read their AND mask rather than making
        // the entire (possibly padded) bitmap opaque.
        let mask = if bgra.chunks_exact(4).all(|p| p[3] == 0) {
            let mask_drawn =
                unsafe { DrawIconEx(mem, 0, 0, hicon, w, h, 0, None, DI_MASK) }.is_ok();
            let _ = unsafe { GdiFlush() };
            mask_drawn.then(|| unsafe {
                std::slice::from_raw_parts(bits as *const u8, (w * h * 4) as usize).to_vec()
            })
        } else {
            None
        };
        let rgba = bgra_to_rgba(&bgra, mask.as_deref());
        let (rgba, w, h) = normalize_icon_bounds(rgba, w as u32, h as u32);

        // 需要缩小且确实比目标大才缩；放大交给前端（放大只会更糊，没有收益）
        let t = target.clamp(0, 1024);
        if t > 0 && (t as u32) < w.max(h) {
            let (tw, th) = (t, t);
            let small = downsample(&rgba, w, h, tw as u32, th as u32);
            encode_png(&small, tw as u32, th as u32)
        } else {
            encode_png(&rgba, w, h)
        }
    } else {
        None
    };

    unsafe { SelectObject(mem, old) };
    let _ = unsafe { DeleteObject(HGDIOBJ(dib.0)) };
    let _ = unsafe { DeleteDC(mem) };
    unsafe { ReleaseDC(None, screen) };
    png
}

/// BGRA → RGBA。
///
/// DrawIconEx outputs premultiplied BGRA. PNG expects straight RGBA; legacy
/// icons without alpha use their AND mask instead of an opaque rectangle.
#[cfg(windows)]
fn bgra_to_rgba(bgra: &[u8], mask: Option<&[u8]>) -> Vec<u8> {
    let has_alpha = bgra.chunks_exact(4).any(|p| p[3] != 0);
    let mut rgba = Vec::with_capacity(bgra.len());
    for (i, p) in bgra.chunks_exact(4).enumerate() {
        let a = if has_alpha {
            p[3]
        } else {
            mask.map(|m| 255 - m[i * 4]).unwrap_or(0)
        };
        let straight = |c: u8| {
            if has_alpha && a > 0 {
                ((c as u32 * 255) / a as u32).min(255) as u8
            } else {
                c
            }
        };
        rgba.extend_from_slice(&[straight(p[2]), straight(p[1]), straight(p[0]), a]);
    }
    rgba
}

/// Legacy icons in a jumbo list occupy a small corner of a fixed-size slot.
/// Only remove excessive empty canvas; retain ordinary icon padding.
#[cfg(windows)]
fn normalize_icon_bounds(rgba: Vec<u8>, w: u32, h: u32) -> (Vec<u8>, u32, u32) {
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for y in 0..h {
        for x in 0..w {
            if rgba[((y * w + x) * 4 + 3) as usize] > 8 {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x + 1);
                y1 = y1.max(y + 1);
            }
        }
    }
    if x1 <= x0 || y1 <= y0 || (x1 - x0) * 2 > w || (y1 - y0) * 2 > h {
        return (rgba, w, h);
    }
    let side = (x1 - x0).max(y1 - y0);
    let mut out = vec![0; (side * side * 4) as usize];
    let ox = (side - (x1 - x0)) / 2;
    let oy = (side - (y1 - y0)) / 2;
    for y in y0..y1 {
        let src = ((y * w + x0) * 4) as usize;
        let dst = (((y - y0 + oy) * side + ox) * 4) as usize;
        let len = ((x1 - x0) * 4) as usize;
        out[dst..dst + len].copy_from_slice(&rgba[src..src + len]);
    }
    (out, side, side)
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

    if !rgba.chunks_exact(4).any(|p| p[3] > 0) {
        return None;
    }

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

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    struct ShortcutFixture(std::path::PathBuf);
    impl ShortcutFixture {
        fn create() -> Self {
            let root = std::env::temp_dir().join(format!(
                "nimbus-icon-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&root).unwrap();
            let script = r#"
Add-Type -AssemblyName System.Drawing
$stream = [System.IO.File]::Create((Join-Path $env:NIMBUS_ICON_TEST_DIR 'small.ico'))
[System.Drawing.SystemIcons]::Information.Save($stream)
$stream.Dispose()
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path $env:NIMBUS_ICON_TEST_DIR 'small.lnk'))
$link.TargetPath = (Join-Path $env:WINDIR 'System32\notepad.exe')
$link.IconLocation = (Join-Path $env:NIMBUS_ICON_TEST_DIR 'small.ico')
$link.Save()
$plain = $shell.CreateShortcut((Join-Path $env:NIMBUS_ICON_TEST_DIR 'plain.lnk'))
$plain.TargetPath = (Join-Path $env:WINDIR 'System32\notepad.exe')
$plain.Save()
"#;
            let output = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .env("NIMBUS_ICON_TEST_DIR", &root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "owned Windows shortcut fixture must be created"
            );
            Self(root)
        }
    }
    impl Drop for ShortcutFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn shortcut_without_custom_icon_uses_its_target_image() {
        let fixture = ShortcutFixture::create();
        let target = std::path::PathBuf::from(std::env::var_os("WINDIR").unwrap()).join("System32").join("notepad.exe");
        let plain = fixture.0.join("plain.lnk");
        let expected = unsafe { extract(&target.to_string_lossy(), 48) }.expect("target icon");
        assert!(unsafe { extract(&plain.to_string_lossy(), 48) }.as_ref() == Some(&expected), "default shortcut must inherit its target icon");
    }

    #[test]
    fn shortcut_small_resource_is_visible_at_requested_size() {
        let fixture = ShortcutFixture::create();
        let path = fixture.0.join("small.lnk").canonicalize().unwrap();
        for size in [32, 64] {
            let url = unsafe { extract(&path.to_string_lossy(), size) }
                .expect("owned shortcut icon, including canonical paths");
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(url.split_once(',').unwrap().1)
                .unwrap();
            let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
                .read_info()
                .unwrap();
            let mut pixels = vec![0; reader.output_buffer_size()];
            let info = reader.next_frame(&mut pixels).unwrap();
            let visible = pixels[..info.buffer_size()]
                .chunks_exact(4)
                .filter(|p| p[3] > 32)
                .count();
            let coverage = visible as f64 / (info.width * info.height) as f64;
            println!("owned {size} px shortcut icon coverage: {coverage:.3}");
            assert!(
                coverage > 0.2,
                "Shell jumbo padding must not shrink the actual icon into a dot"
            );
            assert!(info.width <= size as u32 && info.height <= size as u32);
        }
    }

    #[test]
    fn empty_icons_are_rejected_and_alpha_mask_is_preserved() {
        assert!(encode_png(&[0, 0, 0, 0], 1, 1).is_none());
        assert_eq!(bgra_to_rgba(&[0, 32, 64, 128], None), vec![127, 63, 0, 128]);
        assert_eq!(
            bgra_to_rgba(
                &[0, 0, 0, 0, 0, 0, 255, 0],
                Some(&[255, 255, 255, 0, 0, 0, 0, 0])
            ),
            vec![0, 0, 0, 0, 255, 0, 0, 255]
        );
        let mut pixels = vec![0; 256 * 256 * 4];
        for y in 0..32 {
            for x in 0..32 {
                pixels[(y * 256 + x) * 4 + 3] = 255;
            }
        }
        let (cropped, w, h) = normalize_icon_bounds(pixels, 256, 256);
        assert_eq!((w, h), (32, 32));
        assert_eq!(cropped.len(), 32 * 32 * 4);
        let (ordinary, w, h) = normalize_icon_bounds(vec![255; 32 * 32 * 4], 32, 32);
        assert_eq!((ordinary.len(), w, h), (32 * 32 * 4, 32, 32));
    }

    #[test]
    fn missing_files_are_not_cached_as_permanent_failures() {
        let path =
            std::env::temp_dir().join(format!("nimbus-icon-missing-{}.txt", std::process::id()));
        let _ = std::fs::remove_file(&path);
        assert!(extract_cached(&path.to_string_lossy(), 32).is_none());
        let key = format!("{}\u{1}32", path.to_string_lossy());
        assert!(!cache().lock().unwrap().contains_key(&key));
    }
}
