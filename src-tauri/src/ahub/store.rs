use crate::ahub::models::*;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{Manager, Wry};

pub type AppH = tauri::AppHandle<Wry>;

/// 构造一个「不弹控制台黑框」的命令（Windows 下 git 等子进程默认会闪出黑框）
pub fn silent_command(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

pub fn es(e: std::io::Error) -> String {
    e.to_string()
}

pub fn config_dir(app: &AppH) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".agenthub"))
}

pub fn settings_path(app: &AppH) -> PathBuf {
    config_dir(app).join("settings.json")
}

pub fn load_settings(app: &AppH) -> Settings {
    let path = settings_path(app);
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(s) = serde_json::from_str::<Settings>(&text) {
            return s;
        }
    }
    Settings::default()
}

pub fn save_settings(app: &AppH, s: &Settings) -> Result<(), String> {
    let path = settings_path(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(es)?;
    }
    write_json(&path, s)
}

/// 桥①：数据根 = <云台数据目录>/modules/agenthub。
///
/// 源侧这里读 AgentHub 自己的 `settings.data_dir`（没有就用 exe 旁的 data/），
/// 而云台已经有一套唯一的数据目录解析（便携优先 + 指针文件 + 迁移）。
/// 两套并存会让同一个应用写出两个数据根，用户以为数据丢了；
/// 所以这里改成挂在云台数据目录下的一个子目录，其余一切照旧。
pub fn data_root(_app: &AppH) -> PathBuf {
    crate::commands::data::resolve_data_dir()
        .map(|root: PathBuf| root.join("modules").join("agenthub"))
        .unwrap_or_else(|_| std::env::temp_dir().join("agenthub-data"))
}

pub fn ensure_layout(root: &Path) -> Result<(), String> {
    for sub in ["prompts", "mcp", "skills"] {
        std::fs::create_dir_all(root.join(sub)).map_err(es)?;
    }
    Ok(())
}

pub fn dirs_info(app: &AppH) -> DataDirs {
    let root = data_root(app);
    DataDirs {
        root: root.to_string_lossy().into_owned(),
        prompts: root.join("prompts").to_string_lossy().into_owned(),
        mcp: root.join("mcp").to_string_lossy().into_owned(),
        skills: root.join("skills").to_string_lossy().into_owned(),
    }
}

pub fn settings_info(app: &AppH) -> SettingsInfo {
    SettingsInfo {
        settings: load_settings(app),
        data_dirs: dirs_info(app),
    }
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let text = std::fs::read_to_string(path).map_err(es)?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {}", path.display(), e))
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(es)?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(es)
}

pub fn push_version(versions: &mut Vec<VersionEntry>, old_content: &str) {
    if old_content.is_empty() {
        return;
    }
    let v = versions.iter().map(|x| x.v).max().unwrap_or(0) + 1;
    versions.push(VersionEntry {
        v,
        saved_at: now_iso(),
        note: String::new(),
        content: old_content.to_string(),
    });
    let len = versions.len();
    if len > 50 {
        versions.drain(0..len - 50);
    }
}
/// 发布语义：把**当前**正文记为一条新版本。
/// 与 `push_version`（存"改动前的旧内容"，供自动存档用）不同，这里只由用户
/// 显式点击「发布」触发，因此：
///   · 正文为空 → 不记录（空内容没有回滚价值）
///   · 与最后一条版本内容相同 → 不重复记录（否则连点两次会出现两个相同版本）
/// 返回值表示是否真的产生了新版本。
pub fn push_published(versions: &mut Vec<VersionEntry>, content: &str) -> bool {
    if content.is_empty() {
        return false;
    }
    if versions.last().map(|v| v.content.as_str()) == Some(content) {
        return false;
    }
    push_version(versions, content);
    true
}

pub fn backup_file(path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let target = path.with_file_name(format!("{name}.agenthub-bak-{ts}"));
    std::fs::copy(path, &target).map_err(es)?;
    Ok(Some(target))
}

pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if ch == '-' || ch == '_' {
            out.push(ch);
        } else if ch == ' ' || ch == '.' {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        format!("skill-{}", chrono::Local::now().format("%Y%m%d%H%M%S"))
    } else {
        trimmed
    }
}

/// DOS 纪元阈值：1980-01-02T00:00:00Z（1980-01-01 为 315_532_800）。
///
/// ZIP 的时间戳以 1980-01-01 为原点，条目没填日期时（很多打包工具不填）
/// 就落在这一天 —— 这是「没有信息」的哨兵值，不是真实时间。
/// 留一天余量吸收时区偏移（实测有时会偏成 1979-12-31）。
pub const DOS_EPOCH_SECS: u64 = 315_619_200;

/// 时间戳是否可信：晚于 DOS 纪元阈值才算真实信息。
pub fn valid_time(t: std::time::SystemTime) -> Option<std::time::SystemTime> {
    let secs = t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    (secs >= DOS_EPOCH_SECS).then_some(t)
}

/// 把目录树里带「DOS 纪元」时间戳的文件改写为可信时间，返回改写数量。
///
/// 参考时间取该树内最新的可信 mtime —— 通常是工具自身写入的 .hub.json /
/// SKILL.toml，也就是这份内容真正被接入中枢的时刻；若全树都没有可信时间
/// （例如一个刚解包、从未被工具写过的目录），才退回当前时间。
pub fn normalize_epoch_times(root: &Path) -> usize {
    fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    collect(&p, out);
                } else {
                    out.push(p);
                }
            }
        }
    }
    let mut files: Vec<PathBuf> = Vec::new();
    collect(root, &mut files);
    if files.is_empty() {
        return 0;
    }

    let mut reference: Option<std::time::SystemTime> = None;
    for p in &files {
        if let Ok(t) = std::fs::metadata(p).and_then(|m| m.modified()) {
            if let Some(t) = valid_time(t) {
                reference = Some(reference.map_or(t, |r| r.max(t)));
            }
        }
    }
    let reference = reference.unwrap_or_else(std::time::SystemTime::now);
    let ft = filetime::FileTime::from_system_time(reference);

    let mut fixed = 0usize;
    for p in &files {
        let Ok(t) = std::fs::metadata(p).and_then(|m| m.modified()) else {
            continue;
        };
        if valid_time(t).is_none() && filetime::set_file_mtime(p, ft).is_ok() {
            fixed += 1;
        }
    }
    fixed
}

pub fn copy_dir_recursive(src: &Path, dst: &Path, skip_dotfiles: bool) -> Result<(), String> {
    copy_dir_inner(src, dst, skip_dotfiles, true)
}

fn copy_dir_inner(src: &Path, dst: &Path, skip_dotfiles: bool, top: bool) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(es)?;
    for entry in std::fs::read_dir(src).map_err(es)? {
        let entry = entry.map_err(es)?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if skip_dotfiles && file_name.starts_with('.') {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&file_name);
        if from.is_dir() {
            copy_dir_inner(&from, &to, skip_dotfiles, false)?;
        } else {
            std::fs::copy(&from, &to).map_err(es)?;
        }
    }
    // 复制会保留源文件的修改时间（Windows 的 CopyFile 行为，std::fs::copy 底层即它），
    // 其中可能带着 ZIP 的 DOS 纪元哨兵值 —— 在顶层落盘后归一化一次，
    // 这样所有「导入 / 收集进中枢」的路径都自动覆盖到，不必逐个调用点去改。
    if top {
        normalize_epoch_times(dst);
    }
    Ok(())
}

pub fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                total += dir_size(&p);
            } else if let Ok(meta) = e.metadata() {
                total += meta.len();
            }
        }
    }
    total
}

// ---------------- 测试：DOS 纪元时间戳归一化 ----------------

#[cfg(test)]
mod epoch_tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    const EPOCH_1980: u64 = 315_532_800; // 1980-01-01T00:00:00Z —— ZIP 的哨兵值
    const REAL_2027: u64 = 1_800_000_000;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-epoch-{tag}-{}", crate::ahub::models::new_id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 用 filetime 主动写入哨兵/真实时间 —— 测试因此能双向验证这个依赖
    fn set_mtime(p: &Path, secs: u64) {
        filetime::set_file_mtime(p, filetime::FileTime::from_unix_time(secs as i64, 0)).unwrap();
    }
    fn mtime(p: &Path) -> std::time::SystemTime {
        std::fs::metadata(p).unwrap().modified().unwrap()
    }

    #[test]
    fn replaces_epoch_with_reference_time() {
        let d = tmpdir("ref");
        let skill = d.join("SKILL.md");
        let hub = d.join(".hub.json");
        std::fs::write(&skill, b"x").unwrap();
        std::fs::write(&hub, b"{}").unwrap();
        set_mtime(&skill, EPOCH_1980);
        set_mtime(&hub, REAL_2027);

        let n = normalize_epoch_times(&d);
        assert_eq!(n, 1, "只应改写那一个哨兵文件，真实时间的文件不动");
        assert_eq!(mtime(&skill), mtime(&hub), "应被改写为树内最新的可信时间");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn recurses_into_subdirs() {
        let d = tmpdir("recurse");
        let sub = d.join("references");
        std::fs::create_dir_all(&sub).unwrap();
        let deep = sub.join("notes.md");
        std::fs::write(&deep, b"y").unwrap();
        let hub = d.join(".hub.json");
        std::fs::write(&hub, b"{}").unwrap();
        set_mtime(&deep, EPOCH_1980);
        set_mtime(&hub, REAL_2027);

        assert_eq!(normalize_epoch_times(&d), 1);
        assert!(valid_time(mtime(&deep)).is_some(), "子目录里的哨兵也要修");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn noop_when_all_times_are_fine() {
        let d = tmpdir("noop");
        let f = d.join("SKILL.md");
        std::fs::write(&f, b"x").unwrap();
        set_mtime(&f, REAL_2027);
        assert_eq!(normalize_epoch_times(&d), 0, "都正常时不应产生任何写入");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn falls_back_to_now_when_nothing_is_valid() {
        // 整棵树都是哨兵（刚解包、从未被工具写过）→ 用当前时间兜底
        let d = tmpdir("now");
        let f = d.join("SKILL.md");
        std::fs::write(&f, b"x").unwrap();
        set_mtime(&f, EPOCH_1980);

        assert_eq!(normalize_epoch_times(&d), 1);
        let t = mtime(&f);
        assert!(valid_time(t).is_some(), "兜底后必须是可信时间");
        // 应接近当前时间（不是又落回某个纪元）
        let age = std::time::SystemTime::now().duration_since(t).unwrap_or(Duration::ZERO);
        assert!(age.as_secs() < 120, "兜底时间应接近现在，实际相差 {:?}", age);
        std::fs::remove_dir_all(&d).ok();
    }

    /// 关键回归：复制会保留源 mtime（Windows CopyFile），
    /// 因此 copy_dir_recursive 必须在落盘后归一化，否则哨兵值一路传进中枢
    #[test]
    fn copy_dir_recursive_normalizes_epoch() {
        let src = tmpdir("cp-src");
        let dst = src.join("..").join(format!("ah-epoch-cp-dst-{}", crate::ahub::models::new_id()));
        let f = src.join("SKILL.md");
        std::fs::write(&f, b"payload").unwrap();
        set_mtime(&f, EPOCH_1980);

        copy_dir_recursive(&src, &dst, false).unwrap();

        let copied = dst.join("SKILL.md");
        assert_eq!(std::fs::read_to_string(&copied).unwrap(), "payload");
        let mt = mtime(&copied);
        assert!(
            valid_time(mt).is_some(),
            "复制后必须是可信时间（说明复制确实保留了源 mtime，且归一化生效）"
        );
        std::fs::remove_dir_all(&src).ok();
        std::fs::remove_dir_all(&dst).ok();
    }
}

#[cfg(test)]
mod publish_tests {
    use super::*;

    fn entry(v: u32, content: &str) -> VersionEntry {
        VersionEntry {
            v,
            saved_at: "2026-01-01T00:00:00+08:00".into(),
            note: String::new(),
            content: content.into(),
        }
    }

    #[test]
    fn publishes_new_content() {
        let mut vs = vec![entry(1, "v1 body")];
        assert!(push_published(&mut vs, "v2 body"));
        assert_eq!(vs.len(), 2);
        assert_eq!(vs[1].v, 2);
        assert_eq!(vs[1].content, "v2 body");
    }

    /// 连点两次「发布」不该产生两条一模一样的时间轴节点
    #[test]
    fn skips_when_same_as_last() {
        let mut vs = vec![entry(1, "same")];
        assert!(!push_published(&mut vs, "same"));
        assert_eq!(vs.len(), 1, "内容与最后一条相同时必须不新增");
    }

    #[test]
    fn skips_empty_content() {
        let mut vs: Vec<VersionEntry> = Vec::new();
        assert!(!push_published(&mut vs, ""));
        assert!(vs.is_empty(), "空正文没有回滚价值，不该产生版本");
    }

    #[test]
    fn first_publish_on_empty_history() {
        let mut vs: Vec<VersionEntry> = Vec::new();
        assert!(push_published(&mut vs, "first"));
        assert_eq!(vs.len(), 1);
        assert_eq!(vs[0].v, 1);
    }

    /// 版本号必须递增接续，不能因为裁剪历史而重头开始
    #[test]
    fn continues_numbering_after_trim() {
        let mut vs: Vec<VersionEntry> = (1..=50).map(|i| entry(i, &format!("body {i}"))).collect();
        assert!(push_published(&mut vs, "brand new"));
        assert_eq!(vs.len(), 50, "上限 50 条，超出须裁剪最旧的一条");
        assert_eq!(vs.last().unwrap().v, 51);
        assert_eq!(vs[0].v, 2, "裁剪掉的是最旧的 v1");
    }
}
