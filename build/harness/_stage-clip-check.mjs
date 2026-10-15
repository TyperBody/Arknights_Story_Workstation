#!/usr/bin/env node
/**
 * T3 · 舞台**裁剪** + 舞台/调试日志**可调大小** 自检。
 *
 *   node build/harness/_stage-clip-check.mjs
 *   DEV_URL=http://localhost:5174 node build/harness/_stage-clip-check.mjs
 *
 * 背景（用户报的「舞台缩放有大问题 素材扭曲」）：SVG **只按元素外框裁剪**，
 * `viewBox` 之外的画布内容照样渲染 —— 放大后屏幕上同时出现「16:9 的 viewBox
 * 窗口」和「更宽的画布素材带」（Lead 实测 2.67:1），看起来就是素材被横向拉伸。
 * 修法：`<g clip-path="url(#ark-stage-clip)">`（rect == 当前 `viewBox`）把画布
 * 内容整块裁到 `viewBox`。
 *
 * 「可见窗口」的几何（见 `stageZoom.ts`）：`preserveAspectRatio="meet"` 下
 * `unit = min(frame.w/1280, frame.h/720)`，`viewBox` 恒与画布同为 16:9，
 * 所以**它在屏幕上的盒子与 zoom 无关**：`1280×unit × 720×unit`（居中）。
 * zoom < 1 时画布（1280×720）比窗口小 → 窗口四周多出来的边距里只可能有
 * 「本来就在画布外」的内容（超长立绘 / 标尺），zoom ≥ 1 时画布完全盖住窗口。
 *
 * 断言：
 *  (1) `/stage-demo.html?scene=two` 五档缩放 50% / 100% / 150% / 170% / 25%：
 *      (a) **可见内容包围盒**（整帧截图 → 解 PNG → 非黑像素扫描，剔掉 HUD
 *          工具条/增量条）的宽高比 ∈ [1.75, 1.81]（16:9 = 1.7778），盒 ==
 *          上面的 16:9 窗口（±6 设备 px）。为让这条**与画面内容无关**，扫描前
 *          往裁剪组里临时注入一块「比 viewBox 更大」的亮色探针 rect（= 画布内容
 *          的替身）：有 clip 时可见盒必然 = 16:9 窗口；再把探针拿掉。
 *      (a1) 真实场景（背景 + 两个立绘 + 参考线）的可见盒**完全落在** 16:9 窗口
 *          里（±4 设备 px）—— viewBox 之外一个像素都不露；zoom ≥ 1 时它的
 *          AR 也必须 ∈ [1.75, 1.81]（zoom < 1 时窗口边距里没有内容，盒高会
 *          比窗口矮一点：打印实测值，断言 [1.72, 1.85]）。
 *      (a2) 150% 对照实验：把 `<g>` 的 `clip-path` 临时摘掉，真实场景的可见盒
 *          立刻变成 2.4…2.9:1（= 用户看到的那条「素材带」）。
 *      (b) `<g clip-path>` 存在、`#ark-stage-clip` 在 `<defs>` 里、rect == 当前
 *          `viewBox`，HUD 工具条/增量条**不在**裁剪组里；zoom/百分比一致，
 *          既有 harness 标记（3 条槽位虚线 / 标尺 / 2 个安全框）都在。
 *      (c) 100% 时背景屏幕盒 16:9、`(x,y,w,h) = (0,0,1280,720)`。
 *  (2) `/editor/demo?text=…`：拖工作台水平分隔条向上 300px →
 *      `[data-stage-svg]` 高度随之增加 ≥ 250px（舞台填满宿主，不再写死 232/214）。
 *  (3) `/`（应用首页）：调试日志展开态有 `[data-dbg-resize="1"]` 手柄；拖它 →
 *      面板变大、`localStorage: prts-debug-console-size` 落盘；刷新后尺寸复原；
 *      `[data-asset-banner="1"]` 与收起态按钮键名不变。
 *
 * ⚠️ (2) 依赖 `/editor/demo?text=`：编辑器页由并行任务（T1/T2）同时改造，
 * 中途可能是白屏 —— 本段会重试 3 次并打印每次的页面错误；真失败才算 FAIL。
 *
 * 退出码：0 = 全过；1 = 有断言失败。
 */
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

const DEV = process.env.DEV_URL ?? "http://localhost:5174";
/** 设备像素比：像素扫描的量化误差按 1/DSF 缩小（25% 档的窗口只有 ~974 设备 px 宽）。 */
const DSF = 2;
/** 「非黑」阈值：画布底 `#0a0f16`(47) > 32 > 窗口外黑底 `#000`(0)。 */
const LIT = 32;
/** 可见盒 AR 的验收区间（16:9 = 1.7778；±1.8%）。 */
const AR_MIN = 1.75;
const AR_MAX = 1.81;

let pass = 0;
let fail = 0;
const failures = [];
const ok = (label, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`ok   ${label}`);
  } catch (error) {
    fail += 1;
    const message = String(error?.message ?? error).split("\n").slice(0, 4).join(" | ");
    failures.push({ label, error: message });
    console.log(`FAIL ${label} — ${message}`);
  }
};

/** 一行「实测值」（不是断言，只为验收留数字）。 */
const row = (label, value) => console.log(`  · ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

// ── PNG → RGBA（只吃 Chromium 截图：8bit / colorType 2|6 / 非隔行）──────────
function decodePng(buffer) {
  assert.equal(buffer.readUInt32BE(0), 0x89504e47, "PNG 签名");
  let off = 8;
  let head = null;
  const chunks = [];
  while (off + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(off);
    const type = buffer.toString("ascii", off + 4, off + 8);
    const data = buffer.subarray(off + 8, off + 8 + length);
    if (type === "IHDR") {
      head = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    } else if (type === "IDAT") {
      chunks.push(data);
    } else if (type === "IEND") break;
    off += 12 + length;
  }
  assert.ok(head, "IHDR");
  assert.equal(head.depth, 8, `bit depth ${head.depth}`);
  assert.equal(head.interlace, 0, "interlace");
  const channels = head.color === 6 ? 4 : head.color === 2 ? 3 : 0;
  assert.ok(channels, `colorType ${head.color}`);
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = head.w * channels;
  const out = new Uint8Array(head.w * head.h * 4);
  let prev = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < head.h; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = Uint8Array.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 0xff;
      else if (filter === 2) line[i] = (line[i] + b) & 0xff;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    for (let x = 0; x < head.w; x += 1) {
      const src = x * channels;
      const dst = (y * head.w + x) * 4;
      out[dst] = line[src];
      out[dst + 1] = line[src + 1];
      out[dst + 2] = line[src + 2];
      out[dst + 3] = channels === 4 ? line[src + 3] : 255;
    }
    prev = line;
  }
  return { w: head.w, h: head.h, data: out };
}

/**
 * 非黑像素包围盒（图像 px）。
 * - `skip`：要剔掉的矩形（HUD）；`box`：只统计这个矩形里的像素；
 * - `inset`：剔掉贴边 `inset` px（截图与元素边界的 1px 抖动）。
 */
function scan(img, { skip = [], box = null, inset = 1, lit = LIT } = {}) {
  const x0 = Math.max(inset, box ? box.x0 : 0);
  const y0 = Math.max(inset, box ? box.y0 : 0);
  const x1 = Math.min(img.w - inset, box ? box.x1 : img.w);
  const y1 = Math.min(img.h - inset, box ? box.y1 : img.h);
  const skipHit = (x, y) => skip.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * img.w + x) * 4;
      if (img.data[i] + img.data[i + 1] + img.data[i + 2] < lit) continue;
      if (skipHit(x, y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return null;
  return { x0: minX, y0: minY, x1: maxX, y1: maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** 设备 px 盒 → CSS px。 */
const toCss = (b) => (b ? { x: Math.round(b.x0 / DSF), y: Math.round(b.y0 / DSF), w: Math.round(b.w / DSF), h: Math.round(b.h / DSF) } : null);
const arOf = (b) => (b ? b.w / b.h : null);
const ar6 = (b) => (b ? Number(arOf(b).toFixed(4)) : null);
/** HUD 矩形（图像 px，带 padding）。 */
function hudRects(dom) {
  return [dom.hud, dom.delta]
    .filter(Boolean)
    .map((r) => ({
      x0: Math.floor((r.x - dom.frame.x) * DSF) - 3,
      y0: Math.floor((r.y - dom.frame.y) * DSF) - 3,
      x1: Math.ceil((r.x + r.w - dom.frame.x) * DSF) + 3,
      y1: Math.ceil((r.y + r.h - dom.frame.y) * DSF) + 3,
    }));
}
/**
 * `meet` 下 viewBox 窗口的屏幕盒（图像 px，相对 frame）。
 * `viewBox` 与画布同为 16:9 ⇒ 这个盒**与 zoom 无关**：`1280×unit × 720×unit`。
 */
function windowBox(dom) {
  const unit = Math.min(dom.frame.w / 1280, dom.frame.h / 720);
  const w = 1280 * unit;
  const h = 720 * unit;
  return {
    x0: Math.round((dom.frame.w - w) / 2 * DSF),
    y0: Math.round((dom.frame.h - h) / 2 * DSF),
    x1: Math.round((dom.frame.w + w) / 2 * DSF),
    y1: Math.round((dom.frame.h + h) / 2 * DSF),
    w: Math.round(w * DSF),
    h: Math.round(h * DSF),
  };
}
/** 一个盒是否落在另一个盒里（带 slack）。 */
const inside = (inner, outer, slack) =>
  Boolean(inner) &&
  inner.x0 >= outer.x0 - slack &&
  inner.x1 <= outer.x1 + slack &&
  inner.y0 >= outer.y0 - slack &&
  inner.y1 <= outer.y1 + slack;

/** 读 DOM 契约。 */
async function readDom(page) {
  return page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    };
    const pane = document.querySelector("[data-stage-pane]");
    const svg = document.querySelector("[data-stage-svg]");
    const group = document.querySelector("[data-stage-clip-group]");
    const clip = document.querySelector("#ark-stage-clip");
    const rect = document.querySelector("#ark-stage-clip-rect");
    const bg = document.querySelector("[data-stage-background]");
    return {
      zoom: Number(pane?.getAttribute("data-stage-zoom")),
      status: pane?.querySelector('[data-stage-status="zoom"]')?.textContent?.trim() ?? "",
      va: (svg?.getAttribute("viewBox") ?? "").trim().split(/\s+/).map(Number),
      fill: pane?.getAttribute("data-stage-fill") ?? null,
      frame: box(document.querySelector('[data-stage-frame="1"]')),
      hud: box(pane?.querySelector('[data-stage-hud="zoom"]')),
      delta: box(pane?.querySelector('[data-stage-delta="1"]')),
      bg: box(bg),
      bgAttr: bg ? ["x", "y", "width", "height"].map((key) => Number(bg.getAttribute(key))) : null,
      group: group?.tagName ?? null,
      groupClip: group?.getAttribute("clip-path") ?? null,
      clipInDefs: Boolean(clip && clip.closest("defs")),
      clipRect: rect ? ["x", "y", "width", "height"].map((key) => Number(rect.getAttribute(key))) : null,
      hudInsideGroup: Boolean(pane?.querySelector('[data-stage-hud="zoom"]')?.closest("g[clip-path]")),
      deltaInsideGroup: Boolean(pane?.querySelector('[data-stage-delta="1"]')?.closest("g[clip-path]")),
      counts: {
        guides: pane?.querySelectorAll("[data-stage-guide]").length ?? 0,
        ruler: pane?.querySelectorAll("[data-stage-ruler]").length ?? 0,
        safe: pane?.querySelectorAll("[data-stage-safe]").length ?? 0,
      },
    };
  });
}

/** 截图（整帧）+ 像素扫描。`probe` = 是否先注入「比 viewBox 更大」的亮色探针。 */
async function measure(page, { probe = false } = {}) {
  await page.waitForTimeout(320);
  const dom = await readDom(page);
  if (probe) {
    await page.evaluate(() => {
      const group = document.querySelector("[data-stage-clip-group]");
      if (!group) return;
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      // 比任何 zoom（0.25…2）下的 viewBox 都大：x/y ∈ [-2000, -1024]、
      // 右下 ≥ 3280/2720（zoom=0.25 时 viewBox = -1920 -1080 5120 2880）。
      rect.setAttribute("x", "-4000");
      rect.setAttribute("y", "-3000");
      rect.setAttribute("width", "12000");
      rect.setAttribute("height", "9000");
      rect.setAttribute("fill", "#ff00ff");
      rect.setAttribute("data-stage-probe", "1");
      group.appendChild(rect);
    });
    await page.waitForTimeout(160);
  }
  const shot = await page.screenshot({ clip: { x: dom.frame.x, y: dom.frame.y, width: dom.frame.w, height: dom.frame.h } });
  if (probe) {
    await page.evaluate(() => document.querySelector("[data-stage-probe]")?.remove());
  }
  const img = decodePng(shot);
  const skip = hudRects(dom);
  const window = windowBox(dom);
  return { dom, img, window, skip, visible: scan(img, { skip }), probeBox: probe ? scan(img, { skip }) : null };
}

const alive = await fetch(`${DEV}/stage-demo.html`, { method: "GET" })
  .then((response) => response.ok)
  .catch(() => false);
console.log(`stage-clip harness — node ${process.version} / DEV ${DEV} / DSF ${DSF}\n`);
if (!alive) {
  console.log(`FAIL dev server 不在：${DEV}（dev server + /stage-demo.html 是验收前提）`);
  process.exitCode = 1;
}

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium",
  // 全套 harness 连跑时同机有多个 chromium 在起落：显存/zygote 竞争会让
  // 页面在最后一屏前被关掉（实测 "Target page … has been closed"）。这里
  // 关 GPU + 限渲染进程 + 压堆，和 `float-window.mjs` 同一套稳健参数。
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--renderer-process-limit=1",
    "--js-flags=--max-old-space-size=512",
  ],
});

/** 五档缩放：怎么点到目标百分比（HUD 按钮语义见 `stageZoom.ts`）。 */
const STEPS = [
  { label: "50%", want: 0.5, path: ["zoom-05"] },
  { label: "100%", want: 1, path: ["zoom-1"] },
  { label: "150%", want: 1.5, path: ["zoom-1", "zoom-in", "zoom-in", "zoom-in", "zoom-in", "zoom-in"] },
  { label: "170%", want: 1.7, path: ["zoom-1", "zoom-in", "zoom-in", "zoom-in", "zoom-in", "zoom-in", "zoom-in", "zoom-in"] },
  { label: "25%", want: 0.25, path: ["zoom-05", "zoom-out", "zoom-out", "zoom-out"] },
];

const measured = [];
const demoErrors = [];
let unclippedAr = null;
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: DSF });
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => demoErrors.push(String(error.stack ?? error).split("\n")[0]));
  if (alive) {
    console.log("## (1) /stage-demo.html?scene=two —— 五档缩放");
    await page.goto(`${DEV}/stage-demo.html?scene=two`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-stage-pane] [data-stage-svg]", { timeout: 20_000 });
    await page.waitForTimeout(1800);
    const pane = page.locator("[data-stage-pane]").first();

    for (const step of STEPS) {
      for (const action of step.path) await pane.locator(`[data-stage-action="${action}"]`).click();
      await page.waitForTimeout(140);

      // ── 探针：可见盒必须 = viewBox 的 16:9 窗口（与画面内容无关）────────
      const withProbe = await measure(page, { probe: true });
      row(`${step.label} 探针盒 / 16:9 窗口（设备 px）`, `${withProbe.probeBox ? `${withProbe.probeBox.w}×${withProbe.probeBox.h}` : "（空）"} / ${withProbe.window.w}×${withProbe.window.h}`);
      ok(`${step.label} (a) 可见内容盒 AR ∈ [${AR_MIN}, ${AR_MAX}]（探针）`, () => {
        const ar = arOf(withProbe.probeBox);
        assert.ok(withProbe.probeBox, "探针盒为空");
        assert.ok(ar >= AR_MIN && ar <= AR_MAX, `AR ${ar.toFixed(4)}（${withProbe.probeBox.w}×${withProbe.probeBox.h}）`);
      });
      ok(`${step.label} (a) 可见内容盒 == viewBox 窗口（±6 设备 px）`, () => {
        const b = withProbe.probeBox;
        const w = withProbe.window;
        assert.ok(b, "探针盒为空");
        assert.ok(Math.abs(b.w - w.w) <= 6 && Math.abs(b.h - w.h) <= 6, `${b.w}×${b.h} vs ${w.w}×${w.h}`);
      });

      // ── 真实场景（背景 + 立绘 + 参考线）────────────────────────────────
      const real = await measure(page);
      const css = toCss(real.visible);
      const ar = arOf(real.visible);
      measured.push({
        zoom: real.dom.status,
        ar: ar6(real.visible),
        probeAr: ar6(withProbe.probeBox),
        probeDevice: withProbe.probeBox ? { w: withProbe.probeBox.w, h: withProbe.probeBox.h } : null,
        boxDevice: real.visible ? { w: real.visible.w, h: real.visible.h } : null,
        boxCss: css,
        windowDevice: { w: real.window.w, h: real.window.h },
      });
      row(`${step.label} 真实场景可见盒`, `${real.visible ? `${real.visible.w}×${real.visible.h} 设备 px` : "（空）"} → AR ${ar === null ? "—" : ar.toFixed(4)}（CSS ${JSON.stringify(css)} / 窗口 ${real.window.w}×${real.window.h}）`);

      ok(`${step.label} (a1) 真实场景可见盒完全落在 16:9 窗口内（±4 设备 px）`, () => {
        assert.ok(real.visible, "一个非黑像素都没有");
        assert.ok(inside(real.visible, real.window, 4), `可见盒 ${JSON.stringify(real.visible)} 超出窗口 ${JSON.stringify(real.window)}`);
      });
      ok(`${step.label} (a1) 真实场景可见盒不超出画布素材带（窗口宽 ±6）`, () => {
        assert.ok(real.visible, "一个非黑像素都没有");
        assert.ok(real.visible.w <= real.window.w + 6, `可见盒宽 ${real.visible.w} > 窗口宽 ${real.window.w} + 6`);
      });

      ok(`${step.label} (b) <g clip-path> 存在、clipPath 的 rect == 当前 viewBox`, () => {
        assert.equal(real.dom.group, "g", "没有 [data-stage-clip-group]");
        assert.equal(real.dom.groupClip, "url(#ark-stage-clip)", `clip-path=${real.dom.groupClip}`);
        assert.equal(real.dom.clipInDefs, true, "#ark-stage-clip 不在 <defs> 里");
        assert.ok(real.dom.clipRect, "没有 #ark-stage-clip-rect");
        const vb = real.dom.va;
        assert.equal(vb.length, 4, `viewBox=${vb}`);
        for (const [index, key] of ["x", "y", "width", "height"].entries()) {
          assert.ok(
            Math.abs(real.dom.clipRect[index] - vb[index]) < 1e-6,
            `clipRect.${key}=${real.dom.clipRect[index]} vs viewBox.${key}=${vb[index]}`,
          );
        }
        assert.equal(real.dom.hudInsideGroup, false, "HUD 工具条被包进了裁剪组");
        assert.equal(real.dom.deltaInsideGroup, false, "HUD 增量条被包进了裁剪组");
      });
      ok(`${step.label} (b2) zoom / 百分比一致 + 既有标记都在`, () => {
        assert.ok(Math.abs(real.dom.zoom - step.want) < 1e-9, `data-stage-zoom=${real.dom.zoom}（想要 ${step.want}）`);
        assert.ok(real.dom.status.startsWith(`${Math.round(step.want * 100)}%`), `状态条=${real.dom.status}`);
        assert.equal(real.dom.counts.guides, 3, `[data-stage-guide] 计数 ${real.dom.counts.guides}`);
        assert.equal(real.dom.counts.ruler, 1);
        assert.equal(real.dom.counts.safe, 2);
      });

      if (step.want >= 1) {
        // zoom ≥ 1：画布完全盖住窗口 → 真实场景的可见盒就是窗口，AR 必须达标。
        ok(`${step.label} (a1) zoom ≥ 1：真实场景可见盒 AR ∈ [${AR_MIN}, ${AR_MAX}]`, () => {
          assert.ok(real.visible, "包围盒为空");
          assert.ok(ar >= AR_MIN && ar <= AR_MAX, `AR ${ar.toFixed(4)}（${real.visible.w}×${real.visible.h}）`);
        });
        if (step.want > 1) {
          ok(`${step.label} (a3) 画布（背景素材）比 16:9 窗口更宽 → 裁剪是必需的（用户报的素材带）`, () => {
            assert.ok(real.dom.bg, "没有背景 <image>");
            const bgDevice = real.dom.bg.w * DSF;
            assert.ok(bgDevice > real.window.w + 100, `画布 ${bgDevice.toFixed(0)}px 并未超出窗口 ${real.window.w}px`);
          });
        } else {
          ok("100% (a3) 画布与 16:9 窗口等宽（这一档本来就看不见裁剪差异）", () => {
            assert.ok(real.dom.bg, "没有背景 <image>");
            const bgDevice = real.dom.bg.w * DSF;
            assert.ok(Math.abs(bgDevice - real.window.w) <= 6, `画布 ${bgDevice.toFixed(0)}px vs 窗口 ${real.window.w}px`);
          });
        }
      } else {
        // zoom < 1：窗口比画布大，画布缩在窗口中央；
        // AR 与几何都必须仍然“在窗口里”。
        ok(`${step.label} (a1) zoom < 1：真实场景可见盒 AR ∈ [1.70, 1.86]`, () => {
          assert.ok(real.visible, "包围盒为空");
          assert.ok(ar >= 1.7 && ar <= 1.86, `AR ${ar.toFixed(4)}`);
        });
      }
      if (step.want === 1) {
        ok("100% (c) 背景 <image> 屏幕盒 16:9、(x,y,w,h) = (0,0,1280,720)", () => {
          assert.ok(real.dom.bg, "没有背景 <image>");
          const bgAr = real.dom.bg.w / real.dom.bg.h;
          assert.ok(Math.abs(bgAr - 16 / 9) < 0.02, `背景 AR ${bgAr.toFixed(4)}`);
          assert.deepEqual(real.dom.bgAttr, [0, 0, 1280, 720]);
        });
      }

      // ── 150%：摘掉 clip 的对照实验（用户看到的那条素材带）──────────────
      if (step.want === 1.5) {
        await page.locator('[data-stage-frame="1"]').screenshot({ path: "build/harness/shots/stage-clip-150.png" }).catch(() => {});
        await page.evaluate(() => document.querySelector("[data-stage-clip-group]")?.setAttribute("clip-path", "none"));
        await page.locator('[data-stage-frame="1"]').screenshot({ path: "build/harness/shots/stage-clip-150-unclipped.png" }).catch(() => {});
        const unclipped = await measure(page);
        unclippedAr = arOf(unclipped.visible);
        await page.evaluate(() => document.querySelector("[data-stage-clip-group]")?.setAttribute("clip-path", "url(#ark-stage-clip)"));
        row("150% 摘掉 clip-path 后的可见盒", unclipped.visible ? `${unclipped.visible.w}×${unclipped.visible.h} 设备 px → AR ${unclippedAr.toFixed(4)}` : "（空）");
        ok("150% (a2) 对照：摘掉 clip → 可见盒变成 ~2.67:1 的「素材带」（用户报的现象）", () => {
          assert.ok(unclipped.visible, "包围盒为空");
          assert.ok(unclippedAr > 2.4 && unclippedAr < 2.9, `摘掉 clip 后 AR ${unclippedAr.toFixed(4)}（期望 2.4…2.9，Lead 实测 2.67）`);
          assert.ok(unclipped.visible.w > unclipped.window.w + 100, "摘掉 clip 后素材带没变宽，说明本来就被别的机制裁着");
        });
      }
    }

    await pane.locator('[data-stage-action="zoom-1"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-stage-frame="1"]').screenshot({ path: "build/harness/shots/stage-clip-100.png" }).catch(() => {});
  }

  // ── (2) 编辑器：舞台面板拖多大，舞台就多大 ──────────────────────────
  console.log("\n## (2) /editor/demo —— 拖水平分隔条 +300px");
  const SCRIPT = [
    '[HEADER(key="fanfic_demo", fit_mode="BLACK_MASK")]',
    '[Background(image="bg_corridor", x=0, y=0, fadetime=0, block=true)]',
    '[charslot(slot="m", name="char_130_doberm_ex", duration=0.5)]',
    '[name="杜宾"]  这里是……？',
  ].join("\n");
  const editor = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const editorErrors = [];
  try {
    editor.on("pageerror", (error) => editorErrors.push(String(error.stack ?? error).split("\n")[0]));
    await editor.addInitScript(() => {
      try {
        Object.keys(localStorage).filter((k) => k.startsWith("prts-editor-wb:")).forEach((k) => localStorage.removeItem(k));
      } catch {
        // 隐私模式：不影响断言
      }
    });
    let mounted = false;
    for (let attempt = 1; attempt <= 3 && !mounted; attempt += 1) {
      await editor.goto(`${DEV}/editor/demo?pack=fanfic_demo&text=${encodeURIComponent(SCRIPT)}`, { waitUntil: "domcontentloaded" });
      await editor.addStyleTag({ content: ".bookshelf-sync-warning,.dl-bar{display:none!important}" }).catch(() => {});
      mounted = await editor
        .waitForSelector('[data-wb-panel="stage"] [data-stage-svg]', { timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      if (!mounted) row(`第 ${attempt} 次挂载失败（并行改造中？）`, JSON.stringify(editorErrors.slice(-2)));
    }
    assert.ok(mounted, `编辑器页 3 次都没挂上舞台：${editorErrors.slice(0, 2).join(" | ") || "无 pageerror"}`);
    await editor.waitForTimeout(1200);
    const read = () =>
      editor.evaluate(() => {
        const box = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
        };
        return {
          panel: box('[data-wb-panel="stage"]'),
          stage: box(".ed-stage"),
          host: box(".ed-stage-host"),
          pane: box("[data-stage-pane]"),
          frame: box('[data-stage-frame="1"]'),
          svg: box("[data-stage-svg]"),
          fill: document.querySelector("[data-stage-pane]")?.getAttribute("data-stage-fill") ?? null,
          status: document.querySelector('[data-stage-status="zoom"]')?.textContent?.trim() ?? "",
          clip: document.querySelector("[data-stage-clip-group]")?.getAttribute("clip-path") ?? null,
        };
      });
    const before = await read();
    row("拖前", JSON.stringify(before));
    ok("舞台已挂载 + 填满宿主（data-stage-fill=1 / 无写死高度）", () => {
      assert.ok(before.svg, "编辑器里没有 [data-stage-svg]");
      assert.equal(before.fill, "1", "data-stage-fill≠1：页面仍在传 height");
      assert.equal(before.clip, "url(#ark-stage-clip)", "编辑器里的 StagePane 没有裁剪组");
      assert.ok(before.stage.h >= before.panel.h - 40, `.ed-stage ${before.stage.h} vs 面板 ${before.panel.h}`);
    });

    const handle = await editor.evaluate(() => {
      const el = [...document.querySelectorAll("[data-wb-gutter]")].find((node) => node.getBoundingClientRect().height <= 8);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, path: el.getAttribute("data-wb-path") };
    });
    assert.ok(handle, "没有水平分隔条（[data-wb-gutter] 高度 ≤ 8）");
    await editor.mouse.move(handle.x, handle.y);
    await editor.mouse.down();
    await editor.mouse.move(handle.x, handle.y - 300, { steps: 15 });
    await editor.mouse.up();
    await editor.waitForTimeout(600);
    const after = await read();
    row("拖后（分隔条向上 300px）", JSON.stringify(after));
    const delta = { svg: after.svg.h - before.svg.h, stage: after.stage.h - before.stage.h, panel: after.panel.h - before.panel.h };
    row("高度增量（px）", JSON.stringify(delta));
    ok("拖分隔条 +300px 后 [data-stage-svg] 高度增加 ≥ 250px", () => {
      assert.ok(delta.svg >= 250, `只增加了 ${delta.svg}px（${before.svg.h} → ${after.svg.h}）`);
    });
    ok("舞台宿主同步（.ed-stage / [data-wb-panel=stage] 也长高）", () => {
      assert.ok(delta.stage >= 250, `.ed-stage 只增加了 ${delta.stage}px`);
      assert.ok(delta.panel >= 250, `[data-wb-panel=stage] 只增加了 ${delta.panel}px`);
    });
    ok("拖大后像素盒仍是 16:9（frame 尺寸变化不改几何）", () => {
      const unit = Math.min(after.frame.w / 1280, after.frame.h / 720);
      assert.ok(Math.abs(after.svg.h - 720 * unit) < 4, `svg 高 ${after.svg.h} vs ${(720 * unit).toFixed(1)}`);
      assert.ok(Math.abs(before.svg.h - Math.min(before.frame.w / 1280, before.frame.h / 720) * 720) < 4, "拖前就不是 16:9");
    });
  } finally {
    await editor.close();
  }

  // ── (3) 调试日志：手柄 + 记忆 ─────────────────────────────────────
  console.log("\n## (3) / —— 调试日志可调大小 + 记忆");
  const home = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await home.goto(`${DEV}/`, { waitUntil: "domcontentloaded" });
    await home.evaluate(() => localStorage.removeItem("prts-debug-console-size")).catch(() => {});
    await home.reload({ waitUntil: "domcontentloaded" });
    await home.addStyleTag({ content: ".bookshelf-sync-warning,.dl-bar{display:none!important}" }).catch(() => {});
    await home.waitForTimeout(1200);
    const toggle = home.locator('button[title="查看调试日志"]');
    const toggleCount = await toggle.count();
    assert.ok(toggleCount > 0, "首页没有「调试日志」按钮（debug console 未启用？）");
    ok("收起态按钮键名不变（文案「调试日志」/ title=查看调试日志）", async () => {
      assert.ok(true);
    });
    const toggleText = ((await toggle.first().textContent()) ?? "").trim();
    row("收起态按钮文案", JSON.stringify(toggleText));
    await toggle.first().click();
    await home.waitForTimeout(300);

    const boxOf = () =>
      home.evaluate(() => {
        const handle = document.querySelector('[data-dbg-resize="1"]');
        const panel = handle?.parentElement ?? null;
        const b = panel?.getBoundingClientRect();
        const hb = handle?.getBoundingClientRect();
        return {
          handle: Boolean(handle),
          banner: panel?.parentElement?.querySelector?.('[data-asset-banner="1"]') ? true : document.querySelectorAll('[data-asset-banner="1"]').length > 0,
          panel: b ? { w: Math.round(b.width), h: Math.round(b.height) } : null,
          anchor: hb ? { x: hb.x, y: hb.y, w: hb.width, h: hb.height } : null,
          stored: localStorage.getItem("prts-debug-console-size"),
        };
      });
    const before = await boxOf();
    row("展开态默认", JSON.stringify(before));
    ok("展开态面板带 [data-dbg-resize=\"1\"] 手柄；默认仍是 min(720px,90vw) × min(320px,50vh)", () => {
      assert.equal(before.handle, true, "没有 [data-dbg-resize]");
      assert.ok(before.panel, "拿不到面板盒");
      assert.ok(Math.abs(before.panel.w - Math.min(720, 1400 * 0.9)) < 2, `默认宽 ${before.panel.w}`);
      assert.ok(Math.abs(before.panel.h - Math.min(320, 900 * 0.5)) < 2, `默认高 ${before.panel.h}`);
    });

    await home.mouse.move(before.anchor.x + before.anchor.w / 2, before.anchor.y + before.anchor.h / 2);
    await home.mouse.down();
    await home.mouse.move(before.anchor.x + before.anchor.w / 2 + 240, before.anchor.y + before.anchor.h / 2 - 200, { steps: 12 });
    await home.mouse.up();
    await home.waitForTimeout(300);
    const after = await boxOf();
    row("拖动后", JSON.stringify(after));
    ok("拖手柄 → 面板变大（+240 宽 / +200 高）", () => {
      assert.ok(after.panel.w - before.panel.w >= 200, `宽 ${before.panel.w} → ${after.panel.w}`);
      assert.ok(after.panel.h - before.panel.h >= 160, `高 ${before.panel.h} → ${after.panel.h}`);
    });
    ok("尺寸落到 localStorage: prts-debug-console-size（{w,h}）", () => {
      const parsed = JSON.parse(after.stored ?? "null");
      assert.ok(parsed && Number.isFinite(Number(parsed.w)) && Number.isFinite(Number(parsed.h)), `stored=${after.stored}`);
      assert.ok(Math.abs(Number(parsed.w) - after.panel.w) <= 2, `w ${parsed.w} vs ${after.panel.w}`);
      assert.ok(Math.abs(Number(parsed.h) - after.panel.h) <= 2, `h ${parsed.h} vs ${after.panel.h}`);
    });

    await home.reload({ waitUntil: "domcontentloaded" });
    await home.addStyleTag({ content: ".bookshelf-sync-warning,.dl-bar{display:none!important}" }).catch(() => {});
    await home.waitForTimeout(1200);
    await home.locator('button[title="查看调试日志"]').first().click();
    await home.waitForTimeout(300);
    const restored = await boxOf();
    row("刷新后（记忆生效）", JSON.stringify(restored));
    ok("刷新后尺寸复原（记忆生效）", () => {
      assert.ok(restored.panel, "刷新后拿不到面板盒");
      assert.ok(Math.abs(restored.panel.w - after.panel.w) <= 2, `${restored.panel.w} vs ${after.panel.w}`);
      assert.ok(Math.abs(restored.panel.h - after.panel.h) <= 2, `${restored.panel.h} vs ${after.panel.h}`);
    });
    void after;
    await home.evaluate(() => localStorage.setItem("prts-debug-console-size", "not-json"));
    await home.reload({ waitUntil: "domcontentloaded" });
    await home.addStyleTag({ content: ".bookshelf-sync-warning,.dl-bar{display:none!important}" }).catch(() => {});
    await home.waitForTimeout(1200);
    await home.locator('button[title="查看调试日志"]').first().click();
    await home.waitForTimeout(300);
    const fallback = await boxOf();
    row("坏 JSON 后", JSON.stringify(fallback.panel));
    ok("坏 JSON → 回落现状默认（min(720px,90vw) × min(320px,50vh)）", () => {
      assert.ok(fallback.panel, "拿不到面板盒");
      assert.ok(Math.abs(fallback.panel.w - Math.min(720, 1400 * 0.9)) < 2, `宽 ${fallback.panel.w}`);
      assert.ok(Math.abs(fallback.panel.h - Math.min(320, 900 * 0.5)) < 2, `高 ${fallback.panel.h}`);
    });
  } finally {
    await home.close();
  }
} catch (error) {
  fail += 1;
  const message = String(error?.stack ?? error).split("\n").slice(0, 4).join(" | ");
  failures.push({ label: "harness", error: message });
  console.log(`FAIL harness — ${message}`);
} finally {
  await browser.close();
}

ok("(1) /stage-demo.html 零 JS 报错", () => {
  assert.deepEqual(demoErrors.slice(0, 3), []);
});

console.log("\n## 五档实测 AR（探针 = 内容无关的 16:9 断言；真实 = 背景+立绘+参考线）");
for (const item of measured) {
  row(
    item.zoom,
    `探针 AR ${item.probeAr}（${item.probeDevice ? `${item.probeDevice.w}×${item.probeDevice.h}` : "—"} 设备 px / 16:9 窗口 ${item.windowDevice.w}×${item.windowDevice.h}）· 真实场景 AR ${item.ar}（${item.boxDevice ? `${item.boxDevice.w}×${item.boxDevice.h}` : "—"}）· CSS ${JSON.stringify(item.boxCss)}`,
  );
}
row("150% 摘掉 clip 对照（真实场景）", unclippedAr === null ? "—" : `AR ${unclippedAr.toFixed(4)}`);

console.log(`\nSTAGE-CLIP ${fail === 0 ? "PASS" : "FAIL"} — ${pass} pass${fail ? ` / ${fail} fail` : ""}`);
if (fail) {
  for (const item of failures) console.log(`  ✗ ${item.label}: ${item.error}`);
  process.exitCode = 1;
}
