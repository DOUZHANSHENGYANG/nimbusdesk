import { useCallback, useEffect, useRef, useState } from "react";
import { clampCount, DEFAULT_STEP, nextCount, revealForSelection } from "@/lib/incremental";

/**
 * 长列表分片显示：先渲染前 `step` 条，滚到底部（哨兵可见）再放一批。
 *
 * 用它在「条目可能上千」的列表上：文件页条目网格、搜索结果。
 * 逻辑全是纯函数（`src/lib/incremental.ts`），这里只负责把它接到 React 与
 * IntersectionObserver 上。
 *
 * - `resetKey` 变化（换了筛选/搜索词）→ 回到第一批，不然用户会看到上一次的展开状态；
 * - `total` 变小（删除、过滤）→ 收窄显示条数，不会越界；
 * - 哨兵可见即再放一批；放完后仍可见会继续放，直到把可视区填满或到底。
 */
export interface IncrementalCount {
  /** 当前已渲染的条数（配合 `items.slice(0, count)` 使用） */
  count: number;
  /** 还有没渲染的 */
  hasMore: boolean;
  /** 挂到列表末尾的哨兵元素上 */
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  /** 让第 index 条进入已渲染范围（键盘导航用） */
  ensureVisible: (index: number) => void;
}

export function useIncrementalCount(
  total: number,
  options: { step?: number; resetKey?: string } = {},
): IncrementalCount {
  const step = options.step ?? DEFAULT_STEP;
  const resetKey = options.resetKey ?? "";
  const [count, setCount] = useState(() => clampCount(step, total));
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // 换筛选/搜索词：从头开始
  useEffect(() => {
    setCount(clampCount(step, total));
    // total 不进依赖：它变化由下面那个 effect 单独处理（这里只认 resetKey）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, step]);

  // 总数变化（删除、过滤）：只收窄，不主动展开
  useEffect(() => {
    setCount((current) => clampCount(current, total));
  }, [total]);

  const grow = useCallback(() => {
    setCount((current) => nextCount(current, total, step));
  }, [total, step]);

  const ensureVisible = useCallback(
    (index: number) => {
      setCount((current) => revealForSelection(index, current, total, step));
    },
    [total, step],
  );

  // 哨兵进入可视区就再放一批
  useEffect(() => {
    if (count >= total) return;
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) grow();
      },
      { rootMargin: "400px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [count, total, grow]);

  return { count, hasMore: count < total, sentinelRef, ensureVisible };
}

/** 列表末尾的哨兵：没有更多时渲染 null（也就不会多一个 DOM 节点）。 */
export function ListSentinel({
  sentinelRef,
  hasMore,
  className = "h-px w-full",
}: Pick<IncrementalCount, "sentinelRef" | "hasMore"> & { className?: string }) {
  if (!hasMore) return null;
  return <div ref={sentinelRef} aria-hidden className={className} />;
}
