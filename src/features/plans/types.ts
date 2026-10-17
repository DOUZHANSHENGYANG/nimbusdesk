/** 计划管理数据模型与树工具 */

export type TaskStatus = "todo" | "doing" | "done";

/** Managed local copy; path is relative to the data directory. */
export interface TaskAttachment {
  id: string;
  name: string;
  path: string;
  size: number;
  createdAt: number;
}

export interface PlanTask {
  id: string;
  /** null = 顶层计划；否则为父任务 id */
  parentId: string | null;
  title: string;
  note?: string;
  /** 开始时间 HH:mm，可空 */
  start?: string;
  /** 结束时间 HH:mm，可空。与 start 成对出现才构成时间范围 */
  end?: string;
  /**
   * 唯一由用户直接设置的状态：点一下勾选即完成。
   * 「进行中」是推导出来的（见 statusOf），不落盘 ——
   * 因此到点自动变进行中不需要任何定时器去改数据。
   */
  done: boolean;
  createdAt: number;
  /**
   * 最后修改时间。**只有备份合并（backup.ts）在用它**：
   * 同 id 冲突时保留较新的一份。不做展示，不参与排序。
   */
  updatedAt: number;
  /**
   * 关联的本地文件/文件夹/网址，点击直达。
   *
   * 与文件条目（FileItem.type）刻意用同一套三态，这样「绑定」的语义在整个
   * 应用里只有一种解释：路径是真实的、由系统默认程序打开。
   * 缺失 = 未关联（不写空对象，JSON 里干脆不带这个键）。
   */
  link?: TaskLink;
  attachments?: TaskAttachment[];
}

/** 关联类型，与 FileItem.type 对齐 */
export type TaskLinkType = "folder" | "file" | "url";

export interface TaskLink {
  type: TaskLinkType;
  /** 绝对路径或完整 URL */
  path: string;
  /** 自定展示名。缺省时由 linkTitle() 从 path 推导 */
  title?: string;
}

/**
 * 关联的展示名。
 *
 * 优先用自定标题；否则取路径末段。URL 走 hostname+path 而不是整串 ——
 * 完整 URL 常常长到把任务标题挤没，而任务标题才是这一行的主体。
 */
export function linkTitle(link: TaskLink): string {
  const custom = link.title?.trim();
  if (custom) return custom;
  if (link.type === "url") {
    try {
      const u = new URL(link.path);
      const host = u.hostname.replace(/^www\./, "");
      const rest = u.pathname === "/" ? "" : u.pathname;
      return `${host}${rest}`;
    } catch {
      return link.path;
    }
  }
  const seg = link.path.split(/[\\/]/).filter(Boolean).pop();
  return seg ?? link.path;
}

export interface ArchivedDay {
  archivedAt: number;
  tasks: PlanTask[];
}

export type PlanTaskPatch = Partial<Pick<PlanTask, "title" | "note" | "start" | "end" | "done" | "link" | "attachments">>;

/* ── 时间 ─────────────────────────────────────────────── */

/**
 * 时间轴纵向范围：默认 08:00 – 22:00。
 * 只用于布局与夹取，从不写进任务；实际范围由 axisBounds() 按任务撑开
 * （更早的开始 / 更晚的结束），两端再各留一点松弛。
 */
export const AXIS_DEFAULT_FROM = 8 * 60;
export const AXIS_DEFAULT_TO = 22 * 60;

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** "HH:mm" → 当日分钟数；非法或空返回 null */
export function minutesOf(hhmm?: string): number | null {
  if (!hhmm) return null;
  const m = HHMM_RE.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 当日分钟数 → "HH:mm" */
export function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 是否构成合法时间范围（两端都有且 end > start） */
export function hasRange(task: Pick<PlanTask, "start" | "end">): boolean {
  const s = minutesOf(task.start);
  const e = minutesOf(task.end);
  return s != null && e != null && e > s;
}

/** 时间范围展示文本，如 "09:00 – 11:30"；无范围返回 null */
export function rangeLabel(task: Pick<PlanTask, "start" | "end">): string | null {
  if (!hasRange(task)) return null;
  return `${task.start} – ${task.end}`;
}

/** 时长文本，如 "2 小时 30 分" / "45 分"；无范围返回 null */
export function rangeDuration(task: Pick<PlanTask, "start" | "end">): number | null {
  const s = minutesOf(task.start);
  const e = minutesOf(task.end);
  if (s == null || e == null || e <= s) return null;
  return e - s;
}

/* ── 状态推导 ─────────────────────────────────────────── */

/**
 * 任务在给定日期下的状态。
 *
 * - done：用户手动勾选，唯一可直接设置的状态
 * - doing：仅当「任务属于今天」且「当前时刻落在 [start, end) 内」时成立
 * - todo：其余情况（含没设时间范围的任务 —— 它们永远保持待办直到手动完成）
 *
 * 纯函数：now 由调用方传入，配合 useNow() 定期重算即可实现「到点自动开始」。
 */
export function statusOf(
  task: Pick<PlanTask, "done" | "start" | "end">,
  date: string,
  now: Date = new Date(),
): TaskStatus {
  if (task.done) return "done";
  if (date !== fmtDate(now)) return "todo";
  const s = minutesOf(task.start);
  const e = minutesOf(task.end);
  if (s == null || e == null || e <= s) return "todo";
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur >= s && cur < e ? "doing" : "todo";
}

/* ── 树工具 ───────────────────────────────────────────── */

/** 某日直接子任务（保持数组顺序） */
export function childrenOf(tasks: PlanTask[], parentId: string | null): PlanTask[] {
  return tasks.filter((t) => t.parentId === parentId);
}

/** 收集某任务及其全部后代 id（级联删除用） */
export function subtreeIds(tasks: PlanTask[], id: string): Set<string> {
  const ids = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tasks) {
      if (t.parentId && ids.has(t.parentId) && !ids.has(t.id)) {
        ids.add(t.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** 子树完成进度（不含自身） */
export function subtreeProgress(tasks: PlanTask[], id: string): { done: number; total: number } {
  const ids = subtreeIds(tasks, id);
  let done = 0;
  let total = 0;
  for (const t of tasks) {
    if (t.id !== id && ids.has(t.id)) {
      total++;
      if (t.done) done++;
    }
  }
  return { done, total };
}

/** 统计某日完成进度（按落盘的 done 计，与时间推导无关） */
export function dayProgress(tasks: PlanTask[]): { done: number; total: number } {
  return { total: tasks.length, done: tasks.filter((t) => t.done).length };
}

/* ── 日期 ─────────────────────────────────────────────── */

/** 本地日期 YYYY-MM-DD */
export function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayStr(): string {
  return fmtDate(new Date());
}

export function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return fmtDate(dt);
}

export function parseDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/* ── 日期区间（归档筛选等用） ─────────────────────────── */

export interface DateRange {
  /** 起（含），YYYY-MM-DD；null = 不限 */
  from: string | null;
  /** 止（含），YYYY-MM-DD；null = 不限 */
  to: string | null;
}

/** 日期是否落在区间内（两端都含）。字符串比较即可 —— YYYY-MM-DD 字典序 = 时间序 */
export function inRange(date: string, range: DateRange): boolean {
  if (range.from && date < range.from) return false;
  if (range.to && date > range.to) return false;
  return true;
}

/** 区间天数（含两端）；任一端为空返回 null */
export function rangeDays(range: DateRange): number | null {
  if (!range.from || !range.to) return null;
  const ms = parseDate(range.to).getTime() - parseDate(range.from).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

/** 相对今天的常用区间。周一为一周起点（与日历视图一致） */
export function presetRange(
  preset: "today" | "week" | "month" | "last7" | "last30",
  now: Date = new Date(),
): DateRange {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const shift = (d: Date, delta: number) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta);

  switch (preset) {
    case "today":
      return { from: fmtDate(base), to: fmtDate(base) };
    case "week": {
      const offset = (base.getDay() + 6) % 7; // 周一为首
      const mon = shift(base, -offset);
      return { from: fmtDate(mon), to: fmtDate(shift(mon, 6)) };
    }
    case "month": {
      const first = new Date(base.getFullYear(), base.getMonth(), 1);
      const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
      return { from: fmtDate(first), to: fmtDate(last) };
    }
    case "last7":
      return { from: fmtDate(shift(base, -6)), to: fmtDate(base) };
    case "last30":
      return { from: fmtDate(shift(base, -29)), to: fmtDate(base) };
  }
}

/** 某月的日历网格（42 格，周一为首），格内含是否属于本月 */
export function monthGrid(
  year: number,
  month: number,
): { date: string; inMonth: boolean }[] {
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - startOffset);
  const cells: { date: string; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({ date: fmtDate(d), inMonth: d.getMonth() === month });
  }
  return cells;
}

/** 该月第一天 / 最后一天的 YYYY-MM-DD */
export function monthBounds(year: number, month: number): { from: string; to: string } {
  return {
    from: fmtDate(new Date(year, month, 1)),
    to: fmtDate(new Date(year, month + 1, 0)),
  };
}
/* ── 时间轴几何（timeline 视图用；纯函数，便于断言） ──── */

/** 当日最后一个可表示的分钟（23:59）。注意 "24:00" 不是合法 HH:mm，落盘前必须夹到这里 */
export const DAY_END_MIN = 23 * 60 + 59;

/** 拖动吸附粒度（分钟） */
export const SNAP_MIN = 5;

/** 时间块最短持续时长（分钟） */
export const MIN_BLOCK_MIN = 15;


/** 吸附到最近的粒度格 */
export function snapMinute(m: number, step: number = SNAP_MIN): number {
  return Math.round(m / step) * step;
}

/** 夹在 [lo, hi] 内 */
export function clampMinute(m: number, lo: number, hi: number): number {
  return Math.min(Math.max(m, lo), hi);
}

/**
 * 任务在时间轴上的显示区间（分钟）。
 * - 有合法范围 → 用范围
 * - 只有起点 → 给 MIN_BLOCK_MIN 的可见高度，否则会塌成一条看不见的线
 * - 没有起点 → null（归入未定时搁板）
 */
export function axisRange(
  task: Pick<PlanTask, "start" | "end">,
): { start: number; end: number } | null {
  const s = minutesOf(task.start);
  if (s == null) return null;
  const e = minutesOf(task.end);
  // 合法区间原样返回，只夹终点（防越界）。起点不夹 —— 23:50–23:59 是合法范围，
  // 挪动起点会悄悄改掉用户的数据。
  if (e != null && e > s) return { start: s, end: Math.min(e, DAY_END_MIN) };
  // 没有合法终点时才合成最短块，这时起点必须夹：23:59 起点的「+15 分钟」会得到
  // {1439, 1439}，那样它在轴上算有块（会渲染出来），而 hasRange 判为无范围
  // （永不会「进行中」）—— 两个视图对同一条数据给出矛盾结论。
  const start = Math.min(s, DAY_END_MIN - MIN_BLOCK_MIN);
  return { start, end: start + MIN_BLOCK_MIN };
}

/**
 * 时间轴纵向范围：默认 08:00–22:00，被任务撑开后取整到小时。
 *
 * 时间轴视图已改用固定的全天轴，不再需要这个函数；它保留给需要
 * 「按内容裁出紧凑区间」的调用方（例如未来做缩略图 / 概览条）。
 */
export function axisBounds(tasks: Pick<PlanTask, "start" | "end">[]): {
  from: number;
  to: number;
} {
  let from = AXIS_DEFAULT_FROM;
  let to = AXIS_DEFAULT_TO;
  for (const task of tasks) {
    const r = axisRange(task);
    if (!r) continue;
    from = Math.min(from, Math.floor(r.start / 60) * 60);
    to = Math.max(to, Math.ceil(r.end / 60) * 60);
  }
  return { from, to: Math.max(to, from + 60) };
}

/** 整体平移（保持时长），结果夹在 [lo, hi] 内 */
export function shiftRange(
  start: number,
  end: number,
  delta: number,
  lo: number,
  hi: number,
): { start: number; end: number } {
  const dur = end - start;
  const s = clampMinute(start + delta, lo, Math.max(hi - dur, lo));
  return { start: s, end: s + dur };
}

/** 拖某一端：另一端固定，最短 MIN_BLOCK_MIN */
export function dragEdge(
  start: number,
  end: number,
  edge: "start" | "end",
  target: number,
  lo: number,
  hi: number,
): { start: number; end: number } {
  if (edge === "start") {
    return { start: clampMinute(target, lo, Math.max(end - MIN_BLOCK_MIN, lo)), end };
  }
  return { start, end: clampMinute(target, Math.max(start + MIN_BLOCK_MIN, lo), hi) };
}

export interface LaneInfo {
  /** 第几条轨道（0 起） */
  lane: number;
  /** 所在重叠簇的总轨道数（算宽度用） */
  lanes: number;
}

/**
 * 重叠任务分轨道（日历类应用的标准贪心布局）。
 *
 * 按开始时间排序，逐个塞进第一条已空闲的轨道；出现不重叠的间隔就结算当前
 * 重叠簇的轨道数 —— 按「簇」而不是「整天」算宽度，才不会因为一天里任意
 * 两处重叠就把所有任务都压窄。
 */
export function packLanes(
  blocks: { id: string; start: number; end: number }[],
): Map<string, LaneInfo> {
  const sorted = [...blocks].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id),
  );
  const out = new Map<string, LaneInfo>();
  let cluster: { id: string; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;

  const flush = () => {
    if (!cluster.length) return;
    const lanes = laneEnds.length;
    for (const c of cluster) out.set(c.id, { lane: c.lane, lanes });
    cluster = [];
    laneEnds = [];
    clusterEnd = Number.NEGATIVE_INFINITY;
  };

  for (const b of sorted) {
    if (cluster.length && b.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((e) => e <= b.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(b.end);
    } else {
      laneEnds[lane] = b.end;
    }
    cluster.push({ id: b.id, lane });
    clusterEnd = Math.max(clusterEnd, b.end);
  }
  flush();
  return out;
}

/**
 * 规范化区间：吸附到 `step`、保证 end > start、夹在 [0, DAY_END_MIN]。
 * 落盘前统一走一遍，避免出现 end === start（hasRange 会判为无范围，
 * 块就消失到未定时区去了）或 "23:60" 这类非法值。
 *
 * `step` 让键盘的 1 分钟微调不被 5 分钟吸附吃掉 —— 否则 Ctrl+↑ 算出的
 * 1 分钟位移会在吸附时被抹回原值，看起来完全没有反应。
 */
export function normalizeRange(
  span: { start: number; end: number },
  step: number = SNAP_MIN,
): { start: number; end: number } {
  const start = clampMinute(snapMinute(span.start, step), 0, DAY_END_MIN - MIN_BLOCK_MIN);
  const end = clampMinute(snapMinute(span.end, step), start + MIN_BLOCK_MIN, DAY_END_MIN);
  return { start, end };
}

/* ── 多行粘贴拆分（A2） ───────────────────────────────── */

/**
 * 把一段文本拆成多条任务标题。
 *
 * 存在的理由：从聊天记录/邮件/网页里一次复制 10 行待办，粘进输入框后
 * 如果原样变成一条任务，用户必须手工拆 10 次 —— 这是待办应用里最常见的
 * 一次「反人类」操作。
 *
 * 拆分规则（刻意保守，宁可少拆也不误拆）：
 *   - 按换行拆（\r\n / \n / \r 都算）
 *   - 逐行 trim；空行丢弃
 *   - 剥掉行首的项目符号（- * • · ▢ ☐ 数字. 数字) ），它们是「复制来源的格式」，
 *     不是任务内容
 *   - 单行输入（没有换行）返回 **1 条**，调用方据此走原有的「一条」路径，
 *     不会因为多经过一次拆分就产生任何行为差异
 *
 * 只返回标题数组，不去重、不改写内容 —— 去重会让用户「明明粘了 10 行
 * 却只出现 7 条」而无从判断，这类静默丢弃比重复更糟。
 */
export function splitPastedLines(text: string): string[] {
  return text
    .split(/\r\n|\n|\r/)
    .map((line) => stripListMarker(line).trim())
    .filter((line) => line.length > 0);
}

/** 行首项目符号 / 有序列表序号 */
function stripListMarker(line: string): string {
  return line.replace(
    /^\s*(?:[-*+•·▢☐▣□]|\d+[.)])\s+/,
    "",
  );
}

/** 是否值得走拆分路径（含换行且有内容）。单行文本交给原路径，避免无谓分支 */
export function shouldSplitPaste(text: string): boolean {
  return /\r|\n/.test(text) && splitPastedLines(text).length > 0;
}

/* ── 完成项排序（A3） ─────────────────────────────────── */

/**
 * 把已完成项移到末尾（稳定排序：各自的相对顺序不变）。
 *
 * 与「自动清除」的区别：这个只影响**显示**，数据一条不删 ——
 * 取消勾选后会回到原来的相对位置，用户不会有「我的东西哪去了」的惊慌。
 * 因此它默认开启、无需确认；自动清除是破坏性的，必须显式开启。
 */
export function withDoneLast(tasks: PlanTask[]): PlanTask[] {
  const active = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  return [...active, ...done];
}

/**
 * 全树按「完成沉底」重排：每一层的兄弟节点各自置底，子树跟着父节点走。
 *
 * 不能只对顶层数组排序 —— 那样子任务会脱离父任务，树结构就断了。
 * 这里按 parentId 分组递归重建，保证输出仍是同一棵树。
 */
export function withDoneLastTree(tasks: PlanTask[]): PlanTask[] {
  const byParent = new Map<string | null, PlanTask[]>();
  for (const t of tasks) {
    const key = t.parentId;
    const arr = byParent.get(key);
    if (arr) arr.push(t);
    else byParent.set(key, [t]);
  }
  const out: PlanTask[] = [];
  const walk = (parentId: string | null) => {
    const kids = withDoneLast(byParent.get(parentId) ?? []);
    for (const k of kids) {
      out.push(k);
      walk(k.id);
    }
  };
  walk(null);
  // 兜底：父节点缺失的孤儿任务（数据异常）不能被合成过程吞掉
  const seen = new Set(out.map((t) => t.id));
  for (const t of tasks) if (!seen.has(t.id)) out.push(t);
  return out;
}
