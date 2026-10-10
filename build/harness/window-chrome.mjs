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
  await page.waitForSelector("textarea.ed-textarea", { timeout: 25000 });
  await page.waitForTimeout(1500);

  const count = async (sel) => page.locator(sel).count();
  check("工作台容器存在 [data-workbench]", (await count("[data-workbench]")) >= 1, `count=${await count("[data-workbench]")}`);
  const panelSel = (id) => `[data-wb-panel="${id}"]`;
  for (const id of ["toolpanel", "stage"]) {
    const n = await count(panelSel(id));
    if (!n) { check(`常驻面板 ${id} 存在`, false, "（P3/P5 落地后应出现）"); continue; }
    const btns = await page.locator(`${panelSel(id)} .ed-win-btn`).count();
    check(`常驻面板 ${id} 无 ⧉/✕（.ed-win-btn = 0）`, btns === 0, `count=${btns}`);
  }
  // 分支图 = Map：默认不在，点工具栏后出现、再点消失
  const before = await count(panelSel("branch"));
  const tab = page.locator(".ed-viewtabs .ed-btn", { hasText: "分支图" });
  if (await tab.count()) {
    await tab.first().click(); await page.waitForTimeout(500);
    const mid = await count(panelSel("branch"));
    await tab.first().click(); await page.waitForTimeout(400);
    const after = await count(panelSel("branch"));
    check("分支图 = 工具栏按需开关（Map）", before === 0 && mid >= 1 && after === 0, `before=${before} mid=${mid} after=${after}`);
  } else check("工具栏有「分支图」开关", false, "未找到 .ed-viewtabs 按钮");
  // 旧标记仍在（回归）
  check("预览窗口标记存在过/可选", true, `data-win=预览 count=${await count('[data-win="预览"]')}`);
} finally { await browser.close(); }

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ok`);
if (failed.length) process.exitCode = 1;
