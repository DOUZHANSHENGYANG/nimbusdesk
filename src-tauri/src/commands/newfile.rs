//! 新建文件的初始内容。
//!
//! 背景：Windows 的「新建 → Word 文档」并不是创建空文件，而是把注册表
//! `HKCR\<.ext>\ShellNew` 指向的模板复制一份。我们之前只 `File::create`，
//! 于是 .docx/.xlsx/.pptx 都是 0 字节空壳，Word/WPS 打开会报「文件已损坏」。
//!
//! 取值顺序（与资源管理器一致，注册表优先）：
//!   1. `HKCR\<.ext>\ShellNew`     → Data / FileName / NullFile
//!   2. `HKCR\<progid>\ShellNew`   → 同上（progid 由 `HKCR\<.ext>` 默认值给出）
//!   3. 内置模板（docx/xlsx/pptx/png/zip）
//!   4. 都没有 → 0 字节文件（txt/md/json/html 这类本就该是空的）
//!
//! `Command` 型 ShellNew（如 WPS 的 AI 建文档）需要拉起外部程序，这里不处理，
//! 直接退回内置模板。
//!
//! 注意：只读注册表。绿色便携的约束是「不写注册表」，读取没有副作用。

/// 内置模板：扩展名小写、不带点。
fn embedded(ext: &str) -> Option<&'static [u8]> {
    Some(match ext {
        "docx" => include_bytes!("../../assets/blank.docx").as_slice(),
        "xlsx" => include_bytes!("../../assets/blank.xlsx").as_slice(),
        "pptx" => include_bytes!("../../assets/blank.pptx").as_slice(),
        "png" => include_bytes!("../../assets/blank.png").as_slice(),
        "zip" => include_bytes!("../../assets/blank.zip").as_slice(),
        _ => return None,
    })
}

/// 从路径里取出小写扩展名（不含点）。
fn ext_of(name: &str) -> Option<String> {
    let stem_end = name.rfind('.').filter(|i| *i > 0)?;
    let ext = &name[stem_end + 1..];
    if ext.is_empty() {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

/// 新建文件应写入的字节。`None` 表示写空文件。
pub fn payload_for(name: &str) -> Option<Vec<u8>> {
    let ext = ext_of(name)?;

    #[cfg(windows)]
    if let Some(bytes) = from_registry(&ext) {
        return Some(bytes);
    }

    embedded(&ext).map(|b| b.to_vec())
}

/* ─────────────────────── Windows 注册表读取 ─────────────────────── */

#[cfg(windows)]
fn from_registry(ext: &str) -> Option<Vec<u8>> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_SUCCESS, WIN32_ERROR};
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CLASSES_ROOT, RRF_RT_ANY, REG_BINARY, REG_VALUE_TYPE, RegGetValueW,
    };

    /// 读一个注册表值，返回 (类型, 原始字节)。不存在返回 None。
    fn read(hive: HKEY, subkey: &str, value: &str) -> Option<(REG_VALUE_TYPE, Vec<u8>)> {
        let sub_w: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
        let val_w: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();

        // 第一遍只问长度
        let mut size: u32 = 0;
        let rc: WIN32_ERROR = unsafe {
            RegGetValueW(
                hive,
                PCWSTR(sub_w.as_ptr()),
                PCWSTR(val_w.as_ptr()),
                RRF_RT_ANY,
                None,
                None,
                Some(&mut size),
            )
        };
        if rc != ERROR_SUCCESS || size == 0 {
            return None;
        }

        // 第二遍真正读；字符串含结尾 NUL，多留 2 字节余量
        let mut buf = vec![0u8; size as usize + 2];
        let mut ty = REG_VALUE_TYPE::default();
        let mut size2 = buf.len() as u32;
        let rc: WIN32_ERROR = unsafe {
            RegGetValueW(
                hive,
                PCWSTR(sub_w.as_ptr()),
                PCWSTR(val_w.as_ptr()),
                RRF_RT_ANY,
                Some(&mut ty),
                Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                Some(&mut size2),
            )
        };
        if rc != ERROR_SUCCESS {
            return None;
        }
        buf.truncate(size2 as usize);
        Some((ty, buf))
    }

    /// 注册表字符串 → Rust String（去掉结尾 NUL）。
    fn as_string(bytes: &[u8]) -> Option<String> {
        if bytes.len() < 2 {
            return None;
        }
        let u16s: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|c| *c != 0)
            .collect();
        String::from_utf16(&u16s).ok()
    }

    /// 展开 %SystemRoot% / %windir%（模板路径里最常见）。
    fn expand(path: &str) -> String {
        let windir = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        path.replace("%SystemRoot%", &windir)
            .replace("%windir%", &windir)
            .replace("%WINDIR%", &windir)
    }

    /// 解析一个 ShellNew 键。返回 None 表示这个键没给出可用内容。
    fn from_shellnew(shellnew: &str) -> Option<Vec<u8>> {
        // NullFile：显式声明「新建出来就是空文件」（.txt/.lnk 等）
        if read(HKEY_CLASSES_ROOT, shellnew, "NullFile").is_some() {
            return None;
        }
        // Data：内容直接内联在注册表里（不常见但合法）
        if let Some((ty, bytes)) = read(HKEY_CLASSES_ROOT, shellnew, "Data")
            && ty == REG_BINARY
            && !bytes.is_empty()
        {
            return Some(bytes);
        }
        // FileName：指向模板文件，相对名默认落在 %SystemRoot%\ShellNew
        if let Some((_, raw)) = read(HKEY_CLASSES_ROOT, shellnew, "FileName") {
            let name = as_string(&raw)?;
            let name = expand(&name);
            let p = std::path::Path::new(&name);
            let full = if p.is_absolute() {
                p.to_path_buf()
            } else {
                let windir = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
                std::path::Path::new(&windir).join("ShellNew").join(p)
            };
            return std::fs::read(full).ok().filter(|b| !b.is_empty());
        }
        // Command 型需要拉起外部程序，这里不支持 → 退回内置模板
        None
    }

    // 1) 扩展名自己的 ShellNew
    let ext_key = format!(".{ext}");
    if let Some(bytes) = from_shellnew(&format!("{ext_key}\\ShellNew")) {
        return Some(bytes);
    }

    // 2) progid 上的 ShellNew
    if let Some((_, raw)) = read(HKEY_CLASSES_ROOT, &ext_key, "")
        && let Some(progid) = as_string(&raw).filter(|s| !s.is_empty())
        && let Some(bytes) = from_shellnew(&format!("{progid}\\ShellNew"))
    {
        return Some(bytes);
    }

    None
}

/* ────────────────────────────── 测试 ────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ext_parsing() {
        assert_eq!(ext_of("a.docx").as_deref(), Some("docx"));
        assert_eq!(ext_of("新建 Word 文档.DOCX").as_deref(), Some("docx"));
        assert_eq!(ext_of("noext"), None);
        assert_eq!(ext_of(".gitignore"), None, "点开头不算有扩展名");
        assert_eq!(ext_of("trailing."), None);
    }

    /// 内置模板必须是真的 zip（OOXML 都是 zip 容器）。
    #[test]
    fn embedded_templates_are_wellformed() {
        for ext in ["docx", "xlsx", "pptx", "zip"] {
            let bytes = embedded(ext).unwrap_or_else(|| panic!("{ext} 缺内置模板"));
            // 空 zip 模板正好 22 字节（仅 EOCD），故用 >=
            assert!(bytes.len() >= 22, "{ext} 太小，不可能是有效 zip");
            assert_eq!(&bytes[..2], b"PK", "{ext} 缺 zip 魔数");
        }
        let png = embedded("png").unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "png 魔数不对");
    }

    /// 解析出的负载必须是完整可打开的 OOXML，不能是空壳。
    #[test]
    fn payload_resolves_for_office() {
        for name in [
            "新建 Word 文档.docx",
            "新建 Excel 工作表.xlsx",
            "新建 PowerPoint 演示文稿.pptx",
        ] {
            let bytes = payload_for(name).unwrap_or_else(|| panic!("{name} 没有解析出内容"));
            assert!(bytes.len() > 500, "{name} 内容过小，疑似空壳");
            assert!(
                bytes.windows(4).any(|w| w == b"PK\x05\x06"),
                "{name} 缺 zip 中央目录结尾"
            );
        }
    }

    /// 纯文本类应该是空文件（不塞垃圾内容）。
    #[test]
    fn plain_text_has_no_payload() {
        assert!(payload_for("新建文本文档.txt").is_none());
        assert!(payload_for("a.md").is_none());
        assert!(payload_for("a.json").is_none());
    }

}
