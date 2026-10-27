/**
 * 规则健康度 —— 「搜索失败的自动失效」就靠这张表。
 *
 * 每条规则记三件事：连续失败次数、上次失败时间、上次成功时间。
 * 连续失败达到 FAIL_LIMIT 就进冷却（COOLDOWN_MS），冷却期内不参与搜索；
 * 冷却结束后给一次机会（半开），成功就清零、失败则重新冷却。
 *
 * 状态按日衰减：跨天自动把连续失败次数减半，避免一次网络抖动（比如笔记本没联网）
 * 把整批规则永久打死。
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";

export const FAIL_LIMIT = 2;
export const COOLDOWN_MS = 12 * 60 * 60 * 1000;

export interface RuleHealth {
  /** 连续失败次数 */
  fails: number;
  /** 上次失败时刻 */
  failedAt?: number;
  /** 上次成功时刻 */
  okAt?: number;
  /** 最近一次成功抽到几条结果（用于排序） */
  hits?: number;
}

interface HealthState {
  rules: Record<string, RuleHealth>;
  recordOk: (id: string, hits: number) => void;
  recordFail: (id: string) => void;
  reset: () => void;
}

/** 冷却判定：连续失败够多，且还没到解冻时间 */
export function isCooling(health: RuleHealth | undefined, now = Date.now()): boolean {
  if (!health || health.fails < FAIL_LIMIT) return false;
  return now - (health.failedAt ?? 0) < COOLDOWN_MS;
}

/** 跨天衰减：把陈旧账本减半，让一次性断网不会永久拉黑 */
export function decay(health: RuleHealth, now = Date.now()): RuleHealth {
  const last = Math.max(health.failedAt ?? 0, health.okAt ?? 0);
  if (!last || now - last < 24 * 60 * 60 * 1000) return health;
  return { ...health, fails: Math.floor(health.fails / 2) };
}

export const useEosHealth = create<HealthState>()(
  persist(
    (set) => ({
      rules: {},
      recordOk: (id, hits) => set((s) => ({
        rules: { ...s.rules, [id]: { fails: 0, okAt: Date.now(), hits } },
      })),
      recordFail: (id) => set((s) => {
        const prev = s.rules[id];
        return { rules: { ...s.rules, [id]: { ...prev, fails: (prev?.fails ?? 0) + 1, failedAt: Date.now() } } };
      }),
      reset: () => set({ rules: {} }),
    }),
    { name: "eos-health", storage: createJSONStorage(() => tauriJsonStorage), version: 1 },
  ),
);

/**
 * 按「能不能用」排序，而不是按上游给的分组顺序。
 * 上次有产出的排前面，冷却中的直接排除，其余按内置实测命中数。
 */
export function rankRules<T extends { id: string; yield: number }>(
  rules: T[],
  health: Record<string, RuleHealth>,
  now = Date.now(),
): T[] {
  return rules
    .filter((rule) => !isCooling(decay(health[rule.id] ?? { fails: 0 }, now), now))
    .sort((a, b) => {
      const ha = health[a.id];
      const hb = health[b.id];
      const sa = ha?.hits ?? a.yield;
      const sb = hb?.hits ?? b.yield;
      return sb - sa;
    });
}
