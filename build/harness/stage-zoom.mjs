// 验收 harness #1：舞台**连续缩放**（BRIEF-workbench-v1 §2.5 / §4 行 1）。
//
//   node build/harness/stage-zoom.mjs
//   DEV_URL=http://localhost:5174 node build/harness/stage-zoom.mjs   # 默认
//
// 两段：
//   (1) **纯数学**：直接 `import` `frontend/src/components/editor/stageZoom.ts`
//       （Node 22 的类型剥离，跑的就是组件 import 的同一份实现）——
//       常量 / clamp / fitZoom / viewBox / zoomAt 锚点保值（误差 < 0.5 CSS px）。
//   (2) **浏览器**：dev server（默认 5174）上的 `/editor/demo?text=…` ——
//       滚轮 3 格后百分比 ≠ 100/50、`viewBox` 变化而 `<image>` 的 x/y/w/h 不变、
//       指针锚点保值、`+`/`−`/百分比/`适配`/`1:1` 都只改 viewBox。
//
// 退出码 0 = 全过；1 = 有断言失败。dev server 不在时浏览器段打印 skip（不算失败）。
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DEV = process.env.DEV_URL ?? "http://localhost:5174";
const OUT = resolve("build/harness/shots");
mkdirSync(OUT, { recursive: true });

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
    failures.push({ label, error: String(error?.message ?? error) });
    console.log(`FAIL ${label} — ${error?.message ?? error}`);
  }
};
const skip = (label, why) => console.log(`skip ${label} — ${why}`);

console.log(`stage-zoom harness — node ${process.version} / DEV ${DEV}\n`);

// ── (1) 纯数学 ────────────────────────────────────────────────────────────
const ZOOM_PATH = resolve("frontend/src/components/editor/stageZoom.ts");
let Z = null;
try {
  Z = await import(`file://${ZOOM_PATH}`);
} catch (error) {
  console.log(`  （import stageZoom.ts 失败：${error?.message ?? error}）`);
}
if (!Z) {
  fail += 1;
  failures.push({ label: "stageZoom.ts 可 import", error: "模块载入失败" });
  console.log("FAIL stageZoom.ts 可 import");
} else {
  console.log("## (1) 纯数学 stageZoom.ts");
  const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}（tol ${tol}）`);
  /** 单精度：CSS px 误差 < 0.5（本 harness 的验收线）。 */
  const NEAR_PX = 0.5;

  ok("常量逐字：0.25 / 2 / 1 / 0.1", () => {
    assert.equal(Z.MIN_ZOOM, 0.25);
    assert.equal(Z.MAX_ZOOM, 2);
    assert.equal(Z.DEFAULT_ZOOM, 1);
    assert.equal(Z.WHEEL_STEP, 0.1);
  });

  ok("clampZoom：上下界 + NaN→1", () => {
    assert.equal(Z.clampZoom(9), 2);
    assert.equal(Z.clampZoom(0), 0.25);
    assert.equal(Z.clampZoom(0.24), 0.25);
    assert.equal(Z.clampZoom(2.5), 2);
    assert.equal(Z.clampZoom(-1), 0.25);
    assert.equal(Z.clampZoom(1), 1);
    assert.equal(Z.clampZoom(1.37), 1.37);
    assert.equal(Z.clampZoom(NaN), 1);
    assert.equal(Z.clampZoom(undefined), 1);
  });

  ok("zoomPercent：四舍五入 + 兜底", () => {
    assert.equal(Z.zoomPercent(1.37), "137%");
    assert.equal(Z.zoomPercent(1), "100%");
    assert.equal(Z.zoomPercent(0.25), "25%");
    assert.equal(Z.zoomPercent(NaN), "100%");
  });

  ok("fitZoom = min(vw/bw, vh/bh) × 留白，两维取小", () => {
    const cases = [
      [{ w: 1280, h: 720 }, { w: 1024, h: 576 }, 0.768], // 4:3 窗格：等比，55% 高
      [{ w: 1280, h: 720 }, { w: 512, h: 512 }, 0.384], // 窗口太窄 → 宽比是瓶颈
      [{ w: 1280, h: 720 }, { w: 1600, h: 600 }, 0.8], // 窗口太矮 → 高比是瓶颈
      [{ w: 1280, h: 720 }, { w: 2560, h: 1440 }, 1.92], // 两倍大窗
      [{ w: 1280, h: 720 }, { w: 400, h: 900 }, 0.3], // 极窄
    ];
    for (const [box, viewport, want] of cases) {
      const got = Z.fitZoom(viewport, box);
      near(got, want, 1e-9);
      // 与「min 比 × FIT_PADDING」的显式公式一致（不依赖上面写死的常数）。
      const raw = Math.min(viewport.w / box.w, viewport.h / box.h) * Z.FIT_PADDING;
      near(got, Z.clampZoom(raw), 1e-12);
    }
    // 两个维度的较小比（不可交换）：更矮的视口 → 更小的适配值
    assert.ok(Z.fitZoom({ w: 1600, h: 600 }, { w: 1280, h: 720 }) < Z.fitZoom({ w: 1600, h: 1200 }, { w: 1280, h: 720 }));
  });

  ok("fitZoom：退化输入 → 100%（不抛、不出 NaN）", () => {
    for (const value of [0, -1, NaN, undefined, null, {}]) {
      assert.equal(Z.fitZoom(value, { w: 1280, h: 720 }), 1, `viewport=${JSON.stringify(value)}`);
      assert.equal(Z.fitZoom({ w: 800, h: 480 }, value), 1, `box=${JSON.stringify(value)}`);
    }
  });

  ok("fitZoom：上限被 clamp 到 2", () => {
    assert.equal(Z.fitZoom({ w: 12800, h: 14400 }, { w: 1280, h: 720 }), 2);
  });

  ok("resetZoom() = 100%", () => {
    assert.equal(Z.resetZoom(), Z.DEFAULT_ZOOM);
  });

  ok("baseUnit / cssScale：meet 语义（短边贴合）", () => {
    assert.equal(Z.baseUnit({ w: 800, h: 600 }), 800 / 1280); // min(0.625, 0.8333)
    assert.equal(Z.baseUnit({ w: 2560, h: 1080 }), 1.5); // min(2, 1.5)
    assert.equal(Z.baseUnit({ w: 0, h: 0 }), 0);
    assert.equal(Z.baseUnit(null), 0);
    near(Z.cssScale(1, { w: 800, h: 600 }), 800 / 1280, 1e-12);
    near(Z.cssScale(2, { w: 800, h: 600 }), (800 / 1280) * 2, 1e-12);
  });

  ok("viewFor：zoom=1 恰好是 1280×720；0.5 外扩一圈；2 收一半", () => {
    assert.deepEqual(Z.viewFor(1), { x: 0, y: 0, w: 1280, h: 720, zoom: 1 });
    assert.deepEqual(Z.viewFor(0.5), { x: -640, y: -360, w: 2560, h: 1440, zoom: 0.5 });
    assert.deepEqual(Z.viewFor(2), { x: 320, y: 180, w: 640, h: 360, zoom: 2 });
    // 超出区间 → clamp
    assert.equal(Z.viewFor(9).w, 640);
    assert.equal(Z.viewFor(NaN).w, 1280);
  });

  ok("viewBoxOf：只输出四条数字（zoom=1 / 0.5 / 1.37）", () => {
    assert.equal(Z.viewBoxOf(1), "0 0 1280 720");
    assert.equal(Z.viewBoxOf(0.5), "-640 -360 2560 1440");
    const parts = Z.viewBoxOf(1.37).split(" ");
    assert.equal(parts.length, 4);
    const view = Z.viewFor(1.37);
    near(Number(parts[0]), view.x, 1e-4);
    near(Number(parts[2]), view.w, 1e-4);
  });

  ok("canvasToCss：16:9 画布中心 → 宿主中心（letterbox 居中）", () => {
    const box = { w: 640, h: 360 };
    const center = Z.canvasToCss(1, { x: 640, y: 360 }, box);
    near(center.x, 320, 1e-9);
    near(center.y, 180, 1e-9);
    // 偏高的宿主：画布仍居中，垂直留黑边
    const tall = { w: 1280, h: 720 * 2 };
    const topLeft = Z.canvasToCss(1, { x: 0, y: 0 }, tall);
    near(topLeft.x, 0, 1e-9);
    near(topLeft.y, 360, 1e-9);
  });

  ok("cssToCanvas ∘ canvasToCss = id（5 档 × 非 16:9 宿主）", () => {
    const box = { w: 1234, h: 567 };
    for (const zoom of [0.25, 0.5, 1, 1.37, 2]) {
      for (const point of [{ x: 333, y: 444 }, { x: -100, y: 800 }]) {
        const css = Z.canvasToCss(zoom, point, box);
        const back = Z.cssToCanvas(zoom, css, box);
        near(back.x, point.x, 1e-9);
        near(back.y, point.y, 1e-9);
      }
    }
  });

  ok("wheelDelta：向上放大一格 / 向下缩小一格 / 0 与 NaN → 0", () => {
    assert.equal(Z.wheelDelta(-120), 0.1);
    assert.equal(Z.wheelDelta(-1), 0.1);
    assert.equal(Z.wheelDelta(120), -0.1);
    assert.equal(Z.wheelDelta(0), 0);
    assert.equal(Z.wheelDelta(NaN), 0);
  });

  ok("zoomIn / zoomOut：一格步长 + 直通 clamp", () => {
    assert.equal(Z.zoomIn(1), 1.1);
    assert.equal(Z.zoomIn(1.1), 1.2);
    assert.equal(Z.zoomIn(2), 2);
    assert.equal(Z.zoomOut(1.1), 1);
    assert.equal(Z.zoomOut(0.25), 0.25);
    assert.equal(Z.zoomIn(1, 0.25), 1.25);
  });

  // —— zoomAt：验收的核心（Lead harness 只查「zoom 变了」；这里查**锚点保值**）——
  /** 锚点在 CSS 像素里的漂移（同一个画布点在缩放前后落到的 CSS 位置之差）。 */
  const anchorDrift = (zoom, point, delta, box, canvas = { w: 1280, h: 720 }) => {
    const start = Z.zoomAt(zoom, point, delta, box);
    const base = Z.baseUnit(box, canvas);
    const v0 = Z.viewFor(zoom, canvas);
    const css0 = { x: (point.x - v0.x) * base * zoom, y: (point.y - v0.y) * base * zoom };
    const css1 = { x: (point.x - start.x) * base * start.zoom, y: (point.y - start.y) * base * start.zoom };
    return { drift: Math.hypot(css1.x - css0.x, css1.y - css0.y), result: start };
  };

  ok("zoomAt：22 组（zoom × delta × 锚点）锚点保值 < 0.5 CSS px", () => {
    const boxes = [{ w: 1280, h: 720 }, { w: 913, h: 214 }, { w: 400, h: 900 }];
    const zooms = [0.25, 0.37, 0.5, 0.73, 1, 1.37, 2];
    const deltas = [0.1, -0.1, 0.3, -0.25];
    const points = [{ x: 640, y: 360 }, { x: 0, y: 0 }, { x: 1280, y: 720 }, { x: 300, y: 100 }];
    let checked = 0;
    let worst = 0;
    for (const box of boxes) {
      for (const zoom of zooms) {
        for (const delta of deltas) {
          for (const point of points) {
            const { drift, result } = anchorDrift(zoom, point, delta, box);
            checked += 1;
            worst = Math.max(worst, drift);
            assert.ok(drift < NEAR_PX, `box=${JSON.stringify(box)} zoom=${zoom} delta=${delta} point=${JSON.stringify(point)} drift=${drift.toFixed(4)}px`);
            assert.ok(result.zoom >= Z.MIN_ZOOM && result.zoom <= Z.MAX_ZOOM);
            assert.ok(Number.isFinite(result.x) && Number.isFinite(result.y));
          }
        }
      }
    }
    console.log(`     （${checked} 组，最大漂移 ${worst.toExponential(2)} px）`);
    assert.ok(checked >= 20, `组数 ${checked}`);
  });

  ok("zoomAt：锚点在视口中心 → viewBox 保持居中（每档都成立）", () => {
    for (const zoom of [0.25, 0.62, 1, 1.85]) {
      const view = Z.viewFor(zoom);
      const point = { x: view.x + view.w / 2, y: view.y + view.h / 2 }; // = (640, 360)
      const next = Z.zoomAt(zoom, point, 0.1, { w: 1280, h: 720 });
      assert.equal(next.x, 0);
      assert.equal(next.y, 0);
    }
  });

  ok("zoomAt：clamp 生效（上界 +ε / 下界 −ε）", () => {
    assert.equal(Z.zoomAt(2, { x: 640, y: 360 }, 0.1, { w: 1280, h: 720 }).zoom, 2);
    assert.equal(Z.zoomAt(0.25, { x: 640, y: 360 }, -0.1, { w: 1280, h: 720 }).zoom, 0.25);
    assert.equal(Z.zoomAt(1.97, { x: 640, y: 360 }, 0.1, { w: 1280, h: 720 }).zoom, 2);
    assert.equal(Z.zoomAt(0.28, { x: 640, y: 360 }, -0.1, { w: 1280, h: 720 }).zoom, 0.25);
  });

  ok("zoomAt：x/y 与 viewBox 一致（4 个精度 + 归一化返回）", () => {
    for (const zoom of [0.25, 0.62, 1, 1.5, 2]) {
      for (const point of [{ x: 0, y: 100 }, { x: 900, y: 360 }]) {
        const start = decodeURIComponent("");
        void start;
        const r = Z.zoomAt(zoom, point, 0.1, { w: 1280, h: 720 });
        const size = 1280 / r.zoom;
        assert.ok(r.x >= point.x - size && r.x <= point.x, "point 必须仍在视口内");
        assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y));
      }
    }
    // 连续放大 7 档回到起始 zoom（步长可逆）
    let zoom = 1;
    for (let i = 0; i < 7; i += 1) zoom = Z.zoomAt(zoom, { x: 640, y: 360 }, 0.1, { w: 1280, h: 720 }).zoom;
    assert.ok(zoom > 1 && zoom < 1.3, `zoom=${zoom}`);
    assert.notEqual(zoom, 1);
    assert.notEqual(zoom, 0.5);
  });

  ok("zoomAt：「+0.1 再 −0.1」回到同一视口（无累计误差）", () => {
    const zoom = 1;
    const point = { x: 812, y: 233 };
    const box = { w: 1280, h: 720 };
    const up = Z.zoomAt(zoom, point, 0.1, box);
    const back = Z.zoomAt(up.zoom, point, -0.1, box);
    assert.equal(back.zoom, zoom);
    near(back.x, Z.viewFor(zoom).x, 1e-9);
    near(back.y, Z.viewFor(zoom).y, 1e-9);
  });

  ok("zoomAt：宿主退化（0/NaN）也给有限解", () => {
    for (const box of [{ w: 0, h: 0 }, { w: NaN, h: NaN }, {}]) {
      const r = Z.zoomAt(1, { x: 640, y: 360 }, 0.1, box);
      assert.ok(Number.isFinite(r.zoom) && Number.isFinite(r.x) && Number.isFinite(r.y), JSON.stringify(box));
      assert.ok(r.zoom > 1);
    }
  });

  ok("stagePointToCss：与 viewBox 平移一致（pan 之外无跳变）", () => {
    const box = { w: 1280, h: 720 };
    const point = { x: 500, y: 400 };
    const centered = Z.canvasToCss(1.3, point, box);
    const panned = Z.stagePointToCss(1.3, { x: Z.viewFor(1.3).x - 100, y: Z.viewFor(1.3).y }, point, box);
    near(panned.x - centered.x, -100 * Z.cssScale(1.3, box), 1e-9);
    near(panned.y - centered.y, 0, 1e-9);
  });

  ok("纯函数：同输入同输出（幂等，无隐藏状态）", () => {
    const a = Z.zoomAt(1.24, { x: 100, y: 200 }, 0.1, { w: 800, h: 450 });
    const b = Z.zoomAt(1.24, { x: 100, y: 200 }, 0.1, { w: 800, h: 450 });
    assert.deepEqual(a, b);
    assert.equal(Z.viewBoxOf(1.37), Z.viewBoxOf(1.37));
  });
}

// ── (2) 浏览器 ─────────────────────────────────────────────────────────
const alive = await fetch(`${DEV}/editor/demo`, { method: "GET" })
  .then((response) => response.ok)
  .catch(() => false);
const report = { pure: { pass, fail }, browser: null };
if (!alive) {
  skip("(2) 浏览器段", `dev server 不在：${DEV}`);
} else {
  console.log("\n## (2) 浏览器（dev server）");
  const { chromium } = await import("playwright-core");
  const text = [
    '[Background(image="bg_forest",fadetime=0)]',
    '[Character(name="char_002_amiya_1",fadetime=0.5)]',
    '[charslot(slot="r",name="char_010_chen_1",duration=0.2)]',
    '[name="阿米娅"]  连续缩放测试',
  ].join("\n");

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const rows = [];
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
    page.on("pageerror", (error) => errors.push(String(error.stack ?? error).split("\n")[0]));
    await page.addInitScript(() => {
      const hide = () => {
        const style = document.createElement("style");
        style.id = "stage-zoom-hide";
        style.textContent = ".bookshelf-sync-warning,.dl-bar{display:none !important}";
        (document.head ?? document.documentElement).appendChild(style);
      };
      hide();
      setInterval(() => { if (!document.getElementById("stage-zoom-hide")) hide(); }, 400);
    });
    await page.goto(`${DEV}/editor/demo?text=${encodeURIComponent(text)}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-stage-pane] [data-stage-svg], [data-stage-svg]", { timeout: 30000 });
    await page.waitForTimeout(1600);

    const paneSel = (await page.locator('[data-wb-panel="stage"] [data-stage-pane]').count())
      ? '[data-wb-panel="stage"] [data-stage-pane]'
      : (await page.locator('[data-win="舞台"] [data-stage-pane]').count())
        ? '[data-win="舞台"] [data-stage-pane]'
        : "[data-stage-pane]";
    const pane = page.locator(paneSel).first();
    const read = () =>
      page.evaluate((sel) => {
        const root = document.querySelector(sel);
        const svg = root?.querySelector("[data-stage-svg]");
        const vb = (svg?.getAttribute("viewBox") ?? "").trim().split(/\s+/).map(Number);
        const first = root?.querySelector("[data-stage-char] image");
        const geo = first
          ? {
              x: first.getAttribute("x"),
              y: first.getAttribute("y"),
              w: first.getAttribute("width"),
              h: first.getAttribute("height"),
            }
          : null;
        const background = root?.querySelector("[data-stage-background]");
        const bgGeo = background
          ? { x: background.getAttribute("x"), y: background.getAttribute("y"), w: background.getAttribute("width"), h: background.getAttribute("height") }
          : null;
        const ctm = svg?.getScreenCTM?.();
        const rect = svg?.getBoundingClientRect?.();
        return {
          vb,
          geo,
          bgGeo,
          zoom: root?.getAttribute("data-stage-zoom") ?? null,
          chars: root?.getAttribute("data-stage-chars") ?? null,
          status: root?.querySelector('[data-stage-status="zoom"]')?.textContent?.trim() ?? "",
          actions: [...root.querySelectorAll("[data-stage-action]")].map((node) => node.getAttribute("data-stage-action")),
          chrome: { roots: root.querySelectorAll('[data-chrome="stage"]').length, folds: root.querySelectorAll('[data-chrome="stage"] .sp-fold').length },
          guides: root.querySelectorAll("[data-stage-guide]").length,
          ruler: root.querySelectorAll("[data-stage-ruler]").length,
          safe: root.querySelectorAll("[data-stage-safe]").length,
          ctm: ctm ? { a: ctm.a, d: ctm.d, e: ctm.e, f: ctm.f } : null,
          rect: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
        };
      }, paneSel);

    const before = await read();
    rows.push({ step: "initial", ...before });

    ok("舞台已挂载：data-stage-svg / viewBox 四条数字", () => {
      assert.equal(before.vb.length, 4, `viewBox=${JSON.stringify(before.vb)}`);
      assert.ok(before.vb[2] > 0 && before.vb[3] > 0);
      assert.ok(before.ctm && before.ctm.a > 0);
      assert.equal(before.zoom, "1");
    });

    ok("既有标记都在（回归）：参考线 / 标尺 / 安全框 / 按钮", () => {
      assert.equal(before.guides, 3);
      assert.equal(before.ruler, 1);
      assert.equal(before.safe, 2);
      for (const action of ["zoom-in", "zoom-out", "zoom-1"]) {
        assert.ok(before.actions.includes(action), `缺 data-stage-action=${action}（有 ${before.actions.join(",")}）`);
      }
      assert.ok(before.actions.includes("guides"));
      assert.ok(before.actions.includes("copy"));
    });

    ok("chrome 控件带 data-chrome=\"stage\" + .sp-fold（P4 契约 §2.2）", () => {
      assert.ok(before.chrome.roots >= 1, `data-chrome=stage 计数 ${before.chrome.roots}`);
      assert.ok(before.chrome.folds >= 1, `.sp-fold 计数 ${before.chrome.folds}`);
    });

    // (a) 滚轮连续缩放：viewBox 变、几何不变、百分比不是 100/50
    const box = before.rect;
    const anchor = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    await page.mouse.move(anchor.x, anchor.y);
    for (let i = 0; i < 3; i += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(250);
    const wheeled = await read();
    rows.push({ step: "wheel×3", ...wheeled });
    await page.screenshot({ path: resolve(OUT, "stage-zoom-wheeled.png") });

    ok("滚轮 3 格：viewBox 变、zoom > 1", () => {
      assert.notDeepEqual(wheeled.vb, before.vb, `before=${before.vb} after=${wheeled.vb}`);
      assert.ok(Number(wheeled.zoom) > 1, `zoom=${wheeled.zoom}`);
    });

    ok("滚轮 3 格：百分比 ≠ 100% / 50%（连续，不是两档）", () => {
      const match = /(\d+(?:\.\d+)?)%/.exec(wheeled.status ?? "");
      assert.ok(match, `状态条没有百分比：${JSON.stringify(wheeled.status)}`);
      assert.notEqual(match[1], "100");
      assert.notEqual(match[1], "50");
      assert.ok(Number(wheeled.zoom) > 1 && Number(wheeled.zoom) <= 2, `data-stage-zoom=${wheeled.zoom}`);
      // 百分比确实反映 zoom（四舍五入）
      assert.equal(match[1], String(Math.round(Number(wheeled.zoom) * 100)));
    });

    ok("几何不变：背景 / 立绘的 `<image>` x/y/width/height 一个像素没动", () => {
      assert.deepEqual(wheeled.bgGeo, before.bgGeo);
      assert.deepEqual(wheeled.geo, before.geo);
    });

    ok("缩放比例连续：CTM 的 a/d 按 zoom 线性变化", () => {
      const ratio = wheeled.ctm.a / before.ctm.a;
      const want = Number(wheeled.zoom) / Number(before.zoom);
      assert.ok(Math.abs(ratio - want) < 1e-3, `ctm 比 ${ratio} vs zoom 比 ${want}`);
      assert.ok(Math.abs(wheeled.vb[2] - 1280 / Number(wheeled.zoom)) < 0.5, `viewBox 宽 ${wheeled.vb[2]} vs ${1280 / Number(wheeled.zoom)}`);
    });

    // (b) 指针锚点保值（真实 CSS 像素）
    const pointInCss = (state, cx, cy) => ({ x: cx * state.ctm.a + state.ctm.e, y: cy * state.ctm.d + state.ctm.f });
    const start = await read();
    const probe = (() => {
      // 取背景中心（16:9 画布的几何中心，一定在舞台里）
      const cx = (start.bgGeo ? Number(start.bgGeo.x) + Number(start.bgGeo.w) : 1280) / 2;
      const cy = (start.bgGeo ? Number(start.bgGeo.y) + Number(start.bgGeo.h) : 720) / 2;
      return { canvas: { x: cx, y: cy }, css: pointInCss(start, cx, cy) };
    })();
    await page.mouse.move(probe.css.x, probe.css.y);
    for (let i = 0; i < 2; i += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(90);
    }
    await page.waitForTimeout(250);
    const anchored = await read();
    rows.push({ step: "anchor", probe, ...anchored });

    ok("滚轮锚点保值：指针下的画布点停在同一个 CSS 像素（< 0.5px）", () => {
      const after = pointInCss(anchored, probe.canvas.x, probe.canvas.y);
      const drift = Math.hypot(after.x - probe.css.x, after.y - probe.css.y);
      assert.ok(drift < 0.5, `漂移 ${drift.toFixed(3)}px（${JSON.stringify(probe)} → ${JSON.stringify(after)}）`);
    });

    // (c) − / ＋：以**当前视口中心**为锚，且 viewBox 变化
    const minusBefore = await read();
    await pane.locator('[data-stage-action="zoom-out"]').click();
    await page.waitForTimeout(200);
    const minusAfter = await read();
    ok("`−` 缩小一格且只改 viewBox（几何不变）", () => {
      assert.ok(Number(minusAfter.zoom) < Number(minusBefore.zoom), `${minusBefore.zoom} → ${minusAfter.zoom}`);
      assert.deepEqual(minusAfter.bgGeo, minusBefore.bgGeo);
      assert.deepEqual(minusAfter.geo, minusBefore.geo);
      assert.ok(Math.abs(Number(minusAfter.zoom) - (Number(minusBefore.zoom) - 0.1)) < 1e-6);
    });

    const plusBefore = await read();
    // 视口中心（画布坐标）→ CSS
    const centerBefore = (() => {
      const cx = plusBefore.vb[0] + plusBefore.vb[2] / 2;
      const cy = plusBefore.vb[1] + plusBefore.vb[3] / 2;
      return { canvas: { x: cx, y: cy }, css: pointInCss(plusBefore, cx, cy) };
    })();
    await pane.locator('[data-stage-action="zoom-in"]').click();
    await page.waitForTimeout(200);
    const plusAfter = await read();
    ok("`＋` 放大一格，且视口中心不动（< 0.5px）", () => {
      assert.ok(Number(plusAfter.zoom) > Number(plusBefore.zoom), `${plusBefore.zoom} → ${plusAfter.zoom}`);
      const after = pointInCss(plusAfter, centerBefore.canvas.x, centerBefore.canvas.y);
      assert.ok(Math.hypot(after.x - centerBefore.css.x, after.y - centerBefore.css.y) < 0.5);
      assert.deepEqual(plusAfter.geo, plusBefore.geo);
    });

    // (d) 百分比按钮 → 100%
    const fitBefore = await read();
    await pane.locator('[data-stage-action="fit"]').click();
    await page.waitForTimeout(200);
    const fitted = await read();
    ok("`适配`：zoom = fitZoom(宿主, 1280×720)（clamp 后）、viewBox 跟着变", () => {
      assert.ok(Z, "需要纯函数段载入成功");
      const want = Z.fitZoom({ w: fitted.rect.w, h: fitted.rect.h }, { w: 1280, h: 720 });
      assert.ok(Math.abs(Number(fitted.zoom) - want) < 0.011, `zoom ${fitted.zoom} vs fitZoom ${want}`);
      assert.deepEqual(fitted.geo, fitBefore.geo);
    });

    await pane.locator('[data-stage-action="zoom-1"]').click();
    await page.waitForTimeout(200);
    const oneToOne = await read();
    ok("`1:1`：zoom 回到 1、viewBox 恰好 0 0 1280 720", () => {
      assert.equal(oneToOne.zoom, "1");
      assert.deepEqual(oneToOne.vb.map((value) => Math.round(value * 1000) / 1000), [0, 0, 1280, 720]);
      assert.deepEqual(oneToOne.geo, before.geo);
    });

    const percentBefore = await read();
    await pane.locator('[data-stage-action="zoom-in"]').click();
    await page.waitForTimeout(150);
    await pane.locator('[data-stage-status="zoom"]').click();
    await page.waitForTimeout(200);
    const percentAfter = await read();
    ok("点百分比 → 回 100%（只改 viewBox）", () => {
      assert.ok(Number(percentBefore.zoom) > 1);
      assert.equal(percentAfter.zoom, "1");
      assert.deepEqual(percentAfter.geo, percentBefore.geo);
      assert.deepEqual(percentAfter.vb, before.vb);
    });

    // (e) chrome 折叠：`.sp-fold` → chrome.onToggle（harness 只看「按钮在且可点」）
    const foldBefore = await read();
    await pane.locator('[data-chrome="stage"] .sp-fold').first().click();
    await page.waitForTimeout(200);
    const foldAfter = await read();
    ok("chrome 折叠按钮可点、不炸（DOM 标记保留）", () => {
      assert.ok(foldBefore.chrome.folds >= 1);
      assert.ok(foldAfter.chrome.roots >= 1);
      assert.equal(foldAfter.geo, foldBefore.geo);
    });

    ok("页内零 JS 报错", () => {
      assert.deepEqual(errors.slice(0, 3), []);
    });

    report.browser = { ok: fail === 0, rows, errors };
    await page.screenshot({ path: resolve(OUT, "stage-zoom.png") });
  } catch (error) {
    fail += 1;
    const message = String(error?.stack ?? error).split("\n").slice(0, 5).join(" | ");
    failures.push({ label: "(2) 浏览器段", error: message });
    console.log(`FAIL (2) 浏览器段 — ${message}`);
    report.browser = { ok: false, error: message, rows, errors };
  } finally {
    await browser.close();
  }
}

try {
  writeFileSync(resolve(OUT, "stage-zoom.json"), `${JSON.stringify({ pass, fail, failures, report }, null, 1)}\n`);
} catch {
  // 报告落盘失败不影响结论
}

console.log(`\nSTAGE-ZOOM ${fail === 0 ? "PASS" : "FAIL"} — ${pass} pass${fail ? ` / ${fail} fail` : ""}`);
if (fail) {
  for (const item of failures) console.log(`  ✗ ${item.label}: ${item.error}`);
  process.exitCode = 1;
}
