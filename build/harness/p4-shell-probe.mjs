// P4 窗口壳行为探针（dock/map 语义的交互侧）——`node build/harness/p4-shell-probe.mjs`
//   需要 dev server（默认 5174）。断言：
//   (1) 常驻 dock（toolpanel/stage）标题条只有折叠 `▾`，**没有** `.ed-win-btn`（无 ⧉/✕）；
//   (2) `▾` = 收起 = 隐藏 Body（`hidden`），但**仍在工作台里**（"显示不显示"）；
//   (3) Map（branch）标题条 `▾ ⧉ ✕`；`⧉` → `data-win-state="float"`；
//   (4) 浮动窗标题条可拖动（指针位移 → rect 位移）；
//   (5) 右下角手柄可改尺寸；
//   (6) `✕` = 从工作台移除（`[data-wb-panel=branch]` 消失）。
import { chromium } from "playwright-core";

const DEV = process.env.DEV_URL ?? "http://localhost:5174";
let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`ok   ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  await page.goto(`${DEV}/editor/demo?text=${encodeURIComponent('[name="阿米娅"]  hello\n[Decision(options="A;B",values="1;2")]\n[Predicate(references="1")]\n[name="A"] A')}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea.ed-textarea", { timeout: 25000 });
  await page.addStyleTag({ content: ".bookshelf-sync-warning,.dl-bar{display:none !important}" });
  await page.waitForTimeout(1200);

  for (const id of ["toolpanel", "stage"]) {
    // 2026-10-13 契约变更：常驻面板也有 `⧉`（分离为独立窗口），`✕` 仍然没有。
    const floatBtn = await page.locator(`[data-wb-panel="${id}"] [data-win-action="float"]`).count();
    const closeBtn = await page.locator(`[data-wb-panel="${id}"] [data-win-action="close"]`).count();
    const fold = await page.locator(`[data-wb-panel="${id}"] .ed-win-collapse`).count();
    ok(`${id} 常驻：有 ⧉、无 ✕，折叠 ▾ 存在`, floatBtn === 1 && closeBtn === 0 && fold === 1, `float=${floatBtn} close=${closeBtn} fold=${fold}`);
    ok(`${id} data-win-state=dock`, (await page.locator(`[data-wb-panel="${id}"] [data-win]`).getAttribute("data-win-state")) === "dock");
  }

  // 折叠 = 显示/隐藏（DOM 保留）
  await page.evaluate(() => document.querySelector('[data-wb-panel="toolpanel"] .ed-win-collapse')?.click());
  await page.waitForTimeout(350);
  ok("折叠：Body hidden 且仍在工作台", (await page.locator('[data-wb-panel="toolpanel"] .ed-win-body[hidden]').count()) === 1 && (await page.locator('[data-wb-panel="toolpanel"]').count()) === 1);
  await page.evaluate(() => document.querySelector('[data-wb-panel="toolpanel"] .ed-win-collapse')?.click());
  await page.waitForTimeout(250);
  ok("展开：Body 回来", (await page.locator('[data-wb-panel="toolpanel"] .ed-win-body:not([hidden])').count()) === 1);

  // Map：branch
  await page.evaluate(() => { [...document.querySelectorAll(".ed-viewtabs .ed-btn")].find((el) => el.textContent.includes("分支图"))?.click(); });
  await page.waitForTimeout(600);
  const actions = await page.locator('[data-wb-panel="branch"] .ed-win-bar button').evaluateAll((els) => els.map((e) => e.dataset.winAction ?? "?"));
  ok("Map 标题条 = ▾ + ⧉ + ✕", JSON.stringify(actions) === JSON.stringify(["fold", "float", "close"]), JSON.stringify(actions));

  await page.evaluate(() => document.querySelector('[data-wb-panel="branch"] [data-win-action="float"]')?.click());
  await page.waitForTimeout(400);
  const win = page.locator('[data-win="分支图"]');
  ok("⧉ → data-win-state=float", (await win.getAttribute("data-win-state")) === "float");
  // 先测右下角手柄（此时窗口还在视口内），再测拖动（窗口可能被拖到边缘）。
  const box0 = await win.boundingBox();
  const handle = await win.locator(".ed-win-resize").boundingBox();
  await page.mouse.move(handle.x + 6, handle.y + 6);
  await page.mouse.down();
  await page.mouse.move(handle.x + 6 - 90, handle.y + 6 - 60, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const box1 = await win.boundingBox();
  ok("右下角手柄可改尺寸", Math.round(box0.width - box1.width) > 60 && Math.round(box0.height - box1.height) > 40, `Δ=${Math.round(box1.width - box0.width)}x${Math.round(box1.height - box0.height)}`);

  const bar = await win.locator(".ed-win-bar").boundingBox();
  await page.mouse.move(bar.x + 60, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + 60 - 120, bar.y + bar.height / 2 - 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const box2 = await win.boundingBox();
  ok("浮动窗标题条可拖动", Math.round(box1.x - box2.x) > 80 && Math.round(box1.y - box2.y) > 20, `Δ=${Math.round(box2.x - box1.x)},${Math.round(box2.y - box1.y)}`);

  await page.evaluate(() => document.querySelector('[data-win="分支图"] [data-win-action="close"]')?.click());
  await page.waitForTimeout(400);
  ok("✕ = 从工作台移除", (await page.locator('[data-wb-panel="branch"]').count()) === 0);
} finally {
  await browser.close();
}
console.log(`\np4-shell-probe: ${pass} ok / ${fail} fail`);
if (fail) process.exitCode = 1;
