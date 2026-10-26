/** 标签分组：标签本身仍是技能/服务器上的字符串，这里只维护「哪个标签属于哪一组」。 */

export interface TagGroup {
  id: string;
  name: string;
  tags: string[];
}

export interface GroupedTags {
  groups: TagGroup[];
  /** 没有归组的标签：单独一张卡，永远最后显示 */
  ungrouped: string[];
}

/**
 * 按分组切一遍标签列表。
 *
 * 规则：
 * - 分组里已经消失的标签自动忽略（删技能不该留下幽灵标签）；
 * - 同一个标签只归属第一个组（先到先得），避免两处都亮；
 * - 未归组的一律进 `ungrouped`，由界面渲染成「未分组」。
 */
export function groupTags(allTags: readonly string[], groups: readonly TagGroup[]): GroupedTags {
  const known = new Set(allTags);
  const taken = new Set<string>();
  const out: TagGroup[] = [];
  for (const group of groups) {
    const tags = group.tags.filter((tag) => known.has(tag) && !taken.has(tag));
    tags.forEach((tag) => taken.add(tag));
    out.push({ ...group, tags });
  }
  return { groups: out, ungrouped: allTags.filter((tag) => !taken.has(tag)) };
}

/** 把一个标签挪到某个组；`groupId` 为 null 表示退出所有组。 */
export function assignTag(groups: readonly TagGroup[], tag: string, groupId: string | null): TagGroup[] {
  return groups.map((group) => {
    const tags = group.tags.filter((t) => t !== tag);
    if (group.id === groupId && !tags.includes(tag)) tags.push(tag);
    return { ...group, tags };
  });
}

/** 新建分组：id 由调用方给（界面里用 crypto.randomUUID）。 */
export function addGroup(groups: readonly TagGroup[], id: string, name: string): TagGroup[] {
  return [...groups, { id, name, tags: [] }];
}

/**
 * 上移 / 下移一个分组。顺序就是左栏与分区的显示顺序；越界与未知 id 原样返回。
 * 用两个按钮而不是拖拽：分组数量个位数，拖拽省下的那点操作抵不上它带来的可达性问题。
 */
export function moveGroup(groups: readonly TagGroup[], id: string, delta: -1 | 1): TagGroup[] {
  const index = groups.findIndex((group) => group.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= groups.length) return [...groups];
  const next = [...groups];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

/** 删除分组：组里的标签自动回到「未分组」，不会跟着消失。 */
export function removeGroup(groups: readonly TagGroup[], id: string): TagGroup[] {
  return groups.filter((group) => group.id !== id);
}

/** 改名；空名字不生效。 */
export function renameGroup(groups: readonly TagGroup[], id: string, name: string): TagGroup[] {
  const trimmed = name.trim();
  if (!trimmed) return [...groups];
  return groups.map((group) => (group.id === id ? { ...group, name: trimmed } : group));
}

/** 只保留确实存在的标签，供 store 在数据变化后自愈。 */
export function pruneGroups(groups: readonly TagGroup[], allTags: readonly string[]): TagGroup[] {
  const known = new Set(allTags);
  return groups.map((group) => ({ ...group, tags: group.tags.filter((tag) => known.has(tag)) }));
}
