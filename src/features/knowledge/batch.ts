/**
 * 批量改属性的「计划」层：只算要改什么，不碰文件。
 *
 * 三条原则：
 * 1. 只有语义确定的组才给批量动作（状态写法、缺类型、没标谁写的）；
 * 2. 计划先给用户过目，再逐篇按指纹写入（外部改过就跳过，不覆盖）；
 * 3. 这里不解释、不猜测内容 —— 只做词表映射和路径推断。
 */

export type BatchKind = "status" | "type" | "owner";

export interface BatchItem { path: string; detail?: string }
export interface PlannedChange { path: string; field: "status" | "type" | "tags"; from: string; to: string; toLabel: string }

/** 组 → 能做的批量动作；没有返回 null，表示这类只能逐篇看。 */
export function batchKind(groupId: string): BatchKind | null {
  if (groupId === "bad_status") return "status";
  if (groupId === "no_type") return "type";
  if (groupId === "no_owner") return "owner";
  return null;
}

const STATUS: Record<string, string> = {
  "进行中": "draft",
  "已完成": "published",
  "已发布": "published",
  "待办": "draft",
  "未开始": "draft",
  "草稿中": "draft",
  "草稿": "draft",
  "done": "published",
  "todo": "draft",
  "wip": "draft",
};

/** 词表外的状态值 → 两个合法值之一。认不出来的一律当草稿（不会把未完成的东西标成定稿）。 */
export function normalizeStatus(value: string): "draft" | "published" {
  const raw = value.trim();
  const hit = STATUS[raw] ?? STATUS[raw.toLowerCase()];
  return hit === "published" ? "published" : "draft";
}

const TYPE_BY_PATH: [RegExp, string][] = [
  [/\/0?6-项目研究\//, "项目研究"],
  [/\/0?7-项目经验\/|\/开发经验\//, "项目经验"],
  [/^0?2-IT\//, "技术知识"],
  [/^0?1-工作\//, "业务知识"],
  [/^0?3-生活\//, "学习笔记"],
  [/^0?4-资源\//, "资源收藏"],
];

/** 按所在区域推一个类型；推不出来用「技术知识」（最保守的通用值）。 */
export function inferType(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  for (const [pattern, type] of TYPE_BY_PATH) if (pattern.test(normalized)) return type;
  return "技术知识";
}

/** 报告里的「FROM 目录不存在: X」→ 建议改成哪个路径（只处理 Inbox 搬家这一种）。 */
export function dataviewTarget(detail?: string): string | null {
  if (!detail) return null;
  const missing = /目录不存在[:：]\s*(.+)$/.exec(detail)?.[1]?.trim();
  if (!missing) return null;
  if (/^00-[^/]+\/Inbox$/i.test(missing)) return "00-Human工作区/Inbox";
  return null;
}

export function planBatch(kind: BatchKind, items: BatchItem[]): PlannedChange[] {
  return items.map((item) => {
    if (kind === "status") {
      const to = normalizeStatus(item.detail ?? "");
      return { path: item.path, field: "status" as const, from: item.detail ?? "?", to, toLabel: to === "published" ? "已发布" : "草稿" };
    }
    if (kind === "type") {
      const to = inferType(item.path);
      return { path: item.path, field: "type" as const, from: "（空）", to, toLabel: to };
    }
    return { path: item.path, field: "tags" as const, from: "（没标）", to: "human", toLabel: "标记为我写的" };
  });
}
