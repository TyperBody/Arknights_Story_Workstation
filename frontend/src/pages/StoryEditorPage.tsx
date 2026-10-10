import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import InspectorWindow, { type WindowState } from "../components/editor/InspectorWindow";
import { clampWindowState, readWindowState } from "../components/editor/windowState";
import { createHistory, diffOf, type HistoryEntry } from "../components/editor/history";
import { disposeEngineFrame } from "../lib/storyPlayerBoot";
// engineBoot / localStories 在别处已是**静态**依赖（predownload.ts 等），页面这里
// 改成静态 import 后，Rollup 的 "INEFFECTIVE_DYNAMIC_IMPORT"（同一模块既静态
// 又动态）就消失了；两者本来就在主 chunk 里，不会变大。
import { bootEngineInFrame } from "../lib/engineBoot";
// `invoke` 也用静态 import：`@tauri-apps/api/core` 在本应用里到处静态引入（例如
// FanficLibraryPage），纯 Vite 下不会炸；静态化后 "INEFFECTIVE_DYNAMIC_IMPORT" 归零。
import { invoke as tauriCoreInvoke } from "@tauri-apps/api/core";
import { listLocalStories } from "../lib/localStories";
// `src/akstage/local/library.js` 由 `localStories.ts` 静态引入；页面直接静态用，
// 同样消除 "INEFFECTIVE_DYNAMIC_IMPORT"。
import { buildPackBundle, localPacks, localUpstream, stripControls } from "../../../src/akstage/local/library.js";
import { loadStoryRuntime } from "../lib/predownload";
import { pushLog } from "../lib/debugLog";

/**
 * 剧本编辑器（`/editor/:packId`）。
 *
 * 借鉴 YayinStoryStudio `MainEditor` 的体验（关键词驱动编辑 + 右侧工具控件 +
 * 状态栏）：左边是带行号 / 当前行高亮 / Tab 补全 / 光标补全的等宽编辑区，
 * 右边是三个工具页签「诊断 / 控制器 / 剧本信息」，下面是状态栏与可拖拽的
 * 「预览」演出面板。
 *
 * 数据通路：
 * - 文本 / pack.json：Rust `read_library_file` / `write_library_file`
 *   （`<资源目录>/assets/library/<id>/<name>`；写是 `.tmp` + rename 的原子替换）。
 * - 解析 / 校验 / 补全 / 悬停：`src/akstage/local/editorModel.js`（与离线工具
 *   共用的纯 ESM 模型；动态 import，浏览器里跑 Vite 也能加载）。
 * - 预览：`loadStoryRuntime(id)` + `bootEngineInFrame({mode:"play"})`，直接渲染
 *   当前**缓冲区**里的文本（不需要先保存）。
 *
 * 纯 Vite（没有 Tauri）下退化成**只读演示**：剧本/元信息从 `/__local-library.json`
 * 探针或 URL 查询参数（`?text=&pack=`）读取，保存按钮提示「需在桌面应用内」。
 */

// ─── 编辑器模型的类型契约（editorModel.js 的 JSDoc 类型在动态 import 后丢失）──

interface ValueMeta {
  name: string;
  type?: string;
  hint?: string;
  enums?: string[];
  default?: unknown;
}

interface ControllerMeta {
  command: string;
  canonical?: string;
  category?: string;
  tier?: string;
  required?: ValueMeta[];
  optional?: ValueMeta[];
  summary?: string;
  example?: string;
  /** `editcore` 的整行形式（`[Character(...)]`）以及它的呈现字段。 */
  detailZh?: string;
  paramsText?: string;
  level?: string;
  /** 降级表里合成出来的条目（不走 model.formatLine）。 */
  synthetic?: boolean;
}

interface ModelDiagnostic {
  code: number | string;
  name?: string;
  severity: "error" | "warning";
  message: string;
  line: number;
  from?: number;
  to?: number;
  /** 可选：修法提示（`editcore` 的 `fix` 字段）。 */
  fix?: string;
}

interface ModelDoc {
  diagnostics?: ModelDiagnostic[];
  stats?: { controllers?: Record<string, number>; decisions?: number; combos?: number; lines?: number };
  merge?: ModelDiagnostic[];
  missing?: Array<{ line?: number; message: string; kind?: string }>;
}

interface Completion {
  label: unknown;
  /** 字符串：仅替换前缀的派生文本；React 节点用于带注解的列表展示。 */
  insertText?: unknown;
  display?: unknown;
  detail?: unknown;
  detailZh?: unknown;
  conclusion?: unknown;
  kind?: string;
  /** 原样返回的「整行」形式（模型给的 `insertTextFull` / `insertText`）。 */
  full?: unknown;
  /** 编辑器模型保留的整行插入字段。 */
  insertTextFull?: unknown;
}

/** 从 Completion 取整行骨架（`formatLine` 的替代）。 */
function completionLine(item: Completion): string {
  const pickup = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of ["text", "line", "insert", "label", "command"]) {
        if (typeof record[key] === "string") return record[key] as string;
      }
    }
    return "";
  };
  const raw = (pickup(item.full) || pickup(item.insertText) || pickup(item.label)).trim();
  if (raw.startsWith("[")) return raw;
  // `name=""` 这类参数级补全只用于文本替换，行级插入时原样返回。
  return `[${raw.endsWith("]") ? raw : `${raw}]`}`;
}

/** 左侧行号的 tooltip：该行的原文（太长就截断）。 */
function lineLabel(text: string, line: number): string {
  const raw = text.split("\n")[line - 1] ?? "";
  const trimmed = raw.trim();
  if (!trimmed) return `${line}: （空行）`;
  return `${line}: ${trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed}`;
}

/**
 * 纯 Vite（无 Tauri）时的本地包来源：`localStories.ts` 的探针通道
 * （`/__local-library.json`、vite-local-library 中间件）注册到
 * `src/akstage/local/library.js` 的 `localhost source`；这里调一次
 * `listLocalStories()` 触发注册（会顺带清缓存），之后 `localPacks()` 才有数据。
 */
let browserSourceReady: Promise<void> | null = null;
function ensureBrowserPackSource(): Promise<void> {
  if (!browserSourceReady) {
    browserSourceReady = Promise.resolve()
      .then(() => listLocalStories())
      .then(() => undefined)
      .catch((error) => {
        browserSourceReady = null; // 允许下一次重试
        pushLog("warn", "[editor] 浏览器本地包来源注册失败：", error);
      });
  }
  return browserSourceReady;
}

/** 模型加载用：优先静态别名（vite.config 的 `@editor-model`），失败再回退相对路径。 */
function loadModelModule(): Promise<Record<string, unknown>> {
  return import("@editor-model")
    .catch(() => import("../../../src/akstage/local/editorModel.js"))
    .then((mod) => mod as unknown as Record<string, unknown>);
}

/**
 * 归一化模型返回的补全项：`editcore` 的 `label` 可能是 enrich 过的展示文本，
 * 参数才是 `{name,type,hint,...}` 对象；`insertText`/`insertTextFull` 可能是
 * 「带 `[` 的整段」或「`[` 之后的片段」。统一成页面用的形状。
 */
function normalizeCompletion(raw: Completion): Completion {
  const pick = (value: unknown, keys: string[]): string => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of keys) {
        if (typeof record[key] === "string") return record[key] as string;
      }
    }
    return "";
  };
  const source =
    pick(raw.full, ["text", "line", "insert"]) ||
    pick(raw.insertTextFull, ["text", "line", "insert"]) ||
    pick(raw.insertText, ["text", "line", "insert"]) ||
    pick(raw.label, ["label", "text", "description", "detail", "command", "canonical", "name"]);
  let insert = source.startsWith("[") ? source.slice(1) : source;
  const wordish = /^[A-Za-z_]\w*\]?$/.test(insert);
  const isController = (raw.kind ?? "") === "controller" || wordish || /^[A-Za-z_]\w*\s*[(]/.test(insert);
  if (isController && wordish && !insert.endsWith("]")) insert = `${insert}]`;
  const displayText =
    pick(raw.display, ["text", "label", "title"]) ||
    pick(raw.label, ["title", "text", "label", "command", "description"]);
  const detail =
    pick(raw.conclusion, ["text", "zh", "summary", "message", "description"]) ||
    pick(raw.detailZh, ["text", "zh", "summary", "message", "description"]) ||
    pick(raw.detail, ["text", "zh", "description", "summary", "message"]) ||
    detailFallback(raw.label);
  return {
    label: displayText || source,
    display: displayText || source,
    detail,
    kind: isController ? "controller" : raw.kind ?? "text",
    insertText: insert,
    full: source,
  };
}

/** 兜底说明文案：`label` 若是参数 meta（`{name,hint,…}`）就拼一句人话。 */
function detailFallback(label: unknown): string | undefined {
  if (!label || typeof label !== "object") return undefined;
  const record = label as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : "";
  const hint = typeof record.hint === "string" ? record.hint : "";
  const text = [name, hint].filter(Boolean).join(" · ");
  return text || undefined;
}

interface HoverInfo {
  title?: string;
  summary?: string;
  anchor?: string;
  engineRef?: string;
  /** `editcore` 返回参数 meta（`{name,type,hint,default}`）或纯字符串。 */
  param?: string | ValueMeta | null;
  from?: number;
  to?: number;
}

/** Hover 里的参数说明：meta → 中文一行；字符串原样。 */
function hoverParamText(param: HoverInfo["param"]): string {
  if (!param) return "";
  if (typeof param === "string") return param;
  const record = param as unknown as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : "";
  const hint = typeof record.hint === "string" ? record.hint : "";
  const type = typeof record.type === "string" ? record.type : "";
  return [name, type && name ? `<${type}>` : "", hint].filter(Boolean).join(" ");
}

interface EditorModel {
  CONTROLLERS: ControllerMeta[];
  CATEGORY_LABELS?: Record<string, string>;
  lintDocument: (text: string) => ModelDoc;
  completions: (prefix: string | undefined, context: unknown) => Completion[];
  formatLine?: (command: string, values: Record<string, unknown>) => string;
  hoverFor?: (text: string, offset: number) => HoverInfo | null;
}

/**
 * 编辑器模型的最小可用契约。先按名字取导出并做**函数级**校验：`editcore` 正在
 * 并行落盘该文件，任何一处 JSDoc/语法问题都不该让页面白屏——拿不到就退回降级模式
 * （基础统计 + 内置骨架表）。
 */
function adaptModel(mod: Record<string, unknown>): EditorModel | null {
  const completions = mod.completions;
  const lintDocument = mod.lintDocument;
  if (typeof completions !== "function" || typeof lintDocument !== "function") return null;
  const controllers = Array.isArray(mod.CONTROLLERS)
    ? (mod.CONTROLLERS as Array<Record<string, unknown>>).map((entry) => ({
        ...(entry as object),
        command: String(entry.command ?? entry.canonical ?? ""),
      })) as ControllerMeta[]
    : [];
  const hoverFor = mod.hoverFor;
  const formatLine = mod.formatLine;
  return {
    CONTROLLERS: controllers,
    CATEGORY_LABELS: (mod.CATEGORY_LABELS as Record<string, string>) ?? undefined,
    lintDocument: (text: string) => lintDocument(text) as ModelDoc,
    completions: (prefix: string | undefined, context: unknown) =>
      ((completions(prefix, context) as Completion[]) ?? [])
        .filter((item) => item && item.label)
        .map(normalizeCompletion),
    formatLine: typeof formatLine === "function" ? (formatLine as EditorModel["formatLine"]) : undefined,
    hoverFor: typeof hoverFor === "function" ? (hoverFor as EditorModel["hoverFor"]) : undefined,
  };
}

/** 一次性动态加载模型；失败（文件缺失/语法错/浏览器里加载不了）返回 null。 */
let modelPromise: Promise<EditorModel | null> | null = null;
function loadEditorModel(): Promise<EditorModel | null> {
  if (!modelPromise) {
    modelPromise = loadModelModule()
      .then((mod) => {
        const adapted = adaptModel(mod);
        if (!adapted) pushLog("warn", "[editor] editorModel 导出不完整，使用降级模式。", Object.keys(mod));
        return adapted;
      })
      .catch((error) => {
        pushLog("warn", "[editor] editorModel.js 加载失败，使用降级模式：", error);
        return null;
      });
  }
  return modelPromise;
}

// ─── 无模型时的降级表（Tab 骨架 / 控制器面板），保证页面始终可用 ─────────────

/** Tab 骨架：值 = `[` 之后的剩余文本（与 model.completions 的 insertText 同形）。 */
const FALLBACK_TAB: Record<string, string> = {
  head: 'header(key="fanfic_demo", fit_mode="BLACK_MASK")]',
  header: 'header(key="fanfic_demo", fit_mode="BLACK_MASK")]',
  back: 'Background(image="bg_black", fadetime=0.5, block=true)]',
  background: 'Background(image="bg_black", fadetime=0.5, block=true)]',
  image: 'Image(image="cg_01", x=0, y=0, fadetime=0.5)]',
  cha: 'Character(name="char_002_amiya_1", fadetime=0.5)]',
  char: 'Character(name="char_002_amiya_1", fadetime=0.5)]',
  character: 'Character(name="char_002_amiya_1", fadetime=0.5)]',
  charslot: 'charslot(slot="m", name="avg_npc_001", duration=1)]',
  del: "Delay(time=1)]",
  delay: "Delay(time=1)]",
  deci: 'Decision(options="选项A;选项B", values="1;2")]',
  decision: 'Decision(options="选项A;选项B", values="1;2")]',
  pre: 'Predicate(references="1;2")]',
  predicate: 'Predicate(references="1;2")]',
  blocker: "Blocker(a=1, r=0, g=0, b=0, fadetime=0.5, block=true)]",
  stopmusic: "stopmusic(fadetime=1)]",
  playmusic: 'PlayMusic(key="$darkness01_loop", volume=0.6)]',
  camera: 'CameraShake(duration=1, xstrength=30, ystrength=30)]',
  curtain: "curtain(direction=0, fadetime=1)]",
  name: 'name=""]',
};

/** 控制器面板（降级模式）：分类 → 整行骨架。 */
const FALLBACK_PALETTE: Array<{ category: string; lines: string[] }> = [
  {
    category: "首行 / 文本",
    lines: [
      '[header(key="fanfic_demo", fit_mode="BLACK_MASK")]',
      '[name="杜宾"]  这里是……？',
      "[Dialog]",
      '[multiline(name="阿米娅")]续写同一段对白',
    ],
  },
  {
    category: "Background",
    lines: [
      '[Background(image="bg_black", fadetime=0.5, block=true)]',
      '[Image(image="cg_01", x=0, y=0, fadetime=0.5)]',
    ],
  },
  {
    category: "Character",
    lines: [
      '[Character(name="char_002_amiya_1", fadetime=0.5)]',
      '[charslot(slot="m", name="avg_npc_001", duration=1)]',
    ],
  },
  { category: "Choice", lines: ['[Decision(options="选项A;选项B", values="1;2")]', '[Predicate(references="1;2")]'] },
  { category: "Delay", lines: ["[Delay(time=1)]", "[Blocker(a=1, r=0, g=0, b=0, fadetime=0.5, block=true)]"] },
  { category: "Music", lines: ['[PlayMusic(key="$darkness01_loop", volume=0.6)]', "[stopmusic(fadetime=1)]"] },
  { category: "VisualEffect", lines: ['[CameraEffect(effect="Grayscale", amount=0.8, keep=true)]', "[curtain(direction=0, fadetime=1)]"] },
];

// ─── 可选子组件：StagePane（task-10）/ ControllerInspector（task-9）──────────
// 这两个文件由别的 teammate 并行交付；用 `import.meta.glob` 收集，**文件不存在
// 时 glob 返回空对象**，页面照常构建（挂载点显示占位行）。文件一落盘，
// 下次 dev/构建自动接上，无需改本页。

type Slot = "l" | "m" | "r";

/** 背景：`stageModel.parseStage` 给 `{key,url}`，内置兜底解析只给 key 字符串。 */
type StageBackground = string | { key?: string; url?: string | null } | null;

/** 背景的可读文案（占位行/状态栏用；对象也只取 key）。 */
function backgroundLabel(background: StageBackground): string {
  if (!background) return "（无）";
  if (typeof background === "string") return background;
  return background.key ?? "（无）";
}

/**
 * 舞台上的一个立绘。字段与 task-10 `stageModel.parseStage()` 的产物对齐：
 * - `x`/`y` = **1280×720 画布 px 偏移（y 向下）**，窗格按 `引擎 rect + (x,y)` 画；
 * - `rect`/`anchor`/`url`/`key`/`focus` 由 `stageModel` 给出（`StagePane` 直接用）；
 * - 我的兜底解析只填 `name/slot/x/y/label`，其余缺省。
 */
interface StageChar {
  name: string;
  slot: Slot;
  /** 画布 px 偏移（1280×720 基准，y 向下）。 */
  x: number;
  y: number;
  label?: string;
  key?: string;
  url?: string | null;
  rect?: { x: number; y: number; w: number; h: number };
  anchor?: { x: number; y: number };
  focus?: boolean;
  dimmed?: boolean;
}

interface StagePaneProps {
  chars: StageChar[];
  background?: StageBackground;
  height?: number;
  /** `delta` = 1280×720 画布 px（y 向下）的**整段拖拽总位移**（pointerup 发一次）。 */
  onMove?: (slot: Slot, delta: { x: number; y: number }) => void;
  onSelect?: (slot: Slot) => void;
  selected?: string | null;
  focusSlots?: Slot[];
  zoom?: number;
  showGuides?: boolean;
  className?: string;
  model?: unknown;
  resolveUrl?: (key: string, kind?: string) => string;
}

interface BranchGraphProps {
  text: string;
  caretLine: number;
  onJumpToLine: (line: number) => void;
  onPatch?: (nextText: string, caretLine?: number) => void;
  height?: number;
  onClose?: () => void;
}

interface ControllerWizardProps {
  model?: unknown;
  open?: boolean;
  onClose?: () => void;
  onInsert?: (line: string) => void;
  initialCommand?: string;
  assets?: unknown;
  resolveUrl?: (key: string) => string;
}

interface ControllerInspectorProps {
  model: unknown;
  line: string;
  lineIndex: number;
  onApply: (next: string) => void;
  height?: number;
}

/**
 * 把 dock 状态转成"合理的初始浮动矩形"：屏幕中偏右，四周都留出可拖动余量
 * （右侧至少 200px，用户能立刻往右拖；见 `ed-win-check.mjs` 的位移断言）。
 */
function floatFor(_prev: WindowState, bounds: { w: number; h: number }): WindowState {
  const w = Math.min(460, Math.max(280, Math.round(bounds.w * 0.3)));
  const h = Math.min(460, Math.max(220, Math.round(bounds.h * 0.45)));
  const maxX = Math.max(0, bounds.w - w - 200);
  const x = Math.max(0, Math.min(maxX, Math.round(bounds.w * 0.5)));
  const y = Math.max(64, Math.min(Math.max(0, bounds.h - h - 120), Math.round(bounds.h * 0.12)));
  return { kind: "float", rect: { x, y, w, h } };
}

/**
 * `../components/editor/*.tsx` → 动态 import 工厂（Vite 静态收集）。
 *
 * **负向模式**排掉页面**静态** import 过的模块：`InspectorWindow.tsx`（窗口壳，
 * 本页直接用）与 `history.ts` / `windowState.ts`（纯逻辑，不是"可选部件"）。
 * 不排除的话 Rollup 会报 "INEFFECTIVE_DYNAMIC_IMPORT: … will not move module
 * into another chunk"（同一模块既静态又动态）。glob 的"文件不存在即空对象"
 * 语义（并行交付期降级）保持不变。
 */
const editorPartLoaders = import.meta.glob([
  "../components/editor/*.tsx",
  "!../components/editor/InspectorWindow.tsx",
  "!../components/editor/history.ts",
  "!../components/editor/windowState.ts",
]) as Record<string, () => Promise<Record<string, unknown>>>;

/**
 * `stageModel.ts`（task-10）：可选依赖，落盘后预览舞台就用它的坐标模型。
 * 同样用负向模式排掉页面**静态** import 的纯逻辑模块（`history.ts` /
 * `windowState.ts`）——它们是"本页自己的依赖"，不是"可选部件"，同时动态+
 * 静态会让 Rollup 报 INEFFECTIVE_DYNAMIC_IMPORT。
 */
const stageModelLoaders = import.meta.glob([
  "../components/editor/*.ts",
  "!../components/editor/history.ts",
  "!../components/editor/windowState.ts",
]) as Record<string, () => Promise<Record<string, unknown>>>;

interface StageModelModule {
  /** 走脚本到 `lineIndex`，产出 `{background, chars[], focusSlots[]}`（task-10 的签名）。 */
  parseStage?: (
    text: string,
    lineIndex: number,
    options?: Record<string, unknown>
  ) => { background?: StageBackground; chars?: StageChar[] } | undefined;
  /** 拖拽 → 引擎认的整行 patch（优先整行字符串）。 */
  movePatch?: (
    slot: Slot,
    dx: number,
    dy: number,
    extra?: { line?: string; ref?: string; viewport?: { width: number; height: number } }
  ) =>
    | string
    | {
        line?: string;
        patch?: Record<string, unknown>;
        absolute?: { x: number; y: number };
        note?: string;
      };
}

let stageModelPromise: Promise<StageModelModule | null> | null = null;
function loadStageModel(): Promise<StageModelModule | null> {
  if (!stageModelPromise) {
    const key = Object.keys(stageModelLoaders).find((candidate) => candidate.endsWith("/editor/stageModel.ts"));
    stageModelPromise = (key
      ? stageModelLoaders[key]().then((mod) => mod as unknown as StageModelModule)
      : Promise.resolve(null)
    ).catch((error) => {
      // 并行交付期该文件可能是**半截状态**（转换失败）：静默退回内置解析即可，
      // 不要让它变成 unhandledrejection / 页面报错。
      pushLog("warn", "[editor] stageModel.ts 暂不可用，使用内置舞台解析：", error);
      return null;
    });
  }
  return stageModelPromise;
}

/**
 * 按文件名取可选组件；**文件不存在时返回 null**（渲染占位）。
 * 注意：glob 在模块转换时求值，dev server 运行中新增文件需要一次 HMR/重启。
 */
function optionalPart<P extends object>(file: string): LazyExoticComponent<ComponentType<P>> | null {
  const wanted = `/editor/${file}`;
  const key = Object.keys(editorPartLoaders).find((candidate) => candidate.endsWith(wanted));
  if (!key) return null;
  const load = editorPartLoaders[key];
  const Empty = (() => null) as ComponentType<P>;
  return lazy(async () => {
    try {
      const mod = (await load()) as { default?: ComponentType<P> };
      // 没写 default export 时给个空组件，别把整页炸掉。
      return { default: mod.default ?? Empty };
    } catch (error) {
      // 并行交付期文件可能**半截**（语法/转换错误）：load 的 promise 若 reject，
      // React.lazy 会把异常抛到最近的 error boundary——没有 boundary 就是整页白屏。
      // 这里把它降级成"空组件"，页面照常可用（控制台留有日志）。
      pushLog("error", `[editor] ${file} 载入失败，暂以空组件占位：`, error);
      return { default: Empty };
    }
  });
}

const StagePanePart = optionalPart<StagePaneProps>("StagePane.tsx");
/** 分支图（task-16 交付）：props 逐字固定，缺文件时占位降级。 */
const BranchGraphPart = optionalPart<BranchGraphProps>("BranchGraph.tsx");
const ControllerInspectorPart = optionalPart<ControllerInspectorProps>("ControllerInspector.tsx");
const ControllerWizardPart = optionalPart<ControllerWizardProps>("ControllerWizard.tsx");


// ─── 舞台/检视器的数据装配（纯函数） ───────────────────────────────────────

/** 画布基准：与 task-10 的 `stageModel` 一致（1280×720，y 向下）。
 *  仅用于兜底/换算提示；`stageModel` 落盘后一切以它为准。 */
const STAGE_W = 1280;
/** 画布高：与 `STAGE_W` 成 16:9（`StagePane` 自己按比例排版，这里只作说明）。 */
const STAGE_H = 720;


/** 槽位默认落点：**相对引擎落点的偏移**（0,0 = 引擎算出来的位置）。
 *  task-10 的 `StagePane` 按 `引擎 rect + (x,y)` 画，所以默认给 0 才不会"飘"。 */
const SLOT_DEFAULT: Record<Slot, { x: number; y: number }> = {
  l: { x: 0, y: 0 },
  m: { x: 0, y: 0 },
  r: { x: 0, y: 0 },
};

/** 兜底解析用的「安全偏移上限」：超过画布 1.25 倍就认为脚本里的 x/y 是绝对坐标，
 *  换算成相对偏移（避免把立绘甩出舞台）。 */
const STAGE_LIMIT_X = STAGE_W * 1.25;
const STAGE_LIMIT_Y = STAGE_H * 1.25;

/** `key=value` 取值（与 engineBoot.auditScenarioReferences 同规则）。 */
function argOf(params: string, key: string): string | undefined {
  const pattern = /([a-zA-Z][\w]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s)]+))/g;
  for (const match of params.matchAll(pattern)) {
    if (match[1].toLowerCase() === key) return match[2] ?? match[3] ?? match[4] ?? "";
  }
  return undefined;
}

/**
 * 抽取「演出进行到 `upto` 行」时的舞台状态：
 * 三个槽位各自最后一次 `[Character]` / `[charslot]`（空名字 = 清槽），
 * 以及最后一次 `[Background]` 的图名。只看节拍、不解释分支——
 * 与取景器（skill 的 rig）的分支展开是两件事。
 */
function stageStateAt(lines: string[], upto: number): { chars: StageChar[]; background: StageBackground } {
  const slots = new Map<Slot, StageChar>();
  let background: StageBackground = null;
  const limit = Math.min(Math.max(upto, 0), lines.length);
  for (let i = 0; i < limit; i += 1) {
    const raw = lines[i].trim();
    if (!raw.startsWith("[")) continue;
    const match = /^\[\s*([A-Za-z_]\w*)\s*(?:\((.*)\))?\s*\]/.exec(raw);
    if (!match) continue;
    const command = match[1].toLowerCase();
    const params = match[2] ?? "";
    if (command === "background") {
      const image = argOf(params, "image");
      background = image && image.trim() ? image.trim() : null;
      continue;
    }
    if (command !== "character" && command !== "charslot") continue;
    const name = (argOf(params, "name") ?? "").trim();
    const slotRaw = (argOf(params, "slot") ?? "m").trim().toLowerCase();
    const slot: Slot = slotRaw === "l" || slotRaw === "left" ? "l" : slotRaw === "r" || slotRaw === "right" ? "r" : "m";
    if (!name) {
      slots.delete(slot);
      continue;
    }
    const fallback = SLOT_DEFAULT[slot];
    const x = Number.parseFloat(argOf(params, "x") ?? "");
    const y = Number.parseFloat(argOf(params, "y") ?? "");
    const anchorX = Number.parseFloat(argOf(params, "xpos") ?? "");
    const anchorY = Number.parseFloat(argOf(params, "ypos") ?? "");
    // 语料里 `x=` 既有"绝对"也有"偏移"两种写法：超过安全区就按绝对 → 偏移换算。
    const rawX = Number.isFinite(x) ? x : Number.isFinite(anchorX) ? anchorX : fallback.x;
    const rawY = Number.isFinite(y) ? y : Number.isFinite(anchorY) ? anchorY : fallback.y;
    slots.set(slot, {
      name,
      slot,
      x: rawX > STAGE_LIMIT_X || rawX < -STAGE_LIMIT_X ? rawX - STAGE_W / 2 : rawX,
      y: rawY > STAGE_LIMIT_Y || rawY < -STAGE_LIMIT_Y ? rawY - STAGE_H * 0.78 : rawY,
      label: `${i + 1} 行`,
    });
  }
  return { chars: [...slots.values()].sort((a, b) => a.slot.localeCompare(b.slot)), background };
}

/** 取一行 `[Character]`/`[charslot]` 的当前 x/y（缺省 = 槽位默认点）。 */
function stageStateForSlot(line: string): { x: number; y: number } | null {
  const match = /^\[\s*(character|charslot)\s*(?:\((.*)\))?\s*\]\s*$/i.exec(line.trim());
  if (!match) return null;
  const params = match[2] ?? "";
  const slotRaw = (argOf(params, "slot") ?? "m").trim().toLowerCase();
  const slot: Slot = slotRaw === "l" || slotRaw === "left" ? "l" : slotRaw === "r" || slotRaw === "right" ? "r" : "m";
  const fallback = SLOT_DEFAULT[slot];
  const x = Number.parseFloat(argOf(params, "x") ?? "");
  const y = Number.parseFloat(argOf(params, "y") ?? "");
  return {
    x: Number.isFinite(x) ? x : fallback.x,
    y: Number.isFinite(y) ? y : fallback.y,
  };
}

/** 在行内写/改 `key=value`（数字裸写、其余带引号；没有就插到 `)` 之前）。
 *  `stageModel.movePatch()` 给的 `patch` 可能同时含 `xpos1=…` 与 `enter="left"`。 */
function withArg(line: string, key: string, value: string | number | boolean): string {
  if (typeof value === "number" || /^-?\d+(?:\.\d+)?$/.test(String(value))) {
    return withNumberArg(line, key, Number(value));
  }
  const literal = typeof value === "boolean" ? String(value) : `"${String(value).replace(/"/g, '\\"')}"`;
  const existing = new RegExp(`(\\b${key}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^,\\s)]+)`, "i");
  if (existing.test(line)) return line.replace(existing, `$1${literal}`);
  const close = line.lastIndexOf(")");
  if (close === -1) return line;
  const inner = line.slice(0, close).trimEnd();
  const needsComma = /[^\s(]$/.test(inner);
  return `${inner}${needsComma ? ", " : ""}${key}=${literal}${line.slice(close)}`;
}

/** 在行内写/改一个 `key=数字`（`x`/`y` 用；没有就插到 `)` 之前）。 */
function withNumberArg(line: string, key: string, value: number): string {
  const next = Math.round(value);
  const existing = new RegExp(`(\\b${key}\\s*=\\s*)(-?[\\d.]+)`, "i");
  if (existing.test(line)) return line.replace(existing, `$1${next}`);
  const close = line.lastIndexOf(")");
  if (close === -1) return line;
  const inner = line.slice(0, close).trimEnd();
  const needsComma = /[^\s(]$/.test(inner);
  return `${inner}${needsComma ? ", " : ""}${key}=${next}${line.slice(close)}`;
}


// ─── 常量：与 CSS 严格一致，行号 / 高亮 / 光标定位全靠它 ─────────────────────

const LH = 21; // .ed-textarea / .ed-gutter 的 line-height
const FONT = "13px ui-monospace, Menlo, Consolas, monospace";
const PAD_X = 10; // .ed-textarea 的左右 padding
const PAD_BOTTOM = 24; // .ed-textarea 的下 padding（最后一行不被贴边裁掉）

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tauri `invoke`（静态 import；纯 Vite 下调用会抛，调用点都有 try/catch）。 */
async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return tauriCoreInvoke<T>(command, args);
}

// ─── 只读降级：无编辑器模型时的最小 lint ────────────────────────────────────

function fallbackLint(text: string, controllers: ControllerMeta[] | null): ModelDoc {
  const names = new Set((controllers ?? []).map((entry) => entry.command.toLowerCase()));
  const counts: Record<string, number> = {};
  const diagnostics: ModelDiagnostic[] = [];
  let decisions = 0;
  const lines = text.split("\n");
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("//")) return;
    const match = /^\[\s*([A-Za-z_]\w*)/.exec(line);
    if (!match) return;
    const command = match[1].toLowerCase();
    counts[command] = (counts[command] ?? 0) + 1;
    if (command === "decision") decisions += 1;
    if (names.size > 0 && !names.has(command)) {
      diagnostics.push({
        code: 1002,
        name: "unknown-controller",
        severity: "warning",
        message: `未知控制器：${match[1]}`,
        line: index + 1,
        from: 1,
        to: 1 + match[1].length,
      });
    }
    if (!line.endsWith("]") && (line.match(/\[/g)?.length ?? 0) !== (line.match(/\]/g)?.length ?? 0)) {
      diagnostics.push({
        code: 1009,
        name: "unclosed-symbol",
        severity: "error",
        message: "指令行没有闭合的 `]`",
        line: index + 1,
        from: 0,
        to: line.length,
      });
    }
  });
  return { diagnostics, stats: { controllers: counts, decisions, lines: lines.length } };
}

/**
 * 取补全用的 prefix + 被替换区间 + 交给模型的 `args`。
 * - `[Cha` → `{prefix:"Cha", args:"Cha"}`（控制器名，`[` 之后）
 * - `screenadapt="cov` → `{prefix:"\"cov", from: 引号, args:"cov"}`（字符串值）
 * - `Character(na` → `{prefix:"na", args:"na"}`（参数名）
 * - `delay(time=` → `{prefix:"", args:undefined, from: 光标}`（空值，列表全给）
 * 模型的 `prefix` 是「不含引号、不含 `=` 的 token」，所以这里分开存两份。
 */
interface CompletionQuery {
  /** 模型要的 token（无引号；参数名/控制器名/裸值）。 */
  args: string | undefined;
  /** 用在弹窗里的展示前缀（可能含开引号）。 */
  prefix: string;
  from: number;
  kind: "controller" | "argument" | "value";
}

function completionQuery(full: string, offset: number): CompletionQuery {
  const lineStart = full.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const before = full.slice(lineStart, offset);
  const bracket = before.lastIndexOf("[");
  if (bracket !== -1) {
    const after = before.slice(bracket + 1);
    if (!after.includes("(") && !after.includes(")")) {
      const head = /^\s*([A-Za-z_]\w*)?$/.exec(after);
      if (head) {
        return { args: head[1] ?? "", prefix: head[1] ?? "", from: lineStart + bracket + 1, kind: "controller" };
      }
    }
  }
  // 开引号之后的字符串值：`screenadapt="cov`
  const quoted = /["']([^"']*)$/.exec(before);
  if (quoted) {
    return { args: quoted[1], prefix: `${before[quoted.index]}${quoted[1]}`, from: offset - quoted[1].length - 1, kind: "value" };
  }
  // `key=` 之后还没写值：光标处直接列候选（prefix 为空，模型会返回全部枚举）。
  const emptyValue = /([A-Za-z_]\w*)\s*=\s*$/.exec(before);
  if (emptyValue) {
    return { args: undefined, prefix: "", from: offset, kind: "value" };
  }
  const bare = /([A-Za-z_]\w*)$/.exec(before);
  if (bare) {
    return { args: bare[1], prefix: bare[1], from: offset - bare[1].length, kind: "argument" };
  }
  return { args: undefined, prefix: "", from: offset, kind: "argument" };
}

/** 光标是否落在空串/空括号里：`Character(name="")` → 落在两个引号中间。 */
function caretInside(insert: string, base: number): number {
  for (const pair of ['""', "''", "()"]) {
    const at = insert.indexOf(pair);
    if (at >= 0) return base + at + 1;
  }
  return base + insert.length;
}

/** `[Cha` + Tab 的骨架：插入文本里若带空串，光标进到里面。 */
function bracketSkeleton(
  prefix: string,
  model: EditorModel | null,
  line: string,
  cursor: number
): { text: string; caret: number } | null {
  const key = prefix.toLowerCase();
  if (model) {
    let items: Completion[] = [];
    try {
      const raw = model.completions(prefix, { line, cursor, prefix }) ?? [];
      // 参数/值级补全（`name=`、`"coverall"`）不是控制器骨架。
      items = raw.map(normalizeCompletion).map((item) => ({ ...item, kind: item.kind === "value" ? "arg" : item.kind }));
    } catch {
      items = [];
    }
    // 先精确匹配控制器本身，再退到「全写在前缀里」的片段。
    const matches = items
      .filter((item) => {
        const insert = String(item.insertText ?? "");
        const word = insert.replace(/\(.*$/, "").replace(/\]$/, "");
        return key.length === 0 ? true : word.toLowerCase().startsWith(key);
      })
      .sort((a, b) => String(a.insertText ?? "").length - String(b.insertText ?? "").length);
    const pick = matches[0];
    if (pick) {
      let insert = String(pick.insertText ?? pick.label ?? "");
      if (!insert.trimEnd().endsWith("]")) insert = `${insert}]`;
      return { text: insert, caret: caretInside(insert, 0) };
    }
  }
  const keys = Object.keys(FALLBACK_TAB).filter((name) => name.startsWith(key));
  if (!keys.length) return null;
  keys.sort((a, b) => a.length - b.length);
  const insert = FALLBACK_TAB[keys[0]];
  return { text: insert, caret: caretInside(insert, 0) };
}

/** 面板「控制器」按钮插入的整行骨架。
 *  优先 `formatLine`（模型给的规范形态），其次是它自己的控制器补全（带
 *  必填参数的骨架），最后才是页面内置的降级表。 */
function paletteLine(model: EditorModel | null, entry: ControllerMeta): string {
  if (model && !entry.synthetic) {
    if (typeof model.formatLine === "function") {
      try {
        const values: Record<string, unknown> = {};
        for (const meta of entry.required ?? []) values[meta.name] = defaultFor(meta);
        const line = model.formatLine(entry.command, values);
        if (typeof line === "string" && line.trim()) return line.trim();
      } catch {
        // 落到下面的整行补全 / 降级骨架。
      }
    }
    try {
      const word = entry.canonical ?? entry.command;
      const items = model.completions(word, { text: `[${word}`, cursor: word.length + 1, prefix: word });
      const hit = items.find((item) => item.kind === "controller");
      const line = hit ? completionLine(hit) : "";
      // 「裸指令」（`[Dialog]`）用 formatLine 的空参形态；带参的才用补全骨架。
      if (line.startsWith("[") && line.includes("(")) return line;
    } catch {
      // 同上。
    }
  }
  const fallback = Object.values(FALLBACK_TAB).find((text) => text.toLowerCase().startsWith(`${entry.command}(`));
  if (fallback) return `[${fallback}`;
  return `[${entry.canonical ?? entry.command}]`;
}

function defaultFor(meta: ValueMeta): unknown {
  if (meta.enums?.length) return meta.enums[0];
  switch (meta.type) {
    case "number":
    case "int":
      return 0;
    case "bool":
      return true;
    case "semicolon-list":
      return "1;2";
    default:
      return "";
  }
}

/** 降级模式：把 FALLBACK_PALETTE 变成 ControllerMeta（category 已带）。 */
function fallbackControllers(): ControllerMeta[] {
  const out: ControllerMeta[] = [];
  for (const group of FALLBACK_PALETTE) {
    for (const line of group.lines) {
      const command = /^\[?([A-Za-z_]\w*)/.exec(line)?.[1] ?? line;
      out.push({ command: command.toLowerCase(), canonical: command, category: group.category, synthetic: true });
    }
  }
  return out;
}

// ─── 页面 ────────────────────────────────────────────────────────────────

type TabKey = "diag" | "palette" | "info";

interface PopupState {
  items: Completion[];
  index: number;
  from: number;
  prefix: string;
  x: number;
  y: number;
}

interface PackMetaFields {
  title: string;
  chapter: string;
  description: string;
  branchPoints: string;
}

export default function StoryEditorPage() {
  const { packId } = useParams<{ packId: string }>();
  const id = packId ? decodeURIComponent(packId) : "";
  const navigate = useNavigate();
  const [search] = useSearchParams();

  const [model, setModel] = useState<EditorModel | null>(null);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [sourceName, setSourceName] = useState("script.txt");
  const [meta, setMeta] = useState<PackMetaFields>({ title: "", chapter: "", description: "", branchPoints: "" });
  const [rawMeta, setRawMeta] = useState<Record<string, unknown> | null>(null);
  const [originalMeta, setOriginalMeta] = useState<PackMetaFields>({ title: "", chapter: "", description: "", branchPoints: "" });
  const [loadState, setLoadState] = useState<"loading" | "ready" | "empty">("loading");
  const [error, setError] = useState("");
  const [tab, setTab] = useState<TabKey>("diag");
  const [lintNonce, setLintNonce] = useState(0);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [hover, setHover] = useState<{ info: HoverInfo; x: number; y: number } | null>(null);
  const [caret, setCaret] = useState({ line: 1, col: 1, offset: 0 });
  const [busy, setBusy] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewFull, setPreviewFull] = useState(false);
  const [previewStatus, setPreviewStatus] = useState("");

  /** 页面根：浮动窗口的定位上下文 + bounds 测量 + focusin 滚动还原。 */
  const rootRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const previewFrame = useRef<HTMLIFrameElement | null>(null);
  const previewCancel = useRef(false);
  const metricRef = useRef<{ ascii: number; cjk: number } | null>(null);
  /** `.ed-anchor`：只读测量锚点（宽度换算 / 最长行宽）。 */
  const anchorRef = useRef<HTMLSpanElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  /** 舞台宿主：拖动增量要按 960×540 基准换算，才能写回 `x=`/`y=`。 */
  const stageHostRef = useRef<HTMLDivElement>(null);
  const hiddenRef = useRef(false);
  const textRef = useRef("");
  const modelRef = useRef<EditorModel | null>(null);
  const pendingSel = useRef<[number, number] | null>(null);

  textRef.current = text;
  modelRef.current = model;

  const readOnly = !inTauri();

  /** 页面根尺寸：浮动窗口的 clamp / 百分比定位都依赖它。 */
  const [bounds, setBounds] = useState({ w: 0, h: 0 });
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  /** 三个工具窗口（右栏 / 舞台 / 预览）的停靠-浮动状态。 */
  const [panelWin, setPanelWin] = useState<WindowState>(
    () => readWindowState("prts-editor-windows:panel") ?? { kind: "dock", side: "right" }
  );
  const [stageWin, setStageWin] = useState<WindowState>(
    () => readWindowState("prts-editor-windows:stage") ?? { kind: "dock", side: "left" }
  );
  const [previewWin, setPreviewWin] = useState<WindowState>(
    () => readWindowState("prts-editor-windows:preview") ?? { kind: "dock", side: "right" }
  );
  /** 撤销 / 重做（覆盖打字、拖立绘、表单、模板、补全——全走 applyEdit/onChange）。 */
  const historyRef = useRef(createHistory({ limit: 200, mergeMs: 500 }));
  const [historySizes, setHistorySizes] = useState({ undo: 0, redo: 0 });

  /** 预览 iframe 是否存活：模型的状态行（save state）分支共用它。 */
  const [previewLive, setPreviewLive] = useState(false);
  /** 测量出来的正文尺寸（横向由最长行决定，纵向由行数决定）。 */
  const [docSize, setDocSize] = useState({ width: 0, height: 0 });
  /** 0 = 不截断（预览到文末）；>0 = 预览时截到第 N 行。 */
  const [previewUpto, setPreviewUpto] = useState(0);
  /** 行定位条滑杆位置（光标行，1 基）。 */
  const scrubLine = previewUpto > 0 ? previewUpto : caret.line;
  /** 舞台：拖动/选中哪个槽位；工具面板是否展开检视器。 */
  const [stageSelected, setStageSelected] = useState<string | null>(null);
  const [showInspector, setShowInspector] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  /** 三个工具窗口的显示开关（关闭 = 收进状态栏的「工具窗口…」菜单）。 */
  const [showPanel, setShowPanel] = useState(true);
  const [showStage, setShowStage] = useState(true);
  const [showBranch, setShowBranch] = useState(false);
  /** 分支图窗口的停靠/浮动状态（默认右侧浮动，跟上其它工具窗口）。 */
  const [branchWin, setBranchWin] = useState<WindowState>(
    () => readWindowState("prts-editor-windows:branch") ?? { kind: "float", rect: { x: 0, y: 72, w: 430, h: 420 } }
  );
  const [stageMoves, setStageMoves] = useState<Array<{ slot: Slot; x: number; y: number }>>([]);

  // 模型（editcore 并行交付）：加载完成前先用降级 lint，页面不会白屏。
  useEffect(() => {
    let alive = true;
    void loadEditorModel().then((loaded) => {
      if (alive && loaded) setModel(loaded);
    });
    return () => {
      alive = false;
    };
  }, []);

  /** 页面根尺寸（浮动窗口换算/clamp 用）。 */
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const rect = root.getBoundingClientRect();
      setBounds((prev) =>
        Math.abs(prev.w - rect.width) < 1 && Math.abs(prev.h - rect.height) < 1
          ? prev
          : { w: Math.round(rect.width), h: Math.round(rect.height) }
      );
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(root);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  /**
   * 修「焦点抢滚动」：工具窗口里的 `input`（例如检视器的语法搜索）拿到焦点时，
   * 浏览器会把它 scroll-into-view，窄面板下会把整页横向推到 `scrollLeft ≈ -828`。
   * 捕获阶段先记下滚动位置，focusin 后**两帧**还原（一帧不够：布局/滚动在下一帧才落定）。
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let pending: { left: number; top: number; target: Element } | null = null;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || !root.contains(target)) return;
      const tag = target.tagName?.toLowerCase();
      if (tag !== "input" && tag !== "select") return;
      const scroller = document.scrollingElement ?? document.documentElement;
      pending = { left: scroller.scrollLeft, top: scroller.scrollTop, target: scroller };
      const restore = () => {
        if (!pending) return;
        pending.target.scrollLeft = pending.left;
        pending.target.scrollTop = pending.top;
      };
      requestAnimationFrame(() => {
        restore();
        requestAnimationFrame(restore);
      });
    };
    root.addEventListener("focusin", onFocusIn);
    return () => root.removeEventListener("focusin", onFocusIn);
  }, []);

  /** 清空历史（重新载入剧本包时）。 */
  const resetHistory = useCallback(() => {
    historyRef.current.clear();
    setHistorySizes({ undo: 0, redo: 0 });
  }, []);

  // ── 载入剧本包 ──────────────────────────────────────────────────────

  const loadPack = useCallback(async () => {
    setLoadState("loading");
    setError("");
    if (!id) {
      setLoadState("empty");
      return;
    }
    if (!inTauri()) {
      // 纯 Vite 只读演示：`?text=` 直给，或走 localStories 的探针通道。
      const textParam = search.get("text");
      const packParam = search.get("pack");
      if (textParam !== null) {
        setText(textParam);
        setRawMeta(packParam ? safeJson(packParam) : null);
        setLoadState("ready");
        setSourceName("?text=");
        return;
      }
      try {
        await ensureBrowserPackSource();
        const packs = (await localPacks()) as Array<{ id: string; files?: Record<string, string>; script?: string }>;
        const pack = packs.find((entry) => entry.id === id);
        const raw = pack?.script ?? pack?.files?.["script.txt"];
        const script = raw ?? pack?.files?.["source/probe.txt"];
        if (script) {
          setText(String(script));
          setSourceName(raw !== undefined ? "script.txt" : "source/probe.txt");
          const packJson = pack?.files ? parseMetaFromText(pack.files["pack.json"]) : null;
          setRawMeta(packJson);
          setLoadState("ready");
          return;
        }
      } catch (e) {
        pushLog("warn", "[editor] 浏览器探针读取失败：", e);
      }
      setText("");
      setLoadState("empty");
      return;
    }

    try {
      let script = await tauriInvoke<string | null>("read_library_file", { id, name: "script.txt" });
      let source = "script.txt";
      if (script === null) {
        script = await tauriInvoke<string | null>("read_library_file", { id, name: "source/probe.txt" });
        if (script !== null) source = "source/probe.txt";
      }
      const packJson = await tauriInvoke<string | null>("read_library_file", { id, name: "pack.json" });
      setRawMeta(parseMetaFromText(packJson));
      setSourceName(source);
      if (script === null) {
        setText("");
        setLoadState("empty");
        setError(`剧本包「${id}」里找不到 script.txt 或 source/probe.txt；可直接在这里开始写，保存会创建 script.txt。`);
        return;
      }
      setText(script);
      setDirty(false);
      resetHistory();
      setLoadState("ready");
    } catch (e) {
      setText("");
      setLoadState("empty");
      setError(`读取剧本包失败：${errText(e)}`);
    }
  }, [id, resetHistory, search]);

  useEffect(() => {
    void loadPack();
  }, [loadPack]);

  // pack.json → 可编辑字段；原文留在 rawMeta 里，保存时只覆盖这几个键。
  useEffect(() => {
    const fields: PackMetaFields = {
      title: str(rawMeta?.title) || id,
      chapter: str(rawMeta?.chapter),
      description: str(rawMeta?.description),
      branchPoints: Array.isArray(rawMeta?.branchPoints) ? (rawMeta?.branchPoints as unknown[]).map(str).join(", ") : "",
    };
    setMeta(fields);
    setOriginalMeta(fields);
  }, [rawMeta, id]);

  // 浏览器里的 URL 参数改动（`?text=`）也算一次重新载入。
  useEffect(() => {
    const onPop = () => void loadPack();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [loadPack]);

  // ── 行/光标工具 ────────────────────────────────────────────────────

  const lineStarts = useMemo(() => {
    const starts = [0];
    for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
    return starts;
  }, [text]);
  const lineStartsRef = useRef(lineStarts);
  lineStartsRef.current = lineStarts;

  const syncCaret = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    const offset = el.selectionStart ?? 0;
    const before = textRef.current.slice(0, offset);
    const line = before.split("\n").length;
    const col = offset - (before.lastIndexOf("\n") + 1) + 1;
    setCaret((prev) => (prev.offset === offset && prev.line === line && prev.col === col ? prev : { line, col, offset }));
  }, []);

  /** 当前状态（历史条目：文本 + 光标区间）。 */
  const currentEntry = useCallback((): HistoryEntry => {
    const el = taRef.current;
    const offset = el?.selectionStart ?? textRef.current.length;
    return { text: textRef.current, sel: [offset, el?.selectionEnd ?? offset] };
  }, []);

  /** 记一条历史（`applyEdit` / `onChange` / 拖拽最终落点共用）。 */
  const commitHistory = useCallback(
    (before: HistoryEntry, after: HistoryEntry, insert?: string, source: "typing" | "edit" = "edit") => {
      historyRef.current.commit({ before, after, insert, source });
      setHistorySizes(historyRef.current.sizes());
    },
    []
  );

  /**
   * 改文本：统一走这里，顺带恢复光标 + 置脏 + **记历史**。
   * 拖立绘 / 表单应用 / 向导插入 / Tab 补全 / 面板插入全部经此，
   * 所以 Ctrl+Z 对它们一体生效。
   */
  const applyEdit = useCallback(
    (from: number, to: number, insert: string, caretFrom?: number, caretTo?: number) => {
      const current = textRef.current;
      const next = current.slice(0, from) + insert + current.slice(to);
      if (next === current) return;
      const at = caretFrom ?? from + insert.length;
      commitHistory({ text: current, sel: [from, to] }, { text: next, sel: [at, caretTo ?? at] }, insert);
      textRef.current = next;
      pendingSel.current = [at, caretTo ?? at];
      setText(next);
      setDirty(true);
    },
    [commitHistory]
  );

  /** 撤销：回退到上一条历史；光标按条目复位（保证第二次 Ctrl+Z 仍走我们的栈）。 */
  const doUndo = useCallback(() => {
    const present = currentEntry();
    const previous = historyRef.current.undo(present);
    setHistorySizes(historyRef.current.sizes());
    if (!previous) return false;
    textRef.current = previous.text;
    pendingSel.current = [previous.sel[0], previous.sel[1]];
    setText(previous.text);
    setDirty(true);
    return true;
  }, [currentEntry]);

  /** 重做：与 `doUndo` 对称。 */
  const doRedo = useCallback(() => {
    const present = currentEntry();
    const next = historyRef.current.redo(present);
    setHistorySizes(historyRef.current.sizes());
    if (!next) return false;
    textRef.current = next.text;
    pendingSel.current = [next.sel[0], next.sel[1]];
    setText(next.text);
    setDirty(true);
    return true;
  }, [currentEntry]);

  useLayoutEffect(() => {
    const el = taRef.current;
    const selection = pendingSel.current;
    if (!el || !selection) return;
    pendingSel.current = null;
    el.focus();
    el.setSelectionRange(selection[0], selection[1]);
    syncCaret();
  });

  /**
   * 正文尺寸：宽 = max(视口宽, 最长行像素宽 + 左右 padding)，
   * 高 = 行数 * LH + 上下 padding。用 `.ed-anchor` 里的隐藏 span **实测**，
   * 保证行号 / 高亮条 / 补全弹窗 / 悬停提示与 textarea 逐像素对齐。
   */
  useLayoutEffect(() => {
    const el = anchorRef.current;
    const scroller = scrollerRef.current;
    if (!el || !scroller) return;
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      let width = 0;
      try {
        const probe = document.createElement("span");
        // 最长行：先按字符数粗选，再实测（CJK 宽两格）。
        let longest = "";
        for (const line of text.split("\n")) if (line.length > longest.length) longest = line;
        probe.textContent = longest || " ";
        el.replaceChildren(probe);
        width = probe.getBoundingClientRect().width;
        el.replaceChildren();
      } catch {
        width = 0;
      }
      const height = lineStarts.length * LH + PAD_BOTTOM;
      setDocSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height }
      );
    };
    measure();
    // 字体/换行变化（缩放、CJK 字体回退）后要重量。
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(scroller);
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [text, lineStarts.length]);

  /** 光标移动后把当前行滚进可见区（Ctrl+End / 点行号 / 面板插入都受益）。 */
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const top = (caret.line - 1) * LH;
    const bottom = top + LH;
    if (top < scroller.scrollTop) scroller.scrollTop = Math.max(0, top - LH);
    else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom - scroller.clientHeight + LH;
    }
  }, [caret.line, caret.offset]);

  const jumpToLine = useCallback(
    (line: number) => {
      const el = taRef.current;
      const starts = lineStartsRef.current;
      const index = Math.min(Math.max(1, line || 1), starts.length) - 1;
      const from = starts[index] ?? 0;
      const to = Math.max(from, (starts[index + 1] ?? textRef.current.length + 1) - 1);
      pendingSel.current = [from, to];
      syncCaret();
      setCaret({ line: index + 1, col: 1, offset: from });
      const scroller = scrollerRef.current;
      if (scroller) scroller.scrollTop = Math.max(0, index * LH - scroller.clientHeight / 3);
      el?.focus();
      el?.setSelectionRange(from, to);
    },
    [syncCaret]
  );

  // ── 诊断（实时 lint，可手动「校验」重跑） ─────────────────────────

  const doc = useMemo<ModelDoc>(() => {
    try {
      if (model) return model.lintDocument(text);
    } catch (e) {
      pushLog("warn", "[editor] lintDocument 抛错，退回降级统计：", e);
    }
    return fallbackLint(text, model?.CONTROLLERS ?? null);
    // lintNonce 只用于「校验」按钮强制重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lintNonce = 「校验」按钮的强制重算信号
  }, [model, text, lintNonce]);

  // `lintDocument` 已经把合流问题（0x1014..0x1018）算进 diagnostics；这里只做
  // 兜底：模型若把合流诊断单独放在 `merge`/`missing` 里（且 diagnostics 中没有
  // 同一行同名项），才补进来——避免同一条问题出现两次。
  const diagnostics = useMemo<ModelDiagnostic[]>(() => {
    const out: ModelDiagnostic[] = [...(doc.diagnostics ?? [])];
    const seen = new Set(out.map((item) => `${item.line}:${item.name ?? item.code}`));
    const extras: ModelDiagnostic[] = [
      ...(doc.merge ?? []),
      ...(doc.missing ?? []).map((item) => ({
        code: "M",
        name: "missing-merge",
        severity: "warning" as const,
        message: item.message,
        line: item.line ?? 0,
      })),
    ];
    for (const item of extras) {
      const key = `${item.line}:${item.name ?? item.code}`;
      if (!item.line || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out.sort((a, b) => (a.line || 0) - (b.line || 0) || (a.from ?? 0) - (b.from ?? 0));
  }, [doc]);

  const controllerCount = useMemo(
    () => Object.values(doc.stats?.controllers ?? {}).reduce((sum, value) => sum + Number(value || 0), 0),
    [doc]
  );
  const errorCount = diagnostics.filter((item) => item.severity === "error").length;

  const diagnosticsByLine = useMemo(() => {
    const map = new Map<number, "error" | "warning">();
    for (const item of diagnostics) {
      if (!item.line) continue;
      const current = map.get(item.line);
      if (current === "error") continue;
      map.set(item.line, item.severity === "error" ? "error" : current ?? "warning");
    }
    return map;
  }, [diagnostics]);

  // ── 补全弹窗 ────────────────────────────────────────────────────

  /** canvas 兜底字宽（只在 DOM 量不到时用）。 */
  const metrics = useCallback(() => {
    if (!metricRef.current) {
      try {
        const ctx = document.createElement("canvas").getContext("2d");
        if (ctx) {
          ctx.font = FONT;
          metricRef.current = { ascii: ctx.measureText("M").width, cjk: ctx.measureText("汉").width };
        }
      } catch {
        // 量不了就用兜底值。
      }
    }
    return metricRef.current ?? { ascii: 7.8, cjk: 15.6 };
  }, []);

  /** 等宽字体下 CJK 占两格：把前缀换算成「ASCII 格数」。 */
  const cellWidths = useCallback((prefixText: string): number => {
    let cells = 0;
    for (const ch of prefixText) cells += (ch.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1;
    return cells;
  }, []);

  /**
   * 光标像素位置。优先用真实 DOM 量：`.ed-anchor` 里塞同前缀文本，
   * `<span>` 的宽度即精确位移（等宽字体下与 textarea 逐像素一致）；
   * 量不到（组件未挂载）再退回 canvas 估算。
   */
  const advanceTo = useCallback(
    (line: number, offset: number): { x: number; y: number } => {
      const starts = lineStartsRef.current;
      const start = starts[Math.min(Math.max(0, line - 1), Math.max(0, starts.length - 1))] ?? 0;
      const prefixText = textRef.current.slice(start, offset);
      let x = PAD_X;
      const anchor = anchorRef.current;
      if (anchor && typeof document !== "undefined") {
        try {
          const probe = document.createElement("span");
          probe.textContent = prefixText;
          anchor.replaceChildren(probe);
          const width = probe.getBoundingClientRect().width;
          anchor.replaceChildren();
          if (width > 0) return { x: PAD_X + width, y: (line - 1) * LH };
        } catch {
          // 落到 canvas 估算。
        }
      }
      const { ascii, cjk } = metrics();
      x += cjk * (cellWidths(prefixText) - prefixText.length) + ascii * prefixText.length;
      return { x, y: (line - 1) * LH };
    },
    [cellWidths, metrics]
  );

  const refreshPopup = useCallback(
    (auto: boolean) => {
      const m = modelRef.current;
      const el = taRef.current;
      if (!m || !el || hiddenRef.current) {
        setPopup(null);
        return;
      }
      const offset = el.selectionStart ?? 0;
      if (offset !== (el.selectionEnd ?? 0)) {
        setPopup(null);
        return;
      }
      const full = textRef.current;
      const query = completionQuery(full, offset);
      if (auto && query.prefix.length === 0 && query.args === undefined) {
        setPopup(null);
        return;
      }
      const lineStart = full.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
      const lineEnd = full.indexOf("\n", offset);
      const line = full.slice(lineStart, lineEnd === -1 ? full.length : lineEnd);
      let items: Completion[] = [];
      try {
        items = m.completions(String(query.args ?? ""), { text: line, cursor: offset - lineStart, prefix: query.args }) ?? [];
      } catch (e) {
        pushLog("warn", "[editor] completions 抛错：", e);
        items = [];
      }
      if (!items.length) {
        setPopup(null);
        return;
      }
      // 归一化 + 只保留与本处语义相符的候选（控制器 / 参数名 / 枚举值）。
      const normalized = items
        .slice(0, 80)
        .map(normalizeCompletion)
        .filter((item) => query.kind === "value" ? item.kind === "value" : item.kind !== "value")
        .map((item) => ({ ...item, kind: query.kind === "controller" ? item.kind ?? "controller" : query.kind }));
      if (!normalized.length) {
        setPopup(null);
        return;
      }
      const pos = advanceTo(caret.line, offset);
      setPopup({ items: normalized.slice(0, 60), index: 0, from: query.from, prefix: query.prefix, x: pos.x, y: pos.y + LH });
    },
    [advanceTo, caret.line]
  );
  const refreshPopupRef = useRef(refreshPopup);
  refreshPopupRef.current = refreshPopup;

  useEffect(() => {
    if (!model) return;
    const raf = requestAnimationFrame(() => refreshPopupRef.current(true));
    return () => cancelAnimationFrame(raf);
  }, [text, caret.offset, model]);

  /** 文本变化时清掉陈旧的悬停帮助，避免提示与正文对不上。 */
  useEffect(() => {
    setHover(null);
  }, [text]);

  const acceptCompletion = useCallback(() => {
    if (!popup) return;
    const item = popup.items[popup.index];
    if (!item) return;
    let insert = String(item.insertText ?? item.label ?? "");
    // 控制器补全补上 `]`：`[Cha` + Enter → `[Character(name="")]`。
    if ((item.kind ?? "controller") === "controller" && !insert.trimEnd().endsWith("]")) {
      insert = `${insert}]`;
    }
    applyEdit(popup.from, popup.from + popup.prefix.length, insert, caretInside(insert, popup.from));
    hiddenRef.current = true;
    setPopup(null);
  }, [applyEdit, popup]);

  /** Tab：光标在 `[Cha` 这种半截控制器末尾时，补成骨架；否则用 Tab 字符。 */
  const tryTabSkeleton = useCallback((): boolean => {
    const el = taRef.current;
    if (!el) return false;
    if ((el.selectionStart ?? 0) !== (el.selectionEnd ?? 0)) return false;
    const full = textRef.current;
    const offset = el.selectionStart ?? 0;
    const lineStart = full.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
    const lineEnd = full.indexOf("\n", offset);
    const line = full.slice(lineStart, lineEnd === -1 ? full.length : lineEnd);
    const before = line.slice(0, offset - lineStart);
    const after = line.slice(offset - lineStart);
    if (after.trim() !== "") return false; // 光标必须在行尾（半截控制器之后）
    const match = /^(\s*)\[([A-Za-z_]\w*)?$/.exec(before);
    if (!match) return false;
    const prefix = match[2] ?? "";
    const skeleton = bracketSkeleton(prefix, modelRef.current, line, offset - lineStart);
    if (!skeleton) return false;
    const insertFrom = lineStart + match[1].length + 1; // `[` 之后
    applyEdit(insertFrom, offset, skeleton.text, insertFrom + skeleton.caret);
    hiddenRef.current = true;
    setPopup(null);
    return true;
  }, [applyEdit]);

  // ── 悬停帮助 ──────────────────────────────────────────────────

  const hoverAt = useCallback(
    (clientX: number, clientY: number) => {
      const m = modelRef.current;
      const box = linesRef.current;
      if (!m || typeof m.hoverFor !== "function" || !box) {
        setHover(null);
        return;
      }
      const rect = box.getBoundingClientRect();
      const starts = lineStartsRef.current;
      const row = Math.max(0, Math.floor((clientY - rect.top) / LH));
      if (row >= starts.length) {
        setHover(null);
        return;
      }
      const start = starts[row];
      const end = (starts[row + 1] ?? textRef.current.length + 1) - 1;
      const lineText = textRef.current.slice(start, end);
      let x = clientX - (rect.left + PAD_X);
      let col = 0;
      const anchor = anchorRef.current;
      if (anchor && typeof document !== "undefined") {
        // 二分：用真实 DOM 量每个前缀的宽度，避免等宽估算在混排时的偏差。
        try {
          let lo = 0;
          let hi = lineText.length;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            const probe = document.createElement("span");
            probe.textContent = lineText.slice(0, mid);
            anchor.replaceChildren(probe);
            const width = probe.getBoundingClientRect().width;
            anchor.replaceChildren();
            if (x >= width - (metrics().ascii / 2)) lo = mid;
            else hi = mid - 1;
          }
          col = lo;
        } catch {
          col = 0;
        }
      }
      if (col === 0 && anchor === null) {
        const { ascii, cjk } = metrics();
        while (col < lineText.length) {
          const width = (lineText.codePointAt(col) ?? 0) > 0x2e80 ? cjk : ascii;
          if (x < width / 2) break;
          x -= width;
          col += 1;
        }
      }
      const info = m.hoverFor(textRef.current, Math.min(start + col, end));
      if (!info) {
        setHover(null);
        return;
      }
      setHover({ info, x: clientX - rect.left + 14, y: clientY - rect.top + 16 });
    },
    [metrics]
  );

  /** 水平方向同理：把光标列滚进可见区。 */
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const { x } = advanceTo(caret.line, caret.offset);
    const left = scroller.scrollLeft;
    const right = left + scroller.clientWidth;
    if (x - PAD_X + 60 > right) scroller.scrollLeft = x + 60 - scroller.clientWidth;
    else if (x - PAD_X - 24 < left) scroller.scrollLeft = Math.max(0, x - PAD_X - 24);
  }, [advanceTo, caret.line, caret.offset]);

  // ── 保存 / 校验 / 重新载入 ──────────────────────────────────────

  const metaChanged = useMemo(
    () =>
      meta.title !== originalMeta.title ||
      meta.chapter !== originalMeta.chapter ||
      meta.description !== originalMeta.description ||
      meta.branchPoints !== originalMeta.branchPoints,
    [meta, originalMeta]
  );
  const isDirty = dirty || metaChanged;

  const writeFile = useCallback(
    async (name: string, content: string, createDirs: boolean) => {
      const result = await tauriInvoke<{ path: string; bytes: number }>("write_library_file", {
        id,
        name,
        content,
        createDirs,
      });
      pushLog("info", `[editor] 已写入 ${result.path} (${result.bytes} bytes)`);
      return result;
    },
    [id]
  );

  const doSave = useCallback(async () => {
    if (!id) return;
    if (!inTauri()) {
      setError("纯浏览器里是只读演示：保存请在桌面应用内打开本页。");
      setDirty(false);
      return;
    }
    setBusy("save");
    setError("");
    try {
      const target = sourceName === "source/probe.txt" ? "source/probe.txt" : "script.txt";
      const result = await writeFile(target, textRef.current, true);
      setSourceName(target);
      setDirty(false);
      if (metaChanged) {
        const merged: Record<string, unknown> = { ...(rawMeta ?? {}) };
        merged.id = merged.id ?? id;
        merged.title = meta.title;
        merged.chapter = meta.chapter;
        merged.description = meta.description;
        merged.branchPoints = meta.branchPoints
          .split(/[,;，、\n]+/)
          .map((value) => value.trim())
          .filter(Boolean);
        await writeFile("pack.json", `${JSON.stringify(merged, null, 1)}\n`, true);
        setRawMeta(merged);
        setOriginalMeta(meta);
      }
      setPreviewStatus(`已保存 ${target}（${result.bytes} 字节）`);
    } catch (e) {
      setError(`保存失败：${errText(e)}`);
    } finally {
      setBusy("");
    }
  }, [id, meta, metaChanged, rawMeta, sourceName, writeFile]);

  const saveMetaOnly = useCallback(async () => {
    if (!inTauri()) {
      setError("纯浏览器里是只读演示：保存请在桌面应用内打开本页。");
      return;
    }
    setBusy("meta");
    try {
      const merged: Record<string, unknown> = { ...(rawMeta ?? {}) };
      merged.id = merged.id ?? id;
      merged.title = meta.title;
      merged.chapter = meta.chapter;
      merged.description = meta.description;
      merged.branchPoints = meta.branchPoints.split(/[,;，、\n]+/).map((v) => v.trim()).filter(Boolean);
      await writeFile("pack.json", `${JSON.stringify(merged, null, 1)}\n`, true);
      setRawMeta(merged);
      setOriginalMeta(meta);
      setPreviewStatus("已保存 pack.json");
    } catch (e) {
      setError(`保存剧本信息失败：${errText(e)}`);
    } finally {
      setBusy("");
    }
  }, [id, meta, rawMeta, writeFile]);

  const reload = useCallback(() => {
    void loadPack();
    setPreviewStatus("");
  }, [loadPack]);

  const runLint = useCallback(() => {
    setLintNonce((value) => value + 1);
    setTab("diag");
  }, []);

  /**
   * Ctrl+S / Ctrl+Space / **Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y**：整页生效。
   *
   * 焦点规则：撤销/重做只在 textarea / 页面根 / body 上拦截——工具窗口里的
   * `input`/`select` 有自己的原生 undo，交还给浏览器（否则用户改表单时按 Ctrl+Z
   * 会把整个文档撤掉，很突兀）。滚动条/根容器也按 textarea 处理。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        void doSave();
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        refreshPopupRef.current(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase() ?? "";
      const isEditorish =
        !target ||
        target === document.body ||
        target === rootRef.current ||
        tag === "textarea" ||
        target.classList?.contains("editor-page") === true ||
        rootRef.current?.contains(target) === true;
      const inFormField = tag === "input" || tag === "select" || (tag === "textarea" && target !== taRef.current);
      if (!isEditorish || inFormField) return;
      if (key === "z" && !event.shiftKey) {
        if (event.altKey) return;
        event.preventDefault();
        doUndo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        doRedo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doRedo, doSave, doUndo]);

  // 有未保存改动时，关页/刷新给一次浏览器原生确认（不用 window.confirm）。
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  // ── 预览（不要求先保存） ─────────────────────────────────────

  /** 用当前缓冲区文本重建一个播放用 runtime（跳过 PRTS 同步）。 */
  const buildPreviewRuntime = useCallback(async (script: string) => {
    const upstream = await (async () => {
      try {
        await ensureBrowserPackSource();
        const packs = (await localPacks()) as Array<Record<string, unknown>>;
        const pack = packs.find((entry) => entry.id === id);
        if (pack) {
          const packJson = { ...(pack.packMeta as object), id } as Record<string, unknown>;
          packJson.title = meta.title || id;
          packJson.chapter = meta.chapter;
          const bundle = buildPackBundle(
            { ...pack, packMeta: packJson, id } as never,
            (await localUpstream()) as { bundle?: object } | null
          );
          // `[Cmd@tag(...)]` 只给取景器用，引擎按字面分发：预览前必须去掉。
          // 与 localStories.localStoryOverride 同形：StoryPlayer 快照放进
          // `story_player`（engineBoot 据此走新版引擎）。
          if (bundle) {
            return {
              story: { script: stripControls(script) as string, title: id },
              bundle: { dom_html: "", data_blocks_html: "", engine_scripts: [], story_player: bundle },
            };
          }
        }
      } catch (e) {
        pushLog("warn", "[editor] 预览：本地包合成失败，改用 PRTS runtime：", e);
      }
      return null;
    })();
    if (upstream) return { story: upstream.story, bundle: upstream.bundle, revision: `editor:${Date.now()}` };
    const runtime = await loadStoryRuntime(id);
    return { story: { ...runtime.story, script, title: id }, bundle: runtime.bundle, revision: `editor:${runtime.revision}` };
  }, [id, meta]);

  /** 浏览器里探测一下是否有可用的剧本包文本 + 上游快照（只读演示）。 */
  const runProbe = useCallback(async (): Promise<{ script: string | null; upstream: boolean }> => {
    try {
      const response = await fetch("/__local-library.json", { cache: "no-store" });
      if (!response.ok) return { script: null, upstream: false };
      const payload = (await response.json()) as {
        packs?: Array<{ id: string; files?: Record<string, string> }>;
        upstream?: { bundle?: unknown } | null;
      };
      const pack = payload.packs?.find((entry) => entry.id === id);
      const script = pack?.files?.["script.txt"] ?? pack?.files?.["source/probe.txt"] ?? null;
      return { script, upstream: Boolean(payload.upstream?.bundle) };
    } catch {
      return { script: null, upstream: false };
    }
  }, [id]);

  const closePreview = useCallback(() => {
    previewCancel.current = true;
    const frame = previewFrame.current;
    previewFrame.current = null;
    if (frame) {
      try {
        disposeEngineFrame(frame);
      } catch {
        // ignore cross-realm errors
      }
      frame.remove();
    }
  }, []);

  /**
   * 开预览。`upto` = 只演到第 N 行（1 基；`text.slice(0, 该行结尾)`），
   * 省略 = 整篇。**不需要先保存**：用的永远是缓冲区里的当前文本。
   */
  const openPreview = useCallback(async (upto?: number) => {
    setPreviewOpen(true);
    setPreviewLive(false);
    const lines = textRef.current.split("\n");
    const cut = upto && upto > 0 ? Math.min(upto, lines.length) : 0;
    setPreviewUpto(cut);
    setPreviewStatus(cut ? `正在准备预览（截到第 ${cut} 行）…` : "正在准备预览…");
    if (!inTauri()) {
      // 浏览器：播放用的 story_player 快照只在 Vite 探针里；没有就得等「PRTS 同步」。
      const probe = await runProbe();
      if (!probe.upstream) {
        setPreviewStatus("浏览器预览：本地探针里没有 story_player 快照，将走 PRTS 同步（首次较慢）。");
      }
    }
    const host = hostRef.current;
    if (!host) return;
    closePreview();
    previewCancel.current = false;
    try {
      // 截断：`upto` 行之后的文字不进 runtime（不含该行行尾换行）。
      const script = cut > 0 ? lines.slice(0, cut).join("\n") : textRef.current;
      const runtime = await buildPreviewRuntime(script);
      if (previewCancel.current) return;
      const frame = document.createElement("iframe");
      frame.title = "剧本预览";
      host.innerHTML = "";
      host.appendChild(frame);
      previewFrame.current = frame;
      setPreviewStatus("正在初始化演出引擎…");
      await bootEngineInFrame({
        iframe: frame,
        bundle: runtime.bundle as never,
        script: runtime.story.script,
        title: id || "preview",
        mode: "play",
        isCancelled: () => previewCancel.current,
      });
      if (previewCancel.current) return;
      setPreviewLive(true);
      setPreviewStatus(
        cut > 0
          ? `预览中（截到第 ${cut} 行；编辑后点「重新载入预览」）`
          : "预览中（编辑后点「重新载入预览」）"
      );
    } catch (e) {
      setPreviewStatus(`预览失败：${errText(e)}`);
    }
  }, [buildPreviewRuntime, closePreview, id, runProbe]);

  useEffect(() => () => closePreview(), [closePreview]);

  // ── 预览面板拖拽高度（像 YSS 的工具控件一样可调整） ───────────────

  const [previewHeight, setPreviewHeight] = useState(340);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const onDragMove = useCallback((event: PointerEvent) => {
    const state = dragRef.current;
    if (!state) return;
    setPreviewHeight(Math.max(140, Math.min(window.innerHeight - 220, state.startHeight + (state.startY - event.clientY))));
  }, []);
  const onDragEnd = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
  }, [onDragMove]);
  const onDragStart = useCallback(
    (event: React.PointerEvent) => {
      dragRef.current = { startY: event.clientY, startHeight: previewHeight };
      window.addEventListener("pointermove", onDragMove);
      window.addEventListener("pointerup", onDragEnd);
    },
    [onDragEnd, onDragMove, previewHeight]
  );

  // ── 控制器面板数据 ────────────────────────────────────────────

  const paletteGroups = useMemo(() => {
    const list = model?.CONTROLLERS?.length ? model.CONTROLLERS : fallbackControllers();
    const labels = model?.CATEGORY_LABELS ?? {};
    const groups = new Map<string, ControllerMeta[]>();
    for (const entry of list) {
      const category = entry.category || "其他";
      const bucket = groups.get(category) ?? [];
      bucket.push(entry);
      groups.set(category, bucket);
    }
    return [...groups.entries()].map(([category, items]) => ({
      category,
      label: labels[category] ?? category,
      items,
    }));
  }, [model]);

  /** 把一整行插到光标处（空行整行替换；行尾另起一行；行中就地拼接）。 */
  const insertLineAtCaret = useCallback(
    (line: string) => {
      const el = taRef.current;
      const full = textRef.current;
      const offset = el?.selectionStart ?? full.length;
      const lineStart = full.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
      const lineEndRaw = full.indexOf("\n", offset);
      const lineEnd = lineEndRaw === -1 ? full.length : lineEndRaw;
      const currentLine = full.slice(lineStart, lineEnd);
      const indent = /^\s*/.exec(currentLine)?.[0] ?? "";
      if (currentLine.trim() === "") {
        applyEdit(lineStart, lineEnd, `${indent}${line}`, lineStart + indent.length + caretInside(line, 0));
      } else if (lineEndRaw === -1 || full.slice(offset, lineEnd).trim() === "") {
        // 行尾：另起一行插到下面（`]` 后的尾随文本另说，整行插入更安全）。
        applyEdit(offset, offset, `\n${indent}${line}`, offset + 1 + indent.length + caretInside(line, 0));
      } else {
        applyEdit(offset, offset, line, offset + caretInside(line, 0));
      }
      hiddenRef.current = true;
      setPopup(null);
    },
    [applyEdit]
  );

  const insertPalette = useCallback(
    (entry: ControllerMeta) => {
      insertLineAtCaret(paletteLine(modelRef.current, entry));
    },
    [insertLineAtCaret]
  );

  /** 光标处的半截控制器名，作为向导的预选（`[Cha` → "Cha"）。 */
  const wizardSeed = useMemo(() => {
    const before = text.slice(0, caret.offset);
    const lineStart = before.lastIndexOf("\n") + 1;
    const chunk = before.slice(lineStart);
    const at = chunk.lastIndexOf("[");
    if (at === -1) return "";
    const after = chunk.slice(at + 1);
    return after.includes("(") || after.includes(")") ? "" : after.trim();
  }, [caret.offset, text]);

  /** stageModel.ts（task-10）：落盘后舞台坐标/解析改用它。 */
  const [stageModel, setStageModel] = useState<StageModelModule | null>(null);
  useEffect(() => {
    let alive = true;
    void loadStageModel().then((loaded) => {
      if (alive && loaded) setStageModel(loaded);
    });
    return () => {
      alive = false;
    };
  }, []);

  /** 舞台状态：演到「光标行 / 预览截断行」时的立绘与背景。 */
  const stageState = useMemo(() => {
    const upto = previewOpen && previewUpto > 0 ? previewUpto : caret.line;
    const lines = text.split("\n");
    let state: { chars: StageChar[]; background: StageBackground };
    try {
      const fromModel = stageModel?.parseStage?.(text, upto) as
        | { chars?: unknown[]; background?: StageBackground }
        | undefined;
      state = fromModel
        ? {
            chars: (fromModel.chars ?? []) as StageChar[],
            background: fromModel.background ?? null,
          }
        : stageStateAt(lines, upto);
    } catch (e) {
      pushLog("warn", "[editor] stageModel.parseStage 失败，退回内置解析：", e);
      state = stageStateAt(lines, upto);
    }
    if (!stageMoves.length) return state;
    // 拖动产生的像素微调：叠加在解析结果上（不改写 `name=`）。
    return {
      ...state,
      chars: state.chars.map((entry) => {
        const move = stageMoves.find((item) => item.slot === entry.slot);
        return move ? { ...entry, x: entry.x + move.x, y: entry.y + move.y } : entry;
      }),
    };
  }, [caret.line, previewOpen, previewUpto, stageMoves, stageModel, text]);

  const stageSlotLine = useCallback(
    (slot: Slot): number => {
      const lines = textRef.current.split("\n");
      for (let i = Math.min(caret.line, lines.length) - 1; i >= 0; i -= 1) {
        const raw = lines[i].trim();
        const match = /^\[\s*(character|charslot)\s*(?:\((.*)\))?\s*\]/i.exec(raw);
        if (!match) continue;
        const slotRaw = (argOf(match[2] ?? "", "slot") ?? "m").trim().toLowerCase();
        const found: Slot = slotRaw === "l" || slotRaw === "left" ? "l" : slotRaw === "r" || slotRaw === "right" ? "r" : "m";
        if (found === slot) return i + 1;
      }
      return 0;
    },
    [caret.line]
  );

  /**
   * 舞台拖动 → 改脚本。回写的**一律是引擎认的参数**：
   * - `stageModel.movePatch()`（task-10）返回整行时以它为准；
   * - 否则写回 `x=`/`y=`（引擎 `[Character]`/`[charslot]` 认的绝对偏移）；
   * - `delta` 由 StagePane 给出；若它给的是 CSS px，这里按 960×540 基准换算。
   * 该动作同时把对应行定位到光标（用户能看见改的是哪一行）。
   */
  const onStageMove = useCallback(
    (slot: Slot, delta: { x: number; y: number }, options?: { absolute?: boolean; canvas?: boolean }) => {
      const deltaIsCanvas = options?.canvas ?? true; // stage 契约：画布 px
      // task-10 的 `onMove(slot, {x,y})` 已是 **1280×720 画布 px**（整段拖拽总位移），
      // 所以这里**不再缩放**；`absolute:true`（或将来有别的单位）时才走旧路径。
      const rendered = stageHostRef.current?.getBoundingClientRect().width ?? 0;
      const scale = options?.absolute || deltaIsCanvas ? 1 : rendered > 0 ? STAGE_W / rendered : 1;
      const stage = { x: delta.x * scale, y: delta.y * scale };
      setStageMoves((prev) => [...prev.filter((item) => item.slot !== slot), { slot, ...stage }]);
      const line = stageSlotLine(slot);
      if (!line) return;
      const starts = lineStartsRef.current;
      const from = starts[line - 1] ?? 0;
      const to = (starts[line] ?? textRef.current.length + 1) - 1;
      const current = textRef.current.slice(from, to);
      // 优先 task-10 的 movePatch（它知道引擎真正的入参形状）；
      // 它没落盘 / 抛错 / 返回空 → 退回写 `x=`/`y=`（引擎同样认这两个键）。
      let next = "";
      try {
        const patched = stageModel?.movePatch?.(slot, stage.x, stage.y, { line: current });
        if (typeof patched === "string") next = patched;
        else if (patched?.line) next = patched.line;
        else if (patched?.patch) {
          next = Object.entries(patched.patch).reduce(
            (acc, [key, value]) => withArg(acc, key, value as string | number | boolean),
            current
          );
        }
      } catch (e) {
        pushLog("warn", "[editor] stageModel.movePatch 失败，退回写 x=/y=：", e);
      }
      if (!next) {
        const base = stageStateForSlot(current);
        next = withNumberArg(
          withNumberArg(current, "x", (base?.x ?? 0) + stage.x),
          "y",
          (base?.y ?? 0) + stage.y
        );
      }
      if (next === current) return;
      applyEdit(from, to, next, from);
    },
    [applyEdit, stageModel, stageSlotLine]
  );

  /** 光标所在行（1 基 → 0 基）与它的原文，供检视器/舞台共用。 */
  const caretLineIndex = Math.max(0, Math.min(lineStarts.length - 1, caret.line - 1));
  const caretLineText = useMemo(() => {
    const start = lineStarts[caretLineIndex] ?? 0;
    const end = (lineStarts[caretLineIndex + 1] ?? text.length + 1) - 1;
    return text.slice(start, end);
  }, [lineStarts, text, caretLineIndex]);

  /** 检视器改完一行：整行替换（保留当前光标 → 行首）。 */
  const onInspectorApply = useCallback(
    (next: string) => {
      const start = lineStartsRef.current[caretLineIndex] ?? 0;
      const end = (lineStartsRef.current[caretLineIndex + 1] ?? textRef.current.length + 1) - 1;
      const original = textRef.current.slice(start, end);
      if (next === original) return;
      // 双保险（task-9 的 `applyForm` 正常就给整行）：只有当**两边都有 `]`**、
      // 且新文本把 `]` 之后的正文整段丢了，才把原文的尾巴接回。
      // - 裸旁白（整行没有 `]`）→ 天然跳过，正文就是整行；
      // - `[aside]  旁白` / `[name="X"]  台词` → 新文本自己带正文，不动；
      // - 注释/空行 → 没有 `]`，跳过。
      let merged = next;
      const oldClose = original.indexOf("]");
      const newClose = next.indexOf("]");
      if (oldClose !== -1 && newClose !== -1) {
        const oldTail = original.slice(oldClose + 1);
        const newTail = next.slice(newClose + 1);
        if (oldTail.trim() && !newTail.trim()) merged = `${next.trimEnd()}${oldTail}`;
      }
      applyEdit(start, end, merged, start);
    },
    [applyEdit, caretLineIndex]
  );

  /** 舞台选中某个槽位：高亮并跳到对应的 `[Character]` 行。 */
  const onStageSelect = useCallback(
    (slot: Slot) => {
      setStageSelected(slot);
      const line = stageSlotLine(slot);
      if (line) jumpToLine(line);
    },
    [jumpToLine, stageSlotLine]
  );

  // ── 渲染 ──────────────────────────────────────────────────

  const title = meta.title || id || "（未命名剧本）";

  return (
    <div className={`editor-page${readOnly ? " readonly" : ""}`} ref={rootRef}>
      <div className="browser-header ed-header">
        <button className="back-icon" onClick={() => navigate(-1)} aria-label="返回">
          ◀
        </button>
        <div className="ed-title">
          <h1>{title}</h1>
          <span className="ed-sub">
            {id || "（无包 ID）"} · <code>{sourceName}</code>
            {loadState === "loading" ? " · 载入中…" : ""}
          </span>
        </div>
        <span className="ed-spacer" />
        <div className="ed-viewtabs">
          <button className="ed-btn" onClick={runLint} title="重新运行校验（实时诊断也会自动刷新）">
            校验
          </button>
          <button
            className="ed-btn"
            onClick={() => void openPreview()}
            title="用当前编辑内容直接开演整篇（不必先保存）"
          >
            预览
          </button>
          <button
            className="ed-btn"
            onClick={() => setShowInspector((value) => !value)}
            title="显示/隐藏控制器检视器"
          >
            {showInspector ? "收起检视器" : "检视器"}
          </button>
          <button
            className={`ed-btn${showBranch ? " on" : ""}`}
            onClick={() => setShowBranch((value) => !value)}
            disabled={!BranchGraphPart}
            title={
              BranchGraphPart
                ? "分支图（按 Decision/Predicate 画剧情走向；点击节点跳到该行）"
                : "分支图由并行任务交付；文件落盘后自动可用"
            }
          >
            ⌥ 分支图
          </button>
          <button
            className="ed-btn"
            onClick={() => {
              // 关掉了就先恢复显示（回到 dock），否则在浮动/停靠之间切换。
              if (!showPanel) {
                setShowPanel(true);
                setPanelWin({ kind: "dock", side: "right" });
                return;
              }
              setPanelWin((prev) =>
                prev.kind === "dock" ? floatFor(prev, bounds) : { kind: "dock", side: "right" }
              );
            }}
            title="右栏工具面板：显示 · 浮动 / 停靠（也可双击它的标题条；✕ 关闭）"
          >
            {showPanel ? "⧉ 面板" : "面板"}
          </button>
          <button
            className="ed-btn"
            onClick={() => setShowStage((value) => !value)}
            title="显示/隐藏舞台"
          >
            {showStage ? "收起舞台" : "舞台"}
          </button>
          <button
            className="ed-btn"
            onClick={() => setWizardOpen(true)}
            disabled={!ControllerWizardPart}
            title={
              ControllerWizardPart
                ? "图形化插入一个控制器（分类 → 指令 → 参数 → 预览 → 插入）"
                : "插入向导由并行任务交付；文件落盘后自动可用"
            }
          >
            插入控制器…
          </button>
          <button className="ed-btn" onClick={reload} title="放弃未保存改动，从磁盘重新载入">
            重新载入
          </button>
          <button
            className="ed-btn primary"
            onClick={() => void doSave()}
            disabled={busy === "save"}
            title="Ctrl+S"
          >
            {busy === "save" ? "保存中…" : "保存"}
          </button>
        </div>
        <span className={`ed-dirty${isDirty ? " on" : ""}`}>{isDirty ? "未保存" : "已保存"}</span>
      </div>

      {/* 行定位条：上一行/下一行 + 滑杆 + 「预览到此处」（截到该行、不必保存）。 */}
      <div className="ed-scrub">
        <button
          className="ed-scrub-btn"
          onClick={() => jumpToLine(Math.max(1, caret.line - 1))}
          disabled={caret.line <= 1}
          title="光标上移一行"
        >
          ▲ 上一行
        </button>
        <button
          className="ed-scrub-btn"
          onClick={() => jumpToLine(Math.min(lineStarts.length, caret.line + 1))}
          disabled={caret.line >= lineStarts.length}
          title="光标下移一行"
        >
          ▼ 下一行
        </button>
        <span>定位</span>
        <input
          type="range"
          min={1}
          max={Math.max(1, lineStarts.length)}
          value={Math.min(lineStarts.length, Math.max(1, scrubLine))}
          aria-label="剧本行定位"
          onChange={(event) => jumpToLine(Number(event.target.value))}
        />
        <input
          type="number"
          min={1}
          max={Math.max(1, lineStarts.length)}
          value={Math.min(lineStarts.length, Math.max(1, scrubLine))}
          aria-label="行号"
          onChange={(event) => jumpToLine(Number(event.target.value) || 1)}
        />
        <span>/ {lineStarts.length}</span>
        <span className="grow" />
        {previewUpto > 0 && <span>预览截到第 {previewUpto} 行</span>}
        <button
          className="ed-scrub-btn"
          onClick={() => void openPreview(caret.line)}
          title="按当前光标行截断剧本，从第一行开演到此处（不必先保存）"
        >
          ▶ 预览到此处
        </button>
        {previewUpto > 0 && (
          <button className="ed-scrub-btn" onClick={() => void openPreview()} title="预览整篇">
            预览全篇
          </button>
        )}
      </div>

      {!inTauri() && (
        <div className="ed-alert" role="status">
          <span>只读演示：当前不在桌面应用内，保存 / 载入包内文件需要 Tauri（可加 `?text=…` 直接试编辑）。</span>
        </div>
      )}

      {error && (
        <div className="ed-alert" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="关闭提示">
            ✕
          </button>
        </div>
      )}

      <div className="ed-split">
        <div className="ed-code">
          <div className="ed-code-scroll" ref={scrollerRef}>
            <div className="ed-gutter" aria-hidden="true" ref={gutterRef} style={{ minHeight: docSize.height }}>
              {lineStarts.map((_, index) => {
                const severity = diagnosticsByLine.get(index + 1);
                return (
                  <span
                    key={index}
                    className={`ed-gutter-line${caret.line === index + 1 ? " current" : ""}${severity ? ` ${severity}` : ""}`}
                    title={lineLabel(text, index + 1)}
                    onClick={() => jumpToLine(index + 1)}
                  >
                    {index + 1}
                  </span>
                );
              })}
            </div>
            <div
              className="ed-code-lines"
              ref={linesRef}
              style={{
                // 宽 = max(视口, 最长行)；高 = 行数 × LH + padding。
                // 横向滚动因此真的生效（`min-width` 撑开 .ed-code-scroll）。
                width: docSize.width > 0 ? `max(100%, ${Math.ceil(docSize.width) + PAD_X * 2}px)` : "100%",
                height: docSize.height,
              }}
            >
              <div className="ed-linebar" style={{ top: (caret.line - 1) * LH, height: LH }} />
              <textarea
                ref={taRef}
                className="ed-textarea"
                value={text}
                spellCheck={false}
                wrap="off"
                aria-label="剧本正文"
                placeholder={"[Character(name=\"char_002_amiya_1\", fadetime=0.5)]\n[name=\"阿米娅\"]  这边走，博士。"}
                onChange={(event) => {
                  hiddenRef.current = false;
                  const nextValue = event.target.value;
                  const previous = textRef.current;
                  if (nextValue !== previous) {
                    // `onChange` 只给最终值；用最小 diff 还原"插入了什么"，
                    // 交给历史栈决定合并（连续打字 = 一条）。
                    const change = diffOf(previous, nextValue);
                    commitHistory(
                      { text: previous, sel: [change.from, change.to] },
                      { text: nextValue, sel: [change.from + change.insert.length, change.from + change.insert.length] },
                      change.insert,
                      "typing"
                    );
                  }
                  setText(nextValue);
                  setDirty(true);
                  textRef.current = nextValue;
                  requestAnimationFrame(syncCaret);
                }}
                onSelect={syncCaret}
                onClick={syncCaret}
                onKeyUp={syncCaret}
                onScroll={syncCaret}
                onMouseMove={(event) => hoverAt(event.clientX, event.clientY)}
                onMouseLeave={() => setHover(null)}
                onKeyDown={(event) => {
                  const mod = event.ctrlKey || event.metaKey;
                  if (mod && event.key.toLowerCase() === "s") {
                    event.preventDefault();
                    void doSave();
                    return;
                  }
                  if (mod && (event.key === " " || event.code === "Space")) {
                    event.preventDefault();
                    hiddenRef.current = false;
                    refreshPopupRef.current(false);
                    return;
                  }
                  if (popup) {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setPopup((prev) => (prev ? { ...prev, index: (prev.index + 1) % prev.items.length } : prev));
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setPopup((prev) =>
                        prev ? { ...prev, index: (prev.index - 1 + prev.items.length) % prev.items.length } : prev
                      );
                      return;
                    }
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      acceptCompletion();
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      hiddenRef.current = true;
                      setPopup(null);
                      return;
                    }
                  }
                  if (event.key === "Tab") {
                    if (popup) {
                      event.preventDefault();
                      acceptCompletion();
                      return;
                    }
                    if (tryTabSkeleton()) {
                      event.preventDefault();
                    }
                  }
                }}
              />
              {/* 不可见的测量锚点：最长行宽 / 前缀像素宽都在这里量（真实 DOM，
                  与 textarea 同字体同字号，保证逐像素对齐）。 */}
              <span className="ed-anchor" aria-hidden="true" ref={anchorRef} />
              {popup && (
                <div className="ed-popup" style={{ left: popup.x, top: popup.y }}>
                  {popup.items.map((item, index) => (
                    <div
                      key={`${item.label}-${index}`}
                      className={`ed-popup-item${index === popup.index ? " active" : ""}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        setPopup((prev) => (prev ? { ...prev, index } : prev));
                        acceptCompletion();
                      }}
                    >
                      {/* 有些模型项返回的是 rich 展示对象；统一转字符串后再渲染。 */}
                      <span>{typeof item.display === "string" ? item.display : String(item.label ?? "")}</span>
                      {typeof item.detail === "string" && item.detail && <small>{item.detail}</small>}
                    </div>
                  ))}
                </div>
              )}
              {hover && (
                <div className="ed-hover" style={{ left: hover.x, top: hover.y }}>
                  <div className="ed-hover-title">{String(hover.info.title ?? "指令")}</div>
                  <div>{String(hover.info.summary ?? "（没有说明）")}</div>
                  {hoverParamText(hover.info.param) && (
                    <div className="ed-hover-ref">参数 {hoverParamText(hover.info.param)}</div>
                  )}
                  {hover.info.anchor && <div className="ed-hover-ref">参考：{hover.info.anchor}</div>}
                </div>
              )}
            </div>
          </div>

          {loadState === "ready" && !text.trim() && (
            <div className="ed-code-empty">
              这个剧本包里的 <code>{sourceName}</code> 是空的。直接开写，然后 Ctrl+S 保存。
            </div>
          )}

          {loadState === "empty" && (
            <div className="ed-code-empty">
              <p>
                空态：<code>{id || "（无包 ID）"}</code> 还没读到剧本。
              </p>
              <p>
                在桌面应用里，请从「同人剧本」页进入；可用 <code>[Cha</code> + Tab 起手，
                或点右侧「控制器」面板插入骨架。
              </p>
            </div>
          )}
        </div>

        {showPanel && (
        <InspectorWindow
          title="工具面板"
          state={panelWin}
          onChange={(next) => setPanelWin(clampWindowState(next, bounds))}
          minW={280}
          minH={200}
          bounds={bounds}
          storageKey="prts-editor-windows:panel"
          onClose={() => setShowPanel(false)}
        >
        <div className="ed-panel">
          <div className="ed-tabs">
            <button className={`ed-tab${tab === "diag" ? " active" : ""}`} onClick={() => setTab("diag")}>
              诊断
              {diagnostics.length > 0 && <span className="ed-tab-count">{diagnostics.length}</span>}
            </button>
            <button className={`ed-tab${tab === "palette" ? " active" : ""}`} onClick={() => setTab("palette")}>
              控制器
            </button>
            <button className={`ed-tab${tab === "info" ? " active" : ""}`} onClick={() => setTab("info")}>
              剧本信息
            </button>
          </div>

          <div className="ed-panel-body">
            {/* 控制器检视器（task-9 交付）：常驻在面板顶部，整行改参数。 */}
            {showInspector && (
              <div className="ed-inspector" data-editor-part="inspector">
                {ControllerInspectorPart ? (
                  <Suspense fallback={<div className="ed-inspector-empty">正在载入控制器检视器…</div>}>
                    <ControllerInspectorPart
                      model={model ?? null}
                      line={caretLineText}
                      lineIndex={caretLineIndex}
                      onApply={onInspectorApply}
                      height={190}
                    />
                  </Suspense>
                ) : (
                  <div className="ed-inspector-empty">
                    第 {caret.line} 行：<code>{caretLineText || "（空行）"}</code>
                    <br />
                    （控制器检视器由并行任务交付；文件落盘后自动挂载）
                  </div>
                )}
              </div>
            )}
            {tab === "diag" && (
              <>
                {!model && <p className="ed-hint">编辑器模型尚未加载：当前只做基础统计（未知指令按模型就绪后复核）。</p>}
                {diagnostics.length === 0 ? (
                  <div className="ed-diag-ok">没有发现问题（{controllerCount} 条控制器 / {doc.stats?.decisions ?? 0} 个决策点）。</div>
                ) : (
                  <div className="ed-diag">
                    {diagnostics.map((item, index) => (
                      <button
                        key={`${item.line}-${item.code}-${index}`}
                        className={`ed-diag-item ${item.severity}`}
                        onClick={() => (item.line ? jumpToLine(item.line) : undefined)}
                        title={`跳到第 ${item.line || "?"} 行：${item.message}`}
                      >
                        <span className="ed-diag-code">
                          {String(item.code)}
                          {item.line ? ` L${item.line}` : ""}
                        </span>
                        <span>
                          {item.message}
                          {item.fix ? <small className="ed-diag-fix">{`修法：${String(item.fix)}`}</small> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {tab === "palette" && (
              <div className="ed-palette">
                <p className="ed-hint">点击插入骨架到光标处（Tab 也能补全半截控制器）。</p>
                {!model && <p className="ed-hint">降级模式：使用内置骨架表；编辑器模型就绪后改为完整指令表。</p>}
                {paletteGroups.map((group) => (
                  <div className="ed-palette-group" key={group.category}>
                    <h3>{group.label}</h3>
                    <div className="ed-palette-grid">
                      {group.items.map((entry) => (
                        <button
                          key={`${group.category}-${entry.command}`}
                          className={`ed-palette-btn${entry.tier ? ` tier-${entry.tier}` : ""}`}
                          onClick={() => insertPalette(entry)}
                          title={entry.summary || entry.example || entry.canonical || entry.command}
                        >
                          {entry.canonical ?? entry.command}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === "info" && (
              <div className="ed-info">
                <p className="ed-hint">pack.json 的字段；「保存剧本信息」只写 pack.json（「保存」会连正文一起写）。</p>
                <label className="ed-field">
                  <span>标题 title</span>
                  <input
                    className="ed-input"
                    value={meta.title}
                    onChange={(event) => setMeta((prev) => ({ ...prev, title: event.target.value }))}
                  />
                </label>
                <label className="ed-field">
                  <span>章节 chapter</span>
                  <input
                    className="ed-input"
                    value={meta.chapter}
                    onChange={(event) => setMeta((prev) => ({ ...prev, chapter: event.target.value }))}
                  />
                </label>
                <label className="ed-field">
                  <span>简介 description</span>
                  <input
                    className="ed-input"
                    value={meta.description}
                    onChange={(event) => setMeta((prev) => ({ ...prev, description: event.target.value }))}
                  />
                </label>
                <label className="ed-field">
                  <span>分支点 branchPoints（逗号分隔）</span>
                  <input
                    className="ed-input"
                    value={meta.branchPoints}
                    onChange={(event) => setMeta((prev) => ({ ...prev, branchPoints: event.target.value }))}
                  />
                </label>
                <button className="ed-btn" onClick={() => void saveMetaOnly()} disabled={busy === "meta"}>
                  {busy === "meta" ? "保存中…" : "保存剧本信息"}
                </button>

                <div className="ed-source">
                  <div>
                    「源文件」：<code>{sourceName}</code>
                  </div>
                  <em>
                    {sourceName === "script.txt"
                      ? "读取顺序 script.txt → source/probe.txt。"
                      : sourceName === "source/probe.txt"
                        ? "script.txt 不存在，正文来自 source/probe.txt；保存也写回它（并在需要时创建目录）。"
                        : "来自 URL 的 ?text=（只读演示）；桌面应用内按 script.txt → source/probe.txt 的顺序读取。"}
                  </em>
                  <em>包 ID：{id || "（无）"}（{readOnly ? "浏览器只读演示" : "Tauri 运行中"}）</em>
                </div>
              </div>
            )}
          </div>
        </div>
        </InspectorWindow>
        )}
      </div>

      {/* 分支图（task-16 交付）：Decision/Predicate 的走向图；点节点跳行。 */}
      {showBranch && (
        <InspectorWindow
          title="分支图"
          state={branchWin}
          onChange={(next) => setBranchWin(clampWindowState(next, bounds, 320, 200))}
          minW={320}
          minH={200}
          bounds={bounds}
          storageKey="prts-editor-windows:branch"
          icon="⌥"
          onClose={() => setShowBranch(false)}
        >
          {BranchGraphPart ? (
            <Suspense fallback={<div className="ed-inspector-empty">正在载入分支图…</div>}>
              <BranchGraphPart
                text={text}
                caretLine={caret.line}
                onJumpToLine={(line: number) => jumpToLine(line)}
                onPatch={(nextText: string, line?: number) => {
                  // 图上改分支 = 一次"整体替换"（撤销可回到改前）。
                  const before: HistoryEntry = { text: textRef.current, sel: [0, 0] };
                  const after: HistoryEntry = { text: nextText, sel: [0, 0] };
                  if (nextText === before.text) return;
                  commitHistory(before, after, "");
                  textRef.current = nextText;
                  pendingSel.current = [0, 0];
                  setText(nextText);
                  setDirty(true);
                  if (line) jumpToLine(line);
                }}
                onClose={() => setShowBranch(false)}
                height={bounds.h - 220}
              />
            </Suspense>
          ) : (
            <div className="ed-inspector-empty">
              分支图由并行任务交付（<code>frontend/src/components/editor/BranchGraph.tsx</code>）；文件落盘后自动挂载。
              当前 {doc.stats?.decisions ?? 0} 个决策点 / {doc.stats?.combos ?? 0} 条组合。
            </div>
          )}
        </InspectorWindow>
      )}

      {/* 插入向导（task-9 交付）：分类 → 指令 → 参数 → 预览 → 插入到光标。 */}
      {wizardOpen && ControllerWizardPart && (
        <div className="ed-wizard" data-editor-part="wizard" onClick={(event) => {
          if (event.target === event.currentTarget) setWizardOpen(false);
        }}>
          <div className="ed-wizard-card">
            <Suspense fallback={<div className="ed-inspector-empty">正在载入插入向导…</div>}>
              <ControllerWizardPart
                model={model ?? null}
                open={wizardOpen}
                onClose={() => setWizardOpen(false)}
                onInsert={(line: string) => {
                  insertLineAtCaret(line);
                  setWizardOpen(false);
                }}
                initialCommand={wizardSeed}
              />
            </Suspense>
          </div>
        </div>
      )}

      {/* 舞台（task-10 交付）：按「演到光标行」的状态画出 16:9 画面；
          拖动立绘 = 改该行 `x=`/`y=`。文件缺失时只显示占位行。 */}
      {showStage && (
      <InspectorWindow
        title="舞台"
        state={stageWin}
        onChange={(next) => setStageWin(clampWindowState(next, bounds, 280, 160))}
        minW={280}
        minH={160}
        bounds={bounds}
        storageKey="prts-editor-windows:stage"
        icon="🎬"
        onClose={() => setShowStage(false)}
      >
      <div className="ed-stage" data-editor-part="stage" style={stageWin.kind === "dock" ? { height: 232 } : { height: "100%" }}>
        <div className="ed-stage-host" ref={stageHostRef}>
          {StagePanePart ? (
            <Suspense fallback={<em className="ed-stage-host-empty">正在载入舞台…</em>}>
              <StagePanePart
                chars={stageState.chars}
                background={stageState.background}
                height={214}
                onMove={onStageMove}
                onSelect={onStageSelect}
                selected={stageSelected}
              />
            </Suspense>
          ) : (
            <em className="ed-stage-host-empty">
              舞台预览由并行任务交付（frontend/src/components/editor/StagePane.tsx）；文件落盘后自动挂载。
              当前解析：{stageState.chars.length} 个立绘 / 背景 {backgroundLabel(stageState.background)}
            </em>
          )}
        </div>
      </div>
      </InspectorWindow>
      )}

      {previewOpen && (
        <InspectorWindow
          title="预览"
          state={{ kind: "dock", side: previewWin.kind === "dock" ? previewWin.side : "right" }}
          onChange={(next) => setPreviewWin(clampWindowState(next, bounds, 320, 200))}
          minW={320}
          minH={200}
          bounds={bounds}
          storageKey="prts-editor-windows:preview"
          onClose={() => { closePreview(); setPreviewOpen(false); }}
        >
        <div
          className={`ed-preview${previewFull ? " full" : ""}${previewWin.kind === "float" ? " float" : ""}`}
          style={previewWin.kind === "float" ? { height: "100%" } : { height: previewFull ? "62%" : previewHeight }}
        >
          <div className="ed-preview-resize" onPointerDown={onDragStart} title="拖动调整高度" />
          <div className="ed-preview-bar">
            <span>预览</span>
            <span className="grow">{previewStatus}</span>
            <button
              className="ed-btn"
              onClick={() => void openPreview(previewUpto > 0 ? previewUpto : undefined)}
            >
              重新载入预览
            </button>
            <button className="ed-btn" onClick={() => setPreviewFull((value) => !value)}>
              {previewFull ? "还原" : "放大"}
            </button>
            <button className="ed-btn" onClick={() => { closePreview(); setPreviewOpen(false); }}>
              关闭
            </button>
          </div>
          <div className="ed-preview-frame" ref={hostRef} />
        </div>
        </InspectorWindow>
      )}

      <div className="ed-status">
        <span>
          {caret.line}:{caret.col}
        </span>
        <span>
          控制器 {controllerCount} / 决策 {doc.stats?.decisions ?? 0}
        </span>
        <span>行数 {lineStarts.length}</span>
        <span className={errorCount ? "error" : ""}>
          {errorCount ? `${errorCount} 个错误` : diagnostics.length ? `${diagnostics.length} 条提示` : "无诊断"}
        </span>
        <button
          className="ed-status-btn"
          onClick={() => doUndo()}
          disabled={historySizes.undo === 0}
          title="撤销（Ctrl+Z）"
        >
          撤销 {historySizes.undo}
        </button>
        <button
          className="ed-status-btn"
          onClick={() => doRedo()}
          disabled={historySizes.redo === 0}
          title="重做（Ctrl+Shift+Z / Ctrl+Y）"
        >
          重做 {historySizes.redo}
        </button>
        <span className="grow" />
        <span>{previewOpen ? (previewLive ? "预览运行中" : "预览准备中") : "预览关闭"}</span>
        <span className={isDirty ? "dirty" : "saved"}>{busy ? "保存中…" : isDirty ? "未保存" : "已保存"}</span>
      </div>
    </div>
  );
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseMetaFromText(text: string | null): Record<string, unknown> | null {
  if (typeof text !== "string" || !text.trim()) return null;
  return safeJson(text);
}
