import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * 「AI 供应商设置有未保存改动」这一个状态。
 *
 * 以前它活在设置页内部（`onDirtyChange` 传给 AiSection），因为 AI 区块和侧栏在同一个组件里。
 * 侧栏拆成独立布局之后，两侧都需要它：AI 页负责**写**，侧栏负责在切走前**拦一下**提醒。
 * 用一个最小的 context 传，不引 store —— 它只活在「设置」这一屏里，不该被持久化。
 */
const AiDirtyContext = createContext<{ dirty: boolean; setDirty: (dirty: boolean) => void }>({
  dirty: false,
  setDirty: () => {},
});

export function AiDirtyProvider({ children }: { children: ReactNode }) {
  const [dirty, setDirty] = useState(false);
  const value = useMemo(() => ({ dirty, setDirty }), [dirty]);
  return <AiDirtyContext.Provider value={value}>{children}</AiDirtyContext.Provider>;
}

export function useAiDirty() {
  return useContext(AiDirtyContext);
}
