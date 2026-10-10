#!/usr/bin/env node
/**
 * 工作台布局自检（offline, zero-dependency）——「拼接工作区 + 自由调换位置」的回归。
 *
 *   node build/harness/wb-selftest.mjs [--rounds 300] [--json out.json]
 *
 * 断言（纯逻辑，无浏览器）：
 *   (a) §2.1/§2.4 常量：`PANELS` 顺序、`WINDOW_SPECS` 的 title/kind/minW/minH/order、
 *       分隔条 clamp 区间（0.12…0.88）；`toolpanel`/`stage` 无 `map`，`preview`/`branch` 是 Map；
 *   (b) `defaultState()` 形状 = `(toolpanel|{placeholder/stage%62}%32)`，`preview`/`branch` 不在树里；
 *   (c) `move(..., "right"|"left"|"top"|"bottom")` = 在目标边缘**建 split**（目标留在原位），
 *       `center` = **换位**（两片叶子互换、树形状不变）；落点不存在时不抛异常；搬走的旧位置折叠；
 *   (d) `resize` clamp / NaN / 过期路径回落；`reorder` 同级换序 / 跨容器；
 *   (e) `stringify` ↔ `parse` 往返等价（`order` 归一后的深度相等）、坏输入 → null；
 *   (f) `normalize`：去重、visible 过滤、share clamp、minimized 与树互补、**不改原对象**（深冻结输入）；
 *   (g) `minimize` / `restore`（Map 关闭/打开）；
 *   (h) `workbenchLayout` 的 localStorage 层：`layoutKey` / `saveLayout` / `loadLayout` /
 *       `listLayouts` / `activeLayout` / `migrateLegacy`（旧 `prts-editor-windows:*` 只读一次后删除）；
 *   (i) 随机稳定性：N 次随机 move/resize/reorder/visible 切换后不抛异常，且
 *       **树里每个 id 只出现一次**、share ∈ [0.12,0.88]、`stringify→parse` 等价、结构合法
 *       （没有单子 split / 没有空 split）；固定种子 → 结果可复现。
 *
 * 退出码：0 = 全过；1 = 有断言失败。
 * 契约：`build/ctx/BRIEF-workbench-v1.md` §2.1 / §2.3 / §2.4、§3.1 / §3.6。
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
process.chdir(HERE);

// ── 测试装置：统计 + 可控的 localStorage ─────────────────
let pass = 0;
let fail = 0;
const rows = [];
const t = (label, fn) => {
  try {
    fn();
    pass += 1;
    rows.push({ label, ok: true });
    console.log(`ok   ${label}`);
  } catch (error) {
    fail += 1;
    const detail = String(error?.message ?? error).split("\n").slice(0, 14).join(" | ");
    rows.push({ label, ok: false, detail });
    console.log(`FAIL ${label} — ${detail}`);
  }
};

/** 内存版 localStorage（Node 里 `globalThis.localStorage` 可能不存在或被占用）。 */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    _dump: () => Object.fromEntries(map),
  };
}
const installStorage = (seed) => {
  const storage = fakeStorage(seed);
  globalThis.localStorage = storage;
  return storage;
};

// ── 载入被测模块（Node 原生类型剥离：`import` 直接吃 `.ts`） ──
const stack = await import("../../frontend/src/components/editor/workbenchStack.ts");
const layout = await import("../../frontend/src/components/editor/workbenchLayout.ts");
const {
  defaultState, ids, leaves, pathTo, pathNode, parentOf, has, replace, drop, splitAt,
  move, resize, reorder, minimize, restore, normalize, stringify, parse, summarize,
  clampShareValue, size, childAt, firstSplitPath,
} = stack;

const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
};
const ROUNDS = Number(arg("rounds", "300"));

// ══ (a) 常量 / 规格表 ══════════════════════════════════
t("PANELS 顺序 = [toolpanel, stage, preview, branch]", () => {
  assert.deepEqual(layout.PANELS, ["toolpanel", "stage", "preview", "branch"]);
});
t("WINDOW_SPECS: 标题 / kind / minW / minH / order（契约 §2.1）", () => {
  assert.deepEqual(layout.WINDOW_SPECS.toolpanel, { title: "工具面板", map: false, minW: 240, minH: 160, order: 10, kind: "dock" });
  assert.deepEqual(layout.WINDOW_SPECS.stage, { title: "舞台", map: false, minW: 280, minH: 160, order: 20, kind: "dock" });
  assert.deepEqual(layout.WINDOW_SPECS.preview, { title: "预览", map: true, minW: 320, minH: 200, order: 30, kind: "map" });
  assert.deepEqual(layout.WINDOW_SPECS.branch, { title: "分支图", map: true, minW: 320, minH: 200, order: 40, kind: "map" });
});
t("dock/map 语义：toolpanel·stage 常驻、preview·branch = Map", () => {
  assert.deepEqual(layout.defaultVisible(), ["toolpanel", "stage"]);
  assert.equal(layout.isMapPanel("branch"), true);
  assert.equal(layout.isDockPanel("stage"), true);
  assert.deepEqual(layout.panelsInOrder(), ["toolpanel", "stage", "preview", "branch"]);
});
t("share clamp 区间 = 0.12 / 0.88", () => {
  assert.equal(layout.SHARE_MIN, 0.12);
  assert.equal(layout.SHARE_MAX, 0.88);
});

// ══ (b) 默认布局 ═══════════════════════════════════════
t("defaultState 形状 = (toolpanel|{placeholder/stage%62}%32)", () => {
  assert.equal(stringify(defaultState()), "(toolpanel|{placeholder/stage%62}%32)");
});
t("preview / branch 默认不在树里（Map 关闭）", () => {
  assert.deepEqual(ids(defaultState()), ["toolpanel", "stage"]);
  assert.equal(has(defaultState(), "preview"), false);
});
t("pathTo：toolpanel=[0]、stage=[1,1]、preview=null", () => {
  const state = defaultState();
  assert.deepEqual(pathTo(state, "toolpanel"), [0]);
  assert.deepEqual(pathTo(state, "stage"), [1, 1]);
  assert.equal(pathTo(state, "preview"), null);
});
t("默认右列是 col 容器（holder 上 / stage 下，share .62）", () => {
  const right = pathNode(defaultState().root, [1]);
  assert.equal(right.t, "split");
  assert.equal(right.dir, "col");
  assert.equal(right.share, 0.62);
  assert.equal(leaves({ root: right, minimized: [] }).join(","), "holder,stage");
});
t("leaves：holder 占位叶仍在树里（P5 用它放 textarea）", () => {
  assert.deepEqual(leaves(defaultState()), ["toolpanel", "holder", "stage"]);
});
t("defaultState 每次都是新对象（不受外部改写影响）", () => {
  const a = defaultState();
  const b = defaultState();
  assert.notEqual(a.root, b.root);
  assert.equal(stringify(a), stringify(b));
});

// ══ (c) move：建 split + 换位 ═════════════════════════
const panelIn = (state, id) => ids(state).includes(id);

t("move(preview → toolpanel 右) = 建 split，target 留在原位", () => {
  const after = move(defaultState(), "preview", "toolpanel", "right");
  assert.deepEqual(ids(after), ["toolpanel", "preview", "stage"], "ids 顺序（tree 顺序）");
  const width = parentOf(after, "preview");
  const anchor = parentOf(after, "toolpanel");
  assert.equal(width.parent.t, "split");
  assert.equal(width.parent.dir, "row");
  assert.equal(width.side, 1, "preview 在 target 右侧");
  // 目标没被搬走、右列（holder/stage）保持完整。
  assert.equal(anchor.side, 0);
  assert.equal(anchor.parent, width.parent, "两者成为同一个 split 的孩子");
  assert.equal(pathNode(after.root, [1]).t, "split");
  assert.equal(leaves({ root: pathNode(after.root, [1]), minimized: [] }).join(","), "holder,stage");
});
t("move(preview → toolpanel 左) 与 右 互为镜像", () => {
  const after = move(defaultState(), "preview", "toolpanel", "left");
  assert.equal(stringify(after), "((preview|toolpanel)|{placeholder/stage%62}%32)", "左：preview 在前");
});
t("move(上/下) = col split（top 在前、bottom 在后）", () => {
  const top = move(defaultState(), "preview", "toolpanel", "top");
  const bottom = move(defaultState(), "preview", "toolpanel", "bottom");
  assert.equal(stringify(top), "({preview/toolpanel}|{placeholder/stage%62}%32)");
  assert.equal(stringify(bottom), "({toolpanel/preview}|{placeholder/stage%62}%32)");
  assert.equal(parentOf(bottom, "preview").parent.dir, "col");
  assert.equal(parentOf(top, "preview").side, 0);
});
t("move 到 stage 右侧：整个工作台里每个 id 仍只出现一次", () => {
  const after = move(defaultState(), "branch", "stage", "right");
  const list = ids(after);
  assert.deepEqual([...list].sort(), ["branch", "stage", "toolpanel"]);
  assert.equal(new Set(list).size, list.length);
  assert.equal(has(after, "preview"), false);
});
t("搬走的旧位置折叠（stage 移出右列 → 右列只剩 holder）", () => {
  const after = move(defaultState(), "stage", "toolpanel", "right");
  assert.deepEqual(ids(after), ["toolpanel", "stage"]);
  assert.equal(leaves(after).includes("holder"), true);
  assert.equal(has(after, "preview"), false);
});
t("move(center) = 换位（stage ↔ toolpanel，形状不变）", () => {
  const state = defaultState();
  const after = move(state, "stage", "toolpanel", "center");
  assert.equal(stringify(after), "(stage|{placeholder/toolpanel%62}%32)");
  assert.deepEqual(ids(after), ["stage", "toolpanel"]);
  assert.equal(pathTo(after, "toolpanel").join(","), "1,1", "toolpanel 接管 stage 的槽位");
});
t("换位可逆：再换回来 == 默认布局", () => {
  const state = defaultState();
  const once = move(state, "split" === "x" ? "preview" : "stage", "toolpanel", "center");
  const twice = move(once, "toolpanel", "stage", "center");
  assert.equal(stringify(twice), stringify(state));
});
t("move(center) 目标不在树里 → 目标侧分屏（不抛异常、不丢 target）", () => {
  const after = move(defaultState(), "preview", "branch", "center");
  assert.equal(panelIn(after, "preview"), true);
  assert.equal(panelIn(after, "stage"), true);
  assert.equal(ids(after).length, 3);
});
t("move(preview → root 右) = 在整棵树右侧分屏", () => {
  const after = move(defaultState(), "preview", "root", "right");
  assert.equal(stringify(after), "((toolpanel|{placeholder/stage%62}%32)|preview)");
});
t("move(preview → root 中心) = 独占（其余进 minimized，可 restore）", () => {
  const after = move(defaultState(), "preview", "root", "center");
  assert.equal(stringify(after), "preview");
  assert.deepEqual([...after.minimized].sort(), ["stage", "toolpanel"]);
  assert.deepEqual(ids(after), ["preview"]);
});
t("move 自身 → 原样返回（不抛异常）", () => {
  const state = defaultState();
  assert.equal(stringify(move(state, "stage", "stage", "center")), stringify(state));
  assert.equal(stringify(move(state, "stage", "stage", "left")), stringify(state));
});
t("move 位置组合全跑一遍不抛异常（4 zones × 4 targets × 5 sources）", () => {
  for (const id of ["toolpanel", "stage", "preview", "branch"]) {
    for (const target of ["toolpanel", "stage", "preview", "branch", "root"]) {
      for (const zone of ["left", "right", "top", "bottom", "center"]) {
        const after = move(defaultState(), id, target, zone);
        assert.equal(new Set(ids(after)).size, ids(after).length, `${id}->${target}:${zone}`);
      }
    }
  }
});

// ══ (d) resize / reorder ══════════════════════════════
t("resize 写 root split 的 share", () => {
  const after = resize(defaultState(), [0], 0.5);
  assert.equal(stringify(after), "(toolpanel|{placeholder/stage%62})");
});
t("resize clamp：0.05 → 0.12、3.5 → 0.88、NaN → 0.5", () => {
  assert.ok(stringify(resize(defaultState(), [0], 0.05)).endsWith("%12)"));
  assert.ok(stringify(resize(defaultState(), [0], 3.5)).endsWith("%88)"));
  assert.equal(stringify(resize(defaultState(), [0], Number.NaN)), "(toolpanel|{placeholder/stage%62})");
});
t("resize 过期路径（[9,9]）回落到根 split，不抛异常", () => {
  const after = resize(defaultState(), [9, 9], 0.44);
  assert.equal(stringify(after), "(toolpanel|{placeholder/stage%62}%44)");
});
t("resize 到 split 里的叶子（[1,1] = stage）→ 回落到最近的 split（右列）", () => {
  assert.equal(stringify(resize(defaultState(), [1, 1], 0.7)), "(toolpanel|{placeholder/stage%70}%32)");
});
t("resize 会更新嵌套 split（右列 holder/stage）", () => {
  const after = resize(defaultState(), [1], 0.3);
  assert.equal(stringify(after), "(toolpanel|{placeholder/stage%30}%32)");
});
t("reorder 同级 before/after 交换槽位", () => {
  const state = move(defaultState(), "preview", "toolpanel", "right"); // ((toolpanel|preview)|{holder/stage})
  const swapped = reorder(state, "preview", "toolpanel", "before");
  assert.equal(stringify(swapped), "(((preview|toolpanel))|{placeholder/stage%62}%32)".replace("((", "(").replace("))", ")"));
  assert.equal(stringify(reorder(swapped, "preview", "toolpanel", "after")), stringify(state), "已就位 → 等价形状");
});
t("reorder 跨容器 = 落到目标的 before(左) / after(右)", () => {
  const before = reorder(defaultState(), "stage", "toolpanel", "before");
  const after = reorder(defaultState(), "stage", "toolpanel", "after");
  assert.equal(stringify(before), "((stage|toolpanel)|placeholder%32)");
  assert.equal(stringify(after), "((toolpanel|stage)|placeholder%32)");
});

// ══ (e) stringify / parse ═════════════════════════════
t("stringify 紧凑格式（row `(a|b)` / col `{a/b}` / `%NN` / holder / min）", () => {
  assert.equal(stringify(defaultState()), "(toolpanel|{placeholder/stage%62}%32)");
  const moved = move(defaultState(), "stage", "toolpanel", "top");
  assert.ok(stringify(moved).includes("{"));
  assert.equal(stringify({ root: { t: "min" }, minimized: [] }), "_");
});
t("stringify → parse 往返：深度相等（默认 + 组合）", () => {
  const cases = [
    defaultState(),
    move(defaultState(), "preview", "toolpanel", "right"),
    move(defaultState(), "preview", "stage", "bottom"),
    resize(defaultState(), [1], 0.2),
    move(move(defaultState(), "preview", "root", "left"), "branch", "preview", "top"),
  ];
  for (const state of cases) {
    const back = parse(stringify(state));
    assert.ok(back, `parse 失败：${stringify(state)}`);
    assert.equal(stringify(back), stringify(state));
    assert.deepEqual(back.root, state.root);
  }
});
t("parse：坏输入一律 null（空 / 垃圾 / 未闭合 / 缺分隔符）", () => {
  for (const bad of ["", "   ", "nonsense", "(toolpanel|stage", "(toolpanel stage)", "{toolpanel|stage}", "(toolpanel|)", "%50", "(", "toolpanel)", "holder|stage"]) {
    assert.equal(parse(bad), null, JSON.stringify(bad));
  }
});
t("parse：单个面板 / `_` / 带空白都认", () => {
  assert.equal(stringify(parse("preview")), "preview");
  assert.equal(stringify(parse(" _ ")), "_");
  assert.equal(stringify(parse(" ( toolpanel | { placeholder / stage %62 } %32 ) ")), stringify(defaultState()));
});
t("summarize 是人话（含面板与比例）", () => {
  const text = summarize(move(defaultState(), "preview", "toolpanel", "right"));
  assert.ok(/toolpanel/.test(text) && /preview/.test(text) && /编辑区/.test(text), text);
});

// ══ (f) normalize ════════════════════════════════════
const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};
const split = (dir, share, a, b) => ({ t: "split", dir, share, a, b });
const panel = (id) => ({ t: "panel", id });
const MIN = { t: "min" };

t("normalize：同一 id 出现两次 → 只留第一个", () => {
  const state = normalize({ root: split("row", 0.5, panel("stage"), panel("stage")), minimized: [] });
  assert.equal(stringify(state), "stage");
});
t("normalize：visible 之外的面板从树里消失", () => {
  const withPreview = move(defaultState(), "preview", "toolpanel", "right");
  const state = normalize(withPreview, ["toolpanel", "stage"]);
  assert.deepEqual(ids(state), ["toolpanel", "stage"]);
});
t("normalize：visible 之外的面板 → 从树里消失后可再放回（Map 关闭/打开语义）", () => {
  const on = move(defaultState(), "branch", "stage", "right");
  const off = normalize(on, ["toolpanel", "stage"]);
  assert.equal(has(off, "branch"), false);
  const back = restore(off, "branch", "stage", "right");
  assert.equal(has(back, "branch"), true);
  assert.deepEqual(ids(back), ids(on));
});
t("normalize：share clamp（-1 → 0.12、9 → 0.88、NaN → 0.5）", () => {
  const holder = { t: "holder" };
  assert.equal(normalize({ root: split("row", -1, panel("stage"), holder), minimized: [] }).root.share, 0.12);
  assert.equal(normalize({ root: split("row", 9, panel("stage"), holder), minimized: [] }).root.share, 0.88);
  assert.equal(normalize({ root: split("col", Number.NaN, panel("stage"), holder), minimized: [] }).root.share, 0.5);
});
t("normalize：单子 split 折叠、`min`=空叶删除", () => {
  const stage = { t: "panel", id: "stage" };
  assert.equal(stringify(normalize({ root: split("row", 0.3, MIN, stage), minimized: [] })), "stage");
  assert.equal(stringify(normalize({ root: split("row", 0.3, stage, MIN), minimized: [] })), "stage");
  const nested = normalize({ root: split("row", 0.3, split("col", 0.4, MIN, stage), stage), minimized: [] });
  assert.equal(stringify(nested), "stage", "单子 split 一路折叠");
  assert.equal(stringify(normalize({ root: split("row", 0.5, MIN, MIN), minimized: [] })), "_", "整体塌成空槽");
});
t("normalize：minimized 与树互补（树里有 → 从 minimized 去掉）", () => {
  const state = normalize({ root: split("row", 0.5, panel("stage"), panel("toolpanel")), minimized: ["stage", "branch", "branch"] });
  assert.deepEqual(state.minimized, ["branch"]);
});
t("normalize：幂等 + 不改原对象（深冻结输入）", () => {
  const source = deepFreeze(move(defaultState(), "preview", "toolpanel", "right"));
  const once = normalize(source, ["toolpanel", "stage", "preview"]);
  const twice = normalize(once, ["toolpanel", "stage", "preview"]);
  assert.equal(stringify(once), stringify(twice));
  assert.equal(stringify(source), stringify(move(defaultState(), "preview", "toolpanel", "right")), "原对象未被改写");
});
t("normalize：visible=undefined 全可见；visible=[\"toolpanel\",\"stage\"] 过滤 preview", () => {
  const on = move(defaultState(), "preview", "toolpanel", "right");
  assert.equal(ids(normalize(on)).includes("preview"), true);
  assert.equal(ids(normalize(on, ["toolpanel", "stage"])).includes("preview"), false);
});
t("normalize：结构合法（没有单子 split / 没有空 split）", () => {
  const check = (node, where) => {
    if (node.t !== "split") return;
    assert.equal(node.a != null && node.b != null, true, `${where} 有空孩子`);
    check(node.a, `${where}a`);
    check(node.b, `${where}b`);
  };
  check(defaultState().root, "root");
  check(normalize(move(defaultState(), "stage", "toolpanel", "left"), undefined).root, "moved");
});

// ══ (g) minimize / restore ════════════════════════════
t("minimize：从树里摘掉并记进 minimized", () => {
  const state = defaultState();
  const after = minimize(state, "stage");
  assert.equal(has(after, "stage"), false);
  assert.deepEqual(after.minimized, ["stage"]);
  assert.equal(stringify(after), "(toolpanel|placeholder%32)", "右列只剩 holder（stage 的旧位置折叠）");
});
t("minimize：不在树里也安全（幂等，不重复记录）", () => {
  const once = minimize(defaultState(), "branch");
  const twice = minimize(once, "branch");
  assert.deepEqual(twice.minimized, ["branch"]);
});
t("restore：放回树里并从 minimized 移除", () => {
  const off = minimize(defaultState(), "stage");
  const on = restore(off, "stage", "toolpanel", "right");
  assert.equal(has(on, "stage"), true);
  assert.deepEqual(on.minimized, []);
  assert.deepEqual([...ids(on)].sort(), ["stage", "toolpanel"]);
});

// ══ (h-0) UI 锚点用的辅助函数 ═════════════════════════
t("clampShareValue：UI 换算像素→比例后的收口（0.12…0.88）", () => {
  assert.equal(clampShareValue(0), 0.12);
  assert.equal(clampShareValue(10), 0.88);
  assert.equal(clampShareValue(Number.NaN), 0.5);
});
t("firstSplitPath / childAt / size：UI 落点与分隔条定位用", () => {
  const state = defaultState();
  assert.deepEqual(firstSplitPath(state), []);
  assert.deepEqual(firstSplitPath({ root: { t: "panel", id: "stage" }, minimized: [] }), null);
  assert.equal(stack.childAt(pathNode(state.root, [1]), 0).t, "holder");
  assert.equal(stack.childAt(pathNode(state.root, [1]), 1).t, "panel");
  assert.equal(size(state), 3);
  assert.equal(size(defaultState()), 3);
});
t("has()：树里有/没有（minimize 后的 Map 面板）", () => {
  assert.equal(has(defaultState(), "stage"), true);
  assert.equal(has(defaultState(), "branch"), false);
  assert.equal(has(minimize(defaultState(), "toolpanel"), "toolpanel"), false);
});

// ══ (h) workbenchLayout：存储 / 迁移 ═══════════════════
t("layoutKey：default 走无名键、其余加名字", () => {
  assert.equal(layout.layoutKey("default"), "prts-editor-wb:default");
  assert.equal(layout.layoutKey("我的布局"), "prts-editor-wb:我的布局");
  assert.equal(layout.WB_KEY_ACTIVE, "prts-editor-wb:active");
});
t("saveLayout/readLayout/listLayouts/activeLayout（内存 localStorage）", () => {
  installStorage({});
  assert.equal(layout.listLayouts().length, 0);
  assert.equal(layout.activeLayout(), "default");
  layout.saveLayoutNamed("default", stringify(defaultState()));
  layout.saveLayoutNamed("宽舞台", stringify(resize(defaultState(), [0], 0.2)));
  assert.deepEqual(layout.listLayouts().sort(), ["default", "宽舞台"].sort());
  assert.equal(layout.activeLayout(), "宽舞台");
  assert.equal(layout.readLayout("宽舞台"), stringify(resize(defaultState(), [0], 0.2)));
  assert.equal(layout.readLayout("不存在"), null);
  assert.deepEqual(parse(layout.readActiveLayout()).root, resize(defaultState(), [0], 0.2).root);
  layout.deleteLayout("宽舞台");
  assert.deepEqual(layout.listLayouts(), ["default"]);
  assert.equal(layout.activeLayout(), "default");
});
t("saveLayout / loadLayout（§2.4 名字）：复制活跃布局、切换 active", () => {
  installStorage({});
  layout.saveLayoutNamed("default", stringify(defaultState()));
  layout.saveLayout("双栏"); // 不给文本 = 复制当前活跃布局
  assert.equal(layout.readLayout("双栏"), stringify(defaultState()));
  assert.equal(layout.loadLayout("双栏"), true);
  assert.equal(layout.activeLayout(), "双栏");
  assert.equal(layout.loadLayout("没有这个"), false);
  assert.equal(layout.activeLayout(), "双栏", "失败的 load 不改 active");
});
t("migrateLegacy：旧 prts-editor-windows:* 只读一次后删除", () => {
  layout.consumeLegacy();
  const storage = installStorage({
    "prts-editor-windows:stage": JSON.stringify({ kind: "dock", side: "left" }),
    "prts-editor-windows:branch": JSON.stringify({ kind: "float", rect: { x: 12, y: 40, w: 430, h: 420 } }),
    "别的键": "keep",
  });
  layout.migrateLegacy();
  assert.equal(storage.getItem("prts-editor-windows:stage"), null);
  assert.equal(storage.getItem("prts-editor-windows:branch"), null);
  assert.equal(storage.getItem("别的键"), "keep");
  const found = layout.pendingLegacyWindows();
  assert.deepEqual(found.map((item) => item.panel).sort(), ["branch", "stage"]);
  assert.deepEqual(found.find((item) => item.panel === "branch").state, { kind: "float", rect: { x: 12, y: 40, w: 430, h: 420 } });
  assert.equal(layout.legacyMigrated(), true);
  layout.migrateLegacy(); // 第二次：旧键已没 → 读到空，结果清空
  assert.deepEqual(layout.pendingLegacyWindows(), []);
});
t("migrateLegacy：显式键（harness 用）只碰传入的键、坏 JSON 跳过", () => {
  const storage = installStorage({ "prts-editor-windows:panel": "{坏 json", "prts-editor-windows:preview": JSON.stringify({ kind: "dock", side: "right" }) });
  layout.migrateLegacy(["prts-editor-windows:preview", "prts-editor-windows:panel"]);
  assert.equal(storage.getItem("prts-editor-windows:preview"), null);
  assert.deepEqual(layout.consumeLegacy().map((item) => item.panel), ["preview"]);
  assert.equal(storage.getItem("prts-editor-windows:missing"), null);
});

// ══ (h-1) JSON 形状 / 坏输入健壮性 ════════════════════
t("parse：undefined / 非字符串 → null（P5 读坏持久化时不炸）", () => {
  assert.equal(parse(undefined), null);
  assert.equal(parse(null), null);
  assert.equal(parse(42), null);
});
t("normalize：缺 root（旧/坏持久化）→ 空槽而不是抛异常", () => {
  assert.equal(stringify(normalize({ root: null, minimized: [] })), "_");
  assert.equal(stringify(normalize(undefined ?? { root: null, minimized: [] })), "_");
});
t("move/resize/reorder 对坏输入是安全空操作", () => {
  const state = defaultState();
  assert.equal(stringify(move({ root: null, minimized: [] }, "preview", "root", "right")), "preview", "只剩它自己");
  assert.equal(stringify(resize({ root: null, minimized: [] }, [0], 0.4)), "_");
  assert.equal(stringify(normalize(undefined)), "_");
  assert.equal(stringify(reorder(state, "preview", "preview", "before")), stringify(state));
});
t("stringify(JSON.parse(stringify(x))) 形状稳定（持久化产物字段不变）", () => {
  const text = stringify(move(resize(defaultState(), [0], 0.4), "preview", "stage", "top"));
  const round = JSON.parse(JSON.stringify(parse(text)));
  assert.deepEqual(Object.keys(round).sort(), ["minimized", "root"]);
  assert.equal(stringify(round), text);
});

// ══ (i) 随机稳定性（固定种子，可复现） ═════════════════
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function structuralAudit(state) {
  const seen = new Set();
  const walk = (node, where) => {
    assert.ok(node && typeof node === "object", `${where}: 空节点`);
    if (node.t === "split") {
      assert.equal(node.dir === "row" || node.dir === "col", true, `${where}: dir=${node.dir}`);
      assert.equal(Number.isFinite(node.share), true, `${where}: share=${node.share}`);
      assert.ok(node.share >= layout.SHARE_MIN - 1e-9 && node.share <= layout.SHARE_MAX + 1e-9, `${where}: share=${node.share} 越界`);
      assert.ok(node.a && node.b, `${where}: 单子 split`);
      walk(node.a, `${where}a`);
      walk(node.b, `${where}b`);
      return;
    }
    assert.ok(node.t === "panel" || node.t === "holder" || node.t === "min", `${where}: t=${node.t}`);
    if (node.t === "panel") {
      assert.ok(layout.PANELS.includes(node.id), `${where}: 未知 id=${node.id}`);
      assert.equal(seen.has(node.id), false, `${where}: id=${node.id} 出现两次`);
      seen.add(node.id);
    }
  };
  walk(state.root, "root");
  for (const id of state.minimized) {
    assert.ok(layout.PANELS.includes(id), `minimized: 未知 id=${id}`);
    assert.equal(seen.has(id), false, `minimized: ${id} 同时在树里`);
  }
  assert.equal(new Set(state.minimized).size, state.minimized.length, "minimized 有重复");
  return seen.size;
}

function runFuzz(seed, rounds, visibleAll) {
  const rnd = mulberry32(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  let state = defaultState();
  let visible = [...layout.defaultVisible()];
  let digest = 0;
  let moves = 0;
  let resizes = 0;
  for (let round = 0; round < rounds; round += 1) {
    if (visibleAll) visible = ["toolpanel", "stage", "preview", "branch"]; // 每轮都全可见，保证 move 有东西可拖
    const roll = rnd();
    if (roll < 0.62) {
      const id = pick(layout.PANELS);
      const target = pick([...layout.PANELS, "root"]);
      const zone = pick(["left", "right", "top", "bottom", "center"]);
      state = move(state, id, target, zone);
      moves += 1;
    } else if (roll < 0.86) {
      const path = [Math.floor(rnd() * 3), Math.floor(rnd() * 3)].slice(0, Math.floor(rnd() * 2) + 1);
      state = resize(state, path, rnd() * 1.4 - 0.2);
      resizes += 1;
    } else if (roll < 0.94) {
      state = reorder(state, pick(layout.PANELS), pick(layout.PANELS), rnd() < 0.5 ? "before" : "after");
    } else if (roll < 0.97) {
      const id = pick(layout.PANELS);
      state = has(state, id) ? minimize(state, id) : restore(state, id, pick(["root", "stage", "toolpanel"]), pick(["left", "right", "top", "bottom"]));
    } else if (!visibleAll) {
      // Map 开关：关一个再开回来，断言"每个 id 只出现一次"始终成立。
      const id = pick(["preview", "branch"]);
      visible = visible.includes(id) ? visible.filter((value) => value !== id) : [...visible, id];
    }
    state = normalize(state, visible);
    // 每轮都做全量审计（比只查重复 id 更严：share / 结构 / minimized 互补）。
    const count = structuralAudit(state);
    const canon = stringify(state);
    const back = parse(canon);
    assert.ok(back, `第 ${round} 轮 stringify→parse 失败：${canon}`);
    assert.equal(stringify(back), canon, `第 ${round} 轮往返不等价`);
    assert.equal(ids(state).length, count, `第 ${round} 轮 ids 与树不一致`);
    digest = (digest * 31 + canon.length + canon.charCodeAt(0)) >>> 0;
  }
  return { state, digest, moves, resizes, summary: summarize(state) };
}

t(`随机稳定性：${ROUNDS} 次 move/resize/reorder/minimize（不抛异常 + 每个 id 只出现一次）`, () => {
  const result = runFuzz(20240607, ROUNDS, true);
  assert.ok(result.moves > 0 && result.resizes > 0, JSON.stringify(result));
  structuralAudit(result.state);
});
t(`随机稳定性（含 visible 切换）：${ROUNDS} 次，Map 关掉再开回不产生重复`, () => {
  const result = runFuzz(987654321, ROUNDS, false);
  structuralAudit(result.state);
});
t("随机结果可复现（同一 seed → 同一摘要）", () => {
  const a = runFuzz(42, 80, false);
  const b = runFuzz(42, 80, false);
  assert.equal(a.digest, b.digest);
  assert.equal(stringify(a.state), stringify(b.state));
});
t("随机 + 落盘往返：把 fuzz 产物存进 localStorage 再读回来等价", () => {
  installStorage({});
  const result = runFuzz(7, 60, true);
  layout.saveLayoutNamed("default", stringify(result.state));
  const back = parse(layout.readLayout("default"));
  assert.ok(back);
  assert.equal(stringify(back), stringify(result.state));
});

// ── 结果 ──────────────────────────────────────────────
const jsonOut = arg("json", null);
if (jsonOut) writeFileSync(resolve(jsonOut), JSON.stringify({ pass, fail, rows }, null, 1));
console.log(`\n${pass}/${pass + fail} ok${fail ? ` — ${fail} FAIL` : ""}`);
process.exit(fail ? 1 : 0);
