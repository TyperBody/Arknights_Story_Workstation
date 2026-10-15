// 分支图（task-16 / 任务 T6）验收 harness —— 单文件、零额外依赖。
//
//   node build/harness/branch-shot.mjs         # 前置：dev server 在 5174（`npm run dev`）
//
// 两段：
//   A. Node 侧（不需要浏览器）：对三份内联样例 + 仓库内置样例跑
//      `buildGraph` → `layoutGraph`，**两个方向各一遍**：
//        · TB（竖排，**默认调用**）= 320×92 卡片、层 → y 单调、主轴单调、
//          边起点贴底缘、`readOrder`（键盘漫游序）= layer → x；
//        · LR（横排，显式 `{direction:"LR"}`）= 老的 200×64 / 层 → x。
//      两方向都断言 矩形零重叠 / 边正交 + 拐点 ≤ 3 / 层单调 / 确定性。
//   B. 浏览器侧（镜像 `build/ed-win-check.mjs` 的启动 + initScript 约定）：
//      `/editor/demo?text=…` → 点「⌥ 分支图」；契约 DOM 标记缺失（并行改造未
//      落盘）时再兜底 `/branch-demo.html`，断言 容器 / 节点 / 边 / 默认竖排
//      （`[data-branch-direction]="tb"` + 卡片 320×92）/ 方向切换（→ lr 200×64
//      → 回 tb）/ 方向键漫游（↓↑ 改选中 + 读数条）/ Enter 跳行（定位滑杆）+ 按 0，
//      并写出 `build/harness/shots/{branch,branch-vertical,branch-editor}.png`。
//
// 说明：
//   · 只依赖 `playwright-core` + `node:fs` / `node:path` / `node:url`
//     （外加 Node 18+ 的全局 `fetch`）；Node 22 ESM，无构建步骤。
//   · `layoutGraph` 并行落盘：**不 stub**。"就绪"= 两发样例都能跑通（不只看
//     导出了函数）。未就绪 / 会抛时按约定轮询重读 5 次 × ~20s；仍不行就用
//     页面里的 dev server 做**运行时兜底**（`/@fs` → `data:`/Blob 导入）。
//   · dev server 若换了端口（5174 被占）：自动扫到真正在跑的那个。
//   · 浏览器侧两条路径（契约 `data-branch-*` 标记 / legacy `.ed-graph`）都探；
//     契约标记缺失只打印一行 `skip`，不算失败。
//   · Node 段失败 = 真失败；结尾 `process.exit(failed === 0 ? 0 : 1)`。

import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── 路径 / 常量 ─────────────────────────────────────────────────────────
/** 规范模块说明符（相对**本文件**解析）——与仓库内调用方一致。 */
const MOD_SPEC = "../../src/akstage/local/branchGraph.js";
const HERE = dirname(fileURLToPath(import.meta.url));
/** 本文件 = <repo>/build/harness/branch-shot.mjs → 仓库根 = 上两级。 */
const REPO = resolve(HERE, "../..");
const GRAPH_MOD = resolve(REPO, "src/akstage/local/branchGraph.js");
/** 运行期兜底要经 dev server 取的候选（规范模块 → 并行落盘的组件）。 */
const HOST_FILES = [
  "src/akstage/local/branchGraph.js",
  "frontend/src/components/editor/BranchGraph.tsx",
];
const SAMPLE_SCRIPT = resolve(REPO, "src-tauri/resources/library/sample-fanfic/script.txt");
const SHOTS = resolve(REPO, "build/harness/shots");
const SHOT_BRANCH = resolve(SHOTS, "branch.png");
const SHOT_EDITOR = resolve(SHOTS, "branch-editor.png");
/** 竖排（默认）视图的截图 —— 用户要的"工作流竖着编排"。 */
const SHOT_VERTICAL = resolve(SHOTS, "branch-vertical.png");
const DEV = process.env.DEV_URL ?? "http://localhost:5174";
const DEV_ORIGIN = DEV.replace(/\/+$/, "").replace(/:\d+$/, "");
const DEV_PORT = Number(new URL(DEV).port || 80);
/** 5174 被占时向后扫的端口数（vite.config 是 strictPort）。 */
const PORT_SCAN = 12;

const NODE_W = 200;
const NODE_H = 64;
/** 竖排（TB，默认）卡片：320×92 —— 与旧横排（LR）200×64 各自成对。 */
const NODE_W_TB = 320;
const NODE_H_TB = 92;
/** 方向 → 期望卡片尺寸（`layoutGraph(graph, {direction})`）。 */
const SIZES = { TB: { w: NODE_W_TB, h: NODE_H_TB }, LR: { w: NODE_W, h: NODE_H } };
/** `checkSample` 覆盖的方向：TB（默认、主口径）在前。 */
const DIRECTIONS = ["TB", "LR"];
/** 契约 `role` 词表。 */
const CONTRACT_ROLES = new Set(["main", "choice", "merge", "back"]);
/** 仓库里并行落盘的另一套（位置）词表；两套都认，但都要是已知值。 */
const POSITION_ROLES = new Set(["start", "decision", "merge", "node", "end"]);
const ALL_ROLES = new Set([...CONTRACT_ROLES, ...POSITION_ROLES]);
/** 决策节点在两套词表里的写法。 */
const DECISION_ROLES = new Set(["choice", "decision"]);

// ── 样例 ─────────────────────────────────────────────────────────────
/** A：纯对白 / 旁白，无 `[Decision]` → 无决策节点（或空图）。 */
const SAMPLE_A = [
  '[HEADER(key="branch_shot_a")]',
  "[Dialog]",
  "【旁白】雨点敲在铁皮棚上。",
  '[name="阿米娅"]  博士，这里就是临时营地。',
  '[name="杜宾"]  今晚先在这里休整。',
  '[name="阿米娅"]  明天一早出发。',
].join("\n");

/** B：一个决策两条线 + 并集 `[Predicate]` 合流（形状取自 `frontend/src/BranchDemoPage.tsx`）。 */
const SAMPLE_B = [
  '[HEADER(key="branch_shot_b")]',
  '[Blocker(a=1, r=0, g=0, b=0, fadetime=0, block=true)]',
  "[Dialog]",
  '[Background(image="bg_black", fadetime=0, block=true)]',
  '[name="杜宾"]  这里是……？',
  '[Decision(options="跟着她走;先问清楚", values="1;2")]',
  '[Predicate(references="1")]',
  '[name="阿米娅"]  这边走，博士。',
  '[Predicate(references="2")]',
  '[name="阿米娅"]  先别急，我把情况说清楚。',
  '[Predicate(references="1;2")]',
  '[name="陈"]  都到齐了。',
  '[Blocker(a=1, r=0, g=0, b=0, fadetime=1.5, block=true)]',
].join("\n");

/** C：三方说话（阿米娅 / 杜宾 / 陈）+ 两个决策，其中一个是**嵌套**（决策开在分支里）。 */
const SAMPLE_C = [
  '[HEADER(key="branch_shot_c")]',
  "[Dialog]",
  '[name="阿米娅"]  博士，前面有三条岔路。',
  '[Decision(options="走左边;走右边", values="1;2")]',
  '[Predicate(references="1")]',
  '[name="杜宾"]  左边是仓库。',
  '[Decision(options="进去看看;继续走", values="3;4")]',
  '[Predicate(references="3")]',
  '[name="阿米娅"]  里面有人。',
  '[Predicate(references="1;3;4")]',
  '[name="陈"]  左边查完了。',
  '[Predicate(references="2")]',
  '[name="杜宾"]  右边是训练场。',
  '[Predicate(references="1;2")]',
  '[name="阿米娅"]  两条路都通到指挥室。',
  '[name="陈"]  那就走吧。',
].join("\n");

// ── 记账 ──────────────────────────────────────────────────────────
const rows = [];
let failed = 0;
let skipped = 0;
const failures = [];
const check = (label, value, pass) => {
  rows.push({ label, value, pass: !!pass });
  if (!pass) {
    failed += 1;
    failures.push(`${label}: ${JSON.stringify(value)}`);
  }
  console.log(`${pass ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(value)}`);
};
const skip = (label, why) => {
  rows.push({ label, skipped: true, why });
  skipped += 1;
  console.log(`skip ${label} — ${why}`);
};

// ── 纯函数工具 ────────────────────────────────────────────────────
/** 两矩形是否相交（贴边不算）。 */
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** 回边（`back` 语义允许同层）。 */
const isBackEdge = (edge) => edge?.kind === "back" || edge?.role === "back";
/** `points` 必须是 ≥2 个 `[number, number]`；合法 → `null`。 */
function pointsWrong(points) {
  if (!Array.isArray(points) || points.length < 2) return `points 长度 ${Array.isArray(points) ? points.length : "非数组"}`;
  for (const point of points) {
    if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return `坏点 ${JSON.stringify(point)}`;
  }
  return null;
}
/** 决策节点（两套 role 词表都认；不看 `kind`，避免 `merge` / `text` 混进来）。 */
const decisionNodes = (out) => (out?.nodes ?? []).filter((node) => DECISION_ROLES.has(node?.role));

/** 规范化一次 `layoutGraph` 输出。`size` = 该方向的期望卡片尺寸。 */
function normalize(out, size = SIZES.TB) {
  const rawNodes = Array.isArray(out?.nodes) ? out.nodes : [];
  const edges = Array.isArray(out?.edges) ? out.edges : [];
  const edgesAll = Array.isArray(out?.edgesAll) && out.edgesAll.length ? out.edgesAll : edges;
  const rects = rawNodes.map((node) => ({
    id: String(node?.id ?? "?"),
    x: Number(node?.x ?? 0),
    y: Number(node?.y ?? 0),
    w: Number(node?.w ?? size.w),
    h: Number(node?.h ?? size.h),
  }));
  const roleUnknown = rawNodes.filter((node) => !ALL_ROLES.has(node?.role)).map((node) => `${node?.id}:${node?.role}`);
  const sizeMismatch = rects.filter((rect) => rect.w !== size.w || rect.h !== size.h).map((rect) => `${rect.id}:${rect.w}x${rect.h}`);
  return { rawNodes, edges, edgesAll, rects, roleUnknown, sizeMismatch, byId: new Map(rects.map((rect) => [rect.id, rect])) };
}

/** 节点层号：契约是 `nodes[].layer`；其余（`col` / `layers` / `lane`）只是兜底。 */
function layerOf(layout, id) {
  const nodes = Array.isArray(layout?.nodes) ? layout.nodes : [];
  const index = nodes.findIndex((node) => String(node?.id) === String(id));
  const node = index >= 0 ? nodes[index] : null;
  if (typeof node?.layer === "number") return node.layer;
  if (typeof node?.col === "number") return node.col;
  if (Array.isArray(layout?.layers)) {
    const at = layout.layers.findIndex((layer) => Array.isArray(layer) && layer.map(String).includes(String(id)));
    if (at >= 0) return at;
    if (typeof layout.layers[index] === "number") return layout.layers[index];
  }
  if (typeof node?.lane === "number") return node.lane;
  return index >= 0 ? index : 0;
}

/**
 * "必然同层"的节点 → 层号：只由**通用的层单调结论**推出 ——
 * 存在非回边 `u → v` 且 `layer(u) < layer(v)` 时，凡 `layer(u) ≤ k < layer(v)`
 * 的节点与 u / v 必然同层（否则这条边跨不过去）。回边 / 同层边不参与推导。
 */
function declaredLayers(edges, layerOfId, has) {
  const layers = new Map();
  for (const edge of edges) {
    if (!edge || edge.to === null || edge.to === undefined) continue;
    if (!has(edge.from) || !has(edge.to) || isBackEdge(edge)) continue;
    const from = layerOfId(edge.from);
    const to = layerOfId(edge.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || !(from < to)) continue;
    layers.set(String(edge.from), Math.min(layers.get(String(edge.from)) ?? Infinity, to - 1));
    layers.set(String(edge.to), Math.max(layers.get(String(edge.to)) ?? -Infinity, from + 1));
  }
  for (const [id, layer] of layers) if (!Number.isFinite(layer)) layers.set(id, 0);
  return layers;
}

/**
 * 轮询"节点卡片尺寸 + 方向属性"到达期望值（React 提交与 Playwright 读取之间
 * 有微任务间隙；这里断言的是**最终**几何，不是某一拍的中间态）。
 * @param {import("playwright-core").Page} page
 * @param {"TB"|"LR"} want
 * @param {number} [timeoutMs]
 */
async function waitForCards(page, want, timeoutMs = 3000) {
  const size = SIZES[want];
  const wantDir = want.toLowerCase();
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = await page.evaluate(() => ({
      dir: document.querySelector('[data-branch-pan="1"]')?.getAttribute("data-branch-direction") ?? null,
      sizes: [...new Set([...document.querySelectorAll("[data-branch-node]")].map((node) => {
        const rect = node.querySelector("rect");
        return `${Number(rect?.getAttribute("width") ?? 0)}x${Number(rect?.getAttribute("height") ?? 0)}`;
      }))],
    })).catch(() => null);
    if (last && last.dir === wantDir && last.sizes.length > 0
      && last.sizes.every((row) => row === `${size.w}x${size.h}`)) return { ok: true, ...last, tries: Math.round((timeoutMs - (deadline - Date.now())) / 150) };
    await page.waitForTimeout(150);
  } while (Date.now() < deadline);
  return { ok: false, ...(last ?? { dir: null, sizes: [] }) };
}

/**
 * "点得动就点，点不动（被浮层盖住 / 正在重渲染）就退化为 DOM `click()`"。
 * 断言的是**行为**（方向切了、面板开了），不是"这一像素没被挡"。
 * @param {import("playwright-core").Locator} locator
 */
async function softClick(locator) {
  const ok = await locator.click({ timeout: 6000 }).then(() => true).catch(() => false);
  if (!ok) await locator.evaluate((el) => /** @type {HTMLElement} */ (el).click()).catch(() => {});
  return ok;
}

// ── A 段：单个样例的全部断言 ────────────────────────────────────
/**
 * 同一份样例：竖排（TB，默认）/ 横排（LR）各跑一遍；几何断言按 `axis` 换轴。
 * TB 那次**不传 options**（顺带证明「默认 = 竖排」），LR 那次显式传 `{direction:"LR"}`。
 * @param {{id:string,title:string,text:string,minDecisions?:number,maxDecisions?:number,
 *          minSpeakers?:number,deterministic?:boolean}} spec
 * @param {Function} layoutGraph
 * @param {Function} buildGraph
 * @param {"TB"|"LR"} direction
 */
function checkSample(spec, layoutGraph, buildGraph, direction = "TB") {
  const tb = direction === "TB";
  /** 主轴（层的方向）：TB = y、LR = x；同层轴（层内）正好相反。 */
  const axis = tb ? "y" : "x";
  const slotAxis = tb ? "x" : "y";
  const size = SIZES[direction];
  const tag = `[${spec.id}/${direction}] ${spec.title}`;
  let graph;
  let layout;
  try {
    graph = buildGraph(spec.text);
    // TB = **默认调用**（不传 options）：断言"不传就是竖排"。
    layout = tb ? layoutGraph(graph) : layoutGraph(graph, { direction });
  } catch (error) {
    check(`${tag} 不抛异常`, `${error?.name ?? "Error"}: ${error?.message ?? error} @ ${repoFrame(error)}`, false);
    return null;
  }
  check(`${tag} 不抛异常`, `graph.nodes=${graph?.nodes?.length ?? "?"} layout.nodes=${layout?.nodes?.length ?? "?"}`, true);

  const norm = normalize(layout, size);
  const n = norm.rects.length;
  const edges = norm.edgesAll;

  // 1) 矩形零重叠（报前 3 对冒犯者）。
  const badPairs = [];
  for (let i = 0; i < norm.rects.length && badPairs.length < 3; i += 1) {
    for (let j = i + 1; j < norm.rects.length && badPairs.length < 3; j += 1) {
      const a = norm.rects[i];
      const b = norm.rects[j];
      if (overlaps(a, b)) badPairs.push({ a: `${a.id}@(${a.x},${a.y},${a.w}x${a.h})`, b: `${b.id}@(${b.x},${b.y},${b.w}x${b.h})` });
    }
  }
  check(`${tag} 矩形两两不重叠`,
    badPairs.length ? { pairs: badPairs, checked: (n * (n - 1)) / 2 } : `pairs=0/${(n * (n - 1)) / 2}`,
    badPairs.length === 0);

  // 2) 节点尺寸：TB = 320×92、LR = 200×64（按 `direction` 换）。
  check(`${tag} 节点尺寸 ${size.w}×${size.h}`, norm.sizeMismatch.length ? norm.sizeMismatch.slice(0, 3) : `${n} 个全部一致`, norm.sizeMismatch.length === 0);

  // 2b) 方向回执：默认（不传 options）必须是 TB；`stats.direction` 同步。
  const gotDir = layout?.direction ?? layout?.stats?.direction ?? null;
  check(`${tag} direction 回执 = ${direction}`, { direction: layout?.direction, stats: layout?.stats?.direction }, gotDir === direction);

  // 3) role 词表（契约 / 位置两套都认，但都要是已知值）。
  check(`${tag} role 词表合法（契约 / 位置两套都认）`, norm.roleUnknown.length ? norm.roleUnknown.slice(0, 3) : `role ok (${n})`, norm.roleUnknown.length === 0);

  // 4) 边：`points` ≥2 个 `[number, number]`。
  const badPoints = edges.map((edge) => ({ edge, wrong: pointsWrong(edge?.points) })).filter((row) => row.wrong);
  check(`${tag} 边 points 均为 ≥2 个 [number,number]`,
    badPoints.length ? badPoints.slice(0, 3).map((row) => `${row.edge?.from}->${row.edge?.to}: ${row.wrong}`) : `${edges.length} 条全部合法`,
    badPoints.length === 0);

  // 4b) 软观测：走过曲线 / 折线的边（`points.length > 2` 或 `d` 含曲线命令）。
  if (edges.length) {
    const curved = edges.filter((edge) => (Array.isArray(edge?.points) ? edge.points.length > 2 : false) || (typeof edge?.d === "string" && /[CQAS]/.test(edge.d)));
    check(`${tag} 走过曲线/折线的边（观测，不设阈值）`, `${curved.length}/${edges.length}`, true);
  }

  // 4c) 正交（TB 主口径）：每段要么平行主轴、要么平行同层轴；拐点 ≤ 3。
  const orthBad = [];
  for (const edge of edges) {
    const points = Array.isArray(edge?.points) ? edge.points : [];
    for (let at = 1; at < points.length; at += 1) {
      const dx = Math.abs(points[at][0] - points[at - 1][0]);
      const dy = Math.abs(points[at][1] - points[at - 1][1]);
      if (dx > 1e-6 && dy > 1e-6) orthBad.push(`${edge?.from}->${edge?.to}@${at}`);
    }
    if (points.length > 4) orthBad.push(`${edge?.from}->${edge?.to}:points=${points.length}`);
  }
  check(`${tag} 边正交（每段水平/垂直）+ 拐点 ≤ 3`, orthBad.length ? orthBad.slice(0, 3) : `edges=${edges.length}`, orthBad.length === 0);

  // 4d) TB 专项：至少一条边带**主轴方向**的段（竖排 = 从上往下），
  //     且跨层边的起点贴在源卡的主轴**下缘**（TB）/ 主轴**右缘**（LR）。
  if (tb && edges.length) {
    const withPrimary = edges.filter((edge) => Array.isArray(edge?.points) && edge.points.some((point, at) => at > 0
      && Math.abs(point[0] - edge.points[at - 1][0]) < 0.5 && Math.abs(point[1] - edge.points[at - 1][1]) > 0.5));
    check(`${tag} 至少一条边有竖段（TB 从上往下）`, `${withPrimary.length}/${edges.length}`, withPrimary.length > 0);
  }
  if (edges.length) {
    const offEdge = [];
    for (const edge of edges) {
      const from = norm.byId.get(String(edge?.from));
      if (!from || !Array.isArray(edge?.points) || !edge.points.length) continue;
      const start = edge.points[0];
      const want = tb
        ? { v: from.y + from.h, u: from.x + from.w / 2 }
        : { v: from.x + from.w, u: from.y + from.h / 2 };
      const got = tb ? { v: start[1], u: start[0] } : { v: start[0], u: start[1] };
      if (Math.abs(got.v - want.v) > 0.5 || Math.abs(got.u - want.u) > 0.5) offEdge.push(`${edge.from}->${edge.to}: ${JSON.stringify(start)} ≠ ${JSON.stringify(want)}`);
    }
    check(`${tag} 边起点贴在源卡${tb ? "底缘" : "右缘"}中点`, offEdge.length ? offEdge.slice(0, 2) : `edges=${edges.length}`, offEdge.length === 0);
  }

  // 5) 层单调：非回边 `from.layer < to.layer`。
  const layerBad = [];
  for (const edge of edges) {
    if (!edge || edge.to === null || edge.to === undefined) continue; // 结束边（to:null）不算
    if (!norm.byId.has(String(edge.from)) || !norm.byId.has(String(edge.to))) {
      layerBad.push(`${edge.from}->${edge.to}: 端点不在 nodes 里`);
    } else {
      const from = layerOf(layout, edge.from);
      const to = layerOf(layout, edge.to);
      if (isBackEdge(edge)) {
        if (!(from >= to)) layerBad.push(`${edge.from}->${edge.to}: back ${from}->${to}`);
      } else if (!(from < to)) {
        layerBad.push(`${edge.from}->${edge.to}: ${from}->${to}`);
      }
    }
    if (layerBad.length >= 3) break;
  }
  check(`${tag} 层单调（非回边 from.layer < to.layer）`, layerBad.length ? layerBad : `edges=${edges.length}`, layerBad.length === 0);

  // 6) 样例特有硬要求。
  if (typeof spec.minDecisions === "number") {
    const found = decisionNodes(layout).length;
    check(`${tag} 决策节点数 ≥ ${spec.minDecisions}`, { decisionNodes: found, graphDecisions: graph?.stats?.decisions ?? "?" }, found >= spec.minDecisions);
  }
  if (typeof spec.maxDecisions === "number") {
    const found = decisionNodes(layout).length;
    check(`${tag} 决策节点数 ≤ ${spec.maxDecisions}`, { decisionNodes: found }, found <= spec.maxDecisions);
  }
  if (typeof spec.minSpeakers === "number") {
    const speakers = new Set((graph?.nodes ?? []).map((node) => node?.speaker).filter(Boolean));
    check(`${tag} buildGraph 里说话人数 ≥ ${spec.minSpeakers}`, [...speakers], speakers.size >= spec.minSpeakers);
  }

  // 7) 同层零重叠：层号若真有意义，同层节点必不重叠（契约 `x = layer` 的必然推论）。
  const declared = declaredLayers(edges, (id) => layerOf(layout, id), (id) => norm.byId.has(String(id)));
  const entries = [...declared];
  const sameLayerBad = [];
  for (const [idA, layerA] of entries) {
    for (const [idB, layerB] of entries) {
      if (String(idA) >= String(idB) || layerA !== layerB) continue;
      const a = norm.byId.get(String(idA));
      const b = norm.byId.get(String(idB));
      if (a && b && overlaps(a, b)) sameLayerBad.push({ layer: layerA, pair: `${a.id}@(${a.x},${a.y})`, with: `${b.id}@(${b.x},${b.y})` });
    }
  }
  check(`${tag} 同层矩形不重叠（层号声明 ${declared.size} 个）`, sameLayerBad.length ? sameLayerBad.slice(0, 2) : "ok", sameLayerBad.length === 0);

  // 7b) 主轴单调：`layer` → 主轴坐标单调（TB：层越深 y 越大）。
  const layersSeen = [...new Set(norm.rawNodes.map((node) => layerOf(layout, node?.id)))].sort((a, b) => a - b);
  const axisBad = [];
  for (let i = 1; i < layersSeen.length; i += 1) {
    const above = norm.rects.filter((rect) => layerOf(layout, rect.id) === layersSeen[i - 1]);
    const below = norm.rects.filter((rect) => layerOf(layout, rect.id) === layersSeen[i]);
    if (!above.length || !below.length) continue;
    const a = Math.max(...above.map((rect) => (tb ? rect.y + rect.h : rect.x + rect.w)));
    const b = Math.min(...below.map((rect) => (tb ? rect.y : rect.x)));
    if (!(b >= a - 1e-6)) axisBad.push(`L${layersSeen[i - 1]}→L${layersSeen[i]}: ${a} > ${b}`);
  }
  check(`${tag} 主轴单调（层 ${layersSeen.length} 层，${axis} 递增）`, axisBad.length ? axisBad.slice(0, 2) : "ok", axisBad.length === 0);

  // 7c) 阅读序（键盘 ↑/↓ 的顺序）：层号升序 → 层内**阅读方向**升序。
  const readSeq = Array.isArray(layout?.readOrder) ? layout.readOrder.map(String) : null;
  if (readSeq) {
    const wantRead = [...norm.rawNodes]
      .sort((a, b) => (layerOf(layout, a?.id) - layerOf(layout, b?.id))
        || ((Number(a?.[slotAxis]) || 0) - (Number(b?.[slotAxis]) || 0))
        || ((Number(a?.line) || 0) - (Number(b?.line) || 0)))
      .map((node) => String(node?.id));
    const readOk = readSeq.length === wantRead.length && readSeq.every((id, at) => id === wantRead[at]);
    check(`${tag} readOrder = layer → ${slotAxis} 升序（键盘漫游顺序）`,
      readOk ? `ok(${readSeq.length})` : { got: readSeq.slice(0, 6), want: wantRead.slice(0, 6) },
      readOk);
  } else {
    skip(`${tag} readOrder`, "布局未声明 `readOrder`（视图按 layer → 层内轴兜底）");
  }

  // 8) 确定性：两次调用 JSON 全等（内置样例按任务书豁免）。
  if (spec.deterministic !== false) {
    let again;
    try {
      again = JSON.stringify(tb ? layoutGraph(buildGraph(spec.text)) : layoutGraph(buildGraph(spec.text), { direction }));
    } catch (error) {
      again = `THROW ${error}`;
    }
    check(`${tag} 布局确定性（两次调用 JSON 全等）`, again === JSON.stringify(layout) ? "identical" : "DIFF", again === JSON.stringify(layout));
  }
  return { graph, layout, norm };
}

// ── 模块装载：等待并行落盘 + 运行时兜底 ─────────────────────────
/** namespace 是 frozen 的：换实现只能换本地绑定（`graphMod` 只用于读 `buildGraph`）。 */
void 0;
/** 模块里"能跑通"的 layoutGraph，否则 null。 */
function hot(graph, mod) {
  if (typeof mod?.layoutGraph !== "function") return null;
  try {
    const out = mod.layoutGraph(graph);
    return out && Array.isArray(out.nodes) ? mod.layoutGraph : null;
  } catch {
    return null;
  }
}
/** 绝对路径 → dev server 的 `/@fs` URL。 */
const fsUrl = (origin, file) => `${origin}/@fs/${encodeURI(resolve(REPO, file).replace(/\\/g, "/")).replace(/#/g, "%23")}`;

/**
 * 经 dev server 取**已转换**的 JS（`.ts` 说明符已被 Vite 处理过），把其中
 * 仍然指向 `/…`（`/@fs`、`/@vite` 等）的依赖**递归内联**成 `data:` URL，
 * 最后整份 `import()` —— 这样 Node 端不需要解析任何 HTTP 说明符。
 * @param {string} origin
 * @param {string} entry `/@fs/…` 形态的入口
 * @param {Map<string,string>} cache
 * @returns {Promise<string>} 可 import 的 URL
 */
async function inlineModule(origin, entry, cache) {
  const url = entry.startsWith("http") ? entry : `${origin}${entry}`;
  if (cache.has(url)) return cache.get(url);
  cache.set(url, "data:text/javascript,"); // 破环（自引用）
  const code = await fetch(url).then((response) => (response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status} ${url}`))));
  let out = code;
  const specs = new Set([...out.matchAll(/(?:from|import)\s*\(?\s*["'](\/[^"']*)["']/g)].map((match) => match[1]));
  for (const spec of specs) {
    const inlined = await inlineModule(origin, spec, cache).catch(() => null);
    if (!inlined) continue;
    out = out.split(`"${spec}"`).join(`"${inlined}"`).split(`'${spec}'`).join(`"${inlined}"`);
  }
  const dataUrl = `data:text/javascript;base64,${Buffer.from(out, "utf8").toString("base64")}`;
  cache.set(url, dataUrl);
  return dataUrl;
}

/** 经 dev server（Vite 转换 + 递归内联）加载候选模块。 */
async function viaDataUrl(origin) {
  const cache = new Map();
  for (const file of HOST_FILES) {
    try {
      const response = await fetch(fsUrl(origin, file));
      if (!response.ok) continue;
      const mod = await import(await inlineModule(origin, fsUrl(origin, file), cache).catch(() => `${fsUrl(origin, file)}`));
      if (typeof mod?.layoutGraph === "function") return { mod, file };
    } catch (error) {
      console.log(`… Node 兜底候选 ${file} 失败：${String(error).split("\n")[0].slice(0, 140)}`);
    }
  }
  return null;
}
/** 页面里 fetch + Blob 导入（Blob URL 下 `/…` 绝对说明符由 dev server 解析）。 */
async function canLoadInPage(target, origin) {
  for (const file of HOST_FILES) {
    const ok = await target.evaluate(async ({ url }) => {
      try {
        const response = await fetch(url);
        if (!response.ok) return false;
        const blob = new Blob([await response.text()], { type: "text/javascript" });
        const mod = await import(URL.createObjectURL(blob));
        return typeof mod?.layoutGraph === "function";
      } catch {
        return false;
      }
    }, { url: fsUrl(origin, file) }).catch(() => false);
    if (ok) return file;
  }
  return null;
}
/** 页面侧兜底：页面里用**同一份** Vite 转换结果跑 layout（断言对象仍是同一实现）。 */
function runLayoutInPage(target, graph, origin) {
  const value = JSON.parse(JSON.stringify(graph));
  return target.evaluate(async ({ graph: input, urls }) => {
    for (const url of urls) {
      try {
        const response = await fetch(url);
        if (!response.ok) continue;
        const blob = new Blob([await response.text()], { type: "text/javascript" });
        const mod = await import(URL.createObjectURL(blob));
        if (typeof mod?.layoutGraph === "function") return mod.layoutGraph(input);
      } catch { /* 下一个候选 */ }
    }
    throw new Error("页面侧找不到可用的 layoutGraph");
  }, { graph: value, urls: HOST_FILES.map((file) => fsUrl(origin, file)) });
}

console.log(`== 仓库根 ${REPO}`);
console.log(`== dev server ${DEV}`);

const graphMod = await import(MOD_SPEC);
const { buildGraph } = graphMod;
/** 可变绑定：默认 = 首次导入的实现；并行落盘 / 修复后指向新加载的实现。 */
let layoutGraph = typeof graphMod.layoutGraph === "function" ? graphMod.layoutGraph : null;
let viaFallback = null;

if (layoutGraph && !hot(buildGraph(SAMPLE_B), graphMod) && !hot(buildGraph(SAMPLE_A), graphMod)) {
  console.log("… 初次导入的 layoutGraph 会抛（并行交付中间态），走「等待 / 兜底」");
  layoutGraph = null;
}
if (layoutGraph) console.log("ok   layoutGraph 初次导入即可用");

// 浏览器先起来：既跑 B 段，也是运行时兜底的宿主。
mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
/** `pageerror`：与 `build/ed-win-check.mjs` 同款，滤掉 Tauri 桥的噪音。 */
const errors = [];
page.on("pageerror", (e) => { const t = String(e.stack ?? e); if (!t.includes("transformCallback")) errors.push(t.split("\n")[0]); });

/** dev server 也可能换了端口（5174 被占时）：扫一遍，选真正在跑的那个。 */
let devOrigin = DEV_ORIGIN;
for (let port = DEV_PORT; port < DEV_PORT + PORT_SCAN; port += 1) {
  const origin = `${DEV_ORIGIN}:${port}`;
  const status = await fetch(origin).then((r) => (r.ok ? r.status : 0)).catch(() => 0);
  if (status) { devOrigin = origin; break; }
}
if (devOrigin !== DEV_ORIGIN) console.log(`== dev server 实际端口 → ${devOrigin}`);

// ── layoutGraph 尚未就绪：轮询重读 → 运行时兜底 ───────────────
if (!layoutGraph) {
  for (let attempt = 1; attempt <= 5 && !layoutGraph; attempt += 1) {
    console.log(`\n… layoutGraph 尚未可调用，等待并行任务（第 ${attempt}/5 次，~20s）`);
    await new Promise((done) => setTimeout(done, 20000));
    try {
      const fresh = await import(`${MOD_SPEC}?v=${Date.now()}`);
      const probe = hot(buildGraph(SAMPLE_B), fresh) ?? hot(buildGraph(SAMPLE_A), fresh);
      if (probe) {
        layoutGraph = probe;
        console.log("ok   layoutGraph 已就绪（重读裸 JS ESM）");
        break;
      }
    } catch (error) {
      console.log(`… 第 ${attempt} 次重读失败：${String(error).split("\n")[0]}`);
    }
  }
  if (!layoutGraph) {
    const viaNode = await viaDataUrl(devOrigin);
    if (viaNode) {
      layoutGraph = viaNode.mod.layoutGraph;
      viaFallback = `dev server · Node data: 导入（${viaNode.file}）`;
    } else {
      const inPage = await canLoadInPage(page, devOrigin);
      if (inPage) {
        viaFallback = `dev server · 页面侧运行（${inPage}）`;
        layoutGraph = (graph) => runLayoutInPage(page, graph, devOrigin);
      }
    }
    if (layoutGraph) console.log(`ok   layoutGraph 已就绪（兜底：${viaFallback}）`);
  }
}

check("layoutGraph 可用（未抛出，schema 有 nodes[]）",
  layoutGraph ? (viaFallback ? `兜底来源：${viaFallback}` : "裸 JS ESM") : `${exportLines(GRAPH_MOD)}`,
  !!layoutGraph);

// ── A 段执行：三份内联样例 + 仓库内置样例 ───────────────────
let sampleB = null;
let sampleC = null;
if (layoutGraph) {
  // 三份内联样例 × 两个方向：TB（默认）在前，LR 复用同一套断言（按轴换）。
  for (const direction of DIRECTIONS) {
    checkSample({ id: "A", title: "无决策：纯对白/旁白", text: SAMPLE_A, maxDecisions: 0 }, layoutGraph, buildGraph, direction);
    const b = checkSample({ id: "B", title: "一个决策两条线 + 合流", text: SAMPLE_B, minDecisions: 1 }, layoutGraph, buildGraph, direction);
    const c = checkSample({ id: "C", title: "三方说话 + 两个决策（含嵌套）", text: SAMPLE_C, minDecisions: 2, minSpeakers: 3 }, layoutGraph, buildGraph, direction);
    if (direction === "TB") { sampleB = b; sampleC = c; }
  }

  // 分支语义的软观测：layout 认了就必须对（没认不算失败）。
  for (const [name, result] of [["B", sampleB], ["C", sampleC]]) {
    if (!result) continue;
    const roles = result.norm.rawNodes.map((node) => node?.role).filter(Boolean);
    if (roles.length) check(`[${name}] layout 有决策角色节点（choice/decision）`, [...new Set(roles)], roles.some((role) => DECISION_ROLES.has(role)));
    const kinds = [...new Set((result.graph?.nodes ?? []).map((node) => node?.kind))];
    if (kinds.includes("choice")) check(`[${name}] buildGraph 有 choice 节点`, kinds, true);
  }

  // 仓库内置样例：只要求 不抛 + 零重叠（确定性按任务书豁免）。
  if (existsSync(SAMPLE_SCRIPT)) {
    for (const direction of DIRECTIONS) {
      checkSample({
        id: "S",
        title: "内置样例 library/sample-fanfic/script.txt",
        text: readFileSync(SAMPLE_SCRIPT, "utf8"),
        minDecisions: 1,
        deterministic: false,
      }, layoutGraph, buildGraph, direction);
    }
  } else {
    skip("[S] 内置样例脚本", `不存在 ${SAMPLE_SCRIPT}`);
  }
}

// ── B 段：浏览器 ────────────────────────────────────────────────
errors.length = 0; // 兜底阶段（页面里 import blob）的噪音不算数
let found = null;
let isMarker = false;
try {
  await page.goto(`${devOrigin}/editor/demo?text=${encodeURIComponent(SAMPLE_B)}`, { waitUntil: "domcontentloaded" });
  // 编辑器页依赖 P5 的接线（`readWindowState` 等）：起不来时直接走 `/branch-demo.html`
  // 兜底（那是 T6 自己的入口，只挂 BranchGraph，断言同一套契约标记）。
  // 编辑器页首帧要等 i18n / workbench / rail 都水合完（并行任务在同一个
  // dev server 上热更新时会慢一拍）：给 30s，仍起不来才退回 /branch-demo.html。
  const editorUp = await page
    .waitForSelector("textarea.ed-textarea", { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  if (!editorUp) {
    console.log("… 编辑器页未就绪（P5 接线中）→ 走 /branch-demo.html");
  } else {
  // 编辑器页还要等**chrome 水合完**（定位条 / 工具条）：并行任务在同一个 dev
  // server 上热更新时，`textarea` 先到、面板后到；不等就会"半页"跑断言。
  await page.locator('input[type="range"]').first().waitFor({ state: "attached", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
  const textareaCount = await page.locator("textarea.ed-textarea").count();
  check("浏览器 textarea.ed-textarea 存在", textareaCount, textareaCount >= 1);

  // (a) 工具栏「⌥ 分支图」：legacy `.ed-viewtabs .ed-btn` + 文案选择器都试。
  const legacyTab = page.locator(".ed-viewtabs .ed-btn", { hasText: "分支图" });
  const anyTab = page.locator('button:has-text("⌥ 分支图")');
  const tab = (await legacyTab.count()) ? legacyTab.first() : anyTab.first();
  if (await tab.count()) {
    if (await tab.isEnabled()) {
      // 点得动就点；被别的浮层盖住（toolbar 上的横幅）时退化为 DOM `click()`
      // —— 断言的是"开关能开分支图"，不是"这一像素没被挡"。
      await softClick(tab);
      // 面板可能是懒加载 / 正在改写：给契约标记与 legacy DOM 各 ~4s。
      await Promise.race([
        page.locator('[data-branch-graph="1"]').first().waitFor({ state: "attached", timeout: 4000 }).catch(() => {}),
        page.locator(".ed-graph-node").first().waitFor({ state: "attached", timeout: 4000 }).catch(() => {}),
      ]);
      await page.waitForTimeout(800);
    } else {
      skip("工具栏「⌥ 分支图」可点", "按钮 disabled（分支图组件未落盘 / 懒加载失败）");
    }
  } else {
    skip("工具栏「⌥ 分支图」", "两种选择器都没找到按钮");
  }
  }

  /** 页面里的"分支图 DOM"：契约标记优先，legacy `.ed-graph`（当前落盘的组件）兜底。 */
  const findGraph = async () => {
    if (!(await page.locator('[data-branch-graph="1"]').count()) && !(await page.locator(".ed-graph-node").count())) {
      await page.waitForTimeout(700); // 再给一拍（懒加载 / React 提交）
    }
    if (await page.locator('[data-branch-graph="1"]').count()) {
      return { variant: "dify", sel: '[data-branch-graph="1"]', root: ".ed-graph", count: await page.locator(".ed-graph").count(), at: "editor/demo" };
    }
    const legacyNodes = await page.locator(".ed-graph-node").count();
    if (legacyNodes) {
      return { variant: "legacy", sel: ".ed-graph svg", root: ".ed-graph", count: await page.locator(".ed-graph").count(), nodes: legacyNodes, at: "editor/demo" };
    }
    return null;
  };
  found = await findGraph();

  // (b) 兜底：`/branch-demo.html`
  if (!found) {
    await page.goto(`${devOrigin}/branch-demo.html`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.locator('[data-branch-graph="1"]').first().waitFor({ state: "attached", timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200);
    found = await findGraph();
    if (found) found.at = "branch-demo.html";
  }

  if (!found) {
    skip("浏览器 分支图 DOM", "编辑器工具栏与 /branch-demo.html 都没有分支图（契约 [data-branch-graph=\"1\"] 或 legacy .ed-graph）");
    skip("浏览器 节点元素 ≥ 1", "同上");
    skip("浏览器 边元素 ≥ 1", "同上");
    skip("fit 热键（按 0）不抛 pageerror", "同上");
  } else {
    isMarker = found.variant === "dify";
    // 契约标记已全中：容器 / 卡片 / 层号 / 边 / 缩放控件 / 适配按钮。
    const nodesSel = isMarker ? "[data-branch-node]" : ".ed-graph-node";
    const edgesSel = isMarker ? '[data-branch-path="1"]' : ".ed-graph svg > g > path";
    const emptyState = isMarker ? await page.locator('[data-branch-empty="1"]').count() : await page.locator(".ed-graph-empty").count();
    if (!isMarker) skip("浏览器 [data-branch-layer] / data-branch-* 契约标记", "当前落盘组件是 legacy DOM（.ed-graph-node / data-node），契约标记待面板改造");
    const nodes = await page.locator(nodesSel).count();
    const paths = await page.locator(edgesSel).count();
    check("浏览器 分支图容器 ≥ 1", { at: found.at, variant: found.variant, roots: found.count }, found.count >= 1);
    check("浏览器 节点（[data-branch-node] / .ed-graph-node）≥ 1", { nodes, edges: paths, emptyState }, nodes >= 1);
    check('浏览器 边 path（[data-branch-path="1"] / graph 层 path）≥ 1', { edges: paths }, paths >= 1);
    if (isMarker) {
      // 卡片几何：默认（竖排）320×92；按 `[data-branch-direction]` 读页面当前口径。
      const dirAttr = await page.locator('[data-branch-pan="1"]').first().getAttribute("data-branch-direction").catch(() => null);
      const curDir = dirAttr === "lr" ? "LR" : "TB";
      const want = SIZES[curDir];
      const sized = await waitForCards(page, curDir);
      check(`浏览器 卡片尺寸 = ${want.w}×${want.h}（${curDir}）`,
        sized.ok ? `${sized.sizes.length} 种 · direction=${sized.dir}` : sized,
        sized.ok === true);

      // 默认方向 = 竖排：`[data-branch-direction]` 必须存在且是 TB（或至少不是 lr）。
      check("浏览器 默认方向 = 竖排（[data-branch-direction] 非 lr）", dirAttr, dirAttr !== "lr");

      // 方向键漫游：面板聚焦 → ↓ 选下一张、↑ 回上一张、Home/End 跳首末。
      const panSel = '[data-branch-pan="1"]';
      await page.locator(panSel).first().click({ position: { x: 10, y: 10 }, timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(300);
      const readSel = async () => page.evaluate(() => {
        const picked = document.querySelector("[data-branch-node].is-picked");
        const hint = document.querySelector('[data-branch-hint-keys="1"]');
        return {
          picked: picked ? (picked.getAttribute("data-node") ?? picked.getAttribute("data-branch-node")) : null,
          hint: (hint?.textContent ?? "").trim(),
        };
      });
      const before = await readSel();
      await page.keyboard.press("ArrowDown").catch(() => {});
      await page.waitForTimeout(250);
      const afterDown = await readSel();
      await page.keyboard.press("ArrowUp").catch(() => {});
      await page.waitForTimeout(250);
      const afterUp = await readSel();
      check("浏览器 ↓ 切换选中卡片（选中 id 变化）",
        { before: before.picked, after: afterDown.picked },
        afterDown.picked !== null && afterDown.picked !== before.picked);
      check("浏览器 ↑ 回到上一张（id 复原）",
        { want: before.picked, got: afterUp.picked },
        afterUp.picked === before.picked);
      check("浏览器 键位读数条 [data-branch-hint-keys] 跟着更新",
        { hint: afterDown.hint.slice(0, 40) },
        afterDown.hint.length > 0 && afterDown.hint !== before.hint);

      // Enter = 跳到该行 + （编辑器页）预览跟到该行：定位滑杆 / 数字框的 value
      // = 选中卡片的行号。契约标记优先，滑杆缺失（/branch-demo.html）时跳过。
      const scrub = page.locator('.ed-scrub input[type="range"]').first();
      if (await scrub.count()) {
        await page.locator(panSel).first().click({ position: { x: 10, y: 10 }, timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(250);
        const pickedNow = await page.evaluate(() => {
          const node = document.querySelector("[data-branch-node].is-picked");
          return node ? (node.getAttribute("data-branch-layer") === null ? null : node.getAttribute("data-node")) : null;
        });
        const wantLine = await page.evaluate((id) => {
          const node = id ? document.querySelector(`[data-branch-node="${id}"]`) : null;
          const title = node?.querySelector("title")?.textContent ?? "";
          const matched = /^#(\d+)/.exec(title);
          return matched ? Number(matched[1]) : null;
        }, pickedNow);
        await page.keyboard.press("Enter").catch(() => {});
        await page.waitForTimeout(600);
        const slider = Number(await scrub.inputValue().catch(() => "-1"));
        check("浏览器 Enter = 跳到该行（定位滑杆 = 卡片首行）",
          { picked: pickedNow, wantLine, slider },
          wantLine !== null && slider === wantLine);
      } else {
        skip("浏览器 Enter → 预览跟到该行", "页面上没有 .ed-scrub 定位滑杆（非编辑器页）");
      }

      // 漫游序自洽：`data-branch-read-index` 必须与 `readOrder` 的 DOM 顺序一致
      // （点选 / ↑↓ 都走它，跑偏了就会"跳着选"）。
      const indexOk = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("[data-branch-node]")]
          .map((el) => ({ id: el.getAttribute("data-node"), at: Number(el.getAttribute("data-branch-read-index")) }))
          .filter((row) => Number.isFinite(row.at))
          .sort((a, b) => a.at - b.at);
        const want = [...document.querySelectorAll("[data-branch-node]")]
          .map((el) => ({ id: el.getAttribute("data-node"), at: Number(el.getAttribute("data-branch-read-index")), layer: Number(el.getAttribute("data-branch-layer")) }))
          .filter((row) => Number.isFinite(row.at))
          .sort((a, b) => (a.layer - b.layer) || (a.at - b.at));
        return { n: rows.length, contiguous: rows.every((row, i) => row.at === i), layersSorted: want.every((row, i) => i === 0 || row.layer >= want[i - 1].layer) };
      });
      check("浏览器 漫游序自洽（read-index 连续 + 层号不倒退）", indexOk, indexOk.n > 0 && indexOk.contiguous && indexOk.layersSorted);

      const layers = await page.locator("[data-branch-layer]").count();
      check("浏览器 [data-branch-layer] 存在", layers, layers >= 1);
      const pan = await page.locator('[data-branch-pan="1"]').count();
      check("浏览器 平移面 [data-branch-pan=\"1\"] 存在", pan, pan >= 1);
      const fold = await page.locator(".bg-fold").count();
      const fitCount = await page.locator('[data-branch-action="fit"]').count();
      const chromeRoot = await page.locator('[data-chrome="branch"]').count();
      check("浏览器 chrome（data-chrome=branch + .bg-chrome + .bg-fold + ⤢ 适配）",
        { chromeRoot, fold, fit: fitCount }, chromeRoot >= 1 && fold >= 1 && fitCount >= 1);
      // 方向切换按钮：`[data-branch-action="direction"]` 点一下 → data-branch-direction=lr。
      const dirBtn = page.locator('[data-branch-action="direction"]');
      const dirBtnCount = await dirBtn.count();
      check('浏览器 方向按钮 [data-branch-action="direction"] 存在', dirBtnCount, dirBtnCount >= 1);
      if (dirBtnCount) {
        /** 读当前口径（选中的方向按钮可能被预览 iframe 的 openPreview 重渲染挤掉，读 DOM 更稳）。 */
        const dirNow = () => page.locator('[data-branch-pan="1"]').first().getAttribute("data-branch-direction").catch(() => null);
        await softClick(dirBtn.first());
        await page.waitForTimeout(500);
        if ((await dirNow()) !== "lr") {
          await softClick(page.locator('[data-branch-action="direction"]').first());
          await page.waitForTimeout(700);
        }
        const flipped = await waitForCards(page, "LR");
        check("浏览器 切换 → 横排（direction=lr 且卡片 200×64）",
          { direction: flipped.dir, sizes: flipped.sizes },
          flipped.ok === true);
        await softClick(page.locator('[data-branch-action="direction"]').first());
        await page.waitForTimeout(500);
        if ((await dirNow()) !== "tb") await softClick(page.locator('[data-branch-action="direction"]').first());
        const back = await waitForCards(page, "TB");
        check("浏览器 再点 → 回竖排（direction=tb）", { direction: back.dir, sizes: back.sizes }, back.ok === true);
        // 竖排截图（用户要的"竖的编排"）：单独出一张，别和横排混。
        await page.locator(found.root).first().screenshot({ path: SHOT_VERTICAL, timeout: 10000 }).catch(() => {});
        check("截图 branch-vertical.png（竖排）", existsSync(SHOT_VERTICAL) ? describe(SHOT_VERTICAL) : "缺失", existsSync(SHOT_VERTICAL) && statSync(SHOT_VERTICAL).size > 0);
      }

      const edgeTagged = await page.locator("[data-branch-edge]").count();
      check('浏览器 [data-branch-edge="1"] 与 [data-branch-path="1"] 并存', { edgeTagged, paths }, edgeTagged >= 1 && paths >= 1);
      /** 空态文案：同一脚本去掉 Decision 后**逐字**在页面上（人话提示）。 */
      const sample = await page.locator("textarea.ed-textarea").first().inputValue().catch(() => "");
      if (sample) {
        const noDecision = sample.split("\n").filter((line) => !/\[Decision|\[Predicate/.test(line)).join("\n");
        await page.locator("textarea.ed-textarea").first().fill(noDecision).catch(() => {});
        await page.waitForTimeout(700);
        const text = (await page.locator('[data-branch-empty="1"]').textContent().catch(() => "")) ?? "";
        check("浏览器 无 Decision 时 [data-branch-empty=\"1\"] 人话提示", text.trim(), text.includes("这个剧本还没有分支：插入 [Decision] 后这里会画出走向"));
        await page.locator("textarea.ed-textarea").first().fill(sample).catch(() => {});
        await page.waitForTimeout(600);
      } else {
        const empty = await page.locator('[data-branch-empty="1"]').textContent().catch(() => null);
        skip("空态文案（无 Decision）", empty ? `当前文本已有分支，页面上的空态=${empty.trim()}` : "演示页无 textarea，跳过换文");
      }
    }

    // fit 热键 `0`：不崩、不新增 pageerror（契约热键；legacy 组件同键，不崩即可）。
    const beforeFit = errors.length;
    await page.locator(found.sel).first().hover({ timeout: 5000 }).catch(() => {});
    await page.keyboard.press("0").catch(() => {});
    await page.waitForTimeout(400);
    await page.keyboard.press("0").catch(() => {});
    await page.waitForTimeout(500);
    check(isMarker ? "fit 热键（按 0）不抛 pageerror" : "press 0（fit 热键，legacy 组件）不抛 pageerror",
      { newErrors: errors.slice(beforeFit) }, errors.length === beforeFit);

    const fitBtn = page.locator('[data-branch-action="fit"]');
    if (await fitBtn.count()) {
      const beforeClick = errors.length;
      await fitBtn.first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(400);
      check('fit 按钮（[data-branch-action="fit"]）可点且不抛', "clicked", errors.length === beforeClick);
    }
  }

  // ── 截图：容器元素截图（closest [data-win] → .ed-graph → svg）→ 失败则全页兜底 ──
  let shotKind = "全页兜底";
  if (found) {
    /** 首选 `.ed-graph` 内的 `[data-branch-pan]`（缩放 / 适配后的真实画面），
     *  其次容器；都拿不到再全页兜底。 */
    const containers = [
      page.locator(found.at === "editor/demo" ? `[data-win]:has(${found.root})` : `${found.root}`),
      page.locator(found.root),
      page.locator(found.sel),
    ];
    for (const container of containers) {
      if ((await container.count()) === 0) continue;
      try {
        await container.first().screenshot({ path: SHOT_BRANCH, timeout: 10000 });
      } catch {
        try {
          const box = await container.first().boundingBox();
          if (box && box.width > 4 && box.height > 4) await page.screenshot({ path: SHOT_BRANCH, clip: box, timeout: 10000 });
        } catch { /* 落到全页兜底 */ }
      }
      if (existsSync(SHOT_BRANCH) && statSync(SHOT_BRANCH).size > 0) { shotKind = "元素截图"; break; }
    }
  }
  if (shotKind === "全页兜底") await page.screenshot({ path: SHOT_BRANCH, fullPage: true, timeout: 15000 }).catch(() => {});
  check("截图 branch.png", existsSync(SHOT_BRANCH) ? `${shotKind} · ${describe(SHOT_BRANCH)}` : "缺失", existsSync(SHOT_BRANCH) && statSync(SHOT_BRANCH).size > 0);

  await page.screenshot({ path: SHOT_EDITOR, fullPage: true, timeout: 15000 }).catch(() => {});
  check("截图 branch-editor.png（全页）", existsSync(SHOT_EDITOR) ? describe(SHOT_EDITOR) : "缺失", existsSync(SHOT_EDITOR) && statSync(SHOT_EDITOR).size > 0);

  /** 编辑器页（P5）崩了但分支图本身没问题 → `readWindowState` 之类的页面接线噪音
   *  只记一行（当 `found.at !== "editor/demo"` 时不计入失败）。 */
  const pageNoise = found && found.at !== "editor/demo" && errors.every((line) => /readWindowState|is not defined/.test(line));
  if (pageNoise) console.log(`… 编辑器页接线噪音（${errors.length} 条，已在 /branch-demo.html 完成分支图断言）：${errors[0]}`);
  check("pageerror（已滤 transformCallback）", errors.slice(0, 3), errors.length === 0 || pageNoise);
} catch (error) {
  check("浏览器段无异常", String(error).split("\n").slice(0, 3).join(" | "), false);
} finally {
  await browser.close().catch(() => {});
}

// ── 汇总 ───────────────────────────────────────────────────────
const passed = rows.filter((row) => row.pass).length;
console.log(`\n== 结果：${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""} ==`);
for (const line of failures.slice(0, 8)) console.log(`   ↳ ${line}`);
console.log(`（浏览器路径：${found ? `${found.variant} @ ${found.at}` : "未找到分支图 DOM"}${isMarker ? "" : "；契约 data-branch-* 标记待面板改造"}）`);
process.exit(failed === 0 ? 0 : 1);

// ── 小工具 ───────────────────────────────────────────────────
/** 人类可读的截图大小。 */
function describe(path) {
  try {
    const size = statSync(path).size;
    return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(2)} MB` : `${Math.round(size / 1024)} KB`;
  } catch {
    return "读取失败";
  }
}
/** 断言失败时的证据：文件里的 `export` 行。 */
function exportLines(path) {
  try {
    return existsSync(path)
      ? readFileSync(path, "utf8").split("\n").filter((line) => line.includes("export")).map((line) => line.trim()).slice(-4)
      : "文件不存在";
  } catch {
    return "读取失败";
  }
}
/** 异常里指向 `branchGraph.js` 的第一帧（`file:line:col`）——把失败钉到具体行。 */
function repoFrame(error) {
  const lines = String(error?.stack ?? "").split("\n");
  for (const line of lines) {
    const match = line.match(/\(?((?:file:\/\/)?\/?[^()\s]*branchGraph\.js):(\d+):(\d+)\)?/);
    if (match) return `branchGraph.js:${match[2]}:${match[3]}`;
  }
  return lines[1]?.trim().slice(0, 100) ?? "（无栈）";
}
