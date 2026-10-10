// 本地剧本包（fanfic packs）的共享实现：目录扫描、元信息解析、索引合并、素材域收集。
// 纯 ESM、零依赖；应用（frontend/src/lib/localStories.ts）与离线脚本
// （skill 的 lint/build）共用同一份，避免两套格式。
//
// 数据来源由调用方注入（`registerLocalSource`）：
//   { listPacks(): Promise<Array<{ id, files: Record<string,string> }>>, upstream?: object }
// - 桌面应用：Rust 命令 `list_library` / `read_library_file`（见 src-tauri/src/commands/library.rs）
// - 浏览器探针：scripts/fanfic/vite-local-library.mjs 注入的虚拟模块
// 见 .akskills/arkstage-fanfic/reference/package.md。

/**
 * @typedef {object} PackBundleHook
 * @property {{script: string, title: string}} story
 * @property {object} bundle   StoryPlayerBundle 形状（entry/prelude/modules/styles/data）
 * @property {string} revision
 */

/**
 * @typedef {object} LocalPack
 * @property {string} id
 * @property {string} dir
 * @property {string} title
 * @property {string} chapter
 * @property {string} author
 * @property {string} description
 * @property {string[]} branchPoints
 * @property {string} script
 * @property {Record<string, unknown>} packMeta
 * @property {Record<string, unknown>} chapterMeta
 * @property {unknown} chapters
 * @property {{characters: unknown, resolutionRules: unknown, variables: unknown}} patches
 * @property {unknown} runtime
 * @property {string|null} wikitext
 * @property {Record<string, string>} assets
 */

export const PACK_MARKER = "script.txt";
export const CHARACTER_URL = "https://torappu.prts.wiki/assets/avg/character.json";
export const BACKGROUND_URL = "https://torappu.prts.wiki/assets/avg/background.json";
export const VARIABLES_URL = "https://torappu.prts.wiki/gamedata/latest/story/story_variables.json";

let source = null;

export function registerLocalSource(next) {
  source = next;
}

export function hasLocalSource() {
  return Boolean(source);
}

/** 读一次即可 —— 包内容在一次会话里不变，反复调用走缓存。 */
let cache = null;

/** @param {{refresh?: boolean}} [options] @returns {Promise<LocalPack[]>} */
export async function localPacks({ refresh = false } = {}) {
  if (!source) return [];
  if (cache && !refresh) return cache;
  const packs = await source.listPacks();
  cache = packs
    .map(toPack)
    .filter((pack) => pack && pack.script.trim())
    .sort((a, b) => a.id.localeCompare(b.id));
  return cache;
}

export function clearLocalCache() {
  cache = null;
}

/**
 * 共享上游快照提供者：由应用在启动时注入（`predownload.ts` 的 `loadBundle()`）。
 * 剧本包自带 `build/runtime.json` 时优先用它；没有时（例如内置样例）用这份共享
 * 快照，用户不必自己带 3 MB 的引擎快照。
 * @type {null | (() => Promise<{bundle?: object}|null>)}
 */
let upstreamProvider = null;

/** @param {null | (() => Promise<{bundle?: object}|null>)} provider */
export function setUpstreamProvider(provider) {
  upstreamProvider = provider;
}

/** 上游快照（StoryPlayerBundle）：本地包自带的 build/runtime.json 优先，否则用共享快照。 */
export async function localUpstream() {
  const own = source?.upstream;
  if (own) return own;
  if (upstreamProvider) {
    try {
      return await upstreamProvider();
    } catch {
      return null;
    }
  }
  return null;
}

function toPack(raw) {
  const files = raw.files ?? {};
  const script = files[PACK_MARKER];
  if (typeof script !== "string") return null;
  const meta = parseJson(files["pack.json"]) ?? {};
  const id = String(meta.id || raw.id || "").trim();
  if (!id) return null;
  return {
    id,
    dir: raw.dir ?? raw.id ?? id,
    title: String(meta.title || id),
    chapter: String(meta.chapter || meta.title || id),
    author: meta.author ? String(meta.author) : "",
    description: meta.description ? String(meta.description) : "",
    branchPoints: Array.isArray(meta.branchPoints) ? meta.branchPoints : [],
    script,
    packMeta: meta,
    chapterMeta: parseJson(files["metadata.json"]) ?? {},
    chapters: parseJson(files["build/chapters.json"]) ?? null,
    patches: {
      characters: parseJson(files["patch/characters.json"]) ?? null,
      resolutionRules: parseJson(files["patch/resolutionRules.json"]) ?? null,
      variables: parseJson(files["patch/story_variables.json"]) ?? null,
    },
    runtime: parseJson(files["build/runtime.json"]) ?? null,
    wikitext: typeof files["build/page.wikitext"] === "string" ? files["build/page.wikitext"] : null,
    assets: files,
  };
}

function parseJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 把上游 bundle（或本包自带的快照）+ patch 合成播放用 bundle。 */
/** @param {LocalPack} pack @param {{bundle?: object}|null} upstream @returns {object|null} */
export function buildPackBundle(pack, upstream) {
  const own = /** @type {{bundle?: object}} */ (pack.runtime);
  const base = own?.bundle ?? upstream?.bundle;
  if (!base) return null;
  const data = { ...base.data };
  const mergeInto = (key, patch) => {
    if (!patch || typeof patch !== "object") return;
    const current = data[key];
    data[key] = current && typeof current === "object" ? mergeTables(current, patch) : patch;
  };
  mergeInto(CHARACTER_URL, pack.patches.characters);
  mergeInto(BACKGROUND_URL, pack.patches.resolutionRules);
  mergeInto(VARIABLES_URL, pack.patches.variables);
  return { ...base, data };
}

/** 表合并：条目级覆盖；条目内 `array` 缺省沿用上游，显式给 `null` 表示清空。 */
/** @param {Record<string, any>} upstreamTable @param {Record<string, any>} patchTable @returns {Record<string, any>} */
export function mergeTables(upstreamTable, patchTable) {
  /** @type {Record<string, any>} */
  const out = { ...upstreamTable };
  for (const [key, value] of Object.entries(patchTable)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    const current = out[key];
    if (current && typeof current === "object" && value && typeof value === "object" && !Array.isArray(value)) {
      /** @type {Record<string, any>} */
      const merged = { ...current, ...value };
      if (!("array" in value) && Array.isArray(current.array)) merged.array = current.array;
      if (!("groups" in value) && Array.isArray(current.groups)) merged.groups = current.groups;
      if (!("pos" in value) && current.pos) merged.pos = current.pos;
      if (!("size" in value) && current.size) merged.size = current.size;
      out[key] = merged;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** @param {LocalPack} pack @param {{bundle?: object}|null} upstream @returns {PackBundleHook|null} */
export function buildHook(pack, upstream) {
  const bundle = buildPackBundle(pack, upstream);
  if (!bundle) return null;
  const revision = `fan:${pack.id}:${hash(stripControls(pack.script))}`;
  return { story: { script: stripControls(pack.script), title: pack.id }, bundle, revision };
}

/** @param {string} script @returns {string} */
export function stripControls(script) {
  // `[Cmd@tag(...)]` 里的 @tag 只给取景器用；引擎按字面分发，必须去掉。
  return String(script ?? "").replace(/\[\s*([A-Za-z_]\w*)@[A-Za-z0-9_-]+\s*(?=[\](])/g, "[$1");
}

/** 剧本里出现的上游素材域名（本地素材用 `local.arkstage.invalid`）。 */
export function collectAssetHosts(scripts) {
  const hosts = new Set();
  for (const script of scripts) {
    for (const match of String(script ?? "").matchAll(/https?:\/\/([^/\s"'`<>)]+)/g)) {
      const host = match[1].toLowerCase().replace(/:\d+$/, "");
      if (host.includes(".")) hosts.add(host);
    }
  }
  return [...hosts];
}

export function localHosts(pack) {
  const hosts = collectAssetHosts([pack.script, JSON.stringify(pack.patches ?? {})]);
  return hosts.filter((host) => host.endsWith(".invalid"));
}

/** 合并进书架索引：新增「同人剧场」分类，不动上游数据。 */
/** @param {{categories?: Array<{name: string, chapters: unknown[]}>}|null} index @param {Array<{id:string,title:string,chapter:string}>} packs @param {string} [categoryName] */
export function mergeLocalIntoIndex(index, packs, categoryName = "同人剧场") {
  if (!packs.length) return index;
  const stories = packs.map((pack) => ({
    title: pack.title,
    page_title: pack.id,
    local: true,
    chapter_name: pack.chapter,
  }));
  const chapters = new Map();
  for (const story of stories) {
    const list = chapters.get(story.chapter_name) ?? [];
    list.push(story);
    chapters.set(story.chapter_name, list);
  }
  const categories = [...(index?.categories ?? [])];
  const existing = categories.findIndex((category) => category.name === categoryName);
  const entry = {
    name: categoryName,
    chapters: [...chapters.entries()].map(([name, list]) => ({
      name,
      activity_name: categoryName,
      local: true,
      stories: list.map(({ chapter_name, ...rest }) => rest),
    })),
  };
  if (existing === -1) categories.unshift(entry);
  else categories[existing] = entry;
  return { ...(index ?? {}), categories };
}

/**
 * 角色渲染计划（fanfic skill 的 rig 输出）：给定角色引用与画布尺寸，算出
 * 「按引擎规则绘制」所需的 URL 与几何，供无头浏览器测量、或人工核对。
 * @param {{bases: Record<string, {size: Array<number|string>, render?: number}>, characters: Record<string, {image?: string, name?: string, face?: string, size?: Array<number|string>, render?: number}>, assets: Record<string, {width: number, height: number}>, upstream: Record<string, {pos?: {x:number,y:number}, size?: {x:number,y:number}, image?: string}>}} input
 * @param {{base: string, index?: number|null, group?: number|null, alias?: string|null}|string} ref
 * @param {{width: number, height: number, portraitZoom?: number}} viewport
 */
export function resolvePlan(input, ref, viewport) {
  const parsed = typeof ref === "string" ? parseCharacterRef(ref) : ref;
  const entry = input.characters[parsed.base];
  const upstreamEntry = input.upstream?.[parsed.base];
  const canvas = input.assets[entry?.image ?? ""] ?? null;
  const size = viewportSize(input.bases, parsed.base);
  const zoom = typeof entry?.render === "number" && entry.render > 0 ? entry.render : 1;
  const rect = size.x === 0 ? size : { x: size.x / zoom, y: size.y / zoom };
  const anchor = upstreamEntry?.pos ?? { x: (viewport.width - rect.x) / 2, y: 0 };
  return { url: assetUrlFor(entry), base: parsed.base, rect, anchor, canvas, upstreamPlan: upstreamEntry ?? null };
}

/**
 * 角色引用拆分（与 src/akstage/local/storyPack.js 的 parseCharacterRef 同规则，
 * 这里内联一份以免两个模块互相依赖）。
 * @param {string} raw
 * @returns {{base: string, index: number|null, group: number|null, alias: string|null}}
 */
function parseCharacterRef(raw) {
  let rest = String(raw ?? "").trim();
  /** @type {{base: string, index: number|null, group: number|null, alias: string|null}} */
  const ref = { base: "", index: null, group: null, alias: null };
  const aliasAt = rest.lastIndexOf("@");
  if (aliasAt !== -1) { ref.alias = rest.slice(aliasAt + 1); rest = rest.slice(0, aliasAt); }
  const cut = (mark) => {
    const at = rest.lastIndexOf(mark);
    if (at === -1) return null;
    const value = rest.slice(at + 1);
    if (!/^\d+$/.test(value)) return null;
    rest = rest.slice(0, at);
    return Number(value);
  };
  const group = cut("$");
  if (group !== null) ref.group = group;
  const index = cut("#");
  if (index !== null) ref.index = index;
  ref.base = rest;
  return ref;
}

function viewportSize(bases, base) {
  const raw = bases?.[base]?.size ?? [1024, 1024];
  const [x, y] = raw.map((value) => (typeof value === "string" && value.endsWith("%") ? (Number.parseFloat(value) / 100) * 1280 : Number(value)));
  return { x, y };
}

function assetUrlFor(entry) {
  return entry?.image ? `https://torappu.prts.wiki/assets/avg/characters/${entry.image}.png` : null;
}

function hash(text) {
  let value = 5381;
  for (let i = 0; i < text.length; i += 1) value = ((value << 5) + value + text.charCodeAt(i)) >>> 0;
  return value.toString(16).padStart(8, "0");
}
