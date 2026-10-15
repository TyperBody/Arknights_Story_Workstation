// 素材库验收（task-9）。
//
//   node build/harness/_asset-lib-check.mjs
//
// 前置：dev server（`npx vite frontend --port 5174 --strictPort`）；**纯 Vite、无 Tauri**。
// 断言：
//   (a) rail 放出 `assets` 面板 → `[data-asset-lib="1"]` 出现（懒加载部件真的挂上）；
//   (b) 搜索过滤后 `[data-asset-key]` 数量下降且 ≥1；清空后恢复；
//   (c) 拖 `[data-asset-key="bg_black"]` 到 `[data-stage-svg="1"]` → 舞台背景 key 变
//       `bg_black`（或正文里出现该 key）；
//   (d) 拖到正文 textarea → 正文插入 key，且 `Ctrl+Z` 能撤（**走撤销栈**）；
//   (e) 音频条目的 `[data-asset-audio]` 有非空 `src`；
//   (f) 格子数 ≥ 50（引擎表就绪）；
//   (g) 无 Tauri：`[data-asset-import]` disabled + title 提示桌面版；
//   (h) 零新增 JS 报错（`transformCallback` 白名单）。
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DEV = process.env.DEV_URL ?? "http://localhost:5174";
const REPO = resolve(import.meta.dirname, "..", "..");
const OUT = resolve(REPO, "build/harness/shots");
mkdirSync(OUT, { recursive: true });
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY ??= "1";

let pass = 0;
const failures = [];
const ok = (label, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`ok   ${label}`);
  } catch (error) {
    failures.push(label);
    console.log(`FAIL ${label} — ${error?.message ?? error}`);
  }
};

/** 脚本：用得上的素材 key 全在（背景 / 立绘 / BGM），便于断言"当前场景"。 */
const SCRIPT = [
  '[HEADER(key="harness_assets", fit_mode="BLACK_MASK")]',
  '[Background(image="bg_room_2", fadetime=0.5, block=true)]',
  '[charslot(slot="m", name="char_002_amiya_1", duration=0.5)]',
  // `$变量` = 引擎的音频惯例（`story_variables.json` → `Sound_Beta_2/...`），
  // 只有这种 key 才算得出**可试听**的直链（裸 `m_calm` 判不出路径）。
  '[PlayMusic(key="$calm_loop", volume=1)]',
  '[name="阿米娅"]  这边走。',
  '[endtip(block=true)]',
].join("\n");

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium",
  // 素材库面板要渲染 5000+ 缩略图：同机连跑时 GPU/zygote 竞争会把页面在
  // 后半段（`Ctrl+Z` 那一步）拖死或直接关掉。这里和 `float-window.mjs` 用同一套
  // 稳健参数（关 GPU、限渲染进程、压堆）。
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--renderer-process-limit=1",
    "--js-flags=--max-old-space-size=768",
  ],
});
const page = await browser.newPage({ viewport: { width: 1700, height: 1050 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack ?? e).split("\n")[0]));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console:${m.text().slice(0, 160)}`);
});
// 外部请求（prts / jsdelivr）与本次断言无关：abort（无网时不拖超时）——
// 被 abort 的图片/音频会在 console 里留 `net::ERR_FAILED`，属**预期噪音**（见 (h)）。
await page.route("**/*", (route) => {
  const url = route.request().url();
  if (url.startsWith(DEV) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
  return route.abort();
});

const value = () => page.locator(".ed-textarea").inputValue();
/** HTML5 拖拽：合成 `dragstart → dragover → drop`（CDP 鼠标拖拽不触发 dataTransfer）。 */
const dragKeyTo = (key, selector) =>
  page.evaluate(
    ([assetKey, targetSelector]) => {
      const source = document.querySelector(`[data-asset-key="${CSS.escape(assetKey)}"]`);
      const target = document.querySelector(targetSelector);
      if (!source || !target) return { ok: false, source: !!source, target: !!target };
      const transfer = new DataTransfer();
      transfer.setData("text/plain", assetKey);
      transfer.setData("application/x-arkstage-asset", JSON.stringify({ kind: "background", key: assetKey }));
      const fire = (node, type) =>
        node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
      fire(source, "dragstart");
      fire(target, "dragover");
      fire(target, "drop");
      fire(source, "dragend");
      return { ok: true };
    },
    [key, selector]
  );

await page.goto(`${DEV}/editor/demo?text=${encodeURIComponent(SCRIPT)}&_t=${Date.now()}`, {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
await page.waitForSelector(".ed-textarea", { timeout: 30_000 });
await page.waitForTimeout(2200);

// ── (a) 经 rail 放出 assets 面板 ─────────────────────────────────────
const rail = await page.$$eval("[data-rail-item]", (els) => els.map((el) => el.dataset.railItem));
ok("(a) rail 里有 [data-rail-item=assets]（面板已注册）", () => assert.ok(rail.includes("assets"), rail.join(",")));
if (!(await page.locator('[data-wb-panel="assets"]').count())) {
  // rail 是懒加载部件：**先等图标挂上**再点（冷启动/首次访问时 2.2s 可能还不够，
  // 直接 evaluate 点会静默 no-op → 后面的 waitForSelector 超时）。
  // ⚠️ 只等 `attached`：rail **整条收起**时（别的 harness 会把
  // `prts-editor-rail` 留成 collapsed）条目仍在 DOM 但不可见，用 `visible` 会假超时。
  await page.waitForSelector('[data-rail-item="assets"]', { state: "attached", timeout: 30_000 });
  for (let round = 0; round < 3; round += 1) {
    if (await page.locator('[data-asset-lib="1"]').count()) break;
    await page.evaluate(() => {
      const rail = document.querySelector('[data-ed-rail="1"]');
      // 收起态：先展开整条 rail 再点（`[data-rail-toggle]`）。
      if (rail?.getAttribute("data-rail-collapsed") === "1") {
        (document.querySelector("[data-rail-toggle]"))?.click();
      }
      document.querySelector('[data-rail-item="assets"]')?.click();
    });
    await page.waitForTimeout(1500);
  }
}
await page.waitForSelector('[data-asset-lib="1"]', { timeout: 20_000 });
ok("(a) 点 rail 后 [data-asset-lib=1] 挂上", () => assert.ok(true));
const shell = await page.evaluate(() => ({
  lib: document.querySelectorAll('[data-asset-lib="1"]').length,
  search: document.querySelectorAll("[data-asset-search]").length,
  importButton: document.querySelectorAll("[data-asset-import]").length,
  preview: document.querySelectorAll("[data-asset-preview]").length,
  placeholder: document.querySelectorAll("[data-assets-placeholder]").length,
}));
ok(
  "(a) DOM 契约齐全：lib / search / import / preview = 1，且无旧占位",
  () => assert.deepEqual(shell, { lib: 1, search: 1, importButton: 1, preview: 1, placeholder: 0 }),
);

// ── (f) 表就绪：格子数 ────────────────────────────────────────────
// 引擎表是**异步**读的（内置快照 → runtime），面板先出"素材表还没就绪"占位：
// 轮询到格子出现为止（最多 25s），别用固定 sleep（同机连跑时快照读会慢一拍）。
for (let i = 0; i < 50; i += 1) {
  if ((await page.locator("[data-asset-key]").count()) >= 50) break;
  await page.waitForTimeout(500);
}
const count = await page.locator("[data-asset-key]").count();
ok("(f) 引擎表就绪：格子数 ≥ 50", () => assert.ok(count >= 50, `count=${count}`));
const thumbCount = await page.locator('[data-asset-thumb="1"]').count();
ok("(f) 每个格子一个缩略图节点（thumb 数 = 格子数）", () => assert.equal(thumbCount, count, `${thumbCount} vs ${count}`));
const kinds = await page.$$eval("[data-asset-kind]", (els) => els.map((el) => el.dataset.assetKind));
ok("(f) 类型栏 6 项（全部 + 5 类）", () =>
  assert.deepEqual(kinds, ["all", "background", "character", "music", "sound", "other"]));

await page.screenshot({ path: `${OUT}/asset-lib.png` }).catch(() => {});

// ── (b) 搜索过滤 ────────────────────────────────────────────────
await page.fill("[data-asset-search]", "bg_black");
await page.waitForTimeout(400);
const filtered = await page.locator("[data-asset-key]").count();
ok("(b) 搜索 bg_black 后格子数下降且 ≥ 1", () => assert.ok(filtered >= 1 && filtered < count, `${filtered} / ${count}`));
const filteredKeys = await page.$$eval("[data-asset-key]", (els) => els.map((el) => el.dataset.assetKey));
ok("(b) 过滤结果都含搜索词", () => assert.ok(filteredKeys.every((key) => key.includes("bg_black")), filteredKeys.slice(0, 5).join(",")));
await page.fill("[data-asset-search]", "");
await page.waitForTimeout(400);
{
  const restored = await page.locator("[data-asset-key]").count();
  ok("(b) 清空搜索后恢复全量", () => assert.ok(restored >= 50, `restored=${restored}`));
}

// ── (g) 无 Tauri：导入按钮 disabled + title ─────────────────────
const gate = await page.evaluate(() => {
  const button = document.querySelector("[data-asset-import]");
  return { desktop: "__TAURI_INTERNALS__" in window, disabled: button?.disabled ?? null, title: button?.getAttribute("title") ?? "" };
});
if (!gate.desktop) {
  ok("(g) 纯 Vite：导入按钮 disabled", () => assert.equal(gate.disabled, true));
  ok("(g) 纯 Vite：title 提示桌面版", () => assert.ok(gate.title.length > 0, `title=${gate.title}`));
} else {
  ok("(g) Tauri 内：导入按钮可用", () => assert.equal(gate.disabled, false));
}

// ── (e) 音频试听 ─────────────────────────────────────────────
await page.fill("[data-asset-search]", "$calm_loop");
await page.waitForTimeout(300);
const musicCell = page.locator("[data-asset-key]").first();
if (await musicCell.count()) {
  await musicCell.click();
  await page.waitForTimeout(300);
  const audio = await page.evaluate(() => {
    const node = document.querySelector("[data-asset-audio]");
    return node ? { src: node.getAttribute("src") ?? "", ready: true } : { src: "", ready: false };
  });
  ok("(e) 音频条目的 [data-asset-audio] 存在且 src 非空", () =>
    assert.ok(audio.ready && audio.src.length > 8, JSON.stringify(audio)));
} else {
  ok("(e) 脚本里的 BGM key 出现在列表里", () => assert.ok(false, "没找到 $calm_loop 条目"));
}
await page.fill("[data-asset-search]", "");
await page.waitForTimeout(300);

// ── (c) 拖到舞台 ────────────────────────────────────────────
const beforeBg = await page.evaluate(() => document.querySelector("[data-stage-background]")?.getAttribute("data-stage-background") ?? "");
const beforeText = await value();
const drop = await dragKeyTo("bg_forest", '[data-stage-svg="1"]');
ok("(c) 能定位到 [data-asset-key=bg_forest] 与 [data-stage-svg=1]", () => assert.equal(drop.ok, true, JSON.stringify(drop)));
await page.waitForTimeout(500);
const afterBg = await page.evaluate(() => document.querySelector("[data-stage-background]")?.getAttribute("data-stage-background") ?? "");
const afterText = await value();
ok(
  "(c) 拖到舞台 → 当前场景背景变 bg_forest（或正文写入 key）",
  () => assert.ok(afterBg.includes("bg_forest") || (afterText.includes("bg_forest") && afterText !== beforeText), `bg=${beforeBg}→${afterBg}`),
);
await page.screenshot({ path: `${OUT}/asset-lib-stage-drop.png` }).catch(() => {});

// ── (d) 拖到正文 + Ctrl+Z ────────────────────────────────
await page.evaluate(() => {
  const textarea = document.querySelector(".ed-textarea");
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  textarea.dispatchEvent(new Event("select", { bubbles: true }));
});
const beforeInsert = await value();
const toText = await dragKeyTo("bg_forest", ".ed-textarea");
ok("(d) 能定位到 textarea 作为投放目标", () => assert.equal(toText.ok, true, JSON.stringify(toText)));
await page.waitForTimeout(400);
const afterInsert = await value();
ok("(d) 拖到正文 → 正文里出现该 key", () =>
  assert.ok(afterInsert.includes("bg_forest") && afterInsert !== beforeInsert, `${beforeInsert.length}→${afterInsert.length}`));
await page.keyboard.press("Control+z");
await page.waitForTimeout(400);
const afterUndo = await value();
ok("(d) Ctrl+Z 撤销插入（走撤销栈）", () => assert.equal(afterUndo, beforeInsert));

// ── (h) 报错 ───────────────────────────────────────────
const known = /transformCallback|net::ERR_FAILED|Failed to load resource/;
const fresh = errors.filter((line) => !known.test(line));
ok("(h) 零新增 JS 报错（transformCallback + 被 abort 的外部资源白名单）", () => assert.deepEqual(fresh, [], fresh.slice(0, 3).join(" | ")));

console.log(`\nASSET-LIB ${failures.length === 0 ? "PASS" : "FAIL"} — ${pass} pass${failures.length ? ` / ${failures.length} fail` : ""}`);
if (failures.length) for (const label of failures) console.log(`  ✗ ${label}`);
await browser.close().catch(() => {});
process.exit(failures.length === 0 ? 0 : 1);
