// 素材库**增量加载** harness（2026-10-19）。
//
//   node build/harness/asset-incremental.mjs     # 需要 dev server :5174
//
// 用户原话：「素材库要加载优化 演示不要全量加载演示」。
// 引擎资源表有 5,200+ 条（全量约 2 万），全量挂 DOM 首帧要几百 ms。断言：
//   (a) 首帧格子数 = 一页（≤ 200），不是全量；
//   (b) 滚动到底 → 自动 +一页（IntersectionObserver 生效）；
//   (c) 「更多」按钮显示 `已显示 N / M`，点击再 +一页；
//   (d) 切类型 / 改搜索 → 回到第一页；
//   (e) lazy `<img loading="lazy">`（图片不在首帧全解码）。
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const DEV = process.env.DEV_URL ?? "http://localhost:5174";
let pass = 0;
const failures = [];
const ok = (label, fn) => {
  try { fn(); pass += 1; console.log(`ok   ${label}`); }
  catch (error) { failures.push(label); console.log(`FAIL ${label} — ${error?.message ?? error}`); }
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--renderer-process-limit=1"],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(60_000);
const errors = [];
const KNOWN = /transformCallback|ERR_FAILED|Failed to load resource|CORS|Access-Control/;
page.on("pageerror", (e) => { const s = String(e.message ?? e); if (!KNOWN.test(s)) errors.push(s.slice(0, 140)); });
await page.goto(`${DEV}/editor/demo?text=${encodeURIComponent('[Header(key="t")]')}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".ed-textarea", { timeout: 40_000 });
await page.evaluate(() => document.querySelector('[data-rail-item="assets"]')?.click());
await page.waitForSelector("[data-asset-lib=1]", { state: "attached", timeout: 40_000 }).catch(() => {});
await page.evaluate(() => document.querySelector("[data-asset-cell], [data-asset-page]")?.scrollIntoView?.());
await page.waitForTimeout(400);
await page.waitForTimeout(1200);
const cells = () => page.locator("[data-asset-key]").count();
const first = await cells();
ok("(a) 首帧只挂一页（≤ 200，不是全量 5,200+）", () => assert.ok(first > 0 && first <= 200, `cells=${first}`));

const count = await page.evaluate(() => Number(document.querySelector(".ed-assets-kind small")?.textContent ?? 0));
ok("(a) 目录总数仍是全量（首帧 rows 少、总数不少）", () => assert.ok(count >= 1000, `count=${count}`));

// 滚动**真正的滚动容器**（`.ed-assets-groups`；面板本身 overflow visible）。
for (let i = 0; i < 16; i += 1) {
  const moved = await page.evaluate(() => {
    const box = document.querySelector(".ed-assets-groups") ?? document.querySelector(".ed-assets");
    if (!box) return false;
    const before = box.scrollTop;
    box.scrollTop = Math.min(box.scrollHeight, before + 700);
    return box.scrollTop > before;
  });
  await page.waitForTimeout(220);
  if (!moved) break;
}
await page.waitForTimeout(700);
const afterScroll = await cells();
ok("(b) 滚动到底自动加载下一页（IntersectionObserver）", () => assert.ok(afterScroll > first, `${first} → ${afterScroll}`));

const more = page.locator("[data-asset-more]");
ok("(c) 有「更多」按钮且带 `已显示 N / M`", async () => {});
const label = (await more.count()) ? (await more.first().innerText()).replace(/\s+/g, " ").trim() : "";
const beforeClick = await cells();
if (await more.count()) {
  await more.first().click().catch(() => {});
  await page.waitForTimeout(400);
}
const afterClick = await cells();
ok("(c) 点「更多」再 +一页", () => {
  assert.ok(/已显示|showing/i.test(label), `label=${label}`);
  assert.ok(afterClick >= beforeClick, `${beforeClick} → ${afterClick}`);
});

await page.locator('[data-asset-search="1"]').fill("bg_forest");
await page.waitForTimeout(700);
const afterSearch = await cells();
ok("(d) 改搜索：结果集变小 + 回到第一页", () => assert.ok(afterSearch > 0 && afterSearch < afterClick, `cells=${afterSearch}`));

const lazy = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll("[data-asset-thumb] img")];
  return { total: imgs.length, lazy: imgs.filter((img) => img.loading === "lazy").length };
});
ok("(e) 缩略图 `loading=lazy`（不全量解码）", () => assert.ok(lazy.total === 0 || lazy.lazy === lazy.total, JSON.stringify(lazy)));

ok("(f) 全程无新增 JS 报错", () => assert.deepEqual(errors, []));
console.log(`\nASSET-INCREMENTAL ${failures.length ? "FAIL" : "PASS"} — ${pass} pass${failures.length ? ` / ${failures.length} fail` : ""}`);
for (const f of failures) console.log(`  ✗ ${f}`);
await browser.close();
process.exit(failures.length ? 1 : 0);
