//! 后台采集心跳：60 秒检查一次，到期的（启用 + 距上次 ≥ interval）就跑。
//!
//! 跑动不持锁 —— `run_source` 自己进数据目录锁只做几毫秒的落盘，
//! 抓取过程（可能几十秒）完全在锁外。

use super::{run_source, store};
use serde_json::json;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const TICK_SECS: u64 = 60;

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            run_due(&app);
            std::thread::sleep(Duration::from_secs(TICK_SECS));
        }
    });
}

fn run_due(app: &AppHandle) -> usize {
    let Ok(state) = store::load() else { return 0 };
    let now = chrono::Local::now();
    let mut ran = 0;
    for source in state.sources.iter().filter(|source| source.enabled) {
        let due = match source
            .last_run_at
            .as_deref()
            .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
        {
            Some(last) => {
                now.signed_duration_since(last.with_timezone(&chrono::Local)).num_minutes()
                    >= source.interval_minutes.max(5)
            }
            None => true,
        };
        if !due {
            continue;
        }
        if run_source(&source.id).is_ok() {
            ran += 1;
        }
        let _ = app.emit("feeds://updated", json!({ "sourceId": source.id }));
    }
    ran
}
