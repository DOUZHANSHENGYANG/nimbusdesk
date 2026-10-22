//! 定时任务的频率模型与「下次运行时刻」计算。
//!
//! 这一层是**纯函数 + 本地时间**：不碰文件、不碰 Tauri、不碰线程，
//! 所以六种频率的边界（跨月、跨年、2 月没有 31 号、闰年、刚好等于当前时刻）
//! 都能直接单测。
//!
//! 时间基准刻意选「每次心跳从 `now` 重新算」而不是「上次结果 + 周期」：
//! 用户改系统时间 / 换时区之后，算术递推会一路算错下去，
//! 而从 `now` 重算的话下一次心跳就自动回到正确的钟点上。

use chrono::{DateTime, Datelike, Duration, Local, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};

/// 落后于调度时刻多久算「应用没在运行」，而不是「心跳晚了几秒」。
/// 心跳 30 秒一次，留 3 拍余量。
pub const MISSED_GRACE_SECS: i64 = 90;

/// 运行历史保留条数。
pub const HISTORY_LIMIT: usize = 50;

/// 频率。字段名走 camelCase，直接就是前端 JSON 的形状。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Frequency {
    /// 一次性：`at` = "YYYY-MM-DDTHH:MM"，跑完自动停用
    Once { at: String },
    /// 每天 `time` = "HH:MM"
    Daily { time: String },
    /// 每周：`weekdays` 1=周一 … 7=周日（多选）
    Weekly { weekdays: Vec<u32>, time: String },
    /// 每月：`day` 1–31；该月没有这一天时按**该月最后一天**跑
    Monthly { day: u32, time: String },
    /// 每年：`month` 1–12 + `day`（同样按月末回退）
    Yearly { month: u32, day: u32, time: String },
    /// 间隔：每 `minutes` 分钟（最小 1）
    Interval { minutes: u32 },
}

/// 一个任务。`next_run` / `last_run` 由引擎维护，前端只读。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub name: String,
    pub frequency: Frequency,
    pub action: ActionSpec,
    pub enabled: bool,
    /// 错过后补跑一次；默认关（错过就是错过，不要一次补一堆）
    #[serde(default)]
    pub run_if_missed: bool,
    /// "YYYY-MM-DDTHH:MM:SS"（本地时间）。None = 还没排过 / 一次性已跑完
    #[serde(default)]
    pub next_run: Option<String>,
    #[serde(default)]
    pub last_run: Option<String>,
    #[serde(default)]
    pub last_status: Option<String>,
}

/// 动作调用：注册表 id + 该动作自己的参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionSpec {
    pub id: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// 一次运行的结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub task_id: String,
    pub task_name: String,
    /// 本地时间 "YYYY-MM-DDTHH:MM:SS"
    pub at: String,
    /// success / failed / skipped
    pub status: String,
    /// 耗时毫秒
    pub ms: u64,
    /// 错误码或摘要
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 产出（例如知识库笔记路径 / 备份文件路径）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// skipped 的原因：app-not-running
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub fn fmt_dt(dt: DateTime<Local>) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S").to_string()
}

pub fn parse_dt(s: &str) -> Option<DateTime<Local>> {
    let naive = parse_local(s)?;
    local_at(naive.date(), naive.time())
}

/// "HH:MM"
pub fn parse_time(s: &str) -> Option<NaiveTime> {
    let (h, m) = s.trim().split_once(':')?;
    NaiveTime::from_hms_opt(h.trim().parse().ok()?, m.trim().parse().ok()?, 0)
}

/// "YYYY-MM-DDTHH:MM[:SS]"（也接受空格分隔）。手写解析：格式固定，报错行为可预期。
pub fn parse_local(s: &str) -> Option<NaiveDateTime> {
    let (date, time) = s.trim().split_once(['T', ' '])?;
    let mut d = date.split('-');
    let year: i32 = d.next()?.parse().ok()?;
    let month: u32 = d.next()?.parse().ok()?;
    let day: u32 = d.next()?.parse().ok()?;
    if d.next().is_some() {
        return None;
    }
    let mut t = time.split(':');
    let hour: u32 = t.next()?.parse().ok()?;
    let minute: u32 = t.next()?.parse().ok()?;
    let second: u32 = match t.next() {
        Some(value) => value.parse().ok()?,
        None => 0,
    };
    if t.next().is_some() {
        return None;
    }
    NaiveDate::from_ymd_opt(year, month, day)?.and_hms_opt(hour, minute, second)
}

/// 本地时间 → DateTime；夏令时缺口（时钟被跳过的那一小时）返回 None，
/// 歧义（时钟回拨重复的那一小时）取较早的一次。
fn local_at(date: NaiveDate, time: NaiveTime) -> Option<DateTime<Local>> {
    match Local.from_local_datetime(&date.and_time(time)) {
        LocalResult::Single(dt) => Some(dt),
        LocalResult::Ambiguous(first, _) => Some(first),
        LocalResult::None => None,
    }
}

pub fn days_in_month(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = if month >= 12 { (year + 1, 1) } else { (year, month + 1) };
    let first = NaiveDate::from_ymd_opt(year, month, 1).expect("month is 1..=12");
    let next = NaiveDate::from_ymd_opt(next_year, next_month, 1).expect("month is 1..=12");
    (next - first).num_days() as u32
}

/// 严格晚于 `now` 的下一次运行时刻。
///
/// - 日历型（一次性/每天/每周/每月/每年）只看 `now`：因此系统时间或时区变化后，
///   下一次心跳就算出正确时刻。
/// - 间隔型以 `anchor` 为基准（调用方传上次触发时刻；从未跑过就传 `now`）。
///   这样「每 5 分钟」不会被心跳本身推着往前走，永远不会触发。
///
/// 返回 `None` 表示这类配置没有下一次（一次性已过、星期集合为空、时间串非法）。
pub fn next_run_after(now: DateTime<Local>, spec: &Frequency, anchor: DateTime<Local>) -> Option<DateTime<Local>> {
    match spec {
        Frequency::Once { at } => {
            let target = parse_dt(at)?;
            (target > now).then_some(target)
        }
        Frequency::Interval { minutes } => {
            // 上限一天：再大的间隔用「每天」表达，避免一次错误的输入把任务推到几年后
            let minutes = (*minutes).clamp(1, 24 * 60);
            Some(anchor + Duration::minutes(i64::from(minutes)))
        }
        Frequency::Daily { time } => {
            let time = parse_time(time)?;
            let base = now.date_naive();
            // 3 天窗口足够跨过任何一次夏令时缺口
            (0..3).find_map(|offset| before_now(base + Duration::days(offset), time, now))
        }
        Frequency::Weekly { weekdays, time } => {
            let time = parse_time(time)?;
            let base = now.date_naive();
            // 今天 + 之后 7 天 = 覆盖任意星期组合
            (0..8)
                .map(|offset| base + Duration::days(offset))
                .filter(|date| weekdays.contains(&date.weekday().number_from_monday()))
                .find_map(|date| before_now(date, time, now))
        }
        Frequency::Monthly { day, time } => {
            let time = parse_time(time)?;
            let day = (*day).clamp(1, 31);
            let mut year = now.year();
            let mut month = now.month();
            // 3 个月窗口：本月已过就试下月，下月同样可能已过（不可能，但别写死假设）
            (0..3).find_map(|_| {
                let date = NaiveDate::from_ymd_opt(year, month, day.min(days_in_month(year, month)))?;
                let hit = before_now(date, time, now);
                if month >= 12 {
                    year += 1;
                    month = 1;
                } else {
                    month += 1;
                }
                hit
            })
        }
        Frequency::Yearly { month, day, time } => {
            let time = parse_time(time)?;
            if !(1..=12).contains(month) {
                return None;
            }
            let day = (*day).clamp(1, 31);
            let mut year = now.year();
            (0..3).find_map(|_| {
                let date = NaiveDate::from_ymd_opt(year, *month, day.min(days_in_month(year, *month)))?;
                let hit = before_now(date, time, now);
                year += 1;
                hit
            })
        }
    }
}

/// 某天的 `time` 若严格晚于 `now` 则给出该时刻，否则 None（夏令时缺口也是 None）。
fn before_now(date: NaiveDate, time: NaiveTime, now: DateTime<Local>) -> Option<DateTime<Local>> {
    let dt = local_at(date, time)?;
    (dt > now).then_some(dt)
}

/// UI 预览用：连续若干次运行时刻。`count` 上限 10。
pub fn preview(now: DateTime<Local>, spec: &Frequency, count: usize) -> Vec<String> {
    let count = count.clamp(1, 10);
    let mut out = Vec::new();
    let mut cursor = now;
    for _ in 0..count {
        let Some(next) = next_run_after(cursor, spec, cursor) else {
            break;
        };
        out.push(fmt_dt(next));
        cursor = next;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Local> {
        parse_dt(text).expect("测试时间应能解析")
    }

    fn next(now: &str, spec: &Frequency) -> Option<String> {
        let now = at(now);
        next_run_after(now, spec, now).map(fmt_dt)
    }

    fn daily(time: &str) -> Frequency {
        Frequency::Daily { time: time.into() }
    }

    #[test]
    fn daily_rolls_over_to_tomorrow_when_today_passed() {
        assert_eq!(next("2026-10-22T08:00:00", &daily("09:30")).unwrap(), "2026-10-22T09:30:00");
        assert_eq!(next("2026-10-22T10:00:00", &daily("09:30")).unwrap(), "2026-10-23T09:30:00");
    }

    /// 刚好等于当前时刻不算「下次」—— 否则心跳会原地死循环重跑。
    #[test]
    fn a_time_equal_to_now_is_not_the_next_run() {
        assert_eq!(next("2026-10-22T09:30:00", &daily("09:30")).unwrap(), "2026-10-23T09:30:00");
        let once = Frequency::Once { at: "2026-10-22T09:30".into() };
        assert_eq!(next("2026-10-22T09:30:00", &once), None, "一次性到点即耗尽");
        assert_eq!(next("2026-10-22T09:29:59", &once).unwrap(), "2026-10-22T09:30:00");
    }

    #[test]
    fn daily_crosses_month_and_year_boundaries() {
        assert_eq!(next("2026-10-31T23:00:00", &daily("00:30")).unwrap(), "2026-11-01T00:30:00");
        assert_eq!(next("2026-12-31T23:59:00", &daily("00:01")).unwrap(), "2027-01-01T00:01:00");
    }

    #[test]
    fn weekly_picks_the_earliest_selected_weekday() {
        // 2026-10-22 是周四（4）
        let spec = Frequency::Weekly { weekdays: vec![1, 5], time: "07:00".into() };
        assert_eq!(next("2026-10-22T08:00:00", &spec).unwrap(), "2026-10-23T07:00:00", "周五最近");
        assert_eq!(next("2026-10-23T08:00:00", &spec).unwrap(), "2026-10-26T07:00:00", "跳过周末到周一");
        // 今天就是选中的星期，但时刻已过 → 下一个选中的天
        let spec = Frequency::Weekly { weekdays: vec![4, 5], time: "07:00".into() };
        assert_eq!(next("2026-10-22T08:00:00", &spec).unwrap(), "2026-10-23T07:00:00");
        assert_eq!(next("2026-10-22T06:00:00", &spec).unwrap(), "2026-10-22T07:00:00");
    }

    #[test]
    fn weekly_covers_every_weekday_and_spans_a_year_end() {
        let spec = Frequency::Weekly { weekdays: (1..=7).collect(), time: "12:00".into() };
        let mut cursor = at("2026-12-28T13:00:00");
        for _ in 0..10 {
            let step = next_run_after(cursor, &spec, cursor).unwrap();
            assert!(step > cursor);
            assert!(step - cursor <= Duration::days(1), "每天都选中时不该跳超过一天");
            cursor = step;
        }
        assert_eq!(cursor.format("%Y-%m-%d").to_string(), "2027-01-07");
        // 空集合没有下一次
        let empty = Frequency::Weekly { weekdays: vec![], time: "12:00".into() };
        assert_eq!(next("2026-10-22T08:00:00", &empty), None);
        // 越界的星期值不算数
        let junk = Frequency::Weekly { weekdays: vec![0, 8], time: "12:00".into() };
        assert_eq!(next("2026-10-22T08:00:00", &junk), None);
    }

    #[test]
    fn monthly_falls_back_to_the_last_day_of_a_short_month() {
        let spec = Frequency::Monthly { day: 31, time: "06:00".into() };
        // 2 月没有 31 号 → 2 月 28 日（2027 非闰年）
        assert_eq!(next("2027-02-01T00:00:00", &spec).unwrap(), "2027-02-28T06:00:00");
        // 闰年落到 29 日
        assert_eq!(next("2028-02-01T00:00:00", &spec).unwrap(), "2028-02-29T06:00:00");
        // 4 月 → 30 日
        assert_eq!(next("2027-04-02T00:00:00", &spec).unwrap(), "2027-04-30T06:00:00");
        // 本月那次已经过了 → 下月同日
        assert_eq!(next("2027-03-31T07:00:00", &spec).unwrap(), "2027-04-30T06:00:00");
        // 本月还没到
        assert_eq!(next("2027-03-10T07:00:00", &spec).unwrap(), "2027-03-31T06:00:00");
    }

    #[test]
    fn monthly_crosses_year_end_and_survives_junk_days() {
        let spec = Frequency::Monthly { day: 15, time: "00:00".into() };
        assert_eq!(next("2026-12-15T00:00:01", &spec).unwrap(), "2027-01-15T00:00:00");
        // 越界的「几号」按 1 / 31 收敛，而不是永不触发
        assert_eq!(next("2026-10-01T00:00:00", &Frequency::Monthly { day: 0, time: "05:00".into() }).unwrap(), "2026-10-01T05:00:00");
        assert_eq!(next("2026-10-01T00:00:00", &Frequency::Monthly { day: 99, time: "05:00".into() }).unwrap(), "2026-10-31T05:00:00");
    }

    #[test]
    fn yearly_handles_leap_day_and_year_rollover() {
        let spec = Frequency::Yearly { month: 2, day: 29, time: "08:00".into() };
        assert_eq!(next("2026-03-01T00:00:00", &spec).unwrap(), "2027-02-28T08:00:00");
        assert_eq!(next("2027-03-01T00:00:00", &spec).unwrap(), "2028-02-29T08:00:00");
        let spec = Frequency::Yearly { month: 10, day: 22, time: "09:00".into() };
        assert_eq!(next("2026-10-22T10:00:00", &spec).unwrap(), "2027-10-22T09:00:00");
        assert_eq!(next("2026-10-22T08:00:00", &spec).unwrap(), "2026-10-22T09:00:00");
        assert_eq!(next("2026-01-01T00:00:00", &Frequency::Yearly { month: 13, day: 1, time: "00:00".into() }), None);
    }

    /// 间隔型以 anchor 为基准：心跳重复计算同一 anchor 必须得到同一答案。
    #[test]
    fn interval_is_anchored_not_recomputed_from_now() {
        let spec = Frequency::Interval { minutes: 5 };
        let anchor = at("2026-10-22T09:00:00");
        let first = next_run_after(anchor, &spec, anchor).unwrap();
        assert_eq!(fmt_dt(first), "2026-10-22T09:05:00");
        let later_now = at("2026-10-22T09:02:00");
        assert_eq!(next_run_after(later_now, &spec, anchor).unwrap(), first, "心跳推着 now 走也不能改下次时刻");
        // 归还之后以新 anchor 重新起算
        assert_eq!(fmt_dt(next_run_after(first, &spec, first).unwrap()), "2026-10-22T09:10:00");
    }

    #[test]
    fn interval_clamps_degenerate_values() {
        let now = at("2026-10-22T09:00:00");
        for minutes in [0, 1] {
            assert_eq!(fmt_dt(next_run_after(now, &Frequency::Interval { minutes }, now).unwrap()), "2026-10-22T09:01:00");
        }
        assert_eq!(fmt_dt(next_run_after(now, &Frequency::Interval { minutes: 999_999 }, now).unwrap()), "2026-10-23T09:00:00");
    }

    #[test]
    fn once_returns_nothing_after_the_moment_passed() {
        let spec = Frequency::Once { at: "2026-10-22T09:30".into() };
        assert_eq!(next("2026-10-22T09:00:00", &spec).unwrap(), "2026-10-22T09:30:00");
        assert_eq!(next("2026-10-22T09:31:00", &spec), None);
        assert_eq!(next("2026-10-24T00:00:00", &spec), None);
        for junk in ["", "2026-13-01T00:00", "2026-10-32T00:00", "nonsense", "2026-10-22T25:00"] {
            assert_eq!(next("2026-10-20T00:00:00", &Frequency::Once { at: junk.into() }), None, "{junk}");
        }
    }

    #[test]
    fn malformed_time_strings_never_panic_and_have_no_next_run() {
        for time in ["", "9", "25:00", "12:60", "-1:00", "aa:bb"] {
            assert_eq!(next("2026-10-22T00:00:00", &daily(time)), None, "{time}");
        }
        // 手写解析：一位数小时也接受，前后空白也接受
        assert_eq!(next("2026-10-22T00:00:00", &daily(" 9:05 ")).unwrap(), "2026-10-22T09:05:00");
        assert!(parse_dt("2026-10-22 09:05").is_some());
        assert!(parse_dt("2026-10-22T09:05:07").is_some());
        assert!(parse_dt("2026-10-22T09:05:07:08").is_none());
    }

    #[test]
    fn preview_lists_consecutive_runs_and_terminates_on_once() {
        let now = at("2026-10-22T09:00:00");
        assert_eq!(
            preview(now, &daily("09:30"), 3),
            vec!["2026-10-22T09:30:00", "2026-10-23T09:30:00", "2026-10-24T09:30:00"]
        );
        assert_eq!(
            preview(now, &Frequency::Once { at: "2026-10-22T09:30".into() }, 5),
            vec!["2026-10-22T09:30:00"]
        );
        assert!(preview(now, &daily("nonsense"), 5).is_empty());
        assert_eq!(preview(now, &Frequency::Interval { minutes: 90 }, 2).len(), 2);
    }

    #[test]
    fn days_in_month_matches_the_calendar() {
        assert_eq!(days_in_month(2026, 1), 31);
        assert_eq!(days_in_month(2026, 2), 28);
        assert_eq!(days_in_month(2028, 2), 29);
        assert_eq!(days_in_month(2026, 4), 30);
        assert_eq!(days_in_month(2026, 12), 31);
    }

    /// 频率的 JSON 形状就是前端用的形状，tag/字段名不许悄悄漂移。
    #[test]
    fn frequency_json_shape_is_stable() {
        let spec = Frequency::Weekly { weekdays: vec![1, 5], time: "07:00".into() };
        let value = serde_json::to_value(&spec).unwrap();
        assert_eq!(value, serde_json::json!({ "kind": "weekly", "weekdays": [1, 5], "time": "07:00" }));
        let back: Frequency = serde_json::from_value(value).unwrap();
        assert_eq!(back, spec);
        assert_eq!(
            serde_json::to_value(Frequency::Interval { minutes: 5 }).unwrap(),
            serde_json::json!({ "kind": "interval", "minutes": 5 })
        );
        assert_eq!(
            serde_json::to_value(Frequency::Once { at: "2026-10-22T09:30".into() }).unwrap(),
            serde_json::json!({ "kind": "once", "at": "2026-10-22T09:30" })
        );
    }

    /// 每条历史都要能原样往返，前端靠 status/reason 区三态。
    #[test]
    fn history_entry_round_trips_optional_fields() {
        let entry = HistoryEntry {
            id: "h1".into(),
            task_id: "t1".into(),
            task_name: "备份".into(),
            at: "2026-10-22T09:30:00".into(),
            status: "skipped".into(),
            ms: 0,
            error: None,
            note: None,
            reason: Some("app-not-running".into()),
        };
        let text = serde_json::to_string(&entry).unwrap();
        assert!(!text.contains("error"), "空字段不该写进 JSON：{text}");
        assert_eq!(serde_json::from_str::<HistoryEntry>(&text).unwrap().reason.unwrap(), "app-not-running");
    }
}
