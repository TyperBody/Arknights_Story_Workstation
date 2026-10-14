import { chromium } from "playwright-core";

// 回归：`.ed-preview-bar` 必须保持**单行**高度。
// 复现：面板拖窄 + 状态里塞一条多行 loader 报错（真实场景见 _p6-ed2.mjs 的
// 「预览失败：…Loader.load… \n TypeError: …」状态文字）。
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
  await page.waitForSelector(".ed-preview-bar", { timeout: 15000 });

  const measure = () => {
    const bar = document.querySelector(".ed-preview-bar");
    const status = document.querySelector(".ed-preview-bar .grow");
    if (!bar) return null;
    const lineH = parseFloat(getComputedStyle(bar).fontSize) * 1.5;
    return {
      barHeight: Math.round(bar.getBoundingClientRect().height),
      statusLines: status ? Math.round(status.getBoundingClientRect().height / lineH) : 0,
      title: status?.textContent?.slice(0, 24) ?? "",
      buttons: bar.querySelectorAll("button").length,
    };
  };

  // 1) 默认宽度：应有 3 个按钮（重新载入预览 / 放大 / 关闭）且单行。
  const normal = await page.evaluate(measure);

  // 2) 压窄面板：标题在、按钮在、状态文字省略号，bar 仍单行。
  await page.evaluate(() => {
    const host = document.querySelector(".ed-preview");
    if (host) { host.style.maxWidth = "360px"; host.style.marginLeft = "auto"; }
  });
  const narrow = await page.evaluate(measure);

  // 3) 多行报错状态：`white-space: nowrap` 应把两行合成一行。
  await page.evaluate(() => {
    const status = document.querySelector(".ed-preview-bar .grow");
    if (status) {
      status.textContent =
        "预览失败：资源加载失败[Loader.load] Failed to load prts-cdn://localhost/torappu.prts.wiki/assets/avg/characters/char_002_amiya_1.png.\nTypeError: Failed to fetch";
    }
  });
  const withError = await page.evaluate(measure);

  await page.screenshot({ path: "build/harness/preview-bar-oneline.png" });

  // bar 的基准高度由按钮决定（`.ed-btn` 13px + 6px 上下 padding ≈ 33，
  // 加 bar 的 4px padding ≈ 42）：只要**不超过**这个基准，就说明状态
  // 文字没有把它撑高（修复前「一字一列」会到几百 px）。
  const BAR_BASE = 48;
  const btnH = await page.evaluate(() => {
    const b = document.querySelector(".ed-preview-bar .ed-btn");
    return b ? Math.round(b.getBoundingClientRect().height) : 0;
  });
  const ok =
    normal !== null &&
    normal.barHeight <= BAR_BASE &&
    narrow !== null &&
    narrow.barHeight <= BAR_BASE &&
    (narrow.statusLines === 0 || narrow.statusLines === 1) &&
    withError !== null &&
    withError.barHeight <= BAR_BASE &&
    withError.statusLines === 1;
  console.log(`bar base=${BAR_BASE} (button height ${btnH})`);
  console.log(JSON.stringify({ normal, narrow, withError, ok }, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
