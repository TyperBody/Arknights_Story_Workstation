// 剧本包**自带素材**（pack-local assets）在应用侧的唯一入口。
//
// 包格式：`<pack>/build/assets.local.json` = `canonicalKey → 包内相对路径`
// （canonical key 与 `src-tauri/src/media.rs::canonical_key` 一致：`host/path`，
// 例 `torappu.prts.wiki/assets/avg/background/bg_black.png`）。素材由
// `scripts/fanfic/fetch-sample-assets.mjs` 下载/转换并随包分发。
//
// 引擎（StoryPlayer/Pixi）只认 `https://torappu.prts.wiki/...` 或
// `prts-cdn://localhost/torappu.prts.wiki/...`，而且模块是 data: URL、Pixi 图片
// 走 Worker/`new Image()`，都不经过 iframe 的 `fetch`。应用因此走三层：
//
//   1) 前端：`setPackAssetMap(packId, map)` 记住「这个包自带哪些 key」；播放前
//      `ensurePackAssetUrls()` 把每个 key 解析成可播放 URL。**两种 transport**，
//      由 Rust `bundled_asset_keys()`（= `prts-cdn` 覆盖层 `bundles.json` 的
//      内容，数据驱动）裁定：
//        · 覆盖层能命中的 key → 原始 `prts-cdn://localhost/<key>`：Rust 直接
//          给字节，**主线程与图片 Worker 都能取**（`asset://` 是自定义协议，
//          Pixi 解码用的 Worker 在 WebKitGTK/WKWebView 上取不到，会
//          `TypeError: Load failed`——task-12 的原生失败就是这条）；
//        · 覆盖层没有的 key → `asset://<abs>`（`pack_asset_path` +
//          `convertFileSrc`），只走主线程也能播。
//   2) iframe realm：`storyPlayerBoot` 把表注入 `globalThis.__arkstagePackAssets`
//      并用它重写 `fetch`/`Image.src`/`Audio`/Pixi `Assets`/Worker——本地文件优先。
//   3) Rust：`prts-cdn://` 协议在缓存仓之前先读随包内置的覆盖层
//      （`<资源目录>/assets/sample/bundles.json`），前两层没命中时仍零网络。
//
// 无头探针（scripts/fanfic/verify-pack.mjs）没有 Tauri：`setSyntheticResolver`
// 注入 `(packId, name) → URL`，用 HTTP 供给同一张映射表。

import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export type PackAssetMap = Record<string, string>;

/** key 归一：`https://host/path` / `http://host/path` / `prts-cdn://localhost/host/path`
 *  → `host/path`（去 query/fragment），与 Rust `canonical_key` 语义一致。 */
export function canonicalAssetKey(raw: string): string | null {
  let value = String(raw ?? "").trim();
  if (!value) return null;
  // 顺序要紧：`http://prts-cdn.localhost/` 必须先于 `http://` 被剥掉。
  for (const prefix of ["prts-cdn://localhost/", "http://prts-cdn.localhost/"]) {
    if (value.startsWith(prefix)) value = value.slice(prefix.length);
  }
  for (const prefix of ["https://", "http://"]) {
    if (value.startsWith(prefix)) value = value.slice(prefix.length);
  }
  let path = value.split("?")[0].split("#")[0];
  // `<origin>/proxy/<host>/<path>`（无头探针把 prts-cdn 换成了 dev server 的
  // `/proxy` 路由）：等价于 canonical `<host>/<path>`。
  if (path.includes("/proxy/")) path = path.slice(path.lastIndexOf("/proxy/") + "/proxy/".length);
  const host = path.split("/")[0].toLowerCase();
  if (!host.includes(".") || !path.includes("/")) return null;
  return `${host}${path.slice(host.length)}`;
}

interface PackAssetState {
  packId: string;
  /** canonical key → 包内相对路径（表里说「自带」的 key）。 */
  files: Map<string, string>;
  /** canonical key → 可播放的 URL（`prts-cdn://` 覆盖层或 `asset://`）。 */
  urls: Map<string, string>;
  /** canonical key → 该 URL 是否由 Rust 覆盖层（`prts-cdn://`）供给。 */
  viaOverlay: Map<string, boolean>;
}

let state: PackAssetState | null = null;
/** Rust 覆盖层（`prts-cdn://` 协议第 1 步）能直接命中的 key。null = 还没问到
 *  （命令不可用 / 探针环境）；那时全部按 `asset://` 处理，与旧行为一致。 */
let overlayKeys: Set<string> | null = null;
/** `prts-cdn://` 基址（WebKit/WKWebView 用 `scheme://`，Chromium 系用
 *  `http://scheme.localhost`——与 `proxy.ts::PROXY_BASE` 同源）。 */
let overlayBaseOverride: string | null = null;
function overlayBase(): string {
  if (overlayBaseOverride) return overlayBaseOverride;
  return typeof navigator !== "undefined" && /Windows|Android/i.test(navigator.userAgent ?? "")
    ? "http://prts-cdn.localhost"
    : "prts-cdn://localhost";
}

/** 覆盖层基址（探针把 `prts-cdn://` 换成 dev server 的 `/overlay` 路由）。 */
export function setOverlayBase(base: string | null): void {
  overlayBaseOverride = base ? base.replace(/\/+$/, "") : null;
  resolving = null;
  if (state) state.urls.clear();
  if (state) state.viaOverlay.clear();
}

/** 覆盖层 URL 的**路径部分**（`/<canonical key>`）——供断言「与 proxyUrl 同形」。 */
export function overlayUrlFor(key: string): string {
  return `${overlayBase()}/${canonicalAssetKey(key) ?? key}`;
}
/** ⚠️ 必须与 `proxyUrl(url, WIKI_CDN_DOMAINS)` 的产物**逐字符相等**，否则同一份
 *  素材会同时出现「`prts-cdn://`」和「`asset://`」两个 URL，而 Pixi 按 URL 缓存
 *  纹理 → 解码两次（第二次在 Worker 里仍可能失败）。`packAssets` 不 import
 *  `proxy.ts` 是为了让离线探针也能直接加载本模块。 */
function overlayUrl(canonicalKey: string): string {
  return overlayUrlFor(canonicalKey);
}
let resolving: Promise<void> | null = null;
/** 无 Tauri 时的替代解析器（探针注入）；注册顺序无关——`setPackAssetMap` 会重放。 */
let syntheticResolver: ((packId: string, name: string) => string | null) | null = null;

/** 填表：覆盖层命中 → `prts-cdn://`（Worker 也能取）；否则交给替代解析器
 *  （探针）或 `pack_asset_path`（应用）。注册顺序无关：两条路径都可能先到。 */
function applySynthetic(): void {
  if (!state) return;
  for (const [key, file] of state.files) {
    if (state.urls.has(key)) continue;
    if (overlayKeys?.has(key)) {
      state.urls.set(key, overlayUrlFor(key));
      state.viaOverlay.set(key, true);
      continue;
    }
    if (!syntheticResolver) continue;
    const url = syntheticResolver(state.packId, file);
    if (url) {
      state.urls.set(key, url);
      state.viaOverlay.set(key, false);
    }
  }
}

/** 记住 Rust 覆盖层能命中的 key（`bundled_asset_keys`）。幂等；失败保留旧值。 */
export async function refreshOverlayKeys(): Promise<void> {
  if (overlayKeys) return;
  try {
    const keys = await invoke<string[]>("bundled_asset_keys");
    overlayKeys = new Set((keys ?? []).map((key) => canonicalAssetKey(key) ?? key));
  } catch {
    // 命令不可用（探针 / 老版本后端）：保持 null → 全部走 asset://。
  }
}

/** 无 Tauri 的探针注入覆盖层名单（等价 `bundled_asset_keys`，用于验证
 *  「覆盖层命中 → 不重写」这条分支）。 */
export function setOverlayKeys(keys: readonly string[] | null): void {
  overlayKeys = keys ? new Set(keys.map((key) => canonicalAssetKey(key) ?? key)) : null;
}

/** 覆盖层（`prts-cdn://`）是否可以供给这个 key。 */
export function servedByOverlay(url: string): boolean {
  const key = canonicalAssetKey(url);
  return Boolean(key && overlayKeys?.has(key));
}

/** 已注册但未能解析成本地 URL 的 key 数（探针断言「自带素材全覆盖」）。 */
export function packAssetMissCount(): number {
  if (!state) return 0;
  let misses = 0;
  for (const key of state.files.keys()) if (!state.urls.has(key)) misses += 1;
  return misses;
}

/** 当前包注册的自带素材数量。 */
export function packAssetCount(): number {
  return state?.files.size ?? 0;
}

/** 已解析成 URL 的数量。 */
export function packAssetResolvedCount(): number {
  return state?.urls.size ?? 0;
}

/** 解析结果里由调度器给出的**本地** URL 数量（Tauri 是 `asset://`，无头探针是
 * `/pack-asset/…`）。`bootStoryPlayer` 据此决定是否注入替换 shim。 */
export function packAssetLocalCount(): number {
  if (!state) return 0;
  if (syntheticResolver) return state.urls.size;
  let count = 0;
  for (const url of state.urls.values()) if (/^(asset:|https?:\/\/asset\.)/.test(url)) count += 1;
  // 覆盖层供给的 key 同样是「已解析、可离线播放」，只是走 `prts-cdn://`。
  return count + packAssetOverlayCount();
}

export function activePackId(): string | null {
  return state?.packId ?? null;
}

/** 注册/覆盖当前剧本包的自带素材表（一次只服务一个包）。 */
export function setPackAssetMap(packId: string, map: PackAssetMap): void {
  const files = new Map<string, string>();
  for (const [key, file] of Object.entries(map ?? {})) {
    const canonical = canonicalAssetKey(key) ?? key;
    const name = String(file ?? "").trim();
    if (name) files.set(canonical, name);
  }
  if (state && state.packId === String(packId) && state.files.size === files.size) {
    let same = true;
    for (const [key, value] of files) if (state.files.get(key) !== value) { same = false; break; }
    if (same) return; // 同一个包重复注册：保留已解析的 URL
  }
  state = { packId: String(packId), files, urls: new Map(), viaOverlay: new Map() };
  resolving = null;
  applySynthetic();
}

export function clearPackAssetMap(): void {
  state = null;
  resolving = null;
}

/** 无 Tauri 时（探针）注入 `(packId, name) → URL` 解析器。可先于
 *  `setPackAssetMap` 调用：后续每次注册都会用同一解析器重放整张表。 */
export function setSyntheticResolver(resolver: (packId: string, name: string) => string | null): void {
  syntheticResolver = resolver;
  resolving = null;
  applySynthetic();
}

/** 清掉替代解析器（回到 `pack_asset_path` 命令路径）。 */
export function clearSyntheticResolver(): void {
  syntheticResolver = null;
  resolving = null;
}

/** 这个 URL/键是否由当前包自带。 */
export function hasPackAsset(url: string): boolean {
  const key = canonicalAssetKey(url);
  return Boolean(key && state?.files.has(key));
}

/** 自带素材的可播放 URL 覆盖：`prts-cdn://`（覆盖层）或 `asset://`（包内文件）。
 *  没有/未解析返回 null（调用方保持原 URL）。 */
export function resolvePackAsset(url: string): string | null {
  const key = canonicalAssetKey(url);
  if (!key || !state) return null;
  return state.urls.get(key) ?? null;
}

/**
 * 把表里的每个 key 解析成可播放 URL。幂等、可重复调用。两种 transport：
 *   ① `bundled_asset_keys()` 说 Rust 覆盖层能供给 → 保留 `prts-cdn://<key>`
 *      （Worker 也能取；见文件头注释）；
 *   ② 否则 `pack_asset_path` → `convertFileSrc` → `asset://<abs>`。
 */
export function ensurePackAssetUrls(): Promise<void> {
  if (!state) return resolving ?? Promise.resolve();
  if (resolving) return resolving;
  const snapshot = state;
  resolving = (async () => {
    await refreshOverlayKeys();
    for (const [key, file] of snapshot.files) {
      if (snapshot !== state) return;
      if (overlayKeys?.has(key)) {
        // 覆盖层命中：**不要**重写成本地文件 URL——Pixi 的图片 Worker 取不到
        // `asset://`（WebKit 自定义协议只在主线程可用）。`fetch` 产物与
        // `proxyUrl(canonical)` 逐字符相同，所以这条分支等于「不重写」。
        snapshot.urls.set(key, overlayUrlFor(key));
        snapshot.viaOverlay.set(key, true);
        continue;
      }
      if (snapshot.urls.has(key)) continue; // 替代解析器（探针）已填
      if (syntheticResolver) {
        const url = syntheticResolver(snapshot.packId, file);
        if (url) {
          snapshot.urls.set(key, url);
          snapshot.viaOverlay.set(key, false);
        }
        continue;
      }
      try {
        const absolute = await invoke<string>("pack_asset_path", { packId: snapshot.packId, name: file });
        if (snapshot !== state || !absolute) continue;
        snapshot.urls.set(key, convertFileSrc(absolute));
        snapshot.viaOverlay.set(key, false);
      } catch {
        // 命令不可用或文件缺失：保留原 URL，走网络/缓存。
      }
    }
  })();
  return resolving;
}

/** manifest（`https://host/path`）形态的自带素材 URL 列表 = 自带 key 的并集。 */
export function packManifestUrls(): string[] {
  if (!state) return [];
  return [...state.files.keys()].map((key) => `https://${key}`);
}

/** 覆盖层供给的 key 数（探针断言「离线可播」）。 */
export function packAssetOverlayCount(): number {
  if (!state) return 0;
  let count = 0;
  for (const key of state.files.keys()) if (state.viaOverlay.get(key)) count += 1;
  return count;
}

/** `prts-cdn://` 的自带素材 URL（供 Worker/测试断言「不重写」）。 */
export function overlayUrls(): string[] {
  if (!state) return [];
  return [...state.viaOverlay.entries()].filter(([, overlay]) => overlay).map(([key]) => overlayUrl(key));
}

/** iframe realm 用的静态表：canonical key → 本地 URL。 */
export function packAssetUrlTable(): Record<string, string> {
  if (!state) return {};
  const table: Record<string, string> = {};
  for (const [key, url] of state.urls) table[key] = url;
  return table;
}

/** 表里是否有**至少一个**已解析、可离线播放的 URL——`asset://`（包内文件）或
 *  `prts-cdn://`（Rust 覆盖层）。`bootStoryPlayer` 据此决定是否注入 shim。 */
export function packAssetShimAvailable(): boolean {
  return packAssetLocalCount() > 0;
}

/** 注入脚本源码的尾巴（表 + 解析函数）。 */
export function packAssetShimCode(): string {
  const table = JSON.stringify(packAssetUrlTable());
  return `
var __arkstagePackTable = /* @__PURE__ */ (function () {
  var raw = ${table};
  if (globalThis.__arkstagePackAssetMerged) {
    // The data:-URL module realm re-runs this script: merge instead of replacing,
    // so a table injected earlier (e.g. by the app shell) stays reachable.
    for (var existing in globalThis.__arkstagePackAssets) if (!(existing in raw)) raw[existing] = globalThis.__arkstagePackAssets[existing];
  }
  globalThis.__arkstagePackAssetMerged = true;
  return raw;
})();
function __arkstagePackAsset(value) {
  try {
    var raw = typeof value === "string" ? value : (value && (value.url || value.src || value.href)) || "";
    var url = String(raw);
    for (var host of ["prts-cdn://localhost/", "http://prts-cdn.localhost/"]) if (url.indexOf(host) === 0) url = url.slice(host.length);
    for (var scheme of ["https://", "http://"]) if (url.indexOf(scheme) === 0) url = url.slice(scheme.length);
    var path = url.split("?")[0].split("#")[0];
    if (path.indexOf("/proxy/") !== -1) path = path.slice(path.lastIndexOf("/proxy/") + 7);
    return __arkstagePackTable[path] || null;
  } catch (error) { return null; }
}
globalThis.__arkstagePackAssets = __arkstagePackTable;
globalThis.__arkstagePackAsset = __arkstagePackAsset;
globalThis.__arkstagePackTableSize = Object.keys(__arkstagePackTable).length;`;
}
