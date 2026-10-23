/**
 * 长列表的分片显示（纯逻辑，方便单测）。
 *
 * 为什么不直接上虚拟滚动：文件页是 `auto-fill` 的自适应网格、搜索窗是带键盘导航的
 * listbox —— 两者都要按「行高 × 列数」或「变高行」来算位置，一改样式就容易错位。
 * 这里换一个更保守的做法：**只渲染前 N 条**，滚到底部再放 N 条。
 * DOM 数量有上界（页面不再因为几千条卡死），布局完全交给浏览器，不会出现错位。
 *
 * 代价是「全量在 DOM 里」的能力没有了（比如 Ctrl+F 只能搜到已渲染的部分），
 * 对这个应用够用：文件页/搜索结果本来就是靠过滤与搜索定位的。
 */

/** 一次放出多少条。太小会频繁触发，太大就失去了分片的意义。 */
export const DEFAULT_STEP = 120;

/** 显示条数不能越过总数，也不能为负（数据被删/过滤后总数会变）。 */
export function clampCount(count: number, total: number): number {
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.min(Math.floor(count), Math.max(0, total)));
}

/** 再放一批。已经到底就停在总数上，不会溢出。 */
export function nextCount(count: number, total: number, step = DEFAULT_STEP): number {
  return clampCount(count + Math.max(1, step), total);
}

/**
 * 让第 `index` 条处在已显示的范围内 —— 键盘导航用。
 *
 * 搜索结果里用户按住向下键一路走到底时，选中项会跑到已渲染范围之外；
 * 这时把显示条数补到「覆盖它的那一批」，选中项才不会凭空消失
 * （`aria-activedescendant` 指向的节点必须存在，否则读屏与滚动都会落空）。
 * 已经可见就原样返回（不改变分片，避免每按一次键就多渲染一批）。
 *
 * 已知代价：列表在首项按 ↑ 回绕到最后一条时，`index` 就是 `total-1`，
 * 这里会一次把整份扩容出来。要避免它得把「显示条数」换成「显示窗口 [start,end)」，
 * 但那会让向上滚动出现空洞（上面那批没渲染过），需要在两个调用点各自处理，
 * 属于另一层改动；当前实现选择「保证选中项在 DOM 里」，代价只落在这一次回绕上。
 */
export function revealForSelection(index: number, count: number, total: number, step = DEFAULT_STEP): number {
  const clamped = clampCount(count, total);
  if (index < clamped) return clamped;
  const size = Math.max(1, step);
  return clampCount((Math.floor(index / size) + 1) * size, total);
}
