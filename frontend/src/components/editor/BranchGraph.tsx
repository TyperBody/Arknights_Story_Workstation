/**
 * StoryEditorPage 的「分支图」视图（task-16）——**独立组件，只依赖 props**。
 *
 * ```tsx
 * <BranchGraph
 *   text={text}                        // 全文（与编辑器 textarea 同源）
 *   caretLine={caret.line}             // 1 基光标行：高亮 + 自动滚入可视区
 *   onJumpToLine={(line) => …}         // 点节点 = 跳到该节点起始行
 *   onPatch={(next, caret) => …}       // 「⤳ 在此分叉」= 回写整篇
 *   height={220}                       // 缺省 220
 *   onClose={() => …}                  // 可选：右上角 ✕
 * />
 * ```
 *
 * 纯 SVG/DOM、零新依赖。所有「线路 / 合流 / 分叉补丁」推导来自
 * `src/akstage/local/branchGraph.js`（`buildGraph` / `graphAt` /
 * `suggestForkOptions` / `forkPatch`）—— 见那里的注释（引擎出处
 * `engine/runtime.ts` 的 decision/predicate case 与
 * `engine/log/semantics.ts` 的 `passesGate`；形状与预算见
 * `.akskills/arkstage-fanfic/reference/branching.md`）。本文件只负责画与交互：
 *   · x 轴 = `node.depth`（列）= 决策层；y 轴 = 节点顺序；线路 ≥6 色循环 + 图例；
 *     选线节点（choice）= 菱形头部 + 双边框；合流节点 = 虚线框；点节点 = 跳行；
 *     hover = 原生 `<title>`（行号 + 线路 + 原文首行）；
 *   · 滚轮缩放（`viewBox`，clamp 0.4~3）；拖空白平移；`pointerdown` 上 `touch-action:none`；
 *   · 「⤳ 在此分叉」：选中节点 → 弹一张 2~4 行的小表格（选项文本 + value）→
 *     确定 → `onPatch(forkPatch(text, 节点末行, rows))` 回写整篇（页面会重跑 lint）；
 *   · 无 Decision → 空态文案；`degraded` → 黄色提示条，图仍可交互。
 *
 * 缺 `onPatch`、`text` 为空、无 Decision、`degraded` 都**不崩**：作为
 * `optionalPart()` 懒加载的可选面板，任何一种缺席都是正常状态。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import {
  buildGraph,
  forkPatch,
  graphAt,
  suggestForkOptions,
  type Edge,
  type Graph,
  type Node as GraphNode,
  type Route,
} from "../../../../src/akstage/local/branchGraph.js";
import "./branchGraph.css";

/** 组件的 props（task-16 契约**逐字**）。 */
export interface BranchGraphProps {
  text: string;
  caretLine: number;
  onJumpToLine: (line: number) => void;
  onPatch?: (nextText: string, caretLine?: number) => void;
  height?: number;
  onClose?: () => void;
}

/** 线路配色（≥6 循环；`-1` = 主线/未归属的淡色）。 */
const ROUTE_COLORS = ["#f4c430", "#4fc3f7", "#a5d6a7", "#ff8a65", "#ba68c8", "#4db6ac", "#e57373", "#9575cd"];
/** 单次滚轮的缩放倍率（配合 `ZOOM_MIN`/`ZOOM_MAX` 的 clamp）。 */
const ZOOM_STEP = 1.1;
/** 画布几何（SVG 用户单位 ≈ px；缩放只改 `viewBox`）。 */
const COL_W = 196;
const ROW_H = 34;
const NODE_W = 160;
const NODE_H = 26;
const PAD = 16;
const LABEL_CHARS = 14;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
/** 分叉表格的行数范围（契约：2~4 行）。 */
const FORK_ROWS_MIN = 2;
const FORK_ROWS_MAX = 4;

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ForkRow {
  label: string;
  value: number;
}

/** 空图（`buildGraph` 理论上不会抛；这里只是第二道保险）。 */
const EMPTY_STATS = {
  lines: 0, parsedLines: 0, decisions: 0, choices: 0, routes: 0, nodes: 0, edges: 0,
  merges: 0, forks: 0, maxDepth: 0, combos: 0, lineagesMax: 0, degradedReasons: [] as string[],
};

/** 节点标签截断（**不用 canvas 量字体**；纯字符串截断）。 */
function clipLabel(text: string, max = LABEL_CHARS): string {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value || "（空）";
}

/** 线路索引 → 颜色（越界循环）。 */
function colorOf(index: number): string {
  if (index < 0) return "#6b7280";
  return ROUTE_COLORS[index % ROUTE_COLORS.length] ?? "#6b7280";
}

/**
 * 分支图面板。
 * @param props
 */
export default function BranchGraph({ text, caretLine, onJumpToLine, onPatch, height = 220, onClose }: BranchGraphProps) {
  /** 图：文本变化才重算（大脚本也只算一次）。 */
  const graph: Graph = useMemo(() => {
    try {
      return buildGraph(String(text ?? ""));
    } catch {
      return { nodes: [], edges: [], routes: [], merges: [], degraded: true, stats: { ...EMPTY_STATS, degradedReasons: ["推导失败"] } };
    }
  }, [text]);
  const caret = Number.isFinite(caretLine) ? Math.max(1, Math.trunc(caretLine)) : 1;
  /** 光标行 → 节点（反向高亮）。`buildGraph` 已含 try/catch。 */
  const caretNodeId = useMemo(() => {
    try {
      return graphAt(String(text ?? ""), caret);
    } catch {
      return null;
    }
  }, [text, caret]);

  /**
   * 手动点选（优先于光标行）。**不做 effect 重置** —— 记录「点选时那一稿的
   * 文本」，文本一变（含 `forkPatch` 回写）自动视为未点选，从而指向必然存在
   * 的节点 id（`useState` 里存快照，避免 setState-in-effect）。
   */
  const [picked, setPicked] = useState<{ text: string; id: string } | null>(null);
  const selectedId = (picked && picked.text === text ? picked.id : null) ?? caretNodeId;
  const selectedNode = useMemo(
    () => (selectedId ? graph.nodes.find((node: GraphNode) => node.id === selectedId) ?? null : null),
    [graph, selectedId],
  );
  const routeIndex = useMemo(() => new Map<string, number>(graph.routes.map((route: Route, index: number) => [route.id, index] as const)), [graph]);

  /** 布局：x = depth 列，y = 节点顺序。 */
  const layout = useMemo(() => {
    const positions = new Map<string, { x: number; y: number }>();
    graph.nodes.forEach((node: GraphNode, index: number) => {
      positions.set(node.id, { x: PAD + node.depth * COL_W, y: PAD + index * ROW_H });
    });
    return positions;
  }, [graph]);

  const content = useMemo(() => {
    const maxDepth = graph.nodes.reduce((max: number, node: GraphNode) => Math.max(max, node.depth), 0);
    return {
      width: PAD * 2 + (maxDepth + 1) * COL_W,
      height: PAD * 2 + Math.max(1, graph.nodes.length) * ROW_H + 8,
    };
  }, [graph]);

  const bodyHeight = Math.max(80, height - 84);
  /**
   * 视图状态 = 派生（内容尺寸）+ 用户交互（缩放/平移）的**折叠**结果：
   * `boxKey` 记录派生时用的内容尺寸，内容一变自动以「看得见全图」为基准，
   * 不需要在 effect 里 setState。光标行居中同理（见下面 `viewBox` 的 y 修正）。
   */
  const EMPTY_VIEW = { key: "", zoom: 1, panX: 0, panY: 0 };
  const [view, setView] = useState<{ key: string; zoom: number; panX: number; panY: number }>(EMPTY_VIEW);
  const boxKey = `${content.width}x${content.height}x${bodyHeight}`;
  const viewState = view.key === boxKey ? view : { ...EMPTY_VIEW, key: boxKey };
  const baseHeight = Math.max(1, bodyHeight || content.height);
  /** 光标行所在节点的 y（用于「自动居中」；派生阶段算，不写 effect）。 */
  const caretY = useMemo(() => (caretNodeId ? layout.get(caretNodeId)?.y ?? null : null), [caretNodeId, layout]);
  /** 当前 `viewBox`：内容尺寸 + 缩放决定宽高，光标行决定 y（鼠标拖过则用 panY）。 */
  const box = useMemo<ViewBox>(() => {
    const width = Math.max(1, content.width) / viewState.zoom;
    const height = baseHeight / viewState.zoom;
    const maxY = Math.max(0, content.height - height);
    const desired = caretY !== null ? caretY - height / 2 + NODE_H / 2 : viewState.panY - height / 2;
    const y = Math.min(maxY, Math.max(0, viewState.panY !== 0 ? viewState.panY : desired));
    return { x: viewState.panX, y, w: width, h: height };
  }, [baseHeight, caretY, content.height, content.width, viewState.panX, viewState.panY, viewState.zoom]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; box: ViewBox } | null>(null);
  /** 「⤳ 在此分叉」草稿：`null` = 弹窗关闭。 */
  const [fork, setFork] = useState<{ nodeId: string; rows: ForkRow[] } | null>(null);
  /**
   * 交互（滚轮缩放 / 拖拽平移）→ 折成 `{zoom, panX, panY}`。
   * 目标 `value` 相对**本帧派生出来的 `box`** 计算，故不需要在 effect 里
   * 同步状态（内容一变，`boxKey` 变化即自动回到「看得见全图」的基准）。
   */
  const applyView = useCallback((value: ViewBox) => {
    setView({
      key: boxKey,
      zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.max(1, content.width) / Math.max(1, value.w))),
      panX: value.x,
      panY: value.y,
    });
  }, [boxKey, content.width]);

  /** 滚轮 = 缩放。缩放倍率 clamp 在 `ZOOM_MIN..ZOOM_MAX`（`viewBox` 越小越"放大"）。 */
  const onWheel = useCallback((event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
    const width = Math.min(content.width / ZOOM_MIN, Math.max(content.width / ZOOM_MAX, box.w / factor));
    const ratio = width / box.w;
    applyView({ ...box, w: width, h: box.h * ratio });
  }, [applyView, box, content.width]);

  /** 拖空白 = 平移。 */
  const onPointerDown = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const target = event.target as Element | null;
    if (target?.closest("[data-node]")) return;
    drag.current = { x: event.clientX, y: event.clientY, box };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 某些 WebView 不支持；退化为不捕获 */
    }
  }, [box]);

  const onPointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const state = drag.current;
    if (!state) return;
    const pixels = Math.max(60, bodyRef.current?.clientWidth ?? content.width);
    const scale = state.box.w / pixels;
    applyView({
      ...state.box,
      x: state.box.x - (event.clientX - state.x) * scale,
      y: Math.max(0, state.box.y - (event.clientY - state.y) * (state.box.h / Math.max(40, bodyHeight))),
    });
  }, [applyView, bodyHeight, content.width]);

  const onPointerUp = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  const openFork = useCallback(() => {
    if (!selectedNode || !onPatch) return;
    let rows: ForkRow[] = [];
    try {
      rows = suggestForkOptions(String(text ?? ""), FORK_ROWS_MIN).slice(0, FORK_ROWS_MAX);
    } catch {
      rows = [
        { label: "选项一", value: 1 },
        { label: "选项二", value: 2 },
      ];
    }
    setFork({ nodeId: selectedNode.id, rows });
  }, [onPatch, selectedNode, text]);

  const confirmFork = useCallback(() => {
    if (!fork || !onPatch) return;
    const node = graph.nodes.find((candidate: GraphNode) => candidate.id === fork.nodeId);
    setFork(null);
    if (!node) return;
    try {
      const result = forkPatch(String(text ?? ""), node.lines[1], fork.rows);
      onPatch(result.text, result.caretLine);
    } catch (error) {
      // 极端输入下宁可不动稿，也不要让页面崩（`Textarea` 里还有用户的原文）。
      console.warn("[branch-graph] forkPatch failed:", error);
    }
  }, [fork, graph, onPatch, text]);

  const hasChoice = graph.nodes.some((node) => node.kind === "choice");

  return (
    <section className="ed-graph" style={{ height, width: "100%" }} aria-label="分支图">
      <header className="ed-graph-head">
        <span className="ed-graph-title">分支图</span>
        <span className="ed-graph-stat">
          {hasChoice
            ? `${graph.stats.decisions} 决策 · ${graph.routes.length} 线路 · ${graph.merges.length} 合流`
            : "还没有分支"}
        </span>
        <span className="ed-graph-legend">
          {graph.routes.slice(0, 6).map((route: Route, index: number) => (
            <span key={route.id} className="ed-graph-legend-item" title={`${route.value}：${route.label}`}>
              <i style={{ background: colorOf(routeIndex.get(route.id) ?? index) }} />
              {`${route.value}:${clipLabel(route.label, 8)}`}
            </span>
          ))}
          {graph.routes.length > 6 ? <span className="ed-graph-legend-more">{`+${graph.routes.length - 6}`}</span> : null}
        </span>
        {onClose ? (
          <button type="button" className="ed-graph-close" onClick={onClose} aria-label="关闭分支图">
            ✕
          </button>
        ) : null}
      </header>

      {graph.degraded ? (
        <p className="ed-graph-warn" role="status">
          {`分支结构较复杂，图上可能只展开了部分线路${graph.stats.degradedReasons[0] ? `（${graph.stats.degradedReasons[0]}）` : ""}`}
        </p>
      ) : null}
      {hasChoice ? null : <p className="ed-graph-empty">还没有分支：选中一行后点「⤳ 在此分叉」。</p>}

      <div className="ed-graph-body" ref={bodyRef} style={{ height: bodyHeight }}>
        <svg
          className="ed-graph-svg"
          viewBox={`${box.x} ${box.y} ${Math.max(1, box.w)} ${Math.max(1, box.h)}`}
          preserveAspectRatio="xMidYMin meet"
          width="100%"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <defs>
            <marker id="ed-graph-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 z" fill="#4b5563" />
            </marker>
          </defs>

          {graph.edges.map((edge: Edge, index: number) => {
            const from = edge.from ? layout.get(edge.from) : undefined;
            if (!from) return null;
            const to = edge.to ? layout.get(edge.to) : undefined;
            const color = edge.value === null ? "#4b5563" : colorOf(routeIndex.get(edge.routes[0] ?? "") ?? -1);
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = to ? to.x : x1 + 28;
            const y2 = to ? to.y + NODE_H / 2 : y1;
            return (
              <g key={`edge-${index}`}>
                <path
                  d={to ? `M ${x1} ${y1} C ${x1 + 28} ${y1}, ${x2 - 28} ${y2}, ${x2} ${y2}` : `M ${x1} ${y1} h 28`}
                  fill="none"
                  stroke={color}
                  strokeWidth={to ? 1.6 : 1.1}
                  strokeDasharray={to ? undefined : "4 3"}
                  markerEnd={to ? "url(#ed-graph-arrow)" : undefined}
                />
                {edge.label ? (
                  <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 3} textAnchor="middle" fontSize={9.5} fill="#cfd6e4">
                    {clipLabel(edge.label, 8)}
                  </text>
                ) : null}
              </g>
            );
          })}

          {graph.nodes.map((node: GraphNode) => {
            const position = layout.get(node.id);
            if (!position) return null;
            const stroke = node.kind === "choice"
              ? "#f4c430"
              : node.kind === "merge"
                ? "#8b93a7"
                : colorOf(node.route ? routeIndex.get(node.route) ?? -1 : -1);
            const active = node.id === caretNodeId;
            const chosen = node.id === selectedId;
            const label = `#${node.lines[0]}${node.lines[1] > node.lines[0] ? `–${node.lines[1]}` : ""} · ${
              node.route ?? (node.kind === "merge" ? "合流" : "主线")
            }\n${node.text}`;
            return (
              <g
                key={node.id}
                data-node={node.id}
                className={`ed-graph-node${active ? " is-active" : ""}${chosen ? " is-picked" : ""}`}
                transform={`translate(${position.x} ${position.y})`}
                onClick={() => {
                  setPicked({ text, id: node.id });
                  onJumpToLine(node.lines[0]);
                }}
              >
                <title>{label}</title>
                <rect
                  x={0}
                  y={0}
                  width={NODE_W}
                  height={NODE_H}
                  rx={7}
                  fill={node.kind === "merge" ? "rgba(139,147,167,0.12)" : "rgba(255,255,255,0.05)"}
                  stroke={stroke}
                  strokeWidth={active || chosen ? 2.4 : 1.2}
                  strokeDasharray={node.kind === "merge" ? "5 3" : undefined}
                />
                {node.kind === "choice" ? <polygon points="8,13 17,4 26,13 17,22" fill="none" stroke={stroke} strokeWidth={1.4} /> : null}
                <text x={node.kind === "choice" ? 32 : 8} y={NODE_H / 2 + 4} fontSize={11} fill="#e6e9f0">
                  {clipLabel(node.text)}
                </text>
                {node.values.length > 1 ? (
                  <text x={NODE_W - 6} y={NODE_H - 6} textAnchor="end" fontSize={8.5} fill="#f4c430">
                    {`v${node.values.filter((value: number) => value !== 0).join("/") || "0"}`}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="ed-graph-actions">
        <span className="ed-graph-hint">
          {selectedNode ? `选中 #${selectedNode.lines[0]}：${clipLabel(selectedNode.text, 20)}` : "点选一个节点后点「⤳ 在此分叉」"}
        </span>
        <button
          type="button"
          className="ed-graph-fork"
          disabled={!selectedNode || !onPatch}
          title={onPatch ? "在选中节点之后插入一条 Decision（每条线一个 Predicate + 末尾合流闸门）" : "当前为只读（未提供 onPatch）"}
          onClick={openFork}
        >
          ⤳ 在此分叉
        </button>
      </div>

      {fork ? (
        <div className="ed-graph-forkbox" role="dialog" aria-label="在此分叉">
          <table>
            <thead>
              <tr>
                <th>选项文本</th>
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
                        setFork((current) => current && {
                          ...current,
                          rows: current.rows.map((item, at) => (at === index ? { ...item, label: value } : item)),
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
                        setFork((current) => current && {
                          ...current,
                          rows: current.rows.map((item, at) => (at === index ? { ...item, value } : item)),
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
              onClick={() => setFork((current) => current && current.rows.length < FORK_ROWS_MAX
                ? {
                  ...current,
                  rows: [...current.rows, { label: `选项${current.rows.length + 1}`, value: Math.max(1, ...current.rows.map((row) => row.value)) + 1 }],
                }
                : current)}
              disabled={fork.rows.length >= FORK_ROWS_MAX}
            >
              + 一行
            </button>
            <button
              type="button"
              onClick={() => setFork((current) => current && current.rows.length > FORK_ROWS_MIN
                ? { ...current, rows: current.rows.slice(0, -1) }
                : current)}
              disabled={fork.rows.length <= FORK_ROWS_MIN}
            >
              − 一行
            </button>
            <span className="ed-graph-forkgap" />
            <button type="button" className="ed-graph-forkcancel" onClick={() => setFork(null)}>
              取消
            </button>
            <button type="button" className="ed-graph-forkok" onClick={confirmFork}>
              插入
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
