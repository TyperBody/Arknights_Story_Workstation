/**
 * `FloatLayer.tsx` —— **工作台之外**的浮动层（"划区"重构的核心之一）。
 *
 * 为什么需要它：v1 把浮动窗渲染在**布局树的槽位里**（`.wb-shell` → `InspectorWindow`），
 * 于是它天然被 `.wb-slot` / `.wb-stage` 的 `overflow: hidden` 裁住 —— 用户原话
 * 「分离了还只能在区里 不能独立窗口」。现在浮动窗挂到 `.editor-page` 里的
 * `[data-wb-float-layer]`（`position:absolute; inset:0`，坐标 = **页面根**）：
 * 可以拖到工具栏、页头，任何地方；树里用 `[data-wb-float-hole]` 留个占位，
 * 分隔条照旧可用（拖它 = 改"分离前"的比例）。
 *
 * 契约（harness 断言锚点，**只增不改**）：
 * - `[data-wb-float-layer="1"]` 层本身 `pointer-events:none`（不挡工作台），
 *   里面的 `.wb-float-item` 才 `pointer-events:auto`；
 * - 每个浮动窗仍是 `.ed-win[data-win-state="float"]`，**不在** `[data-wb-panel]` 里
 *   （`closest('[data-wb-panel]') === null` = "真的出来了"）；
 * - 树里的占位：`[data-wb-panel="<id>"] [data-wb-float-hole="<id>"]`。
 */

import type { ReactNode } from "react";

import "./workbench.css";

export interface FloatLayerProps {
  /** 层里要画的浮动窗（每个都应是绝对定位的 `.ed-win--float`）。 */
  children: ReactNode;
  /** 当前活跃（拖拽/点击）的浮动窗 id；用于置顶与描边。 */
  activeId?: string | null;
}

export default function FloatLayer({ children, activeId }: FloatLayerProps) {
  return (
    <div
      className={`wb-float-layer${activeId ? " wb-float-layer--active" : ""}`}
      data-wb-float-layer="1"
      data-wb-float-active={activeId ?? ""}
    >
      {children}
    </div>
  );
}
