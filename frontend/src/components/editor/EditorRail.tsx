/**
 * `EditorRail.tsx` —— 编辑器左侧**侧边栏（rail）**：**收起（挂上）的面板托盘**。
 *
 * 用户原话：「窗口里套窗口的操作模式有点恶心 脱离出去就不（脱离）了 为什么还要保留位置」
 * 「引入侧边栏的概念 可以快速收缩 集合窗口」。
 *
 * 语义（用户口径，2026-10-15）：
 * - 「侧边栏是用来**快速隐藏**选择的 而不是可视不可视」——点 rail 上的条目 = 把这条
 *   面板**收回工作台**（`restore`）；挂上来的（收起的）面板**才**出现在 rail 里：
 *   「侧边栏有东西挂到侧边栏才显示的」；
 * - 面板标题条的 `⇤`（`data-win-action="park"`）= **收进侧边栏**（`minimize` + 从
 *   `visible` 摘掉）——**同一个动作只有这一处入口**，rail 不再和工具栏按钮重复；
 * - **文字竖排**（`writing-mode: vertical-rl`）：不留"工具…"这种莫名其妙截断。
 *
 * 行为契约（harness 锚点，**只增不改**）：
 * - `[data-ed-rail="1"]` 根；`[data-rail-toggle="1"]` 整条收起 / 展开；
 * - 每个面板一个 `[data-rail-item="<id>"]`，`aria-pressed` = 「已放出」；
 *   收起 rail 时**不卸载**这些节点（只 `display:none` 掉文字、宽度收到 32px），
 *   否则状态与 harness 都会断；
 * - `ArrowUp/ArrowDown`（含 `Home/End`）在图标间移动焦点，`Enter/Space` = 点按。
 *
 * 本组件**纯展示 + 回调**：状态（`prts-editor-rail`）与布局改动都在页面里
 * （`StoryEditorPage` 的 `railTogglePanel` / `saveRail`）。
 */

import { useCallback, useRef, type KeyboardEvent, type ReactNode } from "react";

import { useT } from "../../i18n/index.ts";
import type { PanelId } from "./workbenchLayout";

export interface RailItem {
  id: PanelId;
  /** 面板标题（`editor.panel.title.<id>` 的译文）——竖排文字与 tooltip 都用它。 */
  title: string;
  /** 挂上 rail 的原因（`map` = Map 面板关着；`park` = 用户主动收进侧边栏）。 */
  reason: "park" | "map";
}

export interface EditorRailProps {
  items: RailItem[];
  /** 整条收起（只剩 28px 窄条，仍可点开）。 */
  collapsed: boolean;
  /** 点条目 = 把这条**挂上的**面板放回工作台（`restore`）。 */
  onRestorePanel: (id: PanelId) => void;
  /** 整条收起 ↔ 展开。 */
  onToggleRail: () => void;
  /** 重置布局（唯一的布局动作；自动落库之外只留它）。 */
  onResetLayout?: () => void;
}

/** 图标（几何字形，不依赖任何图标库/emoji 字体；缺字时也只是不好看，不会崩）。 */
const GLYPHS: Record<PanelId, string> = {
  toolpanel: "☰",
  assets: "▦",
  stage: "▤",
  preview: "▷",
  branch: "⌥",
};

export default function EditorRail({ items, collapsed, onRestorePanel, onToggleRail, onResetLayout }: EditorRailProps): ReactNode {
  const tr = useT();
  const rootRef = useRef<HTMLDivElement>(null);

  /** 条目间移动焦点（`ArrowUp/Down` + `Home/End`）。 */
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const root = rootRef.current;
    if (!root) return;
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-rail-item], [data-rail-toggle]")];
    if (buttons.length < 2) return;
    const current = buttons.findIndex((button) => button === document.activeElement);
    const at = current < 0 ? 0 : current;
    const last = buttons.length - 1;
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? last : at + (event.key === "ArrowDown" ? 1 : -1);
    const target = buttons[Math.min(last, Math.max(0, next))];
    if (!target) return;
    event.preventDefault();
    target.focus();
  }, []);

  const parkedCount = items.length;

  return (
    <div
      className={`ed-rail${collapsed ? " ed-rail--collapsed" : ""}${parkedCount === 0 ? " ed-rail--empty" : ""}`}
      data-ed-rail="1"
      data-rail-collapsed={collapsed ? "1" : undefined}
      data-rail-parked={parkedCount}
      role="toolbar"
      aria-orientation="vertical"
      aria-label={tr("editor.rail.aria", undefined, "侧边栏")}
      ref={rootRef}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="ed-rail-toggle"
        data-rail-toggle="1"
        onClick={onToggleRail}
        aria-expanded={!collapsed}
        title={collapsed ? tr("editor.rail.expand", undefined, "展开侧边栏") : tr("editor.rail.collapse", undefined, "收起侧边栏")}
        aria-label={collapsed ? tr("editor.rail.expand", undefined, "展开侧边栏") : tr("editor.rail.collapse", undefined, "收起侧边栏")}
      >
        <span className="ed-rail-glyph" aria-hidden="true">{collapsed ? "›" : "‹"}</span>
      </button>

      {/*
        只有**挂上来的**（收起的）面板才在这里：`data-rail-item` = 一条托盘条目，
        点一下 = 放回工作台。工作台里正显示的面板**不占** rail（rail 是"集合
        收起项"的托盘，不是可视性开关面板）。
      */}
      <div className="ed-rail-tray" data-rail-tray="1">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="ed-rail-item"
            data-rail-item={item.id}
            data-rail-reason={item.reason}
            aria-pressed="true"
            title={`${tr("editor.rail.restore", undefined, "放回工作台")}：${item.title}`}
            aria-label={`${tr("editor.rail.restore", undefined, "放回工作台")}：${item.title}`}
            onClick={() => onRestorePanel(item.id)}
          >
            <span className="ed-rail-glyph" aria-hidden="true">{GLYPHS[item.id] ?? "▢"}</span>
            <span className="ed-rail-label">{item.title}</span>
          </button>
        ))}
        {parkedCount === 0 && !collapsed && (
          <span className="ed-rail-hint" data-rail-hint="empty">
            {tr("editor.rail.empty", undefined, "收起的窗口会挂在这里")}
          </span>
        )}
      </div>

      {/* 布局动作：只有「重置」（布局本身自动落库）。锚点保持 `[data-layout-bar]` /
          `[data-layout-action="reset"]`；文字用屏读可见的 `ed-rail-sr`（harness 读 innerText）。 */}
      {onResetLayout && (
        <span className="ed-layout ed-rail-layout" data-layout-bar="1">
          <button
            type="button"
            className="ed-rail-reset"
            data-layout-action="reset"
            onClick={onResetLayout}
            title={tr("editor.layout.resetTitle", undefined, "把当前布局恢复成默认（工具面板左 / 编辑区上 / 舞台下）")}
            aria-label={tr("editor.layout.reset", undefined, "重置布局")}
          >
            <span className="ed-rail-glyph" aria-hidden="true">⟲</span>
            <span className="ed-rail-sr">{tr("editor.layout.reset", undefined, "重置布局")}</span>
          </button>
        </span>
      )}
    </div>
  );
}
