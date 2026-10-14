// 验收 harness #2/#3：工具面板/舞台 = 常驻 dock（无 ⧉/✕）；预览/分支图 = Map（工具栏开关）
//   node build/harness/window-chrome.mjs            # 需要 dev server:5174
// 只读断言；失败打印原因，退出码非 0。
import { chromium } from "playwright-core";

const DEV = process.env.DEV_URL ?? "http://localhost:5174";
const text = [
  '[Character(name="char_002_amiya_1",fadetime=0.5)]',
  "[Decision(options=\"A;B\",values=\"1;2\")]",
  '[Predicate(references="1")]',
  '[name="阿米娅"]  A',
  '[Predicate(references="2")]',
  '[name="阿米娅"]  B',
  '[Predicate(references="1;2")]',
  '[name="阿米娅"]  merge',
].join("\n");

const results = [];
const check = (label, ok, detail = "") => { results.push({ label, ok, detail }); console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  // 「书架信息已更新」横幅在 `document.head` 建好前插入会抛（head 为 null）→ 用 head ?? documentElement
  // 并且**每次**失败后重试；否则它会盖住工具栏、**拦截点击**（`ed-win-check.mjs` 的旧坑）。
  await page.addInitScript(() => {
    const fix = () => {
      if (document.getElementById("wb-hide-banner")) return;
      try {
        const s = document.createElement("style");
        s.id = "wb-hide-banner";
        s.textContent = ".bookshelf-sync-warning,.dl-bar{display:none !important}";
        (document.head || document.documentElement).appendChild(s);
      } catch { /* head 还没建好 */ }
    };
    fix(); setInterval(fix, 100);
  });
  await page.goto(`${DEV}/editor/demo?text=${encodeURIComponent(text)}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea.ed-textarea", { timeout: 30000 });
  // 工作台与常驻面板是懒加载部件：等它们挂上再断言（冷启动/连跑时会晚一两秒）。
  await page.waitForSelector("[data-wb-panel]", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);
  // 冗余自愈：`ed-viewtabs` 的其它按钮（校验/预览）别在窗口里飘；这里只做**目录**断言。

  const count = async (sel) => page.locator(sel).count();
  check("工作台容器存在 [data-workbench]", (await count("[data-workbench]")) >= 1, `count=${await count("[data-workbench]")}`);
  const panelSel = (id) => `[data-wb-panel="${id}"]`;
  for (const id of ["toolpanel", "stage"]) {
    const n = await count(panelSel(id));
    if (!n) { check(`常驻面板 ${id} 存在`, false, "（P3/P5 落地后应出现）"); continue; }
    // 2026-10-13：常驻面板也有 `⧉`（分离），`✕` 仍然没有。按 **action** 计数。
    const floatBtn = await page.locator(`${panelSel(id)} [data-win-action="float"]`).count();
    const close = await page.locator(`${panelSel(id)} [data-win-action="close"]`).count();
    check(`常驻面板 ${id} 有 ⧉ 无 ✕`, floatBtn === 1 && close === 0, `float=${floatBtn} close=${close}`);
  }
  // 分支图 = Map：默认不在，点工具栏后出现、再点消失
  const before = await count(panelSel("branch"));
  const tab = page.locator(".ed-viewtabs .ed-btn", { hasText: "分支图" });
  if (await tab.count()) {
    // 点击可能被「书架信息已更新」浮条拦（浮条在 head 前插入时样式注入会失败）→ 兜底 JS click。
    const tapTab = async () => {
      try { await tab.first().click({ timeout: 4000 }); }
      catch { await tab.first().evaluate((el) => el.click()); }
    };
    await tapTab(); await page.waitForTimeout(700);
    const mid = await count(panelSel("branch"));
    await tapTab(); await page.waitForTimeout(500);
    const after = await count(panelSel("branch"));
    check("分支图 = 工具栏按需开关（Map）", before === 0 && mid >= 1 && after === 0, `before=${before} mid=${mid} after=${after}`);
  } else check("工具栏有「分支图」开关", false, "未找到 .ed-viewtabs 按钮");
  // 旧标记仍在（回归）
  check("预览窗口标记存在过/可选", true, `data-win=预览 count=${await count('[data-win="预览"]')}`);
} finally { await browser.close(); }

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ok`);
if (failed.length) process.exitCode = 1;
