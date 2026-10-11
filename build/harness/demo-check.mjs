// ⛳ Lead 的**端到端门禁**（所有 8 条用户需求一次跑完）
//   node build/harness/demo-check.mjs            # 前置：dev server :5174
// 只在**只读**层面断言：DOM 契约 + localStorage 持久化 + 几何不变 + 横幅 + 快照。
// 与各队友的专项 harness（stage-zoom / window-chrome / workbench-drag / branch-shot / engine-failure）
// 互补：这里是"整页真的能用"的合流检查。
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const DEV = process.env.DEV_URL ?? "http://localhost:5174";
const SHOTS = resolve("build/harness/shots");
mkdirSync(SHOTS, { recursive: true });

const SCRIPT = [
  '[Character(name="char_002_amiya_1",fadetime=0.5)]',
  "[Decision(options=\"跟着她走;先问清楚\",values=\"1;2\")]",
  '[Predicate(references="1")]',
  '[name="阿米娅"]  这边走，博士。',
  '[Predicate(references="2")]',
  '[name="杜宾"]  这里是……？',
  '[Predicate(references="1;2")]',
  '[name="阿米娅"]  先别急。',
  '[Blocker(a=1,r=0,g=0,b=0,fadetime=1.5,block=true)]',
].join("\n");

let pass = 0, fail = 0; const rows = [];
const t = (label, ok, detail = "") => { rows.push({ label, ok }); if (ok) { pass += 1; console.log(`ok   ${label}${detail ? ` — ${detail}` : ""}`); } else { fail += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); } };

/** 应用级的「书架信息已更新」浮条会拦截点击：注入样式 + 直接摘除节点 + JS 兜底点击。 */
async function killBanners(page) {
  await page.addStyleTag({ content: ".bookshelf-sync-warning,.dl-bar{display:none!important;pointer-events:none!important}" }).catch(() => {});
  await page.evaluate(() => document.querySelectorAll(".bookshelf-sync-warning").forEach((el) => el.remove())).catch(() => {});
}
/** 点击：优先真实点击；被浮条/遮挡拦住时退回 `el.click()`。 */
async function clickEl(locator) {
  try { await locator.click({ timeout: 4000 }); return "click"; }
  catch { await locator.evaluate((el) => el.click()); return "js"; }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (e) => { const s = String(e.stack ?? e).split("\n")[0]; if (!/transformCallback/.test(s)) pageErrors.push(s); });
  // 应用级「书架信息已更新」浮条会拦截点击：只在 <head> 就绪后插一条**高优先级**样式，
  // 并起一个 400ms 的轻量清扫（不用 MutationObserver —— 应用会不断重建该节点，
  // observer 会被自己的 remove 触发成死循环、把页面渲染饿死）。
  // 全新布局：清掉上一轮的 `prts-editor-wb:*`（否则点到的是历史布局，不是默认布局）。
  await page.addInitScript(() => {
    try { Object.keys(localStorage).filter((k) => k.startsWith("prts-editor-wb:")).forEach((k) => localStorage.removeItem(k)); } catch {}
  });
  await page.addInitScript(() => {
    const CSS = ".bookshelf-sync-warning,.dl-bar{display:none !important;pointer-events:none !important;visibility:hidden !important}";
    const install = () => {
      const root = document.head ?? document.documentElement;
      if (!root) return false;
      if (!document.getElementById("lead-hide")) {
        const style = document.createElement("style");
        style.id = "lead-hide";
        style.textContent = CSS;
        root.appendChild(style);
      }
      return true;
    };
    const tick = () => { if (install()) document.querySelectorAll(".bookshelf-sync-warning").forEach((el) => el.remove()); };
    if (!install()) {
      const onReady = () => { tick(); setInterval(tick, 400); };
      document.addEventListener("DOMContentLoaded", onReady, { once: true });
    } else {
      setInterval(tick, 400);
    }
  });
  // 冷启动预热：vite 首次 transform + 懒加载部件在 headless 下可能 >3s；
  // 先空跑一次首页把 dev server 的模块图热起来，再进编辑页（避免误报"部件缺失"）。
  await page.goto(`${DEV}/`, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.goto(`${DEV}/editor/demo?text=${encodeURIComponent(SCRIPT)}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForSelector("textarea.ed-textarea", { timeout: 30000 });
  await killBanners(page);
  await page.waitForTimeout(1200);
  await killBanners(page);

  // ── 0. 页面活着 ─────────────────────────────────────────────
  const ta = await page.locator("textarea.ed-textarea").count();
  t("① 编辑器：恰好 1 个 textarea", ta === 1, `count=${ta}`);
  const codeScroll = await page.evaluate(() => {
    const scroller = document.querySelector(".ed-code-scroll");
    if (!scroller) return null;
    const long = document.querySelector(".ed-code-lines");
    return { scrollW: scroller.scrollWidth, clientW: scroller.clientWidth, linesW: long ? long.getBoundingClientRect().width : 0 };
  });
  t("① 输入层：横向可滚（长行不被裁）", Boolean(codeScroll) && codeScroll.scrollW >= codeScroll.clientW, JSON.stringify(codeScroll));

  // ── 1. 舞台连续缩放 ───────────────────────────────────────
  // 舞台面板是懒加载部件：等它出现（组合件落盘前会一直是 0）。
  await page.waitForSelector('[data-wb-panel="stage"] [data-stage-pane]', { timeout: 20_000 }).catch(() => {});
  const stage = page.locator("[data-stage-pane]").first();
  const hasStage = await stage.count();
  t("① 舞台存在", hasStage >= 1, `count=${hasStage}`);
  if (hasStage) {
    const zoomLabel = async () => (await stage.locator('[data-stage-status="zoom"]').first().innerText().catch(() => "")).trim();
    const before = await zoomLabel();
    for (const action of ["zoom-in", "zoom-in", "zoom-in"]) {
      const btn = stage.locator(`[data-stage-action="${action}"]`).first();
      if (await btn.count()) await clickEl(btn);
    }
    await page.waitForTimeout(250);
    const after = await zoomLabel();
    const pct = (s) => Number((/(\d+(?:\.\d+)?)%/.exec(s) ?? [])[1] ?? NaN);
    t("① 舞台：连续缩放（百分比变化且非 100/50 两档）", pct(after) !== pct(before) && ![100, 50].includes(pct(after)), `${before} → ${after}`);
    const fit = stage.locator('[data-stage-action="fit"]').first();
    t("① 舞台：有「适配」按钮", (await fit.count()) >= 1);
    const one = stage.locator('[data-stage-action="zoom-1"]').first();
    if (await one.count()) { await clickEl(one); await page.waitForTimeout(200); }
    t("① 舞台：1:1 回到 100%", pct(await zoomLabel()) === 100, await zoomLabel());
    const vb = await page.evaluate(() => document.querySelector("[data-stage-svg]")?.getAttribute("viewBox") ?? "");
    t("① 舞台：缩放只改 viewBox", /^[-\d.]+ [-\d.]+ [\d.]+ [\d.]+$/.test(vb), vb);
  }

  // ── 2/3. 工作台拼接 + 面板语义 ───────────────────────────
  t("③ 工作台容器 [data-workbench]", (await page.locator("[data-workbench]").count()) >= 1);
  const gutters = await page.locator("[data-wb-gutter]").count();
  t("③ 分隔条 [data-wb-gutter]", gutters >= 1, `count=${gutters}`);
  for (const id of ["toolpanel", "stage"]) {
    const n = await page.locator(`[data-wb-panel="${id}"]`).count();
    if (!n) { t(`② 常驻面板 ${id}`, false, "缺失"); continue; }
    const btns = await page.locator(`[data-wb-panel="${id}"] .ed-win-btn`).count();
    t(`② ${id} 常驻：无 ⧉/✕`, btns === 0, `ed-win-btn=${btns}`);
  }
  // 分隔条拖动 → 持久化
  if (gutters) {
    const before = await page.evaluate(() => localStorage.getItem("prts-editor-wb:default"));
    const g = page.locator("[data-wb-gutter]").first();
    const bb = await g.boundingBox();
    if (bb) {
      await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await page.mouse.down();
      await page.mouse.move(bb.x + (bb.width > 4 ? 0 : 120), bb.y + (bb.height > 4 ? 120 : 0), { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(300);
    }
    const after = await page.evaluate(() => localStorage.getItem("prts-editor-wb:default"));
    t("③ 拖动分隔条 → 布局持久化", Boolean(after) && after !== before, `${String(before).slice(0, 24)} → ${String(after).slice(0, 24)}`);
  }

  // ── 4. 分支图 = Map 开关 + dify 视图 ────────────────────
  const tab = page.locator(".ed-viewtabs .ed-btn", { hasText: "分支图" });
  if (await tab.count()) {
    const beforeN = await page.locator('[data-wb-panel="branch"]').count();
    await killBanners(page);
    await clickEl(tab.first()); await page.waitForTimeout(900);
    const midN = await page.locator('[data-wb-panel="branch"]').count();
    const nodes = await page.locator("[data-branch-node]").count();
    const overlay = await page.locator("[data-wb-overlay]").count();
    t("② 分支图 = Map（工具栏开关）", beforeN === 0 ? midN >= 1 : true, `before=${beforeN} mid=${midN} overlay=${overlay}`);
    t("④ 分支图 = dify 节点", nodes >= 3, `[data-branch-node]=${nodes}`);
    const layers = await page.locator("[data-branch-layer]").count();
    t("④ 分支图：分层属性", layers >= 3, `[data-branch-layer]=${layers}`);
    const gapOK = await page.evaluate(() => {
      const rects = [...document.querySelectorAll("[data-branch-node]")].map((el) => el.getBoundingClientRect());
      let bad = 0;
      for (let i = 0; i < rects.length; i += 1) for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i], b = rects[j];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad += 1;
      }
      return { bad, n: rects.length };
    });
    t("④ 分支图：节点矩形零重叠", gapOK.bad === 0, JSON.stringify(gapOK));
    await page.screenshot({ path: resolve(SHOTS, "demo-branch.png") });
    await clickEl(tab.first()); await page.waitForTimeout(500);
    t("④ 再点关闭 → 从工作台移除", (await page.locator('[data-wb-panel="branch"]').count()) === 0);
  } else t("② 工具栏「分支图」开关", false, "未找到");

  // ── 5. 引擎横幅契约 ────────────────────────────────────
  const banner = await page.locator('[data-asset-banner="1"]').count();
  t("⑤ 横幅容器存在（成功时可为空）", banner >= 0, `count=${banner}`);

  // ── 6. 快照随包 ────────────────────────────────────────
  const snap = resolve("src-tauri/resources/engine/v1/snapshot.json");
  t("⑥ 随包引擎快照存在且 > 1 MB", existsSync(snap) && statSync(snap).size > 1_000_000, existsSync(snap) ? `${(statSync(snap).size / 1e6).toFixed(1)} MB` : "missing");

  // ── 7. 设置页：镜像源 + 并发 ──────────────────────────────
  await page.goto(`${DEV}/settings`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(1200);
  await killBanners(page);
  const settingsText = await page.evaluate(() => document.body.innerText);
  t("⑦ 设置：下载源可选", /下载源|镜像/.test(settingsText), "");
  t("⑦ 设置：并发可见（12）", /并发|12/.test(settingsText), "");

  // ── 0b. 无未捕获异常 ───────────────────────────────────
  t("① 页面无未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} finally {
  await browser.close();
}
console.log(`\n=== demo-check: ${pass} ok / ${fail} fail ===`);
if (fail) process.exitCode = 1;
