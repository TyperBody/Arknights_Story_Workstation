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

/** 无 `localStorage`（Node / 隐私模式 / `file://`）时返回 null。 */
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

function readRaw(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    store()?.setItem(key, value);
  } catch {
    // 配额满 / 隐私模式：持久化只是便利，不是功能。
  }
}

function removeRaw(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    // 同上
  }
}

function allKeys(): string[] {
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
      : allKeys().filter((key) => key.startsWith(LEGACY_KEY_PREFIX));
    if (!keys.length) {
      pendingLegacy = []; // 没有旧键 → 「待迁移」结果也清空（第二次调用后不留残影）
      return;
    }
    if (!explicit && readRaw(MIGRATION_MARK) === "1") {
      // 已经迁过：仍把残留键清干净（例如用户从旧版本回滚又升级）。
      for (const key of keys) removeRaw(key);
      return;
    }
    const found: LegacyWindow[] = [];
    for (const key of keys) {
      const parsed = parseLegacy(readRaw(key));
      if (!parsed) continue;
      found.push({ key, panel: legacyPanelOf(key), state: parsed });
    }
    pendingLegacy = found;
    for (const key of keys) removeRaw(key);
    writeRaw(MIGRATION_MARK, "1");
  } catch {
    // 迁移失败不影响启动。
  }
}

/** 迁移是否已跑过（测试/诊断用）。 */
export function legacyMigrated(): boolean {
  return readRaw(MIGRATION_MARK) === "1";
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
