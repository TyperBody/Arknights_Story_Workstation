import { chromium } from "playwright-core";

/* eslint-disable no-console */


// 回归：预览面板必须**填满**工作台槽位 / 浮动窗（内容下面不再留白）。
// 旧症状：`.ed-preview` 内联 `height:340` → 槽位 751px 时下方留白 383px。
const DEV = "http://localhost:5174";
const browser = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.goto(
    `${DEV}/editor/demo?text=${encodeURIComponent('[Character(name="char_002_amiya_1")]\n[name="阿米娅"]  hi')}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForSelector("textarea.ed-textarea", { timeout: 25000 });
  await page.addStyleTag({ content: ".bookshelf-sync-warning{display:none!important}" }).catch(() => {});
  await page.locator(".ed-viewtabs .ed-btn", { hasText: "预览面板" }).evaluate((el) => el.click());
  await page.waitForSelector(".ed-preview", { timeout: 15000 });
  await page.waitForTimeout(500);

  const snap = async (label) => {
    const g = await page.evaluate(() => {
      const panel = document.querySelector('.ed-preview');
      const win = panel?.closest('.ed-win');
      const body = win?.querySelector('.ed-win-body');
      const slot = win?.closest('[data-wb-panel]');
      const r = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null);
      return {
        slot: r(slot),
        win: r(win),
        winState: win?.getAttribute('data-win-state') ?? null,
        body: r(body),
        preview: r(panel),
        previewInlineHeight: panel?.style.height ?? null,
      };
    });
    const gap = g.body !== null && g.preview !== null ? g.body - g.preview : null;
    console.log(label, JSON.stringify({ ...g, gap }));
    return { ...g, gap };
  };

  const docked = await snap("docked ");
  // 浮动（⧉）后再量。
  const floatBtn = page.locator('.ed-win-btn[data-win-action="float"]').first();
  if (await floatBtn.count()) await floatBtn.click().catch(() => {});
  else await page.locator(".wb-shell .ed-win-btn").filter({ hasText: "⧉" }).first().click().catch(() => {});
  await page.waitForTimeout(400);
  const floated = await snap("floated");

  // 面板高 = 浮动壳高（内容填满，不留白/不溢出）。
  const floatsFill = floated.body !== null && floated.preview !== null
    ? floated.body - floated.preview
    : null;

  // 「放大 / 还原」：放大 = `.ed-preview.full` 整页固定层；还原 = 摘掉覆盖层。
  const clickZoom = () =>
    page.evaluate(() => {
      const btn = document.querySelector('.ed-preview-bar [data-preview-action="zoom"]');
      btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  const measurePanel = () =>
    page.evaluate(() => {
      const panel = document.querySelector(".ed-preview");
      const r = panel?.getBoundingClientRect();
      const cs = panel ? getComputedStyle(panel) : null;
      return {
        full: panel?.getAttribute("data-preview-full") === "1",
        position: cs?.position ?? null,
        x: r ? Math.round(r.left) : null,
        y: r ? Math.round(r.top) : null,
        w: r ? Math.round(r.width) : null,
        h: r ? Math.round(r.height) : null,
      };
    });

  await clickZoom();
  await page.waitForTimeout(300);
  const zoomed = await measurePanel();
  await page.screenshot({ path: "build/harness/preview-zoom.png" });
  await clickZoom();
  await page.waitForTimeout(300);
  const restored = await measurePanel();

  const page_ = await page.evaluate(() => ({
    w: Math.round(document.documentElement.clientWidth),
    h: Math.round(document.documentElement.clientHeight),
  }));

  const results = {
    "docked: 面板填满槽位（gap ≤ 2）": docked.gap !== null && Math.abs(docked.gap) <= 2,
    "floated: 面板填满浮动壳（gap ≤ 2）": floatsFill !== null && Math.abs(floatsFill) <= 2,
    "zoom: 预览铺满整页（fixed + inset:0）":
      zoomed.full &&
      zoomed.position === "fixed" &&
      zoomed.x === 0 &&
      zoomed.y === 0 &&
      (zoomed.w ?? 0) >= page_.w - 4 &&
      (zoomed.h ?? 0) >= page_.h - 4,
    "unzoom: 再点摘掉覆盖层": !restored.full && restored.position !== "fixed",
  };
  for (const [name, pass] of Object.entries(results)) check(name, pass);
  const ok = Object.values(results).every(Boolean);
  await page.screenshot({ path: "build/harness/preview-fill-probe.png" });
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}

function check(name, pass) {
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
}
