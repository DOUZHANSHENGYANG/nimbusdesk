//! Read-only document text extraction. Called inside the isolated worker only.
//!
//! No Office automation, macros, external XML entities, or network requests.
use quick_xml::{Reader, events::Event};
use std::{
    fs::File,
    io::{Cursor, Read},
    path::Path,
};

const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 4096;
const MAX_MEMBER_BYTES: u64 = 8 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

pub fn extract_file(path: &Path) -> Result<String, String> {
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let file = File::open(path).map_err(|e| format!("无法读取文档：{e}"))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("无法读取文档属性：{e}"))?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return Err("文档不是普通文件，或超过 32 MB 读取上限".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取文档失败：{e}"))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("文档超过 32 MB 读取上限".into());
    }
    let mut text = match extension.as_str() {
        "doc" | "xls" | "ppt" => {
            #[cfg(windows)]
            {
                ifilter_text(path).map_err(|error| {
                    format!("旧版 Office 文档无法提取：{error}；可另存为 DOCX/XLSX/PPTX 或 PDF")
                })?
            }
            #[cfg(not(windows))]
            {
                return Err("旧版 Office 正文提取需要 Windows 系统 IFilter".into());
            }
        }
        "docx" | "xlsx" | "pptx" => office_text(&bytes, &extension)?,
        "pdf" => pdf_text(&bytes)?,
        "xml" => xml_text(&decode_text(&bytes)?, false)?,
        "txt" | "md" | "markdown" | "json" | "jsonc" | "toml" | "yaml" | "yml" | "csv" | "log"
        | "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "java" | "c" | "cpp" | "h" | "hpp"
        | "css" | "html" | "sql" | "ini" | "conf" | "sh" | "ps1" | "kt" | "cs" | "go" | "rb"
        | "scss" | "vue" | "svelte" => decode_text(&bytes)?,
        _ => return Err("此文件格式暂不支持正文索引".into()),
    };
    // Keep the IPC result bounded, including text containing binary control bytes.
    text.retain(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'));
    if text.len() > MAX_TEXT_BYTES {
        let mut end = MAX_TEXT_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    if text.trim().is_empty() {
        return Err(if extension == "pdf" {
            "PDF 没有可提取的文本层；扫描件需要 OCR（当前未启用）".into()
        } else {
            "文档没有可提取的正文".into()
        });
    }
    Ok(text)
}

fn pdf_text(bytes: &[u8]) -> Result<String, String> {
    let mut document = lopdf::Document::load_mem(bytes)
        .map_err(|_| "PDF 无法读取，文件可能损坏或使用不支持的结构".to_string())?;
    if document.is_encrypted() {
        // Empty owner-password PDFs may be readable; never guess or persist passwords.
        document
            .decrypt("")
            .map_err(|_| "PDF 已加密，需要密码，未建立正文索引".to_string())?;
    }
    let pages: Vec<u32> = document.get_pages().keys().copied().collect();
    document
        .extract_text(&pages)
        .map_err(|_| "PDF 无法提取正文，文本编码可能不受支持".into())
}

#[cfg(windows)]
fn ifilter_text(path: &Path) -> Result<String, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::{
            Storage::IndexServer::{
                CHUNK_TEXT, FILTER_E_END_OF_CHUNKS, FILTER_E_NO_MORE_TEXT, FILTER_E_NO_TEXT,
                FILTER_S_LAST_TEXT, IFILTER_INIT_APPLY_INDEX_ATTRIBUTES,
                IFILTER_INIT_CANON_PARAGRAPHS, IFILTER_INIT_CANON_SPACES,
                IFILTER_INIT_DISABLE_EMBEDDED, IFilter, LoadIFilter, STAT_CHUNK,
            },
            System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize},
        },
        core::{IUnknown, Interface, PCWSTR, PWSTR},
    };
    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err("文档路径包含无效字符".into());
    }
    wide.push(0);
    // This code only runs inside the killable worker, never the WebView process.
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|e| format!("初始化系统过滤器失败：{e}"))?;
    }
    let _com = ComGuard;
    let mut raw = std::ptr::null_mut();
    unsafe { LoadIFilter(PCWSTR(wide.as_ptr()), None::<&IUnknown>, &mut raw) }
        .map_err(|e| format!("本机未提供可用的文档 IFilter，或过滤器无法读取此文件（{e}）"))?;
    if raw.is_null() {
        return Err("系统没有返回可用的文档 IFilter".into());
    }
    let unknown = unsafe { IUnknown::from_raw(raw) };
    let filter: IFilter = unknown.cast().map_err(|_| "系统文档过滤器不支持文本接口")?;
    let mut flags = 0u32;
    let result = unsafe {
        filter.Init(
            (IFILTER_INIT_CANON_PARAGRAPHS.0
                | IFILTER_INIT_CANON_SPACES.0
                | IFILTER_INIT_APPLY_INDEX_ATTRIBUTES.0
                | IFILTER_INIT_DISABLE_EMBEDDED.0) as u32,
            &[],
            &mut flags,
        )
    };
    if result < 0 {
        return Err(format!(
            "系统文档过滤器初始化失败（0x{:08X}）",
            result as u32
        ));
    }
    let mut output = String::new();
    let mut text_calls = 0usize;
    for _ in 0..16_384 {
        let mut chunk = STAT_CHUNK::default();
        let result = unsafe { filter.GetChunk(&mut chunk) };
        if result == FILTER_E_END_OF_CHUNKS.0 {
            return Ok(output);
        }
        if result < 0 {
            return Err(format!("读取文档段落失败（0x{:08X}）", result as u32));
        }
        if chunk.flags.0 & CHUNK_TEXT.0 == 0 {
            continue;
        }
        loop {
            text_calls += 1;
            if text_calls > 65_536 {
                return Err("系统过滤器文本块数量超过上限".into());
            }
            let mut buffer = [0u16; 4096];
            let mut count = buffer.len() as u32;
            let result = unsafe { filter.GetText(&mut count, PWSTR(buffer.as_mut_ptr())) };
            if result == FILTER_E_NO_MORE_TEXT.0 || result == FILTER_E_NO_TEXT.0 {
                break;
            }
            if result < 0 {
                return Err(format!("读取文档文本失败（0x{:08X}）", result as u32));
            }
            if count as usize > buffer.len() {
                return Err("系统过滤器返回了无效文本长度".into());
            }
            append(
                &mut output,
                &String::from_utf16_lossy(&buffer[..count as usize]),
            )?;
            if result == FILTER_S_LAST_TEXT.0 || count == 0 {
                break;
            }
        }
        append(&mut output, "\n")?;
    }
    Err("系统过滤器段落数量超过上限".into())
}

fn decode_text(bytes: &[u8]) -> Result<String, String> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        if bytes.len() % 2 != 0 {
            return Err("UTF-16 文档长度无效".into());
        }
        let little = bytes[0] == 0xff;
        let words: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|b| {
                if little {
                    u16::from_le_bytes([b[0], b[1]])
                } else {
                    u16::from_be_bytes([b[0], b[1]])
                }
            })
            .collect();
        return String::from_utf16(&words).map_err(|_| "UTF-16 文档编码无效".into());
    }
    String::from_utf8(
        bytes
            .strip_prefix(&[0xef, 0xbb, 0xbf])
            .unwrap_or(bytes)
            .to_vec(),
    )
    .map_err(|_| "文档不是受支持的 UTF-8/UTF-16 文本编码".into())
}

fn office_text(bytes: &[u8], extension: &str) -> Result<String, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| "Office 文件不是有效的 ZIP/XML 文档".to_string())?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err("Office 压缩包条目数量超过上限".into());
    }
    let mut unpacked = 0u64;
    let mut members = Vec::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| "无法读取 Office 压缩包目录（可能加密或损坏）".to_string())?;
        let name = entry.name().map_err(|_| "Office 压缩包文件名编码无效")?;
        let wanted = match extension {
            "docx" => {
                name == "word/document.xml"
                    || name == "word/footnotes.xml"
                    || name == "word/endnotes.xml"
                    || (name.starts_with("word/header") || name.starts_with("word/footer"))
                        && name.ends_with(".xml")
            }
            "xlsx" => {
                name == "xl/sharedStrings.xml"
                    || name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml")
            }
            "pptx" => name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
            _ => false,
        };
        if wanted {
            unpacked = unpacked
                .checked_add(entry.size())
                .ok_or("Office 累计解压大小超过上限")?;
            if entry.size() > MAX_MEMBER_BYTES || unpacked > MAX_UNPACKED_BYTES {
                return Err("Office 文档超过单项 8 MB 或累计 64 MB 解压上限".into());
            }
            members.push((name.to_string(), index));
        }
    }
    // Natural numeric ordering: slide2 before slide10; document body precedes footnotes.
    members.sort_by_key(|(name, _)| {
        let digits: String = name.chars().filter(char::is_ascii_digit).collect();
        let primary = if name == "word/document.xml" { 0 } else { 1 };
        (primary, digits.parse::<u64>().unwrap_or(0), name.clone())
    });
    let mut actual_unpacked = 0u64;
    let mut read_member =
        |archive: &mut zip::ZipArchive<Cursor<&[u8]>>, index| -> Result<String, String> {
            let entry = archive
                .by_index(index)
                .map_err(|_| "读取 Office XML 失败".to_string())?;
            let mut bytes = Vec::new();
            entry
                .take(MAX_MEMBER_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "解压 Office XML 失败".to_string())?;
            if bytes.len() as u64 > MAX_MEMBER_BYTES {
                return Err("Office XML 解压超过上限".into());
            }
            actual_unpacked = actual_unpacked.saturating_add(bytes.len() as u64);
            if actual_unpacked > MAX_UNPACKED_BYTES {
                return Err("Office XML 累计解压超过上限".into());
            }
            decode_text(&bytes)
        };
    let shared = if extension == "xlsx" {
        if let Some((_, index)) = members
            .iter()
            .find(|(name, _)| name == "xl/sharedStrings.xml")
        {
            shared_strings(&read_member(&mut archive, *index)?)?
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };
    let mut output = String::new();
    for (name, index) in members {
        if name == "xl/sharedStrings.xml" {
            continue;
        }
        let xml = read_member(&mut archive, index)?;
        let text = if extension == "xlsx" {
            sheet_text(&xml, &shared)?
        } else {
            xml_text(&xml, true)?
        };
        append(&mut output, &text)?;
        append(&mut output, "\n")?;
    }
    Ok(output)
}

fn append(output: &mut String, text: &str) -> Result<(), String> {
    if output.len().saturating_add(text.len()) > MAX_TEXT_BYTES {
        return Err("文档正文超过 2 MB 提取上限".into());
    }
    output.push_str(text);
    Ok(())
}

fn entity(reference: &quick_xml::events::BytesRef<'_>) -> Result<String, String> {
    if let Some(c) = reference
        .resolve_char_ref()
        .map_err(|_| "XML 字符引用无效")?
    {
        return Ok(c.to_string());
    }
    Ok(
        match reference.decode().map_err(|_| "XML 字符编码无效")?.as_ref() {
            "amp" => "&",
            "lt" => "<",
            "gt" => ">",
            "quot" => "\"",
            "apos" => "'",
            _ => return Err("不支持自定义 XML 实体引用".into()),
        }
        .into(),
    )
}

fn xml_text(xml: &str, office: bool) -> Result<String, String> {
    let mut reader = Reader::from_str(xml);
    let mut output = String::new();
    let mut text_depth = 0usize;
    let mut depth = 0usize;
    loop {
        match reader.read_event().map_err(|_| "XML 结构无效或已损坏")? {
            Event::Start(e) => {
                depth += 1;
                if depth > 256 {
                    return Err("XML 嵌套层级超过上限".into());
                }
                if e.local_name().as_ref() == b"t" {
                    text_depth = depth;
                }
            }
            Event::Text(e) if !office || text_depth > 0 => {
                append(&mut output, &e.decode().map_err(|_| "XML 文本编码无效")?)?
            }
            Event::CData(e) if !office || text_depth > 0 => {
                append(&mut output, &e.decode().map_err(|_| "XML 文本编码无效")?)?
            }
            Event::GeneralRef(e) if !office || text_depth > 0 => append(&mut output, &entity(&e)?)?,
            Event::End(e) => {
                if text_depth == depth {
                    text_depth = 0;
                }
                if matches!(
                    e.local_name().as_ref(),
                    b"p" | b"tr" | b"tc" | b"title" | b"body"
                ) {
                    append(&mut output, "\n")?;
                }
                depth = depth.saturating_sub(1);
            }
            Event::Empty(e) if matches!(e.local_name().as_ref(), b"br" | b"tab") => {
                append(&mut output, "\n")?
            }
            Event::DocType(_) => return Err("为安全起见不解析含 DTD 的 XML 文档".into()),
            Event::Eof => break,
            _ => {}
        }
    }
    if depth != 0 {
        return Err("XML 文档未完整闭合".into());
    }
    Ok(output)
}

fn shared_strings(xml: &str) -> Result<Vec<String>, String> {
    let mut reader = Reader::from_str(xml);
    let mut values = Vec::new();
    let mut value = String::new();
    let mut inside = false;
    let mut text = false;
    let mut total = 0usize;
    loop {
        match reader
            .read_event()
            .map_err(|_| "XLSX 共享字符串 XML 无效")?
        {
            Event::Empty(e) if e.local_name().as_ref() == b"si" => {
                if values.len() >= 100_000 {
                    return Err("XLSX 共享字符串超过上限".into());
                }
                values.push(String::new());
            }
            Event::Start(e) if e.local_name().as_ref() == b"si" => {
                inside = true;
                value.clear();
            }
            Event::Start(e) if inside && e.local_name().as_ref() == b"t" => text = true,
            Event::Text(e) if text => {
                append(&mut value, &e.decode().map_err(|_| "XLSX 字符编码无效")?)?
            }
            Event::CData(e) if text => {
                append(&mut value, &e.decode().map_err(|_| "XLSX 字符编码无效")?)?
            }
            Event::GeneralRef(e) if text => append(&mut value, &entity(&e)?)?,
            Event::End(e) if e.local_name().as_ref() == b"t" => text = false,
            Event::End(e) if e.local_name().as_ref() == b"si" => {
                total = total.saturating_add(value.len());
                if total > MAX_TEXT_BYTES || values.len() >= 100_000 {
                    return Err("XLSX 共享字符串超过上限".into());
                }
                values.push(std::mem::take(&mut value));
                inside = false;
            }
            Event::DocType(_) => return Err("不支持含 DTD 的 XLSX XML".into()),
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(values)
}

fn sheet_text(xml: &str, shared: &[String]) -> Result<String, String> {
    let mut reader = Reader::from_str(xml);
    let mut output = String::new();
    let mut value = String::new();
    let mut cell_type = String::new();
    let mut capture = false;
    loop {
        match reader.read_event().map_err(|_| "XLSX 工作表 XML 无效")? {
            Event::Start(e) if e.local_name().as_ref() == b"c" => {
                value.clear();
                cell_type.clear();
                for attr in e.attributes() {
                    let attr = attr.map_err(|_| "XLSX 单元格属性无效")?;
                    if attr.key.as_ref() == b"t" {
                        cell_type = String::from_utf8_lossy(&attr.value).into_owned();
                    }
                }
            }
            Event::Start(e) if matches!(e.local_name().as_ref(), b"v" | b"t") => capture = true,
            Event::Text(e) if capture => {
                append(&mut value, &e.decode().map_err(|_| "XLSX 单元格编码无效")?)?
            }
            Event::CData(e) if capture => {
                append(&mut value, &e.decode().map_err(|_| "XLSX 单元格编码无效")?)?
            }
            Event::GeneralRef(e) if capture => append(&mut value, &entity(&e)?)?,
            Event::End(e) if matches!(e.local_name().as_ref(), b"v" | b"t") => capture = false,
            Event::End(e) if e.local_name().as_ref() == b"c" => {
                if cell_type == "s" {
                    let index = value
                        .trim()
                        .parse::<usize>()
                        .map_err(|_| "XLSX 共享字符串索引无效")?;
                    append(
                        &mut output,
                        shared.get(index).ok_or("XLSX 共享字符串索引越界")?,
                    )?;
                } else {
                    append(&mut output, &value)?;
                }
                append(&mut output, "\t")?;
            }
            Event::End(e) if e.local_name().as_ref() == b"row" => append(&mut output, "\n")?,
            Event::DocType(_) => return Err("不支持含 DTD 的 XLSX XML".into()),
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/search/fixtures")
            .join(name)
    }

    #[test]
    fn extracts_docx_paragraphs_tables_and_notes_without_metadata() {
        let text = extract_file(&fixture("document.docx")).unwrap();
        assert!(text.contains("开发知识 & 搜索"), "{text}");
        assert!(text.contains("表格内容"), "{text}");
        assert!(text.contains("脚注文本"), "{text}");
        assert!(!text.contains("secret metadata"));
    }

    #[test]
    fn extracts_xlsx_shared_inline_and_numeric_cells() {
        let text = extract_file(&fixture("workbook.xlsx")).unwrap();
        assert!(text.contains("共享字符串"), "{text}");
        assert!(text.contains("内联内容"), "{text}");
        assert!(text.contains("42"), "{text}");
        assert!(!text.contains("未引用文本"));
    }

    #[test]
    fn extracts_pptx_in_slide_number_order() {
        let text = extract_file(&fixture("presentation.pptx")).unwrap();
        assert!(text.find("第二页").unwrap() < text.find("第十页").unwrap());
    }

    #[test]
    fn extracts_chinese_text_layer_pdf() {
        let text = extract_file(&fixture("chinese-text.pdf")).unwrap();
        assert!(text.contains("开发知识"), "{text}");
        assert!(text.contains("Office PDF"), "{text}");
    }

    #[test]
    fn rejects_corrupt_zip_pdf_and_legacy_documents_clearly() {
        for name in ["corrupt.docx", "corrupt.pdf", "legacy.doc"] {
            let error = extract_file(&fixture(name)).unwrap_err();
            assert!(!error.is_empty());
        }
        assert!(
            extract_file(&fixture("legacy.doc"))
                .unwrap_err()
                .contains("旧版")
        );
    }

    #[test]
    fn xml_preserves_entities_and_rejects_dtd() {
        let text = extract_file(&fixture("sample.xml")).unwrap();
        assert!(text.contains("你好 & 世界"), "{text}");
        assert!(extract_file(&fixture("external-entity.xml")).is_err());
    }

    #[test]
    fn limits_zip_member_decompression() {
        assert!(
            extract_file(&fixture("oversized.docx"))
                .unwrap_err()
                .contains("上限")
        );
    }

    #[test]
    fn limits_cumulative_zip_decompression_and_entry_count() {
        for name in ["cumulative.docx", "too-many.docx"] {
            assert!(extract_file(&fixture(name)).unwrap_err().contains("上限"));
        }
    }

    #[test]
    fn extracts_complete_office_packages_from_normal_producers() {
        for (name, expected) in [
            ("real-document.docx", "知识配方"),
            ("real-workbook.xlsx", "计划附件"),
            ("real-presentation.pptx", "桌面工作台"),
        ] {
            let text = extract_file(&fixture(name)).unwrap();
            assert!(text.contains(expected), "{name}: {text}");
        }
    }

    #[test]
    fn scanned_and_password_protected_pdfs_are_reported() {
        assert!(
            extract_file(&fixture("scanned.pdf"))
                .unwrap_err()
                .contains("OCR")
        );
        assert!(
            extract_file(&fixture("encrypted.pdf"))
                .unwrap_err()
                .contains("加密")
        );
    }

    #[test]
    fn utf16_text_and_numeric_xml_entities_are_decoded() {
        let bytes: Vec<u8> = [0xff, 0xfe]
            .into_iter()
            .chain("开发知识".encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        assert_eq!(decode_text(&bytes).unwrap(), "开发知识");
        assert_eq!(xml_text("<r>&#x4F60;&#22909;</r>", false).unwrap(), "你好");
        assert!(decode_text(&[0xff, 0xfe, 0]).is_err());
    }

    #[test]
    fn xlsx_empty_shared_string_keeps_its_index() {
        let values = shared_strings("<sst><si/><si><t>第二个值</t></si></sst>").unwrap();
        assert_eq!(values, ["", "第二个值"]);
    }

    #[test]
    fn skips_large_media_members_without_decompressing_them() {
        assert!(
            extract_file(&fixture("large-image.docx"))
                .unwrap()
                .contains("带大图的文档")
        );
    }

    #[cfg(windows)]
    #[test]
    fn installed_ifilter_can_extract_a_plain_text_probe() {
        let text = ifilter_text(&fixture("ifilter-probe.txt")).unwrap();
        assert!(text.contains("开发知识"), "{text}");
    }

    #[test]
    fn reads_go_and_vue_sources_as_plain_text() {
        let directory = std::env::temp_dir().join(format!(
            "nimbus-extract-source-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        for (name, text) in [
            ("sample.go", "package main // 中文正文"),
            ("sample.vue", "<template>开发工具</template>"),
        ] {
            let path = directory.join(name);
            std::fs::write(&path, text).unwrap();
            let result = extract_file(&path);
            std::fs::remove_file(&path).unwrap();
            assert_eq!(result.unwrap(), text);
        }
        std::fs::remove_dir(&directory).unwrap();
    }
}
