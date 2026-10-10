/**
 * 工具窗口的**状态工具**（纯函数 + localStorage 读写）——从
 * `InspectorWindow.tsx` 拆出来，满足 react-refresh 的"只导出组件"规则，
 * 也方便被页面/自测脚本复用。
 *
 * 契约见 `InspectorWindow.tsx` 顶部；`WindowState` 的形状定义在那里
 * （这里用 `import type` 复用，避免循环依赖：`windowState.ts` → `InspectorWindow.tsx`
 * 只有类型引用，运行时无环）。
 */
import type { WindowState } from "./InspectorWindow";

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));

/** 从 localStorage 读状态；坏数据/无 window 时返回 null。 */
export function readWindowState(storageKey: string | undefined): WindowState | null {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WindowState;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.kind === "dock") {
      return parsed.side === "left" ? { kind: "dock", side: "left" } : { kind: "dock", side: "right" };
    }
    if (parsed.kind === "float" && parsed.rect) {
      const { x, y, w, h } = parsed.rect;
      if ([x, y, w, h].every((value) => typeof value === "number" && Number.isFinite(value))) {
        return { kind: "float", rect: { x, y, w, h } };
      }
    }
    return null;
  } catch {
    return null; // 坏 JSON / 隐私模式 → 用默认
  }
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

/** 把任意状态 clamp 进 `bounds`（`dock` 原样返回）。 */
export function clampWindowState(
  state: WindowState,
  bounds: { w: number; h: number },
  minW = 240,
  minH = 140
): WindowState {
  if (state.kind === "dock") return state;
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
