import { chromium } from "playwright-core";
const DEV = "http://localhost:5174";
const browser = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const logs = [];
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text().slice(0, 160)}`));
  page.on("pageerror", (e) => logs.push("pageerror: " + String(e).slice(0, 160)));
  let hits = 0;
  await page.route(/StoryPlayer\.[A-Za-z0-9_-]+\.js/, async (route) => { hits += 1; return route.continue(); });
  await page.addStyleTag; // noop
  await page.goto(`${DEV}/editor/demo?text=${encodeURIComponent('[Character(name="char_002_amiya_1")]\n[name="阿米娅"]  hi')}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea.ed-textarea", { timeout: 25000 });
  await page.addStyleTag({ content: ".bookshelf-sync-warning{display:none!important}" }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.locator(".ed-viewtabs .ed-btn", { hasText: /预览/ }).first().evaluate((el) => el.click());
  await page.waitForTimeout(12000);
  const state = await page.evaluate(() => ({
    status: document.querySelector(".ed-preview-bar .grow")?.textContent ?? null,
    frame: Boolean(document.querySelector(".ed-preview-frame iframe")),
    player: (() => { const f = document.querySelector(".ed-preview-frame iframe"); try { return Boolean(f?.contentDocument?.querySelector(".story-player")); } catch { return "x"; } })(),
    banner: document.querySelectorAll('[data-asset-banner="1"]').length,
  }));
  console.log(JSON.stringify(state), "hits", hits);
  console.log("logs:", JSON.stringify(logs.slice(-12), null, 1));
} finally { await browser.close(); }
