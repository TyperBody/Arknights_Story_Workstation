/**
 * `InspectorWindow` —— 可拖动 / 缩放 / 停靠 / 关闭的**工具窗口**壳子（task-15 交付 B）。
 *
 * 设计要点：
 * - **纯 DOM + React，无新依赖**；外观全在 `inspectorWindow.css`（Tailwind 风格命名）。
 * - **受控组件**：位置/尺寸由 `state` 决定，任何交互都只回调 `onChange(next)`。
 *   `dock` 时 `width:100%`、不绝对定位（就是原来的右栏/底栏）；
 *   `float` 时 `position:absolute`，按**百分比**换算像素（父级需 `position:relative`
 *   —— 编辑页根 `.editor-page` 已加），缩放浏览器时按 `bounds` 重新 clamp。
 * - **拖动 / 缩放**用 `setPointerCapture` + `pointermove`，标题条与手柄都有
 *   `touch-action:none`（否则 WebView/触摸上会被当成滚动）。
 * - `storageKey` 给了就 `localStorage` 持久化（读写都 try/catch，坏 JSON 回落默认）。
 * - `Escape` 关闭；`Escape` 只在**焦点在窗口内**时才关（避免和编辑器抢键）。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import "./inspectorWindow.css";
import { clampWindowState, writeWindowState } from "./windowState";

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

export type WindowState = DockState | { kind: "float"; rect: FloatRect };

export interface InspectorWindowProps {
  title: string;
  state: WindowState;
  onChange: (next: WindowState) => void;
  onClose?: () => void;
  /** 浮动时的最小宽/高（默认 240 / 140）。 */
  minW?: number;
  minH?: number;
  /** 页面根尺寸（像素）；用于百分比换算与 clamp。 */
  bounds: { w: number; h: number };
  /** 给了就持久化（形如 `prts-editor-windows:stage`）。 */
  storageKey?: string;
  /** 标题条左侧的小图标/标签（可选）。 */
  icon?: ReactNode;
  children: ReactNode;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));

export default function InspectorWindow({
  title,
  state,
  onChange,
  onClose,
  minW = 240,
  minH = 140,
  bounds,
  storageKey,
  icon,
  children,
}: InspectorWindowProps) {
  /** 拖动/缩放开始时的基准（指针、状态），null = 没在拖。 */
  const dragRef = useRef<{
    mode: "move" | "resize";
    pointerX: number;
    pointerY: number;
    rect: FloatRect;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 记住上一次的 dock 侧，双击标题条时恢复。 */
  const lastDockSide = useRef<"left" | "right">(state.kind === "dock" ? state.side : "right");
  const [dragging, setDragging] = useState(false);
  /** 指针是否在窗口内：`Escape` 在"刚拖完没点过输入框"时也要能关。 */
  const hoverRef = useRef(false);

  if (state.kind === "dock") lastDockSide.current = state.side;

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

  /** 双击标题条 / `⧉`：float ↔ dock。 */
  const toggle = useCallback(() => {
    if (state.kind === "dock") {
      // 停靠 → 浮动：屏幕中偏右，右侧留 200px 余量（够用户立刻拖动/缩放）。
      const w = clamp(Math.min(430, Math.round(bounds.w * 0.3)), minW, Math.max(minW, Math.round(bounds.w * 0.6)));
      const h = clamp(Math.min(430, Math.round(bounds.h * 0.45)), minH, Math.max(minH, Math.round(bounds.h * 0.8)));
      const x = clamp(Math.round(bounds.w * 0.5), 0, Math.max(0, bounds.w - w - 200));
      const y = clamp(Math.round(bounds.h * 0.12), 0, Math.max(0, bounds.h - h - 80));
      onChange({ kind: "float", rect: { x, y, w, h } });
    } else {
      onChange({ kind: "dock", side: lastDockSide.current ?? "right" });
    }
  }, [bounds.h, bounds.w, minH, minW, onChange, state]);

  const startMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (state.kind !== "float") return; // dock 时标题条只支持双击切换
      // 点在标题条的按钮上（⧉ / ✕）时别开始拖动、也别 setPointerCapture：
      // 捕获会把 pointerup 重定向到标题条，浏览器随之把 `click` 派发给**标题条**
      // 而不是按钮 —— 按钮的 onClick 就永远不触发（浮动状态下点 ✕ 关不掉）。
      if ((event.target as HTMLElement | null)?.closest?.(".ed-win-btn")) return;
      event.preventDefault(); // 防止选中标题文字 / 触发原生拖拽
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      dragRef.current = { mode: "move", pointerX: event.clientX, pointerY: event.clientY, rect: state.rect };
      setDragging(true);
    },
    [state]
  );

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      const rect = state.kind === "float" ? state.rect : { x: 24, y: 96, w: Math.min(420, bounds.w), h: Math.min(420, bounds.h) };
      dragRef.current = { mode: "resize", pointerX: event.clientX, pointerY: event.clientY, rect };
      setDragging(true);
    },
    [bounds.h, bounds.w, state]
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      event.preventDefault();
      const dx = event.clientX - drag.pointerX;
      const dy = event.clientY - drag.pointerY;
      if (drag.mode === "move") {
        onChange(
          clampWindowState(
            { kind: "float", rect: { ...drag.rect, x: drag.rect.x + dx, y: drag.rect.y + dy } },
            bounds,
            minW,
            minH
          )
        );
      } else {
        onChange(
          clampWindowState(
            { kind: "float", rect: { ...drag.rect, w: drag.rect.w + dx, h: drag.rect.h + dy } },
            bounds,
            minW,
            minH
          )
        );
      }
    },
    [bounds, minH, minW, onChange]
  );

  const endDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  }, []);

  // Escape 关闭：焦点在窗口内、指针悬停在窗口上、或焦点在 body 时都关
  // （在编辑器的 textarea 里按 Esc 关的是补全弹窗，不该误关窗口）。
  useEffect(() => {
    if (!onClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const root = rootRef.current;
      const active = document.activeElement;
      const inWindow = Boolean(root && active && root.contains(active));
      const bodyish = !active || active === document.body;
      if (!root || (!inWindow && !bodyish && !hoverRef.current)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const floating = state.kind === "float";
  const style: CSSProperties = floating
    ? {
        // 百分比定位：bounds 变了窗口跟着走（clamp 由上面的 effect 兜底）。
        position: "absolute",
        left: `${bounds.w > 0 ? (state.rect.x / bounds.w) * 100 : 0}%`,
        top: `${bounds.h > 0 ? (state.rect.y / bounds.h) * 100 : 0}%`,
        width: `${bounds.w > 0 ? (state.rect.w / bounds.w) * 100 : 100}%`,
        height: `${bounds.h > 0 ? (state.rect.h / bounds.h) * 100 : 100}%`,
      }
    : { width: "100%" };

  return (
    <div
      ref={rootRef}
      className={`ed-win${floating ? " ed-win--float" : " ed-win--dock"}${dragging ? " ed-win--dragging" : ""}`}
      data-win={title}
      data-win-state={state.kind}
      style={style}
      onPointerEnter={() => { hoverRef.current = true; }}
      onPointerLeave={() => { hoverRef.current = false; }}
    >
      <div
        className="ed-win-bar"
        data-drag-handle="1"
        onPointerDown={startMove}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={toggle}
        title={floating ? "拖动移动 · 双击停靠" : "双击浮动"}
      >
        {icon && <span className="ed-win-icon">{icon}</span>}
        <span className="ed-win-title">{title}</span>
        <span className="ed-win-grow" />
        <button
          type="button"
          className="ed-win-btn"
          onClick={toggle}
          title={floating ? "停靠" : "浮动"}
          aria-label={floating ? "停靠窗口" : "浮动窗口"}
        >
          ⧉
        </button>
        {onClose && (
          <button
            type="button"
            className="ed-win-btn"
            onClick={onClose}
            title="关闭（Esc）"
            aria-label="关闭窗口"
          >
            ✕
          </button>
        )}
      </div>
      <div className="ed-win-body">{children}</div>
      <div
        className="ed-win-resize"
        data-resize-handle="1"
        onPointerDown={startResize}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title="拖动调整大小"
      />
    </div>
  );
}
