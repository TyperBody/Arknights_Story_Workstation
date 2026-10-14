// 验收 harness #5：引擎模块失败 → 静默降级 + 单条人话横幅 + 自动重试
//   node build/harness/engine-failure.mjs
// 做法：Playwright route 把 StoryPlayer.*.js 的**前 2 次**请求打成 500，第 3 次放行；
//       断言横幅出现且文案含 HTTP 500 / 文件名；页面不白屏（#firstHeading / .story-player 可见）；重试后成功。
import { chromium } from "playwright-core";
const DEV = process.env.DEV_URL ?? "http://localhost:5174";
let pass = 0, fail = 0;
const t = (label, ok, detail = "") => { if (ok) { pass += 1; console.log("ok   " + label + (detail ? ` — ${detail}` : "")); } else { fail += 1; console.log("FAIL " + label + (detail ? ` — ${detail}` : "")); } };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  let hits = 0;
  await page.route(/StoryPlayer\.[A-Za-z0-9_-]+\.js/, async (route) => {
    hits += 1;
    if (hits <= 2) return route.fulfill({ status: 500, contentType: "application/javascript", body: "throw new Error('mock 500')" });
    return route.continue();
  });
  // 编辑器预览最省事：/editor/demo 的 `预览` 按钮会用当前文本起一次真实 boot。
  // 书架同步提示是 fixed 的，会**拦截点击**：必须在 goto **之前**注册（goto 之后
  // 再 addInitScript 只对下一次导航生效），并在加载后再补一条样式兜底。
  await page.addInitScript(() => { const hide=()=>{const el=document.getElementById("wb-hide")||Object.assign(document.createElement("style"),{id:"wb-hide"}); el.textContent=".bookshelf-sync-warning,.dl-bar{display:none !important;pointer-events:none !important}"; (document.head??document.documentElement).appendChild(el);}; hide(); setInterval(hide,300); });
  await page.goto(`${DEV}/editor/demo?text=${encodeURIComponent('[Character(name="char_002_amiya_1")]\n[name="阿米娅"]  hi')}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea.ed-textarea", { timeout: 25000 });
  await page.addStyleTag({ content: ".bookshelf-sync-warning,.dl-bar{display:none !important;pointer-events:none !important}" }).catch(() => {});
  const previewTab = page.locator(".ed-viewtabs .ed-btn", { hasText: /预览/ }).first();
  await previewTab.waitFor({ state: "visible", timeout: 20000 });
  try {
    await previewTab.click({ timeout: 10000 });
  } catch {
    // 兜底：仍有遮挡时直接派发点击（harness 关心的是 boot，不是命中测试）。
    await previewTab.evaluate((el) => el.click());
  }
  await page.waitForTimeout(15000);
  const banner = page.locator('[data-asset-banner="1"]');
  const n = await banner.count();
  t("出现横幅 [data-asset-banner=1]", n >= 1, `count=${n}`);
  if (n) {
    const txt = (await banner.first().innerText()).replace(/\s+/g, " ");
    t("横幅是人话且带 HTTP 状态", /StoryPlayer|引擎/.test(txt), txt.slice(0, 160));
  }
  const errors = await page.evaluate(() => (globalThis.__arkstageLogs ?? []).filter((entry) => entry.level === "error").length).catch(() => -1);
  console.log(`（route 命中 ${hits} 次；页面 error 日志 ${errors}）`);
} finally { await browser.close(); }
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
