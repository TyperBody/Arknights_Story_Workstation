/**
 * `workbenchStack.ts` —— 工作台**布局树纯模型**（契约：`build/ctx/BRIEF-workbench-v1.md` §2.3）。
 *
 * 「IDE 式拼接」的全部语义都在这里（特征「拼接工作区 + 自由调换位置」）：
 * - 拖标题条到别的面板**左/右/上/下边缘** → `move(..., zone)` 在该处**建 split**（吸附分屏）；
 * - 拖到面板**中心** → `move(..., "center")` = **换位**（新面板顶掉目标位置，目标接管旧位置）；
 * - 拖分隔条 → `resize(path, share)`；
 * - 关闭 Map 面板 → `minimize` / `visible`（树里消失）；再打开 → `restore`（优先放回原位）。
 *
 * 本文件**零 React / 零 DOM**（只用 `workbenchLayout.ts` 的常量表），`node` 可直接 import：
 * `node build/harness/wb-selftest.mjs`。
 *
 * ## 不变量（`normalize` 保证，`move`/`resize`/`reorder`/`minimize` 的产物都过一遍）
 * 1. 每个 `PanelId` 在树里**最多出现一次**（去重时保留先出现的那份）；
 * 2. 不可见（`visible` 之外）的面板不在树里；单子 split 折叠、空 split 删除；
 * 3. `share` ∈ [0.12, 0.88]（`NaN` → 0.5）；
 * 4. `minimized` 与树互补：树里有的不进 `minimized`，重复项去掉。
 *
 * ## `path` 的形状
 * 由根到节点、逐层 `0` = `a` / `1` = `b` 的下标数组。`pathTo(state, id)` 给**叶子**路径；
 * 渲染层/`resize` 用 `pathNode(root, path)` 定位 split。**DOM 渲染顺序**：`a` 在前（左/上），
 * `b` 在后（右/下）。`isPath` 早就存在）。
 */

// `.ts` 后缀：`tsconfig.app.json` 开了 `allowImportingTsExtensions`，Vite 认；
// 好处是 `node build/harness/wb-selftest.mjs` 能**直接** import 这个文件（Node 原生
// 类型剥离不支持无后缀解析）。
import { SHARE_MAX, SHARE_MIN, isPanelId } from "./workbenchLayout.ts";

/** 可停靠/可拼接的面板（§2.1 常量，顺序即工具栏顺序）。 */
export type PanelId = "toolpanel" | "stage" | "preview" | "branch";

/** `row` = 左右分屏；`col` = 上下分屏。 */
export type Dir = "row" | "col";

/** 拖拽落点：4 个边缘 = 建 split；`center` = 换位。 */
export type Zone = "left" | "right" | "top" | "bottom" | "center";

/** 布局树节点（§2.3 逐字）。 */
export type Subject =
  | { t: "panel"; id: PanelId }
  | { t: "split"; dir: Dir; share: number; a: Subject; b: Subject }
  | { t: "holder" }
  | { t: "min" };

/** 「编辑区」(textarea) 占位叶；P5 在 `renderHolder()` 里渲染真正的内容。 */
export type Holder = { t: "holder" };

/** 最小化槽（没有可见面板时兜底的空槽）。 */
export type MinSlot = { t: "min" };

export interface WorkbenchState {
  root: Subject;
  /** 已收起（不在树里）的面板；Map 面板关闭时进这里，打开时原位恢复。 */
  minimized: PanelId[];
}

/** 序列化用的最小结构（`stringify`/`parse` 的输入输出都是它）。 */
export type SubjectLike = Subject;

const SHARE_DEFAULT = 0.5;

/** 默认布局的左侧占比。 */
export const DEFAULT_SHARE = 0.32;
/** 默认布局里编辑区（上）占比。 */
export const DEFAULT_HOLDER_SHARE = 0.62;

const HOLDER_NODE: Holder = { t: "holder" };
const MIN_NODE: MinSlot = { t: "min" };

const clampShare = (value: number): number =>
  Number.isFinite(value) ? Math.min(SHARE_MAX, Math.max(SHARE_MIN, value)) : SHARE_DEFAULT;

/** clamp `share` 到 §2.3 的 0.12…0.88（导出给渲染层做像素→比例换算后的收口）。 */
export function clampShareValue(value: number): number {
  return clampShare(value);
}

function isSplit(node: Subject | null | undefined): node is Extract<Subject, { t: "split" }> {
  return !!node && node.t === "split";
}

function isPanel(node: Subject | null | undefined): node is Extract<Subject, { t: "panel" }> {
  return !!node && node.t === "panel";
}

// ── 默认 / 规范化 ─────────────────────────────────────

/**
 * 默认布局（契约 §2.3）：
 * ```
 * row[ toolpanel(share .32) , col[ holder(.62) , stage ] ]
 * ```
 * `preview` / `branch` 是 Map：默认**不在树里**（工具栏打开时 `move` 进来）。
 */
export function defaultState(): WorkbenchState {
  return {
    root: {
      t: "split",
      dir: "row",
      share: DEFAULT_SHARE,
      a: { t: "panel", id: "toolpanel" },
      b: {
        t: "split",
        dir: "col",
        share: DEFAULT_HOLDER_SHARE,
        a: { ...HOLDER_NODE },
        b: { t: "panel", id: "stage" },
      },
    },
    minimized: [],
  };
}

/**
 * 规范化（幂等）：去重 / 删不可见 / 折叠单子 split / clamp share / 对齐 `minimized`。
 * `visible` 省略 = 所有面板都可见（`PANELS`）。
 */
export function normalize(state: WorkbenchState, visible?: PanelId[]): WorkbenchState {
  const allow = new Set<PanelId>(
    Array.isArray(visible) ? visible.filter(isPanelId) : (["toolpanel", "stage", "preview", "branch"] as PanelId[])
  );
  const taken = new Set<PanelId>();

  const clean = (node: Subject | null | undefined): Subject | null => {
    if (!node || typeof node !== "object") return null;
    if (node.t === "holder") return { ...HOLDER_NODE };
    // `{t:"min"}` 是**空槽**（删空叶）：单独出现时由根兜底保留，作为 split 的孩子时删掉。
    if (node.t === "min") return null;
    if (node.t === "panel") {
      const id = node.id;
      if (!isPanelId(id) || !allow.has(id) || taken.has(id)) return null;
      taken.add(id);
      return { t: "panel", id };
    }
    const dir: Dir = node.dir === "col" ? "col" : "row";
    const a = clean(node.a);
    const b = clean(node.b);
    if (!a && !b) return null;
    if (!a) return b;
    if (!b) return a;
    return { t: "split", dir, share: clampShare(node.share), a, b };
  };

  const root = clean(state?.root) ?? { ...MIN_NODE };

  const minimized: PanelId[] = [];
  for (const id of Array.isArray(state?.minimized) ? state.minimized : []) {
    if (!isPanelId(id) || !allow.has(id) || taken.has(id) || minimized.includes(id)) continue;
    minimized.push(id);
  }
  return { root, minimized };
}

// ── 遍历 / 定位 ─────────────────────────────────────

/** 树里出现的面板 id（**渲染顺序**：先 `a` 后 `b`）。 */
export function ids(state: WorkbenchState): PanelId[] {
  const out: PanelId[] = [];
  const walk = (node: Subject | null | undefined): void => {
    if (!node) return;
    if (isSplit(node)) {
      walk(node.a);
      walk(node.b);
      return;
    }
    if (isPanel(node) && !out.includes(node.id)) out.push(node.id);
  };
  walk(state?.root);
  return out;
}

/** 树里所有叶子 id（`holder` → `"holder"`、`min` → `"min"`）；调试/断言用。 */
export function leaves(state: WorkbenchState): string[] {
  const out: string[] = [];
  const walk = (node: Subject): void => {
    if (isSplit(node)) {
      walk(node.a);
      walk(node.b);
    } else if (isPanel(node)) out.push(node.id);
    else out.push(node.t);
  };
  if (state?.root) walk(state.root);
  return out;
}

/** 叶子数量（`holder` / `min` 也算）；harness/渲染调试用。 */
export function size(state: WorkbenchState): number {
  return leaves(state).length;
}

/** 面板在树里吗？ */
export function has(state: WorkbenchState, id: PanelId): boolean {
  return pathTo(state, id) != null;
}

/** `root` → `path` 的节点；路径走不通 → `null`。 */
export function pathNode(root: Subject | null | undefined, path: readonly number[]): Subject | null {
  let node: Subject | undefined = root ?? undefined;
  for (const step of Array.isArray(path) ? path : []) {
    if (!node || node.t !== "split") return null;
    node = step === 0 ? node.a : node.b;
  }
  return node ?? null;
}

/** 面板叶子的模型路径；不在树里 → `null`。 */
export function pathTo(state: WorkbenchState, id: PanelId): number[] | null {
  const walk = (node: Subject, prefix: number[]): number[] | null => {
    if (isPanel(node)) return node.id === id ? prefix : null;
    if (isSplit(node)) return walk(node.a, [...prefix, 0]) ?? walk(node.b, [...prefix, 1]);
    return null;
  };
  if (!state?.root) return null;
  return walk(state.root, []);
}

/** 找到面板的父 split（`share` 调整 / 兄弟换位用）；根面板 → `null`。 */
export function parentOf(
  state: WorkbenchState,
  id: PanelId
): { path: number[]; parent: Extract<Subject, { t: "split" }>; side: 0 | 1 } | null {
  const path = pathTo(state, id);
  if (!path || path.length === 0) return null;
  const parent = pathNode(state.root, path.slice(0, -1));
  if (!isSplit(parent)) return null;
  return { path, parent, side: path[path.length - 1] === 0 ? 0 : 1 };
}

/** 不可变替换：`root` 的 `path` 处换成 `next`；`path` 为空即整体替换。 */
export function replace(root: Subject, path: readonly number[], next: Subject): Subject {
  if (!path.length) return next;
  if (!isSplit(root)) return next;
  const [head, ...tail] = path;
  return head === 0
    ? { ...root, a: replace(root.a, tail, next) }
    : { ...root, b: replace(root.b, tail, next) };
}

/** `split` 的孩子（`side` 0 = a / 1 = b）；叶子 → null。 */
export function childAt(node: Subject | null | undefined, side: 0 | 1): Subject | null {
  if (!node || node.t !== "split") return null;
  return side === 0 ? node.a : node.b;
}

/** 删除 `path` 处的叶子：父 split 用幸存的那个孩子顶上。 */
export function drop(root: Subject, path: readonly number[]): Subject | null {
  if (!path.length) return null;
  const parentPath = path.slice(0, -1);
  const side = path[path.length - 1];
  const parent = pathNode(root, parentPath);
  if (!isSplit(parent)) return root;
  return replace(root, parentPath, side === 0 ? parent.b : parent.a);
}

/** 建 split：`node` 落在 `zone` 一侧，`anchor` 在另一侧（`row` 左右 / `col` 上下）。 */
export function splitAt(anchor: Subject, node: Subject, zone: Exclude<Zone, "center">): Subject {
  const dir: Dir = zone === "left" || zone === "right" ? "row" : "col";
  const first = zone === "left" || zone === "top";
  return {
    t: "split",
    dir,
    share: SHARE_DEFAULT,
    a: first ? node : anchor,
    b: first ? anchor : node,
  };
}

// ── 变换 ───────────────────────────────────────────

/** `normalize` 的 `visible` 参数：**树里的 id 一律可见**；`extra` 里若都是
 *  空 → `null`（= 全可见）。别传 `[]`——`normalize` 里 `Array.isArray([])` 为真，
 *  会把整棵树清空。 */
function visibleFilter(state: WorkbenchState, extra: PanelId[]): PanelId[] | undefined {
  const out = ids(state);
  for (const id of extra) if (isPanelId(id) && !out.includes(id)) out.push(id);
  return out.length ? out : undefined;
}

/**
 * 把 `id` 移到 `target` 的 `zone`（或 `"root"`）。
 *
 * - `zone = "center"` 且 `target` 是**树里的**面板 → **换位**：`id` 顶掉 `target` 的位置，
 *   `target` 去 `id` 原来的位置（两片叶子路径互换，树的形状不变）；
 * - `zone = left|right|top|bottom` → 在 `target` 的该侧建 split（`target` 保持在位），
 *   **`id` 原来的位置会折叠**（搬走就是搬走，不留空洞）；
 * - `target = "root"`：`center` = 该面板独占整个工作台；边缘 = 在整棵树的那一侧分屏；
 * - `id` 已是最新且 `target` 是它自己 → 原样返回。
 */
export function move(state: WorkbenchState, id: PanelId, target: PanelId | "root", zone: Zone): WorkbenchState {
  if (!state || !isPanelId(id)) return state;
  const visible = visibleFilter(state, isPanelId(target) ? [id, target] : [id]);
  const base = normalize(state, visible);
  const zoneSafe: Zone = zone === "center" || zone === "left" || zone === "right" || zone === "top" ? zone : zone === "bottom" ? "bottom" : "right";
  const node: Subject = { t: "panel", id };

  // target 是自身且只是原地 → 不动
  if (target === id) {
    if (zoneSafe === "center") return base;
    const selfPath = pathTo(base, id);
    if (!selfPath) return base;
    return base;
  }

  const pathA = pathTo(base, id);
  const removed = pathA ? drop(base.root, pathA) : base.root;
  const afterRemove: WorkbenchState = normalize(
    { root: removed ?? { ...MIN_NODE }, minimized: base.minimized.filter((value) => value !== id) },
    visible
  );

  if (zoneSafe === "center") {
    if (target === "root") {
      // 拖到整个工作台的中心 = 该面板独占（其余面板进 minimized，仍可再拖出来）。
      const rest = ids(afterRemove);
      return normalize({ root: node, minimized: [...afterRemove.minimized, ...rest] }, visible);
    }
    const pathB = pathTo(base, target);
    if (!pathA || !pathB) {
      // id 或 target 不在树里：插到 target 左侧（不破坏 target），语义可预期。
      const anchorPath = pathB ?? pathTo(afterRemove, target);
      const anchorNode = anchorPath ? pathNode(afterRemove.root, anchorPath) : null;
      if (anchorPath && anchorNode) {
        return normalize(
          { root: replace(afterRemove.root, anchorPath, splitAt(anchorNode, node, "left")), minimized: afterRemove.minimized },
          visible
        );
      }
      return normalize({ root: splitAt(afterRemove.root, node, "left"), minimized: afterRemove.minimized }, visible);
    }
    // 换位：两片**叶子**路径互换（叶子互不为祖先，原地替换不会互相影响路径）。
    const swapped = replace(replace(base.root, pathA, { t: "panel", id: target as PanelId }), pathB, node);
    return normalize({ root: swapped, minimized: base.minimized.filter((value) => value !== id && value !== target) }, visible);
  }

  if (target === "root") {
    return normalize(
      { root: splitAt(afterRemove.root, node, zoneSafe), minimized: afterRemove.minimized },
      visible
    );
  }
  const pathB = pathTo(afterRemove, target);
  const anchor = pathB ? pathNode(afterRemove.root, pathB) : null;
  if (!pathB || !anchor) {
    return normalize(
      { root: splitAt(afterRemove.root, node, zoneSafe), minimized: afterRemove.minimized },
      visible
    );
  }
  return normalize(
    { root: replace(afterRemove.root, pathB, splitAt(anchor, node, zoneSafe)), minimized: afterRemove.minimized },
    visible
  );
}

/**
 * 分隔条：把 `path` 处的 split 的 `share` 设为 `share`（clamp 0.12…0.88）。
 * `path = []` / 路径过期（树被拖动改过形）时回落到**根 split**，保证「拖分隔条总是有反应」。
 */
export function resize(state: WorkbenchState, path: readonly number[], share: number): WorkbenchState {
  if (!state?.root) return state;
  const value = clampShare(share);
  const asked = (Array.isArray(path) ? path : []).filter((step) => step === 0 || step === 1);
  const candidates: number[][] = [];
  for (let cut = asked.length; cut >= 0; cut -= 1) candidates.push(asked.slice(0, cut));
  for (const candidate of candidates) {
    const node = pathNode(state.root, candidate);
    if (!isSplit(node)) continue;
    if (node.share === value) return state;
    return { root: replace(state.root, candidate, { ...node, share: value }), minimized: [...state.minimized] };
  }
  return state;
}

/** 树里最外层 split 的路径（先序；根是 split → `[]`）；树里没有 split → `null`。
 *  `resize(state, firstSplitPath(state), share)` = 拖最外层的分隔条。 */
export function firstSplitPath(state: WorkbenchState): number[] | null {
  return state?.root && state.root.t === "split" ? [] : null;
}

/**
 * 同级换序：把 `id` 放到 `targetId` 的 `before`/`after`。
 * - 两者是**同一个 split 的孩子** → 直接交换两侧（几何随槽位，`share` 不动）；
 * - 否则 = `move(..., targetId, "before" ? "left" : "right")`（跨容器用左右分屏表达）。
 */
export function reorder(state: WorkbenchState, id: PanelId, targetId: PanelId, place: "before" | "after"): WorkbenchState {
  if (!state || id === targetId) return state;
  const pa = parentOf(state, id);
  const pb = parentOf(state, targetId);
  const sameParent =
    pa && pb && pa.parent === pb.parent && pa.path.length === pb.path.length && pa.path.slice(0, -1).join("/") === pb.path.slice(0, -1).join("/");
  if (sameParent) {
    const side = place === "before" ? 0 : 1;
    if (pa.side === side) return state; // 已经就位
    const path = pa.path.slice(0, -1);
    const parent = pa.parent;
    const nodeA = { t: "panel", id } as Subject;
    const nodeB = { t: "panel", id: targetId } as Subject;
    const nextSplit: Subject = side === 0 ? { ...parent, a: nodeA, b: nodeB } : { ...parent, a: nodeB, b: nodeA };
    const root = path.length ? replace(state.root, path, nextSplit) : nextSplit;
    return normalize({ root, minimized: state.minimized }, visibleFilter(state, []));
  }
  return move(state, id, targetId, place === "before" ? "left" : "right");
}

/** 收起面板（从树里摘掉、记进 `minimized`，之后 `restore` 放回原位附近）。 */
export function minimize(state: WorkbenchState, id: PanelId): WorkbenchState {
  if (!state || !isPanelId(id)) return state;
  if (!has(state, id)) {
    return normalize({ root: state.root, minimized: [...state.minimized, id] }, visibleFilter(state, [id]));
  }
  const path = pathTo(state, id)!;
  const root = drop(state.root, path) ?? { ...MIN_NODE };
  const stripped: WorkbenchState = { root, minimized: [...state.minimized, id] };
  const normalized = normalize(stripped, visibleFilter(state, []));
  return { root: normalized.root, minimized: normalized.minimized.includes(id) ? normalized.minimized : [...normalized.minimized, id] };
}

/** 打开面板（Map 的「原位恢复」：默认放回根右侧；`target` + `zone` 可指定落点）。 */
export function restore(
  state: WorkbenchState,
  id: PanelId,
  target: PanelId | "root" = "root",
  zone: Zone = "right"
): WorkbenchState {
  if (!state || !isPanelId(id) || has(state, id)) return state;
  const without: WorkbenchState = { root: state.root, minimized: state.minimized.filter((value) => value !== id) };
  return move(without, id, target, zone);
}

// ── 紧凑文本 ─────────────────────────────────────

/** 树 → 紧凑文本。`panel` → `id`、`holder` → `placeholder`、`min` → `_`；
 *  `row` → `(a|b)`、`col` → `{a/b}`；非默认 share 追加 `%NN`（百分数整数）。 */
export function stringify(state: WorkbenchState): string {
  const walk = (node: Subject | null | undefined): string => {
    if (!node) return "";
    if (node.t === "holder") return "placeholder";
    if (node.t === "min") return "_";
    if (isPanel(node)) return node.id;
    const open = node.dir === "row" ? "(" : "{";
    const close = node.dir === "row" ? ")" : "}";
    const sep = node.dir === "row" ? "|" : "/";
    const pct = Math.round(clampShare(node.share) * 100);
    const tail = Math.abs(pct - 50) < 0.5 ? "" : `%${pct}`;
    return `${open}${walk(node.a)}${sep}${walk(node.b)}${tail}${close}`;
  };
  // 空/坏状态 → `_`（空槽）：`parse(stringify(x))` 的往返更稳，UI 也能显示"空工作台"。
  return walk(state?.root) || "_";
}

/** `stringify` 的逆：空白随便加；形状/`%NN` 严格，坏输入 → `null`。 */
export function parse(text: string): WorkbenchState | null {
  if (typeof text !== "string") return null;
  const src = text.trim();
  if (!src) return null;
  let at = 0;

  const fail = Symbol("fail");
  const skip = (): void => {
    while (at < src.length && /\s/.test(src[at]!)) at += 1;
  };
  const word = (): string | null => {
    skip();
    let end = at;
    while (end < src.length && /[A-Za-z0-9_]/.test(src[end]!)) end += 1;
    if (end === at) return null;
    const out = src.slice(at, end);
    at = end;
    return out;
  };
  const group = (dir: Dir): Subject | typeof fail => {
    const open = dir === "row" ? "(" : "{";
    const close = dir === "row" ? ")" : "}";
    const sep = dir === "row" ? "|" : "/";
    skip();
    if (src[at] !== open) return fail;
    at += 1;
    const a = node();
    if (a === fail) return fail;
    skip();
    if (src[at] !== sep) return fail;
    at += 1;
    const b = node();
    if (b === fail) return fail;
    skip();
    let share = SHARE_DEFAULT;
    if (src[at] === "%") {
      at += 1;
      let end = at;
      while (end < src.length && /[0-9]/.test(src[end]!)) end += 1;
      if (end === at) return fail;
      share = Number(src.slice(at, end)) / 100;
      at = end;
    }
    skip();
    if (src[at] !== close) return fail;
    at += 1;
    return { t: "split", dir, share: clampShare(share), a, b };
  };
  const node = (): Subject | typeof fail => {
    skip();
    const ch = src[at];
    if (!ch) return fail;
    if (ch === "(") return group("row");
    if (ch === "{") return group("col");
    if (ch === "_") {
      at += 1;
      return { ...MIN_NODE };
    }
    const token = word();
    if (token == null) return fail;
    if (token === "placeholder" || token === "holder") return { ...HOLDER_NODE };
    if (token === "min") return { ...MIN_NODE };
    if (isPanelId(token)) return { t: "panel", id: token };
    return fail;
  };

  const root = node();
  if (root === fail) return null;
  skip();
  if (at !== src.length) return null;
  return normalize({ root, minimized: [] }, ids({ root, minimized: [] }));
}

/** 人话摘要（状态条 / 日志用）：`工具面板 32% │ (编辑区 62% / 舞台)`。 */
export function summarize(state: WorkbenchState): string {
  const walk = (node: Subject | null | undefined): string => {
    if (!node) return "空";
    if (node.t === "holder") return "编辑区";
    if (node.t === "min") return "（空槽）";
    if (isPanel(node)) return node.id;
    const dir = node.dir === "row" ? "│" : "／";
    const pct = Math.round(clampShare(node.share) * 100);
    return `${walk(node.a)} ${pct}% ${dir} ${walk(node.b)}`;
  };
  const dims = state?.minimized?.length ? ` 收起：${state.minimized.join("、")}` : "";
  return `${walk(state?.root)}${dims}`;
}
