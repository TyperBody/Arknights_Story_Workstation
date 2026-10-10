/**
 * 工具窗口 / 工作台面板的**状态工具**（纯函数 + localStorage 读写）——从
 * `InspectorWindow.tsx` 拆出来，满足 react-refresh 的"只导出组件"规则，
 * 也方便被页面/自测脚本复用。
 *
 * 形态（BRIEF-workbench-v1 §2.1）：
 * - `{kind:"dock", side}`  旧形状（任务 15 的"停靠右栏/左栏"）；`windowState` 里仍完全保留，
 *   常驻面板 toolpanel / stage 工作台里就用它；
 * - `{kind:"float", rect}` 浮动窗（map 面板的 `⧉` 或双击标题条切换）；形状不变，旧数据可读；
 * - `{kind:"map"}`         新增：**按需临时浮层（不进布局树、也无 rect）**，preview / branch 用。
 *
 * ⚠️ 组件 `InspectorWindow.tsx` 从这里**再导出** `WindowState` / `DockState` / `FloatRect`
 *    （页面 `import { type WindowState } from "./InspectorWindow"` 的老写法继续有效），
 *    所以依赖方向是 `InspectorWindow.tsx → windowState.ts` 单向，无环。
 */

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));

/** 旧形状：停靠在页面某侧的常驻栏。 */
export interface DockState {
  kind: "dock";
  side: "left" | "right";
}

/** 浮动矩形：相对页面根（`.editor-page`）的像素。 */
export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 按需地图面板：不进布局树、没有矩形（位置由页面/工作台决定）。 */
export interface MapState {
  kind: "map";
}

export type WindowState = DockState | { kind: "float"; rect: FloatRect } | MapState;

/** 窗口壳的三种渲染形态（`data-win-state` 的取值域）。 */
export type WindowShellKind = WindowState["kind"];

export function isDockState(state: WindowState): state is DockState {
  return state.kind === "dock";
}

export function isFloatState(state: WindowState): state is { kind: "float"; rect: FloatRect } {
  return state.kind === "float";
}

export function isMapState(state: WindowState): state is MapState {
  return state.kind === "map";
}

/** 从 localStorage 读状态；坏数据/无 window 时返回 null。 */
export function readWindowState(storageKey: string | undefined): WindowState | null {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    return parseWindowState(JSON.parse(raw));
  } catch {
    return null; // 坏 JSON / 隐私模式 → 用默认
  }
}

/** 解析任意 JSON 成 `WindowState`（不认识/坏形状 → null）。纯函数，可单测。 */
export function parseWindowState(parsed: unknown): WindowState | null {
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Partial<DockState> & { kind?: string; rect?: Partial<FloatRect> };
  if (value.kind === "dock") {
    return value.side === "left" ? { kind: "dock", side: "left" } : { kind: "dock", side: "right" };
  }
  if (value.kind === "map") return { kind: "map" };
  if (value.kind === "float" && value.rect) {
    const { x, y, w, h } = value.rect;
    if ([x, y, w, h].every((item) => typeof item === "number" && Number.isFinite(item))) {
      return { kind: "float", rect: { x: x as number, y: y as number, w: w as number, h: h as number } };
    }
  }
  return null;
}

/** 写 localStorage（try/catch：`file://` / 隐私模式 / 配额满都不该影响页面）。 */
export function writeWindowState(storageKey: string | undefined, state: WindowState): void {
  if (!storageKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // 忽略：持久化只是便利，不是功能。
  }
}

/** 把任意状态 clamp 进 `bounds`（`dock` / `map` 原样返回）。 */
export function clampWindowState(
  state: WindowState,
  bounds: { w: number; h: number },
  minW = 240,
  minH = 140
): WindowState {
  if (state.kind === "dock" || state.kind === "map") return state;
  // 页面根还没测量（首帧 bounds = 0）：原样返回，别把持久化的位置压成 (0,0)。
  if (!(bounds.w > 1) || !(bounds.h > 1)) return state;
  const w = clamp(state.rect.w, Math.min(minW, Math.max(80, bounds.w)), Math.max(80, bounds.w));
  const h = clamp(state.rect.h, Math.min(minH, Math.max(60, bounds.h)), Math.max(60, bounds.h));
  return {
    kind: "float",
    rect: {
      w,
      h,
      x: clamp(state.rect.x, 0, Math.max(0, bounds.w - w)),
      y: clamp(state.rect.y, 0, Math.max(0, bounds.h - h)),
    },
  };
}
