import { api } from "@/ahub/lib/api";
import type { HarnessReport } from "@/ahub/lib/types";

/**
 * Harness 扫描的**唯一入口**（当天的结果应用内共用一份）。
 *
 * 之前「每天首次进入自动扫一次」只做在「Harness 工具」那张卡片上，其它入口
 * （MCP 页、技能页、批量配置弹框、工具顺序区块）各自直接 invoke 一次全量扫描 ——
 * 于是一个 B 端页面逛下来要扫四五遍，用户的感觉就成了「怎么一直在扫、还特别慢」。
 *
 * 这里做三件事：① 按自然日缓存；② 并发调用共用同一个 in-flight Promise；
 * ③ 任何一次「强制扫」（用户点刷新 / 打开批量配置）都会顺手刷新这份缓存，
 * 所以缓存永远等于「最近一次扫描的结果」，不会因为某处强制扫而让别处更旧。
 */
const CACHE_KEY = "nimbusdesk.harnessScan.v1";

let memory: HarnessReport[] | null = null;
let inflight: Promise<HarnessReport[]> | null = null;

function dayKey(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function readCache(): HarnessReport[] | null {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { day?: string; reports?: HarnessReport[] };
    if (parsed.day !== dayKey() || !Array.isArray(parsed.reports)) return null;
    memory = parsed.reports;
    return memory;
  } catch {
    /* 隐私模式/配额满/坏 JSON：当作没缓存 */
    return null;
  }
}

/** 写入当天结果。单卡刷新、批量配置强制扫之后都要调它，别处才看得到最新。 */
export function writeHarnessScan(reports: HarnessReport[]): void {
  memory = reports;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ day: dayKey(), reports }));
  } catch {
    /* 缓存失败不影响功能 */
  }
}

/**
 * 取 Harness 报告：当天已有就用缓存，否则扫一次。
 * `force` 用于「用户明确要最新」的场合（打开批量配置、单卡刷新）。
 */
export function loadHarnessReports(force = false): Promise<HarnessReport[]> {
  if (!force) {
    const cached = readCache();
    if (cached) return Promise.resolve(cached);
    if (inflight) return inflight;
  }
  const run = api
    .scanHarnesses()
    .then((rs) => {
      const list = rs ?? [];
      writeHarnessScan(list);
      return list;
    })
    .finally(() => {
      inflight = null;
    });
  inflight = run;
  return run;
}
