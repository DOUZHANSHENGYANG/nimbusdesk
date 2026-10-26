//! 动作注册表。
//!
//! 一个动作 = 一行 `ACTIONS`：id / 显示名（i18n key）/ 超时 / 参数表单声明 /
//! 执行函数。前端按 `fields` 声明渲染参数表单，所以**加动作不必改界面**。
//!
//! 两类动作：
//! - `Kind::Local`：在 Rust 侧直接执行（`ai_prompt`）。凭据在这一侧。
//! - `Kind::Delegated`：真正实现在前端（`refresh_feeds` / `backup`）。引擎发一条
//!   `schedule://action` 事件、等前端回调 `schedule_action_result`。
//!   为什么不是「在 Rust 里重写一遍 RSS 抓取和备份打包」：那两条链路的实现
//!   （`src/sources/*`、`src/features/settings/backup.ts`）本来就在前端，
//!   在 Rust 里复制一份等于两份实现各自演化 —— 用户要的是"到点能跑"，
//!   不是把已有的东西抄第二遍。

use crate::ahub::items;
use crate::ahub::prompt_vars::{self, PromptVariable};
use crate::ahub::store::AppH;
use crate::commands::{ai, data};
use chrono::{DateTime, Datelike, Local};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// AI 一次调用给足余量（`request_chat` 自己的客户端超时是 90s）。
pub const AI_TIMEOUT_MS: u64 = 120_000;
/// 全量刷新信息源：几十个源逐个抓，网络慢时 5 分钟都不够，给到 10 分钟。
pub const FEEDS_TIMEOUT_MS: u64 = 600_000;
/// 备份：把全部模块状态打包成一份 JSON。
pub const BACKUP_TIMEOUT_MS: u64 = 120_000;
/// 其余动作够用。
pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;

#[derive(Debug, Clone)]
pub struct Outcome {
    /// 产出，写进历史供用户直接定位（备份文件路径 / 刷新条数 / AI 的整段回答）
    pub note: Option<String>,
}

pub type RunResult = Result<Outcome, String>;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Local,
    Delegated,
}

/// 执行上下文：动作拿得到 app handle、任务身份与自己的参数。
pub struct Ctx<'a> {
    pub app: &'a AppH,
    pub task_id: &'a str,
    pub task_name: &'a str,
    pub params: &'a Value,
}

pub struct ActionDef {
    pub id: &'static str,
    /// i18n key（zh/en 逐条对齐由 `pnpm check:i18n` 兜底）
    pub label: &'static str,
    pub timeout_ms: u64,
    pub kind: Kind,
    /// 参数表单声明（JSON 数组）。字段类型见 `src/features/schedule/editor.tsx`。
    pub fields: &'static str,
    pub run: Option<fn(&Ctx) -> RunResult>,
}

/// ────────────────────────────────────────────────────────────────────
/// 注册表：加动作 = 在下面这张表里加一行（`fields` 里声明参数、`run` 指向执行函数），
/// 前端不用动。要改的**唯一一行**就是 `ACTIONS` 数组。
/// ────────────────────────────────────────────────────────────────────
pub static ACTIONS: &[ActionDef] = &[
    ActionDef {
        id: "ai_prompt",
        label: "schedule.action.aiPrompt",
        timeout_ms: AI_TIMEOUT_MS,
        kind: Kind::Local,
        fields: r#"[
            {"name":"promptId","type":"prompt","label":"schedule.field.promptId","hint":"schedule.field.promptIdHint"},
            {"name":"instruction","type":"textarea","label":"schedule.field.instruction","hint":"schedule.field.instructionHint"}
        ]"#,
        run: Some(ai_prompt),
    },
    ActionDef {
        id: "refresh_feeds",
        label: "schedule.action.refreshFeeds",
        timeout_ms: FEEDS_TIMEOUT_MS,
        kind: Kind::Delegated,
        fields: r#"[
            {"name":"sourceId","type":"source","label":"schedule.field.sourceId","hint":"schedule.field.sourceIdHint"}
        ]"#,
        run: None,
    },
    ActionDef {
        id: "backup",
        label: "schedule.action.backup",
        timeout_ms: BACKUP_TIMEOUT_MS,
        kind: Kind::Delegated,
        fields: "[]",
        run: None,
    },
];

pub fn find(id: &str) -> Option<&'static ActionDef> {
    ACTIONS.iter().find(|action| action.id == id)
}

/// 参数表单的声明是按需解析的：注册表里存字符串，界面上用对象。
pub fn describe() -> Vec<Value> {
    ACTIONS
        .iter()
        .map(|action| {
            json!({
                "id": action.id,
                "label": action.label,
                "timeoutMs": action.timeout_ms,
                "delegated": action.kind == Kind::Delegated,
                "fields": serde_json::from_str::<Value>(action.fields).unwrap_or_else(|_| json!([])),
            })
        })
        .collect()
}

fn str_param(params: &Value, name: &str) -> String {
    params
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// 动作层注入的内置日期变量。
///
/// 源侧的 `prompt_vars` 只有「用户定义过的变量」才会被渲染（未定义的占位符原样保留），
/// 所以这里把内置变量**当成定义补进去**，不改源侧任何文件。
/// 命名取舍：`weekday` 用 ISO 英文名（跨语言无歧义），中文星期另给 `weekdayCn`。
fn builtin_vars(now: DateTime<Local>) -> Vec<(&'static str, String)> {
    const EN: [&str; 7] = [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
    ];
    const CN: [&str; 7] = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];
    let index = now.weekday().num_days_from_monday() as usize;
    vec![
        ("date", now.format("%Y-%m-%d").to_string()),
        ("time", now.format("%H:%M").to_string()),
        ("datetime", now.format("%Y-%m-%d %H:%M").to_string()),
        ("weekday", EN[index].to_string()),
        ("weekdayCn", CN[index].to_string()),
    ]
}

/// 渲染提示词：用户给的非空默认值优先，内置日期变量补空。
///
/// 必填变量既没默认值也不是内置变量时**报错而不是发一条空提示词** ——
/// 定时任务是无人值守的，悄悄发出「用 写一个 的」比直接失败更糟。
fn render_prompt(prompt: &crate::ahub::models::Prompt, now: DateTime<Local>) -> Result<String, String> {
    let builtins = builtin_vars(now);
    let mut defined: Vec<PromptVariable> = prompt.variables.clone();
    for (name, _) in &builtins {
        if !defined.iter().any(|variable| variable.name == *name) {
            defined.push(PromptVariable {
                required: false,
                ..PromptVariable::new(name)
            });
        }
    }
    let mut values: BTreeMap<String, String> = BTreeMap::new();
    for variable in &prompt.variables {
        if !variable.default_value.trim().is_empty() {
            values.insert(variable.name.clone(), variable.default_value.clone());
        }
    }
    for (name, value) in builtins {
        values.entry(name.to_string()).or_insert(value);
    }
    let rendered = prompt_vars::render(&prompt.content, &defined, &values);
    if !rendered.missing.is_empty() {
        return Err(format!(
            "SCHEDULE_PROMPT_VAR_MISSING: {}",
            rendered.missing.join(", ")
        ));
    }
    Ok(rendered.content)
}

/// 从 `ai-providers` 的持久化状态里挑出默认文本提供商，转成 `ChatInput.provider`。
/// 只读：不写回、不改语义。凭据不在这里读（`ai::chat_once` 自己去 Credential Manager 取）。
fn resolve_provider() -> Result<Value, String> {
    let stored = data::read_current("ai-providers")?.ok_or("AI_NO_PROVIDER")?;
    let state = stored.get("state").unwrap_or(&stored);
    let providers = state
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let default_id = state.get("defaultTextId").and_then(Value::as_str).unwrap_or("");
    let provider = providers
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(default_id))
        .or_else(|| providers.first())
        .ok_or("AI_NO_PROVIDER")?;
    let model = provider.get("model").and_then(Value::as_str).unwrap_or("");
    let parameters = provider
        .get("models")
        .and_then(Value::as_array)
        .and_then(|models| models.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(model)))
        .and_then(|item| item.get("parameters"))
        .filter(|value| value.as_object().is_some_and(|fields| !fields.is_empty()))
        .cloned();
    let mut out = json!({
        "id": provider.get("id").cloned().unwrap_or(Value::Null),
        "baseUrl": provider.get("baseUrl").cloned().unwrap_or(Value::Null),
        "model": model,
        "vision": provider.get("vision").and_then(Value::as_bool).unwrap_or(false),
    });
    if let Some(parameters) = parameters {
        out["parameters"] = parameters;
    }
    Ok(out)
}

/// 跑一条提示词，把回答作为这次运行的产出。**不再写进知识库**：
/// 「到点跑一段 AI」和「把产出归档进笔记库」是两件事，后者该由用户自己做主，
/// 之前是动作里硬编码写进知识库收件箱（还得先绑好知识库目录，否则整条任务失败）。
fn ai_prompt(ctx: &Ctx) -> RunResult {
    let now = Local::now();
    let prompt_id = str_param(ctx.params, "promptId");
    let instruction = str_param(ctx.params, "instruction");

    let mut body = String::new();
    if !prompt_id.is_empty() {
        let prompts = items::list_prompts(ctx.app)?;
        let prompt = prompts
            .iter()
            .find(|item| item.id == prompt_id)
            .ok_or_else(|| format!("SCHEDULE_PROMPT_NOT_FOUND: {prompt_id}"))?;
        body = render_prompt(prompt, now)?;
    }
    if !instruction.is_empty() {
        if !body.trim().is_empty() {
            body.push_str("\n\n");
        }
        body.push_str(&instruction);
    }
    if body.trim().is_empty() {
        return Err("SCHEDULE_ACTION_NO_PROMPT".into());
    }

    let answer = ai::chat_once(resolve_provider()?, body)?;
    Ok(Outcome {
        // 整段回答就是产出：历史里看得到（单行截断 + 悬停全文），点一下能复制走。
        note: Some(answer.trim().to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ahub::models::Prompt;

    fn prompt(content: &str, variables: Vec<PromptVariable>) -> Prompt {
        Prompt {
            id: "p1".into(),
            title: "标题".into(),
            description: String::new(),
            content: content.into(),
            tags: Vec::new(),
            variables,
            versions: Vec::new(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn now() -> DateTime<Local> {
        crate::schedule::model::parse_dt("2026-10-22T09:30:00").unwrap()
    }

    #[test]
    fn registry_ids_are_unique_and_every_row_is_consistent() {
        let mut ids: Vec<&str> = ACTIONS.iter().map(|action| action.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "动作 id 不能重复");
        for action in ACTIONS {
            assert!(action.timeout_ms > 0, "{} 必须有超时", action.id);
            assert!(action.label.starts_with("schedule.action."), "{}", action.id);
            let fields: Value = serde_json::from_str(action.fields).expect("fields 必须是 JSON");
            assert!(fields.is_array(), "{} 的 fields 必须是数组", action.id);
            match action.kind {
                Kind::Local => assert!(action.run.is_some(), "{} 是本地动作，必须有执行函数", action.id),
                Kind::Delegated => assert!(action.run.is_none(), "{} 交给前端，不该有本地执行函数", action.id),
            }
        }
        assert_eq!(find("ai_prompt").unwrap().timeout_ms, AI_TIMEOUT_MS, "AI 动作要给足超时");
        assert!(find("nope").is_none());
        // 三个 v1 动作都在
        for id in ["ai_prompt", "refresh_feeds", "backup"] {
            assert!(find(id).is_some(), "缺少动作 {id}");
        }
        assert_eq!(describe().len(), ACTIONS.len());
    }

    #[test]
    fn builtin_variables_cover_the_documented_names() {
        let names: Vec<&str> = builtin_vars(now()).into_iter().map(|(name, _)| name).collect();
        assert_eq!(names, vec!["date", "time", "datetime", "weekday", "weekdayCn"]);
        let values: BTreeMap<&str, String> = builtin_vars(now()).into_iter().collect();
        assert_eq!(values["date"], "2026-10-22");
        assert_eq!(values["time"], "09:30");
        assert_eq!(values["weekday"], "Thursday");
        assert_eq!(values["weekdayCn"], "星期四");
    }

    #[test]
    fn builtin_variables_fill_placeholders_the_prompt_never_declared() {
        let rendered = render_prompt(&prompt("今天是 {{date}}（{{weekdayCn}}），写一份日报", vec![]), now()).unwrap();
        assert_eq!(rendered, "今天是 2026-10-22（星期四），写一份日报");
    }

    #[test]
    fn declared_defaults_win_over_builtin_except_when_blank() {
        let declared = PromptVariable {
            default_value: "2020-01-01".into(),
            ..PromptVariable::new("date")
        };
        assert_eq!(render_prompt(&prompt("{{date}}", vec![declared]), now()).unwrap(), "2020-01-01");
        let blank = PromptVariable {
            required: false,
            ..PromptVariable::new("date")
        };
        assert_eq!(render_prompt(&prompt("{{date}}", vec![blank]), now()).unwrap(), "2026-10-22");
    }

    #[test]
    fn required_variable_without_value_fails_instead_of_sending_an_empty_prompt() {
        let error = render_prompt(&prompt("用 {{lang}} 写", vec![PromptVariable::new("lang")]), now()).unwrap_err();
        assert_eq!(error, "SCHEDULE_PROMPT_VAR_MISSING: lang");
    }

    #[test]
    fn unknown_placeholders_are_left_alone() {
        // 源侧语义：没有定义的占位符原样保留，不被吞掉
        assert_eq!(render_prompt(&prompt("{{unknown}} 与 {{date}}", vec![]), now()).unwrap(), "{{unknown}} 与 2026-10-22");
    }

    #[test]
    fn provider_resolution_prefers_the_stored_parameters_of_the_selected_model() {
        let stored = json!({
            "state": {
                "providers": [
                    {"id": "other", "baseUrl": "https://other.test/v1", "model": "m", "vision": false},
                    {"id": "mine", "baseUrl": "https://mine.test/v1/", "model": "big", "vision": false,
                     "models": [{"id": "big", "vision": false, "parameters": {"temperature": 0.2}}]},
                ],
                "defaultTextId": "mine",
            },
            "version": 1,
        });
        let state = stored.get("state").unwrap();
        let default_id = state["defaultTextId"].as_str().unwrap();
        let providers = state["providers"].as_array().unwrap();
        // 与 resolve_provider 同一段挑选逻辑：默认 id 命中就选它，否则退回第一个
        let picked = providers.iter().find(|item| item["id"].as_str() == Some(default_id)).unwrap();
        assert_eq!(picked["id"], "mine");
        let parameters = picked["models"][0]["parameters"].clone();
        assert_eq!(parameters["temperature"], 0.2);
    }

    #[test]
    fn str_param_trims_and_tolerates_missing_values() {
        let params = json!({"name": "  x  ", "n": 5});
        assert_eq!(str_param(&params, "name"), "x");
        assert_eq!(str_param(&params, "n"), "");
        assert_eq!(str_param(&params, "absent"), "");
    }
}
