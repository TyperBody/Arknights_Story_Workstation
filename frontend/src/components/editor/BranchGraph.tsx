/**
 * 「分支图」视图（T6 / task-7）——**dify 风分层 DAG**，纯 SVG，零新依赖。
 *
 * ```tsx
 * <BranchGraph
 *   text={text}                    // 全文（与编辑器 textarea 同源）
 *   caretLine={caret.line}         // 1 基光标行 → 高亮对应卡片
 *   onJumpToLine={(line) => …}     // 点卡片 = 跳到该卡片首行
 *   onPatch={(next, caret) => …}   // 「⤳ 在此分叉」= 回写整篇
 *   height={340}                   // 可选：容器高度
 *   chrome={{title, ariaLabel, visible, onToggle, onSelect, active}}  // 可选（BRIEF §2.2）
 * />
 * ```
 *
 * 排布**全部**来自 `src/akstage/local/branchGraph.js` 的纯函数
 * （`buildGraph` / `layoutGraph` / `graphAt` / `suggestForkOptions` / `forkPatch`）：
 *   · 分层：`layer` 单调（拓扑长路径），相邻列 x = `PAD + layer × 232`；
 *   · 卡片：200×64（左侧 4px 分类色条 + 标题 1 行 + 摘要 1 行 + 右上状态点）；
 *   · 连线：正交折线（跨列 S 折 / 同列绕行，拐点 6px 圆角），`role: "choice"`
 *     的边在竖向段中点贴分支标签；`[Decision]` 卡片把选项画成 pills + 菱形角标。
 * 本文件只负责**画与交互**（滚轮缩放 0.2…2、拖空白平移、`0` / `⤢ 适配` 复位、
 * 点卡片跳行、`⤳ 在此分叉`）。
 *
 * DOM 标记（harness 断言锚点，**只增不改**）：
 *   `[data-branch-graph="1"]`（svg）、`[data-branch-node="<id>"]` + `data-branch-layer`、
 *   `[data-branch-edge="1"]`（= `data-branch-path="1"]`，同一元素两个名字）、
 *   `[data-branch-pan="1"]`（平移面）、`[data-branch-action="fit"]`、
 *   `[data-branch-empty="1"]`、`[data-chrome="branch"]` + `.bg-chrome` / `.bg-fold`。
 * 缺 `text` / `onPatch` / chrome / 无 Decision / `degraded` 都**不崩**：作为
 * `optionalPart()` 懒加载的可选面板，任何一种缺席都是正常状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelChromeProps } from "./inspectorWindow";
import {
  buildGraph,
  forkPatch,
  graphAt,
  layoutGraph,
  LAYOUT_ZOOM_MAX,
  LAYOUT_ZOOM_MIN,
  suggestForkOptions,
  type Edge,
  type Graph,
  type Node as GraphNode,
  type Route,
} from "../../../../src/akstage/local/branchGraph.js";
import { useT } from "../../i18n/index.ts";
import "./branchGraph.css";

/** 组件的 props：task-16 契约 + P4 的可选 chrome（BRIEF §2.2）。 */
export interface BranchGraphProps {
  text: string;
  caretLine: number;
  onJumpToLine: (line: number) => void;
  onPatch?: (nextText: string, caretLine?: number) => void;
  height?: number;
  onClose?: () => void;
  /**
   * 窗口壳 chrome（BRIEF §2.2 / P4 的 `inspectorWindow.ts`）。
   * **可选**：不给时内容照常渲染（只少一条 `.bg-chrome`）。
   * （`./inspectorWindow` 的类型在 P4 落盘前不存在，故这里只 `import type`
   *  —— 运行期零耦合；若该文件缺席，删掉这一行即可，组件本身不受影响。）
   */
  chrome?: PanelChromeProps;
}

/** 布局输出的最小结构（`layoutGraph` 的 JSDoc 是 `any`，这里给视图补形状）。 */
interface LayoutNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
  role: "start" | "decision" | "merge" | "node" | "end";
  kind: string;
  lane: string | null;
  line: number;
  range: [number, number];
  text: string;
  title: string;
  summary: string;
  values: number[];
  mixed: boolean;
  /** decision 卡片：选项 pills。 */
  lines: string[];
}
interface LayoutEdge {
  id: string;
  from: string;
  to: string | null;
  points: [number, number][];
  d: string;
  anchor: { x: number; y: number } | null;
  role: "main" | "choice" | "merge" | "back" | "dead";
  label: string;
  value: number | null;
}
interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  lanes: { id: string; label: string; value: number; opts: string; line: number; colorIndex: number }[];
  choiceLines: { line: number; title: string; edgeIds: string[]; options: string[] }[];
  width: number;
  height: number;
  degenerate: boolean;
}

/** 线路配色（固定 8 色循环；节点分类色条 + 边 + 图例共用）。 */
const ROLE_COLORS: Record<string, string> = {
  start: "#4db6ac",
  decision: "#f4c430",
  merge: "#9575cd",
  end: "#8b93a7",
  node: "#4fc3f7",
  back: "#e57373",
  main: "#4b5563",
  choice: "#f4c430",
  dead: "#6b7280",
};
/** 无 Decision 时的人话提示（= zh-Hans 原文；harness 逐字断言，en-US 见 `editor.branch.emptyHint`）。 */
const EMPTY_HINT_DEFAULT = "这个剧本还没有分支：插入 [Decision] 后这里会画出走向";
/** 滚轮每格的缩放倍率（clamp 到 `LAYOUT_ZOOM_MIN..MAX`）。 */
const ZOOM_STEP = 1.08;
/** 画布四周的最小可视留白（「适配」用）。 */
const FIT_PAD = 18;
/** 分叉表格的行数范围。 */
const FORK_ROWS_MIN = 2;
const FORK_ROWS_MAX = 4;

const EMPTY_STATS = {
  lines: 0, parsedLines: 0, decisions: 0, choices: 0, routes: 0, nodes: 0, edges: 0,
  merges: 0, forks: 0, maxDepth: 0, combos: 0, lineagesMax: 0, degradedReasons: [] as string[],
};
/** 空布局（`layoutGraph` 理论上不抛；这里只是第二道保险）。 */
const EMPTY_LAYOUT: Layout = {
  nodes: [], edges: [], lanes: [], choiceLines: [], width: 0, height: 0, degenerate: false,
};

/** 数值 clamp。 */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** 视图状态：`x/y` = 平移（屏幕 px），`zoom` = 缩放。 */
interface ViewState {
  key: string;
  zoom: number;
  x: number;
  y: number;
}

/** 把整张图缩放到容器里（「适配」/ 首帧）。 */
function fitView(layout: Layout, w: number, h: number): ViewState {
  const bw = Math.max(1, layout.width);
  const bh = Math.max(1, layout.height);
  const zoom = clamp(Math.min((w - FIT_PAD * 2) / bw, (h - FIT_PAD * 2) / bh), LAYOUT_ZOOM_MIN, LAYOUT_ZOOM_MAX);
  return { key: "", zoom, x: r((w - bw * zoom) / 2), y: r((h - bh * zoom) / 2) };
}

/** 两位小数（避免浮点尾巴进 DOM / 断言）。 */
function r(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

/**
 * 分支图面板：dify 风分层 DAG。
 * @param props
 */
export default function BranchGraph({
  text,
  caretLine,
  onJumpToLine,
  onPatch,
  height = 320,
  onClose,
  chrome,
}: BranchGraphProps) {
  const tr = useT();
  /** 图：文本变化才重算（大脚本也只算一次）；`tr` 每语言一个稳定函数，切语言即重算。 */
  const graph: Graph = useMemo(() => {
    try {
      return buildGraph(String(text ?? ""));
    } catch {
      return { nodes: [], edges: [], routes: [], merges: [], degraded: true, stats: { ...EMPTY_STATS, degradedReasons: [tr("editor.branch.reasonFallback", undefined, "推导失败")] } };
    }
  }, [text, tr]);
  const caret = Number.isFinite(caretLine) ? Math.max(1, Math.trunc(caretLine)) : 1;
  /** 光标行 → 节点（反向高亮）。`buildGraph` 已含 try/catch。 */
  const caretNodeId = useMemo(() => {
    try {
      return graphAt(String(text ?? ""), caret);
    } catch {
      return null;
    }
  }, [text, caret]);

  /** 布局（纯函数、确定性；同一 `graph` 只算一次）。 */
  const layout: Layout = useMemo(() => {
    try {
      return (layoutGraph(graph) ?? EMPTY_LAYOUT) as Layout;
    } catch {
      return EMPTY_LAYOUT;
    }
  }, [graph]);

  /** 手动点选（优先于光标行）；文本一变视为未点选（避免悬空 id）。 */
  const [picked, setPicked] = useState<{ text: string; id: string } | null>(null);
  const selectedId = (picked && picked.text === text ? picked.id : null) ?? caretNodeId;
  const selectedNode = useMemo(
    () => (selectedId ? layout.nodes.find((node) => node.id === selectedId) ?? null : null),
    [layout, selectedId],
  );
  const lanes = useMemo(() => new Map<string, number>(layout.lanes.map((lane) => [lane.id, lane.colorIndex])), [layout]);

  /** 平移面尺寸（「适配」的基准；`ResizeObserver` 只更新尺寸，不动视图）。 */
  const panRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const measure = useCallback(() => {
    const host = panRef.current;
    if (!host) return;
    const next = { w: host.clientWidth || 0, h: host.clientHeight || 0 };
    setSize((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
  }, []);
  // 尺寸测量：`ref` 回调里量首帧（DOM 挂载即触发，不需要 effect 里 setState），
  // `ResizeObserver` 负责后续变化；`useEffect` 里同步 `setSize` 会被
  // `react-hooks/set-state-in-effect` 判为级联渲染。
  const attachPan = useCallback((node: HTMLDivElement | null) => {
    panRef.current = node;
    if (!node) return;
    const next = { w: node.clientWidth || 0, h: node.clientHeight || 0 };
    setSize((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
  }, []);
  useEffect(() => {
    const host = panRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [measure]);

  /**
   * 视图 = 派生（`boxKey`）+ 用户交互的折叠：内容 / 容器尺寸一变，
   * `boxKey` 变化 → 自动回到「适配」。所以**不需要** effect 里 setState。
   */
  const [view, setView] = useState<ViewState>({ key: "", zoom: 1, x: 0, y: 0 });
  const boxKey = `${layout.width}x${layout.height}x${layout.nodes.length}x${size.w}x${size.h}`;
  const fitted = useMemo(
    () => (size.w > 0 && size.h > 0 ? fitView(layout, size.w, size.h) : { key: "", zoom: 1, x: 0, y: 0 }),
    [layout, size.w, size.h],
  );
  const current: ViewState = view.key === boxKey ? view : { ...fitted, key: boxKey };
  const applyView = useCallback((next: ViewState) => {
    setView({ ...next, key: boxKey });
  }, [boxKey]);

  /** `⤢ 适配`（也是首帧 / 内容变化后的基准）。 */
  const fit = useCallback(() => {
    applyView({ ...fitView(layout, size.w || 320, size.h || 200), key: boxKey });
  }, [applyView, boxKey, layout, size.h, size.w]);

  /** 热键的**最新**处理函数（`zoomBy` 在下方定义；挂载只做一次，读 ref）。 */
  const keyRef = useRef<(event: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const handler = (event: KeyboardEvent) => keyRef.current(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  /**
   * 以**指针（或容器中心）**为锚缩放。`+` / `−` 按钮、快捷键、双击都走这里，
   * 滚轮复用同一段数学：锚点下的世界坐标在缩放前后停在同一屏幕像素。
   */
  const zoomAtPoint = useCallback((factor: number, anchor?: { x: number; y: number }) => {
    const host = panRef.current;
    const zoom = clamp(current.zoom * factor, LAYOUT_ZOOM_MIN, LAYOUT_ZOOM_MAX);
    if (zoom === current.zoom) return;
    const px = anchor?.x ?? (size.w || host?.clientWidth || 320) / 2;
    const py = anchor?.y ?? (size.h || host?.clientHeight || 200) / 2;
    const wx = (px - current.x) / current.zoom;
    const wy = (py - current.y) / current.zoom;
    applyView({ key: boxKey, zoom: r(zoom), x: r(px - wx * zoom), y: r(py - wy * zoom) });
  }, [applyView, boxKey, current.x, current.y, current.zoom, size.h, size.w]);

  /** `+` / `−`：以容器中心为锚，一格 = `ZOOM_STEP`。 */
  const zoomBy = useCallback((direction: 1 | -1) => {
    zoomAtPoint(direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  }, [zoomAtPoint]);

  /** 热键：`0` = 适配、`+`/`=` 放大、`-` 缩小（不在输入框里按才生效，别抢正文键）。 */
  const handleKey = useCallback((event: KeyboardEvent) => {
    const tag = (event.target as HTMLElement | null)?.tagName ?? "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (event.metaKey || event.ctrlKey) return; // 让浏览器/页面的缩放与搜索
    const key = event.key;
    if (key !== "0" && key !== "+" && key !== "=" && key !== "-" && key !== "_") return;
    event.preventDefault();
    if (key === "0") fit();
    else if (key === "-" || key === "_") zoomBy(-1);
    else zoomBy(1);
  }, [fit, zoomBy]);
  // 最新 handler 进 ref（render 期只**读**它 → 不触发 `react-hooks/refs` 的写入规则）。
  useEffect(() => { keyRef.current = handleKey; });

  /**
   * 滚轮 = 以指针为锚缩放（`LAYOUT_ZOOM_MIN..MAX`）。
   *
   * ⚠️ 必须用**原生** `addEventListener(..., { passive: false })`：React 19 的
   * `onWheel` 走 root 上的**委托**、默认 `passive`，`preventDefault()` 只会在控制台
   * 报 `Unable to preventDefault inside passive event listener invocation.` 而**不生效**
   * —— 滚轮于是同时滚动了外层面板/页面，"缩放很难用"（StagePane 早先踩过同一个坑）。
   * 用 ref 存最新 handler，避免每次 `view` 变化都重挂监听。
   *
   * **Shift+滚轮** = 一把缩放更狠（×2.4 一格）；**Shift 之外的横向滚轮**
   * （触控板/带 tilt 的鼠标）当平移，符合"看 DAG 时想挪一下"的直觉。
   */
  const wheelRef = useRef<(event: WheelEvent) => void>(() => {});
  const handleWheel = (event: WheelEvent) => {
    if (!layout.nodes.length) return;
    if (event.ctrlKey && !event.altKey) return; // Ctrl+滚轮 = 浏览器缩放，让给它
    event.preventDefault();
    const host = panRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    // 横向滚轮（deltaY≈0、deltaX 明显）= 平移一格；纵向 = 缩放。
    if (event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      applyView({ key: boxKey, zoom: current.zoom, x: r(current.x - event.deltaX), y: r(current.y - event.deltaY) });
      return;
    }
    // 触控板/高分辨率滚轮给的是小数 delta → 按比例缩放，一格 ≈ ZOOM_STEP。
    // 下限 0.6（旧 0.4 太肉："放大缩小太难用"）；Shift = 粗档。
    const scale = event.shiftKey ? 2.4 : 1;
    const steps = clamp(Math.abs(event.deltaY) / 100, 0.6, 4) * scale;
    const factor = Math.pow(event.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP, steps);
    zoomAtPoint(factor, { x: px, y: py });
  };
  // 最新 handler 存进 ref（**在 effect 里**赋值：render 期写 ref 会被 lint 拦）；
  // 挂载只做一次，handler 永远读最新闭包。
  useEffect(() => {
    wheelRef.current = handleWheel;
  });
  useEffect(() => {
    const host = panRef.current;
    if (!host) return;
    const handler = (event: WheelEvent) => wheelRef.current(event);
    host.addEventListener("wheel", handler, { passive: false });
    return () => host.removeEventListener("wheel", handler);
  }, []);

  /** 拖空白 = 平移（卡片 / 按钮上按下不算）。 */
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as Element | null;
    if (target?.closest("[data-branch-node],button")) return;
    drag.current = { x: event.clientX, y: event.clientY, vx: current.x, vy: current.y };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 某些 WebView 不支持；退化为不捕获 */
    }
  }, [current.x, current.y]);
  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    applyView({
      key: boxKey,
      zoom: current.zoom,
      x: r(state.vx + (event.clientX - state.x)),
      y: r(state.vy + (event.clientY - state.y)),
    });
  }, [applyView, boxKey, current.zoom]);
  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  /** 「⤳ 在此分叉」草稿：`null` = 弹窗关闭。 */
  const [fork, setFork] = useState<{ nodeId: string; rows: { label: string; value: number }[] } | null>(null);
  const openFork = useCallback(() => {
    if (!selectedNode || !onPatch) return;
    let rows: { label: string; value: number }[] = [];
    try {
      rows = suggestForkOptions(String(text ?? ""), FORK_ROWS_MIN).slice(0, FORK_ROWS_MAX);
    } catch {
      rows = [{ label: tr("editor.branch.forkFallbackA", undefined, "选项一"), value: 1 }, { label: tr("editor.branch.forkFallbackB", undefined, "选项二"), value: 2 }];
    }
    setFork({ nodeId: selectedNode.id, rows });
    // `tr` 每个语言一个稳定函数：切语言时闭包跟着换（fallback 文案）。
  }, [onPatch, selectedNode, text, tr]);
  const confirmFork = useCallback(() => {
    if (!fork || !onPatch) return;
    const node = layout.nodes.find((candidate) => candidate.id === fork.nodeId);
    setFork(null);
    if (!node) return;
    try {
      const result = forkPatch(String(text ?? ""), node.range[1], fork.rows);
      onPatch(result.text, result.caretLine);
    } catch (error) {
      console.warn("[branch-graph] forkPatch failed:", error);
    }
  }, [fork, layout.nodes, onPatch, text]);

  /** 分支行高亮：`layout.mergeLines` 里的卡片画合流角标。 */
  const mergeLineSet = useMemo(() => {
    const raw = (layout as unknown as { mergeLines?: number[] }).mergeLines;
    return new Set(Array.isArray(raw) ? raw : []);
  }, [layout]);

  const hasChoice = layout.nodes.some((node) => node.role === "decision");
  const colorOf = useCallback((node: LayoutNode): string => {
    if (node.role === "node" && node.lane) {
      const index = lanes.get(node.lane);
      if (index !== undefined) return ["#4fc3f7", "#a5d6a7", "#ff8a65", "#ba68c8", "#4db6ac", "#e57373", "#9575cd", "#f4c430"][index % 8] ?? "#4fc3f7";
    }
    return ROLE_COLORS[node.role] ?? "#6b7280";
  }, [lanes]);
  const edgeColor = useCallback((edge: LayoutEdge): string => {
    if (edge.role === "choice") return "#f4c430";
    if (edge.role === "merge") return "#9575cd";
    if (edge.role === "back") return "#e57373";
    if (edge.role === "dead") return "#6b7280";
    return "#5b6472";
  }, []);

  const bodyHeight = Math.max(120, height - 58);
  /** 折叠（`▾`）：有 chrome 时用 `chrome.visible` / `chrome.onToggle`；
   *  没有 chrome 时退化为**组件内部**的收起（DOM 不卸载，与契约「显示不显示」一致）。 */
  const [folded, setFolded] = useState(false);
  const hidden = chrome?.visible === false || (!chrome?.onToggle && folded);
  const toggleFold = useCallback(() => {
    if (chrome?.onToggle) chrome.onToggle();
    else setFolded((value) => !value);
  }, [chrome]);

  return (
    <section className="ed-graph bg-graph" style={{ height, width: "100%" }} aria-label={tr("editor.panel.branchAriaFallback", undefined, "分支图")}>
      <header className="ed-graph-head bg-chrome" data-chrome="branch" data-active={chrome?.active ? "1" : "0"}
        onClick={chrome?.onSelect}
        onKeyDown={(event) => { if (event.key === "Enter") chrome?.onSelect?.(); }}
        role={chrome?.onSelect ? "button" : undefined}
        tabIndex={chrome?.onSelect ? 0 : undefined}
      >
        <span className="bg-role-chip" data-branch-role="legend" aria-hidden="true" />
        <span className="ed-graph-title">{chrome?.title ?? tr("editor.panel.branchAriaFallback", undefined, "分支图")}</span>
        <span className="ed-graph-stat">
          {hasChoice
            ? tr("editor.branch.decisionSummary", { decisions: graph.stats.decisions, lanes: layout.lanes.length, merges: graph.stats.merges }, `${graph.stats.decisions} 决策 · ${layout.lanes.length} 线路 · ${graph.stats.merges} 合流`)
            : tr("editor.branch.noBranches", undefined, "还没有分支")}
        </span>
        <span className="ed-graph-legend" data-branch-legend="1">
          {layout.lanes.slice(0, 6).map((lane) => (
            <span key={lane.id} className="ed-graph-legend-item" title={tr("editor.branch.laneTitle", { value: lane.value, label: lane.label }, `${lane.value}：${lane.label}`)}>
              <i style={{ background: colorOf({ role: "node", lane: lane.id } as LayoutNode) }} />
              {`${lane.value}:${lane.label.slice(0, 8)}`}
            </span>
          ))}
          {layout.lanes.length > 6 ? <span className="ed-graph-legend-more">{`+${layout.lanes.length - 6}`}</span> : null}
        </span>
        <span className="bg-chrome-grow" />
        {/* 缩放控件：`−` / 百分比（点按 = 适配） / `+` / 适配 —— 拖拽之外的第二条路。 */}
        <span className="bg-zoombar" data-branch-zoom-bar="1">
          <button
            type="button"
            className="bg-zoombtn"
            data-branch-action="zoom-out"
            title={tr("editor.branch.zoomOutTitle", undefined, "缩小（快捷键 −）")}
            aria-label={tr("editor.branch.zoomOut", undefined, "缩小")}
            disabled={current.zoom <= LAYOUT_ZOOM_MIN + 1e-6}
            onClick={() => zoomBy(-1)}
          >
            −
          </button>
          <button
            type="button"
            className="bg-zoom bg-zoom-reset"
            data-branch-zoom-label="1"
            title={tr("editor.branch.zoomResetTitle", undefined, "点按 = 适配窗口（快捷键 0）")}
            onClick={fit}
          >
            {`${Math.round(current.zoom * 100)}%`}
          </button>
          <button
            type="button"
            className="bg-zoombtn"
            data-branch-action="zoom-in"
            title={tr("editor.branch.zoomInTitle", undefined, "放大（快捷键 +）")}
            aria-label={tr("editor.branch.zoomIn", undefined, "放大")}
            disabled={current.zoom >= LAYOUT_ZOOM_MAX - 1e-6}
            onClick={() => zoomBy(1)}
          >
            +
          </button>
        </span>
        <button
          type="button"
          className="bg-fit"
          data-branch-action="fit"
          title={tr("editor.branch.fitTitle", undefined, "适配窗口（快捷键 0）")}
          onClick={fit}
        >
          {tr("editor.branch.fit", undefined, "⤢ 适配")}
        </button>
        <button
          type="button"
          className="bg-fold"
          data-branch-action="fold"
          onClick={toggleFold}
          title={hidden ? tr("editor.branch.expandTitle", undefined, "展开分支图") : tr("editor.branch.collapseTitle", undefined, "收起分支图")}
          aria-expanded={!hidden}
          aria-label={`${hidden ? tr("editor.toolbar.foldShow", undefined, "展开") : tr("editor.toolbar.foldHide", undefined, "收起")}${chrome?.ariaLabel || tr("editor.panel.branchAriaFallback", undefined, "分支图")}`}
        >
          {hidden ? "▸" : "▾"}
        </button>
        {onClose ? (
          <button type="button" className="ed-graph-close" onClick={onClose} aria-label={tr("editor.branch.close", undefined, "关闭分支图")}>✕</button>
        ) : null}
      </header>

      {graph.degraded ? (
        <p className="ed-graph-warn" role="status">
          {tr("editor.branch.degraded", { reason: graph.stats.degradedReasons[0] ? `（${graph.stats.degradedReasons[0]}）` : "" }, `分支结构较复杂，图上可能只展开了部分线路${graph.stats.degradedReasons[0] ? `（${graph.stats.degradedReasons[0]}）` : ""}`)}
        </p>
      ) : null}

      <div className="ed-graph-body" style={{ height: bodyHeight }} hidden={hidden}>        <div
          className="ed-graph-pan"
          data-branch-pan="1"
          ref={attachPan}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <svg
            className="ed-graph-svg"
            data-branch-graph="1"
            data-branch-zoom={r(current.zoom)}
            width="100%"
            height="100%"
            aria-label={tr("editor.branch.graphAria", undefined, "分支图（按 Decision / Predicate 画剧情走向）")}
          >
            <defs>
              <marker id="bg-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M0,0 L7,3.5 L0,7 z" fill="#7a8494" />
              </marker>
              <marker id="bg-arrow-choice" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M0,0 L7,3.5 L0,7 z" fill="#f4c430" />
              </marker>
              <marker id="bg-arrow-merge" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M0,0 L7,3.5 L0,7 z" fill="#9575cd" />
              </marker>
            </defs>
            <g className="bg-world" transform={`translate(${r(current.x)} ${r(current.y)}) scale(${r(current.zoom)})`}>
              {/* 连线在卡片下层：正交折线 + 分支标签（贴竖向段中点） */}
              <g className="bg-edges">
                {layout.edges.map((edge) => {
                  const color = edgeColor(edge);
                  const dashed = edge.role === "back" || edge.role === "dead" || edge.role === "merge";
                  return (
                    <g key={edge.id} className={`bg-edge bg-edge-${edge.role}`} data-branch-edge-role={edge.role}>
                      <path
                        data-branch-edge="1"
                        data-branch-path="1"
                        data-branch-edge-id={edge.id}
                        d={edge.d}
                        fill="none"
                        stroke={color}
                        strokeWidth={edge.role === "choice" || edge.role === "merge" ? 1.8 : 1.4}
                        strokeDasharray={dashed ? "5 4" : undefined}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                        markerEnd={edge.to && edge.role !== "dead" ? (edge.role === "choice" ? "url(#bg-arrow-choice)" : edge.role === "merge" ? "url(#bg-arrow-merge)" : "url(#bg-arrow)") : undefined}
                      />
                      {edge.label && edge.anchor ? (
                        <g className="bg-edge-label" transform={`translate(${r(edge.anchor.x)} ${r(edge.anchor.y)})`}>
                          <rect x={-30} y={-11} width={60} height={17} rx={4} className="bg-edge-label-bg" />
                          <text className="bg-edge-label-text" textAnchor="middle" y={1.5}>{edge.label.slice(0, 8)}</text>
                          <title>{tr("editor.branch.edgeTitle", { label: edge.label, value: edge.value ?? "—" }, `${edge.label}（value=${edge.value ?? "—"}）`)}</title>
                        </g>
                      ) : null}
                    </g>
                  );
                })}
              </g>

              {/* 卡片节点：左色条 + 标题 + 摘要 + 状态点 */}
              <g className="bg-nodes">
                {layout.nodes.map((node) => {
                  const color = colorOf(node);
                  const active = node.id === caretNodeId;
                  const chosen = node.id === selectedId;
                  const isMerged = mergeLineSet.has(node.line);
                  return (
                    <g
                      key={node.id}
                      className={`ed-graph-node bg-node bg-node-${node.role}${active ? " is-active" : ""}${chosen ? " is-picked" : ""}`}
                      data-node={node.id}
                      data-branch-node={node.id}
                      data-branch-layer={node.layer}
                      data-branch-role={node.role}
                      transform={`translate(${r(node.x)} ${r(node.y)})`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setPicked({ text, id: node.id });
                        onJumpToLine(node.line);
                      }}
                    >
                      <title>{`#${node.range[0]}${node.range[1] > node.range[0] ? `–${node.range[1]}` : ""} · ${node.role}${node.lane ? ` · ${node.lane}` : ""}\n${node.text}`}</title>
                      <rect className="bg-card" x={0} y={0} width={node.w} height={node.h} rx={8} />
                      <rect className="bg-card-bar" x={1} y={1} width={4} height={node.h - 2} rx={2} fill={color} />
                      {node.role === "decision" ? (
                        <polygon className="bg-diamond" points="14,32 20,24 26,32 20,40" fill="none" stroke={color} strokeWidth={1.4} />
                      ) : null}
                      <text className="bg-title" x={node.role === "decision" ? 34 : 14} y={27}>{node.title}</text>
                      {node.role === "decision" ? (
                        <g className="bg-pills">
                          {node.lines.slice(0, 3).map((option, index) => (
                            <g key={`${node.id}-pill-${index}`} transform={`translate(${14 + index * 62} 40)`}>
                              <rect className="bg-pill" x={0} y={0} width={58} height={16} rx={4} />
                              <text className="bg-pill-text" x={29} y={11.5} textAnchor="middle">{option.slice(0, 5)}</text>
                            </g>
                          ))}
                        </g>
                      ) : (
                        <text className="bg-summary" x={14} y={46}>{node.summary}</text>
                      )}
                      {isMerged ? <text className="bg-merge-tag" x={node.w - 12} y={58} textAnchor="end">{tr("editor.branch.mergeTag", undefined, "合流")}</text> : null}
                      <circle
                        className={`bg-state bg-state-${isMerged ? "done" : active ? "active" : "idle"}`}
                        cx={node.w - 11}
                        cy={12}
                        r={3.5}
                        fill={isMerged ? "#4caf50" : active ? "#f4c430" : "#5b6472"}
                      />
                      {node.mixed ? (
                        <text className="bg-values" x={node.w - 12} y={node.h - 4} textAnchor="end">
                          {`v${node.values.filter((value) => value !== 0).join("/") || "0"}`}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </g>
            </g>
          </svg>

          {!hasChoice ? (
            <p className="ed-graph-empty bg-empty" data-branch-empty="1" role="status">{tr("editor.branch.emptyHint", undefined, EMPTY_HINT_DEFAULT)}</p>
          ) : null}
          {layout.degenerate ? (
            <p className="bg-hint" data-branch-hint="degenerate">{tr("editor.branch.degenerateHint", undefined, "节点较多，已退化为一列排布；可滚轮缩放后拖动查看。")}</p>
          ) : null}
        </div>
      </div>

      {hidden ? (
        <p className="ed-graph-empty" data-branch-hidden="1">{tr("editor.branch.collapsed", { title: chrome?.title ?? tr("editor.panel.branchAriaFallback", undefined, "分支图") }, `${chrome?.title ?? "分支图"}已收起（点 ▸ 展开）`)}</p>
      ) : null}

      <div className="ed-graph-actions">
        <span className="ed-graph-hint">
          {selectedNode
            ? tr("editor.branch.selection", { line: selectedNode.range[0], title: selectedNode.title }, `选中 #${selectedNode.range[0]}：${selectedNode.title}`)
            : tr("editor.branch.hint", undefined, "点卡片跳行 · 拖空白平移 · 滚轮缩放 · 0 / ⤢ 适配")}
        </span>
        <button
          type="button"
          className="ed-graph-fork"
          data-branch-action="fork"
          disabled={!selectedNode || !onPatch}
          title={onPatch ? tr("editor.branch.forkTitle", undefined, "在选中卡片之后插入一条 Decision（每条线一个 Predicate + 末尾合流闸门）") : tr("editor.branch.forkTitleReadOnly", undefined, "当前为只读（未提供 onPatch）")}
          onClick={openFork}
        >
          {tr("editor.branch.forkButton", undefined, "⤳ 在此分叉")}
        </button>
      </div>

      {fork ? (
        <div className="ed-graph-forkbox" role="dialog" aria-label={tr("editor.branch.forkDialog", undefined, "在此分叉")}>
          <table>
            <thead>
              <tr>
                <th>{tr("editor.branch.forkOptionColumn", undefined, "选项文本")}</th>
                <th>value</th>
              </tr>
            </thead>
            <tbody>
              {fork.rows.map((row, index) => (
                <tr key={`fork-${index}`}>
                  <td>
                    <input
                      value={row.label}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setFork((state) => state && {
                          ...state,
                          rows: state.rows.map((item, at) => (at === index ? { ...item, label: value } : item)),
                        });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      value={row.value}
                      onChange={(event) => {
                        const parsed = Number.parseInt(event.currentTarget.value, 10);
                        const value = Number.isFinite(parsed) ? parsed : 0;
                        setFork((state) => state && {
                          ...state,
                          rows: state.rows.map((item, at) => (at === index ? { ...item, value } : item)),
                        });
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ed-graph-forkbtns">
            <button
              type="button"
              onClick={() => setFork((state) => state && state.rows.length < FORK_ROWS_MAX
                ? { ...state, rows: [...state.rows, { label: tr("editor.branch.forkOptionDefault", { index: state.rows.length + 1 }, `选项${state.rows.length + 1}`), value: Math.max(1, ...state.rows.map((row) => row.value)) + 1 }] }
                : state)}
              disabled={fork.rows.length >= FORK_ROWS_MAX}
            >
              {tr("editor.branch.forkAddRow", undefined, "+ 一行")}
            </button>
            <button
              type="button"
              onClick={() => setFork((state) => state && state.rows.length > FORK_ROWS_MIN ? { ...state, rows: state.rows.slice(0, -1) } : state)}
              disabled={fork.rows.length <= FORK_ROWS_MIN}
            >
              {tr("editor.branch.forkRemoveRow", undefined, "− 一行")}
            </button>
            <span className="ed-graph-forkgap" />
            <button type="button" className="ed-graph-forkcancel" onClick={() => setFork(null)}>{tr("editor.common.cancel", undefined, "取消")}</button>
            <button type="button" className="ed-graph-forkok" onClick={confirmFork}>{tr("editor.branch.forkConfirm", undefined, "插入")}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** 保留 `Route` / `GraphNode` / `Edge` 的类型引用（页面 props 契约的一部分）。 */
export type { Edge, Graph, GraphNode, Route };
