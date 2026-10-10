// 分支图（T6）**视觉证据** harness（补充 `branch-shot.mjs`）：
// 断言「适配 → 缩放 → 复位」闭环，并出两张图（适配全貌 / 放大细节）。
//   node build/harness/t6-visual-check.mjs       # 前置：dev server:5174
import { chromium } from "playwright-core";
import { resolve } from "node:path";

const DEV = process.env.DEV_URL ?? "http://localhost:5174";
const SHOTS = resolve("build/harness/shots");
const SCRIPT = [
  '[HEADER(key="fanfic_sample")]',
  "[Dialog]",
  '[name="杜宾"]  这里是……？',
  '[Decision(options="跟着她走;先问清楚", values="1;2")]',
  '[Predicate(references="1")]',
  '[Character(name="char_002_amiya_1#1")]',
  '[name="阿米娅"]  这边走，博士。',
  '[Predicate(references="2")]',
  '[name="阿米娅"]  先别急，我把情况说清楚。',
  '[Predicate(references="1;2")]',
  '[name="陈"]  都到齐了。',
].join("\n");

let failed = 0;
const check = (label, value, pass) => {
  console.log(`${pass ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(value)}`);
  if (!pass) failed += 1;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const errors = [];
  page.on("pageerror", (event) => {
    const text = String(event.stack ?? event);
    if (!text.includes("transformCallback")) errors.push(text.split("\n")[0]);
  });
  await page.goto(`${DEV}/branch-demo.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.locator("textarea").first().fill(SCRIPT);
  await page.waitForTimeout(800);

  const svg = page.locator('[data-branch-graph="1"]');
  const zoomOf = async () => Number(await svg.getAttribute("data-branch-zoom"));
  const box = await page.locator(".ed-graph").boundingBox();

  const fitZoom = await zoomOf();
  check("首帧 = 适配（fit）", fitZoom, fitZoom >= 0.2 && fitZoom <= 2);
  await page.screenshot({ path: resolve(SHOTS, "branch-fit.png"), clip: box });

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(400);
  const zoomed = await zoomOf();
  check("滚轮放大（fit 之后 zoom 变大）", { fitZoom, zoomed }, zoomed > fitZoom);
  await page.locator('[data-branch-pan="1"]').screenshot({ path: resolve(SHOTS, "branch-zoom.png") });

  await page.locator('[data-branch-pan="1"]').click({ position: { x: 8, y: 8 } });
  await page.keyboard.press("0");
  await page.waitForTimeout(400);
  const reset = await zoomOf();
  check("键 0 复位到适配", { zoomed, reset }, Math.abs(reset - fitZoom) < 1e-6);

  /** DOM 里的几何：零重叠 + 间距 ≥ 32（与 `layoutGraph` 的单元断言互为交叉验证）。 */
  const metrics = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("[data-branch-node]")].map((node) => {
      const matched = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(node.getAttribute("transform") ?? "");
      const rect = node.querySelector("rect");
      return {
        x: matched ? Number(matched[1]) : NaN,
        y: matched ? Number(matched[2]) : NaN,
        w: Number(rect?.getAttribute("width") ?? 0),
        h: Number(rect?.getAttribute("height") ?? 0),
      };
    });
    let overlap = 0;
    let minGapX = Infinity;
    let minGapY = Infinity;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlap += 1;
        if (Math.abs(a.y - b.y) < 0.5 && b.x > a.x) minGapX = Math.min(minGapX, b.x - (a.x + a.w));
        if (Math.abs(a.x - b.x) < 0.5 && b.y > a.y) minGapY = Math.min(minGapY, b.y - (a.y + a.h));
      }
    }
    return { nodes: nodes.length, overlap, minGapX, minGapY };
  });
  check("DOM 卡片两两不重叠", { nodes: metrics.nodes, overlap: metrics.overlap }, metrics.overlap === 0);
  check("DOM 相邻间距 = 32px", { minGapX: metrics.minGapX, minGapY: metrics.minGapY }, metrics.minGapX === 32 && metrics.minGapY === 32);
  check("pageerror（已滤 transformCallback）", errors.slice(0, 2), errors.length === 0);
} finally {
  await browser.close();
}

console.log(`\n== 结果：${failed === 0 ? "全部通过" : `${failed} 项失败`} ==`);
process.exit(failed === 0 ? 0 : 1);
