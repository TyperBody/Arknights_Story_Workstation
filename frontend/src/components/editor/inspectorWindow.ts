/**
 * `inspectorWindow.ts` —— 窗口壳的**类型 + 纯工具**（无 React、无 DOM、无副作用）。
 *
 * ⚠️ 文件名与组件 `InspectorWindow.tsx` 只差扩展名（`inspectorWindow` vs `InspectorWindow`）：
 *    `inspectorWindow.ts` = 类型/工具（P2 的 StagePane、T6 的 BranchGraph 都 `import type` 这里）；
 *    `InspectorWindow.tsx` = 组件。Linux 与大小写不敏感文件系统上都安全（`.ts` / `.tsx` 是两个文件）。
 *
 * 契约来源：`build/ctx/BRIEF-workbench-v1.md` §2.1 / §2.2。
 *
 * 语义（用户原话「检视器在工具面板 所以不应该和其他窗口一样单开脱离按钮 并且这是显示不显示也不是独立窗口阿」）：
 * - `dock`（toolpanel / stage）= **常驻拼接块**：标题条**没有** `⧉`、**没有** `✕`，只能吸附拼接 + 调尺寸；
 * - `map`（preview / branch）= **Map**：工具栏按需开关，`✕` = 关掉（从工作台移除），`⧉` 保留（停靠块 ↔ 浮动窗）。
 */

/** 面板 id（与 P3 的 `workbenchStack.ts::PanelId` 结构一致；本文件不硬依赖 P3 的文件）。 */
export type PanelId = "toolpanel" | "stage" | "preview" | "branch";

/** 窗口壳的三种形态。见 `windowState.ts` 的 `WindowState`。 */
export type PanelShellKind = "dock" | "map" | "float";

/**
 * 窗口内容组件（StagePane / BranchGraph）的 chrome 控件 props —— **逐字**按 BRIEF §2.2。
 * 缺失时内容组件必须照常渲染（`props.chrome?: PanelChromeProps`）。
 */
export interface PanelChromeProps {
  title: string;
  ariaLabel: string;
  visible: boolean;
  /** 「▾」折叠 = 隐藏（Map 语义）。 */
  onToggle?: () => void;
  /** 点标题条 = 选中该面板（活跃环 `.is-active`）。 */
  onSelect?: () => void;
  active?: boolean;
}

/** `workbenchLayout.ts::WINDOW_SPECS` 的**结构子集**（P3 的表落地前也能编译）。 */
export interface WindowSpecLike {
  title?: string;
  kind?: PanelShellKind;
  map?: boolean;
  minW?: number;
  minH?: number;
  order?: number;
}

/**
 * 兜底标题：**只在** P3 的 `WINDOW_SPECS` 还没注册（或该 id 不在表里）时用。
 * 真值永远优先从注册表取 —— 见 `registerWindowSpecs` / `resolveChrome`。
 */
export const FALLBACK_TITLES: Record<PanelId, string> = {
  toolpanel: "工具面板",
  stage: "舞台",
  preview: "预览",
  branch: "分支图",
};

/** 兜底 kind：toolpanel / stage = 常驻 dock；preview / branch = Map。 */
export const FALLBACK_KINDS: Record<PanelId, "dock" | "map"> = {
  toolpanel: "dock",
  stage: "dock",
  preview: "map",
  branch: "map",
};

/**
 * P3/P5 可用 `registerWindowSpecs(WINDOW_SPECS)` 把**真表**注入进来（一行、可选）。
 * 不注入也能跑：按 `FALLBACK_TITLES` / `FALLBACK_KINDS` 兜底。
 */
let registry: Record<string, WindowSpecLike> | null = null;

export function registerWindowSpecs(specs: Record<string, WindowSpecLike> | null | undefined): void {
  if (specs && typeof specs === "object") registry = specs;
}

/** 取某个面板的规格（注册表优先；缺失回落兜底），永远返回一个可用的对象。 */
export function panelSpec(id: string): Required<Pick<WindowSpecLike, "title" | "kind">> & WindowSpecLike {
  const known = (FALLBACK_TITLES as Record<string, string>)[id];
  const registered = registry?.[id];
  const fallbackKind: "dock" | "map" = (FALLBACK_KINDS as Record<string, "dock" | "map">)[id] ?? "map";
  return {
    ...registered,
    title: registered?.title ?? known ?? id,
    kind: registered?.kind ?? (registered?.map ? "map" : fallbackKind),
  };
}

/** 面板标题。`specs` 可显式传入（P3 的 `WINDOW_SPECS`），否则用注册表/兜底。 */
export function panelTitle(id: string, specs?: Record<string, WindowSpecLike>): string {
  return specs?.[id]?.title ?? panelSpec(id).title;
}

/** 面板语义：`"dock"` = 常驻拼接块（无 ⧉/✕）；`"map"` = 地图面板（✕ + ⧉）。 */
export function panelKind(id: string, specs?: Record<string, WindowSpecLike>): "dock" | "map" {
  const spec = specs?.[id] ?? registry?.[id];
  if (spec?.kind) return spec.kind === "dock" ? "dock" : "map";
  if (spec?.map !== undefined) return spec.map ? "map" : "dock";
  return panelSpec(id).kind === "dock" ? "dock" : "map";
}

/**
 * 由面板 id + 规格解析出 `PanelChromeProps`。
 * `spec` 可以是**单个**面板的规格（`WINDOW_SPECS[id]`），也可以是**整张表**。
 */
export function resolveChrome(
  id: string,
  spec?: WindowSpecLike | Record<string, WindowSpecLike>
): PanelChromeProps {
  const looksLikeTable = Boolean(spec) && !("title" in spec!) && !("kind" in spec!) && !("map" in spec!);
  const single = looksLikeTable ? (spec as Record<string, WindowSpecLike>)[id] : (spec as WindowSpecLike | undefined);
  const title = single?.title ?? registry?.[id]?.title ?? panelTitle(id);
  return { title, ariaLabel: `${title}面板`, visible: true, active: false };
}

/** 显示名（标题条右侧的形态提示，给无障碍/调试用）。 */
export function shellKindLabel(kind: PanelShellKind): string {
  return kind === "dock" ? "常驻面板" : kind === "map" ? "地图面板" : "浮动窗口";
}
