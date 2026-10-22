//! 技能摘要（skills-summary）：AI 通读技能后产出的结构化速览。
//!
//! 分工（spec `summary-content` / `ai-input-limit`）：
//! - AI 只产出 `domain` / `one_liner` / `kind` 三项；
//! - `script_count` / `reference_count` 由程序扫描目录得出，不交给 AI 估算；
//! - `generated_at` / `model` 由程序补齐。
//!
//! 摘要持久化在技能目录的 `.hub.json`（字段 `summary`），因此打开界面
//! 不会触发任何 AI 调用（spec `summary-storage`）。

use crate::ahub::models::{now_iso, SkillSummary};
use crate::ahub::store::AppH;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// 发给 AI 的正文上限（字符数）。超长技能只截取前 4000 字符。
pub const MAX_BODY_CHARS: usize = 4000;
/// 一句话功能描述上限（字符数）
pub const MAX_ONE_LINER_CHARS: usize = 40;
/// 文件名列表上限（防止超大技能把 prompt 撑爆）
const MAX_FILE_NAMES: usize = 120;

const SYSTEM_PROMPT: &str = "你是技能速览助手。阅读技能文档与文件清单，输出一个 JSON 对象，\
只包含三个字段：domain（领域，一个词或短语，如「办公」「开发」「数据分析」「设计」）、\
one_liner（一句话说清这个技能能做什么，不超过 40 个字）、\
kind（定性，只能是 tool / reference / workflow / knowledge 之一）。\
只输出 JSON，不要输出解释、不要用代码围栏。";

/// 批量生成里单个技能的结果
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BatchOutcome {
    pub dir_name: String,
    pub ok: bool,
    /// 成功时的摘要（失败为 None，前端据此就地更新）
    pub summary: Option<SkillSummary>,
    pub error: String,
}

/// `skill-summary-progress` 事件载荷
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryProgress {
    pub dir_name: String,
    pub current: usize,
    pub total: usize,
    pub ok: bool,
    pub message: String,
}

/// 生成摘要：读 SKILL.md 正文（截断 4000 字符）+ 文件名列表 → 调 AI → 补齐规模统计 → 写回 .hub.json。
pub fn generate(app: &AppH, dir_name: &str) -> Result<SkillSummary, String> {
    let root = crate::ahub::store::data_root(app).join("skills").join(dir_name);
    if !root.is_dir() {
        return Err(format!("技能不存在: {dir_name}"));
    }
    let model = crate::ahub::aihelper::resolve_model(app);

    let summary = generate_at(&root, &model, |system, user| {
        crate::ahub::aihelper::chat(app, system, user)
    })?;
    crate::ahub::skills::write_summary(app, dir_name, &summary)?;
    Ok(summary)
}

/// 纯路径 + 注入式 AI 调用的生成内核：便于单元测试与复用，不依赖 AppHandle。
pub fn generate_at<F>(root: &Path, model: &str, chat: F) -> Result<SkillSummary, String>
where
    F: Fn(&str, &str) -> Result<String, String>,
{
    let input = prepare_input(root)?;
    let raw = chat(SYSTEM_PROMPT, &input.prompt)?;
    let ai = parse_ai_json(&raw)?;
    let (script_count, reference_count) = count_scale(root);
    Ok(SkillSummary {
        domain: ai.domain,
        one_liner: truncate_chars(&ai.one_liner, MAX_ONE_LINER_CHARS),
        kind: ai.kind,
        script_count,
        reference_count,
        generated_at: now_iso(),
        model: model.to_string(),
    })
}

/// 批量生成：逐个串行（不并发压 AI 接口），每个技能结束推一条 `skill-summary-progress`。
pub fn generate_batch(app: &AppH, dir_names: Vec<String>) -> Result<Vec<BatchOutcome>, String> {
    let total = dir_names.len();
    let mut out = Vec::with_capacity(total);
    for (i, name) in dir_names.iter().enumerate() {
        let cur = i + 1;
        let outcome = match generate(app, name) {
            Ok(summary) => BatchOutcome {
                dir_name: name.clone(),
                ok: true,
                summary: Some(summary),
                error: String::new(),
            },
            // 单个失败不中断其余技能（spec `batch-generate`）
            Err(e) => BatchOutcome {
                dir_name: name.clone(),
                ok: false,
                summary: None,
                error: e,
            },
        };
        emit_progress(app, &outcome, cur, total);
        out.push(outcome);
    }
    Ok(out)
}

fn emit_progress(app: &AppH, outcome: &BatchOutcome, current: usize, total: usize) {
    use tauri::Emitter;
    let message = if outcome.ok {
        format!("已生成摘要：{}", outcome.dir_name)
    } else {
        format!("{} 生成失败：{}", outcome.dir_name, outcome.error)
    };
    let _ = app.emit(
        "skill-summary-progress",
        SummaryProgress {
            dir_name: outcome.dir_name.clone(),
            current,
            total,
            ok: outcome.ok,
            message,
        },
    );
}

// ---------------- AI 输入构造 ----------------

/// 发给 AI 的输入：正文（已截断）+ 文件名列表。
///
/// `body` / `files` 单独留出便于测试断言与后续调参（prompt 由两者拼成）。
#[allow(dead_code)]
pub struct SummaryInput {
    pub body: String,
    pub files: Vec<String>,
    pub prompt: String,
}

/// 读取 SKILL.md 正文（去 frontmatter、截断到 4000 字符）与目录树文件名列表。
pub fn prepare_input(root: &Path) -> Result<SummaryInput, String> {
    let doc_path = root.join("SKILL.md");
    let text = std::fs::read_to_string(&doc_path)
        .map_err(|e| format!("读取 SKILL.md 失败：{e}"))?;
    let body = crate::ahub::skills::split_doc(&text).1;
    let body = truncate_chars(body.trim(), MAX_BODY_CHARS);
    let files = collect_file_names(root);

    let file_list = if files.is_empty() {
        "（无其它文件）".to_string()
    } else {
        files.join("、")
    };
    let prompt = format!(
        "技能目录内的文件：{file_list}\n\n技能文档（SKILL.md 正文）：\n{body}"
    );
    Ok(SummaryInput { body, files, prompt })
}

/// 递归收集相对路径（目录以 `/` 结尾），跳过本工具自身的 sidecar 与备份文件。
fn collect_file_names(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) {
        if out.len() >= MAX_FILE_NAMES {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut items: Vec<_> = entries.flatten().collect();
        items.sort_by_key(|e| e.file_name());
        for e in items {
            if out.len() >= MAX_FILE_NAMES {
                return;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if is_internal(&name) {
                continue;
            }
            let rel = format!("{prefix}{name}");
            if e.path().is_dir() {
                out.push(format!("{rel}/"));
                walk(&e.path(), &format!("{rel}/"), out);
            } else {
                out.push(rel);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, "", &mut out);
    out
}

/// 工具自身写下的文件：既不是脚本也不是参考资料，不进 AI 输入、不计规模。
fn is_internal(name: &str) -> bool {
    name == ".hub.json"
        || name == "SKILL.toml"
        || name.starts_with('.')
        || name.contains(".agenthub-bak-")
        || name.contains(".agenthub-staging-")
}

// ---------------- 规模统计（程序算，不交给 AI） ----------------

/// 脚本类扩展名（小写、不含点）
const SCRIPT_EXTS: &[&str] = &[
    "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "sh", "bash", "zsh", "ps1", "psm1", "bat", "cmd",
    "rb", "pl", "lua", "go", "rs", "java", "kt", "php",
];

/// 统计 (脚本数, 参考文件数)。SKILL.md 与 sidecar 都不计入。
pub fn count_scale(root: &Path) -> (usize, usize) {
    fn walk(dir: &Path, scripts: &mut usize, refs: &mut usize) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if is_internal(&name) {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                walk(&p, scripts, refs);
                continue;
            }
            if name == "SKILL.md" {
                continue;
            }
            let ext = p
                .extension()
                .map(|x| x.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if SCRIPT_EXTS.contains(&ext.as_str()) {
                *scripts += 1;
            } else {
                *refs += 1;
            }
        }
    }
    let (mut scripts, mut refs) = (0usize, 0usize);
    walk(root, &mut scripts, &mut refs);
    (scripts, refs)
}

// ---------------- AI 输出解析 ----------------

/// 解析后的 AI 结论
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAi {
    pub domain: String,
    pub one_liner: String,
    pub kind: String,
}

/// 从模型输出里抠出 JSON 对象并校验字段（容忍 ``` 围栏与前后杂文字）。
pub fn parse_ai_json(content: &str) -> Result<ParsedAi, String> {
    let s = strip_fence(content);
    let candidate = match (s.find('{'), s.rfind('}')) {
        (Some(a), Some(b)) if b > a => &s[a..=b],
        _ => s.as_str(),
    };
    let value: serde_json::Value = serde_json::from_str(candidate).map_err(|e| {
        format!(
            "AI 返回内容不是合法 JSON（{e}）：{}",
            content.chars().take(200).collect::<String>()
        )
    })?;
    let get = |key: &str| -> Option<String> {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let domain = get("domain").ok_or_else(|| missing("domain", content))?;
    let one_liner = get("one_liner")
        .or_else(|| get("oneLiner"))
        .ok_or_else(|| missing("one_liner", content))?;
    let kind = get("kind").ok_or_else(|| missing("kind", content))?;
    Ok(ParsedAi {
        domain,
        one_liner,
        kind: normalize_kind(&kind),
    })
}

fn missing(field: &str, content: &str) -> String {
    format!(
        "AI 返回的 JSON 缺少字段 {field}：{}",
        content.chars().take(200).collect::<String>()
    )
}

fn strip_fence(content: &str) -> String {
    let mut s = content.trim();
    for fence in ["```json", "```JSON", "```"] {
        if let Some(rest) = s.strip_prefix(fence) {
            s = rest.trim_start();
            break;
        }
    }
    if let Some(rest) = s.strip_suffix("```") {
        s = rest.trim_end();
    }
    s.trim().to_string()
}

/// kind 归一化：只认 tool / reference / workflow / knowledge，其它一律记 tool。
pub fn normalize_kind(raw: &str) -> String {
    let k = raw.trim().to_lowercase();
    match k.as_str() {
        "reference" | "workflow" | "knowledge" | "tool" => k,
        _ => "tool".to_string(),
    }
}

/// 按字符（不是字节）截断，避免把中文切坏。
pub fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

/// 技能目录路径（供调用方定位）
#[allow(dead_code)]
pub fn skill_dir(app: &AppH, dir_name: &str) -> PathBuf {
    crate::ahub::store::data_root(app).join("skills").join(dir_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-summary-{tag}-{}", crate::ahub::models::new_id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_skill(root: &Path, body: &str) {
        std::fs::write(
            root.join("SKILL.md"),
            format!("---\nname: demo\ndescription: d\n---\n{body}"),
        )
        .unwrap();
    }

    // ---- 规模统计 ----

    #[test]
    fn counts_scripts_and_references() {
        let d = tmp("count");
        write_skill(&d, "正文");
        std::fs::write(d.join("run.py"), "print(1)").unwrap();
        std::fs::write(d.join("build.sh"), "echo").unwrap();
        std::fs::write(d.join("tool.ps1"), "Write-Host").unwrap();
        std::fs::write(d.join("index.ts"), "export {}").unwrap();
        std::fs::write(d.join("README.md"), "# hi").unwrap();
        std::fs::write(d.join("data.json"), "{}").unwrap();
        // 子目录里的脚本与参考资料都要算
        std::fs::create_dir_all(d.join("references")).unwrap();
        std::fs::write(d.join("references/a.md"), "a").unwrap();
        std::fs::create_dir_all(d.join("scripts")).unwrap();
        std::fs::write(d.join("scripts/helper.js"), "1").unwrap();

        let (scripts, refs) = count_scale(&d);
        assert_eq!(scripts, 5, "py/sh/ps1/ts/js 五个脚本");
        assert_eq!(refs, 3, "README/data.json/references/a.md 三个参考文件");
        std::fs::remove_dir_all(&d).ok();
    }

    /// SKILL.md 与工具自身的 sidecar / 备份不算规模，也不算「参考文件」
    #[test]
    fn ignores_skill_md_and_sidecars() {
        let d = tmp("sidecar");
        write_skill(&d, "正文");
        std::fs::write(d.join(".hub.json"), "{}").unwrap();
        std::fs::write(d.join("SKILL.toml"), "[meta]").unwrap();
        std::fs::write(d.join("SKILL.md.agenthub-bak-20260101-000000"), "x").unwrap();

        let (scripts, refs) = count_scale(&d);
        assert_eq!((scripts, refs), (0, 0), "自身文件不应计入规模");
        std::fs::remove_dir_all(&d).ok();
    }

    // ---- AI 输出解析 ----

    #[test]
    fn parses_plain_json() {
        let p = parse_ai_json(r#"{"domain":"开发","one_liner":"生成提交信息","kind":"tool"}"#).unwrap();
        assert_eq!(p.domain, "开发");
        assert_eq!(p.one_liner, "生成提交信息");
        assert_eq!(p.kind, "tool");
    }

    #[test]
    fn parses_fenced_json() {
        let p = parse_ai_json(
            "```json\n{\"domain\":\"办公\",\"one_liner\":\"整理会议纪要\",\"kind\":\"workflow\"}\n```",
        )
        .unwrap();
        assert_eq!(p.kind, "workflow");
        assert_eq!(p.domain, "办公");
    }

    /// 模型常在 JSON 前后加解释文字，必须仍然能抠出来
    #[test]
    fn parses_json_embedded_in_prose() {
        let p = parse_ai_json(
            "好的，这是结果：\n{\"domain\":\"设计\",\"one_liner\":\"生成配色方案\",\"kind\":\"reference\"}\n希望有帮助。",
        )
        .unwrap();
        assert_eq!(p.domain, "设计");
        assert_eq!(p.kind, "reference");
    }

    #[test]
    fn rejects_non_json() {
        let e = parse_ai_json("抱歉，我无法完成").unwrap_err();
        assert!(e.contains("不是合法 JSON"), "应给出可读原因：{e}");
    }

    #[test]
    fn rejects_missing_field() {
        let e = parse_ai_json(r#"{"domain":"开发","kind":"tool"}"#).unwrap_err();
        assert!(e.contains("one_liner"), "应指出缺哪个字段：{e}");
    }

    // ---- kind 归一化 ----

    #[test]
    fn normalizes_illegal_kind_to_tool() {
        assert_eq!(normalize_kind("script"), "tool");
        assert_eq!(normalize_kind(""), "tool");
        assert_eq!(normalize_kind("其他"), "tool");
        assert_eq!(normalize_kind("WORKFLOW"), "workflow");
        assert_eq!(normalize_kind("  Reference "), "reference");
        assert_eq!(normalize_kind("knowledge"), "knowledge");
    }

    #[test]
    fn parses_illegal_kind_as_tool() {
        let p = parse_ai_json(r#"{"domain":"开发","one_liner":"x","kind":"插件"}"#).unwrap();
        assert_eq!(p.kind, "tool");
    }

    // ---- 输入截断 ----

    #[test]
    fn truncates_body_to_4000_chars() {
        let d = tmp("trunc");
        let long: String = std::iter::repeat_n('技', 5000).collect();
        write_skill(&d, &long);

        let input = prepare_input(&d).unwrap();
        assert_eq!(input.body.chars().count(), MAX_BODY_CHARS);
        assert!(
            input.prompt.chars().count() < 4200,
            "prompt 不应显著超出截断后的正文"
        );
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn keeps_short_body_intact() {
        let d = tmp("short");
        write_skill(&d, "短正文");
        let input = prepare_input(&d).unwrap();
        assert_eq!(input.body, "短正文");
        std::fs::remove_dir_all(&d).ok();
    }

    /// frontmatter 不进 AI 输入（spec：正文不含 frontmatter）
    #[test]
    fn strips_frontmatter_from_body() {
        let d = tmp("fm");
        write_skill(&d, "只有正文");
        let input = prepare_input(&d).unwrap();
        assert!(!input.body.contains("description: d"), "frontmatter 不应出现");
        assert!(input.body.contains("只有正文"));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn truncate_counts_chars_not_bytes() {
        assert_eq!(truncate_chars("中文三个", 2), "中文");
        assert_eq!(truncate_chars("abc", 10), "abc");
    }

    // ---- 端到端（注入假 AI，验证补齐逻辑） ----

    #[test]
    fn generate_at_fills_counts_and_truncates_one_liner() {
        let d = tmp("e2e");
        write_skill(&d, "正文");
        std::fs::write(d.join("run.py"), "1").unwrap();
        std::fs::write(d.join("notes.md"), "1").unwrap();

        let long_one_liner: String = std::iter::repeat_n('长', 60).collect();
        let summary = generate_at(&d, "test-model", |_sys, user| {
            assert!(user.contains("正文"), "输入里应有正文");
            Ok(format!(
                "{{\"domain\":\"开发\",\"one_liner\":\"{long_one_liner}\",\"kind\":\"workflow\"}}"
            ))
        })
        .unwrap();

        assert_eq!(summary.domain, "开发");
        assert_eq!(summary.kind, "workflow");
        assert_eq!(summary.script_count, 1);
        assert_eq!(summary.reference_count, 1);
        assert_eq!(summary.model, "test-model");
        assert_eq!(summary.one_liner.chars().count(), MAX_ONE_LINER_CHARS);
        assert!(!summary.generated_at.is_empty());
        std::fs::remove_dir_all(&d).ok();
    }

    /// AI 报错必须原样向上抛（不静默写入空摘要）
    #[test]
    fn generate_at_propagates_ai_error() {
        let d = tmp("err");
        write_skill(&d, "正文");
        let e = generate_at(&d, "m", |_, _| Err(crate::ahub::aihelper::ERR_NOT_CONFIGURED.into()))
            .unwrap_err();
        assert!(e.contains("设置"), "未配置提示应指向设置页：{e}");
        std::fs::remove_dir_all(&d).ok();
    }

    /// 缺 SKILL.md 的技能目录应明确报错，而不是生成空摘要
    #[test]
    fn generate_at_requires_skill_md() {
        let d = tmp("nomd");
        let e = generate_at(&d, "m", |_, _| Ok("{}".into())).unwrap_err();
        assert!(e.contains("SKILL.md"), "应指出缺 SKILL.md：{e}");
        std::fs::remove_dir_all(&d).ok();
    }
}
