import type { PlanTask } from "@/features/plans/types";
import type { FileCategory, FileItem, FenceState } from "@/stores/files";

/**
 * 首页脉络的「真实关联」推导。
 *
 * 与连线本身（归属）的区别：这里连的是**数据上真的有关系**的两个模块 ——
 * 要么靠同一个 path 文件（计划挂了某条收藏），要么靠同一个 categoryId
 * （条目落在开着栅栏的分类里）。全部是本地规则，不发网络请求、不调用 AI。
 */

/** 卫星下标：必须与 home/page.tsx 传给 HubGraph 的 nodes 顺序一致 */
export const NODE = { PLANS: 0, DOING: 1, ITEMS: 2, FENCES: 3 } as const;

export type RelationKind = "plans-items" | "items-fences";

export interface RelationEdge {
  kind: RelationKind;
  /** 连接的两颗卫星 */
  from: number;
  to: number;
  /** 命中的数量（边上的数字） */
  count: number;
  /** 命中项的名字，最多 3 个，用于悬停提示 */
  samples: string[];
}

export interface HomeRelations {
  edges: RelationEdge[];
  /** 没有连到任何模块上的部分（首页用来提示「还有多少没归置」） */
  orphans: {
    /** 分类已不存在（分类被删、条目成了孤儿） */
    uncategorized: number;
    /** 今日任务里没有挂任何内容的 */
    unlinkedTasks: number;
  };
}

/** 路径归一：Windows 下大小写不敏感、正反斜杠同义、结尾分隔符忽略 */
export function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/\//g, "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
}

export function deriveHomeRelations(input: {
  tasks: PlanTask[];
  items: FileItem[];
  categories: FileCategory[];
  fences: Record<string, FenceState | undefined>;
}): HomeRelations {
  const { tasks, items, categories, fences } = input;

  /*
   * 计划 → 收藏条目：任务挂的内容（link）在条目库里存在同一条。
   * 判等用「type + 归一化 path」而不是标题 —— 标题可以重复、可以改，
   * 路径才是同一个东西的标识（两者本来就共用 folder/file/url 三态）。
   */
  const itemKeys = new Set(items.map((i) => `${i.type}|${normalizePath(i.path)}`));
  const linked = tasks.filter(
    (t) => t.link && itemKeys.has(`${t.link.type}|${normalizePath(t.link.path)}`),
  );

  /* 条目 → 开启栅栏：条目所在分类的栅栏开着（栅栏是每分类一份，按自身分类判，不继承父级） */
  const openCatIds = new Set(
    Object.entries(fences)
      .filter(([, f]) => f?.open)
      .map(([id]) => id),
  );
  const inFences = items.filter((i) => openCatIds.has(i.categoryId));
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const fenceCats = [...new Set(inFences.map((i) => i.categoryId))].map(
    (id) => catName.get(id) ?? "",
  );

  const edges: RelationEdge[] = [];
  if (linked.length > 0) {
    edges.push({
      kind: "plans-items",
      from: NODE.PLANS,
      to: NODE.ITEMS,
      count: linked.length,
      samples: linked.slice(0, 3).map((t) => t.title),
    });
  }
  if (inFences.length > 0) {
    edges.push({
      kind: "items-fences",
      from: NODE.ITEMS,
      to: NODE.FENCES,
      count: inFences.length,
      samples: fenceCats.filter(Boolean).slice(0, 3),
    });
  }

  const catIds = new Set(categories.map((c) => c.id));
  return {
    edges,
    orphans: {
      uncategorized: items.filter((i) => !catIds.has(i.categoryId)).length,
      unlinkedTasks: tasks.filter((t) => !t.link).length,
    },
  };
}
