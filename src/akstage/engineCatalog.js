/**
 * engineCatalog.js — 「引擎/素材目录」的纯数据层（P1）。
 *
 * 数据源：`catalog-data.json`（`tools/mirror/fetch-catalog.mjs` 从上游抓取生成，
 * 运行时**零网络**）。契约见 BRIEF-workbench-v1 §2.6：
 *
 * ```js
 * catalog(): CatalogEntry[]                 // { id, label, kind, key, urls, size }
 * mirrorOf(rawUrl, source)                 // → string | null（该源不适用 = null）
 * projectManifest(selection, tables)       // → { files: { canonicalKey: {...} }, total }
 * ```
 *
 * 纯 ESM、零依赖（只 import JSON），**不得** import Tauri / React —— 离线脚本
 * （`tools/mirror/*.mjs`）与前端（`frontend/src/lib/engineCatalog.ts` 包装）共用。
 */

import data from "./catalog-data.json" with { type: "json" };
import {
  DEFAULT_PRTS_HOST,
  MIRRORABLE_HOSTS,
  SOURCE_IDS,
  describe as describeKey,
  officialUrl,
  mirrorUrl as routeMirrorUrl,
  toMirrorKey,
} from "./assetRouting.js";

/** @typedef {"src"|"css"|"js"|"font"|"data"} CatalogKind */
/** @typedef {{id: string, label: string, kind: CatalogKind, key: string, urls: string[], size: number}} CatalogEntry */

const DEFAULT_SOURCE = "pack";
const KINDS = Object.freeze(["css", "js", "font", "data", "src"]);

let catalogCache = null;
let indexCache = null;

function labelOf(kind, path) {
  const name = path.split("/").pop() ?? path;
  switch (kind) {
    case "css":
      return `样式 ${name}`;
    case "js":
      return name === "StoryPlayer.js" ? "引擎 StoryPlayer" : `脚本 ${name}`;
    case "font":
      return `字体 ${name}`;
    case "data":
      return `数据 ${name}`;
    case "src":
      return `素材 ${name}`;
    default:
      return name;
  }
}

function urlOf(path) {
  return /^https?:\/\//.test(path) ? path : `https://${path}`;
}

const ENGINE_HOST = "static.prts.wiki";

export function guessKind(path) {
  if (/\.css(?:[?#]|$)/.test(path)) return "css";
  if (/\.(?:ttf|otf|woff2?)(?:[?#]|$)/.test(path)) return "font";
  if (/\.(?:png|webp|jpe?g|gif|svg)(?:[?#]|$)/.test(path)) return "src";
  if (/\.m?js(?:[?#]|$)/.test(path)) return "js";
  return "src";
}

/**
 * 目录里所有 `static.prts.wiki/**` 的 canonical key（kind ∈ {css,js,font,src} 全在内）。
 */
export function engineRuntimeKeys() {
  return catalog()
    .filter((entry) => entry.key.startsWith(`${ENGINE_HOST}/`))
    .map((entry) => entry.key);
}

/**
 * 引擎目录里 `static.prts.wiki/**` 的**独立文件**（含 `assets/scenario/**` 那批；
 * `tools/gen-index` / `storylines` 里用到的图标只统计不下载，见 NOTES-p1）。
 */
export function engineAssetPaths() {
  const out = [];
  for (const path of data.scenarioPaths ?? []) out.push(`${ENGINE_HOST}/${path}`);
  for (const path of data.widgetPaths ?? []) out.push(`${ENGINE_HOST}/${path}`);
  return out;
}

/** `host/path`（或 URL）逐段百分号编码（`$` → `%24`、`#` → `%23`）。 */
function encodePathInKey(input) {
  const text = String(input ?? "").replace(/^https?:\/\//, "");
  const at = text.indexOf("/");
  if (at <= 0) return text.toLowerCase();
  const host = text.slice(0, at).toLowerCase();
  const path = text
    .slice(at + 1)
    .split("/")
    .map((seg) => {
      try {
        return encodeURIComponent(decodeURIComponent(seg)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
      } catch {
        return encodeURIComponent(seg);
      }
    })
    .join("/");
  return `${host}/${path}`;
}

/** `static.prts.wiki/...` / `torappu.prts.wiki/...` → 去 host 的相对路径。 */
function pathOf(url) {
  const info = describeKey(url);
  return info ? info.path : String(url);
}

/** 分类表里 HOST 去掉后的短路径（`engine/*` / `widgets/*` / `assets/*`…）。 */
function shortKindPath(kind, path) {
  const at = path.indexOf("/");
  const rel = at > 0 ? path.slice(at + 1) : path;
  if (rel.startsWith("assets/avg/")) return rel; // torappu 舞台表
  return rel;
}

/**
 * 全量目录（**只读缓存**，别改返回的数组/对象）。
 * `key` = canonical key（`host/path`），`urls` = [官方直链, jsd, fastly, ghproxy, （自定义）]
 * 的可用项。`size` = 上游已知字节数（0 = 未知；`fetch-catalog.mjs` 只对少量条目录过）。
 *
 * @returns {CatalogEntry[]}
 */
export function catalog() {
  if (catalogCache) return catalogCache;
  /** @type {CatalogEntry[]} */
  const entries = [];
  const seen = new Set();

  const add = (rawKey, kind, size = 0, label) => {
    const text = String(rawKey ?? "");
    // 约定：`#` **只在**「表 + 变量名」里出现（`story_variables.json#<变量>`）；
    // 上游素材名里的字面 `#`（例 `avg_npc_135_1#1.png`）在 `encodePathInKey` 里编码掉。
    const varPrefix = `https://${VAR_BASE}#`;
    const varAt = text.startsWith(varPrefix) ? varPrefix.length - 1 : text.startsWith(`${VAR_BASE}#`) ? VAR_BASE.length : -1;
    const body = varAt >= 0 ? text.slice(0, varAt) : text;
    const hash = varAt >= 0 ? text.slice(varAt) : "";
    // 目录键 = **逐段百分号编码**后的 canonical key：`$`/`#` 这类会与 URL 语义打架的
    // 字符编码掉，键才能安全地进 `<a href>` / fetch。
    const encoded = encodePathInKey(body);
    const canonical = officialUrl(encoded) ?? `https://${encoded}`;
    const info = describeKey(encoded);
    if (!info) return;
    const key = `${info.key}${hash}`;
    const id = `${kind}:${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    entries.push({
      id,
      label: label ?? labelOf(kind, info.name),
      kind,
      key,
      urls: urlsFor(info.key),
      size: Number.isFinite(size) && size > 0 ? size : 0,
    });
  };

  /** 引擎/运行时自家的键：`static.prts.wiki/**`（widget 引擎代 + scenario + 字体，≥ 25 条）。 */
  const engineKeys = new Set();
  for (const path of data.scenarioPaths ?? []) engineKeys.add(`${ENGINE_HOST}/${path}`);
  for (const path of data.widgetPaths ?? []) engineKeys.add(`${ENGINE_HOST}/${path}`);
  for (const item of data.external ?? []) {
    const info = describeKey(item.url);
    if (!info) continue;
    if (info.host === ENGINE_HOST) engineKeys.add(item.url);
  }
  for (const key of engineKeys) add(key, guessKind(key));
  /** 上游表 + 目录里的全部键（`data`：变量名 / 背景 / 立绘）。 */
  for (const key of data.backgroundPaths ?? []) add(key, "data");
  for (const key of data.characterPaths ?? []) add(key, "data");
  for (const key of data.tableKeys ?? []) add(key, "data");
  for (const key of data.tableUrls ?? []) add(key, "data");
  if (!(data.tableKeys ?? []).length && !(data.tableUrls ?? []).length) {
    for (const key of ["torappu.prts.wiki/assets/avg/character.json", "torappu.prts.wiki/assets/avg/background.json", VAR_BASE]) {
      add(key, "data");
    }
  }
  for (const key of data.variableKeys ?? []) {
    add(`${data.variableBase ?? VAR_BASE}#${encodeURIComponent(key)}`, "data", 0, `变量 ${key}`);
  }
  catalogCache = entries;
  return entries;
}

/** 剧情变量所在表（目录里用 `#变量名` 作后缀）。 */
export const VAR_BASE = "torappu.prts.wiki/gamedata/latest/story/story_variables.json";

/** 上游 JSON 清单（`data` 层）：角色表 / 背景表 / 剧情变量。 */
export const TABLE_URLS = Object.freeze([
  "torappu.prts.wiki/assets/avg/character.json",
  "torappu.prts.wiki/assets/avg/background.json",
  VAR_BASE,
]);

/** 精简索引：canonical key → 分类（多数调用只需要这个，省内存）。 */
function keyIndex() {
  if (indexCache) return indexCache;
  const map = new Map();
  for (const entry of catalog()) {
    if (!map.has(entry.key)) map.set(entry.key, entry.kind);
    else if (map.get(entry.key) !== entry.kind) map.set(entry.key, "data");
  }
  indexCache = map;
  return map;
}

/**
 * 各源对这个 key 的 URL（顺序 = `SOURCE_IDS` 去掉拼不出的那些）。
 * 注意 `custom` 需要模板，所以这里不含自定义源。
 *
 * @param {string} key
 * @returns {string[]}
 */
export function urlsFor(key) {
  const out = [];
  for (const source of SOURCE_IDS) {
    if (source === "custom") continue;
    const url = routeMirrorUrl(source, key);
    if (url) out.push(url);
  }
  // 去重（pack 与 prts 展开成同一个 URL 时只留一个）
  return [...new Set(out)];
}

/**
 * 由 URL + 源拼下载地址（BRIEF §2.6 的签名）；不适用的源 → `null`。
 *
 * @param {string} rawUrl
 * @param {string} source
 * @returns {string|null}
 */
export function mirrorOf(rawUrl, source) {
  return routeMirrorUrl(source, rawUrl);
}

/** `{base}#{var}` → `[base, name]`；没有 `#` 时 name = `""`。 */
function decodeHashKey(key) {
  const at = key.indexOf("#");
  if (at < 0) return /** @type {[string, string]} */ ([key, ""]);
  const suffix = key.slice(at + 1);
  try {
    return /** @type {[string, string]} */ ([key.slice(0, at), decodeURIComponent(suffix)]);
  } catch {
    return /** @type {[string, string]} */ ([key.slice(0, at), suffix]);
  }
}

/** `catalog()` 里按 canonical key / 官方 URL 查条目（`#变量` 也算命中表本身）。 */
export function entryFor(rawKey) {
  const info = describeKey(urlOf(rawKey).split("#")[0]);
  if (!info) return null;
  return catalog().find((entry) => entry.key.split("#")[0] === info.key) ?? null;
}

/** 条目分类（`css|js|font|src|data`）；未知 URL → `null`。 */
export function kindOf(rawUrl) {
  const info = describeKey(urlOf(rawUrl).split("#")[0]);
  if (!info) return null;
  return keyIndex().get(info.key) ?? null;
}

/**
 * 「引擎快照」需要的最小集合（`static.prts.wiki` 的可执行/样式文件 + 字体 +
 * 上游 JSON 表 + 包内已有的 storyline 图）。按选择下载菜单只需这一层。
 */
export function engineEntries() {
  return catalog().filter(
    (entry) => entry.kind === "css" || entry.kind === "js" || entry.kind === "font" || entry.key.startsWith("static.prts.wiki/"),
  );
}

/** 目录摘要（设置页「已收录 N 条 / 引擎 M 条」）。 */
export function catalogSummary() {
  const byKind = { css: 0, js: 0, font: 0, src: 0, data: 0 };
  for (const entry of catalog()) byKind[entry.kind] += 1;
  return {
    entries: catalog().length,
    engine: engineEntries().length,
    byKind,
    mirrorableHosts: MIRRORABLE_HOSTS,
    sources: SOURCE_IDS,
    version: `catalog:${String(data.version ?? 1)}`,
  };
}

/** `keys` 是否都在目录里（`data` 类不算缺）。 */
export function missingKeys(keys) {
  const index = keyIndex();
  return (keys ?? []).filter((key) => {
    const info = describeKey(key);
    return info ? !index.has(info.key) : false;
  });
}

/**
 * 把「选择集」投影成一份可下载清单（「按选择下载引擎」菜单用）。
 *
 * `selection` 里每项可以是：
 *   - catalog 条目 `id`（例 `css:static.prts.wiki/assets/...`）或 canonical key / URL；
 *   - 组选择器 `*`（全部）、`kind:css`、`engine`（= `engineEntries()`）。
 *
 * `tables`（可选）用上游 JSON 推进「选择集」：
 * ```js
 * { characters: ["a","b"], backgrounds: ["bg_black"], links: ["...avg/characters/x.png"],
 *   variables: ["DecisiveBattle_loop"] }
 * ```
 *
 * @param {string[]} selection
 * @param {{characters?: string[], backgrounds?: string[], links?: string[], variables?: string[]}} [tables]
 * @returns {{files: Record<string, {url: string, mirrorUrls: string[], size: number, kind: CatalogKind}>, total: number}}
 */
export function projectManifest(selection, tables = {}) {
  const picked = new Map(); // canonical key -> entry
  const entries = catalog();
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  const want = Array.isArray(selection) ? selection : [];
  const addEntry = (entry) => {
    if (entry) picked.set(entry.key, entry);
  };

  const all = want.includes("*");
  if (all) for (const entry of engineEntries()) addEntry(entry);
  for (const item of want) {
    const text = String(item ?? "").trim();
    if (!text || text === "*") continue;
    if (text === "engine") {
      for (const entry of engineEntries()) addEntry(entry);
      continue;
    }
    if (text.startsWith("kind:")) {
      const kind = text.slice(5).trim();
      for (const entry of entries) if (entry.kind === kind) addEntry(entry);
      continue;
    }
    const direct = byId.get(text);
    if (direct) {
      addEntry(direct);
      continue;
    }
    const info = describeKey(text);
    if (!info) continue;
    const known = entries.find((entry) => entry.key === info.key);
    if (known) addEntry(known);
    else addEntry({
      id: `meta:${info.key}`,
      label: labelOf("src", info.path),
      kind: "src",
      key: info.key,
      urls: urlsFor(info.key),
      size: 0,
    });
  }

  const addCandidate = (kind, candidate) => {
    if (!candidate) return;
    const url = candidate.startsWith("http") ? candidate : `https://${candidate}`;
    const info = describeKey(url);
    if (!info) return;
    const known = entries.find((entry) => entry.key === info.key);
    if (known) addEntry(known);
    else addEntry({ id: `sel:${info.key}`, label: labelOf(kind, info.name), kind, key: info.key, urls: urlsFor(info.key), size: 0 });
  };

  for (const name of tables.characters ?? []) {
    addCandidate("src", `torappu.prts.wiki/assets/avg/characters/${String(name).replace(/^\/+/, "")}.png`);
  }
  for (const name of tables.backgrounds ?? []) {
    addCandidate("src", `torappu.prts.wiki/assets/avg/background/${String(name).toLowerCase()}.png`);
  }
  for (const link of tables.links ?? []) {
    addCandidate("src", `auto:${String(link)}`);
  }
  for (const name of tables.variables ?? []) {
    addCandidate("data", `torappu.prts.wiki/gamedata/latest/story/story_variables.json#${encodeURIComponent(name)}`);
  }

  /** @type {Record<string, {url: string, mirrorUrls: string[], size: number, kind: CatalogKind}>} */
  const files = {};
  let total = 0;
  for (const entry of picked.values()) {
    const url = officialUrl(entry.key) ?? entry.urls[0] ?? "";
    files[entry.key] = {
      url,
      mirrorUrls: entry.urls.filter((u) => u !== url),
      size: entry.size,
      kind: entry.kind,
    };
    if (entry !== byId.get("placeholder")) total += 1;
  }
  return { files, total: Object.keys(files).length };
}

export default { catalog, mirrorOf, projectManifest, catalogSummary, engineEntries, missingKeys, kindOf, entryFor, urlsFor, DEFAULT_PRTS_HOST, DEFAULT_SOURCE, KINDS };
