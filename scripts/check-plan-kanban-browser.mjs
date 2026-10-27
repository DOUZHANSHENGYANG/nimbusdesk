import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const server = await (await import("vite")).createServer({ server: { host: "127.0.0.1", port: 17817, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.SEARCH_BROWSER_PATH });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
  await page.goto("http://127.0.0.1:17817/src/features/plans/fixtures/plan-outline.html?view=kanban", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.outlineReview?.stores, undefined, { timeout: 20000 });

  const tasks = () =>
    page.evaluate(() =>
      window.outlineReview.stores.usePlans.getState().days[window.outlineReview.days.today].map((t) => ({
        id: t.id,
        done: !!t.done,
      })),
    );
  const col = (name) => page.locator(`[data-kanban-col="${name}"]`);
  const card = (id) => page.locator(`[data-kanban-card="${id}"]`);
  const isDone = async (id) => (await tasks()).find((t) => t.id === id)?.done;

  const todoIds = (await tasks()).filter((t) => !t.done).map((t) => t.id);
  assert.ok(todoIds.length >= 1, "夹具里至少要有一条未完成任务");
  assert.equal(await col("todo").locator("[data-kanban-card]").count(), todoIds.length, "待办列条数要和 store 一致");

  /** 指针拖动：按下 → 越过 4px 阈值 → 移到目标列 → 松手 */
  const dragCard = async (id, column) => {
    const from = await card(id).boundingBox();
    const to = await col(column).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + 18);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 12, from.y + 24, { steps: 3 });
    await page.mouse.move(to.x + to.width / 2, to.y + 120, { steps: 10 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    await page.waitForTimeout(150);
  };

  const dragged = todoIds[0];
  await dragCard(dragged, "done");
  assert.equal(await isDone(dragged), true, "拖到「已完成」必须把任务标记为完成");
  assert.equal(await card(dragged).evaluate((n) => n.closest('[data-kanban-col="done"]') !== null), true, "卡片要落到已完成列");
  console.log("PASS 看板：指针拖到「已完成」= 勾选完成");

  await dragCard(dragged, "todo");
  assert.equal(await isDone(dragged), false, "拖回「待办」必须取消完成");
  console.log("PASS 看板：指针拖回「待办」= 取消完成");

  assert.deepEqual(errors, [], "没有运行时报错");
} finally {
  await browser.close();
  await server.close();
}
