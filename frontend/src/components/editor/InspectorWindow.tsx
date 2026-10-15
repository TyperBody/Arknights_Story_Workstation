/**
 * `InspectorWindow` —— 工作台里的**窗口壳**（task-15 交付 B 的 2.0）。
 *
 * 语义（BRIEF-workbench-v1 §0.2 / §2.1；用户原话「检视器在工具面板 所以不应该和其他窗口
 * 一样单开脱离按钮 并且这是显示不显示也不是独立窗口阿」）：
 * - **`dock`（常驻 dock 块）**：toolpanel / stage（`shellKind="dock"`）。标题条
 *   **没有 `⧉`、没有 `✕`** —— 它不会"单开"、也不会"关闭"，只能在拼接区里吸附 / 调尺寸。
 *   标题条右侧只留折叠 `▾`（`chrome.onToggle`）；有 `onDragStart` 时拖动交给 P3 的
 *   `Workbench`（壳只负责"超过 4px 就把会话连元素和起始尺寸一起交出去"）。
 * - **`map`（按需地图面板）**：preview / branch（`shellKind="map"` + `state.kind==="map"`）。
 *   工具栏开关决定**在不在**；`✕` = 从工作台移除；`⧉` 保留 = 「停靠块 ↔ 浮动窗」。
 *   块形态下右下角是**比例拖拽**（`onResizeShare`，交给 P3 的分隔条）。
 * - **`float`（浮动窗）**：标题条拖动 + 右下角像素缩放（P3 没给 `onResizeShare` 时）。
 *
 * 三种形态全部由受控 prop `state` + `onChange` 表达；DOM 上是 `data-win-state = dock|map|float`。
 * ⚠️ 标记纪律：`data-win` / `data-win-state` / `ed-win-bar` / `ed-win-btn` / `data-drag-handle`
 * / `data-resize-handle` **只增不改**（harness 断言用）；新增的按钮带 `data-win-action`。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { useT } from "../../i18n/index.ts";
import "./inspectorWindow.css";
import { clampWindowState, parseWindowState, writeWindowState, type WindowState } from "./windowState";
import type { PanelChromeProps } from "./inspectorWindow";

export type { DockState, FloatRect, MapState, WindowShellKind, WindowState } from "./windowState";

export interface InspectorWindowProps {
  title: string;
  state: WindowState;
  onChange: (next: WindowState) => void;
  onClose?: () => void;
  /** 「收进侧边栏」（`⇤`）：把这条面板挂到左侧 rail 上（用户口径：「侧边栏是
   *  用来快速隐藏选择的」）。给了才画这个按钮 —— dock 面板用它，Map 面板的
   *  `✕` 已经是同一个语义。 */
  onPark?: () => void;
  /** 浮动时的最小宽/高（默认 240 / 140）。 */
  minW?: number;
  minH?: number;
  /** 页面根尺寸（像素）：浮动矩形按它的口径换算/clamp；`absoluteRect` 时只用于 clamp 兜底。 */
  bounds: { w: number; h: number };
  /** 给了就持久化（形如 `prts-editor-wb:default`）。 */
  storageKey?: string;
  /** 标题条左侧的小图标/标签（可选）。 */
  icon?: ReactNode;
  children: ReactNode;

  // —— 面板语义（BRIEF §2.1 / §2.2） ——
  /** `"dock"` = 常驻拼接块（无 ⧉/✕）；`"map"` = 地图面板（✕ + ⧉）。默认按 `state` 推。 */
  shellKind?: "dock" | "map";
  /** 内容组件（P2 StagePane / T6 BranchGraph）的 chrome；壳只用 `visible`/`title`。 */
  chrome?: Partial<PanelChromeProps>;
  /** 标题条上选面板（活跃环）。 */
  onSelect?: () => void;
  /** 受控折叠；不给就用 `chrome.visible === false` 推断。 */
  collapsed?: boolean;
  /** 受控活跃（配合 `onSelect`）。 */
  active?: boolean;

  // —— 拼接（P3 Workbench 接管） ——
  /** pointerdown 后位移超过 4px 才算拖：把元素 + 起始尺寸交给 Workbench。 */
  onDragStart?: (node: HTMLElement, size: { w: number; h: number }) => void;
  /** 外部正在拖（Workbench 或本壳）：加半透明 + 禁选中。 */
  dragging?: boolean;
  /** 分隔条语义：给了就由右下角回报 share（0…1），不再走像素 rect。 */
  onResizeShare?: (share: number) => void;
  /** 分隔条是哪根轴（`row` = 改宽 / `col` = 改高）；默认按父容器形状猜。 */
  resizeAxis?: "row" | "col";
  /** 常驻块（没有分隔条）右下角像素 resize 的回报（可选）。 */
  onResizePx?: (size: { w: number; h: number }) => void;

  // —— 定位 ——
  /** 浮动时 `rect` 用"父容器坐标系里的绝对 CSS px"（而不是按 `bounds` 的百分比）。 */
  absoluteRect?: boolean;
  /** 合并进壳的 inline style（页面定位用；优先级最高）。 */
  style?: CSSProperties;
  /** `true` = 该壳正渲染在浮动层里（页面用；只影响标记，不影响行为）。 */
  detached?: boolean;
}

const MIN_DRAG = 4;
const SHARE_MIN = 0.12;
const SHARE_MAX = 0.88;
const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));

type Rect = { x: number; y: number; w: number; h: number };
type Axis = "row" | "col";

/** 定位父（`offsetParent`）：百分比 left/top 的口径就是它；showFloat 用它换算。 */
const offsetParentOf = (element: HTMLElement | null): HTMLElement | null =>
  (element?.offsetParent as HTMLElement | null) ?? null;

/** 父容器实测尺寸（量不到就回落 `fallback`）。 */
function parentSize(element: HTMLElement | null, fallback: { w: number; h: number }): { w: number; h: number } {
  const parent = offsetParentOf(element);
  if (!parent) return fallback;
  const rect = parent.getBoundingClientRect();
  return { w: rect.width > 1 ? rect.width : fallback.w, h: rect.height > 1 ? rect.height : fallback.h };
}

/** 默认浮动尺寸：屏幕中偏右、右侧留点余量（够用户立刻拖动/缩放）。 */
function defaultFloatRect(bounds: { w: number; h: number }, minW: number, minH: number): Rect {
  const w = clamp(Math.min(430, Math.round(bounds.w * 0.3)), minW, Math.max(minW, Math.round(bounds.w * 0.6)));
  // 浮动窗至少 300 高（Map 的图 / iframe 要地方）——和页面 `onWinChange` 的下限一致。
  const floor = Math.max(minH, 300);
  const h = clamp(Math.min(430, Math.round(bounds.h * 0.45)), floor, Math.max(floor, Math.round(bounds.h * 0.8)));
  return {
    w,
    h,
    x: clamp(Math.round(bounds.w * 0.5), 0, Math.max(0, bounds.w - w - 20)),
    y: clamp(Math.round(bounds.h * 0.12), 0, Math.max(0, bounds.h - h - 40)),
  };
}

type DragSession =
  | { mode: "handoff"; pointerX: number; pointerY: number }
  | { mode: "move"; pointerX: number; pointerY: number; rect: Rect }
  | { mode: "resize"; pointerX: number; pointerY: number; w: number; h: number; rect: Rect | null }
  | { mode: "share"; pointerX: number; pointerY: number; share: number; extent: number; axis: Axis };

export default function InspectorWindow({
  title,
  state,
  onChange,
  onClose,
  onPark,
  minW = 240,
  minH = 140,
  bounds,
  storageKey,
  icon,
  children,
  shellKind,
  chrome,
  onSelect,
  collapsed,
  active,
  onDragStart,
  dragging,
  onResizeShare,
  resizeAxis,
  onResizePx,
  absoluteRect = false,
  style,
  detached = false,
}: InspectorWindowProps) {
  const tr = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  /** 指针在壳内：`Escape` 在"刚拖完没点过输入框"时也要能关。 */
  const hoverRef = useRef(false);
  /** 上一次的停靠侧：浮动 → 停靠时恢复（常驻 dock 的老写法会用到）。 */
  const lastDockSide = useRef<"left" | "right">(state.kind === "dock" ? state.side : "right");
  /** 交接给 Workbench 的起始尺寸。 */
  const anchorSize = useRef<{ w: number; h: number } | null>(null);
  /** 常驻块（没有分隔条）右下角像素 resize 的本地尺寸。 */
  const [localSize, setLocalSize] = useState<{ w: number; h: number } | null>(null);
  const [selfDragging, setSelfDragging] = useState(false);
  const dragRef = useRef<DragSession | null>(null);

  if (state.kind === "dock") lastDockSide.current = state.side;

  /** 面板语义：常驻 dock / 地图面板；浮动状态按"地图"处理（否则回不去）。 */
  const shell: "dock" | "map" = shellKind ?? (state.kind === "map" ? "map" : "dock");
  const floating = state.kind === "float";
  /**
   * **每块都能分离**（用户：「还不能分离窗口 分离了还只能在区里」）：常驻面板与 Map
   * 一样有 `⧉`；`✕`（= 从工作台移除）仍然只有 Map 才有意义。
   */
  const showFloatButton = true;
  const showClose = shell === "map" && Boolean(onClose);
  const foldHandler = chrome?.onToggle;
  const folded = collapsed ?? chrome?.visible === false;

  // bounds 变化（窗口缩放/布局变化）时把浮动窗口 clamp 回可见区域。
  // 首帧 `bounds` 还是 0（页面根尚未测量）→ 跳过，否则会把持久化的位置压成 (0,0)。
  useEffect(() => {
    if (state.kind !== "float") return;
    if (bounds.w <= 1 || bounds.h <= 1) return;
    const next = clampWindowState(state, bounds, minW, minH);
    const same =
      next.kind === "float" &&
      next.rect.x === state.rect.x &&
      next.rect.y === state.rect.y &&
      next.rect.w === state.rect.w &&
      next.rect.h === state.rect.h;
    if (!same) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 bounds 变化时 clamp
  }, [bounds.w, bounds.h, state.kind]);

  // 持久化（受控组件的副作用都收敛在这里）。
  useEffect(() => {
    writeWindowState(storageKey, state);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 状态本身是唯一输入
  }, [storageKey, JSON.stringify(state)]);

  /** storageKey 已存在但页面没做迁移时：把旧形状（dock/float）读出来（坏 JSON 静默）。 */
  useLayoutEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = parseWindowState(JSON.parse(raw));
      if (!parsed) return;
      if (parsed.kind === "dock" && state.kind === "dock" && parsed.side !== state.side) onChange(parsed);
      if (parsed.kind === "float" && state.kind !== "float") onChange(parsed);
    } catch {
      /* 坏 JSON：保持现状 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时兜底一次
  }, [storageKey]);

  const measure = useCallback((): { w: number; h: number } => {
    const element = rootRef.current;
    if (!element) return { w: 0, h: 0 };
    const rect = element.getBoundingClientRect();
    return { w: Math.round(rect.width), h: Math.round(rect.height) };
  }, []);

  /** 由当前块的位置派生浮动矩形。 */
  const rectForFloat = useCallback((): Rect => {
    const element = rootRef.current;
    const parent = offsetParentOf(element);
    const own = element?.getBoundingClientRect();
    if (!element || !parent || !own || own.width < 1) return defaultFloatRect(bounds, minW, minH);
    const parentRect = parent.getBoundingClientRect();
    const usable = parentSize(element, bounds);
    const scale = !absoluteRect && parentRect.width > 1 && usable.w > 1 ? usable.w / parentRect.width : 1;
    return {
      x: Math.round((own.left - parentRect.left) * scale),
      y: Math.round((own.top - parentRect.top) * scale),
      w: clamp(Math.round(own.width * scale), minW, Math.max(minW, Math.round(usable.w))),
      h: clamp(Math.round(own.height * scale), minH, Math.max(minH, Math.round(usable.h))),
    };
  }, [absoluteRect, bounds, minH, minW]);

  /** 双击标题条 / `⧉`：地图面板「块 ↔ 浮动窗」；常驻 dock 只在自己浮动时回停靠。 */
  const toggle = useCallback(() => {
    if (state.kind === "float") {
      if (shell === "dock") onChange({ kind: "dock", side: lastDockSide.current ?? "right" });
      else onChange({ kind: "map" });
      return;
    }
    onChange(clampWindowState({ kind: "float", rect: rectForFloat() }, bounds, minW, minH));
  }, [bounds, minH, minW, onChange, rectForFloat, shell, state.kind]);

  const resolveAxis = useCallback((): { axis: Axis; extent: number } => {
    const parentRect = offsetParentOf(rootRef.current)?.getBoundingClientRect();
    const axis: Axis = resizeAxis ?? (parentRect && parentRect.width >= parentRect.height ? "row" : "col");
    const extent = axis === "row" ? parentRect?.width ?? 0 : parentRect?.height ?? 0;
    return { axis, extent };
  }, [resizeAxis]);

  /** 标题条 pointerdown：浮动 = 拖动；块（dock/map）= 交给 Workbench（超过 4px）。 */
  const startBarPointer = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const target = event.target as HTMLElement | null;
      onSelect?.();
      // 点在标题条按钮上时别 setPointerCapture：捕获会把 `click` 派发给标题条而不是按钮
      // （浮动状态下点 ✕ 就永远关不掉）。
      if (target?.closest?.(".ed-win-btn, .ed-win-collapse")) return;
      if (state.kind === "float") {
        event.preventDefault(); // 防止选中标题文字 / 触发原生拖拽
        event.currentTarget.setPointerCapture?.(event.pointerId);
        dragRef.current = { mode: "move", pointerX: event.clientX, pointerY: event.clientY, rect: { ...state.rect } };
        setSelfDragging(true);
        return;
      }
      if (!onDragStart) return;
      event.preventDefault();
      anchorSize.current = measure();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      dragRef.current = { mode: "handoff", pointerX: event.clientX, pointerY: event.clientY };
    },
    [measure, onDragStart, onSelect, state]
  );

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      if (onResizeShare && !floating) {
        const { axis, extent } = resolveAxis();
        const own = rootRef.current?.getBoundingClientRect();
        const current = axis === "row" ? own?.width ?? 0 : own?.height ?? 0;
        dragRef.current = {
          mode: "share",
          pointerX: event.clientX,
          pointerY: event.clientY,
          share: extent > 1 ? clamp(current / extent, SHARE_MIN, SHARE_MAX) : 0.5,
          extent,
          axis,
        };
        setSelfDragging(true);
        return;
      }
      if (state.kind === "float") {
        dragRef.current = {
          mode: "resize",
          pointerX: event.clientX,
          pointerY: event.clientY,
          w: state.rect.w,
          h: state.rect.h,
          rect: { ...state.rect },
        };
      } else {
        const own = measure();
        dragRef.current = {
          mode: "resize",
          pointerX: event.clientX,
          pointerY: event.clientY,
          w: localSize?.w ?? own.w,
          h: localSize?.h ?? own.h,
          rect: null,
        };
      }
      setSelfDragging(true);
    },
    [floating, localSize, measure, onResizeShare, resolveAxis, state]
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.mode === "handoff") {
        if (Math.hypot(event.clientX - drag.pointerX, event.clientY - drag.pointerY) < MIN_DRAG) return;
        event.preventDefault();
        dragRef.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        // 交出去的是"标题条"（Workbench 在它上面接管指针 + 画 overlay/ghost）。
        const node = barRef.current ?? rootRef.current;
        setSelfDragging(true);
        if (node) onDragStart?.(node, anchorSize.current ?? measure());
        return;
      }
      event.preventDefault();
      if (drag.mode === "share") {
        const delta =
          (drag.axis === "row" ? event.clientX - drag.pointerX : event.clientY - drag.pointerY) /
          Math.max(1, drag.extent);
        onResizeShare?.(clamp(drag.share + delta, SHARE_MIN, SHARE_MAX));
        return;
      }
      const dx = event.clientX - drag.pointerX;
      const dy = event.clientY - drag.pointerY;
      if (drag.mode === "move") {
        // ⚠️ 容器（`Workbench` 的 `[data-wb-panel]` / `.bad-shell` / 页面）才是定位父：
        // 不能按页面 `bounds` clamp x/y，否则槽位在右侧时 rect 天然就是 (0,1)、一 clamp 就钉死。
        onChange({ kind: "float", rect: { ...drag.rect, x: drag.rect.x + dx, y: drag.rect.y + dy } });
        return;
      }
      const next = { w: Math.max(minW, Math.round(drag.w + dx)), h: Math.max(minH, Math.round(drag.h + dy)) };
      if (drag.rect) {
        // 浮动：像素 resize 回报成 rect；页面（或页面的 clamp）可以直接 clampWindowState。
        onChange({ kind: "float", rect: { ...drag.rect, ...next } });
      } else {
        setLocalSize(next);
        onResizePx?.(next);
      }
    },
    [measure, minH, minW, onChange, onDragStart, onResizePx, onResizeShare]
  );

  const endDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setSelfDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  // Escape 关闭：只对"地图面板"（有 ✕ 的）生效；常驻 dock 不该被 Esc 关掉。
  useEffect(() => {
    if (!onClose || !showClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const root = rootRef.current;
      const focused = document.activeElement;
      const inWindow = Boolean(root && focused && root.contains(focused));
      const bodyish = !focused || focused === document.body;
      if (!root || (!inWindow && !bodyish && !hoverRef.current)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, showClose]);

  const percentRect: CSSProperties | undefined =
    state.kind === "float"
      ? absoluteRect
        ? { position: "absolute", left: state.rect.x, top: state.rect.y, width: state.rect.w, height: state.rect.h }
        : {
            left: `${bounds.w > 0 ? (state.rect.x / bounds.w) * 100 : 0}%`,
            top: `${bounds.h > 0 ? (state.rect.y / bounds.h) * 100 : 0}%`,
            width: `${bounds.w > 0 ? (state.rect.w / bounds.w) * 100 : 100}%`,
            height: `${bounds.h > 0 ? (state.rect.h / bounds.h) * 100 : 100}%`,
          }
      : undefined;

  const busy = selfDragging || Boolean(dragging);
  const rootStyle: CSSProperties = {
    ...(percentRect ?? {}),
    ...(localSize && !floating && shell === "dock" ? { height: localSize.h } : {}),
    ...style,
  };

  return (
    <div
      ref={rootRef}
      className={`ed-win ed-win--${floating ? "float" : "block"} ed-win--${shell}${
        busy ? " ed-win--dragging" : ""
      }${folded ? " ed-win--folded" : ""}${active ? " ed-win--active" : ""}`}
      data-win={title}
      data-win-state={state.kind}
      data-shell={shell}
      data-wb-detached={detached ? "1" : undefined}
      style={rootStyle}
      onPointerEnter={() => {
        hoverRef.current = true;
      }}
      onPointerLeave={() => {
        hoverRef.current = false;
      }}
    >
      <div
        ref={barRef}
        className="ed-win-bar"
        data-drag-handle="1"
        onPointerDown={startBarPointer}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // 双击标题条 = 分离 ↔ 回停靠（常驻面板也适用：用户要的"分离/收回"）。
        onDoubleClick={toggle}
        title={
          floating
            ? tr("editor.window.barFloat", undefined, "拖动移动 · 双击回停靠")
            : shell === "map"
              ? tr("editor.window.barMap", undefined, "拖动拼接 · 双击（或 ⧉）浮动")
              : tr("editor.window.barDock", undefined, "常驻面板：拖到别的面板边缘拼接 · 折叠 ▾ 收起")
        }
      >
        {icon && <span className="ed-win-icon">{icon}</span>}
        <span className="ed-win-title">{title}</span>
        {folded && <span className="ed-win-fold-hint">{tr("editor.window.folded", undefined, "已收起")}</span>}
        <span className="ed-win-grow" />
        {onPark ? (
          <button
            type="button"
            className="ed-win-btn ed-win-park"
            data-win-action="park"
            onClick={onPark}
            title={tr("editor.window.park", undefined, "收进侧边栏")}
            aria-label={tr("editor.window.park", undefined, "收进侧边栏")}
          >
            ⇤
          </button>
        ) : null}
        {foldHandler ? (
          <button
            type="button"
            className="ed-win-btn ed-win-fold ed-win-collapse"
            data-win-action="fold"
            onClick={foldHandler}
            title={folded ? tr("editor.toolbar.foldShow", undefined, "展开") : tr("editor.toolbar.foldHide", undefined, "收起")}
            aria-label={folded ? tr("editor.window.expandPanel", undefined, "展开面板") : tr("editor.window.collapsePanel", undefined, "收起面板")}
            aria-expanded={!folded}
          >
            {folded ? "▸" : "▾"}
          </button>
        ) : null}
        {showFloatButton ? (
          <button
            type="button"
            className="ed-win-btn ed-win-float"
            data-win-action="float"
            onClick={toggle}
            title={floating ? tr("editor.window.dockBack", undefined, "停靠回工作台") : tr("editor.window.floatWindow", undefined, "浮动窗口")}
            aria-label={floating ? tr("editor.window.dockWindow", undefined, "停靠窗口") : tr("editor.window.floatWindow", undefined, "浮动窗口")}
          >
            ⧉
          </button>
        ) : null}
        {showClose ? (
          <button
            type="button"
            className="ed-win-btn ed-win-close"
            data-win-action="close"
            onClick={onClose}
            title={tr("editor.window.closeEsc", undefined, "关闭（Esc）")}
            aria-label={tr("editor.window.closeWindow", undefined, "关闭窗口")}
          >
            ✕
          </button>
        ) : null}
      </div>
      <div className="ed-win-body" hidden={folded || undefined}>
        {children}
      </div>
      <div
        className="ed-win-resize"
        data-resize-handle="1"
        onPointerDown={startResize}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title={onResizeShare && !floating ? tr("editor.window.resizeShare", undefined, "拖动调整比例") : tr("editor.window.resizeFree", undefined, "拖动调整大小")}
      />
    </div>
  );
}
