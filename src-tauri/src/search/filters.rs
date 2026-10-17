//! Filename-only filters shared by live Everything queries and cached names.
pub const NOISY_SEGMENTS: &[&str] = &[
    "node_modules",
    ".git",
    "winsxs",
    "$recycle.bin",
    "system volume information",
    "__pycache__",
    ".cache",
];
pub fn noisy(path: &str) -> bool {
    path.split(['/', '\\']).any(|part| {
        NOISY_SEGMENTS
            .iter()
            .any(|name| part.eq_ignore_ascii_case(name))
    })
}
pub fn name_limit(value: Option<u64>) -> u64 {
    value.unwrap_or(250_000).clamp(10_000, 5_000_000)
}
pub fn everything(
    query: &str,
    roots: Option<&[String]>,
    hide_noise: bool,
) -> Result<String, String> {
    let mut clauses = vec![];
    if !query.is_empty() {
        clauses.push(format!("<{query}>"));
    }
    if let Some(roots) = roots {
        if roots.is_empty() {
            return Err("未选择文件名索引目录".into());
        }
        if roots
            .iter()
            .any(|r| r.contains('"') || r.chars().any(char::is_control))
        {
            return Err("文件名索引目录无效".into());
        }
        clauses.push(format!(
            "<{}>",
            roots
                .iter()
                .map(|root| format!(
                    "path:\"{}\\\"",
                    root.replace('/', "\\").trim_end_matches('\\')
                ))
                .collect::<Vec<_>>()
                .join(" | ")
        ));
    }
    if hide_noise {
        clauses.extend(
            NOISY_SEGMENTS
                .iter()
                .map(|segment| format!("!path:\"\\{segment}\\\"")),
        );
    }
    Ok(clauses.join(" "))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_entire_path_segments_only() {
        for path in [
            "C:/x/node_modules/a.js",
            "C:\\Windows\\WinSxS\\x",
            "C:/.Git/config",
        ] {
            assert!(noisy(path));
        }
        for path in [
            "C:/x/node_modules-helper.exe",
            "C:/dist/program.exe",
            "C:/target/program.exe",
        ] {
            assert!(!noisy(path));
        }
    }
    #[test]
    fn grouping_preserves_query_ors_and_scopes() {
        let roots = vec!["C:/My Files".into()];
        let expression = everything("exe | bat", Some(&roots), true).unwrap();
        assert!(expression.starts_with("<exe | bat> <path:\"C:\\My Files\\\">"));
        assert!(expression.contains("!path:\"\\node_modules\\\""));
        assert!(everything("", Some(&[]), true).is_err());
        assert!(everything("", Some(&["C:/bad\"root".into()]), false).is_err());
        assert_eq!(name_limit(None), 250_000);
        assert_eq!(name_limit(Some(0)), 10_000);
        assert_eq!(name_limit(Some(u64::MAX)), 5_000_000);
    }
}
