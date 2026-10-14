// Lead 的观感快照：编辑器工作台（默认）、分支图、舞台缩放、设置-下载源。
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
const DEV = process.env.DEV_URL ?? "http://localhost:5174";
const OUT = resolve("build/harness/shots"); mkdirSync(OUT, { recursive: true });
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
const b = await chromium.launch({ executablePath: "/snap/bin/chromium", args: ["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 1680, height: 1000 } });
await p.addInitScript(() => { const css = () => { const r = document.head; if (!r) return; const s = document.getElementById("s") || Object.assign(document.createElement("style"), { id: "s" }); s.textContent = ".bookshelf-sync-warning,.dl-bar{display:none!important}"; r.appendChild(s); }; css(); setTimeout(css, 300); setTimeout(css, 1500); });
await p.goto(`${DEV}/editor/demo?text=${encodeURIComponent(SCRIPT)}`, { waitUntil: "domcontentloaded", timeout: 90000 });
await p.waitForSelector("textarea.ed-textarea", { timeout: 40000 });
await p.waitForTimeout(2500);
await p.screenshot({ path: resolve(OUT, "lead-workbench.png") });
// 分支图
const tab = p.locator(".ed-viewtabs .ed-btn", { hasText: "分支图" });
await tab.first().evaluate((el) => el.click());
await p.waitForTimeout(1500);
await p.screenshot({ path: resolve(OUT, "lead-workbench-branch.png") });
// 舞台放大
const stage = p.locator("[data-stage-pane]").first();
for (let i = 0; i < 4; i += 1) { const btn = stage.locator('[data-stage-action="zoom-in"]').first(); if (await btn.count()) await btn.evaluate((el) => el.click()); }
await p.waitForTimeout(400);
await stage.screenshot({ path: resolve(OUT, "lead-stage-zoom.png") }).catch(() => {});
// 设置
await p.goto(`${DEV}/settings`, { waitUntil: "domcontentloaded", timeout: 90000 });
await p.waitForTimeout(1800);
await p.screenshot({ path: resolve(OUT, "lead-settings.png"), fullPage: false });
await b.close();
console.log("shots written");
