/**
 * StagePane —— 16:9 舞台预览（task-10）。
 *
 * 独立组件：不读任何 app context，**只依赖 props**。
 *
 * ```tsx
 * <StagePane
 *   chars={snapshot.chars}          // 可带 rect/anchor/url（stageModel.parseStage 的产物）
 *   background={snapshot.background?.key ?? null}
 *   height={214}
 *   onMove={(slot, delta) => …}     // delta 单位 = 1280×720 画布 px（y 向下）
 *   onSelect={(slot) => …}
 *   selected={slot}
 * />
 * ```
 *
 * - **坐标**：画布恒 1280×720（`stageModel.ts` 与引擎一致）。`chars[].rect` 给了就直接
 *   画；没给就用 `stageModel.layoutOf`（`model` / 全局注入的角色表）算，命中不到就画
 *   虚线占位框 + 名字（"未知角色"不再静默消失）。
 * - **拖拽**：pointerup 时发**整段位移**（画布 px）。沿用的引擎语义见
 *   `stageModel.movePatch()`：`[Character]` 的 `xpos…`/`ypos…` 只是滑入起点，
 *   想留住位置要用 `CharacterAction(move)` / `charslot(setpos)` / `character.json` 的 `pos`。
 * - **缩放**：**连续** 25%…200%（`stageZoom.ts`）：滚轮以**指针为锚**、
 *   `−`/`＋` 一格 10%、百分比按钮回 100%、`适配` 用 `fitZoom`、`1:1` = 100%。
 *   缩放**只改 viewBox**，画布 px 几何一个像素都不动（HUD 里显示的仍是画布 px）。
 * - **resolveUrl**：`(key, kind) => url`；不给就用 prts 直链（应用里由调用方
 *   用 `prts-cdn://` 代理改写）。
 * - **chrome**：可选 `chrome?: PanelChromeProps`（BRIEF §2.2，P4 的
 *   `inspectorWindow.ts`）；缺失时内容照常渲染。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  STAGE_HEIGHT,
  STAGE_WIDTH,
  type Box,
  type CharacterTable,
  type Point,
  type Slot,
  type StageCharInput,
  ensureBackgroundRules,
  ensureCharacterTable,
  layoutOf,
  movePatch,
  type BackgroundRules,
  type MovePatch,
  resolveExpression,
  rulesFromModel,
  tableFromModel,
} from "./stageModel";
import {
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  STAGE_CANVAS,
  WHEEL_STEP,
  anchorPoint,
  clampZoom,
  cssScale,
  fitZoom,
  viewFor,
  wheelDelta,
  zoomAt,
  zoomPercent,
  type ZoomView,
} from "./stageZoom";
// P4 的窗口壳类型（BRIEF §2.2）。`inspectorWindow.ts` = 纯类型/工具（无 React）。
// TODO(P4)：若该文件在并行期还没落地，把下面这行换成下面注释里的行内形状即可
// （`PanelChromeProps` 只有 6 个字段，组件只读 title/ariaLabel/visible/onToggle/onSelect/active）。
//   export interface PanelChromeProps {
//     title: string; ariaLabel: string; visible: boolean;
//     onToggle?: () => void; onSelect?: () => void; active?: boolean;
//   }
import type { PanelChromeProps } from "./inspectorWindow";

/** 组件接受的字符（`parseStage` 的产物超集；缺 rect 时自己算）。 */
export interface StagePaneChar extends StageCharInput {
  slot?: Slot;
  label?: string;
  /** `parseStage`/编辑器兜底解析给的名字（`name` 的别名）。 */
  focus?: boolean;
}

/** 背景：`[Background(image=…)]` 的键，或 `parseStage` 给的 `{key,url,rule}`。 */
export type StagePaneBackground =
  | string
  | { key?: string | null; url?: string | null; rule?: unknown }
  | null
  | undefined;

export interface StagePaneProps {
  chars: StagePaneChar[];
  /** 背景键或 `{key,url}`；`null`/`""`/拼不出 URL = 纯黑底（**不发** `src=""` 的空请求）。 */
  background?: StagePaneBackground;
  /** 窗格高度（px）；宽度自适应，画布按 16:9 letterbox 居中。 */
  height?: number;
  /** 拖拽结束：`delta` 单位 = 1280×720 画布 px、y 向下（拖右 `+x`、拖下 `+y`）。 */
  onMove?: (slot: Slot, delta: Point) => void;
  /** 点选立绘（空舞台点击 → `null`，用于取消选择）。 */
  onSelect?: (slot: Slot | null) => void;
  /** 当前选中的槽。 */
  selected?: string | null;
  /** 素材 URL 改写（应用里通常接 `prts-cdn://` 代理）。 */
  resolveUrl?: (key: string, kind?: "background" | "character") => string;
  /** 角色表（`character.json` / `StoryPlayerBundle` / runtime.json）；不给就用组件自己拉的（`ensureCharacterTable`）。 */
  model?: Record<string, unknown> | null;
  /** 背景规则（`patch/resolutionRules.json`）；不给就从 `model` 取、或组件自己拉一次 `background.json`。 */
  rules?: BackgroundRules | null;
  /** 关掉"自己拉上游表"（测试/离线：只用 props 里的 rect）。 */
  offline?: boolean;
  /** 覆盖 `focus=` 的亮/暗（不给按每个立绘自带的 `dimmed`）。 */
  focusSlots?: Slot[];
  /** 初始缩放：连续值 `[MIN_ZOOM, MAX_ZOOM]`（`1` = 100%）。窗格内按钮/滚轮写 override。 */
  zoom?: number;
  /** 画栅格 + 槽位虚线（默认开）。 */
  showGuides?: boolean;
  /** 当前光标行的原文：给了才能在「复制这一行」里给出**整行**。 */
  line?: string | null;
  /** 每次拖拽结束的补丁（供编辑器记录/回写）。 */
  onPatch?: (patch: MovePatch) => void;
  /**
   * 窗口壳 chrome（BRIEF §2.2；P4 的 `inspectorWindow.ts`）。
   * **可选**：不给时内容照常渲染（只少一条 `.sp-chrome`）。
   */
  chrome?: PanelChromeProps;
  className?: string;
}

/** 安全框（任务给的 1280×720 letterbox：标题 90% / 动作 93%）。 */
const SAFE_TITLE = { x: STAGE_WIDTH * 0.05, y: STAGE_HEIGHT * 0.05 };
const SAFE_ACTION = { x: STAGE_WIDTH * 0.035, y: STAGE_HEIGHT * 0.035 };
/** 未知角色的占位框尺寸。 */
const PLACEHOLDER_SIZE = { w: 720, h: 720 };

const SLOT_LABEL: Record<Slot, string> = { l: "l 左", m: "m 中", r: "r 右" };

/** 一档滚轮/按钮的缩放步长（含 Shift 加速）。 */
const ZOOM_FAST = 0.25;

function defaultResolveUrl(key: string, kind: "background" | "character" = "background"): string {
  const value = String(key ?? "").trim();
  if (!value) return "";
  if (/^(https?:|data:|blob:|asset:|prts-cdn:)/i.test(value)) return value;
  if (kind === "character") {
    const encoded = value.split("/").map((part) => encodeURIComponent(part)).join("/");
    return `https://torappu.prts.wiki/assets/avg/characters/${encoded}.png`;
  }
  return `https://torappu.prts.wiki/assets/avg/background/${encodeURIComponent(value.toLowerCase())}.png`;
}

/**
 * 一个立绘的落点。**有角色表就用引擎公式重算**（`character.json` 的
 * `pos`/`size` + `slotBaseX`），没表才退回调用方给的 `rect`，再没有就画占位框。
 * 编辑器传进来的 `rect` 与我们算出来的必然一致；重算的价值在于：宿主没注入
 * 角色表时（`StagePane` 自己会拉一次），第一帧的兜底矩形不会固化成几何。
 */
function rectOf(
  char: StagePaneChar,
  table: CharacterTable | null,
  rules: BackgroundRules | null,
  background: string | null,
): { rect: Box; engine: Box; missing: boolean; image: string | null } {
  const given = char.rect && Number(char.rect.w) > 0
    ? { x: Number(char.rect.x) || 0, y: Number(char.rect.y) || 0, w: Number(char.rect.w), h: Number(char.rect.h) }
    : null;
  const resolvable = table ? resolveExpression(table, char.name) !== null : false;
  if (table && resolvable) {
    const computed = layoutOf(
      { characters: table, upstream: table, resolutionRules: rules ?? undefined },
      { chars: [{ ...char, rect: undefined, x: 0, y: 0 }], background, rules, viewport: { width: STAGE_WIDTH, height: STAGE_HEIGHT } },
    ).chars[0];
    if (computed) {
      const rect = { ...computed.engineRect, x: computed.engineRect.x + (char.x ?? 0), y: computed.engineRect.y + (char.y ?? 0) };
      return { rect, engine: computed.engineRect, missing: computed.missing, image: computed.image };
    }
  }
  if (given) {
    return {
      rect: { ...given, x: given.x + (char.x ?? 0), y: given.y + (char.y ?? 0) },
      engine: given,
      missing: Boolean(char.missing),
      image: char.image ?? null,
    };
  }
  return {
    rect: {
      x: STAGE_WIDTH / 2 - PLACEHOLDER_SIZE.w / 2 + (char.x ?? 0),
      y: STAGE_HEIGHT - PLACEHOLDER_SIZE.h / 2 + (char.y ?? 0),
      w: PLACEHOLDER_SIZE.w,
      h: PLACEHOLDER_SIZE.h,
    },
    engine: { x: 0, y: 0, w: PLACEHOLDER_SIZE.w, h: PLACEHOLDER_SIZE.h },
    missing: true,
    image: null,
  };
}

/**
 * 舞台预览窗格。`chars` 为空时画空舞台（栅格 + 槽位虚线 + 提示），不抛错。
 */
export function StagePane(props: StagePaneProps) {
  const {
    chars,
    background = null,
    height,
    onMove,
    onSelect,
    selected = null,
    resolveUrl,
    model,
    rules,
    offline,
    focusSlots,
    zoom,
    showGuides,
    line,
    onPatch,
    chrome,
    className,
  } = props;

  // 受控/非受控两用：`zoom`/`showGuides` prop 是**默认值**，窗格内的按钮/滚轮写 override。
  const [zoomOverride, setZoomOverride] = useState<ZoomView | null>(null);
  const [guidesOverride, setGuidesOverride] = useState<boolean | null>(null);
  const [foldedOverride, setFoldedOverride] = useState<boolean | null>(null);
  const [ghost, setGhost] = useState<{ slot: Slot; dx: number; dy: number; key: string } | null>(null);
  const [pending, setPending] = useState<MovePatch | null>(null);
  const [hint, setHint] = useState<string>("");
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const dragRef = useRef<{ slot: Slot; x: number; y: number; dx: number; dy: number; moved: boolean } | null>(null);
  const zoomState = clampZoom(zoomOverride?.zoom ?? zoom ?? DEFAULT_ZOOM);
  const guides = guidesOverride ?? showGuides ?? true;
  // chrome：受控（`chrome.visible`）优先；不受控时窗格自己记住折叠。
  const chromeVisible = chrome?.visible ?? !(foldedOverride ?? false);
  const toggleChrome = useCallback(() => {
    if (chrome?.onToggle) chrome.onToggle();
    else setFoldedOverride((value) => !(value ?? false));
  }, [chrome]);

  // 尺寸测量：拖拽的 CSS→画布换算全靠它。
  useLayoutEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setBox((prev) => (Math.abs(prev.w - rect.width) < 0.5 && Math.abs(prev.h - rect.height) < 0.5 ? prev : { w: rect.width, h: rect.height }));
    };
    update();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(update);
      observer.observe(node);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // `chars` 变了（父组件已把落点应用回去）→ 本地的拖拽残影自然失效。
  const charsKey = useMemo(
    () => chars.map((char) => `${char.slot ?? "m"}:${char.name}:${char.x ?? 0},${char.y ?? 0},${char.rect?.w ?? 0}`).join("|"),
    [chars],
  );
  const activeGhost = ghost && ghost.key === charsKey ? ghost : null;

  /**
   * 画布坐标 → viewBox。**缩放只改这里**（画布里的几何 px 一个都不动）：
   * `zoom = 1` 只露 1280×720；`zoom = 2` 收一半；滚轮缩放后原点由
   * `stageZoom.zoomAt` 按**锚点保值**给出（不一定居中）。
   */
  const view = useMemo<ZoomView>(() => {
    if (zoomOverride) return zoomOverride;
    return viewFor(zoomState, STAGE_CANVAS);
  }, [zoomOverride, zoomState]);

  // preserveAspectRatio="meet" → 1 画布 px = `1 / unit` CSS px（`stageZoom.cssScale` 的逆）。
  // 拖拽的 CSS→画布换算必须用**当前缩放**：`view.w / box.w` 已含 zoom。
  const unit = box.w > 0 && box.h > 0 ? 1 / cssScale(zoomState, box, STAGE_CANVAS) : view.w / STAGE_WIDTH;
  const unitRef = useRef(unit);
  useEffect(() => {
    unitRef.current = unit;
  }, [unit]);

  /** 把一次缩放操作的结果写进窗格（viewBox 原点 + zoom 一起）。 */
  const applyZoom = useCallback((result: { zoom: number; x: number; y: number }) => {
    const zoom = clampZoom(result.zoom);
    setZoomOverride({ x: result.x, y: result.y, w: STAGE_WIDTH / zoom, h: STAGE_HEIGHT / zoom, zoom });
  }, []);

  /** 缩放中心 = 当前视口中心（按钮/适配用；锚点保值退化为「中心不动」）。 */
  const zoomCenter = useCallback(
    (step: number) => {
      const point = { x: view.x + view.w / 2, y: view.y + view.h / 2 };
      applyZoom(zoomAt(zoomState, point, step, box, clampZoom, view));
    },
    [applyZoom, box, view, zoomState],
  );

  /** 回到 100%/100%（居中）。 */
  const zoomToDefault = useCallback(() => {
    setZoomOverride(viewFor(DEFAULT_ZOOM, STAGE_CANVAS));
  }, []);

  /** `适配`：把 1280×720 完整放进窗格（`fitZoom`，含 0.96 留白），居中。 */
  const zoomToFit = useCallback(() => {
    const next = fitZoom({ w: box.w, h: box.h }, { w: STAGE_WIDTH, h: STAGE_HEIGHT });
    setZoomOverride(viewFor(next, STAGE_CANVAS));
  }, [box]);

  // 滚轮：**原生监听 + `passive:false`**（React 的 onWheel 在 root 上是 passive，
  // `preventDefault()` 会被忽略、页面跟着滚）。以**指针**为锚连续缩放。
  useEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      const delta = wheelDelta(event.deltaY) * (event.shiftKey ? ZOOM_FAST / WHEEL_STEP : 1);
      if (!delta) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const css = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const size = { w: rect.width, h: rect.height };
      const point = anchorPoint(view.zoom, css, size, STAGE_CANVAS, view);
      applyZoom(zoomAt(view.zoom, point, delta, size, clampZoom, view));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [applyZoom, view]);

  // 角色表 / 背景规则：props 优先；props 没给（或给的是空表）就自己拉一次上游。
  const [fetched, setFetched] = useState<{ table: CharacterTable; rules: BackgroundRules } | null>(null);
  const propsTable = useMemo(() => {
    if (!model) return null;
    const fromModel = tableFromModel(model);
    return Object.keys(fromModel).length ? fromModel : null;
  }, [model]);
  const propsRules = useMemo(() => {
    const fromProps = rules ?? (model ? rulesFromModel(model) : {});
    return Object.keys(fromProps ?? {}).length ? (fromProps as BackgroundRules) : null;
  }, [model, rules]);

  useEffect(() => {
    if (propsTable || offline) return;
    let alive = true;
    void ensureCharacterTable().then((loaded) => {
      if (!alive || !loaded) return;
      setFetched((prev) => (prev?.table === loaded ? prev : { table: loaded, rules: prev?.rules ?? {} }));
    });
    return () => {
      alive = false;
    };
  }, [offline, propsTable]);

  useEffect(() => {
    if (propsRules || offline) return;
    let alive = true;
    void ensureBackgroundRules().then((loaded) => {
      if (!alive || !Object.keys(loaded).length) return;
      setFetched((prev) => (prev ? { ...prev, rules: loaded } : { table: {} as CharacterTable, rules: loaded }));
    });
    return () => {
      alive = false;
    };
  }, [offline, propsRules]);

  const table = propsTable ?? fetched?.table ?? null;
  const activeRules = propsRules ?? fetched?.rules ?? null;
  const backgroundKey = useMemo(() => {
    const record = background && typeof background === "object" ? background : null;
    const key = String((record ? record.key : background) ?? "").trim();
    return key || null;
  }, [background]);

  const items = useMemo(
    () =>
      chars.map((char, index) => {
        const slot: Slot = char.slot === "l" || char.slot === "r" ? char.slot : "m";
        const computed = rectOf(char, table, activeRules, backgroundKey);
        const dim = focusSlots ? (focusSlots.length > 0 && !focusSlots.includes(slot)) : Boolean(char.dimmed);
        const offset = activeGhost && activeGhost.slot === slot && selected === slot ? { x: activeGhost.dx, y: activeGhost.dy } : { x: 0, y: 0 };
        return {
          char,
          index,
          slot,
          dim,
          rect: { ...computed.rect, x: computed.rect.x + offset.x, y: computed.rect.y + offset.y },
          missing: computed.missing,
          image: computed.image,
        };
      }),
    [activeGhost, activeRules, backgroundKey, chars, focusSlots, selected, table],
  );

  /**
   * 背景 URL。三类输入：字符串键 / `{key,url}` / 空。
   * - 对象里已经带了 `url`（`parseStage` 的结果）→ 直接用，仅当它非空；
   * - 只有键 → 让 `resolveUrl`（应用里接 `prts-cdn://`）或直链兜底；
   * - 空键/空 URL → `null`：黑底，不渲染 `<image>`（避免 `src=""` 打空请求）。
   */
  const backgroundImage = useMemo(() => {
    const record = background && typeof background === "object" ? background : null;
    const key = String((record ? record.key : background) ?? "").trim();
    const given = record ? String(record.url ?? "").trim() : "";
    if (given) return { key: key || given, url: resolveUrl ? resolveUrl(given, "background") : given };
    if (!key) return null;
    const url = resolveUrl ? resolveUrl(key, "background") : defaultResolveUrl(key, "background");
    return String(url ?? "").trim() ? { key, url: String(url).trim() } : { key, url: null };
  }, [background, resolveUrl]);
  const backgroundUrl = backgroundImage?.url ?? null;

  const resolveCharUrl = useCallback(
    (char: StagePaneChar, image: string | null): string | null => {
      if (char.url) return resolveUrl ? resolveUrl(char.url, "character") : char.url;
      if (!image) return null;
      return resolveUrl ? resolveUrl(image, "character") : defaultResolveUrl(image, "character");
    },
    [resolveUrl],
  );

  const startDrag = (event: React.PointerEvent<SVGGElement>, slot: Slot) => {
    if (event.button !== 0) return;
    event.preventDefault();
    onSelect?.(slot);
    dragRef.current = { slot, x: event.clientX, y: event.clientY, dx: 0, dy: 0, moved: false };
    setGhost({ slot, dx: 0, dy: 0, key: charsKey });
  };

  const charsKeyRef = useRef(charsKey);
  useEffect(() => {
    charsKeyRef.current = charsKey;
  }, [charsKey]);

  // 拖拽的 window 监听：SVG 之外的指针也跟得住。
  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = (event.clientX - drag.x) * unitRef.current;
      const dy = (event.clientY - drag.y) * unitRef.current;
      drag.dx = dx;
      drag.dy = dy;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
      setGhost({ slot: drag.slot, dx, dy, key: charsKeyRef.current });
    };
    const onPointerUp = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      setGhost(null);
      if (!drag.moved) return; // 点选而已
      const dx = Math.round(drag.dx);
      const dy = Math.round(drag.dy);
      const patch = movePatch(drag.slot, dx, dy, { line: line ?? undefined });
      setPending(patch);
      onPatch?.(patch);
      onMove?.(drag.slot, { x: dx, y: dy });
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [line, onMove, onPatch]);

  const copyPatch = useCallback(async () => {
    const text = (pending?.line ?? pending?.slideLine ?? "").trim();
    if (!text) return;
    try {
      await navigator.clipboard?.writeText(text);
      setHint("已复制这一行");
    } catch {
      setHint("复制失败（浏览器不允许）—— 文本已选中");
    }
    if (typeof window !== "undefined") window.setTimeout(() => setHint(""), 1600);
  }, [pending]);

  const patchText = pending ? (pending.line ?? pending.slideLine) : "";
  const selectedChar = items.find((item) => item.slot === selected) ?? null;

  return (
    <div
      className={className}
      data-stage-pane="1"
      data-stage-zoom={zoomState}
      data-stage-chars={chars.length}
      data-stage-chrome-visible={chromeVisible ? "1" : "0"}
      style={{
        height: height ?? 232,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: 4,
        background: "#05070b",
        color: "#dbe4ef",
        font: "11px/1.4 ui-monospace, Menlo, Consolas, monospace",
        userSelect: "none",
      }}
    >
      {/* chrome（BRIEF §2.2）：`data-chrome="stage"` + `.sp-chrome` + 折叠 `.sp-fold`。
          可选 prop（`chrome`）缺失时这条也会渲染（只是没有 `▾` 回调）。 */}
      <div
        className={`sp-chrome${chrome?.active ? " is-active" : ""}`}
        data-chrome="stage"
        data-active={chrome?.active ? "1" : "0"}
        data-hidden={chromeVisible ? "0" : "1"}
        style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 18, padding: "0 2px" }}
        title={chrome?.ariaLabel ?? "舞台"}
        onPointerDown={() => chrome?.onSelect?.()}
      >
        <span className="sp-chrome-title" style={{ color: "#9fb3c8" }}>{chrome?.title ?? "舞台"}</span>
        {chrome?.active ? <span className="sp-chrome-dot" style={{ color: "#7a5cff" }}>●</span> : null}
        <span style={{ flex: "1 1 auto" }} />
        {chrome?.onToggle || chrome === undefined || foldedOverride !== null ? (
          <button
            type="button"
            className="sp-fold"
            onClick={toggleChrome}
            aria-expanded={chromeVisible}
            aria-label={chrome?.ariaLabel ? `${chromeVisible ? "收起" : "展开"}${chrome.ariaLabel}` : "收起"}
            style={buttonStyle(false)}
          >
            {chromeVisible ? "▾" : "▸"}
          </button>
        ) : null}
      </div>

      {/* 画布：16:9 letterbox（宽高由宿主决定，内容等比居中） */}
      <div
        ref={boxRef}
        data-stage-frame="1"
        style={{
          position: "relative",
          flex: "1 1 auto",
          minHeight: 0,
          borderRadius: 4,
          overflow: "hidden",
          background: "#000",
          display: chromeVisible ? undefined : "none",
        }}
      >
        <svg
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          preserveAspectRatio="xMidYMid meet"
          width="100%"
          height="100%"
          style={{ display: "block", touchAction: "none" }}
          data-stage-svg="1"
          data-stage-view={`${Math.round(view.x)},${Math.round(view.y)},${Math.round(view.w)},${Math.round(view.h)}`}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              setPending(null);
              onSelect?.(null);
            }
          }}
        >
          <defs>
            <pattern id="ark-stage-grid" width="80" height="80" patternUnits="userSpaceOnUse">
              <path d="M80 0H0V80" fill="none" stroke="#1d2836" strokeWidth="1" />
            </pattern>
          </defs>

          {/* 画布底 + 背景 */}
          <rect x={0} y={0} width={STAGE_WIDTH} height={STAGE_HEIGHT} fill="#0a0f16" />
          {backgroundUrl ? (
            <image
              href={backgroundUrl}
              x={0}
              y={0}
              width={STAGE_WIDTH}
              height={STAGE_HEIGHT}
              preserveAspectRatio="xMidYMid slice"
              style={{ opacity: 0.92 }}
              data-stage-background={backgroundImage?.key ?? ""}
            />
          ) : null}
          {guides ? <rect x={0} y={0} width={STAGE_WIDTH} height={STAGE_HEIGHT} fill="url(#ark-stage-grid)" style={{ opacity: 0.55 }} /> : null}

          {/* 安全框 + 1280×720 边框 */}
          <rect
            x={SAFE_ACTION.x}
            y={SAFE_ACTION.y}
            width={STAGE_WIDTH - SAFE_ACTION.x * 2}
            height={STAGE_HEIGHT - SAFE_ACTION.y * 2}
            fill="none"
            stroke="#2b6cb0"
            strokeWidth="1"
            strokeDasharray="6 6"
            style={{ opacity: 0.6 }}
            data-stage-safe="action"
          />
          <rect
            x={SAFE_TITLE.x}
            y={SAFE_TITLE.y}
            width={STAGE_WIDTH - SAFE_TITLE.x * 2}
            height={STAGE_HEIGHT - SAFE_TITLE.y * 2}
            fill="none"
            stroke="#2b6cb0"
            strokeWidth="1"
            strokeDasharray="3 9"
            style={{ opacity: 0.45 }}
            data-stage-safe="title"
          />
          <rect x={0} y={0} width={STAGE_WIDTH} height={STAGE_HEIGHT} fill="none" stroke="#3d4b5c" strokeWidth="1" />

          {/* 槽位虚线（l/m/r = 440/640/840，引擎 slotBaseX） */}
          {guides
            ? ([
                { slot: "l" as Slot, x: 440 },
                { slot: "m" as Slot, x: 640 },
                { slot: "r" as Slot, x: 840 },
              ]).map(({ slot, x }) => (
                <g key={slot} data-stage-guide={slot}>
                  <line x1={x} y1={0} x2={x} y2={STAGE_HEIGHT} stroke="#7a5cff" strokeWidth="1" strokeDasharray="10 8" style={{ opacity: 0.45 }} />
                  <text x={x + 6} y={18} fill="#b9a8ff" fontSize="16" style={{ opacity: 0.8 }}>
                    {SLOT_LABEL[slot]}
                  </text>
                </g>
              ))
            : null}

          {/* 标尺：顶部横向刻度（每 80px 一格小刻度、每 160px 数字） */}
          <g data-stage-ruler="1" style={{ opacity: 0.75 }}>
            {Array.from({ length: Math.floor(view.w / 80) + 1 }, (_, index) => {
              const mod = Math.round(view.x / 80) * 80 + index * 80;
              if (mod < view.x || mod > view.x + view.w) return null;
              const major = mod % 160 === 0;
              return (
                <g key={`x${mod}`}>
                  <line x1={mod} y1={view.y} x2={mod} y2={view.y + (major ? 12 : 6)} stroke="#6b7b8d" strokeWidth="1" />
                  {major ? (
                    <text x={mod + 3} y={view.y + 26} fill="#8fa1b5" fontSize="14">
                      {mod}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {Array.from({ length: Math.floor(view.h / 80) + 1 }, (_, index) => {
              const mod = Math.round(view.y / 80) * 80 + index * 80;
              if (mod < view.y || mod > view.y + view.h) return null;
              const major = mod % 160 === 0;
              return (
                <g key={`y${mod}`}>
                  <line x1={view.x} y1={mod} x2={view.x + (major ? 12 : 6)} y2={mod} stroke="#6b7b8d" strokeWidth="1" />
                  {major ? (
                    <text x={view.x + 14} y={mod - 3} fill="#8fa1b5" fontSize="14">
                      {mod}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>

          {/* 立绘 */}
          {items.map(({ char, slot, rect, dim, missing, image }) => {
            const url = resolveCharUrl(char, image);
            const isSelected = selected === slot;
            const alpha = dim ? 0.45 : 1;
            return (
              <g
                key={`${slot}-${char.name}-${rect.x}`}
                data-stage-char={slot}
                data-stage-missing={missing ? "1" : "0"}
                style={{ cursor: "grab", opacity: alpha }}
                onPointerDown={(event) => startDrag(event, slot)}
              >
                {url ? <image href={url} x={rect.x} y={rect.y} width={rect.w} height={rect.h} preserveAspectRatio="none" /> : null}
                {missing || !url ? (
                  <>
                    <rect
                      x={rect.x}
                      y={rect.y}
                      width={rect.w}
                      height={rect.h}
                      fill="rgba(255, 96, 96, 0.08)"
                      stroke="#ff6b6b"
                      strokeWidth="2"
                      strokeDasharray="14 10"
                    />
                    <text x={rect.x + 16} y={rect.y + 34} fill="#ffb3b3" fontSize="26">
                      {char.name || "（空）"}
                    </text>
                    <text x={rect.x + 16} y={rect.y + 66} fill="#ff9b9b" fontSize="18">
                      未知角色（引擎会 warn missing_asset 并清槽）
                    </text>
                  </>
                ) : null}
                {isSelected ? (
                  <rect
                    x={rect.x - 4}
                    y={rect.y - 4}
                    width={rect.w + 8}
                    height={rect.h + 8}
                    fill="none"
                    stroke="#f4c430"
                    strokeWidth="3"
                    strokeDasharray="18 10"
                    data-stage-selected="1"
                  />
                ) : null}
                <text x={rect.x + 8} y={rect.y - 12} fill={isSelected ? "#f4c430" : "#9fb3c8"} fontSize="20" data-stage-char-label={slot}>
                  {slot} · {char.name}
                  {char.label ? ` · ${char.label}` : ""}
                </text>
              </g>
            );
          })}

          {items.length === 0 ? (
            <text x={STAGE_WIDTH / 2} y={STAGE_HEIGHT / 2} fill="#6b7b8d" fontSize="30" textAnchor="middle" data-stage-empty="1">
              舞台为空（演到这一行还没有立绘）
            </text>
          ) : null}
        </svg>

        {/* HUD：缩放工具条（连续缩放：`−` / 百分比 → 100% / `＋` / `适配` / `1:1`）。
            既有 `data-stage-action="zoom-1"`（harness 回归用）保留在 1:1 上；
            `zoom-05` 保留为「50% 一档」（`stage-check.mjs` 的旧断言仍绿）。 */}
        <div data-stage-hud="zoom" style={{ position: "absolute", top: 4, right: 4, display: "flex", gap: 4, alignItems: "center" }}>
          <button
            type="button"
            data-stage-action="zoom-out"
            onClick={() => zoomCenter(-WHEEL_STEP)}
            disabled={zoomState <= MIN_ZOOM + 1e-9}
            style={buttonStyle(false)}
            title="缩小 10%（以视口中心为锚）"
          >
            −
          </button>
          <button
            type="button"
            data-stage-action="zoom-reset"
            onClick={zoomToDefault}
            style={buttonStyle(zoomState === DEFAULT_ZOOM)}
            title="回到 100%（点击百分比）"
          >
            {zoomPercent(zoomState)}
          </button>
          <button
            type="button"
            data-stage-action="zoom-in"
            onClick={() => zoomCenter(WHEEL_STEP)}
            disabled={zoomState >= MAX_ZOOM - 1e-9}
            style={buttonStyle(false)}
            title="放大 10%（以视口中心为锚）"
          >
            ＋
          </button>
          <button type="button" data-stage-action="fit" onClick={zoomToFit} style={buttonStyle(false)} title="适配窗格（fitZoom，含留白）">
            适配
          </button>
          <button type="button" data-stage-action="zoom-1" onClick={zoomToDefault} style={buttonStyle(zoomState === DEFAULT_ZOOM)} title="1:1（铺满窗格，只看 1280×720）">
            1:1
          </button>
          <button
            type="button"
            data-stage-action="zoom-05"
            onClick={() => applyZoom(zoomAt(zoomState, { x: view.x + view.w / 2, y: view.y + view.h / 2 }, 0.5 - zoomState, box, clampZoom, view))}
            style={buttonStyle(Math.abs(zoomState - 0.5) < 1e-9)}
            title="50%（看全 1.25× 边距）"
          >
            50%
          </button>
          <button type="button" data-stage-action="guides" onClick={() => setGuidesOverride((value) => !(value ?? guides))} style={buttonStyle(guides)} title="栅格 + 槽位虚线 + 安全框">
            参考线
          </button>
        </div>

        {/* HUD：实时增量 / 补丁 */}
        {activeGhost && Math.abs(activeGhost.dx) + Math.abs(activeGhost.dy) > 1 ? (
          <div data-stage-delta="1" style={{ position: "absolute", left: 6, bottom: 6, padding: "2px 6px", background: "rgba(0,0,0,0.72)", border: "1px solid #f4c430", borderRadius: 3, color: "#f4c430" }}>
            {activeGhost.slot} Δ {Math.round(activeGhost.dx) >= 0 ? "+" : ""}{Math.round(activeGhost.dx)}, {Math.round(activeGhost.dy) >= 0 ? "+" : ""}{Math.round(activeGhost.dy)} px
          </div>
        ) : null}
      </div>

      {/* 状态条 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 20, whiteSpace: "nowrap", overflow: "hidden" }}>
        <span data-stage-status="zoom" title="缩放百分比 · 窗格 CSS 尺寸" style={{ cursor: "pointer" }} onClick={zoomToDefault}>
          {zoomPercent(zoomState)} · {box.w > 0 ? `${Math.round(box.w)}×${Math.round(box.h)}` : "—"}
        </span>
        <span data-stage-status="slot" style={{ color: "#f4c430" }}>
          {selectedChar ? `选中 ${selectedChar.slot}：${selectedChar.char.name}` : "未选中"}
        </span>
        <code
          data-stage-patch="1"
          title={patchText}
          style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", color: pending ? "#9fe0a0" : "#6b7b8d" }}
        >
          {pending ? patchText : "拖动立绘 → 这里给出引擎认的补丁"}
        </code>
        <button type="button" data-stage-action="copy" onClick={() => void copyPatch()} disabled={!pending} style={buttonStyle(Boolean(pending))} title="把补丁整行复制到剪贴板">
          复制这一行
        </button>
        {hint ? <span style={{ color: "#9fe0a0" }}>{hint}</span> : null}
      </div>
    </div>
  );
}

function buttonStyle(active: boolean): React.CSSProperties {
  return {
    padding: "1px 6px",
    background: active ? "rgba(122, 92, 255, 0.35)" : "rgba(0,0,0,0.55)",
    color: active ? "#e7e0ff" : "#9fb3c8",
    border: `1px solid ${active ? "#7a5cff" : "#3d4b5c"}`,
    borderRadius: 3,
    font: "inherit",
    cursor: "pointer",
  };
}

export default StagePane;
