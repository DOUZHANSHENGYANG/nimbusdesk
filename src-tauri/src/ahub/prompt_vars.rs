//! 提示词变量系统。
//!
//! 占位语法与语义对齐 AI Gist（MIT，yarin-zhang/AI-Gist）的 `prompt-template.ts`：
//! `{{name}}` 为占位符，两侧空白可有可无；同名占位可出现多次（填同一个值）。
//!
//! 设计取舍：
//! - **不做 Jinja**。上游用模板引擎支持 `{% for %}` / 过滤器等，但本工具的定位是
//!   "填几个变量"，引入模板引擎属过度设计，还会带来沙箱与转义风险。
//! - **不做 AI 生成/调优**。那要接模型 API 与密钥管理，与"工具管理"的定位无关。
//! - 变量定义与正文**可能不同步**：正文里删掉了占位符，变量定义还在。
//!   这里区分 active（正文中出现的）与 unused（仅存在于定义的），
//!   渲染只认 active，避免把残留定义当成真实变量。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 变量类型。渲染时只影响值的转换与空值判定，不做模板运算。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VarType {
    Text,
    Textarea,
    Select,
    Number,
    Boolean,
}

impl Default for VarType {
    fn default() -> Self {
        VarType::Text
    }
}

impl VarType {
    /// 归一化：接受 int/float/bool 等别名（与上游 normalizeVariableType 一致）。
    pub fn normalize(s: &str) -> VarType {
        match s.trim().to_ascii_lowercase().as_str() {
            "textarea" => VarType::Textarea,
            "select" => VarType::Select,
            "number" | "int" | "float" => VarType::Number,
            "boolean" | "bool" => VarType::Boolean,
            _ => VarType::Text,
        }
    }
}

/// 一个变量的定义（持久化在 Prompt 里）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptVariable {
    pub name: String,
    #[serde(default)]
    pub r#type: VarType,
    #[serde(default)]
    pub default_value: String,
    /// select 的候选值
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub placeholder: String,
    #[serde(default)]
    pub description: String,
}

impl PromptVariable {
    pub fn new(name: &str) -> Self {
        PromptVariable {
            name: name.to_string(),
            r#type: VarType::Text,
            default_value: String::new(),
            options: Vec::new(),
            // 与上游一致：新建变量默认必填
            required: true,
            placeholder: String::new(),
            description: String::new(),
        }
    }
}

/// 正文切片：文本或占位符。用于重命名/删除时精确改写，避免正则误伤。
#[derive(Debug, Clone, PartialEq)]
pub enum Segment {
    Text(String),
    Var { name: String, raw: String },
}

/// 未闭合的 `{{`（有开无合）—— 提供给界面做提示，不阻断渲染。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub kind: String,
    pub start: usize,
    pub end: usize,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct Parsed {
    pub segments: Vec<Segment>,
    /// 按首次出现顺序去重
    pub names: Vec<String>,
    pub diagnostics: Vec<Diagnostic>,
}

/// 解析正文里的 `{{占位}}`。
///
/// 空名字（`{{}}`、`{{   }}`）会被跳过且不报错——上游也是这个行为。
/// 名字里不允许 `{` `}` 与换行，避免跨行吞掉大段内容。
pub fn parse(content: &str) -> Parsed {
    let bytes = content.as_bytes();
    let mut segments: Vec<Segment> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    let mut cursor = 0usize;
    let mut i = 0usize;

    while i + 1 < bytes.len() {
        if bytes[i] == b'{' && bytes[i + 1] == b'{' {
            // 找闭合的 }}
            if let Some(rel) = content[i + 2..].find("}}") {
                let inner_start = i + 2;
                let inner_end = inner_start + rel;
                let raw_end = inner_end + 2;
                let raw = &content[i..raw_end];
                let name = content[inner_start..inner_end].trim();
                // 名字非法（含括号/换行）→ 视为未闭合，继续往后找
                if !name.is_empty() && !name.contains('{') && !name.contains('}') && !name.contains('\n') && !name.contains('\r') {
                    if i > cursor {
                        segments.push(Segment::Text(content[cursor..i].to_string()));
                    }
                    if !names.iter().any(|n| n == name) {
                        names.push(name.to_string());
                    }
                    segments.push(Segment::Var {
                        name: name.to_string(),
                        raw: raw.to_string(),
                    });
                    cursor = raw_end;
                    i = raw_end;
                    continue;
                }
            }
        }
        i += 1;
    }

    if cursor < content.len() || segments.is_empty() {
        segments.push(Segment::Text(content[cursor..].to_string()));
    }

    // 未闭合诊断：扫描所有 `{{`，只有「找不到任何 }}」才算未闭合。
    // 注意不能只看合法占位区间 —— `{{}}` / `{{   }}` 是合法的空占位
    // （上游同样跳过它们且不报错），若把它们排除在区间外会被误报成未闭合。
    let mut diagnostics = Vec::new();
    let mut offset = content.find("{{");
    while let Some(off) = offset {
        // 从这个 {{ 到下一个 }} 之间若含换行或另一个 {{，视为没有闭合
        let rest = &content[off + 2..];
        let closed = rest.find("}}").map(|r| &rest[..r]);
        let looks_closed = match closed {
            Some(inner) => !inner.contains('{') && !inner.chars().any(|c| c.is_control()),
            None => false,
        };
        if !looks_closed {
            let line_end = content[off..].find('\n').map(|r| off + r).unwrap_or(content.len());
            diagnostics.push(Diagnostic {
                kind: "unclosed-variable".into(),
                start: off,
                end: line_end,
                message: "占位符未闭合".into(),
            });
        }
        offset = content[off + 2..].find("{{").map(|r| off + 2 + r);
    }

    Parsed {
        segments,
        names,
        diagnostics,
    }
}

/// 变量定义与正文的对账结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reconciled {
    /// 正文中出现的变量（按首次出现顺序），已合并定义
    pub active: Vec<PromptVariable>,
    /// 只在定义里、正文已不再引用
    pub unused: Vec<PromptVariable>,
}

/// 把正文解析结果与已有定义合并：正文决定"有哪些"，定义决定"长什么样"。
///
/// 正文里出现但**没有定义**的占位符不会出现在 active 里 —— 它们由调用方决定
/// 是否自动补建定义（编辑器场景补建、渲染场景原样保留）。
pub fn reconcile(content: &str, defined: &[PromptVariable]) -> Reconciled {
    let parsed = parse(content);
    let mut by_name: BTreeMap<&str, &PromptVariable> = BTreeMap::new();
    for v in defined {
        if !v.name.is_empty() {
            by_name.insert(v.name.as_str(), v);
        }
    }
    let active: Vec<PromptVariable> = parsed
        .names
        .iter()
        .filter_map(|n| by_name.get(n.as_str()).map(|v| (*v).clone()))
        .collect();
    let unused: Vec<PromptVariable> = defined
        .iter()
        .filter(|v| !v.name.is_empty() && !parsed.names.iter().any(|n| n == &v.name))
        .cloned()
        .collect();
    Reconciled { active, unused }
}

/// 编辑器场景：按正文补齐定义 —— 正文里出现但尚无定义的占位符自动建一条默认定义。
/// 与 `reconcile` 的区别是它会补建；渲染路径不能用它，否则未定义占位符会被吞掉。
pub fn reconcile_for_editor(content: &str, defined: &[PromptVariable]) -> Reconciled {
    let parsed = parse(content);
    let mut by_name: BTreeMap<&str, &PromptVariable> = BTreeMap::new();
    for v in defined {
        if !v.name.is_empty() {
            by_name.insert(v.name.as_str(), v);
        }
    }
    let active: Vec<PromptVariable> = parsed
        .names
        .iter()
        .map(|n| {
            by_name
                .get(n.as_str())
                .map(|v| (*v).clone())
                .unwrap_or_else(|| PromptVariable::new(n))
        })
        .collect();
    let unused: Vec<PromptVariable> = defined
        .iter()
        .filter(|v| !v.name.is_empty() && !parsed.names.iter().any(|n| n == &v.name))
        .cloned()
        .collect();
    Reconciled { active, unused }
}

/// 变量名校验。返回 `None` 表示合法。
pub fn validate_name(name: &str, defined: &[PromptVariable], current: Option<&str>) -> Option<&'static str> {
    let n = name.trim();
    if n.is_empty() {
        return Some("required");
    }
    if n.contains('{') || n.contains('}') || n.contains('\n') || n.contains('\r') {
        return Some("invalid");
    }
    let dup = defined
        .iter()
        .any(|v| Some(v.name.as_str()) != current && v.name == n);
    if dup {
        return Some("duplicate");
    }
    None
}

/// 重命名：只改写占位符本身，不动正文其它内容（含同名纯文本）。
pub fn rename_variable(content: &str, from: &str, to: &str) -> String {
    parse(content)
        .segments
        .iter()
        .map(|seg| match seg {
            Segment::Var { name, .. } if name == from => format!("{{{{{to}}}}}"),
            Segment::Var { raw, .. } => raw.clone(),
            Segment::Text(t) => t.clone(),
        })
        .collect()
}

/// 删除某个变量的所有占位符（连同占位符本身一起移除，不留空洞标记）。
pub fn remove_variable(content: &str, name: &str) -> String {
    parse(content)
        .segments
        .iter()
        .filter_map(|seg| match seg {
            Segment::Var { name: n, .. } if n == name => None,
            Segment::Var { raw, .. } => Some(raw.clone()),
            Segment::Text(t) => Some(t.clone()),
        })
        .collect()
}

/// 渲染结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rendered {
    pub content: String,
    /// 必填但没给值的变量名
    pub missing: Vec<String>,
}

fn is_empty_value(v: Option<&String>) -> bool {
    match v {
        None => true,
        Some(s) => s.trim().is_empty(),
    }
}

/// 用给定值填充占位符。
///
/// - 未提供的变量：用 defaultValue；仍为空则按 required 记入 missing
/// - 正文中不存在对应定义的占位符：原样保留（避免悄悄吞掉用户内容）
pub fn render(content: &str, defined: &[PromptVariable], values: &BTreeMap<String, String>) -> Rendered {
    let rec = reconcile(content, defined);
    let mut missing = Vec::new();
    for v in &rec.active {
        let given = values.get(&v.name);
        if v.required && is_empty_value(given) && v.default_value.trim().is_empty() {
            missing.push(v.name.clone());
        }
    }
    let map: BTreeMap<&str, &PromptVariable> = rec.active.iter().map(|v| (v.name.as_str(), v)).collect();
    let out = parse(content)
        .segments
        .iter()
        .map(|seg| match seg {
            Segment::Text(t) => t.clone(),
            Segment::Var { name, raw } => {
                let Some(def) = map.get(name.as_str()) else {
                    return raw.clone();
                };
                match values.get(name) {
                    Some(v) => v.clone(),
                    None => def.default_value.clone(),
                }
            }
        })
        .collect();
    Rendered {
        content: out,
        missing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vmap(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn parses_placeholders_and_dedupes_names() {
        let p = parse("写一个 {{lang}} 的 {{kind}}，用 {{lang}} 实现");
        assert_eq!(p.names, vec!["lang", "kind"]);
        assert_eq!(p.diagnostics.len(), 0);
        // 切分：TEXT / VAR(lang) / TEXT / VAR(kind) / TEXT / VAR(lang) / TEXT
        // 注意 {{lang}} 出现了两次，两个出现各占一段 —— 共 7 段
        assert_eq!(p.segments.len(), 7);
    }

    #[test]
    fn trims_whitespace_inside_braces() {
        let p = parse("a{{  name  }}b");
        assert_eq!(p.names, vec!["name"]);
        match &p.segments[1] {
            Segment::Var { name, .. } => assert_eq!(name, "name"),
            _ => panic!("应为变量段"),
        }
    }

    #[test]
    fn skips_empty_placeholder() {
        // {{}} 与 {{  }} 既不是变量，也不该报未闭合
        let p = parse("a {{}} b {{   }} c");
        assert!(p.names.is_empty());
        assert_eq!(p.diagnostics.len(), 0);
    }

    #[test]
    fn reports_unclosed_placeholder() {
        let p = parse("开头 {{name 没闭合");
        assert_eq!(p.diagnostics.len(), 1);
        assert_eq!(p.diagnostics[0].kind, "unclosed-variable");
    }

    #[test]
    fn no_false_positive_for_closed_placeholder() {
        let p = parse("{{a}} 和 {{b}}");
        assert_eq!(p.diagnostics.len(), 0);
        assert_eq!(p.names, vec!["a", "b"]);
    }

    #[test]
    fn reconcile_splits_active_and_unused() {
        let defined = vec![
            PromptVariable::new("lang"),
            PromptVariable::new("ghost"),
        ];
        let r = reconcile("用 {{lang}} 写", &defined);
        assert_eq!(r.active.len(), 1);
        assert_eq!(r.active[0].name, "lang");
        // 定义里有、正文没引用 → unused，不能当成真实变量
        assert_eq!(r.unused.len(), 1);
        assert_eq!(r.unused[0].name, "ghost");
    }

    #[test]
    fn reconcile_does_not_create_definition_for_undefined() {
        // 渲染路径：正文有占位符但无定义 → 不补建，交由 render 原样保留
        let r = reconcile("{{brand_new}}", &[]);
        assert!(r.active.is_empty(), "无定义的占位符不应出现在 active 里");
    }

    #[test]
    fn editor_reconcile_creates_default_for_undefined() {
        let r = reconcile_for_editor("{{brand_new}}", &[]);
        assert_eq!(r.active.len(), 1);
        assert_eq!(r.active[0].name, "brand_new");
        assert_eq!(r.active[0].r#type, VarType::Text);
        assert!(r.active[0].required, "新建变量默认必填（与上游一致）");
    }

    #[test]
    fn validate_rejects_bad_names() {
        let defined = vec![PromptVariable::new("taken")];
        assert_eq!(validate_name("", &defined, None), Some("required"));
        assert_eq!(validate_name("  ", &defined, None), Some("required"));
        assert_eq!(validate_name("a{b", &defined, None), Some("invalid"));
        assert_eq!(validate_name("a\nb", &defined, None), Some("invalid"));
        assert_eq!(validate_name("taken", &defined, None), Some("duplicate"));
        // 改名时与自身同名不算重复
        assert_eq!(validate_name("taken", &defined, Some("taken")), None);
        assert_eq!(validate_name("fresh", &defined, None), None);
    }

    #[test]
    fn rename_only_touches_placeholders() {
        // 正文里也有同名的纯文本，必须保持不变
        let src = "用 {{lang}} 写，lang 这个词不要动";
        let out = rename_variable(src, "lang", "language");
        assert_eq!(out, "用 {{language}} 写，lang 这个词不要动");
    }

    #[test]
    fn rename_handles_repeated_placeholders() {
        let out = rename_variable("{{a}} 与 {{a}} 与 {{ab}}", "a", "x");
        assert_eq!(out, "{{x}} 与 {{x}} 与 {{ab}}");
    }

    #[test]
    fn remove_strips_placeholder_entirely() {
        let out = remove_variable("前缀{{a}}后缀{{b}}", "a");
        assert_eq!(out, "前缀后缀{{b}}");
    }

    #[test]
    fn render_fills_values_and_defaults() {
        let defined = vec![
            PromptVariable { default_value: "Rust".into(), ..PromptVariable::new("lang") },
            PromptVariable { default_value: "".into(), required: false, ..PromptVariable::new("who") },
        ];
        let r = render("用 {{lang}} 给 {{who}} 写", &defined, &vmap(&[("who", "小王")]));
        assert_eq!(r.content, "用 Rust 给 小王 写");
        assert!(r.missing.is_empty());
    }

    #[test]
    fn render_reports_missing_required() {
        let defined = vec![PromptVariable::new("lang")]; // 默认必填、无默认值
        let r = render("用 {{lang}} 写", &defined, &BTreeMap::new());
        assert_eq!(r.missing, vec!["lang"]);
        // 仍应产出内容（占位符被替换成空），由界面决定是否拦截
        assert_eq!(r.content, "用  写");
    }

    #[test]
    fn render_keeps_unknown_placeholder() {
        // 正文有占位符但没有对应定义 → 原样保留，不悄悄吞掉
        let r = render("{{unknown}}", &[], &BTreeMap::new());
        assert_eq!(r.content, "{{unknown}}");
    }

    #[test]
    fn whitespace_only_value_counts_as_missing() {
        let defined = vec![PromptVariable::new("x")];
        let r = render("{{x}}", &defined, &vmap(&[("x", "   ")]));
        assert_eq!(r.missing, vec!["x"]);
    }

    #[test]
    fn var_type_normalizes_aliases() {
        assert_eq!(VarType::normalize("int"), VarType::Number);
        assert_eq!(VarType::normalize("float"), VarType::Number);
        assert_eq!(VarType::normalize("bool"), VarType::Boolean);
        assert_eq!(VarType::normalize("textarea"), VarType::Textarea);
        assert_eq!(VarType::normalize("whatever"), VarType::Text);
    }

    #[test]
    fn roundtrip_preserves_content_exactly() {
        // 解析再拼回必须逐字节一致 —— 否则保存提示词会静默改坏内容
        for src in [
            "纯文本",
            "{{a}}",
            "前{{a}}中{{b}}后",
            "{{}} 空占位",
            "含 {{ 未闭合",
            "多行\n{{a}}\n第二行",
            "中文 {{变量 名}} 结尾",
        ] {
            let rebuilt: String = parse(src)
                .segments
                .iter()
                .map(|s| match s {
                    Segment::Text(t) => t.clone(),
                    Segment::Var { raw, .. } => raw.clone(),
                })
                .collect();
            assert_eq!(rebuilt, src, "roundtrip 失败: {src:?}");
        }
    }
}
