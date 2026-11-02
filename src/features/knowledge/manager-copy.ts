import { useSettings } from "@/stores/settings";

const zh = {
  tabs: { manage: "工作区", notes: "归档区" },
  common: { loading: "读取中…" },
  centerTitle: "知识库",

  tabsInbox: "收件箱",
  tabsReview: "审核区",
  tabsArchive: "待归档区",
  tabsLoop: "经验区",
  tabsCold: "冷知识区",

  filterLabel: "筛选",
  filterAll: "全部",
  filterAgent: "AI",
  filterHuman: "Human",

  colName: "文档名称",
  colSource: "来源",
  colAction: "操作",
  colConcept: "概念",
  colState: "状态",
  colCases: "案例",
  colOpen: "打开",

  reviewAction: "审核",
  reviewInput: "输入",
  reviewOutput: "输出",
  reviewInputText: "来源：{zone}\n路径：{path}\n\n原文在 Obsidian 里；这里给的是这篇稿子本身，审的就是它。",

  typeLabel: "归档类型",
  suggestPath: "AI 建议归档路径",
  finalPath: "最终归档地址（可改）",
  approve: "通过并送审",
  reject: "退回",
  openInObsidian: "在 Obsidian 打开",
  reviewApproved: "已通过 → {path}，去「待归档」确认归档。",
  reviewRejected: "已退回 → {path}",
  reviewEmpty: "没有待审的稿子。往里放材料就出现在这里。",
  uploadToInbox: "上传文件到收件箱", uploaded: "已放入 {n} 个文件。",
  inboxEmpty: "收件箱是空的。把材料放进收件箱，或让 AI 写稿。",
  coldEmpty: "冷知识区是空的：长期没被引用的案例会移到这里，只移动不删除。",
  loopDefine: "经验 = 同一主题 3 个以上真实案例、且至少被用过一次的结论；不足 3 例只是「假设」。",

  needFix: "{n} 处可以在入库前自动修好（状态写法、隐藏字符）",
  fixAll: "一键修好",
  fixedStatic: "已修好 {status} 篇状态、{files} 个文件的隐藏字符。",
  reminders: { draft_old: "{n} 篇草稿超过 90 天没动", unclosed: "{n} 个文件头损坏" } as Record<string, string>,
  reminderBadge: { draft_old: "草稿超期", unclosed: "文件头损坏" } as Record<string, string>,

  archiveEmpty: "没有待归档的笔记。先审稿，通过后就会出现在这里。",
  runArchive: "确认归档",
  doneArchive: "归档完成。",

  loopEmpty: "还没有成形的经验。",
  loopProgress: "{n} / {total} 例",
  states: { hypothesis: "还在验证", working: "已经在用", established: "已确立", cold: "已冷存" } as Record<string, string>,
  openConcept: "打开概念笔记",

  unitIssue: "处",
  unitNote: "篇",
};

const en: typeof zh = {
  tabs: { manage: "Workspace", notes: "Archive" },
  common: { loading: "Loading…" },
  centerTitle: "Knowledge",

  tabsInbox: "Inbox",
  tabsReview: "Review",
  tabsArchive: "To file",
  tabsLoop: "Lessons",
  tabsCold: "Cold",

  filterLabel: "Filter",
  filterAll: "All",
  filterAgent: "AI",
  filterHuman: "Human",

  colName: "Document",
  colSource: "Source",
  colAction: "Action",
  colConcept: "Concept",
  colState: "State",
  colCases: "Cases",
  colOpen: "Open",

  reviewAction: "Review",
  reviewInput: "Input",
  reviewOutput: "Output",
  reviewInputText: "Source: {zone}\nPath: {path}\n\nThe original stays in Obsidian; this is the draft you are reviewing.",

  typeLabel: "Archive type",
  suggestPath: "AI suggested destination",
  finalPath: "Final destination (editable)",
  approve: "Approve and send",
  reject: "Send back",
  openInObsidian: "Open in Obsidian",
  reviewApproved: "Approved → {path}; confirm it under To file.",
  reviewRejected: "Sent back → {path}",
  reviewEmpty: "Nothing to review. Drop material in and it shows up here.",
  uploadToInbox: "Upload files to the inbox", uploaded: "Saved {n} files.",
  inboxEmpty: "The inbox is empty. Drop material in, or let the AI draft.",
  coldEmpty: "Cold is empty: cases nobody referenced for a long time move here; nothing is deleted.",
  loopDefine: "A lesson = 3+ real cases on one topic, used at least once. Fewer than 3 is still a hypothesis.",

  needFix: "{n} can be fixed automatically before review (status wording, hidden characters)",
  fixAll: "Fix all",
  fixedStatic: "Fixed {status} statuses and {files} files with hidden characters.",
  reminders: { draft_old: "{n} drafts untouched for 90+ days", unclosed: "{n} broken headers" },
  reminderBadge: { draft_old: "Stale drafts", unclosed: "Broken headers" },

  archiveEmpty: "Nothing to file. Approve a draft first and it lands here.",
  runArchive: "Confirm",
  doneArchive: "Filing done.",

  loopEmpty: "No lesson has formed yet.",
  loopProgress: "{n} / {total} cases",
  states: { hypothesis: "testing", working: "in use", established: "established", cold: "cold" },
  openConcept: "Open concept note",

  unitIssue: "issues",
  unitNote: "notes",
};

export function useManagerCopy(): typeof zh {
  return useSettings((s) => s.lang) === "zh" ? zh : en;
}
