/**
 * `files` 的增量计算与回放（纯逻辑）。
 *
 * 存储层改成「一条条目一行」之后，前端每次 `set()` 都要回答一个问题：**相对上一次落库，什么变了**。
 * 这里就是那个回答，形状必须与 Rust 侧的 `files_table::apply` 一一对应：
 *
 * ```json
 * {
 *   "categories": { "upsert": [{ "value": {...}, "order": 0 }], "remove": ["id"] },
 *   "items":      { "upsert": [{ "value": {...}, "order": 3 }],
 *                   "reorder": [{ "id": "x", "order": 5 }],
 *                   "remove": ["id"] }
 * }
 * ```
 *
 * 关键约定：`order` 就是「这块实体在数组里的最终下标」。拖动排序会让一整段下标都变，所以
 * 那一段里的每个条目都会带一条 `reorder`（只改位置、重写 payload 的代价就省了）。
 *
 * 比对靠**引用相等**：store 的每个 mutation 都只替换真正改过的对象（`{...item, patch}`），
 * 没动过的条目还是同一个引用 —— 于是「8000 条里只看一条」是 O(n) 次指针比较，不做序列化。
 */

export interface SnapshotEntity {
  id: string;
}

export interface DeltaEntity {
  value: SnapshotEntity;
  order: number;
}

export interface ReorderEntity {
  id: string;
  order: number;
}

export interface FilesDelta {
  categories: { upsert: DeltaEntity[]; remove: string[] };
  items: { upsert: DeltaEntity[]; reorder: ReorderEntity[]; remove: string[] };
}

export interface FilesSnapshot {
  categories: readonly SnapshotEntity[];
  items: readonly SnapshotEntity[];
}

export function emptyDelta(): FilesDelta {
  return {
    categories: { upsert: [], remove: [] },
    items: { upsert: [], reorder: [], remove: [] },
  };
}

export function isEmptyDelta(delta: FilesDelta): boolean {
  return (
    delta.categories.upsert.length === 0 &&
    delta.categories.remove.length === 0 &&
    delta.items.upsert.length === 0 &&
    delta.items.reorder.length === 0 &&
    delta.items.remove.length === 0
  );
}

/** 相对 `prev`（上一次落库的快照，null = 库里是空的）算出增量。 */
export function diffFiles(prev: FilesSnapshot | null, next: FilesSnapshot): FilesDelta {
  const delta = emptyDelta();

  const prevCategories = new Map((prev?.categories ?? []).map((entity, index) => [entity.id, { entity, index }]));
  const nextCategoryIds = new Set<string>();
  next.categories.forEach((category, index) => {
    nextCategoryIds.add(category.id);
    const before = prevCategories.get(category.id);
    // 分类数量是几十量级：即使只是顺序变了也整条重发，省一套 reorder 协议
    if (!before || before.entity !== category || before.index !== index) {
      delta.categories.upsert.push({ value: category, order: index });
    }
  });
  for (const id of prevCategories.keys()) if (!nextCategoryIds.has(id)) delta.categories.remove.push(id);

  const prevItems = new Map((prev?.items ?? []).map((entity, index) => [entity.id, { entity, index }]));
  const nextItemIds = new Set<string>();
  next.items.forEach((item, index) => {
    nextItemIds.add(item.id);
    const before = prevItems.get(item.id);
    if (!before || before.entity !== item) {
      // 新条目或内容变了：payload 要重写，顺带把最终下标给它
      delta.items.upsert.push({ value: item, order: index });
    } else if (before.index !== index) {
      delta.items.reorder.push({ id: item.id, order: index });
    }
  });
  for (const id of prevItems.keys()) if (!nextItemIds.has(id)) delta.items.remove.push(id);

  return delta;
}

/**
 * 把别的窗口推来的增量应用到本地状态（跨窗口回灌用）。
 *
 * 按 `order` 重新排：拖动时发送方会为「下标变了的那一段」全部带上新下标，所以据此稳定排序
 * 就能还原出与发送方一致的数组。并发移动同一批条目时以最后一次到达的为准 —— 这与既有
 * `storage://changed` 的跨窗口语义一致（后到者赢），不为它引入额外冲突解决。
 */
export function applyFilesDelta<T extends { categories: SnapshotEntity[]; items: SnapshotEntity[] }>(
  state: T,
  delta: FilesDelta,
): T {
  const categories = mergeEntities(state.categories, delta.categories.upsert, delta.categories.remove);
  const items = mergeEntities(state.items, delta.items.upsert, delta.items.remove, delta.items.reorder);
  return { ...state, categories, items } as T;
}

function mergeEntities<E extends { id: string }>(
  current: readonly E[],
  upsert: DeltaEntity[],
  remove: string[],
  reorder: ReorderEntity[] = [],
): E[] {
  const byId = new Map<string, { entity: E; order: number }>();
  current.forEach((entity, index) => byId.set(entity.id, { entity, order: index }));

  for (const entry of upsert) byId.set(entry.value.id, { entity: entry.value as unknown as E, order: entry.order });
  for (const entry of reorder) {
    const existing = byId.get(entry.id);
    if (existing) existing.order = entry.order;
  }
  for (const id of remove) byId.delete(id);

  return [...byId.values()].sort((a, b) => a.order - b.order).map((entry) => entry.entity);
}
