/**
 * `workbenchLayout.ts` —— 工作台**规格表 + 持久化 + 旧状态迁移**（BRIEF-workbench-v1 §2.4）。
 *
 * 三层分工：
 * - **规格**（本文件）：面板标题 / 最小尺寸 / dock|map 语义（`WINDOW_SPECS`，P4/P5/T6 都 import；
 *   名字与字段**不可改**）；
 * - **纯模型**（`workbenchStack.ts`）：布局树、`move` / `resize` / `minimize`；
 * - **容器**（`Workbench.tsx`）：递归渲染 + 分隔条 + 拖拽会话。
 *
 * 持久化键（§2.1）：
 * - `prts-editor-wb:default`        默认（无名）布局
 * - `prts-editor-wb:<name>`         命名布局
 * - `prts-editor-wb:active`        当前活跃布局名
 * - 旧键 `prts-editor-windows:*`    `readWindowState` 形状 `{kind:"dock",side}` | `{kind:"float",rect}`
 *   —— `migrateLegacy()` **只读一次后删除**，并把 dock/map 惯例落成新的默认布局 JSON。
 *
 * 本文件零 React：`localStorage` 缺失（Node / 隐私模式）时全部是安全空操作。
 */

import { getItem, listKeys, removeItem, setItem, hydrate } from "../../lib/stateStore.ts";
import type { PanelId } from "./workbenchStack";

export type { PanelId };

/** 面板清单（顺序 = 默认工具栏顺序，也是 §2.1 的常量顺序）。 */
export const PANELS: PanelId[] = ["toolpanel", "stage", "preview", "branch"];

export interface WindowSpec {
  /** 标题条文字；窗口根 `data-win="<title>"`、`aria-label` 都用它。 */
  title: string;
  /** `true` = Map 面板（工具栏按需开关，关掉即从工作台移除）。 */
  map: boolean;
  minW: number;
  minH: number;
  /** 工具栏/列出顺序（小 → 前）。 */
  order: number;
  kind: "dock" | "map";
}

/**
 * **全局规格表**（P4/P5/T6 都 import）。
 * toolpanel / stage = 常驻 dock（标题条**没有** `⧉`、**没有** `✕`）；
 * preview / branch = Map（`预览`、`⌥ 分支图` 开关）。
 */
export const WINDOW_SPECS: Record<PanelId, WindowSpec> = {
  toolpanel: { title: "工具面板", map: false, minW: 240, minH: 160, order: 10, kind: "dock" },
  stage: { title: "舞台", map: false, minW: 280, minH: 160, order: 20, kind: "dock" },
  preview: { title: "预览", map: true, minW: 320, minH: 200, order: 30, kind: "map" },
  branch: { title: "分支图", map: true, minW: 320, minH: 200, order: 40, kind: "map" },
};

/** 触碰阈值：拖动超过这么多像素才算「拖起来了」（低于它 = 点击/双击）。 */
export const WB_DRAG_THRESHOLD = 4;
/**
 * 分隔条**视觉**厚度（px）；`workbench.css` 的 `.wb-gutter` 与之一致。
 * 视觉上要细（用户："划区边太宽了"），但**命中区**靠 `::after` 外扩到
 * `WB_GUTTER_HIT`（抓起来不费劲）。
 */
export const WB_GUTTER_SIZE = 4;
/** 分隔条命中区总宽（px）：`padding` 之外再外扩 `(HIT-SIZE)/2`，保证好抓。 */
export const WB_GUTTER_HIT = 18;
/** 面板块的缺省最小尺寸（树里第一个面板推不出来时兜底）。 */
export const WB_FALLBACK_MIN = { minW: 160, minH: 120 };

/** 分隔条 share 的合法区间（两条都要 clamp 到这里，§2.3）。 */
export const SHARE_MIN = 0.12;
export const SHARE_MAX = 0.88;

/** 类型守卫：任意字符串 → `PanelId`。 */
export function isPanelId(value: unknown): value is PanelId {
  return typeof value === "string" && (PANELS as string[]).includes(value);
}

/** 标题（未知 id 回落到 id 本身）。 */
export function titleOf(id: PanelId): string {
  return WINDOW_SPECS[id]?.title ?? String(id);
}

/** 规格（未知 id 回落到一个安全的 dock 缺省）。 */
export function specOf(id: PanelId): WindowSpec {
  return WINDOW_SPECS[id] ?? { title: String(id), map: false, minW: 160, minH: 120, order: 99, kind: "dock" };
}

/** Map 语义（工具栏按需开关）。 */
export function isMapPanel(id: PanelId): boolean {
  return specOf(id).map;
}

/** 常驻 dock 面板（toolpanel / stage）：默认可见。 */
export function isDockPanel(id: PanelId): boolean {
  return !isMapPanel(id);
}

/** 默认可见清单：常驻 dock。 */
export function defaultVisible(): PanelId[] {
  return PANELS.filter(isDockPanel);
}

/** 按 `order` 排序的面板清单（工具栏按钮 / 最小化项渲染用）。 */
export function panelsInOrder(): PanelId[] {
  return [...PANELS].sort((a, b) => specOf(a).order - specOf(b).order);
}

// ── localStorage 键 ─────────────────────────────────────

export const WB_KEY_PREFIX = "prts-editor-wb:";
export const WB_KEY_DEFAULT = "prts-editor-wb:default";
export const WB_KEY_ACTIVE = "prts-editor-wb:active";
export const LEGACY_KEY_PREFIX = "prts-editor-windows:";
export const DEFAULT_LAYOUT_NAME = "default";

/** 名字 → 存储键（`default` 走无名键）。 */
export function layoutKey(name: string): string {
  const clean = String(name ?? "").trim() || DEFAULT_LAYOUT_NAME;
  return clean === DEFAULT_LAYOUT_NAME ? WB_KEY_DEFAULT : `${WB_KEY_PREFIX}${clean}`;
}

// 工作台布局是**渲染期同步读**：模块加载时就把 `scope=workspace` 拉进内存
// （`hydrate()` 幂等；无 Tauri 时同步完成）。
void hydrate();

/**
 * `localStorage` 适配（**仅供旧键迁移**：`migrateLegacy` 读 `prts-editor-windows:*`，
 * 那些键在新版本里只可能存在于旧 WebView 的 localStorage；迁移后即删）。
 */
function store(): Storage | null {
  try {
    const g = globalThis as { window?: { localStorage?: Storage }; localStorage?: Storage };
    const ls = g.window?.localStorage ?? g.localStorage;
    if (!ls || typeof ls.getItem !== "function") return null;
    return ls;
  } catch {
    return null; // 某些 WebView 在隐私模式下访问 localStorage 会抛
  }
}

/** 迁移专用：从 **localStorage** 读旧键（不经过 DB；`prts-editor-windows:*` 是旧版遗留）。 */
function readLegacyRaw(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** 迁移专用：删 localStorage 里的旧键。 */
function removeLegacyRaw(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * 读写落到 `stateStore`（`state.db`，scope=workspace）——**不是** `localStorage`：
 * 工作台排版属于"记忆"，清缓存/换 WebView 不该丢。无 Tauri / DB 坏时
 * `stateStore` 自动回落 `localStorage`（同一批键名）。
 */
function readRaw(key: string): string | null {
  try {
    return getItem("workspace", key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    setItem("workspace", key, value);
  } catch {
    // 落库失败 / 隐私模式：持久化只是便利，不是功能（内存里仍生效）。
  }
}

function removeRaw(key: string): void {
  try {
    removeItem("workspace", key);
  } catch {
    // 同上
  }
}

/** scope=workspace 里现有的键（DB 的 `state_db_snapshot` 已在 hydrate 时进内存）。 */
function allKeys(): string[] {
  try {
    return listKeys("workspace");
  } catch {
    return [];
  }
}

// ── 命名布局 ───────────────────────────────────────────

/**
 * 已保存的命名布局（不含保留了 layout JSON 的 `default`——它总是存在）。
 * 名字按字典序，`default` 若已落盘则**排在最前**。
 */
export function listLayouts(): string[] {
  const names = new Set<string>();
  const savedDefault = readRaw(WB_KEY_DEFAULT) != null;
  for (const key of allKeys()) {
    if (!key.startsWith(WB_KEY_PREFIX)) continue;
    const name = key.slice(WB_KEY_PREFIX.length);
    if (!name || name === "active" || name === DEFAULT_LAYOUT_NAME) continue;
    names.add(name);
  }
  const rest = [...names].sort();
  return savedDefault ? [DEFAULT_LAYOUT_NAME, ...rest] : rest;
}

/** 把当前状态存成命名布局（`default` 存无名键）。`text` = `workbenchStack.stringify(state)`。 */
export function saveLayoutNamed(name: string, text: string): boolean {
  const key = layoutKey(name);
  writeRaw(key, String(text ?? ""));
  writeRaw(WB_KEY_ACTIVE, String(name ?? "").trim() || DEFAULT_LAYOUT_NAME);
  return readRaw(key) != null;
}

/** 读取命名布局文本（没有 → null）。 */
export function readLayout(name: string): string | null {
  const raw = readRaw(layoutKey(name));
  return raw && raw.trim() ? raw : null;
}

/** 删除命名布局（`default` 可删；删活跃布局时把 active 指回 `default`）。 */
export function deleteLayout(name: string): void {
  const clean = String(name ?? "").trim() || DEFAULT_LAYOUT_NAME;
  removeRaw(layoutKey(clean));
  if (readRaw(WB_KEY_ACTIVE) === clean) writeRaw(WB_KEY_ACTIVE, DEFAULT_LAYOUT_NAME);
}

// ── 视图状态（面板开关 / 浮动窗 / 折叠）──────────────────────────────
//
// 为什么**不**和布局文本合并：布局串只描述"树里怎么分屏"（`workbenchStack`
// 的 `stringify`/`parse`，格式对用户可见）；"哪几个 Map 面板开着""哪个窗浮着"
// 是**另一个维度**，塞进串里会污染格式，也让旧串解析变复杂。所以单开一条
// `prts-editor-wb:view`（JSON），只做"记忆"。

/** 视图状态键。 */
export const WB_KEY_VIEW = "prts-editor-wb:view";

/**
 * 控制器检视器（`Toolpanel` 顶部那块）的尺寸记忆。
 * 用户原话「检视器大小固定了 太难用」→ 拖拽条 + 落盘；**不是**布局树的一部分
 * （它不参与分屏，只是面板内一块可调高的区域），所以挂在视图状态里。
 */
export const INSPECTOR_MIN_H = 140;
export const INSPECTOR_MAX_H = 900;
export const INSPECTOR_DEFAULT_H = 240;

/** 面板视图状态（持久化形状；坏数据逐字段回落）。 */
export interface WorkbenchView {
  /** 树里（可见）的面板。 */
  visible: string[];
  /** 浮动窗矩形：`panelId → {x,y,w,h}`。 */
  floats: Record<string, { x: number; y: number; w: number; h: number }>;
  /** 收起（`▾`）的面板。 */
  folded: string[];
  /** 控制器检视器：高度（px）+ 显示。旧数据缺省 → 默认高度、显示。 */
  inspector?: { height: number; visible: boolean };
}

/** 读视图状态；没存过 / 坏 JSON → `null`（调用方用默认）。 */
export function readView(): WorkbenchView | null {
  const raw = readRaw(WB_KEY_VIEW);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkbenchView>;
    const rect = (value: unknown): { x: number; y: number; w: number; h: number } | null => {
      if (!value || typeof value !== "object") return null;
      const v = value as Record<string, unknown>;
      const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : null);
      const [x, y, w, h] = [num(v.x), num(v.y), num(v.w), num(v.h)];
      if (x === null || y === null || w === null || h === null) return null;
      return { x, y, w, h };
    };
    const floats: WorkbenchView["floats"] = {};
    if (parsed.floats && typeof parsed.floats === "object") {
      for (const [id, value] of Object.entries(parsed.floats)) {
        const r = rect(value);
        if (r) floats[id] = r;
      }
    }
    const inspectorRaw = parsed.inspector as { height?: unknown; visible?: unknown } | undefined;
    const inspector = (() => {
      if (!inspectorRaw || typeof inspectorRaw !== "object") return undefined;
      const height = typeof inspectorRaw.height === "number" && Number.isFinite(inspectorRaw.height)
        ? Math.round(inspectorRaw.height)
        : null;
      if (height === null) return undefined;
      return { height, visible: inspectorRaw.visible !== false };
    })();
    return {
      visible: Array.isArray(parsed.visible) ? parsed.visible.filter((id): id is string => typeof id === "string") : [],
      floats,
      folded: Array.isArray(parsed.folded) ? parsed.folded.filter((id): id is string => typeof id === "string") : [],
      inspector,
    };
  } catch {
    return null;
  }
}

/** 写视图状态（旧数据里没有 `inspector` → 保留默认，不写死）。 */
export function saveView(view: Partial<WorkbenchView>): void {
  const previous = readView();
  const next: WorkbenchView = {
    visible: Array.isArray(view.visible) ? view.visible : [],
    floats: view.floats ?? {},
    folded: Array.isArray(view.folded) ? view.folded : [],
    inspector: view.inspector ?? previous?.inspector,
  };
  try {
    writeRaw(WB_KEY_VIEW, JSON.stringify(next));
  } catch {
    // 落库失败只是"这次没记住"
  }
}

/** 活跃布局名（没存过 → `default`）。 */
export function activeLayout(): string {
  const raw = (readRaw(WB_KEY_ACTIVE) ?? "").trim();
  return raw || DEFAULT_LAYOUT_NAME;
}

/**
 * `saveLayout(name)` / `loadLayout(name)` 的**模型绑定**：`text` 由 `workbenchStack` 解析。
 * 之所以分成两层：`workbenchLayout` 不 import 模型（避免环），P5 传 `parse` / `stringify` 进来。
 */
export interface LayoutCodec {
  parse: (text: string) => unknown;
  stringify: (state: unknown) => string;
}

/** 保存当前状态到命名布局。 */
export function saveLayoutWith(codec: LayoutCodec, name: string, state: unknown): boolean {
  try {
    return saveLayoutNamed(name, codec.stringify(state));
  } catch {
    return false;
  }
}

/** 读取命名布局（解析成功才返回，坏 JSON → null）。 */
export function loadLayoutWith(codec: LayoutCodec, name: string): unknown | null {
  const raw = readLayout(name);
  if (!raw) return null;
  try {
    const parsed = codec.parse(raw);
    return parsed ?? null;
  } catch {
    return null;
  }
}

/**
 * §2.4 的 `saveLayout(name)`：不给 `text` 时把**当前活跃布局**的文本复制成命名布局
 * （`saveLayoutNamed(name, text)` 是带文本的显式版本；持久的布局 JSON 由
 * `workbenchStack.stringify` 产出）。
 */
export function saveLayout(name: string, text?: string): void {
  const clean = String(name ?? "").trim() || DEFAULT_LAYOUT_NAME;
  if (typeof text === "string") {
    saveLayoutNamed(clean, text);
    return;
  }
  const source = readLayout(activeLayout()) ?? readRaw(WB_KEY_DEFAULT);
  if (source) saveLayoutNamed(clean, source);
  else writeRaw(WB_KEY_ACTIVE, clean);
}

/**
 * §2.4 的 `loadLayout(name)`：存在则把 `active` 指向它并返回 true。
 * 解析由调用方用 `parse`（或 `loadLayoutWith`）做——本文件不 import 模型。
 */
export function loadLayout(name: string): boolean {
  const clean = String(name ?? "").trim() || DEFAULT_LAYOUT_NAME;
  if (!readLayout(clean)) return false;
  writeRaw(WB_KEY_ACTIVE, clean);
  return true;
}

/** 当前活跃布局的文本（没有 → null）。 */
export function readActiveLayout(): string | null {
  return readLayout(activeLayout());
}

// ── 旧窗口状态迁移（一次性） ────────────────────────────

/** 旧 `windowState.readWindowState` 的形状（只读，别改）。 */
export type LegacyWindowState =
  | { kind: "dock"; side: "left" | "right" }
  | { kind: "float"; rect: { x: number; y: number; w: number; h: number } };

export interface LegacyWindow {
  key: string;
  panel: PanelId | null;
  state: LegacyWindowState;
}

const MIGRATION_MARK = "prts-editor-wb:migrated";

let pendingLegacy: LegacyWindow[] = [];

/** 上次 `migrateLegacy()` 读到的旧窗口（P5 用来决定 Map 面板是否默认打开；`consumeLegacy()` 取走后清空）。 */
export function pendingLegacyWindows(): LegacyWindow[] {
  return [...pendingLegacy];
}

/** 取走并清空迁移结果。 */
export function consumeLegacy(): LegacyWindow[] {
  const out = pendingLegacy;
  pendingLegacy = [];
  return out;
}

function parseLegacy(raw: string | null): LegacyWindowState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { kind?: unknown; side?: unknown; rect?: { x: number; y: number; w: number; h: number } };
    if (!value || typeof value !== "object") return null;
    if (value.kind === "dock") {
      return { kind: "dock", side: value.side === "left" ? "left" : "right" };
    }
    if (value.kind === "float" && value.rect) {
      const { x, y, w, h } = value.rect;
      if ([x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) {
        return { kind: "float", rect: { x, y, w, h } };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 旧键后缀 → PanelId（`prts-editor-windows:panel` → `toolpanel`）。 */
export function legacyPanelOf(key: string): PanelId | null {
  const suffix = key.startsWith(LEGACY_KEY_PREFIX) ? key.slice(LEGACY_KEY_PREFIX.length) : key;
  const map: Record<string, PanelId> = {
    panel: "toolpanel",
    toolpanel: "toolpanel",
    stage: "stage",
    preview: "preview",
    branch: "branch",
  };
  return map[suffix] ?? null;
}

/** 旧 float 窗口落成布局的哪一侧（`w`/位置只做粗判：够用即可）。 */
function zoneOfLegacy(state: LegacyWindowState, fallback: "left" | "right"): "left" | "right" {
  if (state.kind === "dock") return state.side;
  return fallback;
}

/** 旧 float 的显隐：`{kind:"float"}` = 曾经开过 → 视为可见（P5 可用 `consumeLegacy()` 调整）。 */
function visibleFromLegacy(_state: LegacyWindowState): boolean {
  void _state;
  return true;
}

/**
 * 一次性迁移旧的 `prts-editor-windows:*`（§2.1）：
 * 1. 读每条旧记录（形状见 `LegacyWindowState`）；
 * 2. **已落盘的布局 JSON 本体不动**（`Workbench.tsx` 的 `readWorkbench` / P5 用
 *    `consumeLegacy()` 的结果决定 Map 面板默认显隐）——布局 JSON 的键/形状由 `workbenchStack`
 *    决定，这里**不**解析，避免与模型耦合；
 * 3. 迁移标记 `prts-editor-wb:migrated`（`?reset` 语义：删掉它即可再跑一次）；
 * 4. 删除读过的旧键（一次性）。
 *
 * `previousStorageKeys` 传入时只处理这些键（harness 用；此时**不**删旧键，避免影响真实环境）。
 */
export function migrateLegacy(previousStorageKeys?: string[]): void {
  try {
    const explicit = previousStorageKeys != null;
    const keys = explicit
      ? [...new Set(previousStorageKeys.map((key) => String(key)))]
      : legacyKeysFromStore().filter((key) => key.startsWith(LEGACY_KEY_PREFIX));
    if (!keys.length) {
      pendingLegacy = []; // 没有旧键 → 「待迁移」结果也清空（第二次调用后不留残影）
      return;
    }
    if (!explicit && (readLegacyRaw(MIGRATION_MARK) === "1" || readRaw(MIGRATION_MARK) === "1")) {
      // 已经迁过：仍把残留键清干净（例如用户从旧版本回滚又升级）。
      for (const key of keys) removeLegacyRaw(key);
      return;
    }
    const found: LegacyWindow[] = [];
    for (const key of keys) {
      const parsed = parseLegacy(readLegacyRaw(key));
      if (!parsed) continue;
      found.push({ key, panel: legacyPanelOf(key), state: parsed });
    }
    pendingLegacy = found;
    for (const key of keys) removeLegacyRaw(key);
    try {
      store()?.setItem(MIGRATION_MARK, "1");
    } catch {
      /* 迁移标记写不进也只是下次再跑一次（幂等） */
    }
  } catch {
    // 迁移失败不影响启动。
  }
}

/** 迁移专用：localStorage 里现有的键（**不**经过 DB）。 */
function legacyKeysFromStore(): string[] {
  const ls = store();
  if (!ls) return [];
  try {
    const out: string[] = [];
    for (let i = 0; i < ls.length; i += 1) {
      const key = ls.key(i);
      if (typeof key === "string") out.push(key);
    }
    return out;
  } catch {
    return [];
  }
}

/** 迁移是否已跑过（测试/诊断用）：localStorage 或 DB 任一有标记即算。 */
export function legacyMigrated(): boolean {
  return readLegacyRaw(MIGRATION_MARK) === "1" || readRaw(MIGRATION_MARK) === "1";
}

/** 旧选项 → 新布局建议（P5 可以直接拿去 `move`）：返回「面板 → 落点 zone」。 */
export function legacyFallbackPlacement(legacy: LegacyWindow[]): Array<{ panel: PanelId; zone: "left" | "right" }> {
  const out: Array<{ panel: PanelId; zone: "left" | "right" }> = [];
  for (const item of legacy) {
    if (!item.panel || item.panel === "toolpanel" || item.panel === "stage") {
      if (item.panel) out.push({ panel: item.panel, zone: zoneOfLegacy(item.state, item.panel === "stage" ? "left" : "right") });
      continue;
    }
    // Map 面板：float 的旧记录（`branch` 默认 float）→ 右侧；dock → 记录侧。
    out.push({ panel: item.panel, zone: zoneOfLegacy(item.state, "right") });
    void visibleFromLegacy(item.state);
  }
  return out;
}
