/**
 * 舞台坐标模型（task-10）——「立绘为什么乱飘」的答案在这里。
 *
 * ## 引擎事实（逐条核对 `.akresearch/repo/src/widgets/StoryPlayer/engine/`）
 *
 * 1) **绝对落点**来自 `character.json` 的 `pos`/`size`，与脚本无关
 *    （`rendering/PixiStoryRenderer.ts::setCharacter`）：
 *
 *    ```
 *    slotBaseX = { l: 440, m: 640, r: 840 }   // 旧 960 空间 [330,480,630] × 4/3
 *    root.x    = slotBaseX[slot] - size.x/2 + pos.x
 *    root.y    = 720 - size.y/2 - pos.y       // Unity y-up → 屏幕 y-down
 *    ```
 *    画布恒 1280×720（`engine/types.ts`）。`pos.x` 是像素偏移、**可为负**；
 *    `pos.y` 越大立绘越靠上（脚在画面外是常态——立绘贴图自带透明边）。
 *    不同角色/不同卡的 `pos`/`size` 都不同，**这就是"换个角色就飘"的来源**。
 *
 * 2) `[Character]` 的 `xpos1/ypos1/xpos2/ypos2` **只是入场滑入的起点**，不是落点
 *    （`runtime.ts:2425-2437` 的注释 + `PixiStoryRenderer::enterOffset`）：
 *    - 只在 `enter` 合法（原生按 ordinal 比 left/right/up/down，`"middle"` 无效）
 *      **且 x/y 同时给出**时生效，否则回落到 `_GenPosition`；
 *    - 值是 Int32、**槽位局部**（l/r 自带 ±200 补偿：`SLOT_ENTER_COMPENSATION`）；
 *    - Unity y-up → renderer y-down（`y = -Math.trunc(ypos)`）；
 *    - 滑入结束后 `SetCharPos(0,0,duration)` 把偏移**拉回 0** —— 所以"拖完又弹回原位"。
 *    要**留住**位置只有两条路：改 `character.json` / `patch/characters.json` 的 `pos`，
 *    或用运行时移动（`[CharacterAction(type="move", xpos=…, ypos=…)]`、
 *    `[charslot(action="setpos", posfrom="0,0", posto="x,y")]` → `_offset`，
 *    见 `runtime.ts:2466` 与 `runMoveAction`：`motionLayer.y = -actionY`）。
 *
 * 3) `[Character]` 的**清槽规则**（`runtime.ts` 的 `updates` 数组，MIDDLE→LEFT→RIGHT）：
 *    - 只有 `name`    → `m = name`，`l`、`r` **一起被清**；
 *    - `name`+`name2` → `l = name`、`r = name2`，`m` **被清**；
 *    - `name=""`       → 三个槽全清。
 *    `[charslot]` 只动 `slot=` 指定的槽；`slot` 缺省/空 = 清三个内置槽；
 *    `name="char_empty"` = 清该槽；**写了 slot 但 name 为空 = 什么都不做**。
 *    "立绘忽然没了"多半踩了这一条。
 *
 * 4) `focus`：`[Character]` 的判定是 `l/m: (unsigned)focus > 1 变暗`、
 *    `r: focus ∉ {0,2} 变暗`（`runtime.ts:2445-2449`）；`[charslot]` 用
 *    `focus="all|l|m|r"`（`resolveCharacterSlotFocusSlots`）。默认全亮。
 *
 * 5) 本文件的 `planOf()` 是 `src/akstage/local/library.js::resolvePlan` +
 *    `viewportSize` + `assetUrlFor` 的**逐行移植**（`scripts/fanfic/stage-selftest.mjs`
 *    对 50 个语料角色断言数值一致）：`bases.size` = 截图尺寸（缺省 1024×1024，
 *    `"%"` 按 1280 折算）÷ `render` 缩放，锚点 = 上游 `pos`。
 *
 * 6) **背景只影响背景自己**。`PixiStoryRenderer::nativeBackgroundRect` 按
 *    `background.json` 的 ppu（值就是 ppu：100 / 80 / 68.2464…）把贴图折成原生
 *    矩形（`贴图 / ppu * 100`）——`bg_cher_1`（1024×576、ppu 68.246）因此原生
 *    渲染 1500.44×844，是 17% 的居中过扫，**立绘一动不动**。所以"换背景立绘就
 *    飘"在上游数据里并不存在；能出现这种差异的只有包自己的
 *    `patch/resolutionRules.json`（见 `BackgroundRule`：`pos`/`size`/`render`
 *    会叠加到该背景上的所有立绘）。`nativeBackgroundRect()` 在同一处实现，
 *    供背景自身摆位复用。
 *
 * ## 本模块的契约
 *
 * - 屏幕增量 `{x, y}`：**1280×720 画布 px、y 向下**（拖右 `+x`，拖下 `+y`）；
 * - `character.json` 增量：`{x: +dx, y: -dy}`（`pos.y` 越大越靠上）；
 * - `[Character]` 的 `xpos*` 是**屏幕方向**的槽位局部偏移；`ypos*` 是 **Unity y-up**。
 *
 * 纯逻辑、零 React：`StagePane.tsx`、编辑器页与离线自检共用同一份实现。
 */
import {
  arg,
  parseCharacterRef,
  parseLine,
  parseScript,
} from "../../../../src/akstage/local/storyPack.js";

/** 引擎画布（`engine/types.ts` 的 `STORY_WIDTH`/`STORY_HEIGHT`，逻辑坐标恒定）。 */
export const STAGE_WIDTH = 1280;
export const STAGE_HEIGHT = 720;

/** 槽位基准 x（`PixiStoryRenderer::setCharacter` 的 `slotBaseX`）。 */
export const SLOT_BASE_X: Record<"l" | "m" | "r", number> = { l: 440, m: 640, r: 840 };

/** `_GenPosition` 的槽位补偿：水平入场时抵消槽位自身的偏移。 */
export const SLOT_ENTER_COMPENSATION: Record<string, number> = { l: 200, r: -200 };

/** 原生处理顺序 MIDDLE → LEFT → RIGHT（同帧同步）。 */
export const SLOT_ORDER = ["m", "l", "r"] as const;

/** `character.json` 缺条目时的兜底（= `engineBoot.ts::repairScenarioLinks` 的默认布局）。 */
export const FALLBACK_POS: Point = { x: 0, y: 160 };
export const FALLBACK_SIZE: Point = { x: 1024, y: 1024 };

/** `bases.size` 缺省（`library.js::viewportSize`）。 */
const DEFAULT_BASE_SIZE = 1024;

/** 上游表 URL（= `StoryPlayerBundle.data` 的键）。 */
export const CHARACTER_TABLE_URL = "https://torappu.prts.wiki/assets/avg/character.json";
export const BACKGROUND_TABLE_URL = "https://torappu.prts.wiki/assets/avg/background.json";

export type Slot = "l" | "m" | "r";
export type EnterDirection = "left" | "right" | "up" | "down";

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StageViewport {
  width: number;
  height: number;
}

/** `character.json` 的一条：上游原样（`groups`/`array` 可能缺省）。 */
export interface CharacterEntry {
  pos?: Point;
  size?: Point;
  render?: number;
  image?: string;
  name?: string;
  groups?: Array<Record<string, unknown>>;
  array?: Array<Record<string, unknown>>;
}

export type CharacterTable = Record<string, CharacterEntry>;

/** `layoutOf`/`parseStage` 接受的 model：角色表本身、`StoryPlayerBundle`、runtime.json 或 `resolvePlan` 的 input。 */
export type StageModel = Record<string, unknown> | null | undefined;

/** `StagePane` 的 `chars` 项 / `layoutOf` 的输入。 */
export interface StageCharInput {
  /** 原始引用 `base[#N][$G][@alias]`。 */
  name: string;
  slot?: Slot;
  /** 画布 px 偏移（y 向下）：引擎落点之外的编辑器微调。 */
  x?: number;
  y?: number;
  /** 已算好的矩形（`parseStage` 的产物；无 model 时直接采用）。 */
  rect?: Box;
  anchor?: Point;
  key?: string;
  url?: string | null;
  image?: string | null;
  label?: string;
  missing?: boolean;
  dimmed?: boolean;
}

/** 一个立绘在画布上的落点。 */
export interface StageLayoutChar {
  slot: Slot;
  name: string;
  /** `character.json` 的键（大小写折叠后的 base）。 */
  key: string;
  /** 命中的 `image`/`groups[].base`（贴图键）。 */
  image: string | null;
  /** 最终矩形（= 引擎矩形 + 编辑器偏移）。 */
  rect: Box;
  /** 引擎落点矩形（不含编辑器偏移）。 */
  engineRect: Box;
  /** 上游 `pos`（`{0,160}` = `repairScenarioLinks` 兜底值）。 */
  anchor: Point;
  /** 上游 `size`。 */
  size: Point;
  url: string | null;
  x: number;
  y: number;
  label?: string;
  /** 命中不到条目：虚线占位框（引擎此时 warn `missing_asset` 并清槽）。 */
  missing: boolean;
  dimmed: boolean;
}

export interface StageBackground {
  key: string;
  /** 无 URL（自备键拼不出、或宿主 `resolveUrl` 返回空）= 黑底，**不要**写成 `src=""`。 */
  url: string | null;
  /** 命中的背景规则（`patch/resolutionRules.json`）：`pos`/`size` 已作用到立绘上。 */
  rule?: BackgroundRule | null;
}

export interface StageSnapshot {
  viewport: StageViewport;
  background: StageBackground | null;
  chars: StageLayoutChar[];
  /** 亮起的槽位（`focus`）；`[]` = 全暗。 */
  focusSlots: Slot[];
  /** 解析到的行号（含）；0 = 空舞台。 */
  line: number;
  warnings: string[];
}

// ── 小工具 ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toFinite(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function point(value: unknown, fallback: Point): Point {
  if (!isRecord(value)) return { ...fallback };
  return { x: toFinite(value.x, fallback.x), y: toFinite(value.y, fallback.y) };
}

/** `\` 续行与注释都在 `storyPack.parseScript` 里处理；这里只暴露一个小包装。 */
export function parseStageLines(text: string) {
  return parseScript(text);
}

// ── 上游表加载 / 形状归一 ────────────────────────────────────────────

const EMPTY_TABLE: CharacterTable = {};
let activeTable: CharacterTable = EMPTY_TABLE;
let activeTableSource: string | null = null;
let tablePromise: Promise<CharacterTable | null> | null = null;
let activeRules: BackgroundRules = {};
let rulesPromise: Promise<BackgroundRules> | null = null;

/** 注入上游角色表（编辑器拉到 `character.json` 后调用；离线自检也用它）。 */
export function setCharacterTable(table: CharacterTable | null | undefined, source?: string): void {
  activeTable = isRecord(table) ? (table as CharacterTable) : EMPTY_TABLE;
  activeTableSource = source ?? null;
}

export function getCharacterTable(): CharacterTable {
  return activeTable;
}

export function getCharacterTableSource(): string | null {
  return activeTableSource;
}

/**
 * 拉一次上游 `background.json`（键 → ppu）并折成 `BackgroundRules`。
 * ppu 只决定背景自身矩形；包自己写在 `patch/resolutionRules.json` 里的
 * `pos`/`size`/`render` 才会叠到立绘锚点上。
 */
export function ensureBackgroundRules(options: {
  url?: string;
  fetchImpl?: typeof fetch;
  force?: boolean;
} = {}): Promise<BackgroundRules> {
  if (Object.keys(activeRules).length && !options.force) return Promise.resolve(activeRules);
  if (rulesPromise && !options.force) return rulesPromise;
  const url = options.url ?? BACKGROUND_TABLE_URL;
  const doFetch = options.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return Promise.resolve(activeRules);
  rulesPromise = doFetch(url)
    .then((response) => (response.ok ? response.json() : null))
    .then((data: unknown) => {
      if (!isRecord(data)) return activeRules;
      activeRules = rulesFromModel({ resolutionRules: data });
      return activeRules;
    })
    .catch(() => activeRules);
  return rulesPromise;
}

/**
 * 拉一次上游 `character.json` 并注入；失败返回 `null`（StagePane 仍能画占位框）。
 */
export function ensureCharacterTable(options: {
  url?: string;
  fetchImpl?: typeof fetch;
  force?: boolean;
} = {}): Promise<CharacterTable | null> {
  if (Object.keys(activeTable).length && !options.force) return Promise.resolve(activeTable);
  if (tablePromise && !options.force) return tablePromise;
  const url = options.url ?? CHARACTER_TABLE_URL;
  const doFetch = options.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return Promise.resolve(null);
  tablePromise = doFetch(url)
    .then((response) => (response.ok ? response.json() : null))
    .then((data: unknown) => {
      if (!isRecord(data)) return null;
      setCharacterTable(data as CharacterTable, url);
      return activeTable;
    })
    .catch(() => null);
  return tablePromise;
}

/** 判断一个对象像不像「base → 条目」的 `character.json` 表。 */
function looksLikeTable(value: unknown): value is CharacterTable {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (!entries.length) return false;
  let hits = 0;
  for (const [, entry] of entries) {
    if (!isRecord(entry)) continue;
    if ("array" in entry || "pos" in entry || "size" in entry) hits += 1;
    if (hits >= 3) return true;
  }
  return hits > 0 && hits >= Math.min(3, entries.length);
}

/** 从任意形态里抽出角色表：表本身 / bundle.data[CHARACTER_URL] / runtime.json / resolvePlan 的 input。 */
export function tableFromModel(raw: StageModel): CharacterTable {
  if (!isRecord(raw)) return EMPTY_TABLE;
  const data = isRecord(raw.bundle) && isRecord((raw.bundle as Record<string, unknown>).data)
    ? ((raw.bundle as Record<string, unknown>).data as Record<string, unknown>)
    : isRecord(raw.data)
      ? (raw.data as Record<string, unknown>)
      : null;
  const candidates: unknown[] = [
    data?.[CHARACTER_TABLE_URL],
    raw.upstream,
    raw.characters,
    raw.table,
    raw.linkMap,
    raw,
  ];
  for (const candidate of candidates) {
    if (looksLikeTable(candidate)) return candidate;
  }
  return EMPTY_TABLE;
}

/** 表查找：键折叠小写（`context.ts::normalizeCharacterMap` 的 `base.toLowerCase()`）。 */
export function tableEntry(table: CharacterTable, base: string): CharacterEntry | null {
  if (!base || !isRecord(table)) return null;
  if (Object.prototype.hasOwnProperty.call(table, base)) return table[base] ?? null;
  const lowered = base.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(table, lowered)) return table[lowered] ?? null;
  for (const [key, value] of Object.entries(table)) {
    if (key.toLowerCase() === lowered) return value ?? null;
  }
  return null;
}

// ── 角色引用 → 贴图（`engine/characterRef.ts` + `asset.ts` 的移植） ─────

/**
 * `resolveCharacterSelection` 的移植：`base[#index][$group][@alias]`，外加网页版
 * 扩展 `base-expression`；`@alias` 优先按 alias 命中、否则回落 `array[0]`。
 */
export function resolveExpression(
  table: CharacterTable,
  rawRef: string,
): { base: string; entry: CharacterEntry; item: Record<string, unknown> | null } | null {
  const raw = String(rawRef ?? "").trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase();

  const direct = tableEntry(table, normalized);
  if (direct) {
    return { base: normalized, entry: direct, item: (direct.array?.[0] ?? null) as Record<string, unknown> | null };
  }

  // `base-expression`（网页版扩展）：`name` 直接是 array 项的名字。
  for (const [base, entry] of Object.entries(table)) {
    const prefix = `${base.toLowerCase()}-`;
    if (!normalized.startsWith(prefix)) continue;
    const expression = normalized.slice(prefix.length);
    if (!expression) continue;
    const found = (entry?.array ?? []).find((item) => String(item.name ?? "").toLowerCase() === expression);
    if (found) return { base, entry, item: found };
  }

  const parsed = parseCharacterRef(raw);
  const base = parsed.base.toLowerCase();
  const entry = tableEntry(table, base);
  if (!entry) return null;
  const array = Array.isArray(entry.array) ? entry.array : [];
  if (!array.length) return null;

  if (parsed.alias !== null) {
    const wanted = parsed.alias.toLowerCase();
    const found = array.find((item) => String(item.alias ?? "").toLowerCase() === wanted);
    return { base, entry, item: found ?? array[0] ?? null };
  }
  // `storyPack.parseCharacterRef` 的 `group`/`index` 是**字面值**（`$1` → 1、`#1` → 1），
  // 引擎的 `parseNativeCharacterRef` 才是 0 基（`parsed - 1`）；这里按前者换算：
  // `$G` 的 array 项名以 `$G` 结尾，`#N` 取组内第 N 项（`#1` → 第 0 项）。
  if (parsed.group !== null) {
    const suffix = `$${parsed.group}`;
    const grouped = array.filter((item) => String(item.name ?? "").endsWith(suffix));
    if (!grouped.length) return null;
    const offset = Math.max(0, (parsed.index ?? 1) - 1);
    return { base, entry, item: grouped[offset] ?? grouped[0] ?? null };
  }
  const offset = Math.max(0, (parsed.index ?? 1) - 1);
  return { base, entry, item: array[offset] ?? array[0] ?? null };
}

/**
 * 贴图键：`array` 项的 `image`（`group === -1`），或 `groups[group].base`
 * （`face_overlay`：整身来自 group.base、表情叠在 faceRect 里 —— `preload.ts` 同规则）。
 */
export function imageKeyOf(entry: CharacterEntry | null, item: Record<string, unknown> | null): string | null {
  if (!item) return null;
  const group = toFinite(item.group, -1);
  if (group === -1) {
    const image = item.image;
    return typeof image === "string" && image.trim() ? image.trim() : null;
  }
  const groups = Array.isArray(entry?.groups) ? entry.groups : [];
  const groupEntry = groups[group];
  if (typeof item.face === "string" && item.face.trim() && isRecord(groupEntry) && typeof groupEntry.base === "string") {
    if (groupEntry.base.trim()) return groupEntry.base.trim();
  }
  return typeof item.image === "string" && item.image.trim() ? item.image.trim() : null;
}

/** 立绘 URL（`engine/asset.ts::resolveStoryCharacterAssetByKey`，路径分段转义）。 */
export function characterUrl(image: string | null | undefined): string | null {
  const key = String(image ?? "").trim();
  if (!key) return null;
  const encoded = key.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `https://torappu.prts.wiki/assets/avg/characters/${encoded}.png`;
}

/**
 * 一条**背景规则**（`patch/resolutionRules.json` = `background.json` 的增量）。
 *
 * 上游的 `background.json` 里值是**数字**：贴图的 ppu（像素/单位），只决定背景
 * 自身的原生矩形（`nativeBackgroundRect` = `贴图 / ppu * 100`）——**不改立绘**。
 * 但同一个值也可以写成对象，让一个包把"这套背景上的站位"一起带上：
 *
 * ```json
 * { "bg_forest": { "pos": { "x": 60, "y": -40 }, "note": "森林这张地面更低" } }
 * ```
 *
 * `pos` 与 `character.json` 的 `pos` **同语义**（x 向右、**y 向上**），叠加在该
 * 背景上所有立绘的锚点上。这正是"换个背景立绘就飘"在数据上的可解释形态：
 * 只要包/上游给了规则，`layoutOf` 就会把差异算出来；没给就完全按
 * `character.json`（与引擎一致 —— 引擎只把 ppu 用在背景自身上）。
 */
export interface BackgroundRule {
  /** 叠加在立绘锚点上的偏移（character.json 的 `pos` 语义，y 向上）。 */
  pos?: Point;
  /** `pos` 的别名（写 `offset` 的包也认）。 */
  offset?: Point;
  /** 覆盖立绘尺寸（character.json 的 `size` 语义）。 */
  size?: Point;
  /** `> 0` 时按它缩小立绘（`library.js::resolvePlan` 的 `render`）。 */
  render?: number;
  /** 上游形态：贴图 ppu（只影响背景自身，不动立绘）。 */
  ppu?: number;
  note?: string;
}

/** `key → BackgroundRule`（键大小写折叠）。 */
export type BackgroundRules = Record<string, BackgroundRule>;

/** 把任意一条 `background.json` / `resolutionRules` 的值折成 `BackgroundRule`。 */
function toBackgroundRule(value: unknown): BackgroundRule | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? { ppu: value } : null;
  if (!isRecord(value)) return null;
  const rule: BackgroundRule = {};
  const pos = isRecord(value.pos) ? value.pos : isRecord(value.offset) ? value.offset : null;
  if (pos) rule.pos = { x: toFinite(pos.x, 0), y: toFinite(pos.y, 0) };
  if (isRecord(value.size)) rule.size = { x: toFinite(value.size.x, 0), y: toFinite(value.size.y, 0) };
  if (value.render !== undefined) rule.render = toFinite(value.render, 0);
  if (value.ppu !== undefined) rule.ppu = toFinite(value.ppu, 0);
  if (typeof value.note === "string") rule.note = value.note;
  return Object.keys(rule).length ? rule : null;
}

/** 规则表：`resolutionRules` / `backgrounds` / `bundle.data[background.json]`。 */
export function rulesFromModel(raw: StageModel): BackgroundRules {
  if (!isRecord(raw)) return {};
  const root = raw as Record<string, unknown>;
  const data = isRecord(root.bundle) && isRecord((root.bundle as Record<string, unknown>).data)
    ? ((root.bundle as Record<string, unknown>).data as Record<string, unknown>)
    : isRecord(root.data)
      ? (root.data as Record<string, unknown>)
      : null;
  const tables = [root.resolutionRules, root.rules, root.backgrounds, data?.[BACKGROUND_TABLE_URL]];
  for (const table of tables) {
    if (!isRecord(table)) continue;
    const out: BackgroundRules = {};
    let usable = 0;
    for (const [key, value] of Object.entries(table)) {
      const rule = toBackgroundRule(value);
      if (!rule) continue;
      out[key.toLowerCase()] = rule;
      if (rule.pos || rule.size || rule.render) usable += 1;
    }
    if (Object.keys(out).length) return out;
    void usable;
  }
  return {};
}

/**
 * 背景规则对**立绘锚点**的净增量（`character.json` 的 `pos` 语义，x 右、y 上）。
 * 没规则 → `null`。这就是"换个背景立绘就飘"里唯一**可查**的那部分差异。
 */
export function ruleShift(rules: BackgroundRules | null | undefined, key: string): Point | null {
  const rule = backgroundRuleOf(rules, key);
  if (!rule?.pos) return null;
  return { x: rule.pos.x, y: rule.pos.y };
}

/** 背景规则查找（键小写折叠）。 */
export function backgroundRuleOf(rules: BackgroundRules | null | undefined, key: string): BackgroundRule | null {
  const wanted = String(key ?? "").trim().toLowerCase();
  if (!wanted || !rules) return null;
  if (rules[wanted]) return rules[wanted];
  for (const [name, rule] of Object.entries(rules)) {
    if (name.toLowerCase() === wanted) return rule;
  }
  return null;
}

/**
 * `PixiStoryRenderer::nativeBackgroundRect` 的移植（`rendering/PixiStoryRenderer.ts:4821`）：
 *
 * - 规则里给了 ppu（`background.json` 的值）→ `贴图 / ppu * 100`（`canvas.referencePixelsPerUnit = 100`）；
 * - 缺规则且贴图正好 16:9 → 1280×720（2023 后的背景都按画布调过 ppu）；
 * - 否则保持贴图尺寸。
 *
 * ⚠️ 这只决定**背景自身**的矩形 —— 立绘落点永远只看 `character.json` 的
 * `pos`/`size`（外加本模块的 `resolutionRules.pos` 增量）。`bg_cher_1`
 * （1024×576、ppu 68.2464…）因此原生渲染 1500.44×844，是 17% 的居中过扫，
 * 但同一张背景上的立绘一动不动。
 */
export function nativeBackgroundRect(
  key: string,
  texture: { width: number; height: number },
  rules?: BackgroundRules | null,
): Point {
  const width = Math.max(1, toFinite(texture.width, 1));
  const height = Math.max(1, toFinite(texture.height, 1));
  const ppu = backgroundRuleOf(rules, key)?.ppu;
  if (ppu !== undefined && ppu > 0) return { x: (width / ppu) * 100, y: (height / ppu) * 100 };
  if (Math.abs(width / height - STAGE_WIDTH / STAGE_HEIGHT) < 0.01) return { x: STAGE_WIDTH, y: STAGE_HEIGHT };
  return { x: width, y: height };
}

/** 背景 URL（键小写折叠；绝对 URL 原样返回）。`key` 为空 → `null`。 */
export function backgroundUrl(key: string | null | undefined): string | null {
  const value = String(key ?? "").trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `https://torappu.prts.wiki/assets/avg/background/${encodeURIComponent(value.toLowerCase())}.png`;
}

// ── resolvePlan 移植 ───────────────────────────────────────────────

/**
 * `library.js::viewportSize` 的移植：截图尺寸表（缺省 1024×1024，`"%"` 按 1280 折算）。
 * @param bases `{base: {size: [number|string, number|string], render?: number}}`
 */
export function viewportSize(
  bases: Record<string, { size?: Array<number | string> }> | null | undefined,
  base: string,
): Point {
  const raw = bases?.[base]?.size ?? [DEFAULT_BASE_SIZE, DEFAULT_BASE_SIZE];
  const convert = (value: unknown): number =>
    typeof value === "string" && value.endsWith("%")
      ? (Number.parseFloat(value) / 100) * STAGE_WIDTH
      : Number(value);
  const [x, y] = (Array.isArray(raw) ? raw : []).map(convert);
  return { x: toFinite(x, DEFAULT_BASE_SIZE), y: toFinite(y, DEFAULT_BASE_SIZE) };
}

/** `library.js::assetUrlFor` 的移植（不做转义，与上游逐字一致）。 */
function planUrlFor(entry: { image?: string } | null): string | null {
  return entry?.image ? `https://torappu.prts.wiki/assets/avg/characters/${entry.image}.png` : null;
}

export interface PlanPort {
  url: string | null;
  base: string;
  /** **不是矩形**：`{x: 宽, y: 高}`（`library.js::resolvePlan` 的 `rect`）。 */
  rect: Point;
  /** 上游 `pos`；缺省 `{(viewport.width - w)/2, 0}`。 */
  anchor: Point;
  canvas: { width?: number; height?: number } | null;
  upstreamPlan: CharacterEntry | null;
}

/**
 * `library.js::resolvePlan` 的**逐行移植**（`input` 形状完全一致：
 * `{bases, characters, assets, upstream}`）。数值必须与上游一致 —— 由
 * `scripts/fanfic/stage-selftest.mjs` 对 50 个语料角色断言。
 */
export function planOf(
  input: unknown,
  ref: string | { base: string },
  viewport: StageViewport = { width: STAGE_WIDTH, height: STAGE_HEIGHT },
): PlanPort {
  const root = isRecord(input) ? input : {};
  const parsed = typeof ref === "string"
    ? parseCharacterRef(ref)
    : { base: String((ref as { base: string }).base ?? ""), index: null, group: null, alias: null };
  const characters = isRecord(root.characters) ? (root.characters as Record<string, CharacterEntry>) : EMPTY_TABLE;
  const entry = characters[parsed.base] ?? null;
  const upstreamMap = isRecord(root.upstream) ? (root.upstream as Record<string, CharacterEntry>) : EMPTY_TABLE;
  const upstreamEntry = upstreamMap[parsed.base] ?? null;
  const image = entry?.image;
  const assets = isRecord(root.assets) ? (root.assets as Record<string, { width?: number; height?: number }>) : {};
  const canvas = assets[image ?? ""] ?? null;
  const size = viewportSize(isRecord(root.bases) ? (root.bases as Record<string, { size?: Array<number | string> }>) : null, parsed.base);
  const zoom = typeof entry?.render === "number" && entry.render > 0 ? entry.render : 1;
  const rect = size.x === 0 ? size : { x: size.x / zoom, y: size.y / zoom };
  const anchor = upstreamEntry?.pos
    ? { x: toFinite(upstreamEntry.pos.x, 0), y: toFinite(upstreamEntry.pos.y, 0) }
    : { x: (viewport.width - rect.x) / 2, y: 0 };
  return {
    url: planUrlFor(entry),
    base: parsed.base,
    rect,
    anchor,
    canvas,
    upstreamPlan: upstreamEntry,
  };
}

// ── `_GenPosition` ─────────────────────────────────────────────

/**
 * `_GenPosition` 的移植（`PixiStoryRenderer::enterOffset` 的 fallback 分支）：
 * 入场起点，单位 = **槽位局部的屏幕偏移**（y 向下）。
 */
export function genPosition(slot: Slot, direction: EnterDirection): Point {
  const compensation = SLOT_ENTER_COMPENSATION[slot] ?? 0;
  switch (direction) {
    case "left": return { x: compensation - 1152, y: 0 };
    case "right": return { x: compensation + 1152, y: 0 };
    case "up": return { x: 0, y: -1072 };
    case "down": return { x: 0, y: 1072 };
    default: return { x: 0, y: 0 };
  }
}

/** `parseEnterDirection`：原生按 ordinal 比四个字面量，`"middle"` 等一律无效。 */
export function parseEnter(value: unknown): EnterDirection | undefined {
  const raw = String(value ?? "");
  return raw === "left" || raw === "right" || raw === "up" || raw === "down" ? raw : undefined;
}

/**
 * `_ProcessSlotWithParam` 的滑入偏移：只有（合法 `enter` + x/y 都给）才用
 * `xpos/ypos`，否则回落 `_GenPosition`；y 取负（Unity y-up → 屏幕 y-down）。
 */
export function enterOffset(
  slot: Slot,
  direction: EnterDirection | undefined,
  position: Point | undefined,
): Point {
  if (direction && position) return { x: Math.trunc(position.x), y: -Math.trunc(position.y) };
  return direction ? genPosition(slot, direction) : { x: 0, y: 0 };
}

// ── layoutOf ────────────────────────────────────────────────

/**
 * 把「字符列表」算成画布上的矩形。`chars[].name` 走 `resolveExpression`；
 * 命中不到就画虚线占位框（`missing: true`）——引擎此时 `missing_asset` warn 并
 * **清掉该槽**（`runtime.ts:2415-2420`），编辑器里显示出来比静默消失有用。
 *
 * `chars[].rect` 已给出时直接采用（`parseStage` 的产物）；`viewport` 非 1280×720
 * 时按引擎矩形等比缩放。
 */
export function layoutOf(
  model: StageModel,
  options: {
    chars?: StageCharInput[];
    background?: string | null;
    viewport?: StageViewport;
    focusSlots?: Slot[];
    /** 背景规则（不给就从 model 里取 `resolutionRules` / `background.json`）。 */
    rules?: BackgroundRules | null;
  } = {},
): StageSnapshot {
  const viewport = options.viewport ?? { width: STAGE_WIDTH, height: STAGE_HEIGHT };
  const table = tableFromModel(model);
  const effective = Object.keys(table).length ? table : activeTable;
  const rules = options.rules ?? rulesFromModel(model);
  const zoomX = viewport.width / STAGE_WIDTH;
  const zoomY = viewport.height / STAGE_HEIGHT;
  const warnings: string[] = [];
  const chars: StageLayoutChar[] = [];
  const bgKey = String(options.background ?? "").trim();
  const bgRule = backgroundRuleOf(rules, bgKey);

  for (const input of options.chars ?? []) {
    const name = String(input.name ?? "").trim();
    const slot: Slot = input.slot === "l" || input.slot === "r" ? input.slot : "m";
    const parsed = parseCharacterRef(name);
    const resolved = name ? resolveExpression(effective, name) : null;
    const entry = resolved?.entry ?? null;
    const image = resolved ? imageKeyOf(entry, resolved.item) : null;
    // 背景规则（`patch/resolutionRules.json`）可以覆盖/平移这一张背景上的站位。
    const ruleSize = bgRule?.size && toFinite(bgRule.size.x, 0) > 0 ? bgRule.size : null;
    const ruleZoom = ruleSize && bgRule?.render && bgRule.render > 0 ? bgRule.render : 1;
    const engineSize = ruleSize
      ? { x: toFinite(ruleSize.x, 0) / ruleZoom, y: toFinite(ruleSize.y, 0) / ruleZoom }
      : entry?.size && toFinite(entry.size.x, 0) > 0
        ? { x: toFinite(entry.size.x, 0), y: toFinite(entry.size.y, 0) }
        : { ...FALLBACK_SIZE };
    const baseAnchor = entry?.pos ? point(entry.pos, FALLBACK_POS) : { ...FALLBACK_POS };
    const anchor: Point = bgRule?.pos
      ? { x: baseAnchor.x + bgRule.pos.x, y: baseAnchor.y + bgRule.pos.y }
      : baseAnchor;
    const engineRect: Box = {
      x: (SLOT_BASE_X[slot] - engineSize.x / 2 + anchor.x) * zoomX,
      y: (viewport.height - engineSize.y / 2 - anchor.y) * zoomY,
      w: engineSize.x * zoomX,
      h: engineSize.y * zoomY,
    };
    const offsetX = toFinite(input.x, 0);
    const offsetY = toFinite(input.y, 0);
    const given = input.rect && toFinite(input.rect.w, 0) > 0
      ? {
          x: toFinite(input.rect.x, 0),
          y: toFinite(input.rect.y, 0),
          w: toFinite(input.rect.w, 0),
          h: toFinite(input.rect.h, 0),
        }
      : null;
    const baseRect: Box = given ?? engineRect;
    const rect: Box = { x: baseRect.x + offsetX, y: baseRect.y + offsetY, w: baseRect.w, h: baseRect.h };
    const placeholder = resolved === null;
    if (placeholder && name) {
      warnings.push(`未知角色 ${name}：character.json 里没有 base "${parsed.base}"（引擎会 warn missing_asset 并清槽）`);
    }
    chars.push({
      slot,
      name,
      key: resolved?.base ?? parsed.base.toLowerCase(),
      image,
      rect,
      engineRect,
      anchor,
      size: engineSize,
      url: input.url ?? characterUrl(image),
      x: offsetX,
      y: offsetY,
      label: input.label,
      missing: input.missing ?? placeholder,
      dimmed: Boolean(input.dimmed),
    });
  }

  return {
    viewport,
    background: bgKey ? { key: bgKey, url: backgroundUrl(bgKey), rule: bgRule } : null,
    chars,
    focusSlots: options.focusSlots ?? ["l", "m", "r"],
    line: 0,
    warnings,
  };
}

// ── parseStage ─────────────────────────────────────────────

/** 一行 `[charslot]` / `[character]` 的节拍状态。 */
interface SlotBeat {
  ref: string;
  line: number;
  dimmed: boolean;
}

/**
 * 走到第 `lineIndex` 行（1 基、**含**该行）时的舞台状态。
 *
 * Decision/Predicate 闸门按 `log/semantics.ts::passesGate` 复刻。编辑期没有真实
 * 选择：`decisionValue = 0` → 闸门全放行（"未知就全显示"），两条分支的
 * `[Character]` 依次落地，合流后与播放一致；给了 `options.selections`
 * （decision 行号 → 取值）就按真实分支走。
 *
 * 返回的 `chars[].rect` 已经是画布坐标；`layoutOf`/`StagePane` 直接画。
 */
export function parseStage(
  text: string,
  lineIndex = Number.MAX_SAFE_INTEGER,
  options: {
    model?: StageModel;
    viewport?: StageViewport;
    /** decision 行号（1 基）→ 选中的 value。 */
    selections?: Record<number, number>;
    /** 直接给表（优先于 model / 注入的表）。 */
    table?: CharacterTable;
    /** 背景规则表（`patch/resolutionRules.json` 的合并结果）。 */
    rules?: BackgroundRules | null;
  } = {},
): StageSnapshot {
  const viewport = options.viewport ?? { width: STAGE_WIDTH, height: STAGE_HEIGHT };
  const table = options.table
    ?? (options.model !== undefined ? tableFromModel(options.model) : activeTable);
  const effective = Object.keys(table ?? {}).length ? (table as CharacterTable) : activeTable;
  const lines = parseScript(text);
  const slots = new Map<Slot, SlotBeat>();
  let background: string | null = null;
  let focusSlots: Slot[] = ["l", "m", "r"];
  let decisionValue = 0;
  let references: number[] | null = null;
  let reached = 0;
  const warnings: string[] = [];
  const limit = Number.isFinite(lineIndex) ? lineIndex : Number.MAX_SAFE_INTEGER;

  for (const line of lines) {
    if (line.lineNumber > limit) break;
    reached = line.lineNumber;
    if (line.kind !== "command") continue;
    const command = line.command;

    if (command === "decision") {
      decisionValue = 0;
      references = null;
      const optionsRaw = arg(line.args, "options");
      if (optionsRaw === undefined) continue; // 无效 decision：状态照样被清空（runtime 同）
      const values = String(arg(line.args, "values") ?? "")
        .split(";")
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((value) => Number.isFinite(value));
      const picked = options.selections?.[line.lineNumber];
      if (typeof picked === "number") decisionValue = picked;
      // 只有一个选项时玩家没有别的选择；多选项且没有记录 → 0（闸门全放行）。
      else if (values.length === 1) decisionValue = values[0];
      continue;
    }
    if (command === "predicate") {
      const raw = arg(line.args, "references");
      if (raw === undefined) { references = null; continue; }
      references = String(raw)
        .split(";")
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((value) => Number.isFinite(value) && value !== 0);
      continue;
    }

    // ── 闸门（`passesGate`）：decision/predicate 自身永远放行 ──
    if (decisionValue !== 0 && references !== null && references.length > 0 && !references.includes(decisionValue)) {
      continue;
    }

    if (command === "background") {
      const image = arg(line.args, "image");
      background = typeof image === "string" && image.trim() ? image.trim() : null;
      continue;
    }
    if (command === "gridbg" || command === "verticalbg" || command === "largebg") {
      const first = String(arg(line.args, "imagegroup") ?? "").split("/")[0] ?? "";
      background = first.trim() ? first.trim() : null;
      if (first.trim()) warnings.push(`${line.lineNumber}: ${command} 是拼图家族，预览取 imagegroup 的第一张 ${first.trim()}`);
      continue;
    }

    if (command === "character") {
      const name = typeof arg(line.args, "name") === "string" ? String(arg(line.args, "name")) : "";
      const name2 = typeof arg(line.args, "name2") === "string" ? String(arg(line.args, "name2")) : "";
      const focus = toFinite(arg(line.args, "focus"), 0);
      focusSlots = resolveCharacterFocus(focus);
      // 原生 MIDDLE → LEFT → RIGHT，同帧同步；没写名字的槽一律被清。
      const updates: SlotBeat[] = [
        { ref: name && !name2 ? name : "", line: line.lineNumber, dimmed: focus >>> 0 > 1 },
        { ref: name2 ? name : "", line: line.lineNumber, dimmed: focus >>> 0 > 1 },
        { ref: name2, line: line.lineNumber, dimmed: ![0, 2].includes(focus) },
      ];
      SLOT_ORDER.forEach((slot, index) => {
        const update = updates[index];
        if (!update?.ref) { slots.delete(slot); return; }
        slots.set(slot, update);
      });
      continue;
    }

    if (command === "charslot") {
      const rawSlot = String(arg(line.args, "slot") ?? "").trim();
      const name = String(arg(line.args, "name") ?? "");
      if (!rawSlot) { slots.clear(); continue; } // 空 slot = 清三个内置槽
      const slot = parseSlot(rawSlot);
      if (!slot) {
        warnings.push(`${line.lineNumber}: charslot 的 slot "${rawSlot}" 不是内置槽（自定义槽未建模，引擎会 warn）`);
        continue;
      }
      const focus = String(arg(line.args, "focus") ?? "all").trim().toLowerCase();
      if (!focus || focus === "all") focusSlots = ["l", "m", "r"];
      else if (focus) focusSlots = resolveFocusList(focus);
      if (name === "char_empty") { slots.delete(slot); continue; }
      if (!name) continue; // 引擎：写了 slot 但 name 为空 → 该槽不动
      if (!resolveExpression(effective, name)) {
        warnings.push(`${line.lineNumber}: charslot name="${name}" 解析不到（引擎会清掉该槽）`);
      }
      slots.set(slot, { ref: name, line: line.lineNumber, dimmed: !focusSlots.includes(slot) });
      continue;
    }
  }

  const chars: StageCharInput[] = [];
  for (const slot of SLOT_ORDER) {
    const beat = slots.get(slot);
    if (!beat) continue;
    const parsed = parseCharacterRef(beat.ref);
    chars.push({
      name: beat.ref,
      slot,
      x: 0,
      y: 0,
      label: `${beat.line} 行 · ${slot === "l" ? "左" : slot === "r" ? "右" : "中"}`,
      dimmed: beat.dimmed,
      missing: !resolveExpression(effective, beat.ref) && Boolean(parsed.base),
    });
  }

  const rules = options.rules ?? rulesFromModel(options.model);
  const snapshot = layoutOf(
    { characters: effective, upstream: effective, resolutionRules: rules },
    { chars, background, viewport, focusSlots, rules },
  );
  return { ...snapshot, line: reached, warnings: [...snapshot.warnings, ...warnings] };
}

// ── 槽位 / focus 词表 ───────────────────────────────────────

/** `parseCharacterSlot`：`l|left|char_left`、`m|middle|c|center|char_middle`、`r|right|char_right`。 */
export function parseSlot(value: unknown): Slot | undefined {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "char_left":
    case "l":
    case "left":
      return "l";
    case "c":
    case "center":
    case "char_middle":
    case "m":
    case "middle":
      return "m";
    case "char_right":
    case "r":
    case "right":
      return "r";
    default:
      return undefined;
  }
}

/** `[Character]` 的 focus → 亮起的槽位（`runtime.ts` 的两个判定取并集）。 */
export function resolveCharacterFocus(focus: number): Slot[] {
  const slots: Slot[] = [];
  if (focus >>> 0 <= 1) slots.push("l", "m");
  if ([0, 2].includes(focus)) slots.push("r");
  return slots;
}

/** `[charslot]` 的 `focus=` → 亮起的槽位（`_ProcessFocusArray`；未知值 = 全暗）。 */
export function resolveFocusList(focus: string): Slot[] {
  if (!focus || focus === "all") return ["l", "m", "r"];
  const tokens: Record<string, Slot> = { l: "l", left: "l", m: "m", middle: "m", r: "r", right: "r" };
  const out: Slot[] = [];
  for (const token of focus.split(",")) {
    const slot = tokens[token.trim().toLowerCase()];
    if (slot && !out.includes(slot)) out.push(slot);
  }
  return out;
}

// ── movePatch ─────────────────────────────────────────────

export interface MovePatch {
  slot: Slot;
  /** 画布 px 增量（y 向下），= 传入的 dx/dy（取整）。 */
  dx: number;
  dy: number;
  /** 等价「绝对偏移」：`patch/characters.json` 里 `pos` 的增量（Unity y-up）。 */
  absolute: Point;
  /** 同一个增量的屏幕方向写法（y 向下）。 */
  canvas: Point;
  /** 引擎认的滑入参数（Unity y-up；`xpos = -dx`、`ypos = +dy`）。 */
  slide: { enter: EnterDirection; x: number; y: number };
  /** 该槽用哪三个键：`l/m` → `enter/xpos1/ypos1`，`r` → `enter2/xpos2/ypos2`。 */
  keys: { enter: string; x: string; y: string };
  /** 合并进当前行要用的键值对。 */
  patch: Record<string, number | string>;
  /** 单独一行：滑入形态（`[Character(...)]`，记得补 `name=`）。 */
  slideLine: string;
  /** 单独一行：**落点会留下来**的运行时移动（`[CharacterAction(type="move")]`）。 */
  moveLine: string;
  /** `extra.line` 给定时：按那一行的写法改好的整行（优先用它）。 */
  line?: string;
  /** `extra.line` 的控制器（`character`/`charslot`/`characteraction`）；无 = `null`。 */
  lineCommand: string | null;
  /** 一行人类可读的映射说明（HUD/日志用）。 */
  note: string;
}

/** 把增量写成 `+80,-40`（HUD 用）。 */
export function formatDelta(point: Point): string {
  const sign = (value: number) => (value >= 0 ? `+${Math.round(value)}` : `${Math.round(value)}`);
  return `${sign(point.x)},${sign(point.y)}`;
}

/**
 * 拖拽 → 引擎认的补丁。屏幕增量 `(dx, dy)` 单位 = **1280×720 画布 px、y 向下**。
 *
 * ### 映射（"位置乱飘"的修法）
 *
 * | 目标 | 写法 | 数值 |
 * |---|---|---|
 * | 滑入起点（`[Character]`，只有入场一次）| `enter="…" xpos1=… ypos1=…` | `xpos1 = -dx`、`ypos1 = +dy`（Int32、槽位局部、Unity y-up）|
 * | 落点（`patch/characters.json`）| `pos += …` | `pos.x += dx`、`pos.y += -dy` |
 * | 运行时移动（`[CharacterAction]`）| `type="move" xpos=… ypos=…` | `xpos = dx`、`ypos = -dy`（`runMoveAction`: `actionX += xpos`）|
 * | `charslot` 落点 | `action="setpos" posfrom="0,0" posto="dx,-dy"` | `_offset.localPosition = posto`，`motionLayer.y = -posto.y` |
 *
 * `enter` 按「从哪边来」：向右拖（`dx > 0`）→ `"left"`；位移水平 ≥ 垂直走
 * `left/right`，否则 `dy > 0`（向下拖）→ `"up"`。
 *
 * `extra.line`（编辑器传当前行原文）给定时，`line` = 按该行写法改好的整行：
 * - `[charslot(...)]` → `setpos` + `posto`（瞬时落点）；
 * - `[CharacterAction(...)]` → `xpos/ypos`；
 * - `[Character(...)]` → `enter` + 对应槽的 `xpos…`/`ypos…`（`name` only → `xpos1`；
 *   `name2` 在 → `r` 槽写 `enter2/xpos2/ypos2`，`l` 槽写 `enter/xpos1/ypos1`）。
 */
export function movePatch(
  slot: Slot,
  dx: number,
  dy: number,
  extra: { line?: string; ref?: string } = {},
): MovePatch {
  const ndx = Math.round(toFinite(dx, 0));
  const ndy = Math.round(toFinite(dy, 0));
  const enter: EnterDirection = Math.abs(ndx) >= Math.abs(ndy)
    ? (ndx >= 0 ? "left" : "right")
    : (ndy >= 0 ? "up" : "down");
  const keys = slot === "r"
    ? { enter: "enter2", x: "xpos2", y: "ypos2" }
    : { enter: "enter", x: "xpos1", y: "ypos1" };
  const slide = { enter, x: -ndx, y: ndy };
  const patch: Record<string, number | string> = { [keys.enter]: enter, [keys.x]: slide.x, [keys.y]: slide.y };
  const slideLine = slot === "r"
    ? `[Character(name="", name2="", ${keys.enter}="${enter}", ${keys.x}=${slide.x}, ${keys.y}=${slide.y})]`
    : `[Character(name="", ${keys.enter}="${enter}", ${keys.x}=${slide.x}, ${keys.y}=${slide.y})]`;
  const moveName = slot === "l" ? "left" : slot === "r" ? "right" : "middle";
  const moveLine = `[CharacterAction(name="${moveName}", type="move", xpos=${ndx}, ypos=${-ndy}, block=true)]`;

  const out: MovePatch = {
    slot,
    dx: ndx,
    dy: ndy,
    absolute: { x: ndx, y: -ndy },
    canvas: { x: ndx, y: ndy },
    slide,
    keys,
    patch,
    slideLine,
    moveLine,
    lineCommand: null,
    note: `屏幕增量 ${formatDelta({ x: ndx, y: ndy })} → 滑入起点 ${keys.x}=${slide.x}, ${keys.y}=${slide.y}` +
      `（Unity y-up）；想留住位置：patch/characters.json 的 pos += {x:${ndx}, y:${-ndy}} 或用 ${moveLine}`,
  };

  const current = String(extra.line ?? "");
  if (!current.trim()) return out;
  const parsed = parseLine(current.trim(), 0);
  const command = parsed.kind === "command" ? parsed.command : null;
  out.lineCommand = command;
  if (!command) {
    out.note += "（extra.line 不是指令行 → 用返回的 slideLine/moveLine）";
    return out;
  }

  if (command === "charslot") {
    // `setpos` 是 Web 扩展（runtime `runMoveAction` → `_offset`），duration 被跳过 → 瞬时落点。
    const values = { action: "setpos", posfrom: "0,0", posto: `${ndx},${-ndy}` } as const;
    out.line = setArgs(current, values);
    out.patch = { ...values };
    out.note = `charslot(action="setpos")：_offset.localPosition = ${ndx},${-ndy}` +
      `（posto 是「屏幕增量 (dx, -dy)」，会留在画面上）`;
    return out;
  }
  if (command === "characteraction") {
    const type = String(arg(parsed.args, "type") ?? "move") || "move";
    const values = { type, xpos: ndx, ypos: -ndy };
    out.line = setArgs(current, values);
    out.patch = { ...values };
    out.note = `CharacterAction(type="${type}")：actionX += ${ndx}, actionY += ${-ndy}` +
      `（motionLayer.y = -actionY ⇒ 屏幕 y ${ndy >= 0 ? "+" : ""}${ndy}）`;
    return out;
  }
  if (command === "character") {
    const hasName2 = parsed.args.name2 !== undefined;
    const useKeys = !hasName2
      ? { enter: "enter", x: "xpos1", y: "ypos1" } // 只有 name → 引擎只摆 m 槽
      : slot === "r"
        ? { enter: "enter2", x: "xpos2", y: "ypos2" }
        : { enter: "enter", x: "xpos1", y: "ypos1" };
    const values: Record<string, number | string> = { [useKeys.enter]: enter, [useKeys.x]: slide.x, [useKeys.y]: slide.y };
    out.keys = useKeys;
    out.patch = { ...values };
    out.line = setArgs(current, values);
    if (!hasName2 && slot !== "m") {
      out.note += `（这一行只有 name= → 引擎只摆 m 槽；要摆 ${slot} 槽需写 name2=）`;
    }
    return out;
  }
  out.note += `（extra.line 的命令 ${command} 不认移动参数 → 用返回的 slideLine/moveLine）`;
  return out;
}

/** 行内改/加 `key=value`（保留其余字节；与 `StoryEditorPage.tsx::withArg` 同规则）。 */
export function setArgs(line: string, values: Record<string, number | string>): string {
  let out = line;
  for (const [key, value] of Object.entries(values)) out = setArg(out, key, value);
  return out;
}

function formatArgValue(value: number | string): string {
  if (typeof value === "number") return String(value);
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setArg(line: string, key: string, value: number | string): string {
  const literal = formatArgValue(value);
  const existing = new RegExp(`(\\b${escapeRegExp(key)}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^,\\s)]+)`, "i");
  if (existing.test(line)) return line.replace(existing, `$1${literal}`);
  const close = line.lastIndexOf(")");
  if (close === -1) return line.endsWith("]") ? `${line.slice(0, -1)}(${key}=${literal})]` : line;
  const inner = line.slice(0, close).replace(/\s+$/, "");
  const needsComma = /[^\s(]$/.test(inner);
  return `${inner}${needsComma ? ", " : ""}${key}=${literal}${line.slice(close)}`;
}
