#!/usr/bin/env node
/**
 * `build/harness/_rail-check.mjs` —— **task-8** 的收口自检：侧边栏（rail）+ 「脱离不留洞」。
 *
 *   node build/harness/_rail-check.mjs                  # 需要 dev server（默认 :5174）
 *   DEV_URL=http://localhost:5174 node build/harness/_rail-check.mjs
 *
 * 用户原话：
 *  - 「窗口里套窗口的操作模式有点恶心 脱离出去就不（脱离）了 为什么还要保留位置」
 *    → 脱离后原地**不留洞**，邻居**填满**；
 *  - 「引入侧边栏的概念 可以快速收缩 集合窗口」
 *    → 左侧 rail 管面板收放（图标 + 整条收起 + 键盘可达）。
 *
 * 断言（`data-*` 锚点，不按像素猜实现）：
 *  (a) `[data-ed-rail="1"]` 存在、`[data-rail-toggle="1"]` 存在（整条收起）；
 *      **tray 语义**（用户口径「侧边栏是用来快速隐藏选择的 而不是可视不可视」
 *      「侧边栏有东西挂到侧边栏才显示的」）：rail 里**只有收起的面板** ——
 *      默认 tree = toolpanel+stage，所以 rail = assets/preview/branch 三条，
 *      且 `data-rail-parked` = 3；
 *  (b) **收起**：点 `[data-wb-panel="toolpanel"]` 标题条的 `⇤`
 *      （`data-win-action="park"`）→ 它从树里消失 + 出现在 rail（`data-rail-item`）；
 *      **放出**：点 rail 上那条 → 回到 `[data-wb-panel]` + 从 rail 消失；
 *      另：`[data-rail-item="assets"]`（默认就挂着）点一下 → assets 进树；
 *  (c) 脱离 `branch` → `[data-wb-float-hole]` 数量 = 0，且**同一 split 里剩下的
 *      面板 rect 比脱离前大 ≥60px**（邻居占满）；
 *  (d) `[data-rail-toggle]` 收起 → 宽度收窄（图标**仍在 DOM**）；
 *      刷新后仍是收起（`stateStore` → 无 Tauri 时 `localStorage: prts-editor-rail`）；
 *  (e) 零新增 JS 报错（既有 `transformCallback` 噪音白名单排除）。
 *
 * 键盘：`ArrowDown/Up` 在图标间移动焦点（本 harness 也断言一次）。
 * **只读断言**：只点 UI / 敲键盘，不改任何源码。
 */
import { chromium } from "playwright-core";

const DEV = process.env.DEV_URL ?? "http://localhost:5174";
const CHROMIUM = process.env.CHROMIUM_PATH || "/snap/bin/chromium";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`ok   ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
};
const info = (label, detail) => console.log(`     ${label}${detail ? ` — ${detail}` : ""}`);

const devUp = async () => {
  try {
    const res = await fetch(`${DEV}/`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
};
if (!(await devUp())) {
  console.log(`FAIL dev server 起不来：${DEV}（先起 \`npx vite frontend --port 5174 --strictPort\`）`);
  process.exit(1);
}

/** 既有噪音（与本任务无关）：
 *  - `transformCallback`：Tauri 桩在纯浏览器里的报错；
 *  - `cdn.jsdelivr.net/gh/djkcyl/arkstage@resources/metadata.json`：引擎/镜像元数据的
 *    网络探测（离线或 CDN 抖动时 `ERR_CONNECTION_CLOSED`），页面自带降级。 */
// 环境噪音（与本 harness 的断言无关）：
//  - `transformCallback`：dev 下 Tauri 桩缺失；
//  - `ERR_FAILED` / `ERR_CONNECTION_CLOSED` / CORS：探测 `torappu.prts.wiki`
//    的素材表时断网/被 CORS 拦（**纯 Vite 下必然发生**，页面里有兜底）。
const KNOWN = /transformCallback|djkcyl\/arkstage@resources\/metadata\.json|ERR_CONNECTION_CLOSED|ERR_FAILED|Failed to load resource|blocked by CORS policy|Access-Control-Allow-Origin/;
const errors = [];

const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--renderer-process-limit=1"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  page.on("pageerror", (error) => {
    const first = String(error?.stack ?? error).split("\n")[0];
    if (!KNOWN.test(first)) errors.push(first);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (!KNOWN.test(text)) errors.push(`console: ${text.split("\n")[0]}`);
  });

  await page.goto(`${DEV}/editor/demo?text=hi`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForSelector("textarea.ed-textarea", { timeout: 60_000 });
  // 干净起点：清掉上次跑批留下的布局 / rail 状态，再刷新。
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("prts-editor-wb:") || key === "prts-editor-rail") localStorage.removeItem(key);
    }
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForSelector("textarea.ed-textarea", { timeout: 60_000 });
  await page.addStyleTag({ content: ".bookshelf-sync-warning,.dl-bar,[data-asset-banner]{display:none !important}" });
  await page.waitForTimeout(900);

  const railSnap = () =>
    page.evaluate(() => {
      const rail = document.querySelector('[data-ed-rail="1"]');
      const rect = rail?.getBoundingClientRect();
      return {
        present: Boolean(rail),
        width: rect ? Math.round(rect.width) : null,
        collapsed: rail?.getAttribute("data-rail-collapsed") === "1",
        items: [...document.querySelectorAll("[data-rail-item]")].map((el) => ({
          id: el.getAttribute("data-rail-item"),
          pressed: el.getAttribute("aria-pressed"),
          visible: el.getBoundingClientRect().width > 0,
        })),
        toggle: Boolean(document.querySelector('[data-rail-toggle="1"]')),
      };
    });
  const panels = () => page.evaluate(() => [...document.querySelectorAll("[data-wb-panel]")].map((el) => el.getAttribute("data-wb-panel")));
  const panelBox = (id) =>
    page.evaluate((panel) => {
      const el = document.querySelector(`[data-wb-panel="${panel}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    }, id);

  // ── (a) rail 存在 + tray 语义 ─────────────────────────────────────
  const snap0 = await railSnap();
  check("(a) `[data-ed-rail=\"1\"]` 存在", snap0.present);
  check("(a) `[data-rail-toggle=\"1\"]` 存在（整条收起入口）", snap0.toggle);
  const treeItems = () => page.evaluate(() => [...document.querySelectorAll("[data-wb-panel]")].map((el) => el.getAttribute("data-wb-panel")));
  const railIds = () => page.evaluate(() => [...document.querySelectorAll("[data-rail-item]")].map((el) => el.getAttribute("data-rail-item")));
  const parkedCount = () => page.evaluate(() => Number(document.querySelector('[data-ed-rail="1"]')?.getAttribute("data-rail-parked") ?? -1));
  check(
    "(a) rail 只挂**收起的**面板：默认 = assets/preview/branch（3 条）",
    (await parkedCount()) === 3 && JSON.stringify(await railIds()) === JSON.stringify(["assets", "preview", "branch"]),
    `parked=${await parkedCount()} ids=${JSON.stringify(await railIds())}`
  );
  check(
    "(a) 工作台里正显示的 toolpanel/stage **不占** rail",
    !(await railIds()).includes("toolpanel") && !(await railIds()).includes("stage"),
    JSON.stringify(await railIds())
  );

  /** 点 rail 条目（`onClick`）。 */
  const clickRail = (id) =>
    page.evaluate((panel) => {
      const el = document.querySelector(`[data-rail-item="${panel}"]`);
      if (!el) return false;
      el.click();
      return true;
    }, id);

  // ── (b) 收起（⇤ = 挂到 rail）/ 放出（点 rail 条目）──────────────
  check("(b) 点到 `[data-rail-item=\"assets\"]`", await clickRail("assets"));
  await page.waitForTimeout(500);
  const afterAssets = await treeItems();
  check("(b) assets 放出 → `[data-wb-panel=\"assets\"]` 进树", afterAssets.includes("assets"), JSON.stringify(afterAssets));
  check("(b) 放出后它从 rail 消失（托盘里不重复）", !(await railIds()).includes("assets"), JSON.stringify(await railIds()));

  const parked = await page.evaluate(() => {
    const btn = document.querySelector('[data-wb-panel="toolpanel"] [data-win-action="park"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  check("(b) toolpanel 标题条有 `⇤`（`data-win-action=\"park\"`）", parked);
  await page.waitForTimeout(500);
  const afterPark = await treeItems();
  check("(b) `⇤` → toolpanel 从 `[data-wb-panel]` 消失", !afterPark.includes("toolpanel"), JSON.stringify(afterPark));
  check("(b) `⇤` → toolpanel **挂上** rail（`data-rail-item=toolpanel`）", (await railIds()).includes("toolpanel"), JSON.stringify(await railIds()));
  check(
    "(b) rail 条目带来源标记（`data-rail-reason=park`）",
    (await page.evaluate(() => document.querySelector('[data-rail-item="toolpanel"]')?.getAttribute("data-rail-reason"))) === "park"
  );
  check("(b) 收起 toolpanel 时 assets 不受影响（仍在树里）", afterPark.includes("assets"), JSON.stringify(afterPark));
  check(
    "(b) `data-rail-parked` = 托盘条目数（toolpanel 挂上后仍 =3）",
    (await parkedCount()) === (await railIds()).length,
    `parked=${await parkedCount()} ids=${JSON.stringify(await railIds())}`
  );

  check("(b) 点 rail 上那条 → toolpanel 回树", await clickRail("toolpanel"));
  await page.waitForTimeout(500);
  const afterRestore = await treeItems();
  check("(b) toolpanel 回到 `[data-wb-panel]`", afterRestore.includes("toolpanel"), JSON.stringify(afterRestore));
  check("(b) toolpanel 同时从 rail 消失", !(await railIds()).includes("toolpanel"), JSON.stringify(await railIds()));

  // 键盘：`ArrowDown` 在托盘条目间移动焦点（从第一条到第二条）。
  const railOrder = await railIds();
  await page.evaluate((first) => document.querySelector(`[data-rail-item="${first}"]`)?.focus(), railOrder[0]);
  await page.keyboard.press("ArrowDown");
  const focused = await page.evaluate(() => document.activeElement?.getAttribute?.("data-rail-item") ?? null);
  check("(b) `ArrowDown` 把焦点移到下一条", focused === railOrder[1], `order=${JSON.stringify(railOrder)} focus=${focused}`);

  // 竖排文字：中文标题必须**竖排**且不被截断。
  const vertical = await page.evaluate(() => {
    const label = document.querySelector('[data-rail-item="preview"] .ed-rail-label');
    if (!label) return null;
    const cs = getComputedStyle(label);
    const r = label.getBoundingClientRect();
    return { writingMode: cs.writingMode, clientH: Math.round(label.clientHeight), scrollH: Math.round(label.scrollHeight), h: Math.round(r.height), text: label.textContent };
  });
  check(
    "(b) rail 文字**竖排**（`writing-mode: vertical-rl`）且不截断",
    Boolean(vertical) && vertical.writingMode.startsWith("vertical") && vertical.scrollH <= vertical.clientH + 1,
    JSON.stringify(vertical)
  );

  // ── (c) 脱离不留洞 + 邻居填满 ─────────────────────────────────────
  check("(c) 从 rail 放出 branch", await clickRail("branch"));
  await page.waitForTimeout(700);
  const widthOfAll = () =>
    page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll("[data-wb-panel]")].map((el) => {
          const r = el.getBoundingClientRect();
          return [el.getAttribute("data-wb-panel"), { w: Math.round(r.width), h: Math.round(r.height) }];
        })
      )
    );
  const beforeDetach = await widthOfAll();
  const detached = await page.evaluate(() => {
    const btn = document.querySelector('[data-wb-panel="branch"] [data-win-action="float"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  check("(c) 找到 branch 的「分离」（⧉）按钮", detached);
  await page.waitForTimeout(600);
  const holes = await page.evaluate(() => [...document.querySelectorAll("[data-wb-float-hole]")].map((el) => el.getAttribute("data-wb-float-hole")));
  const holesAll = await page.evaluate(() => document.querySelectorAll("[data-wb-float-hole]").length);
  check("(c) 脱离后 `[data-wb-float-hole]` 数量 = 0（原地不留洞）", holesAll === 0, `holes=${JSON.stringify(holes)}`);
  const inLayer = await page.evaluate(() => Boolean(document.querySelector('[data-wb-float-layer] [data-win-state="float"]')));
  check("(c) 浮动窗仍在 `[data-wb-float-layer]` 里（浮动本身保留）", inLayer);
  check("(c) 树里也没了 branch（位置让给邻居）", !(await treeItems()).includes("branch"), JSON.stringify(await treeItems()));
  check(
    "(c) 脱离的面板**不占** rail（它还在浮动，不是收起）",
    !(await railIds()).includes("branch"),
    JSON.stringify(await railIds())
  );

  const afterDetach = await widthOfAll();
  const growth = Object.entries(afterDetach)
    .filter(([id]) => id !== "branch")
    .map(([id, box]) => {
      const before = beforeDetach[id];
      if (!before) return { id, dw: box.w, dh: box.h };
      return { id, dw: box.w - before.w, dh: box.h - before.h };
    });
  const best = growth.reduce((acc, item) => (acc && acc.dw >= item.dw ? acc : item), null);
  check(
    "(c) 邻居被撑大（同一 split 里剩下某面板宽或高 +≥60px）",
    Boolean(best) && (best.dw >= 60 || best.dh >= 60),
    `before=${JSON.stringify(beforeDetach)} after=${JSON.stringify(afterDetach)} growth=${JSON.stringify(growth)}`
  );
  info("(c) 邻居增量", JSON.stringify(growth));

  // 停靠回来：⧉ → 回树（同一面板从浮动层回工作台）。
  await page.evaluate(() => document.querySelector('[data-wb-float-layer] [data-win="分支图"] [data-win-action="float"]')?.click());
  await page.waitForTimeout(500);
  check("(c) 「还原/停靠」→ branch 回到树里", (await treeItems()).includes("branch"), JSON.stringify(await treeItems()));

  // ── (d) rail 整条收起 → 刷新后仍是收起 ───────────────────────────
  await page.evaluate(() => document.querySelector('[data-rail-toggle="1"]')?.click());
  await page.waitForTimeout(500);
  const parkedBefore = await railIds();
  const collapsed = await railSnap();
  check("(d) 收起后 rail 变窄（≤24px）", collapsed.width !== null && collapsed.width <= 24, `width=${collapsed.width}px`);
  check(
    "(d) 收起后**不卸载**：托盘条目仍在 DOM 且仍可点",
    collapsed.items.length === parkedBefore.length && collapsed.items.every((it) => it.visible),
    JSON.stringify(collapsed.items.map((it) => `${it.id}:${it.visible ? "visible" : "hidden"}`))
  );
  const stored = await page.evaluate(() => localStorage.getItem("prts-editor-rail"));
  check("(d) 状态落 `prts-editor-rail`（stateStore scope=workspace）", stored === "collapsed", `value=${stored}`);

  await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForSelector("textarea.ed-textarea", { timeout: 60_000 });
  await page.addStyleTag({ content: ".bookshelf-sync-warning,.dl-bar,[data-asset-banner]{display:none !important}" });
  await page.waitForTimeout(900);
  const afterReload = await railSnap();
  check(
    "(d) 刷新后仍是收起（`data-rail-collapsed=1` + 宽度 ≤34px）",
    afterReload.collapsed && afterReload.width !== null && afterReload.width <= 24,
    `collapsed=${afterReload.collapsed} width=${afterReload.width}`
  );
  check(
    "(d) 刷新后托盘条目数与收起前一致",
    afterReload.items.length === parkedBefore.length,
    `before=${JSON.stringify(parkedBefore)} after=${JSON.stringify(afterReload.items.map((it) => it.id))}`
  );

  // 还原成展开（别把状态留给下一个 harness）。
  await page.evaluate(() => document.querySelector('[data-rail-toggle="1"]')?.click());
  await page.waitForTimeout(400);
  check("(d) 再点 toggle → 展开（width ≥ 26px）", (await railSnap()).width >= 26, `width=${(await railSnap()).width}`);

  await page.screenshot({ path: "build/harness/shots/rail.png" }).catch(() => {});
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("prts-editor-wb:") || key === "prts-editor-rail") localStorage.removeItem(key);
    }
  }).catch(() => {});

  // ── (e) 零新增 JS 报错 ────────────────────────────────────────
  check("(e) 零新增 JS 报错（`transformCallback` 白名单已排除）", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (error) {
  check("harness 未抛异常", false, String(error?.message ?? error).split("\n")[0]);
} finally {
  await browser.close();
}

console.log(`\n=== rail-check: ${pass} ok / ${fail} fail ===`);
process.exit(fail ? 1 : 0);
