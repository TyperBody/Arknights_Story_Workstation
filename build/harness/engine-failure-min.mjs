// P6 自带最小验收：引擎模块 500 → 单条人话横幅（含 HTTP 状态）+ 页面不白屏。
//   node build/harness/engine-failure-min.mjs        # 需要 dev server:5174
// 与 Lead 的 build/harness/engine-failure.mjs 同一断言面
// （`[data-asset-banner="1"]` + 文案含 `HTTP 500`），但不依赖 P5 的编辑器页：
// 在任意页面上直接调 bootStoryPlayer（与播放器/编辑器预览同一条代码路径）。
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const DEV = process.env.DEV_URL ?? "http://localhost:5174";
let pass = 0, fail = 0;
const t = (label, fn) => { try { fn(); pass += 1; console.log("ok   " + label); } catch (e) { fail += 1; console.log("FAIL " + label + " — " + e.message); } };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let hits = 0;
  await page.route(/StoryPlayer\.[A-Za-z0-9_-]+\.js/, async (route) => {
    hits += 1;
    if (hits <= 2) return route.fulfill({ status: 500, contentType: "application/javascript", body: "throw new Error('mock 500')" });
    return route.continue();
  });
  const consoleLines = [];
  page.on("pageerror", (e) => consoleLines.push("pageerror " + String(e).slice(0, 200)));
  await page.goto(`${DEV}/`, { waitUntil: "domcontentloaded" });
  const report = await page.evaluate(async () => {
    // 关键：必须用**应用已加载的同一实例**。dev server 会给改过的文件加 `?t=`
    // 时间戳，裸 `/src/lib/x.ts` 会是另一份模块（debugLog 的 entries/statuses
    // 不共享、React 也收不到更新）。从 performance 资源里取真实 URL。
    const realUrl = (path) => {
      const hit = performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => name.includes(path))
        .sort((a, b) => b.length - a.length)[0];
      return hit || path;
    };
    const { loadBundledEngine, markBundleSource } = await import(realUrl("/src/lib/enginePack.ts"));
    const { bootStoryPlayer } = await import(realUrl("/src/lib/storyPlayerBoot.ts"));
    const { statusEntries } = await import(realUrl("/src/lib/debugLog.ts"));
    const pack = await loadBundledEngine();
    if (!pack) return { error: "no bundled engine (browser dev 里应能从 snapshot.json 拿到)" };
    // 冒充「网络版」候选：boot 会先 probe 入口 URL（route 500）→ 单条横幅。
    markBundleSource(pack.bundle, "network");
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;left:0;top:0;width:960px;height:540px;border:0;background:#000";
    document.body.appendChild(iframe);
    let booted = null, error = null;
    try {
      booted = await bootStoryPlayer({
        iframe,
        bundle: pack.bundle,
        script: '[HEADER(key="p6", is_skippable=true)]\n[name="阿米娅"]  测试',
        title: "p6",
        mode: "play",
      });
    } catch (e) { error = String(e && e.message || e); }
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 120)));
    const doc = iframe.contentDocument;
    return {
      banners: statusEntries(),
      dataBanner: document.querySelectorAll('[data-asset-banner="1"]').length,
      bannerText: document.querySelector('[data-asset-banner="1"]')?.innerText ?? "",
      booted: Boolean(booted),
      boot: doc?.documentElement?.getAttribute("data-arkstage-boot") ?? null,
      player: Boolean(doc?.querySelector(".story-player")),
      bodyLen: doc ? (doc.body?.innerText?.length ?? 0) : 0,
      error,
    };
  });
  console.log("report:", JSON.stringify(report, null, 1).slice(0, 900));
  console.log("console:", JSON.stringify(consoleLines.slice(0, 3)), "route hits:", hits);
  t("引擎横幅出现（[data-asset-banner=1]）", () => assert.ok(report.dataBanner >= 1 && report.banners.length >= 1));
  t("横幅是人话且含 HTTP 500", () => {
    assert.match(report.bannerText, /HTTP 500/);
    assert.match(report.bannerText, /引擎模块/);
  });
  // B) 首选（网络版）**执行**失败 → 必须换 pack，横幅写「已回退到内置快照」。
  const fallbackReport = await page.evaluate(async () => {
    const realUrl = (path) => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes(path)).sort((a, b) => b.length - a.length)[0] || path;
    const dl = await import(realUrl("/src/lib/debugLog.ts"));
    const { loadBundledEngine, markBundleSource } = await import(realUrl("/src/lib/enginePack.ts"));
    const { bootStoryPlayer } = await import(realUrl("/src/lib/storyPlayerBoot.ts"));
    dl.resolveStatus("engine");
    const pack = await loadBundledEngine();
    const broken = {
      ...pack.bundle,
      story_player: { ...pack.snapshot, modules: { ...pack.snapshot.modules, [pack.snapshot.entry]: "export default 1;" } },
    };
    markBundleSource(broken, "network");
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;left:0;top:0;width:800px;height:450px";
    document.body.appendChild(iframe);
    let error = null, booted = false;
    try {
      await bootStoryPlayer({ iframe, bundle: broken, script: '[HEADER(key="p6")]\n[name="x"]  hi', title: "p6b", mode: "play" });
      booted = true;
    } catch (e) { error = String(e?.message ?? e).slice(0, 200); }
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 120)));
    return {
      error, booted,
      bannerText: document.querySelector('[data-asset-banner="1"]')?.innerText ?? "",
      boot: iframe.contentDocument?.documentElement?.getAttribute("data-arkstage-boot") ?? null,
    };
  });
  console.log("fallback scenario:", JSON.stringify(fallbackReport).slice(0, 400));
  t("坏快照 → 换 pack 且横幅写「已回退到内置快照」", () => {
    assert.equal(fallbackReport.error, null);
    assert.ok(fallbackReport.booted);
    assert.match(fallbackReport.bannerText, /已回退到内置快照（v\d+\.\d+\.\d+-[0-9a-f]{8}）/);
  });

  t("页面不白屏：boot 成功且 iframe 里有 .story-player", () => {
    assert.equal(report.error, null);
    assert.ok(report.booted);
    assert.equal(report.boot, "play");
    assert.ok(report.player, "iframe 里应有 .story-player");
  });
} finally { await browser.close(); }
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
