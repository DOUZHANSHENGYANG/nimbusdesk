//! 定时任务：频率模型（`model`）、动作注册表（`actions`）、心跳引擎（`engine`）。
//!
//! 落盘位置遵循云台的模块存储约定：
//! - `modules/schedule/tasks.json`  任务表
//! - `modules/schedule/history.json` 运行历史（最近 50 条）

pub mod actions;
pub mod engine;
pub mod model;
