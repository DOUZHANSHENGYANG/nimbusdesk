import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

/**
 * 年视图夹具：断言 + 截图。
 *
 * 只断言「用户能看见的东西」——12 个月格、每格 42 天、格子里真的列出了任务名、
 * 任务多的那天出现「另外 N 个」收口。年视图最容易悄悄退化成「只有染色方块」，
 * 所以断言里必须点数得清的标题文本。
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

try {
  await page.goto(`${origin}/src/features/plans/fixtures/plan-calendar.html`);
  await page.waitForSelector("[data-month]", { timeout: 15000 });
  await page.waitForTimeout(300);

  const stats = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("[data-month]")];
    const cells = cards.map((card) => card.querySelectorAll("[data-day]").length);
    const dows = cards.map((card) => card.querySelectorAll("[data-dow]").length);
    const chips = [...document.querySelectorAll("[data-day] > span:not([data-dow])")].filter(
      (s) => !/^\d+$/.test(s.textContent ?? ""),
    );
    const overflow = [...document.querySelectorAll("[data-day] > span")].filter((s) =>
      /另外|\+\s*\d|more/i.test(s.textContent ?? ""),
    );
    return {
      months: cards.length,
      cellsPerMonth: [...new Set(cells)],
      dowsPerMonth: [...new Set(dows)],
      chipCount: chips.length,
      chipWidths: chips.slice(0, 60).map((c) => Math.round(c.getBoundingClientRect().width)),
      overflowCount: overflow.length,
      overflowSample: overflow.slice(0, 3).map((s) => s.textContent),
      text: (document.querySelector("#root").innerText ?? "").slice(0, 110).replace(/\n/g, " / "),
      gridHeight: Math.round(document.querySelector("#root").getBoundingClientRect().height),
      columns: getComputedStyle(document.querySelector("[data-month]").parentElement).gridTemplateColumns.split(" ").length,
    };
  });

  console.log("stats", JSON.stringify(stats, null, 1));
  check(stats.months === 12, `12 个月格（实际 ${stats.months}）`);
  check(stats.cellsPerMonth.length === 1 && stats.cellsPerMonth[0] === 42, `每格 42 天（实际 ${stats.cellsPerMonth}）`);
  check(stats.dowsPerMonth.length === 1 && stats.dowsPerMonth[0] === 7, `每月表头 7 个星期名（实际 ${stats.dowsPerMonth}）`);
  check(stats.chipCount > 60, `格子里列出的任务名 ≥60 条（实际 ${stats.chipCount}）`);
  check(stats.overflowCount > 0, `出现「另外 N 个」收口（实际 ${stats.overflowCount}，例 ${stats.overflowSample}）`);
  check(stats.chipWidths.every((w) => w > 40), `任务名没有被压成 0 宽（最小 ${Math.min(...stats.chipWidths)}px）`);
  check(errors.length === 0, `无运行时报错（实际 ${errors.length}）`);

  await page.screenshot({ path: `${dir}/plan-year.png`, fullPage: true });
  console.log("errors", errors);
} finally {
  await browser.close();
}

if (failed.length) {
  console.log(`\n✗ ${failed.length} 项未通过：${failed.join("；")}`);
  process.exit(1);
}
console.log("\n✓ 年视图全部通过");
