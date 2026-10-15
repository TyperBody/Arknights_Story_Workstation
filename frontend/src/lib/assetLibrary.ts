/**
 * `assetLibrary.ts` —— 素材库的**纯数据层**（task-B）。
 *
 * 用户原话：「引入素材库 可以快速预览素材 并且可互动素材（可视，播放） 拖拽（出来到
 * 编辑器是名称，到舞台是对于当前场景） 就和文件管理器一样 可以导入素材 对素材进行整理」。
 *
 * 本文件**零运行时依赖**（不 import React / Tauri / `stageCatalog`）——这样
 * `scripts/fanfic/assetLibrary-selftest.mjs` 能用裸 Node（v22 的类型擦除）直接
 * import 它，UI 与自检共用同一份实现，不会漂移。
 *
 * ## 四个来源（与任务书 §2 一致）
 * 1. **引擎目录**：`background.json` 的键（`{key: ppu}`）与 `character.json` 的
 *    条目（`{base: {array: [{image}]}}`）——**canvas 名与贴图名都要出现**（两者
 *    是不同的条目：`avg_npc_1` 与 `avg_npc_1/avg_npc_1$1`）；
 * 2. **当前脚本**：`parseScriptAssetKeys()` 抽 `[PlayMusic]/[PlaySound]/
 *    [Background]/[Character]/[charslot]/[nameslot]`——`$变量` **原样保留**；
 * 3. **包自带**：`build/assets.local.json` 的 canonical key（`packAssets` 的表）；
 * 4. **随包**：`bundledKeys`（Rust `bundled_asset_keys` / 内置样例）→ `bundled: true`。
 *
 * `uses` = 表里的权重 + 脚本里的出现次数（**聚合**；0 = 未知）。排序 =
 * **随包优先 → 用量降序 → key 字典序**（`key <` 的码点序，不用 `localeCompare`
 * ——后者随 ICU 变化，自检里要逐字节可比）。
 *
 * 音频**没有目录表**：条目从脚本反推，试听 URL 用引擎自己的公式
 * （`${host}/assets/${path.replace("Sound_Beta_2", "assets/audio")}.mp3`，
 * 见 `StoryPlayer` 快照里 `$t()`/`audioVariables`）：`story_variables.json` 把
 * `$calm_loop` 映射成 `Sound_Beta_2/Music/…`，本文件据此算出官方直链。
 */

export type AssetKind = "background" | "character" | "music" | "sound" | "other";

/** 条目的来源（一条可以来自多处；`sources` 是去重后的清单）。 */
export type AssetSource = "engine" | "script" | "pack";

/** 一条素材。`key` = 展示/拖拽用的名字（拖到编辑器就插它）。 */
export interface AssetEntry {
  /** 规范化 key：背景 `bg_x` / 立绘 `角色/贴图` / 音频 `$var` 或 `audio/…`。 */
  key: string;
  kind: AssetKind;
  /** 人话标签（预览条显示）。 */
  label: string;
  /** 用量 = 表里的权重 + 脚本里的出现次数（聚合；0 = 未知）。 */
  uses: number;
  /** 随包（内置样例 / `bundled_asset_keys` 覆盖层）里能直接取到 → 离线可用。 */
  bundled: boolean;
  /** 来自「导入进包」的包自带素材（`build/assets.local.json`）。 */
  fromPack: boolean;
  /** 出现来源（`engine` = 引擎目录表；`script` = 当前脚本；`pack` = 包自带）。 */
  sources: AssetSource[];
  /** 包内相对路径（`assets.local.json` 的值；没有就不填）。 */
  file?: string;
  /** 音频条目的**试听直链**（引擎公式；图片条目空）。 */
  audioUrl?: string;
}

/** `parseScriptAssetKeys()` 的产物（四类 + 每个 key 的出现次数）。 */
export interface ScriptAssetKeys {
  /** `[PlayMusic(key=|intro=)]`。 */
  music: string[];
  /** `[PlaySound(key=)]`。 */
  sound: string[];
  /** `[Background(image=)]`。 */
  images: string[];
  /** `[Character(name=|name2=)]` / `[charslot(name=)]` / `[nameslot(name=)]`。 */
  characters: string[];
  /** key → 出现次数（顺序无意义；`uses` 聚合用它）。 */
  counts: Record<string, number>;
}

/** `assetEntries()` 的输入（全都可缺省；缺省 = 这一类没有）。 */
export interface AssetLibraryInputs {
  /** `background.json`（`{key: ppu}`）或任意键清单。 */
  backgrounds?: Record<string, unknown> | Iterable<unknown> | null;
  /** `character.json`（`{base: {array: [{image}]}}`）或任意名字清单。 */
  characters?: Record<string, unknown> | Iterable<unknown> | null;
  /** `story_variables.json`（`$name` → `Sound_Beta_2/…`）——音频试听 URL 用。 */
  variables?: Record<string, unknown> | null;
  /** 当前脚本抽出来的四类（`parseScriptAssetKeys` 的产物）。 */
  scriptKeys?: ScriptAssetKeys | null;
  /** 包自带素材的 canonical key → 包内相对路径。 */
  packKeys?: Record<string, string> | Iterable<string> | null;
  /** 随包（内置样例 / 覆盖层）能直接供给的 key。 */
  bundledKeys?: Iterable<string> | null;
}

/** 类型栏的固定顺序（UI 与分组都用它）。 */
export const ASSET_KIND_IDS: readonly AssetKind[] = ["background", "character", "music", "sound", "other"];

/** i18n 键的后缀（`editor.assets.kindBackground` 等）。 */
export const ASSET_KIND_KEY: Record<AssetKind, string> = {
  background: "kindBackground",
  character: "kindCharacter",
  music: "kindMusic",
  sound: "kindSound",
  other: "kindOther",
};

const HOST_PREFIX = /^[a-z0-9.-]+\.[a-z]{2,}\//i;
const ABSOLUTE = /^(https?:|data:|blob:|asset:|prts-cdn:|file:)/i;
const IMAGE_EXT = /\.(png|webp|jpg|jpeg|gif|avif)(?:[?#].*)?$/i;
const AUDIO_EXT = /\.(mp3|ogg|oga|wav|m4a|aac|flac|opus|weba)(?:[?#].*)?$/i;

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * 把任意形态的素材引用折成 catalog key（**自包含**，与 `stageCatalog.normalizeStageKey`
 * 的取值一致；后者依赖 `appSettings`/`react`，裸 Node 里 import 不动）：
 * - `…/assets/avg/background/bg_forest.png` → `bg_forest`；
 * - `…/assets/avg/characters/char_002_amiya_1/char_002_amiya_1.png` →
 *   `char_002_amiya_1/char_002_amiya_1`；
 * - `…/assets/audio/Music/x/y.mp3` → `audio/Music/x/y.mp3`；
 * - `bg_forest` / `char_x/char_x` / `$calm_loop` → 原样（`bg*` 前缀小写化）；
 * - 坏输入 → `""`。
 */
export function normalizeAssetKey(value: unknown): string {
  const raw = str(value).replace(/["']/g, "");
  if (!raw) return "";
  if (!ABSOLUTE.test(raw) && !raw.includes("/assets/")) {
    const bare = raw.startsWith("bg") ? raw.toLowerCase() : raw;
    // 纯数字/纯标点的「key」（坏表里的 `"12"`）不成条目：至少要有一个字母或 `$`。
    return /[A-Za-z$]/.test(bare) ? bare : "";
  }
  let path = raw;
  if (ABSOLUTE.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      path = path.replace(/^[a-z]+:\/\/[^/]*/i, "");
    }
  }
  path = path.split("?")[0].split("#")[0];
  path = decodeURIComponent(path);
  const at = path.lastIndexOf("/assets/");
  if (at !== -1) path = path.slice(at + "/assets/".length);
  else path = path.replace(HOST_PREFIX, "");
  const parts = path.split("/").filter(Boolean);
  const file = parts.pop() ?? "";
  if (!file) return "";
  if (parts[0] === "avg" && parts[1] === "background") return file.replace(IMAGE_EXT, "").toLowerCase();
  if (parts[0] === "avg" && parts[1] === "characters") {
    const dir = parts[parts.length - 1] ?? "";
    const base = file.replace(IMAGE_EXT, "");
    return dir && dir !== "characters" ? `${dir}/${base}` : base;
  }
  if (parts[0] === "audio" || AUDIO_EXT.test(file)) {
    return `audio/${[...parts.slice(1), file.replace(AUDIO_EXT, "")].join("/")}`;
  }
  const base = file.replace(IMAGE_EXT, "");
  return base || raw;
}

/** 单条 key 的种类：`/` = 立绘；`bg*`/`ui_*` = 背景；`$`/`audio/` = 音频。 */
export function assetKindOf(value: unknown): AssetKind {
  const key = str(value);
  if (!key) return "other";
  if (key.startsWith("$") || key.startsWith("audio/") || /^Sound_Beta_2\//i.test(key)) {
    return audioKindOf(key);
  }
  if (key.includes("/")) return "character";
  const lower = key.toLowerCase();
  if (lower.startsWith("bg") || lower.startsWith("ui_")) return "background";
  if (/^(char|avg|npc|enemy|token|trap|portrait)/.test(lower)) return "character";
  if (AUDIO_EXT.test(lower)) return audioKindOf(key);
  return "character";
}

/** 音频的细分：`Music/` = BGM，其余（Dialog/AVG/Sound/…）= 音效。 */
function audioKindOf(value: string): AssetKind {
  return /\/music\//i.test(value) || /(^|[^a-z])bgm([^a-z]|$)/i.test(value) ? "music" : "sound";
}

/** 由 `assetKindOf` 决定的显示标签。 */
export function assetLabelOf(key: string, kind: AssetKind): string {
  if (kind === "character") return key.split("/")[0] || key;
  if (kind === "music") return `BGM ${key}`;
  if (kind === "sound") return `SFX ${key}`;
  return key;
}

/**
 * 引擎的音频路径公式（`StoryPlayer` 快照 `$t()` 的逐行移植，`Sound_Beta_2` 前缀
 * 换成固定基数 `https://torappu.prts.wiki/assets/`，再把基数的 `assets/` 换成
 * `assets/audio/`）：
 *
 *   `$calm_loop` →（`story_variables`）→ `Sound_Beta_2/Music/beta1/m_calm` →
 *   `https://torappu.prts.wiki/assets/audio/Music/beta1/m_calm.mp3`
 *
 * `$变量` 查不到 / 值不是字符串 → `""`（调用方据此不渲染 `<audio>`）。
 */
export function audioUrlFor(
  key: string,
  variables?: Record<string, unknown> | null
): string {
  const raw = str(key);
  if (!raw) return "";
  let path = "";
  if (raw.startsWith("$")) {
    const name = raw.slice(1).toLowerCase();
    const table = variables ?? {};
    for (const [candidate, value] of Object.entries(table)) {
      if (candidate.toLowerCase() !== name) continue;
      path = str(value);
      break;
    }
  } else {
    path = raw.replace(/^audio\//, "").replace(/^.*\/assets\/audio\//i, "");
  }
  if (!path) return "";
  // 变量值必须**长得像音频路径**（`Sound_Beta_2/…` / `audio/…` / 带音频扩展名）：
  // `avatar_amiya => "char_130_doberm"` 这种角色变量不该算出 `.mp3` 直链。
  const looksAudio = /^Sound_Beta_2\//i.test(path) || /^audio\//i.test(path) || AUDIO_EXT.test(path);
  if (!looksAudio) return "";
  if (AUDIO_EXT.test(path)) {
    const withoutExt = path.replace(AUDIO_EXT, "");
    return `https://torappu.prts.wiki/assets/audio/${withoutExt.replace(/^Sound_Beta_2\/?/i, "")}.mp3`;
  }
  const body = path.replace(/^Sound_Beta_2\/?/i, "").replace(/^assets\/audio\/?/i, "");
  if (!body) return "";
  return `https://torappu.prts.wiki/assets/audio/${body}.mp3`;
}

/** 从一行里取一个 `key=value`（字符串去引号、数字/变量原样；取不到 → `undefined`）。
 *  **轻量正则**：不依赖 `editorModel`（后者在自检里也不必载入）。 */
function argOf(args: string, key: string): string | undefined {
  const pattern = /([A-Za-z_][\w.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s)]+))/g;
  const wanted = key.toLowerCase();
  for (const match of args.matchAll(pattern)) {
    if (match[1].toLowerCase() !== wanted) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    return value.trim();
  }
  return undefined;
}

/** `[Cmd(args)]` 的骨架（**行首允许 Tab/空格**：区域缩进后的脚本照样能抽）。 */
const COMMAND_LINE = /^[ \t]*\[\s*([A-Za-z_][\w.]*)\s*(?:\(([\s\S]*)\))?\s*\]/;

const MUSIC_COMMANDS = new Set(["playmusic"]);
const SOUND_COMMANDS = new Set(["playsound"]);
const IMAGE_COMMANDS = new Set(["background", "bgeffect"]);
const CHARACTER_COMMANDS = new Set(["character", "charslot", "nameslot"]);

/**
 * 从脚本文本里抽四类 key。行为契约（自检逐条断言）：
 * - 行首 Tab/空格（区域缩进）、`//` 注释行、未知控制器、坏行 → 不抛、跳过；
 * - `key="$var"` 的 `$变量` **原样保留**（不去 `$`、不做未知变量过滤）；
 * - 重复出现去重（首现顺序），次数进 `counts`；
 * - `[Character(name2=…)]` 的 `name2` 也算一条立绘（引擎的 l/r 双槽写法）；
 * - 传入非字符串（null/undefined/数字）→ 空结果。
 */
export function parseScriptAssetKeys(script: unknown): ScriptAssetKeys {
  const out: ScriptAssetKeys = { music: [], sound: [], images: [], characters: [], counts: {} };
  if (typeof script !== "string" || !script) return out;
  const seen: Record<keyof Omit<ScriptAssetKeys, "counts">, Set<string>> = {
    music: new Set(),
    sound: new Set(),
    images: new Set(),
    characters: new Set(),
  };
  const push = (bucket: keyof Omit<ScriptAssetKeys, "counts">, rawValue: unknown) => {
    const value = str(rawValue);
    if (!value) return;
    out.counts[value] = (out.counts[value] ?? 0) + 1;
    if (seen[bucket].has(value)) return;
    seen[bucket].add(value);
    out[bucket].push(value);
  };
  for (const rawLine of script.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    const match = COMMAND_LINE.exec(rawLine);
    if (!match) continue;
    // `[Battle.PlayMusic(…)]` 这类命名空间写法按**末段**判命令（引擎的 dispatch 同形）。
    const command = match[1].toLowerCase().split(".").pop() ?? "";
    const args = match[2] ?? "";
    if (MUSIC_COMMANDS.has(command)) {
      push("music", argOf(args, "key"));
      if (argOf(args, "intro") !== undefined) push("music", argOf(args, "intro"));
      continue;
    }
    if (SOUND_COMMANDS.has(command)) {
      push("sound", argOf(args, "key"));
      continue;
    }
    if (IMAGE_COMMANDS.has(command)) {
      push("images", argOf(args, "image") ?? argOf(args, "key"));
      continue;
    }
    if (CHARACTER_COMMANDS.has(command)) {
      push("characters", argOf(args, "name"));
      if (argOf(args, "name2") !== undefined) push("characters", argOf(args, "name2"));
    }
  }
  return out;
}

/** 一条可变的合并中间态。 */
interface Mutable {
  key: string;
  uses: number;
  bundled: boolean;
  fromPack: boolean;
  file?: string;
  sources: AssetSource[];
  kind?: AssetKind;
  audioUrl?: string;
}

/** `packKeys` 的行：值 = 包内相对路径（**保留字符串**，不能走 `Number()`）。 */
function packRows(input: AssetLibraryInputs["packKeys"]): Array<[string, string]> {
  if (!input) return [];
  if (typeof input === "string") return [[input, ""]];
  if (input instanceof Map) return [...input.entries()].map(([key, value]) => [String(key), str(value)]);
  if (input instanceof Set || Array.isArray(input)) {
    return [...input].map((item) =>
      typeof item === "string"
        ? ([item, ""] as [string, string])
        : ([str((item as Record<string, unknown>)?.key ?? item), str((item as Record<string, unknown>)?.file ?? "")] as [string, string])
    );
  }
  if (typeof input === "object") {
    return Object.entries(input as Record<string, unknown>).map(([key, value]) => [key, str(value)]);
  }
  return [];
}

function entriesOfTable(input: AssetEntrySource): Array<[string, number]> {
  if (!input) return [];
  if (input instanceof Map) return [...input.entries()].map(([key, value]) => [String(key), Number(value) || 0]);
  if (input instanceof Set || Array.isArray(input)) {
    return [...input].map((item) => [str((item as Record<string, unknown>)?.key ?? item), 0]);
  }
  if (typeof input === "object") {
    return Object.entries(input as Record<string, unknown>).map(([key, value]) => [key, Number(value) || 0]);
  }
  return [];
}

type AssetEntrySource =
  | Record<string, unknown>
  | Map<unknown, unknown>
  | Set<unknown>
  | Iterable<unknown>
  | null
  | undefined;

/** 字符（canvas）表的条目：`base` + `array[].image` **两者都要出现**。 */
function characterRows(input: AssetEntrySource): Array<{ key: string; file?: string; uses: number }> {
  const rows: Array<{ key: string; file?: string; uses: number }> = [];
  if (!input) return rows;
  if (input instanceof Set || Array.isArray(input)) {
    for (const item of input) {
      const record = (item ?? {}) as Record<string, unknown>;
      const value = str(record.key ?? record.image ?? item);
      if (value) rows.push({ key: value, uses: Number(record.uses ?? record.count ?? 0) || 0 });
    }
    return rows;
  }
  if (typeof input === "object" && !(input instanceof Map)) {
    for (const [base, value] of Object.entries(input)) {
      const entry = (value ?? {}) as Record<string, unknown>;
      const weight = Number(entry.uses ?? entry.count ?? 0) || 0;
      if (str(base)) rows.push({ key: base, uses: weight });
      const list = Array.isArray(entry.array) ? entry.array : [];
      for (const item of list) {
        const image = str((item as Record<string, unknown>)?.image);
        if (image) rows.push({ key: image.includes("/") ? image : `${base}/${image}`, uses: weight });
      }
    }
  } else {
    for (const [key, value] of entriesOfTable(input)) if (str(key)) rows.push({ key, uses: Number(value) || 0 });
  }
  return rows;
}

/**
 * 合并四个来源 → 条目清单（去重、聚合 `uses`、贴 `bundled`/`sources`、稳定排序）。
 *
 * 契约：
 * - **不抛**：`null`/`undefined`/坏 key/坏表都能吃；
 * - `uses` = 表权重 + 脚本出现次数（聚合，不是覆盖）；
 * - 排序 = 随包优先 → 用量降序 → key 码点序（`Array.prototype.sort` 稳定，
 *   同分同随包时保持插入序）；
 * - `source` 之外的字段都可缺省。
 */
export function assetEntries(inputs: AssetLibraryInputs = {}): AssetEntry[] {
  const merged = new Map<string, Mutable>();
  const put = (rawKey: unknown, patch: Partial<Mutable> = {}): void => {
    const key = str(rawKey);
    if (!key) return;
    const explicitKind = patch.kind;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, {
        uses: 0,
        bundled: false,
        fromPack: false,
        sources: [],
        kind: explicitKind,
        ...patch,
        key: key,
      } as Mutable);
      return;
    }
    previous.uses += patch.uses ?? 0;
    previous.bundled = previous.bundled || Boolean(patch.bundled);
    previous.fromPack = previous.fromPack || Boolean(patch.fromPack);
    if (patch.file && !previous.file) previous.file = patch.file;
    if (patch.audioUrl && !previous.audioUrl) previous.audioUrl = patch.audioUrl;
    if (patch.kind) previous.kind = previous.kind && previous.kind !== "other" ? previous.kind : patch.kind;
    for (const source of patch.sources ?? []) if (!previous.sources.includes(source)) previous.sources.push(source);
  };

  const bundled = new Set<string>();
  for (const value of inputs.bundledKeys ?? []) {
    const key = normalizeAssetKey(value);
    if (key) bundled.add(key);
  }

  for (const [rawKey, weight] of entriesOfTable(inputs.backgrounds)) {
    const key = normalizeAssetKey(rawKey);
    put(key, { kind: "background", uses: weight > 0 ? weight : 0, sources: ["engine"] });
  }
  for (const row of characterRows(inputs.characters)) {
    const key = normalizeAssetKey(row.key);
    put(key, { kind: "character", uses: row.uses, sources: ["engine"] });
  }
  for (const [rawKey, file] of packRows(inputs.packKeys)) {
    const key = normalizeAssetKey(rawKey);
    put(key, {
      kind: assetKindOf(key),
      file: str(file) || undefined,
      fromPack: true,
      bundled: true,
      sources: ["pack"],
    });
  }

  const script = inputs.scriptKeys;
  if (script) {
    const variables = inputs.variables ?? null;
    const at = (key: string) => script.counts?.[key] ?? 1;
    const list = (value: unknown): string[] => (Array.isArray(value) ? value : []);
    for (const value of list(script.images)) {
      const key = normalizeAssetKey(value);
      put(key, { kind: "background", uses: at(key), sources: ["script"] });
    }
    for (const value of list(script.characters)) {
      const key = normalizeAssetKey(value);
      put(key, { kind: "character", uses: at(key), sources: ["script"] });
    }
    for (const [values, kind] of [
      [list(script.music), "music"],
      [list(script.sound), "sound"],
    ] as Array<[string[], AssetKind]>) {
      for (const value of values) {
        const key = str(value);
        put(key, {
          kind,
          uses: at(key),
          sources: ["script"],
          audioUrl: audioUrlFor(key, variables),
        });
      }
    }
  }

  for (const key of bundled) {
    put(key, { bundled: true, kind: merged.get(key)?.kind ?? assetKindOf(key) });
  }

  const out: AssetEntry[] = [];
  for (const item of merged.values()) {
    const kind = item.kind && item.kind !== "other" ? item.kind : assetKindOf(item.key);
    if (keyIsAudioPath(item.key) && (kind === "background" || kind === "character")) {
      // 包自带的音频（`audio/…`）按路径细分，别落到图片类。
      out.push(toEntry(item, audioKindOf(item.key)));
      continue;
    }
    out.push(toEntry(item, kind));
  }
  return sortAssetEntries(out, "uses");
}

function keyIsAudioPath(key: string): boolean {
  return /^audio\//i.test(key) || AUDIO_EXT.test(key) || key.startsWith("$");
}

function toEntry(item: Mutable, kind: AssetKind): AssetEntry {
  const entry: AssetEntry = {
    key: item.key,
    kind,
    label: assetLabelOf(item.key, kind),
    uses: Math.max(0, Math.round(item.uses)),
    bundled: item.bundled || bundledByKey(item),
    fromPack: item.fromPack,
    sources: [...item.sources],
  };
  if (item.file) entry.file = item.file;
  const audio = item.audioUrl || (kind === "music" || kind === "sound" ? audioUrlFor(item.key, null) : "");
  if (audio) entry.audioUrl = audio;
  return entry;
}

/** 兜底：内置样例的 8 条（`stageCatalog.BUNDLED_STAGE_KEYS` 的同值清单，
 *  这里复制一份**常量**，免得纯模块依赖 `appSettings`）。 */
const BUNDLED_FALLBACK: readonly string[] = [
  "bg_black",
  "bg_room_2",
  "bg_forest",
  "bg_rhodeslounge_2",
  "char_002_amiya_1/char_002_amiya_1",
  "char_002_amiya_1/char_002_amiya_3",
  "char_010_chen_1/char_010_chen_1",
  "char_130_doberm_ex/char_130_doberm_ex",
];

function bundledByKey(item: Mutable): boolean {
  if (item.fromPack) return true;
  return BUNDLED_FALLBACK.includes(item.key);
}

export type AssetSort = "uses" | "name";

/** 排序：随包优先 → （`uses` 档：用量降序）→ key 码点序。`Array.sort` 稳定。 */
export function sortAssetEntries(entries: readonly AssetEntry[], sort: AssetSort = "uses"): AssetEntry[] {
  const copy = [...entries];
  copy.sort((a, b) => {
    if (a.bundled !== b.bundled) return a.bundled ? -1 : 1;
    if (sort === "uses" && b.uses !== a.uses) return b.uses - a.uses;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return copy;
}

export interface AssetFilter {
  /** 搜索词（大小写不敏感；匹配 key / 标签 / 包内路径）。 */
  query?: string;
  /** 只看某一类；`"all"` 或缺省 = 全部。 */
  kind?: AssetKind | "all";
  /** 只看随包（含导入进包的）。 */
  onlyBundled?: boolean;
  /** 只看收藏。 */
  onlyFavorites?: boolean;
  /** 收藏集合（`stateStore` 里的 `favorites`）。 */
  favorites?: Iterable<string>;
  /** 排序档（缺省 `uses`）。 */
  sort?: AssetSort;
}

/** 过滤（纯函数；UI 的搜索 / 类型栏 / 开关都走它——harness 与自检共用一套语义）。 */
export function filterAssetEntries(
  entries: readonly AssetEntry[],
  filter: AssetFilter = {}
): AssetEntry[] {
  const query = str(filter.query).toLowerCase();
  const favorites = new Set(filter.favorites ?? []);
  const kind = filter.kind && filter.kind !== "all" ? filter.kind : null;
  const kept = entries.filter((entry) => {
    if (kind && entry.kind !== kind) return false;
    if (filter.onlyBundled && !entry.bundled) return false;
    if (filter.onlyFavorites && !favorites.has(entry.key)) return false;
    if (!query) return true;
    const haystack = `${entry.key}\n${entry.label}\n${entry.file ?? ""}`.toLowerCase();
    return haystack.includes(query);
  });
  return sortAssetEntries(kept, filter.sort ?? "uses");
}

/** 分组：`"flat"` = 一组；`"kind"` = 按类型（`ASSET_KIND_IDS` 顺序，空组丢掉）。 */
export function groupAssetEntries(
  entries: readonly AssetEntry[],
  mode: "flat" | "kind" = "flat"
): Array<{ kind: AssetKind | null; entries: AssetEntry[] }> {
  if (mode === "flat") return [{ kind: null, entries: [...entries] }];
  const buckets = new Map<AssetKind, AssetEntry[]>();
  for (const entry of entries) {
    const list = buckets.get(entry.kind) ?? [];
    list.push(entry);
    buckets.set(entry.kind, list);
  }
  return ASSET_KIND_IDS.filter((kind) => (buckets.get(kind)?.length ?? 0) > 0).map((kind) => ({
    kind,
    entries: buckets.get(kind) ?? [],
  }));
}

/** 每类的条目数（类型栏的 badge 用）。 */
export function assetKindCounts(entries: readonly AssetEntry[]): Record<AssetKind | "all", number> {
  const counts: Record<AssetKind | "all", number> = {
    all: entries.length,
    background: 0,
    character: 0,
    music: 0,
    sound: 0,
    other: 0,
  };
  for (const entry of entries) counts[entry.kind] += 1;
  return counts;
}
