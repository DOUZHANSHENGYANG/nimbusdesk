import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

/**
 * 日历夹具：断言 + 截图（年视图与月视图各一张）。
 *
 * 断言只落在「用户能看见的东西」上：12 个月格、每格 42 天、格子里真的列出了任务名、
 * 任务多的那天出现「另外 N 个」收口、农历/节气/节日真的标出来了、
 * 不同工作项的任务真的不是同一个颜色。日历最容易悄悄退化成「只有染色方块」，
 * 所以断言里必须点数得清的文本，以及真的取计算样式看颜色。
 *
 * 用法（服务端口默认 17800，可用 PLAN_CALENDAR_ORIGIN 覆盖）：
 *   node scripts/shot-plan-calendar.mjs
 */
const origin = process.env.PLAN_CALENDAR_ORIGIN ?? "http://127.0.0.1:17800";
const dir = "E:/01-Desktop/仙台/工作台软件/docs/screenshots";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const failed = [];
const check = (ok, label) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) failed.push(label);
};

/** 页面里通用的一把抓：月份格 / 日期格 / 任务名 / 事件色块 / 农历标签 */
const PROBE = () => {
  const cards = [...document.querySelectorAll("[data-month]")];
  const chips = [...document.querySelectorAll("#root [data-chip]")];
  const colored = chips.filter((c) => [...c.classList].some((k) => k.startsWith("bg-event-")));
  const dayCells = [...document.querySelectorAll("[data-day]")];
  const lunar = dayCells.map((cell) => {
    const node = cell.querySelector("[data-lunar]");
    return {
      date: cell.dataset.day,
      text: node?.textContent?.trim() ?? "",
      festival: node?.classList.contains("text-destructive") ?? false,
    };
  });
  const lunarOf = (date) => lunar.find((l) => l.date === date)?.text ?? "";
  const year = String(window.calendarReview.year ?? "");
  return {
    months: cards.length,
    cellsPerMonth: [...new Set(cards.map((c) => c.querySelectorAll("[data-day]").length))],
    dowsPerMonth: [...new Set(cards.map((c) => c.querySelectorAll("[data-dow]").length))],
    dayCells: dayCells.length,
    columns: cards[0] ? getComputedStyle(cards[0].parentElement).gridTemplateColumns.split(" ").length : 0,
    // 月格的内容（最后一行的格子）不得越过卡片边框 —— 溢出的表现是「最后一行跑到卡片外面」
    cardOverflows: cards.filter((c) => {
      const inner = c.lastElementChild;
      return inner ? inner.getBoundingClientRect().bottom > c.getBoundingClientRect().bottom + 0.5 : false;
    }).length,
    chipCount: chips.length,
    chipWidths: chips.slice(0, 60).map((c) => Math.round(c.getBoundingClientRect().width)),
    coloredCount: colored.length,
    colors: [...new Set(colored.map((c) => getComputedStyle(c).backgroundColor))],
    overflowCount: [...document.querySelectorAll("[data-day] > span")].filter((s) => /另外|\+\s*\d|more/i.test(s.textContent ?? "")).length,
    // 农历
    lunarFilled: lunar.filter((l) => l.text).length,
    lunarSample: lunar.filter((l) => l.text).slice(0, 4).map((l) => `${l.date}=${l.text}`),
    festivalCount: lunar.filter((l) => l.festival).length,
    jan1: lunarOf(`${year}-01-01`),
    may1: lunarOf(`${year}-05-01`),
    oct1: lunarOf(`${year}-10-01`),
    hasTerm: lunar.some((l) => ["立春", "清明", "立夏", "立秋", "立冬", "冬至", "夏至", "春分", "秋分"].includes(l.text)),
    // 事件色规则（纯函数）
    colorsUsed: (() => {
      const idx = window.calendarReview.eventColorIndex;
      const ids = Array.from({ length: 300 }, (_, i) => `task-${i}`);
      return {
        distinct: new Set(ids.map((id) => idx({ id }))).size,
        max: window.calendarReview.EVENT_COLORS,
        inRange: ids.every((id) => {
          const n = idx({ id });
          return Number.isInteger(n) && n >= 0 && n < window.calendarReview.EVENT_COLORS;
        }),
        stable: idx({ id: "task-7", workItemId: null }) === idx({ id: "task-7", workItemId: null }),
        grouped: idx({ id: "a", workItemId: "proj-1" }) === idx({ id: "b", workItemId: "proj-1" }),
        differs: idx({ id: "a", workItemId: "proj-1" }) !== idx({ id: "a", workItemId: "proj-2" }),
      };
    })(),
  };
};

try {
  /* ── 年视图 ── */
  await page.goto(`${origin}/src/features/plans/fixtures/plan-calendar.html?view=year`);
  await page.waitForSelector("[data-month]", { timeout: 15000 });
  await page.waitForTimeout(300);
  const year = await page.evaluate(PROBE);
  console.log("年视图", JSON.stringify(year, null, 1));

  check(year.months === 12, `12 个月格（实际 ${year.months}）`);
  check(year.cellsPerMonth.length === 1 && year.cellsPerMonth[0] === 42, `每格 42 天（实际 ${year.cellsPerMonth}）`);
  check(year.dowsPerMonth.length === 1 && year.dowsPerMonth[0] === 7, `每月表头 7 个星期名（实际 ${year.dowsPerMonth}）`);
  check(year.chipCount > 60, `格子里列出的任务名 ≥60 条（实际 ${year.chipCount}）`);
  check(year.overflowCount > 0, `出现「+N 项」收口（实际 ${year.overflowCount}）`);
  check(year.chipWidths.every((w) => w > 40), `任务名没有被压成 0 宽（最小 ${Math.min(...year.chipWidths)}px）`);
  check(year.cardOverflows === 0, `月格内容没有溢出卡片边框（溢出 ${year.cardOverflows} 个）`);
  await page.screenshot({ path: `${dir}/plan-year.png`, fullPage: true });

  /* ── 月视图 ── */
  await page.goto(`${origin}/src/features/plans/fixtures/plan-calendar.html?view=month`);
  await page.waitForSelector("[data-day]", { timeout: 15000 });
  await page.waitForTimeout(300);
  const month = await page.evaluate(PROBE);
  console.log("月视图", JSON.stringify({ ...month, months: undefined, dowsPerMonth: undefined }, null, 1));

  check(month.dayCells === 42, `月视图 42 个日期格（实际 ${month.dayCells}）`);
  check(month.chipCount > 3, `月视图格子里列着任务名（实际 ${month.chipCount}）`);
  await page.screenshot({ path: `${dir}/plan-month.png`, fullPage: true });

  // 右侧那列面板不再常驻：默认没有，点导航右上角的入口才作为浮层出来，点别处收起
  const rail = page.getByRole("dialog", { name: "今天还没做" });
  const toggle = page.locator("button[aria-expanded]");
  check((await rail.count()) === 0, "月视图默认没有右侧面板（日历铺满）");
  check((await toggle.getAttribute("aria-expanded")) === "false", "入口按钮初始为收起态");
  await toggle.click();
  await rail.waitFor({ timeout: 5000 });
  check((await rail.count()) === 1, "点入口才弹出「今天还没做」浮层");
  check((await toggle.getAttribute("aria-expanded")) === "true", "入口按钮变成展开态");
  await page.screenshot({ path: `${dir}/plan-month-rail.png` });
  await page.mouse.click(40, 700);
  await page.waitForTimeout(200);
  check((await rail.count()) === 0, "点别处收起浮层");

  // 键盘也要有路可退
  await toggle.click();
  await rail.waitFor({ timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check((await rail.count()) === 0, "Esc 收起浮层");

  /* ── 两份视图都要成立的：事件色与农历 ── */
  for (const [name, s] of [["年视图", year], ["月视图", month]]) {
    check(s.colors.length >= 3, `${name}：不同工作项的任务至少有 3 种颜色（实际 ${s.colors.length} 种）`);
    check(s.coloredCount > 0, `${name}：事件色真的落在了任务名上（实际 ${s.coloredCount} 条）`);
    check(s.colorsUsed.distinct === s.colorsUsed.max, `${name}：色板 ${s.colorsUsed.max} 色全部用得到（实际 ${s.colorsUsed.distinct}）`);
    check(s.colorsUsed.inRange, `${name}：颜色序号都落在 0..${s.colorsUsed.max} 内`);
    check(s.colorsUsed.stable, `${name}：同一个任务每次算出来同一个颜色`);
    check(s.colorsUsed.grouped, `${name}：同一条工作项的任务同一个颜色`);
    check(s.colorsUsed.differs, `${name}：不同工作项的任务颜色不同`);
  }

  check(year.lunarFilled === year.dayCells, `年视图每一天都有农历标签（${year.lunarFilled}/${year.dayCells}）`);
  check(month.lunarFilled === month.dayCells, `月视图每一天都有农历标签（${month.lunarFilled}/${month.dayCells}）`);
  // lunar-typescript 给 1 月 1 日的名字是「元旦节」，其余两个是全称
  check(year.jan1.startsWith("元旦"), `1 月 1 日标成元旦（实际「${year.jan1}」）`);
  check(year.may1 === "劳动节", `5 月 1 日标成劳动节（实际「${year.may1}」）`);
  check(year.oct1 === "国庆节", `10 月 1 日标成国庆节（实际「${year.oct1}」）`);
  check(year.hasTerm, `标出了节气（立春/清明/冬至这类）`);
  check(year.festivalCount > 3, `节日/节气用了强调色（实际 ${year.festivalCount} 天）`);
  console.log("农历样例", year.lunarSample);

  check(errors.length === 0, `无运行时报错（实际 ${errors.length}）`);
  console.log("errors", errors);
} finally {
  await browser.close();
}

if (failed.length) {
  console.log(`\n✗ ${failed.length} 项未通过：${failed.join("；")}`);
  process.exit(1);
}
console.log("\n✓ 日历年/月视图全部通过");
