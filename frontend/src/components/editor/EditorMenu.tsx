/**
 * `EditorMenu` —— **文本菜单**（Blender 标题栏菜单的口径，见
 * <https://docs.blender.org/manual/zh-hans/dev/interface/window_system/regions.html>：
 * 「标题栏 …… 用于容纳菜单和常用工具」，菜单项是**文字**，不是一排方块按钮）。
 *
 * 交互（照抄 Blender 文档的行为契约，<.../controls/buttons/menus.html>）：
 * - 左键点标题 → 打开；再点 / 点外面 / `Esc` → 关闭（「按 Esc 关闭菜单而不激活…」）；
 * - 打开后 `↑`/`↓` 在条目间移动、`Enter` 执行、`Home`/`End` 跳首末
 *   （「方向键用于浏览…按下回车执行选中的菜单项」）；
 * - **悬停即切换**：已经打开菜单时把指针移到相邻标题上就换过去（原生菜单栏的"扫过"手感）。
 *
 * DOM 契约（harness 断言用，**只增不改**）：
 * `[data-editor-menu]`（每个菜单）/ `[data-menu-group]`（原 `data-rail-group`）/
 * `[data-menu-item]`（条目）/ `[data-editor-action]`（动作，在条目上）。
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import Icon from "../ui/Icon.tsx";

export interface EditorMenuProps {
  /** 菜单标题（文件 / 视图 / 编辑 / 帮助）。 */
  label: string;
  /** 分组名（`file|view|edit|help`）—— 落在 `[data-menu-group]` 上。 */
  group: string;
  /** `end`：弹出面板贴右边缘（帮助菜单在最右）。 */
  align?: "start" | "end";
  children: ReactNode;
}

export default function EditorMenu({ label, group, align = "start", children }: EditorMenuProps): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const id = useId();

  /** 条目（可见的、未 disabled 的按钮）。 */
  const items = useCallback((): HTMLButtonElement[] => {
    const pop = popRef.current;
    if (!pop) return [];
    return [...pop.querySelectorAll<HTMLButtonElement>("button")].filter((button) => !button.disabled);
  }, []);

  /** 关掉**所有**菜单（点外面时用；同一时刻只允许一个菜单开着）。 */
  const closeAll = useCallback(() => {
    document.querySelectorAll(".ed-menu").forEach((menu) => {
      menu.querySelector(".ed-menu-trigger")?.setAttribute("aria-expanded", "false");
      menu.querySelector(".ed-menu-pop")?.setAttribute("hidden", "");
    });
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeAll();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAll();
    };
    // 捕获阶段：别的组件（编辑器正文）也监听 keydown，Esc 要先给菜单。
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [closeAll, open]);

  const onTriggerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const list = items();
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => items()[0]?.focus());
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => items().at(-1)?.focus());
      } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        // 相邻菜单之间移动焦点（原生菜单栏手感）。
        const menu = rootRef.current?.closest(".ed-menu");
        const all = menu ? [...menu.parentElement!.querySelectorAll<HTMLElement>(".ed-menu-trigger")] : [];
        const at = all.findIndex((el) => el === rootRef.current?.querySelector(".ed-menu-trigger"));
        if (at >= 0) {
          event.preventDefault();
          const step = event.key === "ArrowRight" ? 1 : -1;
          all[(at + step + all.length) % all.length]?.focus();
        }
      }
      void list;
    },
    [items]
  );

  const onPopKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const list = items();
      if (!list.length) return;
      const current = list.findIndex((el) => el === document.activeElement);
      const at = current < 0 ? 0 : current;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        list[(at + step + list.length) % list.length]?.focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        (event.key === "Home" ? list[0] : list.at(-1))?.focus();
      } else if (event.key === "Tab") {
        closeAll();
      }
    },
    [closeAll, items]
  );

  return (
    <div
      className={`ed-menu${open ? " is-open" : ""}`}
      data-editor-menu={group}
      data-menu-group={group}
      ref={rootRef}
      onMouseEnter={() => {
        // 「扫过切换」：已经有菜单开着时，悬停到兄弟标题就换过去。
        const anyOpen = document.querySelector(".ed-menu.is-open");
        if (anyOpen && anyOpen !== rootRef.current) setOpen(true);
      }}
    >
      <button
        type="button"
        className="ed-btn ed-menu-trigger"
        data-menu-trigger={group}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => (open ? closeAll() : setOpen(true))}
        onKeyDown={onTriggerKeyDown}
      >
        {label}
        <Icon name="chevron-down" size={11} className="ed-menu-caret" />
      </button>
      <div
        className={`ed-menu-pop${align === "end" ? " ed-menu-pop--end" : ""}`}
        id={id}
        role="menu"
        aria-label={label}
        hidden={!open}
        data-open={open ? "1" : undefined}
        ref={popRef}
        onKeyDown={onPopKeyDown}
      >
        {children}
      </div>
    </div>
  );
}
