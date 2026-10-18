/**
 * `Icon` —— 内联 **SVG 图标**（ak-ui `.ak-icon` 口径：`currentColor` + 1em 见方）。
 *
 * 为什么要换掉原来的 `⇤ ▾ ⧉ ✕ ▦ ⌥` 这类字符：它们是**字体字形**，
 * - 每个字体/平台的字宽与字面不同 → 有的被压扁、有的被拉长（用户：「图标被扭曲了」）；
 * - 还受 `line-height` / 继承 `font-weight` 影响，工具条里忽胖忽瘦。
 * SVG 的几何是**视线宽固定**的：`width/height = 1em` + `viewBox`，永远不会变形。
 *
 * 图标语义对齐 Blender / ak-ui 的习惯：文字里配一个**细线几何**图标，
 * 动作靠文字表达（避免只有图标、看不懂在干嘛）。
 */
import type { CSSProperties, ReactNode } from "react";

export type IconName =
  | "logo"
  | "park"      // 收进侧边栏
  | "chevron-down"
  | "chevron-right"
  | "chevron-left"
  | "float"     // 浮动 / 分离
  | "close"
  | "panel"     // 面板（工具面板）
  | "layers"    // 素材库
  | "sliders"   // 控制器
  | "info"      // 剧本信息
  | "play"      // 预览
  | "branch"    // 分支图
  | "stage"     // 舞台
  | "tools"     // 工具
  | "search"
  | "reset";    // 重置

/** 24×24 网格上的路径（全部是 1.8px 细线，风格一致）。 */
const PATHS: Record<IconName, ReactNode> = {
  logo: <path d="M4 20 10.4 4h3.2L20 20h-3.3l-1.2-3.4H8.5L7.3 20H4Zm5.6-6.2h4.8L12 7.4l-2.4 6.4Z" />,
  park: (
    <>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <path d="M5.5 9.5 2.5 12l3 2.5" />
    </>
  ),
  "chevron-down": <path d="m6 9.5 6 6 6-6" />,
  "chevron-right": <path d="m9.5 6 6 6-6 6" />,
  "chevron-left": <path d="m14.5 6-6 6 6 6" />,
  float: (
    <>
      <rect x="3.5" y="3.5" width="12" height="12" />
      <rect x="8.5" y="8.5" width="12" height="12" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  panel: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" />
      <path d="M9 4.5v15" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3.5 21 8l-9 4.5L3 8l9-4.5Z" />
      <path d="M3 12.5 12 17l9-4.5" />
    </>
  ),
  sliders: (
    <>
      <path d="M5 4.5v15M12 4.5v15M19 4.5v15" />
      <circle cx="5" cy="9" r="2" />
      <circle cx="12" cy="15" r="2" />
      <circle cx="19" cy="8" r="2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v6M12 7.6v.1" />
    </>
  ),
  play: <path d="M8 5.5 18.5 12 8 18.5v-13Z" />,
  branch: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="12" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <path d="M8.5 6H12a3 3 0 0 1 3 3v.5M8.5 18H12a3 3 0 0 0 3-3v-.5" />
    </>
  ),
  stage: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" />
      <path d="M3.5 15.5h17M8 5.5v10M16 5.5v10" />
    </>
  ),
  tools: <path d="M14.5 4.5a4.5 4.5 0 0 0 5.6 5.9L11 19.5a2.5 2.5 0 1 1-3.5-3.5l9.1-9.1a4.5 4.5 0 0 1-2.1-2.4Z" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 4.5 4.5" />
    </>
  ),
  reset: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.6-5.7" />
      <path d="M4 4.5V10h5.5" />
    </>
  ),
};

export interface IconProps {
  name: IconName;
  /** 像素尺寸；默认 `1em`（跟字号走，和 ak-ui `.ak-icon` 一致）。 */
  size?: number | string;
  /** 线宽（`viewBox` 单位）；默认 1.8。 */
  weight?: number;
  className?: string;
  style?: CSSProperties;
  /** 有 `title` 时给 `role="img"`，否则对读屏隐藏（旁边通常已有文字）。 */
  title?: string;
}

export default function Icon({ name, size, weight = 1.8, className, style, title }: IconProps): ReactNode {
  const glyph = PATHS[name];
  if (!glyph) return null;
  const px = typeof size === "number" ? `${size}px` : (size ?? "1em");
  return (
    <svg
      className={`ak-icon${className ? ` ${className}` : ""}`}
      data-icon={name}
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ flex: "none", ...style }}
    >
      {title ? <title>{title}</title> : null}
      {glyph}
    </svg>
  );
}
