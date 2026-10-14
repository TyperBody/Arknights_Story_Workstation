import { chromium } from "playwright-core";

// 断言有效性自检：**人为**恢复旧样式（`.grow` 只 `flex: 1`、无 nowrap），
// 多行 loader 报错必须把 `.ed-preview-bar` 撑高 → 证明 preview-bar-oneline.mjs
// 的断言不是空跑。
const DEV = "http://localhost:5174";
const browser = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.goto(
    `${DEV}/editor/demo?text=${encodeURIComponent('[Character(name="char_002_amiya_1")]\n[name="阿米娅"]  hi')}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForSelector("textarea.ed-textarea", { timeout: 25000 });
  await page.locator(".ed-viewtabs .ed-btn", { hasText: "预览面板" }).evaluate((el) => el.click());
  await page.waitForSelector(".ed-preview-bar", { timeout: 15000 });

  const measure = () => {
    const bar = document.querySelector(".ed-preview-bar");
    return bar ? Math.round(bar.getBoundingClientRect().height) : null;
  };

  // 1) 现状（含修复）：42px 左右。
  const fixed = await page.evaluate(measure);

  // 2) 旧样式（覆盖）：`.grow{flex:1}` + 允许换行，并压窄宿主。
  await page.addStyleTag({
    content: `
      .ed-preview-bar { overflow: visible !important; white-space: normal !important; }
      .ed-preview-bar .grow { flex: 1 !important; white-space: normal !important; overflow: visible !important; }
      .ed-preview { max-width: 300px !important; margin-left: auto !important; }
    `,
  });
  await page.evaluate(() => {
    const status = document.querySelector(".ed-preview-bar .grow");
    if (status) {
      status.textContent =
        "预览失败：资源加载失败[Loader.load] Failed to load prts-cdn://localhost/torappu.prts.wiki/assets/avg/characters/char_002_amiya_1.png.\nTypeError: Failed to fetch";
    }
  });
  const regressed = await page.evaluate(measure);

  await page.screenshot({ path: "build/harness/preview-bar-oneline-regressed.png" });

  const provesAssertion = fixed !== null && regressed !== null && regressed > fixed + 20;
  console.log(JSON.stringify({ fixed, regressed, provesAssertion }, null, 2));
  process.exitCode = provesAssertion ? 0 : 1;
} finally {
  await browser.close();
}
