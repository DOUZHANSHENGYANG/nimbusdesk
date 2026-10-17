use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const INBOX: &str = "08-收件箱/工作台";
const IMAGES: &str = "assets/images/工作台";
const TRANSACTIONS: &str = "08-收件箱/工作台/.transactions";
const IMAGE_LIMIT: usize = 20 * 1024 * 1024;
const NOTE_LIMIT: u64 = 8 * 1024 * 1024;
static WRITES: Mutex<()> = Mutex::new(());

#[path = "organization.rs"]
mod organization;
pub use organization::organize_with_folders;

type Result<T> = std::result::Result<T, String>;

fn inside(path: &str, folder: &str) -> bool {
    let path = path.to_lowercase();
    let folder = folder.to_lowercase();
    path == folder || path.starts_with(&format!("{folder}/"))
}
fn overlaps(a: &str, b: &str) -> bool {
    inside(a, b) || inside(b, a)
}
fn folder_syntax(folder: &str) -> bool {
    !folder.is_empty()
        && folder.len() <= 1024
        && folder.split('/').count() <= 40
        && folder.split('/').all(|part| {
            !part.is_empty()
                && !part.starts_with('.')
                && !part.ends_with(['.', ' '])
                && !part
                    .chars()
                    .any(|c| c.is_control() || "<>:\"\\|?*".contains(c))
                && !["node_modules", "skills", "target", "vendor"]
                    .contains(&part.to_lowercase().as_str())
                && !device_name(part)
        })
}
fn protected_folder(folder: &str) -> bool {
    ["08-收件箱", "assets"]
        .iter()
        .any(|reserved| overlaps(folder, reserved))
}
fn normalize_folder(vault: &Vault, folder: &str) -> Result<String> {
    // Trim surrounding UI whitespace, while rejecting ambiguous whitespace in names.
    let normalized = folder
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    if !folder_syntax(&normalized) || protected_folder(&normalized) {
        return Err("分类目录须为库内普通相对目录，不能使用收件箱、附件或保留目录".into());
    }
    let mut relative = String::new();
    for part in normalized.split('/') {
        if !relative.is_empty() {
            relative.push('/');
        }
        relative.push_str(part);
        let path = vault.path(&relative)?;
        match fs::symlink_metadata(path) {
            Ok(metadata) if !metadata.is_dir() || hidden(&metadata) => {
                return Err("分类目录必须是普通、可见的文件夹".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(fail("检查分类目录失败", error)),
        }
    }
    Ok(normalized)
}
pub fn validate_folders(root: &str, folders: KnowledgeFolders) -> Result<KnowledgeFolders> {
    let vault = Vault::new(root)?;
    validate_vault_folders(&vault, folders)
}
fn validate_vault_folders(vault: &Vault, folders: KnowledgeFolders) -> Result<KnowledgeFolders> {
    let folders = KnowledgeFolders {
        experience: normalize_folder(vault, &folders.experience)?,
        recipe: normalize_folder(vault, &folders.recipe)?,
        resource: normalize_folder(vault, &folders.resource)?,
    };
    let paths = [&folders.experience, &folders.recipe, &folders.resource];
    for (index, path) in paths.iter().enumerate() {
        if paths[index + 1..].iter().any(|other| overlaps(path, other)) {
            return Err("三个分类目录不能重复或互相包含，请选择独立文件夹".into());
        }
    }
    Ok(folders)
}
fn note_kind(relative: &str, folders: &KnowledgeFolders) -> &'static str {
    if inside(relative, &folders.experience) {
        "experience"
    } else if inside(relative, &folders.recipe) {
        "recipe"
    } else if inside(relative, &folders.resource) {
        "resource"
    } else if inside(relative, "08-收件箱") {
        "inbox"
    } else {
        "note"
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    #[serde(flatten)]
    record: CaptureRecord,
    request_fingerprint: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveTransaction {
    ids: Vec<String>,
    target: String,
    target_fingerprint: String,
    staged_target: String,
    source_fingerprints: HashMap<String, String>,
}
struct Vault {
    root: PathBuf,
}

fn fail(step: &str, error: impl std::fmt::Display) -> String {
    format!("{step}: {error}")
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn fingerprint(bytes: &[u8]) -> String {
    // Deterministic content token, independent of timestamp granularity and process restarts.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}-{}", bytes.len())
}
fn split_frontmatter(content: &str) -> (&str, &str) {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let Some(rest) = content
        .strip_prefix("---\r\n")
        .or_else(|| content.strip_prefix("---\n"))
    else {
        return ("", content);
    };
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return (&rest[..offset], &rest[offset + line.len()..]);
        }
        offset += line.len();
    }
    ("", content)
}
fn id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
fn hidden(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x2 != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}
impl Vault {
    fn new(root: &str) -> Result<Self> {
        let root = fs::canonicalize(root).map_err(|e| fail("无法打开知识库", e))?;
        if !root.is_dir() {
            return Err("知识库根路径必须为文件夹".into());
        }
        let vault = Self { root };
        if !vault.path(".obsidian")?.is_dir() {
            return Err("请选择包含 .obsidian 文件夹的 Obsidian 知识库".into());
        }
        Ok(vault)
    }
    fn path(&self, relative: &str) -> Result<PathBuf> {
        let normalized = relative.replace('\\', "/");
        let path = Path::new(&normalized);
        if normalized.is_empty()
            || normalized.contains(':')
            || normalized.starts_with('/')
            || path
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err("知识库路径不合法：只允许库内相对路径".into());
        }
        let mut full = self.root.clone();
        for component in path.components() {
            full.push(component);
            match fs::symlink_metadata(&full) {
                Ok(metadata) => {
                    if reparse(&metadata) || metadata.file_type().is_symlink() {
                        return Err(format!("拒绝链接或 junction 路径: {relative}"));
                    }
                    let resolved =
                        fs::canonicalize(&full).map_err(|e| fail("无法验证知识库路径", e))?;
                    if !resolved.starts_with(&self.root) {
                        return Err("路径超出绑定的知识库".into());
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(fail("无法检查知识库路径", error)),
            }
        }
        Ok(full)
    }
    fn mkdir(&self, relative: &str) -> Result<PathBuf> {
        let path = self.path(relative)?;
        fs::create_dir_all(&path).map_err(|e| fail("创建知识库目录失败", e))?;
        self.path(relative)
    }
    fn text(&self, relative: &str) -> Result<String> {
        let path = self.path(relative)?;
        if fs::metadata(&path)
            .map_err(|e| fail("读取笔记信息失败", e))?
            .len()
            > NOTE_LIMIT
        {
            return Err("笔记过大（上限 8 MiB）".into());
        }
        fs::read_to_string(path).map_err(|e| fail(&format!("读取 {relative} 失败"), e))
    }
    fn metadata(&self, id: &str) -> Result<Metadata> {
        if !id_ok(id) {
            return Err("条目 ID 不合法".into());
        }
        let metadata: Metadata =
            serde_json::from_str(&self.text(&format!("{INBOX}/{id}/条目.json"))?)
                .map_err(|e| fail("条目元数据损坏", e))?;
        self.validate_metadata(&metadata, id)?;
        Ok(metadata)
    }
    fn validate_metadata(&self, metadata: &Metadata, id: &str) -> Result<()> {
        let record = &metadata.record;
        if record.id != id
            || !(record.note_path == format!("{INBOX}/{id}/条目.md")
                || (record.status == "archived"
                    && record.archived_path.as_ref() == Some(&record.note_path)))
            || !["inbox", "archived"].contains(&record.status.as_str())
        {
            return Err("条目元数据与所属文件夹不一致".into());
        }
        self.path(&record.note_path)?;
        for attachment in &record.attachments {
            if !attachment.path.starts_with(&format!("{IMAGES}/{id}/")) {
                return Err("图片不属于当前条目".into());
            }
            self.path(&attachment.path)?;
            if !["image/png", "image/jpeg", "image/webp", "image/gif"]
                .contains(&attachment.mime.as_str())
            {
                return Err("条目包含不支持的图片类型".into());
            }
        }
        if let Some(path) = &record.archived_path {
            if !archive_path(path) {
                return Err("归档路径不合法".into());
            }
            self.path(path)?;
        }
        Ok(())
    }
    fn save_metadata(&self, metadata: &Metadata) -> Result<()> {
        let relative = format!("{INBOX}/{}/条目.json", metadata.record.id);
        let path = self.path(&relative)?;
        self.path(&format!("{relative}.tmp"))?;
        self.path(&format!("{relative}.bak"))?;
        let bytes =
            serde_json::to_vec_pretty(metadata).map_err(|e| fail("编码条目元数据失败", e))?;
        crate::atomic::write_file_atomic(&path.to_string_lossy(), &bytes)
            .map_err(|e| fail("更新条目状态失败（归档记录已保留，可刷新恢复）", e))
    }
    fn note(&self, relative: &str, content: &str) -> Result<KnowledgeNote> {
        let metadata =
            fs::metadata(self.path(relative)?).map_err(|e| fail("读取笔记状态失败", e))?;
        let (frontmatter, body) = split_frontmatter(content);
        let title = body
            .lines()
            .find_map(|line| line.strip_prefix("# "))
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                Path::new(relative)
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
        let preview = body
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.starts_with("# "))
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(220)
            .collect();
        let kind = note_kind(relative, &KnowledgeFolders::default());
        Ok(KnowledgeNote {
            path: relative.into(),
            title,
            kind: kind.into(),
            modified_at: metadata
                .modified()
                .unwrap_or(UNIX_EPOCH)
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            preview,
            frontmatter: frontmatter.into(),
            organized: false,
        })
    }
}
fn archive_path(path: &str) -> bool {
    // Historical targets remain valid after bindings change; never tie recovery to
    // today's settings. Keep the same ordinary in-vault path restrictions.
    let Some((folder, name)) = path.rsplit_once('/') else {
        return false;
    };
    folder_syntax(folder)
        && !protected_folder(folder)
        && !name.starts_with('.')
        && name.ends_with(".md")
        && !name
            .chars()
            .any(|c| c.is_control() || "<>:\"\\|?*".contains(c))
        && !name.ends_with(['.', ' '])
        && !device_name(name)
}
fn new_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| fail("新文件已存在或无法创建", e))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| fail("保存文件失败", e))
}
fn publish_file(vault: &Vault, staged: &str, target: &str) -> Result<()> {
    let staged_path = vault.path(staged)?;
    let target_path = vault.path(target)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            Win32::Storage::FileSystem::{MOVE_FILE_FLAGS, MoveFileExW},
            core::PCWSTR,
        };
        let source: Vec<u16> = staged_path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let destination: Vec<u16> = target_path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        // Flags=0 deliberately omits REPLACE_EXISTING and COPY_ALLOWED: publish by rename
        // without overwriting, including filesystems that do not implement hard links.
        unsafe {
            MoveFileExW(
                PCWSTR(source.as_ptr()),
                PCWSTR(destination.as_ptr()),
                MOVE_FILE_FLAGS(0),
            )
        }
        .map_err(|e| fail("发布新笔记失败（不会覆盖同名文件，暂存材料保留）", e))
    }
    #[cfg(not(windows))]
    {
        // Unix rename replaces targets, so use a create-new link before removing the stage.
        fs::hard_link(staged_path, target_path)
            .map_err(|e| fail("发布新笔记失败（不会覆盖同名文件，暂存材料保留）", e))?;
        fs::remove_file(vault.path(staged)?)
            .map_err(|e| fail("笔记已发布，清理暂存文件失败（可刷新恢复）", e))
    }
}
fn preserve_incomplete_capture(vault: &Vault, stage: &str, id: &str) -> Result<()> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let recovery = format!("{INBOX}/.recovery-{id}-{nonce}");
    if vault.path(&recovery)?.exists() {
        return Err("暂存恢复目录重名，请重试".into());
    }
    fs::rename(vault.path(stage)?, vault.path(&recovery)?)
        .map_err(|e| fail("保留未完成收集失败，原暂存内容未删除", e))
}
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"/\\|?*[]#^".contains(*c))
        .take(72)
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    if cleaned.is_empty() {
        "未命名".into()
    } else if device_name(cleaned) {
        format!("_{cleaned}")
    } else {
        cleaned.into()
    }
}
fn device_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end()
        .to_uppercase();
    [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .contains(&stem.as_str())
}
fn image_type(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.len() >= 33 {
        Some(("image/png", "png"))
    } else if bytes.starts_with(b"\xff\xd8\xff") && bytes.ends_with(b"\xff\xd9") {
        Some(("image/jpeg", "jpg"))
    } else if bytes.len() >= 20 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some(("image/webp", "webp"))
    } else if bytes.len() >= 14
        && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"))
        && bytes.ends_with(b";")
    {
        Some(("image/gif", "gif"))
    } else {
        None
    }
}
fn markdown(kind: &str, created: u64, tags: &[String], title: &str, body: &str) -> String {
    format!(
        "---\ntype: {kind}\ncreated: {created}\ntags: {}\n---\n\n# {}\n\n{}\n",
        serde_json::to_string(tags).expect("tag serialization"),
        title.replace(['\n', '\r'], " "),
        body
    )
}

pub fn bind(root: &str) -> Result<VaultInfo> {
    let vault = Vault::new(root)?;
    let canonical = vault.root.to_string_lossy();
    let display_root = if let Some(unc) = canonical.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        canonical
            .strip_prefix("\\\\?\\")
            .unwrap_or(&canonical)
            .to_string()
    };
    Ok(VaultInfo {
        root: display_root,
        name: vault
            .root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
    })
}
pub fn read(root: &str, path: &str) -> Result<ReadNote> {
    let vault = Vault::new(root)?;
    if !path.to_lowercase().ends_with(".md") {
        return Err("只支持读取 Markdown 笔记".into());
    }
    let content = vault.text(path)?;
    Ok(ReadNote {
        path: path.into(),
        fingerprint: fingerprint(content.as_bytes()),
        content,
    })
}
pub fn update(root: &str, input: UpdateNoteInput) -> Result<ReadNote> {
    let _guard = WRITES
        .lock()
        .map_err(|_| "知识库写入锁异常，请重启工作台")?;
    if input.content.len() as u64 > NOTE_LIMIT {
        return Err("笔记过大（上限 8 MiB）".into());
    }
    let vault = Vault::new(root)?;
    if !input.path.to_lowercase().ends_with(".md") {
        return Err("只支持保存 Markdown 笔记".into());
    }
    let existing = vault.text(&input.path)?;
    if fingerprint(existing.as_bytes()) != input.fingerprint {
        return Err("笔记已被外部修改，请保留当前编辑内容并重新读取后再保存".into());
    }
    let path = vault.path(&input.path)?;
    vault.path(&format!("{}.tmp", input.path))?;
    vault.path(&format!("{}.bak", input.path))?;
    crate::atomic::write_file_atomic(&path.to_string_lossy(), input.content.as_bytes())
        .map_err(|error| fail("保存笔记失败", error))?;
    Ok(ReadNote {
        path: input.path,
        fingerprint: fingerprint(input.content.as_bytes()),
        content: input.content,
    })
}
pub fn image(root: &str, path: &str) -> Result<String> {
    let vault = Vault::new(root)?;
    if !path.replace('\\', "/").starts_with("assets/images/") {
        return Err("图片必须位于知识库 assets/images 中".into());
    }
    let resolved = vault.path(path)?;
    if fs::metadata(&resolved)
        .map_err(|e| fail("读取图片信息失败", e))?
        .len()
        > IMAGE_LIMIT as u64
    {
        return Err("图片超过 20 MiB 上限".into());
    }
    let bytes = fs::read(resolved).map_err(|e| fail("读取图片失败", e))?;
    let (mime, _) = image_type(&bytes).ok_or("图片内容类型不受支持或已损坏")?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn recover_archives(vault: &Vault) -> Result<()> {
    let folder = vault.path(TRANSACTIONS)?;
    if !folder.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(folder).map_err(|e| fail("读取归档恢复记录失败", e))? {
        let entry = entry.map_err(|e| fail("读取归档恢复项目失败", e))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".json") {
            continue;
        }
        let relative = format!("{TRANSACTIONS}/{name}");
        let transaction: ArchiveTransaction = serde_json::from_str(&vault.text(&relative)?)
            .map_err(|e| fail("归档恢复记录损坏", e))?;
        let target_parent = Path::new(&transaction.target)
            .parent()
            .unwrap_or_else(|| Path::new(""));
        let staged_parent = Path::new(&transaction.staged_target)
            .parent()
            .unwrap_or_else(|| Path::new(""));
        if transaction.ids.is_empty()
            || !archive_path(&transaction.target)
            || target_parent != staged_parent
            || !Path::new(&transaction.staged_target)
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(".archive-"))
        {
            return Err("归档恢复记录路径不合法".into());
        }
        let target = vault.path(&transaction.target)?;
        let staged = vault.path(&transaction.staged_target)?;
        if !target.exists() && staged.exists() {
            if fingerprint(vault.text(&transaction.staged_target)?.as_bytes())
                != transaction.target_fingerprint
            {
                return Err("归档暂存文件不完整，原材料与恢复记录已保留".into());
            }
            for id in &transaction.ids {
                let source = vault.metadata(id)?;
                if transaction.source_fingerprints.get(id)
                    != Some(&fingerprint(
                        vault.text(&source.record.note_path)?.as_bytes(),
                    ))
                {
                    return Err("原始材料在归档恢复前被修改，请检查保留的暂存记录".into());
                }
            }
            publish_file(vault, &transaction.staged_target, &transaction.target)?;
        }
        if target.exists() {
            if fingerprint(vault.text(&transaction.target)?.as_bytes())
                != transaction.target_fingerprint
            {
                return Err("归档目标已被外部修改，请保留原文件并检查恢复记录".into());
            }
            if staged.exists() {
                if fingerprint(vault.text(&transaction.staged_target)?.as_bytes())
                    != transaction.target_fingerprint
                {
                    return Err("归档暂存与目标内容冲突，已保留两份文件".into());
                }
                fs::remove_file(vault.path(&transaction.staged_target)?)
                    .map_err(|e| fail("清理已发布归档的暂存文件失败", e))?;
            }
            for id in &transaction.ids {
                let mut source = vault.metadata(id)?;
                if source
                    .record
                    .archived_path
                    .as_ref()
                    .is_some_and(|path| path != &transaction.target)
                {
                    return Err("恢复归档时发现条目已指向其他笔记".into());
                }
                source.record.status = "archived".into();
                source.record.archived_path = Some(transaction.target.clone());
                vault.save_metadata(&source)?;
            }
        }
        fs::remove_file(vault.path(&relative)?).map_err(|e| fail("清理归档恢复记录失败", e))?;
    }
    Ok(())
}
pub fn captures(root: &str) -> Result<Vec<CaptureRecord>> {
    let _guard = WRITES
        .lock()
        .map_err(|_| "知识库写入锁异常，请重启工作台")?;
    let vault = Vault::new(root)?;
    recover_archives(&vault)?;
    organization::recover(&vault)?;
    let folder = vault.path(INBOX)?;
    if !folder.exists() {
        return Ok(vec![]);
    }
    let mut records = vec![];
    for entry in fs::read_dir(folder).map_err(|e| fail("读取收件箱失败", e))? {
        let entry = entry.map_err(|e| fail("读取收件箱条目失败", e))?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if id.starts_with('.') {
            continue;
        }
        let path = vault.path(&format!("{INBOX}/{id}"))?;
        if !path.is_dir() {
            continue;
        }
        let metadata = vault.metadata(&id)?;
        // Missing original material is an error, not an empty or misleading list.
        vault.text(&metadata.record.note_path)?;
        records.push(metadata.record);
    }
    records.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(records)
}
fn walk(
    vault: &Vault,
    relative: &str,
    query: &str,
    output: &mut Vec<KnowledgeNote>,
    depth: usize,
    limit: usize,
    folders: &KnowledgeFolders,
) -> Result<()> {
    if output.len() >= limit {
        return Ok(());
    }
    if depth > 40 {
        return Err("知识库目录嵌套过深".into());
    }
    // Scope roots may also be junctions; skip them before strict path resolution.
    match fs::symlink_metadata(vault.root.join(relative)) {
        Ok(metadata)
            if reparse(&metadata) || hidden(&metadata) || metadata.file_type().is_symlink() =>
        {
            return Ok(());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(fail("检查知识库目录失败", error)),
    }
    let folder = vault.path(relative)?;
    if !folder.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(folder).map_err(|e| fail(&format!("扫描 {relative} 失败"), e))? {
        if output.len() >= limit {
            break;
        }
        let entry = entry.map_err(|e| fail("扫描知识库条目失败", e))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.')
            || ["node_modules", "skills", "target", "vendor"]
                .contains(&name.to_lowercase().as_str())
        {
            continue;
        }
        // Enumeration can encounter links owned by other tools. Do not follow
        // them or let one unrelated junction abort the entire vault scan.
        // Direct reads and writes still go through Vault::path's strict checks.
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|e| fail("检查知识库条目失败", e))?;
        if reparse(&metadata) || hidden(&metadata) || metadata.file_type().is_symlink() {
            continue;
        }
        let child = format!("{relative}/{name}");
        let path = vault.path(&child)?;
        if path.is_dir() {
            walk(vault, &child, query, output, depth + 1, limit, folders)?;
        } else if metadata.is_file() && name.to_lowercase().ends_with(".md") {
            if child.starts_with(&format!("{INBOX}/")) && child.ends_with("/条目.md") {
                let id = child
                    .trim_start_matches(&format!("{INBOX}/"))
                    .trim_end_matches("/条目.md");
                if id_ok(id) && vault.path(&format!("{INBOX}/{id}/条目.json"))?.exists() {
                    let record = vault.metadata(id)?.record;
                    if record.status == "archived"
                        && record.archived_path.as_deref() != Some(child.as_str())
                    {
                        continue;
                    }
                }
            }
            let text = vault.text(&child)?;
            if query.is_empty()
                || text.to_lowercase().contains(query)
                || child.to_lowercase().contains(query)
            {
                let mut note = vault.note(&child, &text)?;
                note.kind = note_kind(&child, folders).into();
                output.push(note);
            }
        }
    }
    Ok(())
}
#[cfg(test)]
pub fn scan(root: &str) -> Result<Vec<KnowledgeNote>> {
    scan_with_folders(root, &KnowledgeFolders::default())
}
pub fn scan_with_folders(root: &str, folders: &KnowledgeFolders) -> Result<Vec<KnowledgeNote>> {
    search_with_folders(root, "", folders)
}
pub fn templates(root: &str) -> Result<Vec<KnowledgeNote>> {
    let vault = Vault::new(root)?;
    let mut notes = vec![];
    walk(
        &vault,
        "07-模板",
        "",
        &mut notes,
        0,
        100,
        &KnowledgeFolders::default(),
    )?;
    notes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(notes)
}
#[cfg(test)]
pub fn search(root: &str, query: &str) -> Result<Vec<KnowledgeNote>> {
    search_with_folders(root, query, &KnowledgeFolders::default())
}
pub fn search_with_folders(
    root: &str,
    query: &str,
    folders: &KnowledgeFolders,
) -> Result<Vec<KnowledgeNote>> {
    let _guard = WRITES
        .lock()
        .map_err(|_| "知识库写入锁异常，请重启工作台")?;
    let vault = Vault::new(root)?;
    let folders = validate_vault_folders(&vault, folders.clone())?;
    organization::recover(&vault)?;
    let mut notes = vec![];
    let query = query.trim().to_lowercase();
    for scope in [
        folders.experience.as_str(),
        folders.recipe.as_str(),
        folders.resource.as_str(),
        "08-收件箱",
    ] {
        walk(&vault, scope, &query, &mut notes, 0, usize::MAX, &folders)?;
    }
    notes.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then_with(|| a.path.cmp(&b.path))
    });
    organization::mark_completed(&vault, &mut notes)?;
    Ok(notes)
}

pub fn capture(root: &str, input: CaptureInput) -> Result<CaptureRecord> {
    let _guard = WRITES
        .lock()
        .map_err(|_| "知识库写入锁异常，请重启工作台")?;
    let vault = Vault::new(root)?;
    if !id_ok(&input.id) {
        return Err("条目 ID 不合法".into());
    }
    if input.title.trim().is_empty()
        || input.title.len() > 600
        || input.content.len() > 2 * 1024 * 1024
        || input.project.len() > 16_384
        || input.source.len() > 16_384
    {
        return Err("条目标题为空或内容超过上限".into());
    }
    if input.attachments.len() > 20 {
        return Err("每条最多保存 20 张图片".into());
    }
    if input
        .attachments
        .iter()
        .any(|image| image.data_base64.len() > IMAGE_LIMIT.div_ceil(3) * 4)
        || input
            .attachments
            .iter()
            .map(|image| image.data_base64.len())
            .sum::<usize>()
            > 90 * 1024 * 1024
    {
        return Err("图片超过单张 20 MiB 或单条 64 MiB 上限".into());
    }
    let request_fingerprint =
        fingerprint(&serde_json::to_vec(&input).map_err(|e| fail("编码条目失败", e))?);
    let final_folder = format!("{INBOX}/{}", input.id);
    if vault.path(&final_folder)?.exists() {
        let previous = vault.metadata(&input.id)?;
        if previous.request_fingerprint != request_fingerprint {
            return Err("条目 ID 已存在，拒绝覆盖原始材料".into());
        }
        vault.text(&previous.record.note_path)?;
        return Ok(previous.record);
    }
    let mut attachments = vec![];
    let mut image_bytes = vec![];
    let mut total_bytes = 0usize;
    for (index, attachment) in input.attachments.iter().enumerate() {
        if attachment.data_base64.len() > IMAGE_LIMIT.div_ceil(3) * 4 {
            return Err("单张图片超过 20 MiB 上限".into());
        }
        let bytes = STANDARD
            .decode(&attachment.data_base64)
            .map_err(|_| "图片 Base64 内容无效")?;
        total_bytes += bytes.len();
        if bytes.len() > IMAGE_LIMIT || total_bytes > 64 * 1024 * 1024 {
            return Err("图片超过单张 20 MiB 或单条 64 MiB 上限".into());
        }
        let (mime, extension) =
            image_type(&bytes).ok_or("图片内容不受支持（仅 PNG/JPEG/WebP/GIF）")?;
        if attachment.mime != mime {
            return Err("图片声明类型与文件内容不一致".into());
        }
        let stem = Path::new(&attachment.name)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy();
        let name = format!(
            "{}-{}-{}.{}",
            safe_name(&stem),
            index + 1,
            &input.id[..input.id.len().min(12)],
            extension
        );
        attachments.push(CaptureAttachment {
            name: name.clone(),
            path: format!("{IMAGES}/{}/{name}", input.id),
            mime: mime.into(),
        });
        image_bytes.push(bytes);
    }
    let stage = format!("{INBOX}/.staging-{}", input.id);
    let mut metadata = Metadata {
        record: CaptureRecord {
            id: input.id.clone(),
            title: input.title.trim().into(),
            created_at: now(),
            project: input.project.clone(),
            source: input.source.clone(),
            status: "inbox".into(),
            attachments,
            note_path: format!("{final_folder}/条目.md"),
            archived_path: None,
        },
        request_fingerprint,
    };
    if vault.path(&stage)?.exists() {
        let journal = format!("{stage}/条目.json");
        let journal_path = vault.path(&journal)?;
        let previous = if journal_path.exists() {
            serde_json::from_str::<Metadata>(&vault.text(&journal)?).ok()
        } else {
            None
        };
        if let Some(previous) = previous {
            vault.validate_metadata(&previous, &input.id)?;
            if previous.request_fingerprint != metadata.request_fingerprint {
                return Err("该 ID 存在未完成收集，请重试原始内容".into());
            }
            metadata = previous;
        } else {
            // A crash before a complete request journal cannot establish ownership. Preserve it,
            // then reconstruct from the caller's still-present draft instead of overwriting it.
            preserve_incomplete_capture(&vault, &stage, &input.id)?;
        }
    }
    if !vault.path(&stage)?.exists() {
        vault.mkdir(INBOX)?;
        fs::create_dir(vault.path(&stage)?).map_err(|e| fail("创建条目暂存目录失败", e))?;
    }
    let mut body = input.content.clone();
    if !input.project.is_empty() {
        body.push_str(&format!("\n\n项目：{}", input.project));
    }
    if !input.source.is_empty() {
        body.push_str(&format!("\n\n来源：{}", input.source));
    }
    for attachment in &metadata.record.attachments {
        body.push_str(&format!("\n\n![[{}]]", attachment.path));
    }
    let note = markdown(
        "inbox",
        metadata.record.created_at,
        &[],
        &input.title,
        &body,
    );
    let staged_note = vault.path(&format!("{stage}/条目.md"))?;
    if staged_note.exists()
        && fs::read(&staged_note).map_err(|e| fail("检查暂存正文失败", e))? != note.as_bytes()
    {
        // The original draft is authoritative for this identical request, but retain a partial
        // or externally changed staging file as a recovery copy instead of destroying it.
        preserve_incomplete_capture(&vault, &stage, &input.id)?;
        fs::create_dir(vault.path(&stage)?).map_err(|e| fail("重建条目暂存目录失败", e))?;
    }
    for (filename, bytes) in [
        (
            "条目.json",
            serde_json::to_vec_pretty(&metadata).map_err(|e| fail("编码条目元数据失败", e))?,
        ),
        ("条目.md", note.into_bytes()),
    ] {
        let relative = format!("{stage}/{filename}");
        let path = vault.path(&relative)?;
        if path.exists() {
            if fs::read(path).map_err(|e| fail("读取暂存文件失败", e))? != bytes {
                return Err("暂存条目内容已改变，拒绝覆盖".into());
            }
        } else {
            new_file(&path, &bytes)?;
        }
    }
    if !metadata.record.attachments.is_empty() {
        let staged_images = format!("{stage}/images");
        let target_images = format!("{IMAGES}/{}", input.id);
        let target = vault.path(&target_images)?;
        if target.exists() {
            for (attachment, bytes) in metadata.record.attachments.iter().zip(&image_bytes) {
                if fs::read(vault.path(&attachment.path)?)
                    .map_err(|e| fail("检查已保存图片失败", e))?
                    != *bytes
                {
                    return Err("图片目标已存在且内容不同，拒绝覆盖".into());
                }
            }
        } else {
            vault.mkdir(&staged_images)?;
            for (attachment, bytes) in metadata.record.attachments.iter().zip(&image_bytes) {
                let relative = format!("{staged_images}/{}", attachment.name);
                let path = vault.path(&relative)?;
                if path.exists() {
                    if fs::read(path).map_err(|e| fail("读取暂存图片失败", e))? != *bytes {
                        return Err("暂存图片冲突".into());
                    }
                } else {
                    new_file(&path, bytes)?;
                }
            }
            vault.mkdir(IMAGES)?;
            fs::rename(vault.path(&staged_images)?, vault.path(&target_images)?)
                .map_err(|e| fail("发布图片失败（原材料已保留在暂存目录，可重试）", e))?;
        }
    }
    fs::rename(vault.path(&stage)?, vault.path(&final_folder)?)
        .map_err(|e| fail("发布条目失败（图片与原材料已保留，可重试）", e))?;
    Ok(metadata.record)
}

#[cfg(test)]
pub fn archive(root: &str, input: ArchiveInput) -> Result<KnowledgeNote> {
    archive_with_folders(root, input, &KnowledgeFolders::default())
}
pub fn archive_with_folders(
    root: &str,
    mut input: ArchiveInput,
    folders: &KnowledgeFolders,
) -> Result<KnowledgeNote> {
    let _guard = WRITES
        .lock()
        .map_err(|_| "知识库写入锁异常，请重启工作台")?;
    let vault = Vault::new(root)?;
    let folders = validate_vault_folders(&vault, folders.clone())?;
    recover_archives(&vault)?;
    let folder = match input.kind.as_str() {
        "experience" => folders.experience.as_str(),
        "recipe" => folders.recipe.as_str(),
        "resource" => folders.resource.as_str(),
        _ => return Err("归档分类不合法".into()),
    };
    if input.ids.is_empty()
        || input.ids.len() > 100
        || input.title.trim().is_empty()
        || input.title.len() > 600
        || input.content.len() > 2 * 1024 * 1024
        || input.tags.len() > 50
        || input.tags.iter().any(|tag| tag.len() > 120)
    {
        return Err("归档条目、标题或正文不符合要求".into());
    }
    input.ids.sort();
    input.ids.dedup();
    let mut sources = vec![];
    for id in &input.ids {
        let source = vault.metadata(id)?;
        let actual = fingerprint(vault.text(&source.record.note_path)?.as_bytes());
        if input.fingerprints.get(id) != Some(&actual) {
            return Err(format!("条目 {id} 已被外部修改，请刷新后重新整理"));
        }
        sources.push(source);
    }
    // Canonical ordered tuple avoids HashMap serialization order affecting retry identity.
    let expected: Vec<_> = input
        .ids
        .iter()
        .map(|id| (id, &input.fingerprints[id]))
        .collect();
    let identity = fingerprint(
        &serde_json::to_vec(&(
            &input.ids,
            &input.title,
            &input.kind,
            &input.content,
            &input.tags,
            expected,
        ))
        .map_err(|e| fail("编码归档请求失败", e))?,
    );
    let target = format!(
        "{folder}/{}-{}.md",
        safe_name(&input.title),
        &identity[..16]
    );
    let existing = sources
        .iter()
        .filter(|source| source.record.status == "archived")
        .count();
    if existing > 0 {
        let historical_target = sources[0].record.archived_path.as_deref();
        if existing == sources.len()
            && historical_target
                .is_some_and(|path| Path::new(path).file_name() == Path::new(&target).file_name())
            && sources
                .iter()
                .all(|source| source.record.archived_path.as_deref() == historical_target)
        {
            let target = historical_target.expect("validated historical target");
            let content = vault.text(&target)?;
            let mut note = vault.note(&target, &content)?;
            note.kind = input.kind;
            return Ok(note);
        }
        return Err("选择的材料已归档，不能重复创建其他笔记".into());
    }
    if vault.path(&target)?.exists() {
        return Err("归档笔记已存在，拒绝覆盖".into());
    }
    let mut body = input.content;
    body.push_str("\n\n## 原始材料\n");
    let mut images = std::collections::HashSet::new();
    for source in &sources {
        body.push_str(&format!(
            "\n- [[{}]]",
            source.record.note_path.trim_end_matches(".md")
        ));
        for attachment in &source.record.attachments {
            if images.insert(attachment.path.clone()) {
                body.push_str(&format!("\n\n![[{}]]\n", attachment.path));
            }
        }
    }
    let content = markdown(&input.kind, now(), &input.tags, &input.title, &body);
    let staged_target = format!("{folder}/.archive-{identity}.tmp");
    let transaction = ArchiveTransaction {
        ids: input.ids,
        target: target.clone(),
        target_fingerprint: fingerprint(content.as_bytes()),
        staged_target: staged_target.clone(),
        source_fingerprints: input.fingerprints,
    };
    vault.mkdir(folder)?;
    vault.mkdir(TRANSACTIONS)?;
    let journal = format!("{TRANSACTIONS}/{identity}.json");
    new_file(
        &vault.path(&journal)?,
        &serde_json::to_vec_pretty(&transaction).map_err(|e| fail("编码归档恢复记录失败", e))?,
    )?;
    // A staged target cannot become a partially written Markdown note after a crash.
    new_file(&vault.path(&staged_target)?, content.as_bytes())?;
    if vault.path(&target)?.exists() {
        return Err("归档目标在保存时出现重名，请保留恢复记录".into());
    }
    for source in &sources {
        if transaction.source_fingerprints.get(&source.record.id)
            != Some(&fingerprint(
                vault.text(&source.record.note_path)?.as_bytes(),
            ))
        {
            return Err("原始材料在发布前被修改，暂存笔记保留，请刷新".into());
        }
    }
    publish_file(&vault, &staged_target, &target)?;
    recover_archives(&vault)?;
    let mut note = vault.note(&target, &content)?;
    note.kind = input.kind;
    Ok(note)
}

#[cfg(test)]
mod publication_tests {
    use super::*;

    #[test]
    fn publication_never_replaces_existing_target_and_retains_staged_file() {
        let root =
            std::env::temp_dir().join(format!("nimbus-publish-{}-{}", std::process::id(), now()));
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        let vault = Vault::new(&root.to_string_lossy()).unwrap();
        fs::write(root.join("stage.tmp"), "complete new note").unwrap();
        fs::write(root.join("existing.md"), "user original").unwrap();
        assert!(publish_file(&vault, "stage.tmp", "existing.md").is_err());
        assert_eq!(
            fs::read_to_string(root.join("existing.md")).unwrap(),
            "user original"
        );
        assert_eq!(
            fs::read_to_string(root.join("stage.tmp")).unwrap(),
            "complete new note"
        );
        publish_file(&vault, "stage.tmp", "new.md").unwrap();
        assert_eq!(
            fs::read_to_string(root.join("new.md")).unwrap(),
            "complete new note"
        );
        assert!(!root.join("stage.tmp").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
