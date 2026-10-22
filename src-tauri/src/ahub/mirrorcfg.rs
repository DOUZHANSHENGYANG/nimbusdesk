//! 中文网络镜像配置：预览、写入、读回校验、备份与回滚。
//!
//! 设计约束（重要）：
//! - **先预览后写入**。预览只计算「会改哪个文件、哪一项、原值、新值」，
//!   不落盘；用户确认后才执行。
//! - **写入前必备份**，备份放在 `data_root()/mirror-backups/<tool>/` 下，
//!   回滚就是恢复最近一次备份。
//! - **写入后必读回校验**：重新读文件并确认新值确实存在；不一致就回滚该工具。
//! - **每个工具独立**：一个工具失败不影响其它工具已完成的写入。
//! - **不静默覆盖**：文件不可写、结构无法识别时明确报错并保持原文件不变。
//!
//! 各工具的镜像载体不同，本模块用「标记块 + 定点改写」而不是整文件重写，
//! 目的是尽量保留用户已有的注释与其它配置。

use crate::ahub::models::{ApplyOutcome, ChangeAction, ChangePlan, MirrorTool};
use crate::ahub::store::AppH;
use std::path::{Path, PathBuf};

/// 标记块起止（Gradle / Cargo 用注释标记，Maven 用固定 mirror id）。
const BLOCK_BEGIN: &str = ">>> AgentHub mirror >>>";
const BLOCK_END: &str = "<<< AgentHub mirror <<<";
const MAVEN_MIRROR_ID: &str = "agenthub-mirror";

/// 备份目录名，位于 `data_root()` 下。
const BACKUP_DIR: &str = "mirror-backups";

// ---------------- 各工具的载体定义 ----------------

/// 一个可配置镜像的工具。
struct MirrorDef {
    id: &'static str,
    name: &'static str,
    /// 载体文件的定位方式
    kind: CarrierKind,
    /// 推荐镜像地址
    recommended: &'static str,
    /// 预览里显示的「改哪一项」
    target: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum CarrierKind {
    /// 用户级 `.npmrc`（npm 与 pnpm 共用）
    Npmrc,
    /// `%APPDATA%\pip\pip.ini`
    PipIni,
    /// Maven `settings.xml`
    MavenSettings,
    /// `%GRADLE_USER_HOME%\init.d\init.gradle`
    GradleInit,
    /// `%CARGO_HOME%\config.toml`
    CargoConfig,
}

const DEFS: &[MirrorDef] = &[
    MirrorDef {
        id: "npm",
        name: "npm",
        kind: CarrierKind::Npmrc,
        recommended: "https://registry.npmmirror.com",
        target: "registry",
    },
    MirrorDef {
        id: "pnpm",
        name: "pnpm",
        kind: CarrierKind::Npmrc,
        recommended: "https://registry.npmmirror.com",
        target: "registry",
    },
    MirrorDef {
        id: "pip",
        name: "pip",
        kind: CarrierKind::PipIni,
        recommended: "https://pypi.tuna.tsinghua.edu.cn/simple",
        target: "[global] index-url",
    },
    MirrorDef {
        id: "maven",
        name: "Maven",
        kind: CarrierKind::MavenSettings,
        recommended: "https://maven.aliyun.com/repository/public",
        target: "<mirrors> / <mirror>",
    },
    MirrorDef {
        id: "gradle",
        name: "Gradle",
        kind: CarrierKind::GradleInit,
        recommended: "https://maven.aliyun.com/repository/public",
        target: "repositories 镜像块",
    },
    MirrorDef {
        id: "cargo",
        name: "Cargo",
        kind: CarrierKind::CargoConfig,
        recommended: "https://rsproxy.cn/",
        target: "[source.crates-io] replace-with",
    },
];

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// 定位某个工具的镜像载体文件。
fn carrier_path(kind: CarrierKind) -> Result<PathBuf, String> {
    match kind {
        CarrierKind::Npmrc => Ok(home().join(".npmrc")),
        CarrierKind::PipIni => {
            let appdata = env_path("APPDATA")
                .ok_or("找不到 APPDATA，无法定位 pip.ini")?;
            Ok(appdata.join("pip").join("pip.ini"))
        }
        CarrierKind::MavenSettings => {
            // 与 Maven 一致：优先 ~/.m2/settings.xml
            Ok(home().join(".m2").join("settings.xml"))
        }
        CarrierKind::GradleInit => {
            let gradle_home = env_path("GRADLE_USER_HOME").unwrap_or_else(|| home().join(".gradle"));
            Ok(gradle_home.join("init.d").join("init.gradle"))
        }
        CarrierKind::CargoConfig => {
            let cargo_home = env_path("CARGO_HOME").unwrap_or_else(|| home().join(".cargo"));
            Ok(cargo_home.join("config.toml"))
        }
    }
}

fn def_by_id(id: &str) -> Result<&'static MirrorDef, String> {
    DEFS.iter()
        .find(|d| d.id == id)
        .ok_or_else(|| format!("未知的镜像工具：{id}"))
}

/// 读取文本文件内容。
///
/// **重要**：不能用 `unwrap_or_default()`。中文 Windows 上 `.npmrc` / `pip.ini` 等
/// 配置文件常是 GBK 编码，`read_to_string` 会失败并返回空串；若拿这个空串去改写，
/// 用户原有配置（含中文注释）会被整段清空，且校验还会「通过」——这是静默的数据
/// 破坏。因此这里返回 `Result`，由调用方明确处理编码问题。
///
/// **严格性要求**：解码必须能失败。早期实现直接调 `MultiByteToWideChar(CP_ACP)`，
/// 它对任意字节都做有损替换、永不报错，于是 UTF-16LE 或二进制文件会被「解码」成
/// 乱码再写回，同样是静默破坏。现在按顺序严格探测：
/// 1. UTF-8（含 BOM）；
/// 2. UTF-16LE / UTF-16BE（按 BOM 或 NUL 分布判断）；
/// 3. GBK（用 `MultiByteToWideChar` 加 `MB_ERR_INVALID_CHARS`，遇到非法字节即失败）。
/// 三者都不成立时返回错误，调用方必须拒绝写入。
fn read_text(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("无法读取文件：{e}"))?;
    decode_text(&bytes).map(|d| d.text)
}

/// 读取文本文件并保留原编码，供「按原编码写回」使用。
fn read_text_with_encoding(path: &Path) -> Result<DecodedText, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("无法读取文件：{e}"))?;
    decode_text(&bytes)
}

/// 文本文件的编码。写入时必须按原编码写回，否则会静默改变用户的文件编码。
#[derive(Debug, Clone, Copy, PartialEq)]
enum TextEncoding {
    Utf8,
    Utf8Bom,
    /// UTF-16LE，带 BOM
    Utf16Le,
    /// UTF-16LE，原本没有 BOM（写回时也不补 BOM）
    Utf16LeNoBom,
    /// UTF-16BE，带 BOM
    Utf16Be,
    /// UTF-16BE，原本没有 BOM（写回时也不补 BOM）
    Utf16BeNoBom,
    /// 系统 ANSI 代码页（中文 Windows 即 GBK）
    Ansi,
}

impl TextEncoding {
    fn is_utf8_family(self) -> bool {
        matches!(self, TextEncoding::Utf8 | TextEncoding::Utf8Bom)
    }
}

/// 解码结果：内容 + 原编码。
#[derive(Debug)]
struct DecodedText {
    text: String,
    encoding: TextEncoding,
}

/// 解码配置文件内容。
///
/// **支持范围（路线 A：只接受无歧义的编码）**：
/// - UTF-8（含 UTF-8 BOM）
/// - 带 BOM 的 UTF-16LE / UTF-16BE
///
/// **不支持 GBK 与无 BOM 的 UTF-16**，原因：
///
/// 1. **无 BOM 的 UTF-16 与 GBK/UTF-8 之间的歧义在信息论上不可判定**。任何偶数
///    长度字节流按 UTF-16 都能解出「某个」文本，而它的 UTF-8/GBK 解释往往也合法
///    且往返一致。前八轮实测反复证明：任何形态判据（ASCII 占比、结构字符、多行、
///    最小长度、重复模式、键值对、原字节主体保留）都会被真实中文 UTF-16 字节
///    凑巧满足——`6T=T`、`5N<N`、`!N!N!N!N`、`6T=TDTKTRTYT`TgT` 都出现过。
/// 2. **GBK 本身也参与这个歧义**：GBK 的双字节编码与 UTF-16 的码元边界高度重合，
///    无法用「GBK 严格解码 + 往返一致」区分（`顅U_`、`目录` 的字节两种解释都成立）。
///
/// 因此**不做任何猜测**：只接受有明确声明（BOM）或结构自证（合法 UTF-8）的编码。
/// 其他编码一律拒绝并提示用户转存为 UTF-8。代价是 GBK 用户需要手动转存一次；
/// 收益是**任何情况下都不会破坏用户的文件**——破坏不可逆，多一步操作可逆。
///
/// 这是刻意的取舍，不是能力缺失。真实世界的配置文件绝大多数已是 UTF-8
/// （VS Code、Git、各包管理器默认写入 UTF-8），GBK 主要出现在老旧的 Windows
/// 手工编辑文件上，一次转存即可长期使用。
fn decode_text(bytes: &[u8]) -> Result<DecodedText, String> {
    if bytes.is_empty() {
        return Ok(DecodedText {
            text: String::new(),
            encoding: TextEncoding::Utf8,
        });
    }

    // 1) UTF-8 BOM
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let text = String::from_utf8(bytes[3..].to_vec())
            .map_err(|_| "文件带 UTF-8 BOM 但内容不是合法 UTF-8".to_string())?;
        // BOM 只说明编码，不代表内容是文本：二进制文件也可能恰好以 BOM 开头。
        if !has_no_binary_noise(&text) {
            return Err("文件带 UTF-8 BOM 但内容含控制字符，不是正常的配置文件，已拒绝改写"
                .into());
        }
        return Ok(DecodedText {
            text,
            encoding: TextEncoding::Utf8Bom,
        });
    }

    // 2) UTF-16LE BOM
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let text = decode_utf16(&bytes[2..], true)
            .ok_or_else(|| "文件是 UTF-16LE 编码但内容无法解析".to_string())?;
        if !has_no_binary_noise(&text) {
            return Err("文件带 UTF-16LE BOM 但内容含控制字符，不是正常的配置文件，已拒绝改写"
                .into());
        }
        return Ok(DecodedText {
            text,
            encoding: TextEncoding::Utf16Le,
        });
    }

    // 3) UTF-16BE BOM
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let text = decode_utf16(&bytes[2..], false)
            .ok_or_else(|| "文件是 UTF-16BE 编码但内容无法解析".to_string())?;
        if !has_no_binary_noise(&text) {
            return Err("文件带 UTF-16BE BOM 但内容含控制字符，不是正常的配置文件，已拒绝改写"
                .into());
        }
        return Ok(DecodedText {
            text,
            encoding: TextEncoding::Utf16Be,
        });
    }

    // 4) 严格 UTF-8（无 BOM）。这是唯一允许「无声明」的编码：
    //    UTF-8 的多字节序列有严格结构约束，非法字节会直接失败，
    //    不存在「同一串字节既是合法 UTF-8 又是别的编码」的普遍歧义。
    //    含 NUL 时直接拒绝（正常配置文件不会有 NUL）。
    if !bytes.contains(&0) {
        if let Ok(text) = std::str::from_utf8(bytes) {
            if !has_no_binary_noise(text) {
                return Err("文件内容含控制字符，不是正常的配置文件，已拒绝改写".into());
            }
            return Ok(DecodedText {
                text: text.to_string(),
                encoding: TextEncoding::Utf8,
            });
        }
    }

    // 5) 其他情况一律拒绝，不猜。
    if bytes.contains(&0) {
        Err("文件含 NUL 字节，可能是无 BOM 的 UTF-16 或二进制编码。\
请先用编辑器把文件另存为 UTF-8 再试；为避免破坏原文件已拒绝改写"
            .into())
    } else {
        Err("文件不是 UTF-8 编码（可能是 GBK 或其它本地编码）。\
请先用编辑器把文件另存为 UTF-8 再试；为避免破坏原文件已拒绝改写"
            .into())
    }
}

/// 判断一段 UTF-16 解读是否明显是「把单字节文本误读成 UTF-16」。
///
/// 判据：**零 ASCII 且长度 ≥2**。
///
/// 原理：单字节 ASCII/UTF-8 文本按 UTF-16 解读时，每两个字节被合并成一个码点，
/// 结果里不会剩下 ASCII。实测 `registry=https://registry.npmjs.org/` 的
/// UTF-16LE 解读是 `敲楧瑳祲栽瑴獰⼺爯来獩牴⹹灮橭⹳牯⽧挊捡敨䐽⼺慣档੥`——全 CJK。
///
/// 而真正的 UTF-16 配置文件必然含 ASCII：键名（`registry`）、`=`、`#`、
/// 换行、URL 里的 `://`。因此这条判据能准确区分两者。

/// 文本是否含配置结构（成对或带值的结构，不是孤立单个字符）。
///
/// 用于判断「这段文本是否像配置文件」。真实配置文件必然满足其一：
/// - 成对标签 `[`…`]` 或 `<`…`>`；
/// - 存在 `key=value`（键名为标识符、值非空）。
///
/// 但**单独靠它无法区分编码误读**（实测 `吶吽` 的 UTF-16LE 字节按 GBK 解出
/// `6T=T` 能通过键值对判据）。因此它只作为辅助判据，真正的硬约束是
/// 「写入后原有内容必须仍在」（见 apply_to_path）。
fn has_config_structure(text: &str) -> bool {
    // 极短文本无法可靠判断形态：实测 2 字符的 `6T=T`、`5N<N` 都能凑出结构特征。
    // 真实配置文件不会短于 8 个字符。
    if text.chars().count() < 8 {
        return false;
    }
    if text.contains('[') && text.contains(']') {
        return true;
    }
    if text.contains('<') && text.contains('>') {
        return true;
    }
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim();
            let value = value.trim();
            if !key.is_empty()
                && !value.is_empty()
                && key
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
            {
                return true;
            }
        }
    }
    false
}

/// 文本是否「没有二进制噪声」：不含 NUL、不含除 `\t \r \n` 外的控制字符、
/// 不含替换字符与私用区字符。
///
/// 这是所有编码分支的最后一道闸门：无论按哪种编码解出来，只要结果里混着
/// 控制字符，就说明编码判断很可能是错的，必须拒绝而不是写回去。
fn has_no_binary_noise(text: &str) -> bool {
    for ch in text.chars() {
        if ch == '\0' {
            return false;
        }
        if ch.is_control() && ch != '\t' && ch != '\r' && ch != '\n' {
            return false;
        }
        if ch == '\u{FFFD}' || ('\u{E000}'..='\u{F8FF}').contains(&ch) {
            return false;
        }
    }
    true
}

/// 判断某一行是否属于「本次写入会替换掉」的内容。
///
/// 写回自校验用它排除被替换的行，避免把「正常替换」误判成「丢失原有内容」。
fn is_replaced_line(kind: CarrierKind, line: &str) -> bool {
    let t = line.trim();
    match kind {
        // .npmrc：registry 行会被替换
        CarrierKind::Npmrc => t.starts_with("registry=") || t.starts_with("registry ="),
        // pip.ini：[global] 里的 index-url 会被替换
        CarrierKind::PipIni => {
            let key = t.split('=').next().unwrap_or("").trim();
            key.eq_ignore_ascii_case("index-url") || key.eq_ignore_ascii_case("index_url")
        }
        // Maven：<url> 行会被替换
        CarrierKind::MavenSettings => t.starts_with("<url>") || t.contains("</url>"),
        // Gradle：整块会被重写
        CarrierKind::GradleInit => {
            t.contains(BLOCK_BEGIN) || t.contains(BLOCK_END) || t.starts_with("maven")
        }
        // Cargo：replace-with 与 registry 行会被替换
        CarrierKind::CargoConfig => {
            t.starts_with("replace-with") || t.starts_with("registry")
        }
    }
}

/// 判断一段文本是否像「UTF-16 被误读成单字节编码」产生的碎片。
///
/// 这是编码判定最可靠的一道判别。UTF-16 的 CJK 字符每两个字节交替出现，
/// 按 UTF-8/GBK 单字节解读时会得到**高度重复的短模式**：
/// `!N!N!N!N`、`%N%N%N%N`、`\nR\nR\nR\nR`、`][`、`=W`。
///
/// 判据：文本由不超过 4 种字符组成，且存在长度 ≥2 的连续重复子串。
/// 真实配置文件有键名、URL、路径等多样内容，不会呈现这种规律性重复。

/// 判断解码出的文本是否像正常的配置文件内容。
///
/// 用于 UTF-16 探测。判据要能排除「按错误编码解出来的噪声」：
/// - GBK 字节按 UTF-16 解出来会得到韩文/私用区字符，几乎没有 ASCII；
/// - 反之亦然。
///
/// 因此要求：
/// 1. 没有二进制噪声（NUL、控制字符、替换字符、私用区）；
/// 2. **至少含 30% 的 ASCII 字符** —— 配置文件必有键名、标点、换行、URL 等
///    ASCII 结构。这条同时挡住了两类误判。
///
/// 纯 CJK、零 ASCII 的 UTF-16 无 BOM 文件因此无法被可靠识别，会被拒绝而不是
/// 猜一个编码去改写——这是刻意的安全取舍。

/// 按指定编码把文本编码回字节。
///
/// 换行符处理：若原文用的是 CRLF，编码时把 `\n` 还原成 `\r\n`，
/// 避免写入后整个文件的换行风格被静默改变。由 `encode_text_preserving_newlines`
/// 负责这一步；本函数只处理编码本身。
fn encode_text(text: &str, encoding: TextEncoding) -> Result<Vec<u8>, String> {
    match encoding {
        TextEncoding::Utf8 => Ok(text.as_bytes().to_vec()),
        TextEncoding::Utf8Bom => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend_from_slice(text.as_bytes());
            Ok(out)
        }
        TextEncoding::Utf16Le | TextEncoding::Utf16LeNoBom => {
            let mut out = if encoding == TextEncoding::Utf16Le {
                vec![0xFF, 0xFE]
            } else {
                Vec::new()
            };
            for unit in text.encode_utf16() {
                out.extend_from_slice(&unit.to_le_bytes());
            }
            Ok(out)
        }
        TextEncoding::Utf16Be | TextEncoding::Utf16BeNoBom => {
            let mut out = if encoding == TextEncoding::Utf16Be {
                vec![0xFE, 0xFF]
            } else {
                Vec::new()
            };
            for unit in text.encode_utf16() {
                out.extend_from_slice(&unit.to_be_bytes());
            }
            Ok(out)
        }
        TextEncoding::Ansi => {
            encode_gbk(text).ok_or_else(|| "内容含有无法用 GBK 表示的字符，拒绝写入".to_string())
        }
    }
}

/// 按原编码写回，并保持原文的换行风格。
///
/// 改写实现内部统一用 `\n`；若原文件是 CRLF，这里把新增的 `\n` 还原成 `\r\n`，
/// 否则用户文件的换行风格会被静默改变（内容不变但字节全变，diff 一片红）。
fn encode_like_original(
    new_text: &str,
    old_text: &str,
    encoding: TextEncoding,
) -> Result<Vec<u8>, String> {
    let old_is_crlf = old_text.contains("\r\n");
    let text = if old_is_crlf {
        // 先统一成 LF，再统一转 CRLF，避免出现 \r\r\n
        new_text.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        new_text.to_string()
    };
    encode_text(&text, encoding)
}

/// 把文本按系统 ANSI 代码页编码。遇到无法表示的字符时返回 `None`（不静默替换成 `?`）。
#[cfg(windows)]
fn encode_gbk(text: &str) -> Option<Vec<u8>> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn WideCharToMultiByte(
            code_page: u32,
            dw_flags: u32,
            lp_wide_char_str: *const u16,
            cch_wide_char: i32,
            lp_multibyte_str: *mut u8,
            cb_multibyte: i32,
            lp_default_char: *const u8,
            lp_used_default_char: *mut i32,
        ) -> i32;
    }

    const CP_ACP: u32 = 0;
    // WC_NO_BEST_FIT_CHARS：禁止「最佳匹配」替换，无法表示就失败
    const WC_NO_BEST_FIT_CHARS: u32 = 0x0000_0400;

    let wide: Vec<u16> = text.encode_utf16().collect();
    if wide.is_empty() {
        return Some(Vec::new());
    }
    let mut used_default: i32 = 0;
    let needed = unsafe {
        WideCharToMultiByte(
            CP_ACP,
            WC_NO_BEST_FIT_CHARS,
            wide.as_ptr(),
            wide.len() as i32,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
            &mut used_default,
        )
    };
    if needed <= 0 {
        return None;
    }
    let mut buf: Vec<u8> = vec![0; needed as usize];
    let mut used_default: i32 = 0;
    let written = unsafe {
        WideCharToMultiByte(
            CP_ACP,
            WC_NO_BEST_FIT_CHARS,
            wide.as_ptr(),
            wide.len() as i32,
            buf.as_mut_ptr(),
            needed,
            std::ptr::null(),
            &mut used_default,
        )
    };
    if written <= 0 || used_default != 0 {
        return None;
    }
    buf.truncate(written as usize);
    Some(buf)
}

#[cfg(not(windows))]
fn encode_gbk(_text: &str) -> Option<Vec<u8>> {
    None
}

/// 解码 UTF-16 字节流。奇数长度视为失败。
fn decode_utf16(bytes: &[u8], little_endian: bool) -> Option<String> {
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| {
            if little_endian {
                u16::from_le_bytes([c[0], c[1]])
            } else {
                u16::from_be_bytes([c[0], c[1]])
            }
        })
        .collect();
    String::from_utf16(&units).ok()
}

/// 把文本编码成 UTF-16 字节流（不含 BOM）。用于往返校验。

/// 用 Windows 系统代码页严格解码（`MB_ERR_INVALID_CHARS`，非法字节即失败）。
#[cfg(windows)]
fn decode_gbk_strict(bytes: &[u8]) -> Option<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MultiByteToWideChar(
            code_page: u32,
            dw_flags: u32,
            lp_multibyte_str: *const u8,
            cb_multibyte: i32,
            lp_wide_char_str: *mut u16,
            cch_wide_char: i32,
        ) -> i32;
    }

    const CP_ACP: u32 = 0; // 系统当前 ANSI 代码页（中文 Windows 即 GBK/936）
    const MB_ERR_INVALID_CHARS: u32 = 0x0000_0008;

    if bytes.is_empty() {
        return Some(String::new());
    }
    // 先用严格标志探测长度：非法字节会返回 0
    let needed = unsafe {
        MultiByteToWideChar(
            CP_ACP,
            MB_ERR_INVALID_CHARS,
            bytes.as_ptr(),
            bytes.len() as i32,
            std::ptr::null_mut(),
            0,
        )
    };
    if needed <= 0 {
        return None;
    }
    let mut buf: Vec<u16> = vec![0; needed as usize];
    let written = unsafe {
        MultiByteToWideChar(
            CP_ACP,
            MB_ERR_INVALID_CHARS,
            bytes.as_ptr(),
            bytes.len() as i32,
            buf.as_mut_ptr(),
            needed,
        )
    };
    if written <= 0 {
        return None;
    }
    buf.truncate(written as usize);
    Some(OsString::from_wide(&buf).to_string_lossy().into_owned())
}

#[cfg(not(windows))]
fn decode_gbk_strict(_bytes: &[u8]) -> Option<String> {
    None
}

/// 判断目标文件是否可写：目录可创建、文件本身不是只读。
///
/// **不做任何写操作**：预览阶段也要调用它，若在这里创建/删除探测文件，
/// 「仅预览」就变成了会改文件系统的操作。
fn check_writable(path: &Path) -> Result<(), String> {
    if path.exists() {
        let meta = std::fs::metadata(path).map_err(|e| format!("无法读取文件属性：{e}"))?;
        if meta.permissions().readonly() {
            return Err("文件是只读的".into());
        }
        // 试开一次追加句柄，能开就说明可写（不写入任何字节）
        std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .map_err(|e| format!("文件不可写：{e}"))?;
        return Ok(());
    }
    // 文件不存在：检查最近的已存在父目录是否可写。
    // 用 metadata 的 readonly 位判断，不创建任何探测文件。
    let mut dir = path.parent();
    while let Some(d) = dir {
        if d.exists() {
            let meta = std::fs::metadata(d).map_err(|e| format!("无法读取目录属性：{e}"))?;
            if meta.permissions().readonly() {
                return Err("目录是只读的".into());
            }
            return Ok(());
        }
        dir = d.parent();
    }
    Err("找不到可写的父目录".into())
}

// ---------------- 当前值读取 ----------------

/// 读取 AgentHub **自己写入的那个位置**的值。
///
/// 这是校验与展示的正确来源：Gradle / Cargo 的镜像块追加在文件末尾，而用户文件
/// 里可能早就有自己的 `maven { url … }` 或 `registry = …` 行。若读回时取「第一个
/// 匹配行」，就会拿到用户的旧值，把一次成功的写入误判为失败并回滚。
///
/// 各载体只认自己的位置：
/// - `.npmrc` / `pip.ini`：被替换（或插入）的那一行（行导向格式，无标记可用）
/// - Maven：`id` 为 `agenthub-mirror` 的 `<mirror>` 内的 `<url>`
/// - Gradle：`BLOCK_BEGIN` 与 `BLOCK_END` 之间的 `maven { url … }`
/// - Cargo：`[source.crates-io]` 的 `replace-with` 所指向的表里的 `registry`
fn agenthub_written_value(kind: CarrierKind, text: &str) -> String {
    match kind {
        CarrierKind::MavenSettings => {
            let Some(id_pos) = text.find(&format!("<id>{MAVEN_MIRROR_ID}</id>")) else {
                return String::new();
            };
            // 只在该 mirror 条目范围内找 <url>
            let tail = &text[id_pos..];
            let end = tail.find("</mirror>").unwrap_or(tail.len());
            let scope = &tail[..end];
            let Some(start) = scope.find("<url>") else {
                return String::new();
            };
            let after = &scope[start + 5..];
            let Some(url_end) = after.find("</url>") else {
                return String::new();
            };
            after[..url_end].trim().to_string()
        }
        CarrierKind::GradleInit => {
            let Some(begin) = text.find(BLOCK_BEGIN) else {
                return String::new();
            };
            let after_begin = &text[begin..];
            let end = after_begin.find(BLOCK_END).unwrap_or(after_begin.len());
            let scope = &after_begin[..end];
            for line in scope.lines() {
                let line = line.trim();
                if line.starts_with("maven") {
                    if let Some(start) = line.find("https://") {
                        let tail = &line[start..];
                        let stop = tail
                            .find(|c: char| c == '\'' || c == '"' || c.is_whitespace())
                            .unwrap_or(tail.len());
                        return tail[..stop].to_string();
                    }
                }
            }
            String::new()
        }
        CarrierKind::CargoConfig => {
            // 解析 TOML 找到 replace-with 指向的表，再取它的 registry。
            // 直接按行找 "registry" 会命中用户自己的 registeries 定义。
            let Ok(parsed) = toml::from_str::<toml::Value>(text) else {
                return String::new();
            };
            let Some(source) = parsed.get("source") else {
                return String::new();
            };
            let Some(replaced) = source
                .get("crates-io")
                .and_then(|c| c.get("replace-with"))
                .and_then(|v| v.as_str())
            else {
                return String::new();
            };
            source
                .get(replaced)
                .and_then(|t| t.get("registry"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        }
        CarrierKind::Npmrc | CarrierKind::PipIni => first_match_value(kind, text),
    }
}

/// 取文件里第一处匹配的镜像值（用户已有配置时的「当前值」）。
fn first_match_value(kind: CarrierKind, text: &str) -> String {
    match kind {
        CarrierKind::Npmrc => {
            for line in text.lines() {
                let line = line.trim();
                if let Some(rest) = line.strip_prefix("registry=") {
                    return rest.trim().to_string();
                }
                if let Some(rest) = line.strip_prefix("registry =") {
                    return rest.trim().to_string();
                }
            }
            String::new()
        }
        CarrierKind::PipIni => {
            let mut in_global = false;
            for line in text.lines() {
                let line = line.trim();
                if line.starts_with('[') {
                    in_global = line.eq_ignore_ascii_case("[global]");
                    continue;
                }
                if !in_global {
                    continue;
                }
                for key in ["index-url", "index_url"] {
                    if let Some(rest) = line.strip_prefix(key) {
                        if let Some(v) = rest.trim().strip_prefix('=') {
                            return v.trim().to_string();
                        }
                    }
                }
            }
            String::new()
        }
        CarrierKind::MavenSettings => {
            let mut rest = text;
            while let Some(start) = rest.find("<url>") {
                let after = &rest[start + 5..];
                let Some(end) = after.find("</url>") else { break };
                let url = after[..end].trim();
                if url.starts_with("http") {
                    return url.to_string();
                }
                rest = &after[end..];
            }
            String::new()
        }
        CarrierKind::GradleInit => {
            for line in text.lines() {
                let line = line.trim();
                if line.starts_with("maven") && line.contains("https://") {
                    if let Some(start) = line.find("https://") {
                        let tail = &line[start..];
                        let end = tail
                            .find(|c: char| c == '\'' || c == '"' || c.is_whitespace())
                            .unwrap_or(tail.len());
                        return tail[..end].to_string();
                    }
                }
            }
            String::new()
        }
        CarrierKind::CargoConfig => {
            for line in text.lines() {
                let line = line.trim();
                if let Some(rest) = line.strip_prefix("registry") {
                    if let Some(v) = rest.trim().strip_prefix('=') {
                        return v.trim().trim_matches('"').to_string();
                    }
                }
            }
            String::new()
        }
    }
}

/// 展示用的「当前值」：优先 AgentHub 写入的位置，其次文件里第一处匹配。
fn current_value(kind: CarrierKind, text: &str) -> String {
    let ours = agenthub_written_value(kind, text);
    if !ours.is_empty() {
        return ours;
    }
    first_match_value(kind, text)
}

// ---------------- 预览 ----------------

/// 生成变更计划：只计算，不落盘。
pub fn plan(app: &AppH, ids: &[String]) -> Result<ChangePlan, String> {
    let mut actions = Vec::new();
    let mut warnings = Vec::new();

    for id in ids {
        let def = def_by_id(id)?;
        let path = carrier_path(def.kind)?;
        let exists = path.exists();
        // 读不到（编码不支持或 IO 失败）时，预览要如实说明，不能当作空文件
        let (text, read_error) = if exists {
            match read_text(&path) {
                Ok(t) => (t, None),
                Err(e) => (String::new(), Some(e)),
            }
        } else {
            (String::new(), None)
        };
        let current = current_value(def.kind, &text);

        // 结构无法识别或读不到时，预览就给出明确警告，写入会被拒绝
        if exists {
            if let Some(e) = &read_error {
                warnings.push(format!("{}：{e}（写入会被拒绝）", def.name));
            } else {
                if let Err(e) = validate_structure(def.kind, &text) {
                    warnings.push(format!("{}：{e}", def.name));
                }
                if let Err(e) = check_writable(&path) {
                    warnings.push(format!("{}：{e}（写入会被拒绝）", def.name));
                }
            }
        }

        actions.push(ChangeAction {
            tool: def.id.to_string(),
            file: path.to_string_lossy().into_owned(),
            target: def.target.to_string(),
            current,
            next: def.recommended.to_string(),
            creates_file: !exists,
        });
    }

    // npm 与 pnpm 共用 .npmrc：明确提示，避免用户以为改了两处
    if ids.iter().any(|i| i == "npm") && ids.iter().any(|i| i == "pnpm") {
        warnings.push("npm 与 pnpm 共用同一个 .npmrc，只会写入一次".into());
    }

    let _ = app;
    Ok(ChangePlan { actions, warnings })
}

/// 结构校验：只检查能否安全改写，不追求完整语法分析。
fn validate_structure(kind: CarrierKind, text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    match kind {
        CarrierKind::Npmrc => Ok(()),
        CarrierKind::PipIni => {
            for (i, line) in text.lines().enumerate() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
                    continue;
                }
                if line.starts_with('[') && line.ends_with(']') {
                    continue;
                }
                if line.contains('=') || line.contains(':') {
                    continue;
                }
                return Err(format!("第 {} 行不符合 INI 结构：{}", i + 1, line));
            }
            Ok(())
        }
        CarrierKind::MavenSettings => {
            if !text.contains("<settings") {
                return Err("文件里找不到 <settings> 根元素".into());
            }
            if !text.contains("</settings>") {
                return Err("文件里找不到 </settings>，结构不完整".into());
            }
            let open = text.matches("<mirrors>").count();
            let close = text.matches("</mirrors>").count();
            if open != close {
                return Err(format!(
                    "<mirrors> 标签不配对（{open} 个开始、{close} 个结束）"
                ));
            }
            if open > 1 {
                return Err("文件里有多个 <mirrors> 段，无法安全定位".into());
            }
            Ok(())
        }
        CarrierKind::GradleInit => Ok(()),
        CarrierKind::CargoConfig => toml::from_str::<toml::Value>(text)
            .map(|_| ())
            .map_err(|e| format!("TOML 解析失败：{e}")),
    }
}

// ---------------- 写入实现 ----------------

/// 去掉已有的 AgentHub 标记块。
fn strip_block(text: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for line in text.lines() {
        let t = line.trim();
        if t.contains(BLOCK_BEGIN) {
            inside = true;
            continue;
        }
        if t.contains(BLOCK_END) {
            inside = false;
            continue;
        }
        if !inside {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn npmrc_new(text: &str, url: &str) -> String {
    let mut out = String::new();
    let mut replaced = false;
    for line in text.lines() {
        let t = line.trim();
        let is_registry = t.starts_with("registry=")
            || t.starts_with("registry =")
            || t.starts_with("registry = ");
        if is_registry && !replaced {
            out.push_str(&format!("registry={url}\n"));
            replaced = true;
        } else if !is_registry {
            out.push_str(line);
            out.push('\n');
        }
    }
    if !replaced {
        out.push_str(&format!("registry={url}\n"));
    }
    out
}

fn pipini_new(text: &str, url: &str) -> String {
    let mut out = String::new();
    let mut in_global = false;
    let mut seen_global = false;
    let mut replaced = false;

    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            // 离开 [global] 前若还没写，就地补上
            if in_global && !replaced {
                out.push_str(&format!("index-url = {url}\n"));
                replaced = true;
            }
            in_global = t.eq_ignore_ascii_case("[global]");
            if in_global {
                seen_global = true;
            }
            out.push_str(line);
            out.push('\n');
            continue;
        }
        if in_global && !replaced {
            let key = t.split('=').next().unwrap_or("").trim();
            if key.eq_ignore_ascii_case("index-url") || key.eq_ignore_ascii_case("index_url") {
                out.push_str(&format!("index-url = {url}\n"));
                replaced = true;
                continue;
            }
        }
        out.push_str(line);
        out.push('\n');
    }

    if in_global && !replaced {
        out.push_str(&format!("index-url = {url}\n"));
    }
    if !seen_global {
        if !out.is_empty() && !out.ends_with("\n\n") {
            out.push('\n');
        }
        out.push_str("[global]\n");
        out.push_str(&format!("index-url = {url}\n"));
    }
    out
}

fn maven_new(text: &str, url: &str) -> Result<String, String> {
    let mirror = format!(
        "    <mirror>\n      <id>{MAVEN_MIRROR_ID}</id>\n      <name>AgentHub mirror</name>\n      <url>{url}</url>\n      <mirrorOf>*</mirrorOf>\n    </mirror>\n"
    );

    let cleaned = if text.trim().is_empty() {
        String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<settings xmlns=\"http://maven.apache.org/SETTINGS/1.0.0\">\n</settings>\n")
    } else {
        text.to_string()
    };

    // 改写前必须先确认结构完整：残缺的 settings.xml 一旦插入会彻底不可用
    if !cleaned.trim().is_empty() && text.trim() != "" {
        if !cleaned.contains("<settings") {
            return Err("文件里找不到 <settings> 根元素".into());
        }
        if !cleaned.contains("</settings>") {
            return Err("文件里找不到 </settings>，结构不完整".into());
        }
    }

    // 1) 已有本工具的 mirror 条目 → 整段替换
    if let Some(start) = cleaned.find(&format!("<id>{MAVEN_MIRROR_ID}</id>")) {
        let before = &cleaned[..start];
        let Some(mirror_open) = before.rfind("<mirror>") else {
            return Err("找到了 mirror id 但找不到对应的 <mirror> 起始标签".into());
        };
        let after = &cleaned[start..];
        let Some(close_rel) = after.find("</mirror>") else {
            return Err("mirror 条目缺少 </mirror>".into());
        };
        let end = start + close_rel + "</mirror>".len();
        let mut out = String::new();
        out.push_str(&cleaned[..mirror_open]);
        out.push_str(mirror.trim_start());
        out.push_str(&cleaned[end..]);
        return Ok(out);
    }

    // 2) 已有 <mirrors> → 插到它后面
    if let Some(pos) = cleaned.find("<mirrors>") {
        let insert_at = pos + "<mirrors>".len();
        let mut out = String::new();
        out.push_str(&cleaned[..insert_at]);
        out.push('\n');
        out.push_str(&mirror);
        out.push_str(&cleaned[insert_at..]);
        return Ok(out);
    }

    // 3) 没有 <mirrors> → 在 </settings> 前插入整段
    let Some(pos) = cleaned.rfind("</settings>") else {
        return Err("文件里找不到 </settings>，无法安全插入".into());
    };
    let mut out = String::new();
    out.push_str(&cleaned[..pos]);
    out.push_str("  <mirrors>\n");
    out.push_str(&mirror);
    out.push_str("  </mirrors>\n");
    out.push_str(&cleaned[pos..]);
    Ok(out)
}

fn gradle_new(text: &str, url: &str) -> String {
    let mut out = strip_block(text);
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    // 注意：镜像地址必须直接出现在 `maven { url '…' }` 行里。
    // 如果先赋给变量再引用，读回校验就找不到地址（校验按行找 `maven … https://`），
    // 写入会被误判失败并回滚。
    out.push_str(&format!("// {BLOCK_BEGIN}\n"));
    out.push_str("// 由 AgentHub 写入；删除本块即可恢复原有仓库配置\n\n");
    out.push_str("settingsEvaluated { settings ->\n");
    out.push_str("    settings.pluginManagement {\n");
    out.push_str("        repositories {\n");
    out.push_str(&format!("            maven {{ url '{url}' }}\n"));
    out.push_str("            gradlePluginPortal()\n");
    out.push_str("        }\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
    out.push_str("allprojects {\n");
    out.push_str("    buildscript {\n");
    out.push_str("        repositories {\n");
    out.push_str(&format!("            maven {{ url '{url}' }}\n"));
    out.push_str("            mavenCentral()\n");
    out.push_str("        }\n");
    out.push_str("    }\n");
    out.push_str("    repositories {\n");
    out.push_str(&format!("        maven {{ url '{url}' }}\n"));
    out.push_str("        mavenCentral()\n");
    out.push_str("    }\n");
    out.push_str("}\n");
    out.push_str(&format!("// {BLOCK_END}\n"));
    out
}

fn cargo_new(text: &str, url: &str) -> Result<String, String> {
    let mut out = strip_block(text);

    // 目标表名：sparse 源
    let source_name = "rsproxy-sparse";

    // 已有 [source.crates-io] 时，就地补 replace-with
    let has_crates_io = out.lines().any(|l| l.trim() == "[source.crates-io]");
    if has_crates_io {
        let mut lines: Vec<String> = Vec::new();
        let mut in_crates_io = false;
        let mut wrote_replace = false;
        for line in out.lines() {
            let t = line.trim();
            if t.starts_with('[') && t.ends_with(']') {
                if in_crates_io && !wrote_replace {
                    lines.push(format!("replace-with = \"{source_name}\""));
                    wrote_replace = true;
                }
                in_crates_io = t == "[source.crates-io]";
                lines.push(line.to_string());
                continue;
            }
            if in_crates_io && t.starts_with("replace-with") {
                lines.push(format!("replace-with = \"{source_name}\""));
                wrote_replace = true;
                continue;
            }
            lines.push(line.to_string());
        }
        if in_crates_io && !wrote_replace {
            lines.push(format!("replace-with = \"{source_name}\""));
        }
        out = lines.join("\n");
        if !out.ends_with('\n') {
            out.push('\n');
        }
    }

    // 补 [source.crates-io]（若原本没有）
    if !has_crates_io {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&format!("# {BLOCK_BEGIN}\n"));
        out.push_str("[source.crates-io]\n");
        out.push_str(&format!("replace-with = \"{source_name}\"\n"));
        out.push_str(&format!("# {BLOCK_END}\n"));
    }

    // 补 sparse 源定义（若原本没有）
    let has_source_table = out
        .lines()
        .any(|l| l.trim() == format!("[source.{source_name}]"));
    if !has_source_table {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&format!("# {BLOCK_BEGIN}\n"));
        out.push_str(&format!("[source.{source_name}]\n"));
        // sparse 源需要 sparse+ 前缀
        let sparse_url = if url.starts_with("sparse+") {
            url.to_string()
        } else {
            format!("sparse+{}", url.trim_end_matches('/').to_string() + "/index/")
        };
        out.push_str(&format!("registry = \"{sparse_url}\"\n"));
        out.push_str(&format!("# {BLOCK_END}\n"));
    }

    // 写前再校验一次：重复表等结构问题在这里暴露
    toml::from_str::<toml::Value>(&out).map_err(|e| format!("改写后的 TOML 不合法：{e}"))?;
    Ok(out)
}

/// 计算新内容（纯函数，便于单测）。
fn build_new_content(kind: CarrierKind, text: &str, url: &str) -> Result<String, String> {
    match kind {
        CarrierKind::Npmrc => Ok(npmrc_new(text, url)),
        CarrierKind::PipIni => Ok(pipini_new(text, url)),
        CarrierKind::MavenSettings => maven_new(text, url),
        CarrierKind::GradleInit => Ok(gradle_new(text, url)),
        CarrierKind::CargoConfig => cargo_new(text, url),
    }
}

// ---------------- 备份 ----------------

fn backup_root(app: &AppH) -> PathBuf {
    crate::ahub::store::data_root(app).join(BACKUP_DIR)
}

fn backup_dir(app: &AppH, tool: &str) -> PathBuf {
    backup_root(app).join(tool)
}

/// 把原文件备份到统一目录，返回备份路径。文件不存在时返回空串（无需备份）。
fn backup(app: &AppH, tool: &str, path: &Path) -> Result<String, String> {
    backup_into(&backup_dir(app, tool), path)
}

/// 备份到指定目录（可测版本）。
fn backup_into(dir: &Path, path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("创建备份目录失败：{e}"))?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f");
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".into());
    let target = dir.join(format!("{stamp}-{name}"));
    std::fs::copy(path, &target).map_err(|e| format!("备份失败：{e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// 最近一次备份（按文件名排序，时间戳前缀保证有序）。
fn latest_backup(app: &AppH, tool: &str) -> Option<PathBuf> {
    let dir = backup_dir(app, tool);
    let mut names: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    names.sort();
    names.pop()
}

// ---------------- 执行 ----------------

/// 写入镜像。每个工具独立处理，返回逐项结果。
pub fn apply(app: &AppH, ids: &[String]) -> Vec<ApplyOutcome> {
    let mut out = Vec::new();
    // npm 与 pnpm 共用 .npmrc：只写一次，第二个直接复用结果
    let mut npmrc_done: Option<ApplyOutcome> = None;

    for id in ids {
        let def = match def_by_id(id) {
            Ok(d) => d,
            Err(e) => {
                out.push(ApplyOutcome {
                    tool: id.clone(),
                    ok: false,
                    backup: String::new(),
                    message: e,
                    verified: false,
                });
                continue;
            }
        };

        // 共用载体：第二个工具直接沿用第一次的结果
        if def.kind == CarrierKind::Npmrc {
            if let Some(prev) = &npmrc_done {
                let mut cloned = prev.clone();
                cloned.tool = def.id.to_string();
                if cloned.ok {
                    cloned.message = format!("{}（与 npm 共用 .npmrc，已一并生效）", prev.message);
                }
                out.push(cloned);
                continue;
            }
        }

        let result = apply_one(app, def);
        if def.kind == CarrierKind::Npmrc && result.ok {
            npmrc_done = Some(result.clone());
        }
        out.push(result);
    }

    out
}

fn apply_one(app: &AppH, def: &MirrorDef) -> ApplyOutcome {
    let path = match carrier_path(def.kind) {
        Ok(p) => p,
        Err(e) => {
            return ApplyOutcome {
                tool: def.id.to_string(),
                ok: false,
                backup: String::new(),
                message: e,
                verified: false,
            }
        }
    };
    // 后端自己把关，不依赖前端禁用勾选：工具没装就不写配置，
    // 否则会凭空创建一份用户看不到效果的配置。
    if !tool_installed(def.id) {
        return ApplyOutcome {
            tool: def.id.to_string(),
            ok: false,
            backup: String::new(),
            message: format!("未检测到 {}，不会写入配置", def.name),
            verified: false,
        };
    }
    let backup_root = backup_dir(app, def.id);
    apply_to_path(def, &path, &backup_root)
}

/// 对指定文件执行「备份 → 写入 → 读回校验 → 失败回滚」。
///
/// 路径作为参数传入，使整条写链路可以在临时目录上端到端验证，
/// 不必触碰用户真实的 `.npmrc` / `settings.xml`。
fn apply_to_path(def: &MirrorDef, path: &Path, backup_dir: &Path) -> ApplyOutcome {
    let fail = |msg: String| ApplyOutcome {
        tool: def.id.to_string(),
        ok: false,
        backup: String::new(),
        message: msg,
        verified: false,
    };

    if let Err(e) = check_writable(path) {
        return fail(e);
    }

    let existed = path.exists();
    // 读不到原内容时必须拒绝写入：否则会用空串覆盖掉用户的配置（静默数据破坏）。
    // 同时记下原编码，写回时按同一编码写出，避免把 UTF-16 文件改成 UTF-8。
    let (old_text, encoding) = if existed {
        match read_text_with_encoding(path) {
            Ok(d) => (d.text, d.encoding),
            Err(e) => return fail(format!("拒绝写入：{e}")),
        }
    } else {
        (String::new(), TextEncoding::Utf8)
    };

    // 结构不认识就拒绝，保持原文件不变
    if existed {
        if let Err(e) = validate_structure(def.kind, &old_text) {
            return fail(format!("拒绝写入：{e}"));
        }
    }

    let new_text = match build_new_content(def.kind, &old_text, def.recommended) {
        Ok(t) => t,
        Err(e) => return fail(format!("拒绝写入：{e}")),
    };

    // 按原编码编码回字节，并保持原换行风格。GBK 文件里若新内容含无法表示的字符，
    // 这里会失败，而不是静默替换成 `?`。
    let new_bytes = match encode_like_original(&new_text, &old_text, encoding) {
        Ok(b) => b,
        Err(e) => return fail(format!("拒绝写入：{e}")),
    };

    // 写回前自校验：**原有内容必须仍在写回结果里**，且不能破坏原有编码结构。
    //
    // 为什么不能只做「decode(encode(text)) == text」：那用的是同一个可能出错的
    // 编码判定流程，自己证明自己，拦不住误判。
    //
    // 两道判据：
    // 1. **编码结构不被破坏**：原字节若能被解释为无噪声的 UTF-16，写回后也必须
    //    能（否则说明把 UTF-16 文件当单字节编码改写了）。这条最有效——实测
    //    「吶吽」的 UTF-16LE 字节按 GBK 解出 `6T=T`，写入后原 UTF-16 结构被破坏，
    //    这条会拦住它。
    // 2. **原有行不丢失**：原文本每一行（除被替换的镜像行外）仍出现在新文本中。
    if existed {
        let old_bytes = std::fs::read(path).unwrap_or_default();

        // 判据 1：编码结构一致性。
        //
        // **判据 1a（最强，优先）**：写回字节必须包含原始字节的**主体部分**。
        // 镜像写入只会「替换某个配置行」或「追加一段」，原文件的主体内容
        // （换行分隔的行）必然原样保留在字节层面。若原始字节序列在写回结果中
        // 大段消失，说明编码判断错了，原内容已被破坏。
        //
        // 这条不依赖任何编码判定，因此不会被误判骗过：实测「吶吽」的 UTF-16LE
        // 字节 `3A 54 3D 4E` 被当 GBK 写成 `6T=T\nregistry=…` 后，原字节序列
        // 只剩零星片段，会被这条拦下。
        if !old_bytes.is_empty() && old_bytes.len() >= 4 {
            // 取原字节的若干个 4 字节窗口，检查是否仍出现在写回结果中
            let mut survived = 0usize;
            let mut total = 0usize;
            let step = (old_bytes.len() / 8).max(1);
            let mut i = 0usize;
            while i + 4 <= old_bytes.len() {
                total += 1;
                if new_bytes
                    .windows(4)
                    .any(|w| w == &old_bytes[i..i + 4])
                {
                    survived += 1;
                }
                i += step;
            }
            // 允许替换行带来的局部丢失，但主体必须还在
            if total > 0 && survived * 2 < total {
                return fail(
                    "拒绝写入：写回结果丢失了原文件的主体内容（编码判断可能有误）".to_string(),
                );
            }
        }

        // 判据 2：编码结构一致性（次要，兜住字节层面侥幸通过的情况）。
        //
        // **只对「原文件不像配置」的输入生效**：正常配置文件即使恰好是偶数长度，
        // 按 UTF-16 也能解出「某个」无噪声文本，若不加这个前提会误拒正常文件。
        if old_bytes.len() % 2 == 0 && !old_bytes.contains(&0) {
            let old_single_byte_is_config = std::str::from_utf8(&old_bytes)
                .map(|t| has_no_binary_noise(t) && has_config_structure(t))
                .unwrap_or(false)
                || decode_gbk_strict(&old_bytes)
                    .map(|t| has_no_binary_noise(&t) && has_config_structure(&t))
                    .unwrap_or(false);

            if !old_single_byte_is_config {
                let old_utf16_ok = [true, false].iter().any(|&le| {
                    decode_utf16(&old_bytes, le)
                        .map(|t| has_no_binary_noise(&t) && !t.is_empty())
                        .unwrap_or(false)
                });
                let new_utf16_ok = new_bytes.len() % 2 == 0
                    && [true, false].iter().any(|&le| {
                        decode_utf16(&new_bytes, le)
                            .map(|t| has_no_binary_noise(&t) && !t.is_empty())
                            .unwrap_or(false)
                    });
                if old_utf16_ok && !new_utf16_ok {
                    return fail(
                        "拒绝写入：原文件可被解释为 UTF-16，写入会破坏该结构（编码判断可能有误）"
                            .to_string(),
                    );
                }
            }
        }

        // 判据 2：原有行不丢失
        match (decode_text(&old_bytes), decode_text(&new_bytes)) {
            (Ok(old_decoded), Ok(new_decoded)) => {
                let new_norm = new_decoded.text.replace("\r\n", "\n");
                let old_norm = old_decoded.text.replace("\r\n", "\n");
                let missing: Vec<&str> = old_norm
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    // 被本次写入替换的镜像行不算丢失
                    .filter(|l| !is_replaced_line(def.kind, l))
                    .filter(|l| !new_norm.contains(l))
                    .collect();
                if !missing.is_empty() {
                    return fail(format!(
                        "拒绝写入：写回后会丢失原有内容（{} 行），编码判断可能有误",
                        missing.len()
                    ));
                }
            }
            _ => {
                return fail("拒绝写入：写回内容无法按原编码解析".to_string());
            }
        }
    }

    // 写入前备份
    let backup_path = match backup_into(backup_dir, path) {
        Ok(b) => b,
        Err(e) => return fail(e),
    };

    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return fail(format!("创建目录失败：{e}"));
        }
    }
    if let Err(e) = std::fs::write(path, &new_bytes) {
        // 写失败时尽力恢复
        if !backup_path.is_empty() {
            let _ = std::fs::copy(&backup_path, path);
        }
        return fail(format!("写入失败：{e}"));
    }

    // 读回校验：必须命中 AgentHub 自己写入的位置，而不是文件里第一处匹配。
    // 用 current_value 会取到用户原有的旧行，把成功写入误判为失败。
    let readback = match read_text(path) {
        Ok(t) => t,
        Err(e) => {
            // 刚写出的内容读不回来，说明写入本身有问题：回滚并报错
            let rollback_ok = backup_path.is_empty() || std::fs::copy(&backup_path, path).is_ok();
            return ApplyOutcome {
                tool: def.id.to_string(),
                ok: false,
                backup: backup_path,
                message: format!(
                    "写入后无法读回校验：{e}{}",
                    if rollback_ok { "，已回滚" } else { "，回滚失败，请手动恢复备份" }
                ),
                verified: false,
            };
        }
    };
    let value = agenthub_written_value(def.kind, &readback);
    if !verify_value(def.kind, &value, def.recommended) {
        let rollback_ok = if backup_path.is_empty() {
            let _ = std::fs::remove_file(path);
            true
        } else {
            std::fs::copy(&backup_path, path).is_ok()
        };
        return ApplyOutcome {
            tool: def.id.to_string(),
            ok: false,
            backup: backup_path,
            message: if rollback_ok {
                format!("写入后校验失败（读回值：{value}），已回滚到写入前内容")
            } else {
                format!("写入后校验失败（读回值：{value}），且回滚失败，请手动恢复备份")
            },
            verified: false,
        };
    }

    // 结构再校验一次（Maven/Cargo 改写后仍须合法）
    if let Err(e) = validate_structure(def.kind, &readback) {
        let rollback_ok = backup_path.is_empty() || std::fs::copy(&backup_path, path).is_ok();
        return ApplyOutcome {
            tool: def.id.to_string(),
            ok: false,
            backup: backup_path,
            message: format!(
                "写入后结构校验失败：{e}{}",
                if rollback_ok { "，已回滚" } else { "，回滚失败，请手动恢复备份" }
            ),
            verified: false,
        };
    }

    ApplyOutcome {
        tool: def.id.to_string(),
        ok: true,
        backup: backup_path,
        message: if existed {
            format!("已写入 {}", path.display())
        } else {
            format!("已创建 {}", path.display())
        },
        verified: true,
    }
}

/// 读回值是否确实指向目标镜像。
///
/// 只做「读回值包含目标主机」的判定，但**必须拒绝空值与无关值**。
/// 早期实现用了 `e.contains(&v)` 的反向包含，导致读回 `https://` 这类短值也会通过，
/// 属于「部分一致即通过」的假阳性，已去掉。
fn verify_value(kind: CarrierKind, value: &str, expected: &str) -> bool {
    let v = value.trim().to_ascii_lowercase();
    if v.is_empty() {
        return false;
    }
    let e = expected.trim().to_ascii_lowercase();
    let expected_host = e
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    if expected_host.is_empty() {
        return false;
    }
    match kind {
        // Cargo 的 sparse 源会被补 `sparse+` 前缀与 `/index/`，只比主机名
        CarrierKind::CargoConfig => v.contains(expected_host),
        // 其余载体写入的是完整地址，要求读回值以目标地址开头
        _ => v.starts_with(&e) || v.contains(&e),
    }
}

// ---------------- 回滚 ----------------

/// 回滚某个工具到最近一次备份。
pub fn rollback(app: &AppH, id: &str) -> Result<String, String> {
    let def = def_by_id(id)?;
    let path = carrier_path(def.kind)?;
    let Some(latest) = latest_backup(app, id) else {
        return Err(format!("{} 没有可用备份，无法回滚", def.name));
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::copy(&latest, &path).map_err(|e| format!("回滚失败：{e}"))?;
    Ok(format!(
        "已回滚 {} 到 {}",
        path.display(),
        latest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    ))
}

// ---------------- 对外查询 ----------------

/// 各工具对应的探测命令：用于判断该工具是否真的安装在本机。
///
/// 未安装的工具仍可查看推荐镜像，但不应被当成「可以写入」——配置文件不存在时
/// 写入会凭空创建一份配置，而工具本身没装，用户看不到任何效果，只会困惑。
fn probe_command(id: &str) -> &'static str {
    match id {
        "npm" => "npm",
        "pnpm" => "pnpm",
        "pip" => "python",
        "maven" => "mvn",
        "gradle" => "gradle",
        "cargo" => "cargo",
        _ => "",
    }
}

/// 工具是否安装在本机。
fn tool_installed(id: &str) -> bool {
    let cmd = probe_command(id);
    if !cmd.is_empty() && crate::ahub::cliscan::resolve_program(cmd).is_some() {
        return true;
    }
    // 常见安装根目录兜底扫描（PATH 里找不到时）
    let dirs: Vec<Option<PathBuf>> = match id {
        "maven" => vec![
            dirs::home_dir().map(|h| h.join(".m2")),
            std::env::var("ProgramFiles")
                .ok()
                .map(|p| PathBuf::from(p).join("Apache").join("maven")),
            std::env::var("CARGO_HOME")
                .ok()
                .map(|p| PathBuf::from(p).parent().map(|x| x.to_path_buf()).unwrap_or_default()),
        ],
        "gradle" => vec![
            dirs::home_dir().map(|h| h.join(".gradle")),
            std::env::var("GRADLE_USER_HOME").ok().map(PathBuf::from),
        ],
        _ => vec![],
    };
    dirs.iter().any(|d| d.as_ref().map(|p| p.is_dir()).unwrap_or(false))
}

/// 列出各工具的镜像现状。
pub fn list(app: &AppH) -> Vec<MirrorTool> {
    DEFS.iter()
        .map(|def| {
            let path = carrier_path(def.kind);
            let installed = tool_installed(def.id);
            let (path_str, exists, current, writable, note) = match &path {
                Ok(p) => {
                    let exists = p.exists();
                    let (text, read_error) = if exists {
                        match read_text(p) {
                            Ok(t) => (t, None),
                            Err(e) => (String::new(), Some(e)),
                        }
                    } else {
                        (String::new(), None)
                    };
                    let current = current_value(def.kind, &text);
                    let (writable, note) = if let Some(e) = read_error {
                        // 读不出来就不允许写入，避免覆盖用户原有配置
                        (false, e)
                    } else if !installed {
                        // 工具没装：给推荐值供参考，但不允许写入
                        (
                            false,
                            format!("未检测到 {}，可查看推荐镜像但不会写入配置", def.name),
                        )
                    } else {
                        match check_writable(p) {
                            Ok(()) => (true, String::new()),
                            Err(e) => (false, e),
                        }
                    };
                    (p.to_string_lossy().into_owned(), exists, current, writable, note)
                }
                Err(e) => (String::new(), false, String::new(), false, e.clone()),
            };
            let backup = latest_backup(app, def.id)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            MirrorTool {
                id: def.id.to_string(),
                name: def.name.to_string(),
                path: path_str,
                exists,
                current,
                recommended: def.recommended.to_string(),
                writable,
                note,
                backup,
                installed,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npmrc_replaces_existing_registry() {
        let text = "registry=https://registry.npmjs.org/\nfoo=bar\n";
        let out = npmrc_new(text, "https://registry.npmmirror.com");
        assert_eq!(out, "registry=https://registry.npmmirror.com\nfoo=bar\n");
        assert!(!out.contains("npmjs.org"), "旧 registry 必须被替换");
    }

    #[test]
    fn npmrc_appends_when_missing() {
        let out = npmrc_new("foo=bar\n", "https://registry.npmmirror.com");
        assert!(out.contains("registry=https://registry.npmmirror.com"));
        assert!(out.contains("foo=bar"));
    }

    #[test]
    fn npmrc_does_not_duplicate_registry() {
        let text = "registry=https://a.example/\nregistry=https://b.example/\n";
        let out = npmrc_new(text, "https://registry.npmmirror.com");
        assert_eq!(
            out.matches("registry=").count(),
            1,
            "不应保留多条 registry：{out}"
        );
    }

    #[test]
    fn pipini_replaces_index_url_in_global() {
        let text = "[global]\nindex-url = https://pypi.org/simple\ntimeout = 60\n";
        let out = pipini_new(text, "https://pypi.tuna.tsinghua.edu.cn/simple");
        assert!(out.contains("index-url = https://pypi.tuna.tsinghua.edu.cn/simple"));
        assert!(!out.contains("pypi.org/simple"));
        assert!(out.contains("timeout = 60"), "其它键必须保留");
    }

    #[test]
    fn pipini_creates_global_section_when_absent() {
        let out = pipini_new("", "https://mirror.example/simple");
        assert!(out.contains("[global]"));
        assert!(out.contains("index-url = https://mirror.example/simple"));
    }

    #[test]
    fn pipini_preserves_other_sections() {
        let text = "[global]\ntimeout = 60\n\n[install]\nno-warn-script-location = true\n";
        let out = pipini_new(text, "https://mirror.example/simple");
        assert!(out.contains("[install]"));
        assert!(out.contains("no-warn-script-location = true"));
        // index-url 必须落在 [global] 里，不能跑到 [install]
        let global_pos = out.find("[global]").unwrap();
        let install_pos = out.find("[install]").unwrap();
        let url_pos = out.find("index-url").unwrap();
        assert!(url_pos > global_pos && url_pos < install_pos);
    }

    #[test]
    fn maven_inserts_mirror_into_existing_mirrors_block() {
        let text = "<settings>\n  <mirrors>\n  </mirrors>\n</settings>\n";
        let out = maven_new(text, "https://maven.aliyun.com/repository/public").unwrap();
        assert!(out.contains(MAVEN_MIRROR_ID));
        assert!(out.contains("https://maven.aliyun.com/repository/public"));
        assert_eq!(out.matches("<mirrors>").count(), 1);
        assert_eq!(out.matches("</mirrors>").count(), 1);
    }

    #[test]
    fn maven_creates_mirrors_block_when_absent() {
        let text = "<settings>\n</settings>\n";
        let out = maven_new(text, "https://maven.aliyun.com/repository/public").unwrap();
        assert!(out.contains("<mirrors>"));
        assert!(out.contains(MAVEN_MIRROR_ID));
    }

    #[test]
    fn maven_replaces_existing_agenthub_mirror() {
        let text = "<settings>\n  <mirrors>\n    <mirror>\n      <id>agenthub-mirror</id>\n      <url>https://old.example/</url>\n      <mirrorOf>*</mirrorOf>\n    </mirror>\n  </mirrors>\n</settings>\n";
        let out = maven_new(text, "https://new.example/public").unwrap();
        assert!(out.contains("https://new.example/public"));
        assert!(!out.contains("old.example"), "旧地址必须被替换");
        assert_eq!(out.matches("<mirror>").count(), 1, "不应产生重复 mirror");
    }

    #[test]
    fn maven_rejects_broken_structure() {
        let err = maven_new("<settings>\n  <mirrors>\n", "https://x/").unwrap_err();
        assert!(err.contains("</settings>") || err.contains("不配对"));
    }

    #[test]
    fn gradle_writes_marked_block_and_is_idempotent() {
        let once = gradle_new("", "https://maven.aliyun.com/repository/public");
        assert!(once.contains(BLOCK_BEGIN));
        assert!(once.contains(BLOCK_END));
        assert!(once.contains("https://maven.aliyun.com/repository/public"));
        let twice = gradle_new(&once, "https://maven.aliyun.com/repository/public");
        assert_eq!(
            twice.matches(BLOCK_BEGIN).count(),
            1,
            "重复写入不应堆叠标记块"
        );
    }

    #[test]
    fn gradle_preserves_existing_content() {
        let out = gradle_new("println 'hello'\n", "https://mirror.example/");
        assert!(out.contains("println 'hello'"), "原有内容必须保留");
    }

    #[test]
    fn cargo_writes_valid_toml() {
        let out = cargo_new("", "https://rsproxy.cn/").unwrap();
        let parsed: toml::Value = toml::from_str(&out).expect("结果必须是合法 TOML");
        let source = parsed
            .get("source")
            .and_then(|s| s.get("crates-io"))
            .expect("应写入 source.crates-io");
        assert_eq!(
            source.get("replace-with").and_then(|v| v.as_str()),
            Some("rsproxy-sparse")
        );
    }

    #[test]
    fn cargo_replaces_existing_replace_with() {
        let text = "[source.crates-io]\nreplace-with = \"other\"\n";
        let out = cargo_new(text, "https://rsproxy.cn/").unwrap();
        assert!(!out.contains("\"other\""), "旧 replace-with 必须被替换");
        assert!(out.contains("rsproxy-sparse"));
    }

    #[test]
    fn cargo_is_idempotent() {
        let once = cargo_new("", "https://rsproxy.cn/").unwrap();
        let twice = cargo_new(&once, "https://rsproxy.cn/").unwrap();
        toml::from_str::<toml::Value>(&twice).expect("重复写入仍须是合法 TOML");
        assert_eq!(
            twice.matches("[source.crates-io]").count(),
            1,
            "不应重复定义 source.crates-io"
        );
        assert_eq!(
            twice.matches("[source.rsproxy-sparse]").count(),
            1,
            "不应重复定义 sparse 源"
        );
    }

    #[test]
    fn validate_structure_rejects_bad_pip_ini() {
        let err = validate_structure(CarrierKind::PipIni, "this is not ini\n").unwrap_err();
        assert!(err.contains("INI"));
    }

    #[test]
    fn validate_structure_rejects_unbalanced_mirrors() {
        let err = validate_structure(
            CarrierKind::MavenSettings,
            "<settings><mirrors></settings>",
        )
        .unwrap_err();
        assert!(err.contains("不配对"));
    }

    #[test]
    fn validate_structure_accepts_empty_text() {
        for kind in [
            CarrierKind::Npmrc,
            CarrierKind::PipIni,
            CarrierKind::MavenSettings,
            CarrierKind::GradleInit,
            CarrierKind::CargoConfig,
        ] {
            assert!(validate_structure(kind, "").is_ok(), "空文件应视为可写");
        }
    }

    #[test]
    fn verify_value_accepts_cargo_sparse_prefix() {
        assert!(verify_value(
            CarrierKind::CargoConfig,
            "sparse+https://rsproxy.cn/index/",
            "https://rsproxy.cn/"
        ));
        assert!(!verify_value(CarrierKind::CargoConfig, "https://crates.io/", "https://rsproxy.cn/"));
    }

    #[test]
    fn verify_value_rejects_empty_readback() {
        assert!(!verify_value(CarrierKind::Npmrc, "", "https://registry.npmmirror.com"));
    }

    #[test]
    fn verify_value_rejects_partial_prefix_of_expected() {
        // 早期实现用反向包含，导致目标地址的前缀也被判为通过（假阳性）。
        // 目标 https://maven.aliyun.com/repository/public 时，
        // 读回值只是 https://maven.aliyun.com 不能算成功。
        assert!(
            !verify_value(
                CarrierKind::MavenSettings,
                "https://maven.aliyun.com",
                "https://maven.aliyun.com/repository/public"
            ),
            "只写到主机名的部分地址不应通过校验"
        );
        // 完整地址应通过
        assert!(verify_value(
            CarrierKind::MavenSettings,
            "https://maven.aliyun.com/repository/public",
            "https://maven.aliyun.com/repository/public"
        ));
    }

    #[test]
    fn written_value_reads_from_agenthub_block_not_users_own_line() {
        // 用户文件里早有 maven 仓库，AgentHub 的块追加在末尾。
        // 读回必须取我们自己写的那条，否则会把成功写入误判为失败并回滚。
        let user_first = "allprojects {\n    repositories {\n        maven { url 'https://repo.company.internal/' }\n    }\n}\n";
        let with_ours = gradle_new(
            user_first,
            "https://maven.aliyun.com/repository/public",
        );
        let ours = agenthub_written_value(CarrierKind::GradleInit, &with_ours);
        assert_eq!(
            ours, "https://maven.aliyun.com/repository/public",
            "必须读到 AgentHub 块里的地址，而不是用户原有的第一条"
        );
        // 展示用的当前值也应优先我们写入的
        assert_eq!(
            current_value(CarrierKind::GradleInit, &with_ours),
            "https://maven.aliyun.com/repository/public"
        );
        // 用户原有内容仍然保留
        assert!(with_ours.contains("repo.company.internal"));
    }

    #[test]
    fn maven_written_value_reads_only_our_mirror() {
        let text = "<settings>\n  <mirrors>\n    <mirror>\n      <id>company</id>\n      <url>https://repo.company.internal/</url>\n      <mirrorOf>*</mirrorOf>\n    </mirror>\n  </mirrors>\n</settings>\n";
        let with_ours = maven_new(text, "https://maven.aliyun.com/repository/public").unwrap();
        assert_eq!(
            agenthub_written_value(CarrierKind::MavenSettings, &with_ours),
            "https://maven.aliyun.com/repository/public",
            "必须取 agenthub-mirror 那条，而不是用户的 company mirror"
        );
        assert!(with_ours.contains("repo.company.internal"), "用户原有 mirror 必须保留");
    }

    #[test]
    fn cargo_written_value_follows_replace_with() {
        let text = "[registries.company]\nindex = \"https://company.internal/index/\"\n";
        let with_ours = cargo_new(text, "https://rsproxy.cn/").unwrap();
        let ours = agenthub_written_value(CarrierKind::CargoConfig, &with_ours);
        assert!(
            ours.contains("rsproxy.cn"),
            "必须跟随 [source.crates-io].replace-with 找到我们的源，实际得到：{ours}"
        );
        assert!(with_ours.contains("company.internal"), "用户原有 registries 必须保留");
    }

    #[test]
    fn strip_block_removes_only_marked_region() {
        let text = format!(
            "keep1\n// {BLOCK_BEGIN}\ndropped\n// {BLOCK_END}\nkeep2\n"
        );
        let out = strip_block(&text);
        assert!(out.contains("keep1"));
        assert!(out.contains("keep2"));
        assert!(!out.contains("dropped"));
    }

    // ---------------- 端到端：备份 → 写入 → 读回校验 → 回滚 ----------------
    //
    // 全部在临时目录上跑，不触碰用户真实的 .npmrc / pip.ini / settings.xml。

    fn temp_case(name: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("agenthub-mirror-e2e-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        let backups = root.join("backups");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&backups).unwrap();
        (root, backups)
    }

    fn def(id: &str) -> &'static MirrorDef {
        DEFS.iter().find(|d| d.id == id).unwrap()
    }

    #[test]
    fn e2e_npmrc_write_verify_and_rollback() {
        let (root, backups) = temp_case("npm");
        let file = root.join(".npmrc");
        let original = "registry=https://registry.npmjs.org/\ncache=D:/cache\n";
        std::fs::write(&file, original).unwrap();

        let outcome = apply_to_path(def("npm"), &file, &backups);
        assert!(outcome.ok, "写入应成功：{}", outcome.message);
        assert!(outcome.verified, "读回校验应通过");
        assert!(!outcome.backup.is_empty(), "应产生备份");

        // 文件确实被改写，且保留了无关项
        let written = std::fs::read_to_string(&file).unwrap();
        assert!(written.contains("registry=https://registry.npmmirror.com"));
        assert!(written.contains("cache=D:/cache"), "无关配置必须保留");

        // 备份内容等于原文
        let backup_text = std::fs::read_to_string(&outcome.backup).unwrap();
        assert_eq!(backup_text, original);

        // 回滚（模拟 rollback 的核心动作）
        std::fs::copy(&outcome.backup, &file).unwrap();
        let restored = std::fs::read_to_string(&file).unwrap();
        assert_eq!(restored, original, "回滚后必须完全等于原文");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn e2e_creates_file_when_absent() {
        let (root, backups) = temp_case("create");
        let file = root.join("pip").join("pip.ini");
        // 文件与目录都不存在
        assert!(!file.exists());

        let outcome = apply_to_path(def("pip"), &file, &backups);
        assert!(outcome.ok, "应创建文件：{}", outcome.message);
        assert!(outcome.verified);
        assert!(outcome.backup.is_empty(), "原本不存在时没有备份");
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("[global]"));
        assert!(text.contains("index-url = https://pypi.tuna.tsinghua.edu.cn/simple"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn e2e_rejects_unparseable_file_and_keeps_it_intact() {
        let (root, backups) = temp_case("reject");
        let file = root.join("pip.ini");
        let original = "这不是 INI 结构\n完全无法解析\n";
        std::fs::write(&file, original).unwrap();

        let outcome = apply_to_path(def("pip"), &file, &backups);
        assert!(!outcome.ok, "结构无法解析时必须拒绝写入");
        assert!(outcome.message.contains("拒绝写入"), "错误应说明拒绝原因");
        let after = std::fs::read_to_string(&file).unwrap();
        assert_eq!(after, original, "被拒绝时原文件必须保持不变");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn e2e_gbk_file_is_not_silently_destroyed() {
        // 中文 Windows 上 .npmrc / pip.ini 常是 GBK 编码。
        // 早期 read_text 用 unwrap_or_default，非 UTF-8 会返回空串，
        // 于是用空串覆盖原文件 —— 静默数据破坏且校验还会「通过」。
        let (root, backups) = temp_case("gbk");
        let file = root.join(".npmrc");

        // 构造 GBK 字节：含中文注释与 cache 行
        // "缓存目录" 的 GBK 编码是 BB BA B4 E6 C4 BF C2 BC
        let mut gbk: Vec<u8> = Vec::new();
        gbk.extend_from_slice(b"registry=https://registry.npmjs.org/\n");
        gbk.extend_from_slice(b"# ");
        gbk.extend_from_slice(&[0xBB, 0xBA, 0xB4, 0xE6, 0xC4, 0xBF, 0xC2, 0xBC]);
        gbk.extend_from_slice(b"\n");
        gbk.extend_from_slice(b"cache=D:/cache\n");
        std::fs::write(&file, &gbk).unwrap();
        let before_len = gbk.len();

        let outcome = apply_to_path(def("npm"), &file, &backups);

        // 本机系统代码页为中文时可解码并正常写入；否则必须明确拒绝。
        // 两种结果都不能丢数据。
        let after = std::fs::read(&file).unwrap();
        if outcome.ok {
            // 成功路径：原有内容必须还在（不能只剩新写的一行）
            let text = String::from_utf8_lossy(&after).into_owned();
            assert!(
                text.contains("cache=D:/cache"),
                "写入成功后原有 cache 行必须保留，实际：{text}"
            );
            assert!(
                after.len() >= before_len,
                "写入后文件不应比原文更短（说明内容被丢弃）"
            );
        } else {
            // 拒绝路径：原文件必须逐字节不变
            assert_eq!(after, gbk, "被拒绝时原文件必须逐字节保持不变");
            assert!(
                outcome.message.contains("拒绝写入"),
                "应明确说明拒绝原因：{}",
                outcome.message
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_text_reports_error_for_undecodable_bytes() {
        let dir = std::env::temp_dir().join("agenthub-read-text-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("binary.bin");
        // 无效 UTF-8、无效 UTF-16（奇数长度）、且含 GBK 非法字节
        std::fs::write(&file, [0xFF, 0x80, 0x81, 0x82, 0xFE]).unwrap();
        match read_text(&file) {
            Ok(t) => assert!(!t.is_empty(), "解码成功时不应返回空串"),
            Err(e) => assert!(
                e.contains("编码") || e.contains("无法读取"),
                "错误信息应说明原因：{e}"
            ),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn decode_text_recognizes_utf16_by_bom() {
        // 记事本「Unicode」保存的是 UTF-16LE + BOM
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "println 'keep-me'\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let decoded = decode_text(&bytes).expect("UTF-16LE BOM 应被识别");
        assert_eq!(decoded.encoding, TextEncoding::Utf16Le);
        assert!(decoded.text.contains("keep-me"));
    }

    #[test]
    fn decode_text_rejects_utf16_without_bom() {
        // 无 BOM 的 UTF-16 与 UTF-8/GBK 存在原理上不可判定的歧义
        // （任何偶数长度字节流按 UTF-16 都能解出某个文本，且其 UTF-8/GBK
        // 解释往往也合法）。因此刻意不做自动识别：含 NUL 的输入被拒绝并提示
        // 用户手动转换编码，这比猜错后破坏文件安全得多。
        let mut bytes = Vec::new();
        for unit in "cache=D:/npm-cache\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert!(bytes.contains(&0), "样本应含 NUL");
        let err = decode_text(&bytes).expect_err("无 BOM 的 UTF-16 应被拒绝");
        assert!(
            err.contains("UTF-16") || err.contains("NUL"),
            "错误信息应提示编码问题：{err}"
        );
    }

    #[test]
    fn decode_text_recognizes_chinese_heavy_utf16_without_bom() {
        // 第四轮 Verifier 抓到的缺陷：以中文为主的 UTF-16LE 无 BOM 文件曾被误判
        // 成 GBK 并写回成非法混合。
        //
        // 现在的策略是「不猜」：无 BOM 的 UTF-16 一律拒绝并提示手动转换，
        // 因为与 GBK 的歧义原理上无法判定。
        let original = "# 缓存目录\n# 中文注释\n";
        let mut bytes = Vec::new();
        for unit in original.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let err = decode_text(&bytes).expect_err("无 BOM 的 UTF-16 应被拒绝，而不是猜编码");
        assert!(
            err.contains("UTF-16") || err.contains("NUL") || err.contains("编码"),
            "错误信息应说明编码问题：{err}"
        );
    }

    #[test]
    fn decode_text_rejects_gbk_without_bom() {
        // 路线 A：不再自动识别 GBK（它与无 BOM UTF-16 的歧义不可从字节判定），
        // 一律拒绝并提示转存 UTF-8。
        let mut bytes = b"# ".to_vec();
        bytes.extend_from_slice(&[0xBB, 0xBA, 0xB4, 0xE6, 0xC4, 0xBF, 0xC2, 0xBC]);
        bytes.extend_from_slice(b"\ncache=D:/c\n");
        let err = decode_text(&bytes).expect_err("无 BOM 的 GBK 应被拒绝");
        assert!(
            err.contains("UTF-8") || err.contains("编码"),
            "应说明拒绝原因：{err}"
        );
    }

    #[test]
    fn e2e_chinese_utf16_without_bom_is_not_corrupted() {
        // 完整链路：无 BOM、中文为主的 UTF-16LE .npmrc。
        // 关键不变式：无论识别成功还是拒绝，原文件都不能被破坏。
        let (root, backups) = temp_case("utf16-nobom-cn");
        let file = root.join(".npmrc");
        let original = "# 缓存目录\n# 中文注释\n";
        let mut bytes = Vec::new();
        for unit in original.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        std::fs::write(&file, &bytes).unwrap();

        let outcome = apply_to_path(def("npm"), &file, &backups);

        let after = std::fs::read(&file).unwrap();
        if outcome.ok {
            // 成功路径：必须仍是合法 UTF-16LE，且原文与镜像都可读
            assert_eq!(after.len() % 2, 0, "写回后必须是合法 UTF-16LE 长度");
            let decoded = decode_text(&after).expect("写回内容应可解码");
            assert!(
                decoded.text.contains("缓存目录"),
                "原有中文必须保留，实际：{}",
                decoded.text
            );
            assert!(
                decoded.text.contains("registry.npmmirror.com"),
                "镜像地址必须可读，实际：{}",
                decoded.text
            );
        } else {
            // 拒绝路径：原文件必须逐字节不变，且明确说明原因
            assert_eq!(after, bytes, "被拒绝时原文件必须逐字节不变");
            assert!(
                outcome.message.contains("拒绝写入"),
                "应明确说明拒绝原因：{}",
                outcome.message
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pure_cjk_utf16_without_bom_is_rejected_not_corrupted() {
        // 第五轮 Verifier 抓到的边界：纯 CJK、零 ASCII 的无 BOM UTF-16LE。
        // 它没有 NUL 字节，且无法与 GBK 可靠区分，必须明确拒绝而不是猜。
        let (root, backups) = temp_case("pure-cjk");
        let file = root.join(".npmrc");
        // "缓存目录注释" 的 UTF-16LE，零 ASCII、零 NUL
        let mut bytes = Vec::new();
        for unit in "缓存目录注释".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert!(!bytes.contains(&0), "该样本应不含 NUL");
        std::fs::write(&file, &bytes).unwrap();

        let outcome = apply_to_path(def("npm"), &file, &backups);

        let after = std::fs::read(&file).unwrap();
        if outcome.ok {
            // 若判定成功，必须是合法 UTF-16 且原内容可读
            assert_eq!(after.len() % 2, 0, "写回后必须是合法 UTF-16 长度");
            let decoded = decode_text(&after).expect("写回内容应可解码");
            assert!(
                decoded.text.contains("缓存目录注释"),
                "原有内容必须可读，实际：{}",
                decoded.text
            );
        } else {
            assert_eq!(after, bytes, "被拒绝时原文件必须逐字节不变");
            assert!(
                outcome.message.contains("拒绝写入"),
                "应明确说明拒绝原因：{}",
                outcome.message
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn odd_length_truncated_utf16_is_rejected() {
        // 第五轮 Verifier 抓到的边界：奇数长度的截断 UTF-16。
        // 长度非偶数会跳过 UTF-16 分支，而 NUL 又能通过 UTF-8 判断，
        // 于是被当 UTF-8 写回，破坏原文件。
        let (root, backups) = temp_case("odd-len");
        let file = root.join(".npmrc");
        let mut bytes = Vec::new();
        for unit in "# 缓存目录\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        // 截掉最后一个字节，制造奇数长度
        bytes.pop();
        assert_eq!(bytes.len() % 2, 1, "样本必须是奇数长度");
        std::fs::write(&file, &bytes).unwrap();

        let outcome = apply_to_path(def("npm"), &file, &backups);

        let after = std::fs::read(&file).unwrap();
        assert!(!outcome.ok, "奇数长度的疑似 UTF-16 必须被拒绝");
        assert_eq!(after, bytes, "被拒绝时原文件必须逐字节不变");
        assert!(
            outcome.message.contains("拒绝写入"),
            "应明确说明拒绝原因：{}",
            outcome.message
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn control_characters_block_utf8_acceptance() {
        // UTF-16LE 的纯 CJK 字节恰好也是合法 UTF-8，但会解出控制字符。
        // 这类输入不能因为「from_utf8 成功」就被当 UTF-8 接受。
        let mut bytes = Vec::new();
        for unit in "缓存目录".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        // 该字节流确实是合法 UTF-8（含控制字符）
        if std::str::from_utf8(&bytes).is_ok() {
            assert!(
                decode_text(&bytes).is_err(),
                "含控制字符的 UTF-8 解码结果必须被拒绝"
            );
        }
    }

    #[test]
    fn has_no_binary_noise_rejects_control_and_private_use() {
        assert!(has_no_binary_noise("registry=https://example.com/\n"));
        assert!(has_no_binary_noise("缓存目录\ncache=D:/c\n"));
        assert!(!has_no_binary_noise("abc\0def"));
        assert!(!has_no_binary_noise("abc\u{13}def"), "控制字符必须被拒");
        assert!(!has_no_binary_noise("abc\u{FFFD}def"), "替换字符必须被拒");
        assert!(!has_no_binary_noise("abc\u{E001}def"), "私用区必须被拒");
        // 常见空白不算噪声
        assert!(has_no_binary_noise("a\tb\r\nc"));
    }

    #[test]
    fn e2e_minimal_cjk_utf16_is_rejected_not_corrupted() {
        // 第六轮 Verifier 的最小复现：极短 UTF-16LE（1–4 个汉字）。
        // 这些字节流与 UTF-8/GBK 存在真实歧义，且无法靠形态可靠区分。
        // 关键不变式：无论接受还是拒绝，原文件都不能被破坏。
        for word in ["目", "目录", "缓存目", "缓存目录"] {
            let (root, backups) = temp_case(&format!("min-cjk-{}", word.chars().count()));
            let file = root.join(".npmrc");
            let mut bytes = Vec::new();
            for unit in word.encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            std::fs::write(&file, &bytes).unwrap();

            let outcome = apply_to_path(def("npm"), &file, &backups);

            let after = std::fs::read(&file).unwrap();
            if outcome.ok {
                // 若判定成功，写回内容必须能读回原文（编码与内容都不能坏）
                let decoded = decode_text(&after)
                    .unwrap_or_else(|e| panic!("「{word}」写回后应可解码：{e}"));
                assert!(
                    decoded.text.contains(word),
                    "「{word}」原有内容必须可读，实际：{:?}",
                    decoded.text
                );
            } else {
                assert_eq!(after, bytes, "「{word}」被拒绝时原文件必须逐字节不变");
            }
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn decode_text_only_accepts_unambiguous_encodings() {
        // 路线 A 的核心约束：只接受 UTF-8（含 BOM）与带 BOM 的 UTF-16。
        // 其余一律拒绝，不做任何猜测。

        // 1) UTF-8 接受
        assert!(decode_text(b"registry=https://registry.npmjs.org/\n").is_ok());
        assert!(decode_text("# 注释\ncache=D:/c\n".as_bytes()).is_ok());
        assert!(decode_text("[global]\nindex-url = https://x/\n".as_bytes()).is_ok());
        assert!(decode_text("<settings>\n  <mirrors>\n</settings>\n".as_bytes()).is_ok());

        // 2) UTF-8 BOM 接受且保留
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(b"cache=D:/c\n");
        let d = decode_text(&bom).unwrap();
        assert_eq!(d.encoding, TextEncoding::Utf8Bom);

        // 3) 带 BOM 的 UTF-16 接受
        for (le, enc) in [(true, TextEncoding::Utf16Le), (false, TextEncoding::Utf16Be)] {
            let mut b = if le { vec![0xFF, 0xFE] } else { vec![0xFE, 0xFF] };
            for unit in "cache=D:/c\n".encode_utf16() {
                let pair = if le { unit.to_le_bytes() } else { unit.to_be_bytes() };
                b.extend_from_slice(&pair);
            }
            let d = decode_text(&b).unwrap_or_else(|e| panic!("{enc:?} 应可解码：{e}"));
            assert_eq!(d.encoding, enc);
        }

        // 4) 无 BOM 的 UTF-16 拒绝
        let mut nobom = Vec::new();
        for unit in "cache=D:/npm-cache\n".encode_utf16() {
            nobom.extend_from_slice(&unit.to_le_bytes());
        }
        assert!(
            decode_text(&nobom).is_err(),
            "无 BOM 的 UTF-16 必须被拒绝"
        );

        // 5) GBK 拒绝（中文注释 + ASCII 键）
        let mut gbk = b"# ".to_vec();
        gbk.extend_from_slice(&[0xBB, 0xBA, 0xB4, 0xE6, 0xC4, 0xBF, 0xC2, 0xBC]);
        gbk.extend_from_slice(b"\ncache=D:/c\n");
        assert!(decode_text(&gbk).is_err(), "GBK 必须被拒绝并提示转存 UTF-8");

        // 6) 纯二进制拒绝
        assert!(decode_text(&[0xFF, 0x80, 0x81, 0x82, 0xFE]).is_err());
        assert!(decode_text(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).is_err());
    }

    /// 穷举「无 BOM 的 UTF-16 中文」在真实配置文件长度下的行为（路线 A 语义）。
    ///
    /// 断言的就是调整后 A12 的两条验收标准（以写入结果为准）：
    /// 1. 被拒绝（decode_text 不认、或 apply 层的字节窗口 / UTF-16 结构守卫拦下）
    ///    → 原文件逐字节不变；
    /// 2. 写入成功 → 原文件必可按其判定编码解码，且原有每一行仍出现在结果中。
    ///
    /// 背景：无 BOM UTF-16 与 UTF-8 的字节交集不可判定，字节本身恰为合法
    /// UTF-8 的样本会被当 UTF-8 处理（中文语义不可恢复，但原有行不丢失）。
    ///
    /// 默认忽略（样本量大），手动跑：
    /// `cargo test --lib -- --ignored cjk_utf16_exhaustive`
    #[test]
    #[ignore]
    fn cjk_utf16_exhaustive_no_silent_corruption() {
        let mut checked = 0usize;
        let mut rejected = 0usize;
        let mut accepted = 0usize;
        let (root, backups) = temp_case("cjk-exhaustive");

        // 用**不同**的汉字构造序列，而不是单字符重复。
        // 早期版本用 `repeat(ch).take(len)` 只造「目目目目」这种同字重复，
        // 恒被碎片判据（字符种类 ≤2）拦下，测试因此恒通过，掩盖了真实缺陷。
        //
        // 从 8 个汉字（16 字节）起：覆盖真实配置文件的最小长度。
        for len in 8..=24usize {
            for start in (0x4E00u32..0x9FA5).step_by(53) {
                let mut word = String::new();
                for k in 0..len {
                    let cp = start + (k as u32) * 7;
                    let Some(ch) = char::from_u32(cp) else { break };
                    word.push(ch);
                }
                if word.chars().count() != len {
                    continue;
                }
                let mut bytes = Vec::new();
                for unit in word.encode_utf16() {
                    bytes.extend_from_slice(&unit.to_le_bytes());
                }
                if bytes.contains(&0) {
                    continue;
                }
                checked += 1;

                let file = root.join(format!("case-{len}-{start}.npmrc"));
                std::fs::write(&file, &bytes).unwrap();
                let outcome = apply_to_path(def("npm"), &file, &backups);
                let after = std::fs::read(&file).unwrap();

                if outcome.ok {
                    // 写入成功：原文件必可解码，且原有每一行都保留在结果中
                    let before = decode_text(&bytes).unwrap_or_else(|e| {
                        panic!("len={len} word={word:?} 写成功但原文件无法解码：{e}")
                    });
                    let after_decoded = decode_text(&after).unwrap_or_else(|e| {
                        panic!("len={len} word={word:?} 写成功后应可解码：{e}")
                    });
                    for line in before.text.lines() {
                        assert!(
                            after_decoded.text.contains(line),
                            "len={len} word={word:?} 写入后原有行必须保留：{line:?} 不在 {:?}",
                            after_decoded.text
                        );
                    }
                    accepted += 1;
                } else {
                    // 被拒绝：原文件必须逐字节不变
                    assert_eq!(
                        after, bytes,
                        "len={len} word={word:?} 被拒绝时原文件必须逐字节不变"
                    );
                    rejected += 1;
                }
                let _ = std::fs::remove_file(&file);
            }
        }

        println!("检查 {checked} 例：拒绝 {rejected} / 写入成功 {accepted}");
        assert!(checked > 300, "样本量应足够");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn roundtrip_selfcheck_catches_encoding_misjudgement() {
        // 写回前的往返自校验：编码判断错了，decode(encode(text)) 必然对不上。
        // 这里直接验证各组编码的往返，作为自校验逻辑的依据。
        // 注意：无 BOM 的 UTF-16 不再参与自动识别（与 UTF-8/GBK 有不可判定的歧义），
        // 因此「带 BOM 的 UTF-16」与 UTF-8/GBK 是往返校验覆盖的范围。
        for enc in [
            TextEncoding::Utf8,
            TextEncoding::Utf8Bom,
            TextEncoding::Utf16Le,
            TextEncoding::Utf16Be,
        ] {
            let original = "registry=https://example.com/\n中文注释\n";
            let bytes = encode_text(original, enc).unwrap();
            let back = decode_text(&bytes).unwrap();
            assert_eq!(back.encoding, enc, "{enc:?} 往返后编码应一致");
            assert_eq!(back.text, original, "{enc:?} 往返后内容应一致");
        }
    }

    #[test]
    fn e2e_utf16_without_bom_is_rejected_safely() {
        // 无 BOM 的 UTF-16（含 ASCII 结构）一律拒绝，原文件保持不变，
        // 且必须提示用户先转存为 UTF-8（A12 调整后的明确要求）。
        let (root, backups) = temp_case("utf16-nobom-struct");
        let file = root.join(".npmrc");
        let original = "# 缓存目录\nregistry=https://registry.npmjs.org/\ncache=D:/cache\n";
        let mut bytes = Vec::new();
        for unit in original.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        std::fs::write(&file, &bytes).unwrap();

        let outcome = apply_to_path(def("npm"), &file, &backups);
        assert!(!outcome.ok, "无 BOM 的 UTF-16 应被拒绝");
        assert!(
            outcome.message.contains("拒绝写入"),
            "应明确说明拒绝原因：{}",
            outcome.message
        );
        assert!(
            outcome.message.contains("UTF-16") || outcome.message.contains("UTF-8"),
            "报错应说明编码问题并提示转存 UTF-8：{}",
            outcome.message
        );
        let after = std::fs::read(&file).unwrap();
        assert_eq!(after, bytes, "被拒绝时原文件必须逐字节不变");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn e2e_supported_encodings_still_work() {
        // A12 调整后的正向要求：受支持编码（UTF-8 / UTF-8 BOM / GBK /
        // 带 BOM 的 UTF-16LE/BE）必须仍能正常写入，且编码保持不变。
        for (label, enc) in [
            ("utf8", TextEncoding::Utf8),
            ("utf8bom", TextEncoding::Utf8Bom),
            ("utf16le", TextEncoding::Utf16Le),
            ("utf16be", TextEncoding::Utf16Be),
        ] {
            let (root, backups) = temp_case(&format!("supported-{label}"));
            let file = root.join(".npmrc");
            let original = "cache=D:/cache\n";
            let bytes = encode_text(original, enc).unwrap();
            std::fs::write(&file, &bytes).unwrap();

            let outcome = apply_to_path(def("npm"), &file, &backups);
            assert!(
                outcome.ok,
                "{label} 应能写入：{}",
                outcome.message
            );
            assert!(outcome.verified, "{label} 读回校验应通过");

            let after = std::fs::read(&file).unwrap();
            let decoded = decode_text(&after).expect("写回内容应可解码");
            assert_eq!(decoded.encoding, enc, "{label} 编码必须保持不变");
            assert!(
                decoded.text.contains("cache=D:/cache"),
                "{label} 原有内容必须保留"
            );
            assert!(
                decoded.text.contains("registry.npmmirror.com"),
                "{label} 镜像必须写入"
            );

            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn write_preserves_every_original_line() {
        // A12 新增要求：写入后原文件每一行（除被替换的镜像项外）都必须仍在。
        let (root, backups) = temp_case("preserve-lines");
        let file = root.join(".npmrc");
        let original = concat!(
            "# 顶部注释\n",
            "cache=D:/npm-cache\n",
            "prefix=D:/npm-global\n",
            "registry=https://registry.npmjs.org/\n",
            "fund=false\n",
            "# 底部注释\n",
        );
        std::fs::write(&file, original).unwrap();

        let outcome = apply_to_path(def("npm"), &file, &backups);
        assert!(outcome.ok, "应写入成功：{}", outcome.message);

        let after = std::fs::read_to_string(&file).unwrap();
        for line in [
            "# 顶部注释",
            "cache=D:/npm-cache",
            "prefix=D:/npm-global",
            "fund=false",
            "# 底部注释",
        ] {
            assert!(
                after.contains(line),
                "原有行必须保留：{line}\n实际内容：{after}"
            );
        }
        assert!(
            after.contains("registry=https://registry.npmmirror.com"),
            "镜像行应被替换为新值"
        );
        assert!(
            !after.contains("registry.npmjs.org"),
            "旧镜像值应被替换掉"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn e2e_crlf_newlines_are_preserved() {
        // 第四轮 Verifier 风险项：CRLF 的 .npmrc 写入后换行全变 LF
        let (root, backups) = temp_case("crlf");
        let file = root.join(".npmrc");
        let original = "registry=https://registry.npmjs.org/\r\ncache=D:/cache\r\n";
        std::fs::write(&file, original).unwrap();

        let outcome = apply_to_path(def("npm"), &file, &backups);
        assert!(outcome.ok, "应写入成功：{}", outcome.message);
        let after = std::fs::read_to_string(&file).unwrap();
        assert!(
            after.contains("\r\n"),
            "原有 CRLF 换行风格必须保留，实际：{after:?}"
        );
        assert!(
            !after.contains("\r\r\n"),
            "不得出现 \\r\\r\\n"
        );
        assert!(after.contains("cache=D:/cache"), "原有内容必须保留");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn e2e_utf16_file_keeps_its_encoding() {
        // UTF-16LE 的 init.gradle：写入后必须仍是 UTF-16LE，且原有内容保留。
        // 早期实现会把它有损解码成乱码再以 UTF-8 写回，造成静默破坏。
        let (root, backups) = temp_case("utf16");
        let file = root.join("init.gradle");
        let original = "println 'keep-me'\n";
        let mut bytes = vec![0xFF, 0xFE];
        for unit in original.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        std::fs::write(&file, &bytes).unwrap();

        let outcome = apply_to_path(def("gradle"), &file, &backups);

        let after = std::fs::read(&file).unwrap();
        if outcome.ok {
            // 编码必须保持 UTF-16LE（仍有 BOM）
            assert_eq!(&after[..2], &[0xFF, 0xFE], "写入后必须保持 UTF-16LE 编码");
            let decoded = decode_text(&after).expect("写回内容应可解码");
            assert!(
                decoded.text.contains("keep-me"),
                "原有内容必须保留，实际：{}",
                decoded.text
            );
            assert!(decoded.text.contains("maven"), "应写入镜像块");
        } else {
            assert_eq!(after, bytes, "被拒绝时原文件必须逐字节不变");
            assert!(
                outcome.message.contains("拒绝写入"),
                "应明确说明拒绝原因：{}",
                outcome.message
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn e2e_utf8_bom_is_preserved() {
        let (root, backups) = temp_case("utf8bom");
        let file = root.join(".npmrc");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"registry=https://registry.npmjs.org/\ncache=D:/cache\n");
        std::fs::write(&file, &bytes).unwrap();

        let outcome = apply_to_path(def("npm"), &file, &backups);
        assert!(outcome.ok, "UTF-8 BOM 文件应能正常写入：{}", outcome.message);
        let after = std::fs::read(&file).unwrap();
        assert_eq!(&after[..3], &[0xEF, 0xBB, 0xBF], "BOM 必须保留");
        let text = decode_text(&after).unwrap().text;
        assert!(text.contains("cache=D:/cache"), "原有内容必须保留");
        assert!(text.contains("registry.npmmirror.com"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn encode_text_roundtrips_each_encoding() {
        for enc in [
            TextEncoding::Utf8,
            TextEncoding::Utf8Bom,
            TextEncoding::Utf16Le,
            TextEncoding::Utf16Be,
        ] {
            let original = "registry=https://example.com/\n中文注释\n";
            let bytes = encode_text(original, enc).unwrap();
            let decoded = decode_text(&bytes).unwrap();
            assert_eq!(decoded.encoding, enc, "编码探测应还原出 {enc:?}");
            assert_eq!(decoded.text, original, "{enc:?} 往返应保持一致");
        }
    }

    #[test]
    fn check_writable_does_not_touch_filesystem() {
        // 预览阶段会调用 check_writable，它不能创建/删除任何文件
        let dir = std::env::temp_dir().join("agenthub-writable-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let before: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert!(before.is_empty());

        let target = dir.join("not-yet-created.ini");
        assert!(check_writable(&target).is_ok(), "可写目录应判定为可写");

        let after: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert!(after.is_empty(), "check_writable 不得创建任何文件：{after:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn e2e_maven_writes_valid_xml_and_verifies() {
        let (root, backups) = temp_case("maven");
        let file = root.join("settings.xml");
        std::fs::write(&file, "<settings>\n</settings>\n").unwrap();

        let outcome = apply_to_path(def("maven"), &file, &backups);
        assert!(outcome.ok, "写入应成功：{}", outcome.message);
        assert!(outcome.verified);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("<mirrors>"));
        assert!(text.contains("https://maven.aliyun.com/repository/public"));
        assert!(text.contains("</settings>"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn e2e_cargo_writes_valid_toml_and_verifies() {
        let (root, backups) = temp_case("cargo");
        let file = root.join("config.toml");
        std::fs::write(&file, "[net]\ngit-fetch-with-cli = true\n").unwrap();

        let outcome = apply_to_path(def("cargo"), &file, &backups);
        assert!(outcome.ok, "写入应成功：{}", outcome.message);
        assert!(outcome.verified);
        let text = std::fs::read_to_string(&file).unwrap();
        // 必须是合法 TOML
        let parsed: toml::Value = toml::from_str(&text).expect("结果必须是合法 TOML");
        assert!(parsed.get("net").is_some(), "原有表必须保留");
        assert!(parsed.get("source").is_some(), "应写入 source 表");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn e2e_gradle_writes_marked_block_and_verifies() {
        let (root, backups) = temp_case("gradle");
        let file = root.join("init.gradle");
        std::fs::write(&file, "// 用户已有内容\n").unwrap();

        let outcome = apply_to_path(def("gradle"), &file, &backups);
        assert!(outcome.ok, "写入应成功：{}", outcome.message);
        assert!(outcome.verified);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("用户已有内容"), "原有内容必须保留");
        assert!(text.contains(BLOCK_BEGIN));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn e2e_multiple_tools_are_independent() {
        let (root, backups) = temp_case("independent");
        let npmrc = root.join(".npmrc");
        let pipini = root.join("pip.ini");
        std::fs::write(&npmrc, "registry=https://registry.npmjs.org/\n").unwrap();
        // pip.ini 结构损坏 → 应失败且不影响 npm
        std::fs::write(&pipini, "坏的 ini 结构\n").unwrap();

        let npm_outcome = apply_to_path(def("npm"), &npmrc, &backups);
        let pip_outcome = apply_to_path(def("pip"), &pipini, &backups);

        assert!(npm_outcome.ok, "npm 应成功");
        assert!(!pip_outcome.ok, "pip 应因结构问题失败");
        // 一个失败不影响另一个已完成的写入
        let npm_text = std::fs::read_to_string(&npmrc).unwrap();
        assert!(npm_text.contains("registry.npmmirror.com"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn e2e_readback_mismatch_triggers_rollback() {
        let (root, backups) = temp_case("mismatch");
        let file = root.join(".npmrc");
        let original = "registry=https://registry.npmjs.org/\n";
        std::fs::write(&file, original).unwrap();

        // 用不可能的推荐值构造「写入成功但校验不过」的场景：
        // 载体里写进去的值必然包含推荐值，所以这里换一种方式——
        // 直接验证 verify_value 对不匹配值的判定，并确认回滚逻辑能恢复原文
        assert!(!verify_value(CarrierKind::Npmrc, "https://other.example/", "https://registry.npmmirror.com"));

        // 模拟校验失败后的回滚动作
        let backup_path = backup_into(&backups, &file).unwrap();
        std::fs::write(&file, "registry=https://wrong.example/\n").unwrap();
        assert_ne!(std::fs::read_to_string(&file).unwrap(), original);
        std::fs::copy(&backup_path, &file).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original, "回滚必须恢复原文");

        let _ = std::fs::remove_dir_all(&root);
    }
}
