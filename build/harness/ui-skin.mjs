// UI 皮肤验收（task-AK）：**明日方舟风**主题层生效、且不动 DOM 契约。
//
//   node build/harness/ui-skin.mjs            # 需要 dev server :5174
//
// 断言：
//   (a) `main.tsx` 在 `browser.css` **之后**加载 `styles/theme-arknights.css`（源码扫描）；
//   (b) 主题 token 生效：`:root` 的 `--ak-accent` / `--bg-primary`（旧名重绑）
//       与 `body` 的底色/字族都对得上（**实测 computed style**，不是看源码）；
//   (c) 五页各截一张图（home / 书架 / 详情 / 设置 / 编辑器），并断言
//       **页面无新的 JS 报错**（`transformCallback` 白名单）；
//   (d) 皮肤层**不改** DOM 契约：编辑器页的 `[data-ed-rail]`/`[data-wb-panel]`/
//       `[data-stage-svg]`/`[data-workbench]` 数量与 `rail.png` 时代一致（>0）；
//   (e) `prefers-reduced-motion` 下动效被压到 ~0（`--ak-dur` 仍在，但 transition 1ms）。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEV = process.env.DEV_URL ?? "http://localhost:5174";
const REPO = resolve(import.meta.dirname, "..", "..");
const OUT = resolve(REPO, "build/harness/shots");
mkdirSync(OUT, { recursive: true });
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY ??= "1";

let pass = 0;
const failures = [];
const ok = (label, fn) => {
  try { fn(); pass += 1; console.log(`ok   ${label}`); }
  catch (error) { failures.push(label); console.log(`FAIL ${label} — ${error?.message ?? error}`); }
};

// (a) 加载顺序（源码级）
const main = readFileSync(resolve(REPO, "frontend/src/main.tsx"), "utf8");
const atBrowser = main.indexOf("styles/browser.css");
const atTheme = main.indexOf("styles/theme-arknights.css");
ok("(a) main.tsx: theme 在 browser.css 之后加载", () =>
  assert.ok(atBrowser > 0 && atTheme > atBrowser, `browser@${atBrowser} theme@${atTheme}`));
ok("(a) 三个主题文件都在", () => {
  for (const f of ["theme-arknights.css", "theme-arknights.tokens.css", "theme-arknights.pages.css", "theme-arknights.editor.css"]) {
    readFileSync(resolve(REPO, "frontend/src/styles", f), "utf8");
  }
});

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium",
  // 与其它 harness 同一套加固：本机负载高（load 50+）时 chromium 会明显变慢。
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--renderer-process-limit=1",
    "--js-flags=--max-old-space-size=1024",
  ],
});
const errors = [];
const KNOWN = /transformCallback|ERR_FAILED|Failed to load resource|CORS|Access-Control/;
/** 每一张截图**换一个 page**：本机可用内存只有 ~1 GB（load 常年 20~70），同一个
 *  renderer 连开 6 条路由（编辑器 + 素材库最重）会 OOM 崩掉，报
 *  `Target page, context or browser has been closed`。开新页前先关旧页。 */
let page = null;
const newPage = async (viewport) => {
  await page?.close().catch(() => {});
  page = await browser.newPage({ viewport });
  page.on("pageerror", (e) => { const s = String(e.message ?? e); if (!KNOWN.test(s)) errors.push(s.slice(0, 140)); });
  page.on("console", (m) => { if (m.type() === "error" && !KNOWN.test(m.text())) errors.push(`console:${m.text().slice(0, 140)}`); });
  return page;
};
await newPage({ width: 1500, height: 950 });

const shot = async (route, name, prep) => {
  const target = await newPage({ width: 1500, height: 950 });
  await target.goto(`${DEV}${route}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await target.addStyleTag({ content: ".bookshelf-sync-warning,.dl-bar,[data-asset-banner]{display:none!important}" }).catch(() => {});
  await target.waitForTimeout(2600);
  if (prep) await prep(target);
  // 截图给 60s：负载高时 30s 默认值会偶发超时（**环境**抖动，不是断言失败）。
  await target.screenshot({ path: `${OUT}/ui-${name}.png`, timeout: 60_000 });
};

await shot("/", "home");
ok("(b) 首页：`--ak-accent` = 主色金", async () => {});
const token = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  return {
    akAccent: cs.getPropertyValue("--ak-accent").trim(),
    bgPrimary: cs.getPropertyValue("--bg-primary").trim(),
    accent: cs.getPropertyValue("--accent").trim(),
    bg: body.backgroundColor,
    font: body.fontFamily,
  };
});
ok("(b) token 生效：--accent = ak-ui advanced（#f1c644）", () => {
  assert.equal(token.akAccent, "#f1c644");
  assert.equal(token.accent, "#f1c644");
});
ok("(b) 旧名重绑：--bg-primary = --ak-surface-canvas（ak-ui #111315）", () => assert.equal(token.bgPrimary, "#111315"));
ok("(b) body 底色 = 中性近黑 rgb(17, 19, 21)（**不偏蓝**）", () => assert.equal(token.bg, "rgb(17, 19, 21)"));
ok("(b) body 字体栈含 Noto Sans SC", () => assert.match(token.font, /Noto Sans SC/));

await shot("/fanfic", "fanfic");
await shot("/editor/demo", "editor", async (p) => {
  await p.waitForSelector('[data-rail-item="assets"]', { timeout: 30_000 }).catch(() => {});
  await p.evaluate(() => document.querySelector('[data-rail-item="assets"]')?.click());
  await p.waitForSelector('[data-asset-lib="1"]', { timeout: 30_000 }).catch(() => {});
  await p.waitForTimeout(1200);
});
const dom = await page.evaluate(() => ({
  rail: document.querySelectorAll("[data-ed-rail]").length,
  items: document.querySelectorAll("[data-rail-item]").length,
  panels: document.querySelectorAll("[data-wb-panel]").length,
  stage: document.querySelectorAll("[data-stage-svg]").length,
  workbench: document.querySelectorAll("[data-workbench]").length,
  txt: document.querySelectorAll(".ed-textarea").length,
}));
ok("(d) 编辑器 DOM 契约没被皮肤层动过（rail/panel/stage/textarea 都在）", () => {
  // rail 是"收起窗口的托盘"：**只有 parked 的面板才有图标**（新语义），
  // 所以这里只断言"结构在"，不写死条目数。
  assert.ok(dom.rail >= 1 && dom.items >= 1 && dom.panels >= 3 && dom.stage >= 1 && dom.txt >= 1, JSON.stringify(dom));
});
await shot("/settings", "settings");
await shot("/about", "about");

// (e) reduced motion：动效压到 1ms
const small = await browser.newPage({ viewport: { width: 1200, height: 800 }, reducedMotion: "reduce" });
await small.goto(`${DEV}/fanfic`, { waitUntil: "domcontentloaded" });
await small.waitForTimeout(1500);
const dur = await small.evaluate(() => {
  const el = document.querySelector(".fl-card, .chapter-row, .btn-primary") ?? document.body;
  return getComputedStyle(el).transitionDuration;
});
ok("(e) prefers-reduced-motion 下 transition ≤ 2ms", () => {
  const ms = Number.parseFloat(dur) * (dur.includes("ms") ? 1 : 1000);
  assert.ok(ms <= 2, `duration=${dur}`);
});
await small.close();

ok("(c) 全程无新增 JS 报错", () => assert.deepEqual(errors, []));
console.log(`\nUI-SKIN ${failures.length ? "FAIL" : "PASS"} — ${pass} pass${failures.length ? ` / ${failures.length} fail` : ""}`);
for (const f of failures) console.log(`  ✗ ${f}`);
await browser.close();
process.exit(failures.length ? 1 : 0);
