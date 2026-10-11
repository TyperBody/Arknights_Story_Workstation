/**
 * `inspectorWindow.ts` —— 窗口壳的**类型 + 纯工具**（无 React、无 DOM、无副作用）。
 *
 * ⚠️ 文件名与组件 `InspectorWindow.tsx` 只差扩展名（`inspectorWindow` vs `InspectorWindow`）：
 *    `inspectorWindow.ts` = 类型/工具（P2 的 StagePane、T6 的 BranchGraph、P5 的页面都 `import` 这里）；
 *    `InspectorWindow.tsx` = 组件。Linux 与大小写不敏感文件系统上都安全（`.ts` / `.tsx` 是两个文件）。
 *
 * 契约来源：`build/ctx/BRIEF-workbench-v1.md` §2.1 / §2.2。
 *
 * 语义（用户原话「检视器在工具面板 所以不应该和其他窗口一样单开脱离按钮 并且这是显示不显示也不是独立窗口阿」）：
 * - `dock`（toolpanel / stage）= **常驻拼接块**：标题条**没有** `⧉`、**没有** `✕`，只能吸附拼接 + 调尺寸；
 * - `map`（preview / branch）= **Map**：工具栏按需开关，`✕` = 关掉（从工作台移除），`⧉` 保留（停靠块 ↔ 浮动窗）。
 *
 * 规格表归属 P3（`workbenchLayout.ts::WINDOW_SPECS`）。本文件**不复制表**：
 * `StoryEditorPage` 启动时 `registerWindowSpecs(WINDOW_SPECS)` 注入一次即可；
 * 未注入（或某个 id 不在表里）时按 `FALLBACK_TITLES` / `FALLBACK_KINDS` 兜底，永远是可用对象。
 */

/** 面板 id（与 P3 的 `workbenchStack.ts::PanelId` 一致；本文件不硬依赖 P3 的文件）。 */
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

/** 兜底规格表的形状（`FALLBACK_TITLES` + `FALLBACK_KINDS` 派生，和注册表同构）。 */
export const FALLBACK_SPECS: Record<PanelId, WindowSpecLike> = {
  toolpanel: { title: FALLBACK_TITLES.toolpanel, kind: FALLBACK_KINDS.toolpanel },
  stage: { title: FALLBACK_TITLES.stage, kind: FALLBACK_KINDS.stage },
  preview: { title: FALLBACK_TITLES.preview, kind: FALLBACK_KINDS.preview },
  branch: { title: FALLBACK_TITLES.branch, kind: FALLBACK_KINDS.branch },
};

/** 已注册的真表：`WINDOW_SPECS ?? {}` → 兜底（同一套查表逻辑，`registerWindowSpecs` 可复位）。 */
let registry: Record<string, WindowSpecLike> = FALLBACK_SPECS;

/**
 * 注册 P3 的 `WINDOW_SPECS`（`null`/`undefined`/空表 = 复位回兜底）。
 * 只存引用，不复制、不改写 —— 表的所有权仍在 P3。
 */
export function registerWindowSpecs(specs: Record<string, WindowSpecLike> | null | undefined): void {
  registry = specs && Object.keys(specs).length > 0 ? specs : FALLBACK_SPECS;
}

/** 当前生效的表（注册表 ∪ 兜底：缺失的 id 用兜底补，不覆盖注册值）。 */
export function windowSpecs(): Record<string, WindowSpecLike> {
  return registry === FALLBACK_SPECS ? FALLBACK_SPECS : { ...FALLBACK_SPECS, ...registry };
}

/** 找 id 的规格（生效表）；找不到 → `undefined`。 */
export function findSpec(id: string): WindowSpecLike | undefined {
  return windowSpecs()[id];
}

/**
 * 取某个面板的规格（生效表优先；表中缺字段回落兜底），永远返回可用的 `{title, kind}`。
 * `kind` 的推导顺序：`spec.kind` → `spec.map` → 兜底 kind。
 */
export function panelSpec(id: string): { title: string; kind: "dock" | "map" } & WindowSpecLike {
  const spec = findSpec(id);
  const fallbackTitle = (FALLBACK_TITLES as Record<string, string>)[id] ?? id;
  const fallbackKind = (FALLBACK_KINDS as Record<string, "dock" | "map">)[id] ?? "map";
  const title = spec?.title ?? fallbackTitle;
  const kind: "dock" | "map" = spec?.kind === "dock" ? "dock" : spec?.kind === "map" ? "map" : spec?.map ? "map" : fallbackKind;
  return { ...spec, title, kind };
}

/**
 * 面板标题。`specs` 可显式传入（P3 的 `WINDOW_SPECS`），否则用已注册的表/兜底。
 * 显式表里没有该 id → 仍回落兜底（调用方不必自己判空）。
 */
export function panelTitle(id: string, specs?: Record<string, WindowSpecLike>): string {
  return specs?.[id]?.title ?? panelSpec(id).title;
}

/** 面板语义：`"dock"` = 常驻拼接块（无 ⧉/✕）；`"map"` = 地图面板（✕ + ⧉）。 */
export function panelKind(id: string, specs?: Record<string, WindowSpecLike>): "dock" | "map" {
  const spec = specs?.[id];
  if (spec) return spec.kind === "dock" ? "dock" : spec.kind === "map" ? "map" : spec.map ? "map" : panelSpec(id).kind;
  return panelSpec(id).kind;
}

/**
 * 由面板 id + 规格解析出 `PanelChromeProps`（BRIEF §2.2）。
 * `spec` 可以是**单个**面板的规格（`WINDOW_SPECS[id]`），也可以是**整张表**；两个都给错也不炸。
 */
export function resolveChrome(
  id: string,
  spec?: WindowSpecLike | Record<string, WindowSpecLike>
): PanelChromeProps {
  const asTable = spec as Record<string, WindowSpecLike> | undefined;
  const single =
    spec && typeof spec === "object" && !("title" in spec) && !("kind" in spec) && !("map" in spec)
      ? asTable?.[id]
      : (spec as WindowSpecLike | undefined);
  const title = single?.title ?? registry[id]?.title ?? panelTitle(id);
  return { title, ariaLabel: `${title}面板`, visible: true, active: false };
}

/** 显示名（标题条/无障碍文案用的形态提示）。 */
export function shellKindLabel(kind: PanelShellKind): string {
  return kind === "dock" ? "常驻面板" : kind === "map" ? "地图面板" : "浮动窗口";
}
