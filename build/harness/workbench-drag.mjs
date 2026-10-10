// 验收 harness #4：拼接/换位/调尺寸（依赖 P3 的 [data-wb-gutter] + P5 接线）
//   node build/harness/workbench-drag.mjs
import { chromium } from "playwright-core";
const DEV = process.env.DEV_URL ?? "http://localhost:5174";
let pass = 0, fail = 0;
const t = async (label, fn) => { try { await fn(); pass += 1; console.log("ok   " + label); } catch (e) { fail += 1; console.log("FAIL " + label + " — " + e.message); } };
const text = '[Character(name="char_002_amiya_1")]\n[name="阿米娅"]  hi';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  await page.addInitScript(() => localStorage.removeItem("prts-editor-wb:default"));
  await page.addInitScript(() => {
    const fix = () => {
      if (document.getElementById("wb-hide")) return;
      try {
        const el = document.createElement("style");
        el.id = "wb-hide";
        el.textContent = ".bookshelf-sync-warning,.dl-bar{display:none !important}";
        (document.head || document.documentElement).appendChild(el);
      } catch { /* head 还没建好 */ }
    };
    fix(); setInterval(fix, 100);
  });
  await page.goto(`${DEV}/editor/demo?text=${encodeURIComponent(text)}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea.ed-textarea", { timeout: 25000 });
  await page.waitForTimeout(1500);

  await t("存在分隔条 [data-wb-gutter]", async () => {
    const n = await page.locator("[data-wb-gutter]").count();
    if (!n) throw new Error("count=0（P3 的 Workbench 还没接线）");
  });
  const gut = page.locator("[data-wb-gutter]").first();
  if (await gut.count()) {
    await t("拖分隔条改变 share 并持久化", async () => {
      const before = await page.evaluate(() => localStorage.getItem("prts-editor-wb:default"));
      const b = await gut.boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + 160, b.y + b.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => localStorage.getItem("prts-editor-wb:default"));
      if (!after || after === before) throw new Error(`未持久化 before=${before} after=${after}`);
    });
  }
  await t("拖「分支图」标题条到 toolpanel 右侧 → 结构变化", async () => {
    const tab = page.locator(".ed-viewtabs .ed-btn", { hasText: "分支图" });
    if (!(await tab.count())) throw new Error("工具栏没有分支图开关");
    await tab.first().click(); await page.waitForTimeout(400);
    const before = await page.evaluate(() => localStorage.getItem("prts-editor-wb:default"));
    const bar = page.locator('[data-wb-panel="branch"] .ed-win-bar').first();
    const target = await page.locator('[data-wb-panel="toolpanel"]').first().boundingBox();
    const bb = await bar.boundingBox();
    if (!bb || !target) throw new Error("找不到标题条/目标面板");
    await page.mouse.move(bb.x + 40, bb.y + bb.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width - 12, target.y + target.height / 2, { steps: 12 });
    await page.waitForTimeout(150);
    const hasOverlay = await page.locator("[data-wb-overlay]").count();
    await page.mouse.up();
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => localStorage.getItem("prts-editor-wb:default"));
    if (!hasOverlay && after === before) throw new Error(`overlay=${hasOverlay} 且布局未变`);
  });
} finally { await browser.close(); }
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
