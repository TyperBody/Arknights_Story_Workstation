/**
 * `stageZoom.ts` —— 舞台**连续缩放**的纯数学（BRIEF §2.5）。
 *
 * 用户原话：「舞台缩放不正常阿 只有100%与50%」→ 这里给出 0.25…2.0 的连续档位；
 * `StagePane` 只 `import` 本模块，把结果写进 `<svg viewBox>`（**只改视口，几何
 * 一个像素都不动**）。
 *
 * ## 坐标与变换（与 `preserveAspectRatio="xMidYMid meet"` 严格一致）
 *
 * - `canvas` = 1280×720 的**画布坐标**（引擎逻辑坐标，恒定）；
 * - `box` = SVG 宿主的 CSS 尺寸（`getBoundingClientRect()`）；
 * - `view` = viewBox 原点/尺寸（画布坐标同域）：`zoom = 1` 时正好是画布本身，
 *   `zoom` 越大视口越小（放大）；`zoom = 0.5` 时每边多出 25%（1.25× 边距）。
 * - 画布 → CSS：`css(p) = 原点 + (p - view) × baseUnit × zoom`，
 *   其中 `baseUnit = min(bw / 1280, bh / 720)`（`meet` 语义），
 *   `原点 = ((bw - 1280×baseUnit)/2, (bh - 720×baseUnit)/2)`（居中 letterbox）。
 *   `zoomAt` 返回的 `view` 就是这里的 `view`。
 *
 * ## 锚点保值（harness 断言的那条）
 *
 * 指针压住的**画布坐标** `point` 在缩放前后落在同一个 CSS 像素：
 *
 * ```
 * css 固定 ⇒ (point - view) × zoom 固定 ⇒ view' = point - (point - view) × (zoom/zoom')
 * ```
 *
 * `baseUnit` 与居中原点在缩放前后**不变**（zoom 只进 `view` 的尺寸），所以这条
 * 等价关系在 CSS 空间里同样成立（`stagePointToCss` 可直接对拍）。
 *
 * 本文件**纯函数、零依赖、无 DOM、无 enum/namespace** —— Node 22 的类型剥离
 * （`node --experimental-strip-types`，22.18+ 默认）可直接 `import` 同一份实现：
 * `build/harness/stage-zoom.mjs` 与 `scripts/fanfic/stageZoom-selftest.mjs`
 * 都跑它（不是抄一份数学）。
 */

/** 最小缩放：25%。 */
export const MIN_ZOOM = 0.25;
/** 最大缩放：200%。 */
export const MAX_ZOOM = 2;
/** 默认缩放：100%（只看 1280×720 画布）。 */
export const DEFAULT_ZOOM = 1;
/** 一格滚轮 / 一次按钮的步长。 */
export const WHEEL_STEP = 0.1;
/** 「适配」档的留白系数（`fitZoom` 结果再 ×0.96，避免贴边）。 */
export const FIT_PADDING = 0.96;

/** 画布坐标上的一个点（`dx`/`dy` 增量同域）。 */
export interface ZoomPoint {
  x: number;
  y: number;
}

/** 宿主尺寸（CSS px）。 */
export interface ZoomBox {
  w: number;
  h: number;
}

/** 一个 viewBox（画布坐标同域；`zoom` 冗余带上，方便直接驱动渲染）。 */
export interface ZoomView extends ZoomBox {
  /** viewBox 原点 x（画布坐标）。 */
  x: number;
  /** viewBox 原点 y（画布坐标）。 */
  y: number;
  /** 与 `w`/`h` 对应的缩放（`w = canvas.w / zoom`）。 */
  zoom: number;
}

/** 画布矩形（1280×720；`fitZoom` 的 `box` 参数）。 */
export interface ZoomCanvas {
  w: number;
  h: number;
}

/** `zoomAt` 的产物：新 `zoom` + 保值后的 viewBox 原点。 */
export type ZoomAtResult = { zoom: number; x: number; y: number };

/** §2.5 的固定画布；参数缺省时用它。 */
export const STAGE_CANVAS: ZoomCanvas = { w: 1280, h: 720 };

const isPositive = (value: number): boolean => Number.isFinite(value) && value > 0;
const toZoom = (value: number): number => {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_ZOOM;
  return number;
};
/** 缩放值量化到 1e-4：滚轮连点不积累浮点误差（1+0.1×7 = 1.7000000000000002）。 */
export const quantizeZoom = (value: number): number => Math.round(toZoom(value) * 1e4) / 1e4;
const quantize = quantizeZoom;
/** 四位小数（去掉尾零）的字符串；非有限值兜 `0`。 */
const num = (value: number): string => (Number.isFinite(value) ? String(Math.round(value * 1e4) / 1e4) : "0");

/** 把数值收进 `[MIN_ZOOM, MAX_ZOOM]`；`NaN`/非有限 → `DEFAULT_ZOOM`。 */
export function clampZoom(value: number): number {
  const number = toZoom(value);
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, number));
}

/** 百分比文案（状态条 / 工具条）：`1.37 → "137%"`；`NaN → "100%"`。 */
export function zoomPercent(value: number): string {
  return `${Math.round(clampZoom(value) * 100)}%`;
}

/**
 * 「适配」：`min(viewport.w/box.w, viewport.h/box.h)`（两维取小 = `meet`），
 * 乘 `FIT_PADDING` 留白，最后 `clampZoom`。任一侧非法（0/NaN）→ `DEFAULT_ZOOM`。
 */
export function fitZoom(
  viewport: ZoomBox | null | undefined,
  box: ZoomCanvas | ZoomBox | null | undefined,
): number {
  const vw = Number(viewport?.w);
  const vh = Number(viewport?.h);
  const bw = Number(box?.w);
  const bh = Number(box?.h);
  if (!isPositive(vw) || !isPositive(vh) || !isPositive(bw) || !isPositive(bh)) return DEFAULT_ZOOM;
  return clampZoom(Math.min(vw / bw, vh / bh) * FIT_PADDING);
}

/**
 * 1 画布 px = 多少 CSS px 的**基准值**：`min(bw / canvas.w, bh / canvas.h)`
 * （`meet`：画布恒完整可见，短边贴合）。宿主尺寸非法 → `0`。
 */
export function baseUnit(box: ZoomBox | null | undefined, canvas: ZoomCanvas = STAGE_CANVAS): number {
  const bw = Number(box?.w);
  const bh = Number(box?.h);
  const cw = Number(canvas?.w);
  const ch = Number(canvas?.h);
  if (!isPositive(bw) || !isPositive(bh) || !isPositive(cw) || !isPositive(ch)) return 0;
  return Math.min(bw / cw, bh / ch);
}

/**
 * 1 画布 px 在当前 `zoom` 下 = 多少 CSS px。
 * （`zoom = 1` 时等于 `baseUnit`；宿主非法 → `clampZoom(zoom)`，让调用方
 * 仍能得到随缩放单调的数值。）
 */
export function cssScale(
  zoom: number,
  box: ZoomBox | null | undefined,
  canvas: ZoomCanvas = STAGE_CANVAS,
): number {
  const unit = baseUnit(box, canvas);
  const z = clampZoom(zoom);
  return unit > 0 ? unit * z : z;
}

/**
 * 一个 viewBox：`zoom` = 1 → 正好 1280×720；`zoom` = 0.5 → 每边多 25%。
 * 缩放**只**从这里出去 —— 画布里的 `<image x y width height>` 不动。
 */
export function viewFor(zoom: number, canvas: ZoomCanvas = STAGE_CANVAS): ZoomView {
  const z = clampZoom(zoom);
  const w = canvas.w / z;
  const h = canvas.h / z;
  // `(cw − w) / 2`（不是 `−(w − cw) / 2`）：zoom = 1 时严格 0，不留 `-0`。
  return { x: (canvas.w - w) / 2, y: (canvas.h - h) / 2, w, h, zoom: z };
}

/** `viewFor` 的 `<svg viewBox>` 字符串形态。 */
export function viewBoxOf(zoom: number, canvas: ZoomCanvas = STAGE_CANVAS): string {
  const view = viewFor(zoom, canvas);
  return `${num(view.x)} ${num(view.y)} ${num(view.w)} ${num(view.h)}`;
}

/**
 * 滚轮/按钮缩放的**核心**：把 `delta` 加到 `zoom` 上，给出保值后的 viewBox
 * 原点。`point` 是**画布坐标**上指针（缩放中心）的位置。
 *
 * 不变式（锚点在缩放前后落在同一 CSS 像素）：
 *
 * ```
 * css(p) = pad + (p − view) × unit × zoom = 常数
 * ⇒ view′ = p − (p − view) × (zoom / zoom′)
 * ```
 *
 * `from`（可选）= **当前** viewBox 原点；缺省 `viewFor(zoom)`（居中）。
 * 调用方（`StagePane` 的滚轮）必须把上一次的返回值当 `from` 传回来，缩放才
 * 「跟手」；不传则每一档都以居中视口为基准（按钮/`适配` 用这个默认）。
 */
export function zoomAt(
  zoom: number,
  point: ZoomPoint,
  delta: number,
  box: ZoomBox = STAGE_CANVAS,
  clamp: (value: number) => number = clampZoom,
  from?: ZoomPoint | ZoomView | null,
): ZoomAtResult {
  const current = clampZoom(zoom);
  const asked = quantize(current + (Number.isFinite(Number(delta)) ? Number(delta) : 0));
  const clamped = Number(clamp(asked));
  const next = clampZoom(Number.isFinite(clamped) ? clamped : DEFAULT_ZOOM);
  const currentView = originOf(from, current);
  const nextView = viewFor(next);
  // `view.w = canvas.w / zoom`，而 `1 画布 px = baseUnit × zoom` CSS px ——
  // 两者互为倒数 ⇒ 「按 view 尺寸比例」与「按 CSS 比例」是同一个数：
  // 宿主尺寸（`box`）只决定像素大小，不影响保值；`box` 退化(0×0)时同样有限。
  const k = next > 0 ? current / next : 1;
  const px = Number.isFinite(Number(point?.x)) ? Number(point.x) : 0;
  const py = Number.isFinite(Number(point?.y)) ? Number(point.y) : 0;
  // 宿主 0×0（尚未测量 / 被隐藏）时 CSS 空间退化：给「居中视口」这个确定的解。
  const degenerate = !(cssScale(current, box) > 0 && cssScale(next, box) > 0);
  const x = degenerate ? nextView.x : px - (px - currentView.x) * k;
  const y = degenerate ? nextView.y : py - (py - currentView.y) * k;
  return {
    zoom: next,
    // 量化到 1e-4：`1.3 − 0.3×1.3` 之类的抖动在 1e-15 量级，几何对拍才稳。
    x: Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : nextView.x,
    y: Number.isFinite(y) ? Math.round(y * 1e4) / 1e4 : nextView.y,
  };
}

/** `from` → 一个可用的 viewBox 原点（缺省居中；`NaN` 也兜底）。 */
export function originOf(from: ZoomPoint | ZoomView | null | undefined, zoom: number): ZoomPoint {
  const view = viewFor(zoom);
  const x = Number(from?.x);
  const y = Number(from?.y);
  return {
    x: Number.isFinite(x) ? x : view.x,
    y: Number.isFinite(y) ? y : view.y,
  };
}

/**
 * 缩放锚点：宿主 **CSS px** → 画布坐标（`view` = 当前 viewBox 原点，缺省居中）。
 * 滚轮的 `event.clientX/Y` 减宿主 `getBoundingClientRect()` 之后喂进来。
 */
export function anchorPoint(
  zoom: number,
  css: ZoomPoint,
  box: ZoomBox,
  canvas: ZoomCanvas = STAGE_CANVAS,
  view?: ZoomPoint | null,
): ZoomPoint {
  const origin = originOf(view, zoom);
  const unit = cssScale(zoom, box, canvas);
  const boxUnit = baseUnit(box, canvas);
  const padX = (Number(box?.w) - canvas.w * boxUnit) / 2;
  const padY = (Number(box?.h) - canvas.h * boxUnit) / 2;
  const scale = unit > 0 ? unit : 1;
  const x = (Number(css?.x) - (Number.isFinite(padX) ? padX : 0)) / scale + origin.x;
  const y = (Number(css?.y) - (Number.isFinite(padY) ? padY : 0)) / scale + origin.y;
  return { x: Number.isFinite(x) ? x : origin.x, y: Number.isFinite(y) ? y : origin.y };
}

/** 滚轮 `deltaY` → 缩放增量：向上（`deltaY < 0`）放大、一格 `WHEEL_STEP`。 */
export function wheelDelta(deltaY: number): number {
  const value = Number(deltaY);
  if (!Number.isFinite(value) || value === 0) return 0;
  return value < 0 ? WHEEL_STEP : -WHEEL_STEP;
}

/**
 * 画布 `view` 原点占位下，画布点 `point` 落在宿主里的哪个 CSS 像素。
 * 也就是 `preserveAspectRatio="xMidYMid meet"` 的真实映射（含居中 letterbox）。
 */
export function stagePointToCss(
  zoom: number,
  view: ZoomPoint,
  point: ZoomPoint,
  box: ZoomBox,
  canvas: ZoomCanvas = STAGE_CANVAS,
): ZoomPoint {
  const unit = cssScale(zoom, box, canvas);
  const originX = (Number(box?.w) - canvas.w * baseUnit(box, canvas)) / 2;
  const originY = (Number(box?.h) - canvas.h * baseUnit(box, canvas)) / 2;
  const vx = Number.isFinite(Number(view?.x)) ? Number(view.x) : viewFor(zoom, canvas).x;
  const vy = Number.isFinite(Number(view?.y)) ? Number(view.y) : viewFor(zoom, canvas).y;
  return {
    x: (Number.isFinite(originX) ? originX : 0) + (Number(point?.x) - vx) * unit,
    y: (Number.isFinite(originY) ? originY : 0) + (Number(point?.y) - vy) * unit,
  };
}

/** 默认视口（`viewFor(zoom)`，画布居中）下画布点 → CSS px。 */
export function canvasToCss(
  zoom: number,
  point: ZoomPoint,
  box: ZoomBox,
  canvas: ZoomCanvas = STAGE_CANVAS,
): ZoomPoint {
  const view = viewFor(zoom, canvas);
  return stagePointToCss(zoom, view, point, box, canvas);
}

/** `canvasToCss` 的逆：宿主 CSS px → 画布坐标（`viewFor(zoom)` 居中视口）。 */
export function cssToCanvas(
  zoom: number,
  css: ZoomPoint,
  box: ZoomBox,
  canvas: ZoomCanvas = STAGE_CANVAS,
): ZoomPoint {
  const view = viewFor(zoom, canvas);
  const unit = cssScale(zoom, box, canvas);
  const originX = (Number(box?.w) - canvas.w * baseUnit(box, canvas)) / 2;
  const originY = (Number(box?.h) - canvas.h * baseUnit(box, canvas)) / 2;
  const scale = unit > 0 ? unit : 1;
  return {
    x: (Number(css?.x) - (Number.isFinite(originX) ? originX : 0)) / scale + view.x,
    y: (Number(css?.y) - (Number.isFinite(originY) ? originY : 0)) / scale + view.y,
  };
}

/** 「点百分比回 100%」的显式入口（语义化，避免调用方散落魔法数）。 */
export function resetZoom(): number {
  return DEFAULT_ZOOM;
}

/** 把 `zoom` 收进合法区间（`clampZoom` 的别名，便于语义化调用）。 */
export function zoomIn(zoom: number, step: number = WHEEL_STEP): number {
  return clampZoom(quantize(zoom + Math.abs(step)));
}

/** 缩小一格。 */
export function zoomOut(zoom: number, step: number = WHEEL_STEP): number {
  return clampZoom(quantize(zoom - Math.abs(step)));
}
