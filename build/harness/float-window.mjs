#!/usr/bin/env node
/**
 * `build/harness/float-window.mjs` —— **工作台划区 / 浮动窗** 的 7 条冻结契约（task-12）。
 *
 *   node build/harness/float-window.mjs                     # 需要 dev server（默认 :5174）
 *   DEV_URL=http://localhost:5174 node build/harness/float-window.mjs
 *
 * 契约（**用 `data-*` 锚点，不按像素猜实现**）：
 *   1. `[data-wb-gutter]` 视觉宽 ≤ 4px，命中区（`::after` / `elementFromPoint`）≥ 12px；
 *   2. 四个面板标题条都能「分离」（`[data-win-action="float"]`）；`close` 只在 preview / branch；
 *   3. 点 toolpanel 的 `float` → `[data-wb-float-layer]` 里出现 `[data-win-state="float"]`，
 *      且**不在** `[data-wb-panel]` 内（`closest('[data-wb-panel]') === null`）；
 *   4. 分离后树里仍有 `[data-wb-panel="toolpanel"]`，其中含 `[data-wb-float-hole="toolpanel"]` 占位；
 *   5. 浮动窗拖到工作台上方后：`rect.top < [data-workbench].top` 且 `elementFromPoint(中心)` 命中它
 *      （**不被裁剪**）；
 *   6. 双击浮动窗标题条 → 回到树里（`[data-wb-panel]` 内又有 `.ed-win`，浮动层里没有该 id）；
 *   7. 刷新后仍在浮动：先看 DOM（浮动层里有）；DOM 没恢复也要**记忆里有**
 *      （`localStorage` 的 `prts-editor-wb:view` / 旧键，`floats.<id>` 有值）。
 *
 * 约定同其它 harness：无头 chromium（`CHROMIUM_PATH` 可覆盖）、注入 CSS 隐藏
 * `.bookshelf-sync-warning` / `.dl-bar`、ok/FAIL 逐条打印、任一 FAIL → 退出码 1。
 * **只读断言**：harness 只点 UI（标题条按钮 / 拖拽），不改任何源码。
 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { chromium } from "playwright-core";

const DEV = process.env.DEV_URL ?? "http://localhost:5174";
const CHROMIUM = process.env.CHROMIUM_PATH || "/snap/bin/chromium";

const SCRIPT = [
  '[Character(name="char_002_amiya_1",fadetime=0.5)]',
  '[Decision(options="A;B",values="1;2")]',
  '[Predicate(references="1")]',
  '[name="阿米娅"]  A',
  '[Predicate(references="2")]',
  '[name="阿米娅"]  B',
  '[Predicate(references="1;2")]',
  '[name="阿米娅"]  merge',
].join("\n");

const results = [];
let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  if (ok) { pass += 1; console.log(`ok   ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
};
const info = (label, detail) => console.log(`     ${label}${detail ? ` — ${detail}` : ""}`);

/** 浮动层里某个 id 的浮动窗（`data-wb-float-layer` 内的那个 `[data-win]`）。 */
async function devServerUp() {
  try {
    const res = await fetch(`${DEV}/`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

if (!(await devServerUp())) {
  console.log(`dev server 不在 ${DEV} → 自己拉一个（nohup npm run dev）…`);
  spawn("npm", ["run", "dev"], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", openSync("/tmp/arkstage-vite.log", "a"), openSync("/tmp/arkstage-vite.log", "a")],
  }).unref();
  for (let i = 0; i < 40 && !(await devServerUp()); i += 1) await new Promise((done) => setTimeout(done, 1000));
}
if (!(await devServerUp())) {
  console.log(`FAIL dev server 起不来：${DEV}（看 /tmp/arkstage-vite.log）`);
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--renderer-process-limit=1", "--js-flags=--max-old-space-size=256"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  page.on("pageerror", (error) => info("pageerror", String(error).split("\n")[0]));
  await page.goto(`${DEV}/editor/demo?text=${encodeURIComponent(SCRIPT)}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea.ed-textarea", { timeout: 25000 });
  await page.addStyleTag({ content: ".bookshelf-sync-warning,.dl-bar{display:none !important}" });
  // 之前的跑批可能留下浮动状态 / 布局 → 清一次，保证从默认树开始（本 harness 自己写回自己的）。
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("prts-editor-wb:") || key.startsWith("prts-editor-windows:")) localStorage.removeItem(key);
    }
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea.ed-textarea", { timeout: 25000 });
  await page.addStyleTag({ content: ".bookshelf-sync-warning,.dl-bar{display:none !important}" });
  await page.waitForTimeout(900);

  const clickAction = (id, action) =>
    page.evaluate(
      ([panel, name]) => {
        const el = document.querySelector(`[data-wb-panel="${panel}"] [data-win-action="${name}"]`);
        if (!el) return false;
        el.click();
        return true;
      },
      [id, action]
    );

  // ⑩ 先打开两个 Map 面板（preview / branch 的契约都要它们在树里）
  const toolbar = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll(".ed-viewtabs .ed-btn")];
    const preview = buttons.find((el) => /预览/.test(el.textContent));
    const branch = buttons.find((el) => /分支图/.test(el.textContent));
    preview?.click();
    branch?.click();
    return { preview: Boolean(preview), branch: Boolean(branch) };
  });
  await page.waitForTimeout(700);
  const panelsNow = await page.evaluate(() => [...document.querySelectorAll("[data-wb-panel]")].map((el) => el.getAttribute("data-wb-panel")));
  check("前置：4 个面板块都在工作台里", ["toolpanel", "stage", "preview", "branch"].every((id) => panelsNow.includes(id)), `panels=${JSON.stringify(panelsNow)} (toolbar ${JSON.stringify(toolbar)})`);

  // ── 契约 1：分隔条「视觉细、命中宽」 ──────────────────────────────────────
  const gutter = await page.evaluate(() => {
    const gutters = [...document.querySelectorAll("[data-wb-gutter]")];
    const sample = gutters.map((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el, "::after");
      const row = el.getAttribute("data-wb-dir") !== "col";
      // `::after` 命中区外扩量（left/right 或 top/bottom），负数 = 外扩。
      const outA = parseFloat(row ? style.left : style.top);
      const outB = parseFloat(row ? style.right : style.bottom);
      const visual = row ? rect.width : rect.height;
      const grow = -(Number.isFinite(outA) ? outA : 0) - (Number.isFinite(outB) ? outB : 0);
      return { visual: Math.round(visual * 100) / 100, grow: Math.round(grow * 100) / 100, hit: Math.round((visual + grow) * 100) / 100 };
    });
    return { count: gutters.length, sample };
  });
  check(
    "① 分隔条视觉宽 ≤ 4px",
    gutter.count > 0 && gutter.sample.every((item) => item.visual <= 4.01),
    `gutters=${gutter.count} visual=${JSON.stringify(gutter.sample.map((item) => item.visual))}`
  );
  check(
    "① 分隔条命中区 ≥ 12px（::after 外扩）",
    gutter.sample.every((item) => item.hit >= 12),
    `hit=${JSON.stringify(gutter.sample.map((item) => item.hit))} (grow=${JSON.stringify(gutter.sample.map((item) => item.grow))})`
  );

  // 命中实测：在分隔条中心 ±5px 取样，命中它的比例（视觉 4px 时中心两侧 5px 只有 ::after 能救）
  const gutterHit = await page.evaluate(() => {
    const el = document.querySelector("[data-wb-gutter]");
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const row = el.getAttribute("data-wb-dir") !== "col";
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const probes = [-5, -4, 4, 5].map((delta) => {
      const hit = document.elementFromPoint(row ? cx + delta : cx, row ? cy : cy + delta);
      return { delta, hit: Boolean(hit?.closest?.("[data-wb-gutter]")) };
    });
    return { row, probes, hits: probes.filter((item) => item.hit).length };
  });
  check(
    "① elementFromPoint 在分隔条 ±5px 命中它（≥12px 命中区）",
    Boolean(gutterHit) && gutterHit.hits >= 4,
    gutterHit ? `dir=${gutterHit.row ? "row" : "col"} hits=${gutterHit.hits}/4 ${JSON.stringify(gutterHit.probes)}` : "无分隔条"
  );

  // ── 契约 2：每个面板都能「分离」；`close` 只在 Map ──────────────────────
  const actionMap = await page.evaluate(() =>
    Object.fromEntries(
      ["toolpanel", "stage", "preview", "branch"].map((id) => [
        id,
        {
          exists: Boolean(document.querySelector(`[data-wb-panel="${id}"]`)),
          float: Boolean(document.querySelector(`[data-wb-panel="${id}"] [data-win-action="float"]`)),
          close: Boolean(document.querySelector(`[data-wb-panel="${id}"] [data-win-action="close"]`)),
        },
      ])
    )
  );
  const missingPanels = Object.entries(actionMap).filter(([, v]) => !v.exists).map(([id]) => id);
  check("② 四个面板都有「分离」按钮", Object.values(actionMap).every((v) => v.float), `missingFloat=${JSON.stringify(Object.entries(actionMap).filter(([, v]) => !v.float).map(([id]) => id))}${missingPanels.length ? ` missingPanel=${JSON.stringify(missingPanels)}` : ""}`);
  check(
    "② close（✕）只在 preview / branch",
    actionMap.toolpanel.close === false && actionMap.stage.close === false && actionMap.preview.close === true && actionMap.branch.close === true,
    JSON.stringify(Object.fromEntries(Object.entries(actionMap).map(([id, v]) => [id, v.close])))
  );

  // ── 契约 3 / 4：分离（点 `float`）→ 浮动层 + 树里留占位 ────────────────
  const clicked = await clickAction("toolpanel", "float");
  check("③ 找到 toolpanel 的「分离」按钮并可点击", clicked);
  await page.waitForTimeout(500);

  const sep = await page.evaluate(() => {
    const layer = document.querySelector("[data-wb-float-layer]");
    const floats = layer ? [...layer.querySelectorAll('[data-win-state="float"]')] : [];
    const inTreeFloats = [...document.querySelectorAll('[data-wb-panel] [data-win-state="float"]')];
    return {
      layerPresent: Boolean(layer),
      layerFloatCount: floats.length,
      detached: floats.length > 0 && floats.every((el) => el.closest("[data-wb-panel]") === null),
      stillFloatingInTree: inTreeFloats.length,
      panelStillThere: Boolean(document.querySelector('[data-wb-panel="toolpanel"]')),
      hole: Boolean(document.querySelector('[data-wb-panel="toolpanel"] [data-wb-float-hole="toolpanel"], [data-wb-float-hole="toolpanel"]')),
    };
  });
  check("③ 分离后浮动层里有浮动窗", sep.layerPresent && sep.layerFloatCount >= 1, `layer=${sep.layerPresent} float=${sep.layerFloatCount}`);
  check("③ 浮动窗**不在** `[data-wb-panel]` 里（`closest` 为 null）", sep.detached, `inTreeFloats=${sep.stillFloatingInTree}`);
  check("④ 树里仍有 `[data-wb-panel=toolpanel]`", sep.panelStillThere);
  check("④ 树里含 `[data-wb-float-hole=toolpanel]` 占位", sep.hole);

  // ── 契约 5：拖到工作台上方 —— 不被裁剪 ─────────────────────────────────
  // `snapshot` 里锚定"当前这个浮动窗"（层里的优先）与工作台；拖动后再量一次。
  const probeFloat = `(() => {
    const layer = document.querySelector("[data-wb-float-layer]");
    const win = layer?.querySelector('[data-win-state="float"]') ?? document.querySelector('[data-win-state="float"]');
    const wb = document.querySelector("[data-workbench]");
    if (!win || !wb) return null;
    const r = win.getBoundingClientRect();
    const b = wb.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      top: Math.round(r.top), wbTop: Math.round(b.top),
      centerHit: Boolean(hit?.closest?.(".ed-win")),
      hitTag: hit?.tagName ?? null,
      inLayer: Boolean(win.closest("[data-wb-float-layer]")),
    };
  })()`;
  const beforeDrag = await page.evaluate(probeFloat);
  const handleEl = (await page.evaluateHandle(`(() => {
    const layer = document.querySelector("[data-wb-float-layer]");
    const win = layer?.querySelector('[data-win-state="float"]') ?? document.querySelector('[data-win-state="float"]');
    return win?.querySelector(".ed-win-bar") ?? null;
  })()`)).asElement();
  if (!handleEl || !beforeDrag) {
    check("⑤ 浮动窗可拖动（找不到标题条）", false, `handle=${Boolean(handleEl)} probe=${JSON.stringify(beforeDrag)}`);
  } else {
    const box = await handleEl.boundingBox();
    const delta = Math.max(6, beforeDrag.wbTop - 110) - box.y;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + delta, { steps: 14 });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + delta, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(450);
    const after = await page.evaluate(probeFloat);
    check("⑤ 浮动窗顶部真的在工作台上方（未被裁剪）", Boolean(after) && after.top < after.wbTop, after ? `top=${after.top} < wbTop=${after.wbTop}` : "浮动窗消失");
    check("⑤ 中心 `elementFromPoint` 命中窗口", Boolean(after?.centerHit), after ? `hit=${after.hitTag} inLayer=${after.inLayer}` : "-");
  }

  // ── 契约 6：双击标题条 → 回树 ─────────────────────────────────────────
  // （浮动窗既可能在 `[data-wb-float-layer]` 里，也可能是"留在 `[data-wb-panel]` 内的
  //   浮动块"——两种实现都接受；判据统一：**双击后它必须回到树里**。）
  // ⚠️ 用 `page.mouse.dblclick(坐标)` 而不是 elementHandle.dblclick：拖动会触发重渲染，
  // 旧的 handle 可能已 detach（`{force:true}` 会把事件派发给 detached 节点 → 静默无效）。
  // ⚠️ ⑤ 把浮动窗拖到了工作台上方（top < wbTop），那里可能被 `.ed-header` 等高层元素盖住
  // → 中心点 `elementFromPoint` 命中的不一定是标题条。这里**扫一遍窗口矩形**，
  // 找一个"命中解析回同一个浮动窗、且落在 `.ed-win-bar` 上"的点来双击。
  const dblScan = await page.evaluate(() => {
    const layer = document.querySelector("[data-wb-float-layer]");
    const win = layer?.querySelector('[data-win-state="float"]') ?? document.querySelector('[data-win-state="float"]');
    if (!win) return null;
    const r = win.getBoundingClientRect();
    const hits = [];
    for (let gy = r.top + 4; gy < r.bottom - 2; gy += 6) {
      for (let gx = r.left + 6; gx < r.right - 6; gx += 12) {
        const el = document.elementFromPoint(gx, gy);
        if (el?.closest?.('[data-win-state="float"]') === win) hits.push({ x: Math.round(gx), y: Math.round(gy), bar: Boolean(el.closest(".ed-win-bar")) });
      }
    }
    const barHit = hits.find((item) => item.bar);
    return { rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, total: hits.length, bar: hits.filter((i) => i.bar).length, pick: barHit ?? hits[0] ?? null };
  });
  info("⑥ 浮动窗可命中区", JSON.stringify(dblScan));
  const dblBox = dblScan?.pick ?? null;
  if (dblBox) {
    await page.mouse.dblclick(dblBox.x, dblBox.y);
  } else {
    await page.evaluate(() => document.querySelector('[data-wb-panel="toolpanel"] [data-win-action="float"]')?.click());
  }
  await page.waitForTimeout(700);
  const back = await page.evaluate(() => {
    const layer = document.querySelector("[data-wb-float-layer]");
    return {
      inTree: Boolean(document.querySelector('[data-wb-panel="toolpanel"] .ed-win')),
      inTreeFloating: Boolean(document.querySelector('[data-wb-panel="toolpanel"] [data-win-state="float"]')),
      inLayer: layer ? [...layer.querySelectorAll("[data-win]")].length : 0,
      hole: Boolean(document.querySelector('[data-wb-float-hole="toolpanel"]')),
      detached: Boolean(document.querySelector('[data-wb-float-layer] [data-win-state="float"]')),
    };
  });
  check("⑥ 双击 → `[data-wb-panel=toolpanel]` 里又出现 `.ed-win`", back.inTree);
  check("⑥ 不再是「脱离的浮动窗」（浮动层里没有它）", !back.detached, `layerWins=${back.inLayer} detached=${back.detached} hole=${back.hole}`);

  // ── 契约 7：刷新后仍在浮动（DOM 恢复优先，记忆键兜底）──────────────────
  const reclick = await clickAction("toolpanel", "float");
  check("⑦ 再次分离（准备刷新）", reclick);
  await page.waitForTimeout(500);
  const beforeReload = await page.evaluate(() => {
    const layer = document.querySelector("[data-wb-float-layer]");
    const floatingLayerCount = layer ? [...layer.querySelectorAll('[data-win-state="float"]')].length : 0;
    // 刷新前的**运行时**浮动集：`data-wb-float-hole` / `data-wb-float` 都算锚点。
    const holes = [...document.querySelectorAll("[data-wb-float-hole]")].map((el) => el.getAttribute("data-wb-float-hole"));
    const markers = [...document.querySelectorAll("[data-wb-float]")].map((el) => el.getAttribute("data-wb-float"));
    return {
      floatingLayerCount,
      holes,
      markers,
      view: localStorage.getItem("prts-editor-wb:view"),
      legacy: localStorage.getItem("prts-editor-windows:panel"),
    };
  });
  /** 记忆里有没有 `toolpanel` 的浮动（新键 `prts-editor-wb:view` → 旧键）。 */
  const memoryHasFloat = (raw, id) => {
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.floats?.[id]) return true;
      if (parsed?.win?.[id]?.kind === "float") return true;
      if (parsed?.kind === "float" && parsed?.rect) return true; // 旧单窗形状
    } catch { /* 非 JSON：下面用正则兜底 */ }
    return new RegExp(`"?${id}"?\\s*:\\s*\\{[^}]*"?(w|width)"?`, "i").test(raw);
  };
  const memoryHit = memoryHasFloat(beforeReload.view, "toolpanel") || memoryHasFloat(beforeReload.legacy, "toolpanel");
  check(
    "⑦ 分离后（刷新前）：浮动层/占位锚点/记忆键 至少一处记着 toolpanel 的浮动",
    Boolean(reclick) && (beforeReload.floatingLayerCount >= 1 || beforeReload.holes.includes("toolpanel") || beforeReload.markers.includes("toolpanel") || memoryHit),
    `layerFloat=${beforeReload.floatingLayerCount} holes=${JSON.stringify(beforeReload.holes)} markers=${JSON.stringify(beforeReload.markers)} memory=${memoryHit}`
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea.ed-textarea", { timeout: 25000 });
  await page.addStyleTag({ content: ".bookshelf-sync-warning,.dl-bar{display:none !important}" });
  await page.waitForTimeout(1000);
  const afterReload = await page.evaluate(() => {
    const layer = document.querySelector("[data-wb-float-layer]");
    return {
      inLayer: layer ? [...layer.querySelectorAll('[data-win-state="float"]')].length : 0,
      holes: [...document.querySelectorAll("[data-wb-float-hole]")].map((el) => el.getAttribute("data-wb-float-hole")),
      buttons: Boolean(document.querySelector('[data-wb-panel="toolpanel"] [data-win-action="float"]')),
      view: localStorage.getItem("prts-editor-wb:view"),
    };
  });
  const memoryAfter = memoryHasFloat(afterReload.view, "toolpanel");
  check(
    "⑦ 刷新后：DOM 里仍是浮动（层里 / 占位锚点）或 记忆里仍有 `floats.toolpanel`",
    afterReload.inLayer >= 1 || afterReload.holes.includes("toolpanel") || memoryAfter,
    `afterReload(layer=${afterReload.inLayer}, holes=${JSON.stringify(afterReload.holes)}) memory=${memoryAfter} view=${String(afterReload.view).slice(0, 140)}`
  );
  info("⑦ 记忆键", `prts-editor-wb:view=${String(beforeReload.view).slice(0, 110)}`);
  info("⑦ 刷新后记忆键", String(afterReload.view).slice(0, 110));

  // ── 契约 8：**拖出去**也能分离（"可拖到任意位置"的入口之一）──────────
  // 先把 toolpanel 收回树（⑦ 之后它可能还浮着），再拖 branch 的标题条到工作台**外**。
  await page.evaluate(() => {
    document.querySelector('[data-wb-float-layer] [data-win="工具面板"] [data-win-action="float"]')?.click();
  });
  await page.waitForTimeout(400);
  if (!(await page.locator('[data-wb-panel="branch"]').count())) {
    await page.evaluate(() => {
      [...document.querySelectorAll(".ed-viewtabs .ed-btn")].find((el) => el.textContent.includes("分支图"))?.click();
    });
    await page.waitForTimeout(800);
  }
  const barBox = await page.locator('[data-wb-panel="branch"] .ed-win-bar').first().boundingBox();
  let dragOut = null;
  if (barBox) {
    const wbTop = await page.evaluate(() => Math.round(document.querySelector("[data-workbench]").getBoundingClientRect().top));
    await page.mouse.move(barBox.x + 60, barBox.y + 12);
    await page.mouse.down();
    await page.mouse.move(barBox.x + 60, barBox.y + 12, { steps: 2 });   // 过 4px 阈值
    await page.mouse.move(320, 12, { steps: 14 });                       // 拖到页头（工作台之外）
    await page.waitForTimeout(200);
    const hint = await page.evaluate(() => ({
      cls: Boolean(document.querySelector(".wb-root--detaching")),
      text: document.querySelector(".wb-root--detaching")?.getAttribute("data-detach-hint") ?? null,
    }));
    check("⑧ 拖到工作台外：出现「松手 = 分离」提示", hint.cls || Boolean(hint.text), `cls=${hint.cls} text=${hint.text}`);
    await page.mouse.up();
    await page.waitForTimeout(500);
    dragOut = await page.evaluate(() => {
      const f = document.querySelector('[data-wb-float-layer] [data-win="分支图"]');
      const r = f?.getBoundingClientRect();
      return {
        detached: Boolean(f),
        closest: f ? Boolean(f.closest("[data-wb-panel]")) : null,
        top: r ? Math.round(r.top) : null,
        wbTop: Math.round(document.querySelector("[data-workbench]").getBoundingClientRect().top),
      };
    });
    check("⑧ 松手 → 变成浮动层里的独立窗口（closest 为 null）",
      Boolean(dragOut?.detached) && dragOut?.closest === false, JSON.stringify(dragOut));
    check("⑧ 拖出去的窗落在工作台**之上**（任意位置）",
      typeof dragOut?.top === "number" && dragOut.top < dragOut.wbTop, `top=${dragOut?.top} < wbTop=${dragOut?.wbTop}`);
  } else {
    check("⑧ 找到 branch 标题条（拖出去用）", false, "boundingBox=null");
  }

  // ── 契约 9：分离窗的右下角手柄仍可缩放（"独立窗口"要有尺寸自由）────────
  const handle = await page.locator('[data-win-state="float"] .ed-win-resize').first().boundingBox().catch(() => null);
  if (handle) {
    const before = await page.locator('[data-win-state="float"]').first().boundingBox();
    await page.mouse.move(handle.x + 5, handle.y + 5);
    await page.mouse.down();
    await page.mouse.move(handle.x + 105, handle.y + 65, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await page.locator('[data-win-state="float"]').first().boundingBox();
    check("⑨ 浮动窗右下角手柄可改尺寸", after.width - before.width > 60 && after.height - before.height > 30,
      `Δ=${Math.round(after.width - before.width)}x${Math.round(after.height - before.height)}`);
  } else {
    check("⑨ 浮动窗有缩放手柄", false, "找不到 .ed-win-resize");
  }

  // ── 契约 10：分离的 Map 面板点 ✕ → 从工作台移除；再开会话仍是**浮动** ──
  await page.evaluate(() => document.querySelector('[data-wb-float-layer] [data-win="分支图"] [data-win-action="close"]')?.click());
  await page.waitForTimeout(600);
  const closed = await page.evaluate(() => ({
    panel: Boolean(document.querySelector('[data-wb-panel="branch"]')),
    inLayer: Boolean(document.querySelector('[data-wb-float-layer] [data-win="分支图"]')),
  }));
  check("⑩ ✕ = 从工作台移除（树与浮动层都没了）", !closed.panel && !closed.inLayer, JSON.stringify(closed));
  await page.evaluate(() => {
    [...document.querySelectorAll(".ed-viewtabs .ed-btn")].find((el) => el.textContent.includes("分支图"))?.click();
  });
  await page.waitForTimeout(800);
  const reopened = await page.evaluate(() => ({
    inLayer: Boolean(document.querySelector('[data-wb-float-layer] [data-win="分支图"]')),
    docked: Boolean(document.querySelector('[data-wb-panel="branch"] .ed-win')),
  }));
  check("⑩ 重开 → 仍在浮动层（记住「分离」这件事）", reopened.inLayer && !reopened.docked, JSON.stringify(reopened));

  // ── 契约 11：预览（**命令式** iframe）在「分离」时不丢 ──────────────────
  // 预览 iframe 是 `hostRef` 里 appendChild 出来的：面板换壳（树 ↔ 浮动层）时
  // React 会重建宿主 → 若不做 re-parent，演出就断了（状态条却还写"预览运行中"）。
  // 判据 = **元素同一性**：分离前记下那个 iframe，分离后它必须还在（且在层里）。
  if (!(await page.locator('[data-wb-panel="preview"]').count())) {
    await page.evaluate(() => {
      [...document.querySelectorAll(".ed-viewtabs .ed-btn")].find((el) => el.textContent.trim() === "预览")?.click();
    });
    await page.waitForTimeout(800);
  }
  // 起一次真预览（`/editor/demo` 里引擎可能报"接口未初始化"，但 iframe 一定会建）。
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.ed-preview-bar button, .ed-preview-bar .ed-btn')]
      .find((el) => /预览|载入/.test(el.textContent ?? ""));
    btn?.click();
  });
  await page.waitForTimeout(1500);
  const marked = await page.evaluate(() => {
    const frame = document.querySelector('[data-wb-panel="preview"] .ed-preview-frame iframe')
      ?? document.querySelector('.ed-preview-frame iframe');
    if (!frame) return false;
    window.__keepFrame = frame;
    window.__keepTitle = frame.getAttribute("title") ?? "";
    return true;
  });
  if (marked) {
    await page.evaluate(() => document.querySelector('[data-wb-panel="preview"] [data-win-action="float"]')?.click());
    await page.waitForTimeout(600);
    const kept = await page.evaluate(() => {
      const alive = window.__keepFrame;
      const now = document.querySelector('.ed-preview-frame iframe');
      const w = document.querySelector('[data-wb-float-layer] [data-win="预览"]');
      return {
        sameNode: Boolean(alive) && now === alive,
        title: now?.getAttribute("title") ?? null,
        inLayer: Boolean(alive && w && w.contains(alive)),
        inTree: Boolean(alive?.closest?.("[data-wb-panel]")),
        frames: document.querySelectorAll("iframe").length,
      };
    });
    check("⑪ 分离预览：同一个 iframe 被搬到浮动层（不重建、不丢）",
      kept.sameNode && kept.inLayer && !kept.inTree, JSON.stringify(kept));
    await page.evaluate(() => document.querySelector('[data-wb-float-layer] [data-win="预览"] [data-win-action="float"]')?.click());
    await page.waitForTimeout(500);
    const back = await page.evaluate(() => {
      const alive = window.__keepFrame;
      const now = document.querySelector('.ed-preview-frame iframe');
      return { sameNode: Boolean(alive) && now === alive, inTree: Boolean(alive?.closest?.('[data-wb-panel="preview"]')) };
    });
    check("⑪ 收回停靠：同一个 iframe 又回到树里（双向 re-parent）", back.sameNode && back.inTree, JSON.stringify(back));
  } else {
    check("⑪ 预览 iframe 建起来了（契约 11 的前置）", false, "找不到 .ed-preview-frame iframe");
  }

  await page.screenshot({ path: "build/harness/shots/float-window.png" }).catch(() => {});
  // **自清理**：别把"浮动/开关"留给下一个 harness（都在同一份 localStorage 上跑）。
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("prts-editor-wb:") || key.startsWith("prts-editor-windows:")) localStorage.removeItem(key);
    }
  }).catch(() => {});
} catch (error) {
  check("harness 未抛异常", false, String(error?.message ?? error).split("\n")[0]);
} finally {
  await browser.close();
}

console.log(`\n=== float-window: ${pass} ok / ${fail} fail ===`);
// 显式退出：`browser.close()` 之后 playwright 的驱动进程句柄偶尔还挂着，
// 不 exit 会出现 "Detected unsettled top-level await"（run.mjs 里会当成超时）。
process.exit(fail ? 1 : 0);
