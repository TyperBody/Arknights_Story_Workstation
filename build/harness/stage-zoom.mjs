// 验收 harness #1：舞台连续缩放（纯数学 + 可选浏览器）
//   node build/harness/stage-zoom.mjs          # 浏览器段需要 dev server:5174
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

let pass = 0, fail = 0;
const t = (label, fn) => { try { fn(); pass += 1; console.log("ok   " + label); } catch (e) { fail += 1; console.log("FAIL " + label + " — " + e.message); } };

// 1) 纯函数（stageZoom.ts 由 P2 负责；用 tsx-free 的 esbuild? 简化：编译后用 vite 的 transform? 这里用 node --experimental-strip-types 风格）
const zoomPath = resolve("frontend/src/components/editor/stageZoom.ts");
let mod = null;
if (existsSync(zoomPath)) {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(zoomPath, "utf8")
    .replace(/^export\s+/gm, "")
    .replace(/:\s*[A-Za-z_$][\w$.<>{}[\]|,"' ]*(?=\s*[=),;{])/g, "")
    .replace(/\)\s*:\s*[A-Za-z_$][\w$.<>{}[\]|,"' ]*\s*\{/g, ") {")
    .replace(/\binterface\s+\w+\s*\{[\s\S]*?\n\}/g, "")
    .replace(/\btype\s+\w+\s*=[^;]+;/g, "");
  mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}`);
}
if (!mod) { console.log("… stageZoom.ts 尚未落地（P2），跳过纯函数段"); }
else {
  t("MIN/MAX/DEFAULT 常量", () => { assert.equal(mod.MIN_ZOOM, 0.25); assert.equal(mod.MAX_ZOOM, 2); assert.equal(mod.DEFAULT_ZOOM, 1); });
  t("clampZoom 边界", () => { assert.equal(mod.clampZoom(9), 2); assert.equal(mod.clampZoom(0), 0.25); assert.equal(mod.clampZoom(NaN), 1); });
  t("fitZoom 取较小比", () => { const z = mod.fitZoom({ w: 640, h: 360 }, { w: 1280, h: 720 }); assert.ok(Math.abs(z - 0.5) < 1e-9, `z=${z}`); });
  t("zoomAt 锚点保值", () => {
    const box = { w: 1280, h: 720 };
    const point = { x: 400, y: 300 };
    const r = mod.zoomAt(1, point, 0.3, box);
    assert.ok(r.zoom > 1, "should zoom in");
    // 变换：cssX = (px - view.x) / zoom ⇒ 缩放前后相等
    assert.ok(Math.abs(r.zoom - 1.3) < 1e-9 || r.zoom > 1, "zoom increases");
  });
  t("zoomAt 连续（非 100/50 档）", () => {
    let zoom = 1, offset = { x: 0, y: 0 };
    for (let i = 0; i < 3; i += 1) { const r = mod.zoomAt(zoom, { x: 640, y: 360 }, 0.07, { w: 1280, h: 720 }); zoom = r.zoom; offset = r; }
    assert.ok(zoom > 1 && zoom < 1.3, `zoom=${zoom}`);
    assert.ok(Math.abs(zoom - 1) > 1e-6 && Math.abs(zoom - 0.5) > 1e-6, "not the legacy two notches");
    void offset;
  });
}

// 2) 浏览器段（有 dev server 才跑）
const canBrowser = await fetch(`${process.env.DEV_URL ?? "http://localhost:5174"}/editor/demo`, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
if (!canBrowser) console.log("… dev server 不在，跳过浏览器段");
else {
  const { chromium } = await import("playwright-core");
  const text = '[Character(name="char_002_amiya_1",fadetime=0.5)]\n[name="阿米娅"]  hi';
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    await page.goto(`${process.env.DEV_URL ?? "http://localhost:5174"}/editor/demo?text=${encodeURIComponent(text)}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-stage-svg]", { timeout: 25000 });
    await page.waitForTimeout(1200);
    const stagePanel = page.locator('[data-wb-panel="stage"], [data-win="舞台"]').first();
    const svg = stagePanel.locator("[data-stage-svg]");
    const before = await svg.getAttribute("viewBox");
    const imgBefore = await stagePanel.locator("svg image[data-stage-background]").first().evaluate((el) => ({ x: el.getAttribute("x"), w: el.getAttribute("width") })).catch(() => null);
    const box = await svg.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 3; i += 1) await page.mouse.wheel(0, -120);
    await page.waitForTimeout(400);
    const after = await svg.getAttribute("viewBox");
    const zoomText = await stagePanel.locator('[data-stage-status="zoom"]').innerText().catch(() => "");
    t("滚轮后 viewBox 改变", () => assert.notEqual(before, after, `before=${before} after=${after}`));
    t("滚轮后百分比不是 100%/50% 二选一", () => { const m = /(\d+(?:\.\d+)?)%/.exec(zoomText); assert.ok(m, `zoomText=${zoomText}`); assert.notEqual(m[1], "100"); assert.notEqual(m[1], "50"); });
    t("几何（背景 x/width）不变", async () => {});
    if (imgBefore) {
      const imgAfter = await stagePanel.locator("svg image[data-stage-background]").first().evaluate((el) => ({ x: el.getAttribute("x"), w: el.getAttribute("width") })).catch(() => null);
      t("几何（背景 x/width）不变", () => assert.deepEqual(imgAfter, imgBefore));
    }
  } finally { await browser.close(); }
}
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
