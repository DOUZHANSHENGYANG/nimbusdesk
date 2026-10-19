import { useSettings } from "@/stores/settings";

const zh = {
  settings: "允许回写的字段", settingsHint: "默认只读。勾选后，本地修改进入待发送列表，仍需逐次核对确认。状态、工时和评论不在此发送。",
  title: "标题", note: "备注", deadline: "截止日期", allowTitle: "允许回写标题", allowNote: "允许回写备注", allowDeadline: "允许回写截止日期",
  review: "核对禅道修改", pending: "待发送修改", conflict: "需要处理冲突", uncertain: "结果待核实", failed: "发送失败", sending: "正在发送", compare: "核对来源",
  hint: "逐字段比较修改。应用字段选择只更新本地草稿；确认发送后才会写入禅道。", base: "同步基线", local: "当前本地", remote: "最新云端",
  chooseLocal: "保留本地", chooseRemote: "采用云端", chooseEdit: "手动修改", apply: "应用字段选择", refresh: "更新云端值", checked: "我已核对本次字段修改", send: "确认发送到禅道", close: "关闭",
  noCas: "禅道接口未提供已验证的原子版本校验。发送前会重读并校验本次字段，发送后再核实结果；仍可能遇到同时编辑，请核对后发送。",
  empty: "没有待发送修改", noValue: "未设置", unknownHint: "上次发送结果尚未确定。先更新云端值核实结果，再决定下一步，避免重复发送。",
  changed: "数据已更新，之前的字段选择已重置。请核对最新值。", applied: "字段选择已应用", sent: "修改已发送并核实", error: "操作未完成，请检查连接与当前数据。", pendingHint: "仅发送此处列出的字段。", conflictHint: "同一字段在本地和云端都有变化，请逐项选择。", readOnly: "此连接为只读或已关闭相应字段，请先在禅道连接设置中启用。",
};
type Copy = Record<keyof typeof zh, string>;
const en: Copy = {
  settings: "Writable fields", settingsHint: "Read-only by default. Enabled local edits become pending proposals and require review before each send. Status, hours and comments are excluded.",
  title: "Title", note: "Notes", deadline: "Deadline", allowTitle: "Allow title writeback", allowNote: "Allow notes writeback", allowDeadline: "Allow deadline writeback",
  review: "Review ZenTao changes", pending: "Pending changes", conflict: "Resolve conflicts", uncertain: "Result needs verification", failed: "Send failed", sending: "Sending", compare: "Compare source",
  hint: "Compare individual fields. Applying choices only changes the local draft; ZenTao changes only after confirming send.", base: "Sync baseline", local: "Current local", remote: "Latest remote",
  chooseLocal: "Keep local", chooseRemote: "Use remote", chooseEdit: "Edit value", apply: "Apply field choices", refresh: "Refresh remote values", checked: "I reviewed these field changes", send: "Confirm send to ZenTao", close: "Close",
  noCas: "The ZenTao API has no verified atomic version check. We reread and check these fields before sending, then verify the result. Concurrent edits may still occur; review before sending.",
  empty: "No pending changes", noValue: "Not set", unknownHint: "The previous send result is unknown. Refresh remote values to verify before deciding what to do next, avoiding duplicate sends.",
  changed: "Data changed. Previous field choices were reset; review the latest values.", applied: "Field choices applied", sent: "Changes sent and verified", error: "The action did not complete. Check the connection and current data.", pendingHint: "Only the fields listed here will be sent.", conflictHint: "The same field changed locally and remotely. Choose each value explicitly.", readOnly: "This connection is read-only or these fields are disabled. Enable them in the ZenTao connection settings first.",
};
export function useZenWriteCopy(): Copy { return useSettings(s => s.lang) === "zh" ? zh : en; }
