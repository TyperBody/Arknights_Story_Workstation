import { chromium } from "playwright-core";
const DEV = "http://localhost:5174";
const browser = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  let hits = 0;
  await page.route(/StoryPlayer\.[A-Za-z0-9_-]+\.js/, async (route) => { hits += 1; return route.continue(); });
  await page.goto(`${DEV}/editor/demo?text=${encodeURIComponent('[Character(name="char_002_amiya_1")]\n[name="阿米娅"]  hi')}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea.ed-textarea", { timeout: 25000 });
  await page.waitForTimeout(1500);
  const tabs = await page.locator(".ed-viewtabs .ed-btn").allInnerTexts();
  console.log("tabs:", JSON.stringify(tabs));
  const preview = page.locator(".ed-viewtabs .ed-btn", { hasText: /^预览$/ }).first();
  console.log("preview count", await preview.count());
  await preview.click();
  await page.waitForTimeout(9000);
  const state = await page.evaluate(() => ({
    status: document.querySelector(".ed-preview-bar .grow")?.textContent ?? null,
    frame: Boolean(document.querySelector(".ed-preview-frame iframe")),
    frameOk: (() => { const f = document.querySelector(".ed-preview-frame iframe"); try { return Boolean(f?.contentDocument?.querySelector(".story-player")); } catch { return "x"; } })(),
    banner: document.querySelectorAll('[data-asset-banner="1"]').length,
    errors: document.querySelectorAll(".ed-alert").length,
  }));
  console.log(JSON.stringify(state), "hits", hits);
} finally { await browser.close(); }
