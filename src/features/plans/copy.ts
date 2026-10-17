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
};

export function usePlanCopy() {
  const { i18n } = useTranslation();
  return i18n.language.startsWith("zh") ? zh : en;
}
