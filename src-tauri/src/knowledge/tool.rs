//! 跑知识库自己的 Python 工具（kb.py / archive.py / promote.py / harvest.py），
//! 把它们的 `--json` 输出原样交回前端。
//!
//! 为什么不在 Rust 里重写体检与分诊：规则只应存在库内一份（99-系统/config.yaml +
//! 那些脚本）。同一套规则两份实现必然漂移，库的 DESIGN.md 里已经因为两份 config
//! 静默关掉过一次 type 校验。
use std::path::{Path, PathBuf};
use std::process::Command;

/// 白名单：(工具脚本相对库根的路径, 追加参数)。前端只能点名这里列出的动作。
fn invocation(action: &str, argument: &str) -> Option<(&'static str, Vec<String>)> {
    let kb = "99-系统/manage/tools/kb.py";
    let archive = "00-Agent工作区/manage/tools/archive.py";
    let promote = "00-Agent工作区/manage/tools/promote.py";
    let harvest = "00-Agent工作区/manage/tools/harvest.py";
    Some(match action {
        "report" => (kb, vec!["report".into(), "--json".into()]),
        "search" => {
            if argument.trim().is_empty() {
                return None;
            }
            (
                kb,
                vec![
                    "search".into(),
                    argument.to_string(),
                    "--json".into(),
                    "--limit".into(),
                    "50".into(),
                ],
            )
        }
        "triage_status" => (archive, vec!["status".into(), "--json".into()]),
        "triage_plan" => (archive, vec!["plan".into(), "--json".into()]),
        "triage_run" => (archive, vec!["run".into(), "--json".into()]),
        "loop_status" => (promote, vec!["status".into(), "--json".into()]),
        "backlog" => (harvest, vec!["backlog".into(), "--json".into()]),
        // 两个确定性修复：去 BOM、重建静态索引。都是库内脚本的既有能力。
        "fix_bom" => (kb, vec!["fixbom".into()]),
        "index_build" => ("99-系统/manage/tools/index.py", vec!["build".into()]),
        _ => return None,
    })
}

fn run(script: &Path, args: &[String], root: &Path) -> Result<String, String> {
    let mut spawn_error = String::new();
    for binary in ["python", "py"] {
        let mut command = Command::new(binary);
        command
            .arg(script)
            .args(args)
            .current_dir(root)
            // 输出走管道时 Python 默认用本地代码页，中文会乱码。
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1");
        #[cfg(windows)]
        {
            // 不要弹黑框。
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        match command.output() {
            // 解释器找到了：成功就用 stdout，失败就把 stderr 原样带回去，
            // 不再换第二个解释器重试（同一个脚本，换了解释器也是同样的错）。
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if output.status.success() {
                    if stdout.is_empty() {
                        return Err("知识库工具没有输出".into());
                    }
                    return Ok(stdout);
                }
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(if stderr.is_empty() {
                    stdout.lines().next().unwrap_or("知识库工具执行失败").to_string()
                } else {
                    stderr
                });
            }
            Err(error) => spawn_error = error.to_string(),
        }
    }
    Err(format!("找不到可用的 python（{spawn_error}）"))
}

/// 跑一个白名单动作，返回脚本的 JSON 文本。
pub fn run_tool(root: &str, action: &str, argument: &str) -> Result<String, String> {
    let (relative, args) = invocation(action, argument)
        .ok_or_else(|| format!("不支持的知识库动作: {action}"))?;
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err("知识库目录不存在".into());
    }
    let script = root.join(relative);
    if !script.is_file() {
        return Err(format!(
            "这不是 dz 知识库：缺少 {relative}。管理面板需要库内的 99-系统/manage/tools。"
        ));
    }
    run(&script, &args, &root)
}

#[cfg(test)]
mod tests {
    use super::invocation;

    #[test]
    fn whitelist_only_known_actions() {
        assert!(invocation("report", "").is_some());
        assert!(invocation("triage_run", "").is_some());
        assert!(invocation("rm -rf", "").is_none());
        assert!(invocation("search", "  ").is_none());
    }

    #[test]
    fn search_passes_the_query_as_one_argument() {
        let (_, args) = invocation("search", "K8s 调度").unwrap();
        assert_eq!(args[1], "K8s 调度");
        assert!(args.contains(&"--json".to_string()));
    }
}
