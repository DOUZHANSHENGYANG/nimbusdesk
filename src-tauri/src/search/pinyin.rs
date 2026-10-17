//! Bounded filename/title phonetic keys. Original text remains authoritative.
use ::pinyin::ToPinyinMulti;

/// Full spelling and initials, retaining ASCII for queries such as
/// `wendangapi`. Limit variant combinations rather than expanding a Cartesian
/// product for long titles containing many heteronyms.
pub fn keys(title: &str) -> String {
    if !title.chars().any(|c| c.to_pinyin_multi().is_some()) {
        return String::new();
    }
    let mut variants = vec![(String::new(), String::new())];
    for c in title.chars().take(256) {
        let options: Vec<String> = if let Some(p) = c.to_pinyin_multi() {
            p.into_iter().take(4).map(|p| p.plain().into()).collect()
        } else if c.is_alphanumeric() {
            vec![c.to_lowercase().collect()]
        } else {
            continue;
        };
        let mut next = Vec::new();
        // Enumerate default pronunciation first for every existing variant,
        // preserving the useful path even after the variant budget is full.
        for option in &options {
            for (full, initials) in &variants {
                if next.len() >= 16 {
                    break;
                }
                next.push((
                    format!("{full}{option}"),
                    format!("{initials}{}", option.chars().next().unwrap_or_default()),
                ));
            }
            if next.len() >= 16 {
                break;
            }
        }
        variants = next;
    }
    let mut keys = std::collections::BTreeSet::new();
    for (full, initials) in variants {
        keys.insert(full);
        keys.insert(initials);
    }
    keys.into_iter().collect::<Vec<_>>().join("\n")
}

pub fn matches(keys: &str, needle: &str) -> bool {
    !needle.is_empty() && keys.lines().any(|key| key.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_initials_heteronyms_and_mixed_ascii() {
        let value = keys("重庆文档 APIv2");
        assert!(matches(&value, "chongqing"));
        assert!(matches(&value, "cqwd"));
        assert!(matches(&value, "zhongqing"));
        assert!(matches(&value, "wendangapiv2"));
        assert!(!matches(&value, "wxd"));
        assert!(keys("ASCII-only").is_empty());
    }

    #[test]
    fn variants_and_title_size_are_bounded() {
        let value = keys(&"重行长乐".repeat(1000));
        assert!(value.lines().count() <= 32);
        assert!(value.len() < 64 * 1024);
    }
}
