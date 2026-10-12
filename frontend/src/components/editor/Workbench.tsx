/**
 * `Workbench.tsx` —— 工作台**容器**：递归渲染布局树 + 分隔条 + 拖拽拼接会话。
 *
 * 与 `workbenchStack.ts`（纯模型）的分工：
 * - **模型**决定「结构」（谁在谁旁边、share、minimized）；
 * - **容器**只做三件事：把树渲染成 flex 行/列、把指针动作翻译成 `move/resize` 调用、
 *   把结果 `onState(next)` 交回页面（并顺手持久化到 §2.1 的 `prts-editor-wb:*`）。
 *
 * 标记（harness 断言锚点，**只增不改**）：
 * - `[data-workbench]` 容器根；`[data-wb-panel="<id>"]` 面板块；`[data-wb-gutter]` 分隔条；
 * - `[data-wb-overlay]`+`data-wb-drop="left|right|top|bottom|center"` 落点提示；
 * - `[data-wb-min="<id>"]` 最小化项（点一下回树）。
 *
 * 拖拽会话（**Workbench 统一管理**，面板内容零改动即可拖）：
 * 1. 指针按在 `[data-drag-handle]` / `.ed-win-bar`（标题条）上 → 记下会话；
 * 2. 位移 ≥ `DRAG_THRESHOLD`(4px) 才算「拖起来了」（否则是普通点击/双击）；
 * 3. 悬停到某个面板块：边缘 25% → `left/right/top/bottom`、中心 → `center`（换位）；
 * 4. 松手 → `move(state, id, target, zone)`、`onState` + 持久化。
 * 分隔条：按下拖动改 `share`（受两侧 `minW/minH` 约束、模型层再 clamp 0.12…0.88）；
 * **双击**复位 50/50。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import "./workbench.css";
import {
  WB_DRAG_THRESHOLD,
  WB_GUTTER_HIT,
  WB_GUTTER_SIZE,
  saveLayoutNamed,
  specOf,
  titleOf,
  type PanelId,
} from "./workbenchLayout.ts";
import {
  clampShareValue,
  move,
  normalize,
  pathTo,
  resize,
  restore,
  stringify,
  type Subject,
  type WorkbenchState,
  type Zone,
} from "./workbenchStack.ts";
import { useT } from "../../i18n/index.ts";

/** 拖动多少像素才算「拖起来了」：`workbenchLayout.WB_DRAG_THRESHOLD`。 */
const DRAG_THRESHOLD = WB_DRAG_THRESHOLD;
/** 分隔条视觉厚度（px）：`workbenchLayout.WB_GUTTER_SIZE`。 */
const GUTTER_SIZE = WB_GUTTER_SIZE;
/** 分隔条命中区总宽（px）：`workbenchLayout.WB_GUTTER_HIT`。 */
const GUTTER_HIT = WB_GUTTER_HIT;
/** 命中区外扩量（两侧各 `(HIT - SIZE) / 2`）。 */
const GUTTER_PAD = Math.max(0, (GUTTER_HIT - GUTTER_SIZE) / 2);

/** `renderPanel` 的第二个参数：面板可以用它把标题条认成拖动把手。
 *  事件已由容器**委托**（`data-drag-handle` / `.ed-win-bar` 都能抓），P5 直接
 *  `<div className="ed-win-bar" {...handle.dragHandleProps}>` 即可。 */
export interface PanelHandle {
  dragHandleProps: { "data-drag-handle": "1" };
  dragging: boolean;
}

export interface WorkbenchProps {
  state: WorkbenchState;
  visible: PanelId[];
  onState: (next: WorkbenchState) => void;
  renderPanel: (id: PanelId, handle: PanelHandle) => ReactNode;
  renderHolder: () => ReactNode;
  /** 拖拽真正开始（过 4px 阈值）时回调；`size` = 被拖面板块的像素尺寸。 */
  onDragStart?: (node: Subject, size: { w: number; h: number }) => void;
  /** 拖拽中的额外图层（例如跟随指针的幽灵标题）；容器已 `pointer-events:none`。 */
  dragLayer?: ReactNode;
  /** 持久化用的布局名（`default` = `prts-editor-wb:default`）；`null` = 不持久化。 */
  layoutName?: string | null;
  /** 关掉某个 Map 面板时回调（页面据此同步工具栏开关；也可省）。 */
  onHide?: (id: PanelId) => void;
  /** 已分离（浮动）的面板（页面持有；本组件只负责"树里留洞 + 别把拖拽会话接过去"）。 */
  floats?: Partial<Record<PanelId, unknown>>;
  /** 拖标题条到工作台**外**松手 → 请求分离该面板（页面把它变成浮动窗）。 */
  onDetachRequested?: (id: PanelId, pointer: { x: number; y: number }) => void;
}

/** 一次拖拽会话。 */
interface DragSession {
  from: PanelId;
  node: Subject;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  size: { w: number; h: number };
}

/** 一次分隔条拖拽。 */
interface GutterSession {
  path: number[];
  dir: "row" | "col";
  element: HTMLElement;
  pointerId: number;
}

interface DropTarget {
  panel: PanelId;
  zone: Zone;
}

const zoneFromOffset = (rect: DOMRect, x: number, y: number, edge = 0.25): Zone => {
  const fx = rect.width > 0 ? (x - rect.left) / rect.width : 0.5;
  const fy = rect.height > 0 ? (y - rect.top) / rect.height : 0.5;
  if (fx < edge) return "left";
  if (fx > 1 - edge) return "right";
  if (fy < edge) return "top";
  if (fy > 1 - edge) return "bottom";
  return "center";
};

export default function Workbench({
  state,
  visible,
  onState,
  renderPanel,
  renderHolder,
  onDragStart,
  dragLayer,
  layoutName = "default",
  onHide,
  floats,
  onDetachRequested,
}: WorkbenchProps) {
  const tr = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragSession | null>(null);
  const gutterRef = useRef<GutterSession | null>(null);
  const hoverRef = useRef<DropTarget | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [dragging, setDragging] = useState<PanelId | null>(null);
  const [gutterActive, setGutterActive] = useState(false);
  /** 拖拽中指针在工作台**外**（松手 = 分离）。 */
  const [outside, setOutside] = useState(false);

  /** 渲染用的规范化树：`visible` 之外的面板不渲染（Map 关掉即从工作台移除）。 */
  const tree = useMemo(() => normalize(state, visible), [state, visible]);

  // ── 指针：拖拽会话 ─────────────────────────────────
  const endSession = useCallback(() => {
    dragRef.current = null;
    gutterRef.current = null;
    hoverRef.current = null;
    setDrop(null);
    setDragging(null);
    setGutterActive(false);
    setOutside(false);
  }, []);

  /** 指针是否在工作台里（不在 = 用户想"拖出去" → 分离）。 */
  const inWorkbench = useCallback((x: number, y: number): boolean => {
    const root = rootRef.current;
    if (!root) return true;
    const rect = root.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }, []);

  /** 命中测试：指针位置下的面板块 + zone（`[data-wb-panel]` 是唯一锚点）。 */
  const hitTest = useCallback((x: number, y: number): DropTarget | null => {
    const element = document.elementFromPoint(x, y) as HTMLElement | null;
    const panelEl = element?.closest?.("[data-wb-panel]") as HTMLElement | null;
    if (!panelEl) return null;
    const id = panelEl.getAttribute("data-wb-panel") as PanelId | null;
    if (!id) return null;
    return { panel: id, zone: zoneFromOffset(panelEl.getBoundingClientRect(), x, y) };
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      // 1) 分隔条
      const gutter = target?.closest?.("[data-wb-gutter]") as HTMLElement | null;
      if (gutter) {
        const path = (gutter.getAttribute("data-wb-path") ?? "")
          .split(",")
          .filter((part) => part !== "")
          .map((part) => Number(part));
        const dir = gutter.getAttribute("data-wb-dir") === "col" ? "col" : "row";
        if (path.some((step) => Number.isNaN(step))) return;
        event.preventDefault();
        gutterRef.current = { path, dir, element: gutter, pointerId: event.pointerId };
        setGutterActive(true);
        rootRef.current?.setPointerCapture?.(event.pointerId);
        return;
      }
      // 2) 标题条 / 显式把手 → 拖拽会话（4px 阈值后再算「拖起来了」）
      const handle = target?.closest?.("[data-drag-handle],.ed-win-bar") as HTMLElement | null;
      if (!handle) return;
      const panelEl = handle.closest("[data-wb-panel]") as HTMLElement | null;
      const id = panelEl?.getAttribute("data-wb-panel") as PanelId | null;
      if (!id || !panelEl) return;
      if (target?.closest?.(".ed-win-btn")) return; // 标题条按钮：别抢点击
      const rect = panelEl.getBoundingClientRect();
      dragRef.current = {
        from: id,
        node: { t: "panel", id },
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        size: { w: rect.width, h: rect.height },
      };
      hoverRef.current = { panel: id, zone: "center" };
      rootRef.current?.setPointerCapture?.(event.pointerId);
    },
    []
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const session = dragRef.current;
      if (session) {
        const dx = event.clientX - session.startX;
        const dy = event.clientY - session.startY;
        if (!session.active && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
          session.active = true;
          setDragging(session.from);
          onDragStart?.(session.node, session.size);
        }
        if (!session.active) return;
        event.preventDefault();
        const inside = inWorkbench(event.clientX, event.clientY);
        const hit = inside ? hitTest(event.clientX, event.clientY) : null;
        hoverRef.current = hit;
        setOutside(!inside);
        setDrop(hit && hit.panel === session.from && hit.zone === "center" ? null : hit);
        return;
      }
      const gutter = gutterRef.current;
      if (gutter) {
        event.preventDefault();
        const container = gutter.element.parentElement;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const usable = (gutter.dir === "row" ? rect.width : rect.height) - GUTTER_SIZE;
        if (!(usable > 1)) return;
        const pos =
          (gutter.dir === "row" ? event.clientX - rect.left : event.clientY - rect.top) - GUTTER_SIZE / 2;
        // 两侧 minW/minH：先把「像素下限」换算成比例下限，再交给模型 clamp（0.12…0.88）。
        const kids = [...container.children].filter((child) => !child.hasAttribute("data-wb-gutter")) as HTMLElement[];
        const first = kids[0];
        const second = kids[1];
        const minFirst = first ? (gutter.dir === "row" ? Number.parseFloat(getComputedStyle(first).minWidth) || 0 : Number.parseFloat(getComputedStyle(first).minHeight) || 0) : 0;
        const minSecond = second ? (gutter.dir === "row" ? Number.parseFloat(getComputedStyle(second).minWidth) || 0 : Number.parseFloat(getComputedStyle(second).minHeight) || 0) : 0;
        const lower = Math.min(0.88, Math.max(0.12, minFirst / usable));
        const upper = Math.min(0.88, Math.max(0.12, 1 - minSecond / usable));
        const share = clampShareValue(Math.min(Math.max(pos / usable, Math.min(lower, upper)), Math.max(lower, upper)));
        onState(resize(state, gutter.path, share));
        return;
      }
    },
    [hitTest, inWorkbench, onDragStart, onState, state]
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const session = dragRef.current;
      const gutter = gutterRef.current;
      if (session?.active) {
        const hit = hoverRef.current ?? (inWorkbench(event.clientX, event.clientY) ? hitTest(event.clientX, event.clientY) : null);
        if (hit) {
          const next = move(state, session.from, hit.panel, hit.zone);
          if (next !== state) {
            onState(next);
            if (layoutName) saveLayoutNamed(layoutName, stringify(next));
          }
        } else if (!inWorkbench(event.clientX, event.clientY) && onDetachRequested) {
          // 拖到工作台外 → 分离成独立窗口（坐标给页面，它自己算 rect）。
          onDetachRequested(session.from, { x: event.clientX, y: event.clientY });
        }
      }
      if (session || gutter) {
        (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
      }
      endSession();
    },
    [endSession, hitTest, inWorkbench, layoutName, onDetachRequested, onState, state]
  );

  // 指针离开窗口 / 取消：结束会话，别把 overlay 留在屏幕上。
  useEffect(() => {
    const cancel = () => { if (dragRef.current || gutterRef.current) endSession(); };
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, [endSession]);

  /** 双击分隔条 = 复位 50/50。 */
  const resetSplit = useCallback(
    (splitPath: number[]) => {
      const next = resize(state, splitPath, 0.5);
      onState(next);
      if (layoutName) saveLayoutNamed(layoutName, stringify(next));
    },
    [layoutName, onState, state]
  );

  // ── 渲染 ────────────────────────────────────────
  const slotStyle = (grow: number, min: number, dir: "row" | "col"): CSSProperties => ({
    flexGrow: grow,
    flexShrink: 1,
    flexBasis: 0,
    ...(dir === "row" ? { minWidth: min } : { minHeight: min }),
  });

  const renderNode = (
    node: Subject,
    path: number[],
    dir: "row" | "col",
    // 渲染期只读这两个**快照**（会话 ref 不参与渲染；会话进度由 setState 驱动重渲染）。
    snapshot: { drop: DropTarget | null; dragging: PanelId | null }
  ): ReactNode => {
    if (node.t === "split") {
      const splitDir = node.dir;
      const firstSpec = specOf(firstPanelId(node.a) ?? "toolpanel");
      const secondSpec = specOf(firstPanelId(node.b) ?? "stage");
      const firstMin = splitDir === "row" ? firstSpec.minW : firstSpec.minH;
      const secondMin = splitDir === "row" ? secondSpec.minW : secondSpec.minH;
      return (
        <div
          className={`wb-split wb-split--${splitDir}`}
          style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, minHeight: 0 }}
          data-wb-split={path.join(",") || "root"}
          data-wb-dir={splitDir}
        >
          <div className="wb-slot" style={slotStyle(node.share, firstMin, splitDir)} data-wb-slot="0">
            {renderNode(node.a, [...path, 0], splitDir, snapshot)}
          </div>
          <div
            className={`wb-gutter${gutterActive ? " wb-gutter--active" : ""}`}
            data-wb-gutter="1"
            data-wb-path={path.join(",")}
            data-wb-dir={splitDir}
            role="separator"
            aria-orientation={splitDir === "row" ? "vertical" : "horizontal"}
            title={tr("editor.workbench.gutterTitle", undefined, "拖动调整比例 · 双击复位 50/50")}
            onDoubleClick={() => resetSplit(path)}
          />
          <div className="wb-slot" style={slotStyle(1 - node.share, secondMin, splitDir)} data-wb-slot="1">
            {renderNode(node.b, [...path, 1], splitDir, snapshot)}
          </div>
        </div>
      );
    }
    if (node.t === "holder") {
      return (
        <div className="wb-holder" data-wb-holder="1">
          {renderHolder()}
        </div>
      );
    }
    if (node.t === "min") {
      return <div className="wb-empty" data-wb-empty="1" aria-hidden="true" />;
    }
    const id = node.id;
    const spec = specOf(id);
    const nodePath = pathTo(tree, id) ?? path;
    void dir;
    // 已分离（浮动）的面板：树里留**洞**（占位），内容渲染在 `[data-wb-float-layer]`。
    if (floats?.[id]) {
      return (
        <div
          className="wb-panel wb-panel--detached"
          data-wb-panel={id}
          data-wb-order={spec.order}
          style={{ minWidth: spec.minW, minHeight: spec.minH, position: "relative" }}
        >
          <div className="wb-float-hole" data-wb-float-hole={id} aria-hidden="true">
            <span className="wb-float-hole-label">{titleOf(id)}</span>
          </div>
          <span className="wb-panel-path" data-wb-path={nodePath.join(",")} hidden />
        </div>
      );
    }
    return (
      <div
        className={`wb-panel wb-panel--${spec.kind}${snapshot.dragging === id ? " wb-panel--dragging" : ""}`}
        data-wb-panel={id}
        data-wb-order={spec.order}
        style={{ minWidth: spec.minW, minHeight: spec.minH, position: "relative" }}
      >
        {renderPanel(id, {
          dragHandleProps: { "data-drag-handle": "1" },
          dragging: snapshot.dragging === id,
        })}
        {snapshot.drop?.panel === id && (
          <div
            className={`wb-overlay wb-overlay--${snapshot.drop.zone}`}
            data-wb-overlay="1"
            data-wb-drop={snapshot.drop.zone}
            aria-hidden="true"
          />
        )}
        <span className="wb-panel-path" data-wb-path={nodePath.join(",")} hidden />
      </div>
    );
  };

  const minimized = tree.minimized;
  return (
    <div
      className={`wb-root${dragging ? " wb-root--dragging" : ""}${gutterActive ? " wb-root--resizing" : ""}${outside ? " wb-root--detaching" : ""}`}
      data-workbench="1"
      data-detach-hint={tr("editor.workbench.detachHint", undefined, "松手 = 分离为独立窗口")}
      style={
        {
          "--wb-gutter-size": `${GUTTER_SIZE}px`,
          "--wb-gutter-pad": `${GUTTER_PAD}px`,
        } as CSSProperties
      }
      ref={rootRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="wb-tree">{renderNode(tree.root, [], "row", { drop, dragging })}</div>
      {dragLayer && (
        <div className="wb-drag-layer" data-wb-drag-layer="1" aria-hidden="true">
          {dragLayer}
        </div>
      )}
      {minimized.length > 0 && (
        <div className="wb-min-strip" data-wb-min-strip="1">
          <span className="wb-min-label">{tr("editor.toolbar.foldHide", undefined, "收起")}</span>
          {minimized.map((id) => (
            <button
              key={id}
              type="button"
              className="wb-min-item"
              data-wb-min={id}
              title={tr("editor.workbench.restoreTitle", { title: titleOf(id) }, `把「${titleOf(id)}」放回工作台（右侧分屏）`)}
              onClick={() => {
                const next = restore(tree, id, "root", "right");
                onState(next);
                if (layoutName) saveLayoutNamed(layoutName, stringify(next));
              }}
            >
              {titleOf(id)}
            </button>
          ))}
          {onHide && (
            <button
              type="button"
              className="wb-min-clear"
              onClick={() => minimized.forEach((id) => onHide(id))}
              title={tr("editor.workbench.clearTitle", undefined, "清空收起项")}
            >
              {tr("editor.workbench.clear", undefined, "清空")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** split 左侧/上侧第一个面板（推断 min 尺寸用）；没有面板（holder/min）→ null。 */
function firstPanelId(node: Subject): PanelId | null {
  if (!node) return null;
  if (node.t === "panel") return node.id;
  if (node.t === "split") return firstPanelId(node.a) ?? firstPanelId(node.b);
  return null;
}


