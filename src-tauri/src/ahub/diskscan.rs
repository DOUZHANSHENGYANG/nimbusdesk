//! 全盘扫描（只读）：枚举存在的盘符 → 常见开发工具目录模式 →
//! 与 PATH 扫描相同的 `.exe/.cmd/.bat` 枚举 → 结果缓存到 `data_root()/disk-scan.json`。
//!
//! 约束（brief / spec）：
//! - **只读**：只 `read_dir`，绝不写入被扫描目录、配置文件或环境变量；
//! - 仅在用户手动刷新时执行（结果落缓存，平时读缓存）；
//! - 不扫系统目录（system32 / WindowsApps 等，与 cliscan 同一套 skip 规则）；
//! - 结果统一标来源 `disk-scan`，与 PATH / 包管理器来源区分。

use crate::ahub::models::DiscoveredCli;
use crate::ahub::store::{self, AppH};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const CACHE_FILE: &str = "disk-scan.json";

/// 盘符根的目录模式前缀：`<drive>\Dev*`、`Tool*`、`SDK*`、`Program*`（大小写不敏感）。
const ROOT_PREFIXES: &[&str] = &["dev", "tool", "sdk", "program"];

/// 已知工具的常见根目录名（Java / Python / Go / Maven / Gradle 等装在盘符根时的兜底）。
const KNOWN_ROOT_NAMES: &[&str] = &["go", "java", "maven", "gradle", "python"];

/// 容器根之下最多下探的层数：
/// `D:\03-SDK` → `JAVA` → `JDK21` → `bin` 正好 4 层（根 + 3）。
const MAX_DEPTH: usize = 3;

/// 目录数预算：防止极端目录树拖垮扫描。
const DIR_BUDGET: usize = 20_000;

/// 枚举 A:–Z: 中真实存在的盘符。
fn drives() -> Vec<PathBuf> {
    (b'A'..=b'Z')
        .map(|c| PathBuf::from(format!("{}:\\", c as char)))
        .filter(|d| d.is_dir())
        .collect()
}

/// 一个盘符上的候选根目录。
///
/// - 容器根：`Dev*` / `Tool*` / `SDK*` / `Program*` 与已知工具根名（会连同子目录一起下探）；
/// - 叶子：`<drive>\Users\<user>\.local\bin`、`<drive>\Users\<user>\scoop\shims`（直接枚举）。
fn candidate_roots(drive: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut containers = Vec::new();
    let mut leaves = Vec::new();
    if let Ok(entries) = std::fs::read_dir(drive) {
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            let matched =
                ROOT_PREFIXES.iter().any(|pre| name.starts_with(pre)) || KNOWN_ROOT_NAMES.iter().any(|k| name == *k);
            if matched && !crate::ahub::cliscan::skip_path_dir(&p) {
                containers.push(p);
            }
        }
    }
    let users = drive.join("Users");
    if users.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&users) {
            for u in entries.flatten() {
                let home = u.path();
                if !home.is_dir() {
                    continue;
                }
                for leaf in [home.join(".local").join("bin"), home.join("scoop").join("shims")] {
                    if leaf.is_dir() && !crate::ahub::cliscan::skip_path_dir(&leaf) {
                        leaves.push(leaf);
                    }
                }
            }
        }
    }
    (containers, leaves)
}

/// 递归枚举一个容器根：本目录 + 逐层子目录，直到深度用尽或预算用完。
fn scan_tree(dir: &Path, remaining: usize, label: &str, out: &mut Vec<DiscoveredCli>, budget: &mut usize) {
    if *budget == 0 {
        return;
    }
    *budget -= 1;
    crate::ahub::cliscan::scan_dir(dir, "disk-scan", label, out);
    if remaining == 0 {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() && !crate::ahub::cliscan::skip_path_dir(&p) {
                scan_tree(&p, remaining - 1, label, out, budget);
            }
        }
    }
}

/// 执行一次全盘扫描并把结果写入缓存。全程只读。
pub fn scan(app: &AppH) -> Result<Vec<DiscoveredCli>, String> {
    let mut items: Vec<DiscoveredCli> = Vec::new();
    let mut budget = DIR_BUDGET;

    // 当前用户的已知安装根目录（~/.local/bin、~/scoop/shims、~/.cargo/bin 等）—— 叶子
    for leaf in crate::ahub::cliscan::known_roots() {
        if leaf.is_dir() && !crate::ahub::cliscan::skip_path_dir(&leaf) {
            let label = leaf.to_string_lossy().into_owned();
            crate::ahub::cliscan::scan_dir(&leaf, "disk-scan", &label, &mut items);
        }
    }

    for drive in drives() {
        let (containers, leaves) = candidate_roots(&drive);
        for leaf in leaves {
            let label = leaf.to_string_lossy().into_owned();
            crate::ahub::cliscan::scan_dir(&leaf, "disk-scan", &label, &mut items);
        }
        for root in containers {
            let label = root.to_string_lossy().into_owned();
            scan_tree(&root, MAX_DEPTH, &label, &mut items, &mut budget);
        }
    }

    // 同名去重（大小写不敏感），保留先发现的
    let mut seen: HashSet<String> = HashSet::new();
    let tools: Vec<DiscoveredCli> = items
        .into_iter()
        .filter(|c| seen.insert(c.name.to_ascii_lowercase()))
        .collect();

    store::write_json(&store::data_root(app).join(CACHE_FILE), &tools)?;
    Ok(tools)
}

/// 读取上一次扫描的缓存；从未扫过返回 None。
pub fn get_cached(app: &AppH) -> Option<Vec<DiscoveredCli>> {
    store::read_json::<Vec<DiscoveredCli>>(&store::data_root(app).join(CACHE_FILE)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drives_only_lists_existing() {
        for d in drives() {
            assert!(d.is_dir(), "列出的盘符必须真实存在：{}", d.display());
        }
        // 至少能枚举到系统盘
        assert!(!drives().is_empty());
    }

    #[test]
    fn candidate_roots_match_patterns() {
        // 在真实系统盘上验证模式匹配逻辑（只读）
        let (containers, _leaves) = candidate_roots(Path::new("C:\\"));
        for c in &containers {
            let name = c.file_name().unwrap().to_string_lossy().to_ascii_lowercase();
            assert!(
                ROOT_PREFIXES.iter().any(|p| name.starts_with(p)) || KNOWN_ROOT_NAMES.contains(&name.as_str()),
                "容器根必须命中模式：{}",
                c.display()
            );
        }
        // Program Files 一定存在且应被命中
        assert!(containers.iter().any(|c| c.ends_with("Program Files")));
    }
}
