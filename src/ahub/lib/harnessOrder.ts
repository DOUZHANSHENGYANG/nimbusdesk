/** 按用户自定义顺序重排 harness 列表；未在顺序表中的排在末尾并保持原序。 */
export function sortByOrder<T extends { id: string }>(list: T[] | null, order: string[]): T[] | null {
  if (!list) return list;
  if (!order.length) return list;
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return list
    .map((x, i) => ({ x, i }))
    .sort((a, b) => rank(a.x.id) - rank(b.x.id) || a.i - b.i)
    .map(({ x }) => x);
}
