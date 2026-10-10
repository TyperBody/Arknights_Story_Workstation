/**
 * `stageCatalog.ts`（P2）—— 舞台素材（背景 / 立绘）的**候选清单 + 选择 + 源改写**。
 *
 * BRIEF-workbench-v1 §2.6。三个职责：
 *
 * 1. `bgCandidates()` / `charCandidates()` —— 从**真实数据表**派生候选：
 *    `loadStoryRuntime()` 的 `data`（`Record<url, table>`）、仓库快照
 *    `build/fanfic/upstream.json`、或任意 `string[]` / `{key: weight}` / `Set` / `Map`。
 *    **去重 + 稳定排序**（随包样例优先 → 用量降序 → key 字母序），不造数据。
 * 2. `defaultStageSelection()` —— 「从素材里选」的默认选中：**随包内置的 8 张
 *    样例**（`src-tauri/resources/assets/sample/`，离线可用）。
 * 3. `resolveStageUrl(key, source)` —— 素材源改写：**优先** P1 的
 *    `src/akstage/assetRouting.js::mirrorUrl(source, raw)`（动态载入，P1 未落地
 *    也能编译）；拿不到就回落 `https://torappu.prts.wiki/...` 直链
 *    （`source = "custom"` 时套用设置里的 `customMirror` 模板）。
 *
 * 纯计算、无 React；`key` 一律**规范化**：绝对 URL → 折成 `bg_xxx` /
 * `角色/贴图`；`bg_forest` / `char_002_amiya_1/char_002_amiya_1` 原样保留。
 */

import { getAppSettings } from "./appSettings";
import { backgroundUrl, characterUrl } from "../components/editor/stageModel";

/** 素材种类。 */
export type StageAssetKind = "background" | "character";

/** 一条候选素材。 */
export interface StageAsset {
  /** 规范化 key（背景 = `bg_xxx`；立绘 = `角色/贴图`）。 */
  key: string;
  /** 人话标签（下拉里显示）。 */
  label: string;
  /** 背景 / 立绘。 */
  kind: StageAssetKind;
  /** 随包样例里有这张 → 离线可直接显示。 */
  bundled: boolean;
  /** 数据表给的用量/权重（有就按它降序；没有按字母序）。 */
  uses?: number;
}

/** `bgCandidates` / `charCandidates` 接受的输入：字符串、数组、Set、Map、表。 */
export type CandidateInput =
  | string
  | Iterable<string>
  | Set<string>
  | Map<string, number>
  | Record<string, unknown>
  | Array<Record<string, unknown>>
  | null
  | undefined;

/** runtime `data` 的宽松形态（`Record<url, table>`）。 */
export type RuntimeLikeData = Record<string, unknown> | null | undefined;

/**
 * 随包内置的**样例素材**（`src-tauri/resources/assets/sample/bundles.json` 的
 * 8 条 key；`SOURCES.md` 记了哈希）。离线首启就能选、能显示。
 */
export const BUNDLED_STAGE_KEYS: string[] = [
  "bg_black",
  "bg_room_2",
  "bg_forest",
  "bg_rhodeslounge_2",
  "char_002_amiya_1/char_002_amiya_1",
  "char_002_amiya_1/char_002_amiya_3",
  "char_010_chen_1/char_010_chen_1",
  "char_130_doberm_ex/char_130_doberm_ex",
];

/** 内置样例表（`bundles.json` 的 8 条，逐字；自己带 key → 文件）。 */
export const BUNDLED_STAGE_TABLE: Record<string, string> = {
  "torappu.prts.wiki/assets/avg/background/bg_black.png": "bg_black.webp",
  "torappu.prts.wiki/assets/avg/background/bg_room_2.png": "bg_room_2.webp",
  "torappu.prts.wiki/assets/avg/background/bg_forest.png": "bg_forest.webp",
  "torappu.prts.wiki/assets/avg/background/bg_rhodeslounge_2.png": "bg_rhodeslounge_2.webp",
  "torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_1.png": "char_002_amiya_1.webp",
  "torappu.prts.wiki/assets/avg/characters/char_002_amiya_1/char_002_amiya_3.png": "char_002_amiya_3.webp",
  "torappu.prts.wiki/assets/avg/characters/char_010_chen_1/char_010_chen_1.png": "char_010_chen_1.webp",
  "torappu.prts.wiki/assets/avg/characters/char_130_doberm_ex/char_130_doberm_ex.png": "char_130_doberm_ex.webp",
};

/** 设计里的素材源（与 P1 `appSettings.ts::MirrorSource` 同值域）。 */
export const STAGE_SOURCES: Array<{ id: string; label: string }> = [
  { id: "pack", label: "包内 + 官方直连" },
  { id: "jsd", label: "jsDelivr 镜像" },
  { id: "fastly", label: "Fastly 镜像" },
  { id: "ghproxy", label: "gh-proxy 镜像" },
  { id: "custom", label: "自定义源" },
];

const ABSOLUTE = /^(https?:|data:|blob:|asset:|prts-cdn:)/i;
const IMAGE_EXT = /\.(png|webp|jpg|jpeg)(?:[?#].*)?$/i;

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * 把任意形态的素材引用**规范化**成 catalog key：
 * - `…/background/bg_forest.png` → `bg_forest`（背景键小写）；
 * - `…/characters/char_002_amiya_1/char_002_amiya_1.png` →
 *   `char_002_amiya_1/char_002_amiya_1`（立绘目录名保留大小写）；
 * - `bg_forest` / `char_x/char_x` → 原样（`bg*` 前缀小写化）。
 */
export function normalizeStageKey(value: unknown): string {
  const raw = text(value);
  if (!raw) return "";
  if (!ABSOLUTE.test(raw) && !raw.includes("/assets/avg/")) {
    return raw.startsWith("bg") ? raw.toLowerCase() : raw;
  }
  try {
    const pathname = ABSOLUTE.test(raw) ? new URL(raw).pathname : raw.replace(/^[^/]+\/\/?(?=assets\/avg\/)/, "/");
    const parts = pathname.split("/").filter(Boolean);
    const file = parts.pop() ?? "";
    const base = file.replace(IMAGE_EXT, "");
    if (!parts.length) return base;
    const last = parts[parts.length - 1];
    if (last === "characters") return base; // …/characters/<name>.png
    if (parts[parts.length - 2] === "characters" && base) return `${last}/${base}`;
    if (last === "background") return base.toLowerCase();
    return base || raw;
  } catch {
    return raw;
  }
}

/** 背景还是立绘：显式 `kind` 优先；否则按 key 形态判定（含 `/` = 立绘）。 */
export function classifyStageKey(value: unknown, kind?: StageAssetKind): StageAssetKind {
  if (kind) return kind;
  const key = text(value).toLowerCase();
  if (!key) return "background";
  if (key.includes("/")) return "character";
  if (key.startsWith("bg") || key.startsWith("ui_")) return "background";
  if (/^(char|avg|npc|enemy|token|trap)/.test(key)) return "character";
  return "background";
}

/** 立绘 key → 贴图 key（`char_002_amiya_1` → `char_002_amiya_1/char_002_amiya_1`）。 */
export function characterImageKey(value: unknown): string {
  const raw = text(value);
  if (!raw || raw.includes("/") || ABSOLUTE.test(raw)) return raw;
  return raw.startsWith("char_") ? `${raw}/${raw}` : raw;
}

/** 一条素材的**官方直链**（与 `stageModel.backgroundUrl` / `characterUrl` 同形）。 */
export function stageAssetRawUrl(key: string, kind?: StageAssetKind): string {
  const value = normalizeStageKey(key);
  if (!value) return "";
  if (ABSOLUTE.test(value)) return value;
  return classifyStageKey(value, kind) === "character"
    ? (characterUrl(characterImageKey(value)) ?? "")
    : (backgroundUrl(value) ?? "");
}

/** 把候选输入摊平成 `[key, uses]` 流。 */
function* entriesOf(input: CandidateInput): Generator<[string, number]> {
  if (!input) return;
  if (typeof input === "string") {
    yield [input, 0];
    return;
  }
  if (input instanceof Map) {
    for (const [key, value] of input) yield [String(key), Number(value) || 0];
    return;
  }
  if (input instanceof Set || Array.isArray(input)) {
    yield* listOf(input as Iterable<unknown>);
    return;
  }
  if (typeof input === "object") {
    // `{key: weight}` 的表：键才是素材（`background.json` 的值是 ppu，不是素材）。
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      yield [key, Number(value) || 0];
    }
  }
}

/** 条目列表（数组/Set）：字符串 = key；对象取它的 key-ish 字段；`{key}` 优先原样。 */
function* listOf(items: Iterable<unknown>): Generator<[string, number]> {
  for (const item of items) {
    if (typeof item === "string") {
      yield [item, 0];
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const raw = record.key ?? record.image ?? record.path ?? record.name ?? record.url ?? "";
    if (raw && typeof raw === "object") continue;
    yield [String(raw), Number(record.uses ?? record.count ?? 0) || 0];
  }
}

/** 随包样例按种类拆开：键的 URL 形态决定它是背景还是立绘。 */
export const BUNDLED_KEYS_BY_KIND: { background: string[]; character: string[] } = (() => {
  const out: { background: string[]; character: string[] } = { background: [], character: [] };
  for (const url of Object.keys(BUNDLED_STAGE_TABLE)) {
    const key = normalizeStageKey(url);
    if (!key) continue;
    const kind: StageAssetKind = url.includes("/characters/") ? "character" : "background";
    if (!out[kind].includes(key)) out[kind].push(key);
  }
  return out;
})();

const isBundled = (key: string, kind: StageAssetKind): boolean =>
  BUNDLED_KEYS_BY_KIND[kind].includes(key) || BUNDLED_STAGE_KEYS.includes(key) && classifyStageKey(key) === kind;

/** 去重 + 稳定排序：随包样例优先 → 用量降序 → key 字母序。 */
function toAssets(inputs: CandidateInput[], kind: StageAssetKind): StageAsset[] {
  const byKey = new Map<string, StageAsset>();
  for (const input of inputs) {
    for (const [rawKey, uses] of entriesOf(input)) {
      const key = normalizeStageKey(rawKey);
      if (!key || classifyStageKey(key) !== kind) continue;
      const previous = byKey.get(key);
      const bundled = isBundled(key, kind);
      if (previous) {
        if (uses > (previous.uses ?? 0)) previous.uses = uses;
        previous.bundled = previous.bundled || bundled;
        continue;
      }
      byKey.set(key, {
        key,
        label: labelOf(key, kind),
        kind,
        bundled,
        uses: uses > 0 ? uses : undefined,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.bundled !== b.bundled) return a.bundled ? -1 : 1;
    if ((b.uses ?? 0) !== (a.uses ?? 0)) return (b.uses ?? 0) - (a.uses ?? 0);
    return a.key.localeCompare(b.key);
  });
}

/** 候选的显示名：背景 `bg_forest` → `背景 bg_forest`；立绘 `a/b` → `立绘 a`。 */
export function labelOf(key: string, kind: StageAssetKind = classifyStageKey(key)): string {
  return kind === "background" ? `背景 ${key}` : `立绘 ${key.split("/")[0]}`;
}

/** 背景候选。零参数 = 只用随包样例；给了表/数组就并进去（去重）。 */
export function bgCandidates(...inputs: CandidateInput[]): StageAsset[] {
  return toAssets([...inputs, BUNDLED_KEYS_BY_KIND.background], "background");
}

/** 立绘候选。零参数 = 只用随包样例；给了表/数组就并进去（去重）。 */
export function charCandidates(...inputs: CandidateInput[]): StageAsset[] {
  return toAssets([...inputs, BUNDLED_KEYS_BY_KIND.character], "character");
}

/** 从 runtime `data` / upstream 快照里挑出 `character.json` / `background.json` 两张表。 */
export function tablesFromRuntime(data: RuntimeLikeData): {
  characters: Record<string, unknown> | null;
  backgrounds: Record<string, unknown> | null;
} {
  const pick = (table: unknown): Record<string, unknown> | null =>
    table && typeof table === "object" && !Array.isArray(table) ? (table as Record<string, unknown>) : null;
  if (!data || typeof data !== "object") return { characters: null, backgrounds: null };
  const record = data as Record<string, unknown>;
  const tables = [record, pick((record.bundle as Record<string, unknown> | undefined)?.data), pick(record.data)]
    .filter(Boolean) as Array<Record<string, unknown>>;
  let characters: Record<string, unknown> | null = null;
  let backgrounds: Record<string, unknown> | null = null;
  for (const table of tables) {
    for (const [url, value] of Object.entries(table)) {
      if (/character\.json/i.test(url)) characters ??= pick(value);
      else if (/background\.json/i.test(url)) backgrounds ??= pick(value);
    }
  }
  return { characters, backgrounds };
}

/**
 * 由 runtime/上游表派生**两组**候选（一次拿全）。
 * - `background.json` 的**键**就是背景素材（值是 ppu，不是素材）；
 * - `character.json` 的条目 → 贴图 key（`{base: {array:[{image}]}}`）。
 */
export function candidatesFromRuntime(data: RuntimeLikeData): {
  backgrounds: StageAsset[];
  characters: StageAsset[];
} {
  const { characters, backgrounds } = tablesFromRuntime(data);
  return {
    backgrounds: bgCandidates(backgrounds ? Object.keys(backgrounds) : null),
    characters: charCandidatesFromTable(characters),
  };
}

/** 由角色表条目派生立绘候选：`{base: {array:[{image}]}}` → `角色/贴图`。 */
export function charCandidatesFromTable(table: RuntimeLikeData): StageAsset[] {
  if (!table || typeof table !== "object") return charCandidates();
  const names: string[] = [];
  for (const [base, value] of Object.entries(table as Record<string, unknown>)) {
    const entry = value as Record<string, unknown> | null;
    const first = Array.isArray(entry?.array) ? (entry?.array as Array<Record<string, unknown>>)[0] : null;
    const image = text(first?.image);
    if (image) names.push(image.includes("/") ? image : `${base}/${image}`);
    else if (base) names.push(base);
  }
  return charCandidates(names);
}

/** 编辑器「从素材里选」的默认选中：随包样例（离线可显示）。 */
export function defaultStageSelection(): string[] {
  return [...BUNDLED_KEYS_BY_KIND.background, ...BUNDLED_KEYS_BY_KIND.character];
}

/** 默认**背景**（随包样例第一张；`stageCatalog` 的候选表同序）。 */
export function defaultBackground(): string {
  return BUNDLED_KEYS_BY_KIND.background[0];
}

// ── 素材源改写（P1 `src/akstage/assetRouting.js` 优先） ─────────────────────

/** P1 的 `mirrorUrl` / `rewriteUrl` 等函数形状。 */
type MirrorFn = (...args: unknown[]) => unknown;

let routing: { fn: MirrorFn; order: "source-first" | "url-first" } | null = null;
let routingProbed = false;

/**
 * 动态载入 P1 的 `assetRouting.js`。用 `import.meta.glob`（**不是**静态 import）：
 * P1 未落地时 tsc 不会「找不到模块」，Vite 侧拿到 `{}`，落地后自动接上；
 * Node（harness / 离线自检）里没有 `import.meta.glob` → 同样安全返回 `{}`，
 * `resolveStageUrl` 直接走官方直链。
 */
async function loadRouting(): Promise<Record<string, unknown>> {
  const glob = (import.meta as unknown as { glob?: (pattern: string) => Record<string, () => Promise<unknown>> }).glob;
  if (typeof glob !== "function") return {};
  try {
    const loaders = glob("../../../src/akstage/assetRouting.js");
    const load = Object.values(loaders)[0];
    if (!load) return {};
    const module = (await load()) as Record<string, unknown> & { default?: Record<string, unknown> };
    return module?.default && typeof module.default === "object" ? { ...module.default, ...module } : module;
  } catch {
    return {};
  }
}

/** 在候选导出名里找改写函数（兼容 P1 可能的命名），并探一次参数序。 */
async function probeRouting(): Promise<void> {
  if (routingProbed) return;
  routingProbed = true;
  const module = await loadRouting();
  for (const name of ["mirrorUrl", "rewriteAssetUrl", "rewriteUrl", "resolveAssetUrl", "assetUrl"]) {
    const fn = module[name];
    if (typeof fn !== "function") continue;
    const candidate = fn as MirrorFn;
    const probe = "https://torappu.prts.wiki/assets/avg/background/bg_black.png";
    try {
      const first = candidate("pack", probe);
      if (typeof first === "string" && first.trim()) {
        routing = { fn: candidate, order: "source-first" };
        break;
      }
      const second = candidate(probe, "pack");
      if (typeof second === "string" && second.trim()) {
        routing = { fn: candidate, order: "url-first" };
        break;
      }
    } catch {
      routing = { fn: candidate, order: "source-first" };
      break;
    }
  }
}
// 载入即预热：第一次 `resolveStageUrl`（或 P1 落盘后的下一次调用）就有真路由表。
void probeRouting();

function fromRouting(source: string, raw: string): string {
  if (!routing) return "";
  try {
    const value = routing.order === "source-first" ? routing.fn(source, raw) : routing.fn(raw, source);
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

/** 自定义源模板：`{url}` = 原始直链、`{key}` = 规范化 key、`{path}` = URL 路径。 */
export function applyMirrorTemplate(template: string, key: string, raw: string): string {
  const value = text(template);
  if (!value) return "";
  return value
    .replaceAll("{url}", raw)
    .replaceAll("{key}", encodeURIComponent(key))
    .replaceAll("{path}", raw.replace(/^https?:\/\/[^/]+\//, ""));
}

/** 当前设置里的舞台素材源（`appSettings.stageSource`；读不到 → `"pack"`）。 */
export function stageSourceFromSettings(): string {
  try {
    const source = text(getAppSettings().stageSource);
    if (source) return source;
  } catch {
    // 无 localStorage / 无 React 环境：走默认源。
  }
  return "pack";
}

/** 当前设置里的自定义镜像模板（读不到 → `""`）。 */
export function customMirrorFromSettings(): string {
  try {
    return text(getAppSettings().customMirror);
  } catch {
    return "";
  }
}

/** 测试/热重载用：清掉源表探测缓存。 */
export function resetStageCatalogCache(): void {
  routingProbed = false;
  routing = null;
  void probeRouting();
}

/**
 * 素材 URL：`key`（`bg_forest` / `char_x/char_x` / 绝对 URL）→ 可直接 `<image href>`。
 *
 * - `source` 缺省 = 设置里的 `stageSource`，再缺省 `pack`；
 * - P1 的 `assetRouting`（`mirrorUrl(source, raw)`）一旦可用就优先；否则回落官方
 *   直链 `https://torappu.prts.wiki/assets/avg/{background|characters}/…png`；
 * - `source = "custom"` 且设置里有模板时按 `customMirror` 套 `{url}` / `{key}`；
 * - 空 key → `""`（调用方据此不渲染 `<image>`，避免空请求）。
 */
export function resolveStageUrl(key: string, source?: string): string {
  const value = normalizeStageKey(key);
  if (!value) return "";
  const kind = classifyStageKey(value);
  const raw = stageAssetRawUrl(value, kind);
  if (!raw) return "";
  const wanted = text(source) || stageSourceFromSettings();
  const mirrored = fromRouting(wanted, raw);
  if (mirrored) return mirrored;
  if (wanted === "custom") {
    const custom = applyMirrorTemplate(customMirrorFromSettings(), value, raw);
    if (custom) return custom;
  }
  return raw;
}

/** 批量改写（候选 → 可直接用的 URL；顺序与输入一致）。 */
export function resolveStageUrls(
  keys: Iterable<string>,
  source?: string,
): Array<{ key: string; url: string }> {
  return [...keys].map((key) => ({ key, url: resolveStageUrl(key, source) }));
}

/**
 * 「从素材里选」下拉的数据：默认选中 + 两类候选。`data` 可以是
 * `loadStoryRuntime()` 的 `data`、upstream 快照、或任意表；缺省 = 随包样例。
 */
export function stagePickerData(data?: RuntimeLikeData): {
  selection: string[];
  backgrounds: StageAsset[];
  characters: StageAsset[];
} {
  const derived = data ? candidatesFromRuntime(data) : { backgrounds: bgCandidates(), characters: charCandidates() };
  return {
    selection: defaultStageSelection(),
    backgrounds: derived.backgrounds.length ? derived.backgrounds : bgCandidates(),
    characters: derived.characters.length ? derived.characters : charCandidates(),
  };
}
