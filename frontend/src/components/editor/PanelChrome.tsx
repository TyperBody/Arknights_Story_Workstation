/**
 * `PanelChrome` + `PanelFold` —— 给**窗口内容组件**（P2 的 `StagePane`、T6 的 `BranchGraph`）
 * 用的极简 chrome 控件：`▾` 折叠 + 标记 + `.is-active` 活跃环。BRIEF-workbench-v1 §2.2。
 *
 * 为什么内容组件要自带？因为 chrome 的正确层级在**内容容器内部**（`ServerPane`/`BranchGraph`
 * 自己知道标题该贴哪、`data-chrome` 该挂哪）；窗口壳（`InspectorWindow.tsx`）只画标题条上的
 * 折叠按钮。两边通过同一个 `PanelChromeProps`（`./inspectorWindow` 导出）对话。
 *
 * 约定：
 * - `data-chrome="<id>"`（`stage` / `branch`）；折叠按钮 = `.sp-fold`，chrome 根 = `.sp-chrome`；
 *   活跃时根上加 `.is-active`（同时保留 `data-active="1"`，方便 harness 二选一）。
 * - 折叠只切**显示**（`visible:false` → 内容区 `hidden`，不卸载 DOM）：对应"显示不显示"的语义。
 * - 纯 DOM/CSS，零依赖；class 命名与 `StagePane` 的 `.sp-*` 前缀一致，`bg-*` 由内容组件自带。
 */

import type { PanelChromeProps } from "./inspectorWindow";

export interface PanelChromeViewProps {
  id: string;
  chrome?: Partial<PanelChromeProps>;
  /** 额外的 class（内容组件自己的命名，比如 `sp-chrome` / `bg-chrome`）。 */
  className?: string;
  /** 标题右侧的额外小控件（比如 StagePane 的"选择"按钮）。 */
  children?: React.ReactNode;
}

/** chrome 条：`data-chrome="<id>"` + 折叠 `▾` + 活跃环。 */
export default function PanelChrome({ id, chrome, className = "", children }: PanelChromeViewProps) {
  const title = chrome?.title ?? "";
  const active = Boolean(chrome?.active);
  return (
    <div
      className={`panel-chrome ${className}${active ? " is-active" : ""}`.trim()}
      data-chrome={id}
      data-active={active ? "1" : "0"}
    >
      {title ? <span className="panel-chrome-title">{title}</span> : null}
      <span className="panel-chrome-grow" />
      {children}
      {chrome?.onToggle ? <PanelFold chrome={chrome} /> : null}
    </div>
  );
}

/** 折叠按钮：`▾`/`▸`，`aria-expanded` 跟随 `visible`。 */
export function PanelFold({
  chrome,
  className = "sp-fold",
}: {
  chrome: Partial<PanelChromeProps>;
  className?: string;
}) {
  const visible = chrome.visible !== false;
  return (
    <button
      type="button"
      className={className}
      onClick={chrome.onToggle}
      title={visible ? "收起" : "展开"}
      aria-label={chrome.ariaLabel ? `${visible ? "收起" : "展开"}${chrome.ariaLabel}` : visible ? "收起" : "展开"}
      aria-expanded={visible}
    >
      {visible ? "▾" : "▸"}
    </button>
  );
}

/** 自定义 hook：把受控 `chrome.visible` 折叠成"要不要给内容区加 `hidden`"。 */
export function chromeHidden(chrome?: Partial<PanelChromeProps>): boolean {
  return chrome?.visible === false;
}
