import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

/**
 * 标签治理台的截图与冒烟：左栏齿轮 → 弹框 → 勾两条 → 归到分组。
 *
 * 治理台原来是页面级「标签」页签，页面里点那个页签按钮；现在收进了弹框
 * （`TagManagerDialog`），入口只剩左栏齿轮 —— 脚本的落点也跟着改了。
 * x 之前等的是「批量选择」按钮，那按钮在 36c2e55 就没了，脚本一直跑不起来。
 */
const dir = "E:/01-Desktop/仙台/工作台软件/docs/screenshots";
const { chromium } = await loadPlaywright();const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto("http://127.0.0.1:17800/src/ahub/fixtures/tag-shelf.html");
  // 等真内容出现再截：Vite 改完文件后第一次编译可能超过固定等待
  await page.locator("aside button[draggable]").first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${dir}/tag-shelf.png` });

  // 左栏齿轮 → 治理台弹框
  await page.locator('[data-testid="tag-shelf-manage"]').click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByRole("button", { name: "全部标签" }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/tag-manager.png` });

  // 勾两条 → 批量归组条
  await dialog.getByLabel("选择标签 代码").check();
  await dialog.getByLabel("选择标签 设计").check();
  await dialog.getByText("已选 2 个标签").waitFor({ timeout: 5000 });
  await page.screenshot({ path: `${dir}/tag-manager-batch.png` });
  await dialog.getByRole("combobox", { name: "分组" }).first().click();
  await page.getByRole("option", { name: "阶段", exact: true }).click();
  await dialog.getByRole("button", { name: "归到分组" }).click();

  const groups = await page.evaluate(() =>
    window.tagShelfReview.useTagGroups.getState().groups.map((group) => ({ name: group.name, tags: group.tags })),
  );
  console.log("phaseTags", JSON.stringify(groups.find((group) => group.name === "阶段")?.tags ?? []));

  // 技能空态（0 个技能）：原来是三张 ZIP / 文件夹 / Git 入口卡，现在只留提示 + 扫描本机。
  // 这张图原先由 shot-harness-batch.mjs 拍，那个脚本还停在更早的「批量模式」界面上跑不动，
  // 落点搬到这里 —— 同一个夹具，省得再维护一份过期定位。
  await page.goto("http://127.0.0.1:17800/src/ahub/fixtures/tag-shelf.html?empty=1");
  await page.getByText("还没有技能").waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/tag-empty.png` });

  console.log("errors", errors);
} finally {
  await browser.close();
}
