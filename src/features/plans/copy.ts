import { useTranslation } from "react-i18next";

const zh = {
  attachments: "附件", addAttachment: "添加附件", addingAttachment: "正在复制…",
  localFiles: "复制到本地任务目录，保留原文件", noAttachments: "暂无附件",
  open: "打开", reveal: "在文件夹中显示", unlink: "移除关联",
  unlinkHint: "仅移除关联，本地副本保留，可撤销", attachmentFailed: "附件操作失败",
  taskMissing: "任务已移除，附件未关联", addChild: "添加子任务", save: "保存",
  cancel: "取消", edit: "编辑任务", dailyTodos: "全天待办", pin: "置顶窗口",
  unpin: "取消置顶", desktopDay: "在桌面显示当天全部待办", closeDesktopDay: "关闭当天桌面待办",
  close: "关闭待办窗口", details: "任务详情", time: "时间安排",
  remove: "删除任务及子任务", clearDone: "清理已完成", undo: "撤销", redo: "重做",
  find: "在当前便签中查找", previousMatch: "上一项", nextMatch: "下一项", noMatches: "无匹配任务",
  select: "选择任务", selection: "多选", selectAll: "全选", clearSelection: "取消选择",
  complete: "标记完成", restore: "恢复未完成", copy: "复制任务", copied: "已复制任务",
  copyFailed: "复制失败，请重试", moveUp: "上移同级任务", moveDown: "下移同级任务", drag: "拖动排序（同级）",
  selected: "已选择", fold: "收为贴边胶囊", closeFind: "关闭查找",
  expandTask: "展开正文", collapseTask: "收起正文", link: "快捷关联",
};
const en: typeof zh = {
  attachments: "Attachments", addAttachment: "Add attachment", addingAttachment: "Copying…",
  localFiles: "Copy to this task’s local folder; keep the original", noAttachments: "No attachments",
  open: "Open", reveal: "Show in folder", unlink: "Unlink",
  unlinkHint: "Remove this association; keep the local copy for undo", attachmentFailed: "Attachment action failed",
  taskMissing: "Task was removed; attachment was not linked", addChild: "Add subtask", save: "Save",
  cancel: "Cancel", edit: "Edit task", dailyTodos: "Daily todos", pin: "Keep on top",
  unpin: "Stop keeping on top", desktopDay: "Show all of this day’s todos on desktop", closeDesktopDay: "Close this day’s desktop todos",
  close: "Close todo window", details: "Task details", time: "Schedule",
  remove: "Delete task and subtasks", clearDone: "Clear completed", undo: "Undo", redo: "Redo",
  find: "Find in this paper", previousMatch: "Previous match", nextMatch: "Next match", noMatches: "No matching tasks",
  select: "Select task", selection: "Select", selectAll: "Select all", clearSelection: "Clear selection",
  complete: "Mark complete", restore: "Mark incomplete", copy: "Copy tasks", copied: "Tasks copied",
  copyFailed: "Could not copy; please retry", moveUp: "Move sibling up", moveDown: "Move sibling down", drag: "Drag to reorder siblings",
  selected: "selected", fold: "Fold to edge", closeFind: "Close find",
  expandTask: "Expand text", collapseTask: "Collapse text", link: "Quick link",
};

export function usePlanCopy() {
  const { i18n } = useTranslation();
  return i18n.language.startsWith("zh") ? zh : en;
}
